using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>
    /// Adds viewports a <see cref="DesignUiProfile"/> lacks: the kit's six default viewports (<see cref="AddDefaults"/>, the
    /// <c>Window &gt; Design UI &gt; Add Default Viewports to Profile</c> menu) or the ones kit.config.json declares (kit sync with
    /// <c>addProfileViewports</c>). A profile saved before the six-viewport release keeps its own list (Unity keeps a saved
    /// field's value), so it lacks 3840×2160 and the scaled 1600×900 and 1366×768. The change is one Undo step and the profile
    /// asset alone is saved (<see cref="AssetDatabase.SaveAssetIfDirty(Object)"/>): no other dirty asset is written. Edit &gt; Undo
    /// takes the viewports out of the open profile; the file on disk keeps them until the project is saved again.
    /// </summary>
    public static class DesignUiProfileViewports
    {
        /// <summary>The kit's default viewports with their class: the exact ones, then the scaled ones.</summary>
        public static IReadOnlyList<(Vector2Int size, DesignViewportClass cls)> Defaults =>
            DesignUiProfile.DefaultViewports.Select(v => (v, DesignViewportClass.Exact))
                .Concat(DesignUiProfile.DefaultScaledViewports.Select(v => (v, DesignViewportClass.Scaled))).ToList();

        /// <summary>The reference resolution the default viewports are chosen for: their classes hold at this reference only.</summary>
        public static readonly Vector2Int DefaultsReference = new Vector2Int(2560, 1440);

        /// <summary>
        /// Adds the default viewports the profile declares in neither list; returns what it added ("3840×2160 (exact)"). The
        /// defaults are the exact and scaled viewports of a 2560×1440 reference; a profile with another reference is refused
        /// (<see cref="InvalidOperationException"/>, nothing changed), since their classes would be wrong for it.
        /// </summary>
        public static IReadOnlyList<string> AddDefaults(DesignUiProfile profile)
        {
            if (profile != null && profile.referenceResolution != DefaultsReference)
                throw new InvalidOperationException("the default viewports are those of a " + Size(DefaultsReference) + " reference; this profile's reference is " +
                                                    Size(profile.referenceResolution) + ", so their exact and scaled classes would be wrong for it. Add its " +
                                                    "viewports by hand: exact ones where the panel scale makes every kit value whole device pixels, the rest scaled.");
            return Add(profile, Defaults);
        }

        /// <summary>
        /// Adds each viewport the profile declares in neither list, to the list of its class, as one Undo step, and saves the
        /// profile asset (only it). Returns what it added; nothing when the profile has them all.
        /// </summary>
        public static IReadOnlyList<string> Add(DesignUiProfile profile, IEnumerable<(Vector2Int size, DesignViewportClass cls)> viewports)
        {
            if (profile == null) return new string[0];
            var have = new HashSet<Vector2Int>(profile.DeclaredViewports().Select(v => v.size));
            var added = (viewports ?? Enumerable.Empty<(Vector2Int, DesignViewportClass)>()).Where(v => have.Add(v.Item1)).ToList();
            if (added.Count == 0) return new string[0];
            Undo.RecordObject(profile, "Add viewports to the Design UI profile");
            profile.viewports = (profile.viewports ?? new Vector2Int[0]).Concat(added.Where(v => v.Item2 == DesignViewportClass.Exact).Select(v => v.Item1)).ToArray();
            profile.scaledViewports = (profile.scaledViewports ?? new Vector2Int[0]).Concat(added.Where(v => v.Item2 == DesignViewportClass.Scaled).Select(v => v.Item1)).ToArray();
            EditorUtility.SetDirty(profile);
            if (EditorUtility.IsPersistent(profile)) AssetDatabase.SaveAssetIfDirty(profile);
            return added.Select(Describe).ToList();
        }

        /// <summary>What the Add Default Viewports menu reports, including what Undo does and does not do.</summary>
        public static string AddedMessage(string path, IReadOnlyList<string> added) =>
            added == null || added.Count == 0
                ? path + " already declares every default viewport."
                : "Added to " + path + " and saved it: " + string.Join(", ", added) + ". Edit > Undo takes them out of the open profile; " +
                  "save the project afterwards (File > Save Project) to write that to disk. Run Kit Sync to write them into the kit.";

        static string Size(Vector2Int v) => v.x + "×" + v.y;

        /// <summary>"3840×2160 (exact)", "1600×900 (scaled)".</summary>
        public static string Describe((Vector2Int size, DesignViewportClass cls) v) =>
            v.size.x + "×" + v.size.y + " (" + (v.cls == DesignViewportClass.Exact ? "exact" : "scaled") + ")";
    }
}
