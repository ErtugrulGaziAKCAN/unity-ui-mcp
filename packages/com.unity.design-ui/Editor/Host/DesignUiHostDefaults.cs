using System.IO;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>
    /// Fills a <see cref="DesignUiPanelRegion"/> added in the Editor (its Reset) from the project's DesignUiProfile: the
    /// host settings, and the screens' font set (<c>DesignFonts.asset</c> in the profile's output folder), so a game never
    /// wires them by hand. The profile is the one <c>design-ui.config.json</c> names, else the only one in the project.
    /// </summary>
    [InitializeOnLoad]
    internal static class DesignUiHostDefaults
    {
        static DesignUiHostDefaults()
        {
            DesignUiPanelRegion.EditorDefaults = Apply;
        }

        internal static void Apply(DesignUiPanelRegion region)
        {
            var profile = FindProfile();
            Apply(region, profile, FindFontSet(profile));
        }

        internal static void Apply(DesignUiPanelRegion region, DesignUiProfile profile, DesignFontSet fonts)
        {
            if (region == null) return;
            if (profile != null && profile.host != null) region.Settings = profile.host.Clone();
            if (fonts != null && region.Fonts == null) region.Fonts = fonts;
        }

        /// <summary>The profile <c>design-ui.config.json</c> names, else the only DesignUiProfile asset, else null.</summary>
        internal static DesignUiProfile FindProfile()
        {
            var config = DesignUiProjectConfig.Read(Path.GetDirectoryName(Application.dataPath));
            var named = AssetDatabase.LoadAssetAtPath<DesignUiProfile>(config.ProfilePath);
            if (named != null) return named;
            var guids = AssetDatabase.FindAssets("t:" + nameof(DesignUiProfile));
            return guids.Length == 1 ? AssetDatabase.LoadAssetAtPath<DesignUiProfile>(AssetDatabase.GUIDToAssetPath(guids[0])) : null;
        }

        /// <summary><c>DesignFonts.asset</c> in the profile's output folder, else the only DesignFontSet asset, else null.</summary>
        internal static DesignFontSet FindFontSet(DesignUiProfile profile)
        {
            if (profile != null && !string.IsNullOrEmpty(profile.outputFolder))
            {
                var set = AssetDatabase.LoadAssetAtPath<DesignFontSet>(profile.outputFolder.TrimEnd('/') + "/" + DesignFontSet.FileName);
                if (set != null) return set;
            }
            var guids = AssetDatabase.FindAssets("t:" + nameof(DesignFontSet));
            return guids.Length == 1 ? AssetDatabase.LoadAssetAtPath<DesignFontSet>(AssetDatabase.GUIDToAssetPath(guids[0])) : null;
        }
    }
}
