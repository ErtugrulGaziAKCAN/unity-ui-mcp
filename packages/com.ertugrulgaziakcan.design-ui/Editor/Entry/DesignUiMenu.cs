using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>
    /// The <c>Window → Design UI</c> menu items for the operations (the Status window is <see cref="DesignUiWindow"/>):
    /// <c>Kit Sync</c> and <c>Import Screen…</c>. Both use the DesignUiProfile selected in the Project window, else the
    /// project's only profile; the result is logged to the Console and summarised in a dialog. The Unity capture is not a
    /// menu item: it runs as an EditMode test on a copy of the project (see the repository README).
    /// </summary>
    public static class DesignUiMenu
    {
        const string Title = "Design UI";
        const int DialogLines = 12;

        [MenuItem("Window/Design UI/Kit Sync", priority = 2010)]
        public static void KitSyncMenu()
        {
            var profile = ChooseProfile();
            if (profile == null) return;
            var kit = KitFolder(AssetDatabase.LoadAssetAtPath<DesignUiProfile>(profile));
            if (kit == null)
            {
                kit = EditorUtility.OpenFolderPanel("Design UI: kit folder to sync into", "", "");
                if (string.IsNullOrEmpty(kit)) return;
            }
            Report("Kit Sync", DesignUiOps.KitSync(profile, kit));
        }

        /// <summary>
        /// Adds the kit's default viewports (3840×2160, 2560×1440, 1920×1080, 1280×720 exact; 1600×900, 1366×768 scaled) that the
        /// selected profile lacks, as one Undo step, and saves that profile asset only. A profile whose reference is not 2560×1440
        /// is refused with a message.
        /// </summary>
        [MenuItem("Window/Design UI/Add Default Viewports to Profile", priority = 2012)]
        public static void AddDefaultViewportsMenu()
        {
            var path = ChooseProfile();
            if (path == null) return;
            string message;
            try { message = DesignUiProfileViewports.AddedMessage(path, DesignUiProfileViewports.AddDefaults(AssetDatabase.LoadAssetAtPath<DesignUiProfile>(path))); }
            catch (System.InvalidOperationException e) { message = "Nothing added to " + path + ": " + e.Message; }
            Debug.Log("Design UI: " + message);
            EditorUtility.DisplayDialog(Title, message, "OK");
        }

        [MenuItem("Window/Design UI/Import Screen…", priority = 2011)]
        public static void ImportMenu()
        {
            var profile = ChooseProfile();
            if (profile == null) return;
            var export = EditorUtility.OpenFolderPanel("Design UI: export folder to import (screen.ir.json)", "", "");
            if (string.IsNullOrEmpty(export)) return;
            var r = DesignUiOps.Import(profile, export, false);
            if (DesignUiOps.HasManualEdits(r)
                && EditorUtility.DisplayDialog(Title, DialogText(r) + "\n\nDiscard the hand edits and import again?", "Discard and import", "Keep my edits"))
                r = DesignUiOps.Import(profile, export, true);
            Report("Import", r);
        }

        /// <summary>
        /// The profile a menu item uses: <paramref name="selected"/> when it is a DesignUiProfile asset, else the project's
        /// only one; null with the reason in <paramref name="message"/> when there is none or several.
        /// </summary>
        public static string ProfileFor(UnityEngine.Object selected, IReadOnlyList<string> projectProfiles, out string message)
        {
            message = null;
            if (selected is DesignUiProfile)
            {
                var path = AssetDatabase.GetAssetPath(selected);
                if (!string.IsNullOrEmpty(path)) return path;
            }
            var all = (projectProfiles ?? new string[0]).ToList();
            if (all.Count == 1) return all[0];
            message = all.Count == 0
                ? "The project has no DesignUiProfile; create one (Assets > Create > Design UI > Profile)."
                : "The project has several DesignUiProfiles (" + string.Join(", ", all) + "); select the one to use in the Project window.";
            return null;
        }

        /// <summary>The profile's kit folder, or null when it has none.</summary>
        public static string KitFolder(DesignUiProfile profile) =>
            profile == null || string.IsNullOrWhiteSpace(profile.kitDir) ? null : profile.kitDir;

        /// <summary>The first lines of a result for a dialog; the whole log is in the Console.</summary>
        public static string DialogText(OpResult result)
        {
            var lines = (result.Log ?? "").Split('\n');
            var shown = string.Join("\n", lines.Take(DialogLines));
            if (lines.Length > DialogLines) shown += "\n… " + (lines.Length - DialogLines) + " more lines";
            return shown + "\n\nThe full log is in the Console.";
        }

        static string ChooseProfile()
        {
            var all = AssetDatabase.FindAssets("t:" + nameof(DesignUiProfile)).Select(AssetDatabase.GUIDToAssetPath)
                .OrderBy(p => p, StringComparer.Ordinal).ToList();
            var path = ProfileFor(Selection.activeObject, all, out var message);
            if (path == null) EditorUtility.DisplayDialog(Title, message, "OK");
            return path;
        }

        /// <summary>Logs the result (an error when it failed) and shows its first lines in a dialog.</summary>
        internal static void Report(string what, OpResult r)
        {
            if (r.Code == 0) Debug.Log("Design UI " + what + ":\n" + r.Log);
            else Debug.LogError("Design UI " + what + " failed (code " + r.Code + "):\n" + r.Log);
            EditorUtility.DisplayDialog(Title + ": " + what + (r.Code == 0 ? "" : " failed"), DialogText(r), "OK");
        }
    }
}
