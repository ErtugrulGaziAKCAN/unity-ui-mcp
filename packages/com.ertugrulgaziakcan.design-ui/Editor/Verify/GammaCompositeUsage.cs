using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>
    /// Whether the game shows design screens the way verify captures them in a Linear-colour-space project: the colour path
    /// a capture renders through, and a warning when the profile says Gamma Composite but no scene or prefab of the project
    /// has <c>DesignUiGammaComposite</c> (an ordinary on-screen panel blends in linear light and does not match the verdict).
    /// Verify (the capture's meta, the comparison) and the Design UI window report it; a region logs it at runtime.
    /// </summary>
    internal static class GammaCompositeUsage
    {
        internal const string ScriptPath = "Packages/com.ertugrulgaziakcan.design-ui/Runtime/DesignUiGammaComposite.cs";

        /// <summary>
        /// The colour path a capture renders through: <c>gamma-project</c> (a Gamma project blends in gamma space; it has no
        /// composite), <c>linear-panel</c> (an ordinary on-screen panel of a Linear project) or <c>gamma-composite</c>.
        /// </summary>
        internal static string CapturePath(DesignUiProfile profile) =>
            QualitySettings.activeColorSpace != ColorSpace.Linear ? "gamma-project"
            : profile != null && profile.colorPath == DesignColorPath.LinearPanel ? "linear-panel"
            : "gamma-composite";

        /// <summary>
        /// Whether a scene or prefab under <paramref name="assetsDir"/> has the component (its script's GUID in the YAML).
        /// A component that code adds at runtime is not seen.
        /// </summary>
        internal static bool InProject(string assetsDir = "Assets")
        {
            var guid = AssetDatabase.AssetPathToGUID(ScriptPath);
            if (string.IsNullOrEmpty(guid) || !Directory.Exists(assetsDir)) return false;
            var needle = "guid: " + guid;
            foreach (var pattern in new[] { "*.unity", "*.prefab" })
                foreach (var file in Directory.EnumerateFiles(assetsDir, pattern, SearchOption.AllDirectories))
                {
                    try
                    {
                        if (File.ReadLines(file).Any(l => l.Contains(needle))) return true;
                    }
                    catch (IOException) { } // a file being written: the next check reads it
                    catch (UnauthorizedAccessException) { }
                }
            return false;
        }

        /// <summary>The warning for a Linear project on the Gamma Composite path without the component; null otherwise.</summary>
        internal static string Warning(DesignUiProfile profile, string assetsDir = "Assets")
        {
            if (CapturePath(profile) != "gamma-composite" || InProject(assetsDir)) return null;
            return "Linear colour space and the profile's colour path Gamma Composite, but no scene or prefab of the project has DesignUiGammaComposite: " +
                   "in game the design screens blend translucent colours and text edges in linear light and will not match verify. Add Design UI > " +
                   "Gamma Composite with the design PanelSettings (ignore this if code adds it at runtime), or set the colour path to Linear Panel.";
        }
    }
}
