using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine.UIElements;

namespace DesignUi.Editor
{
    /// <summary>
    /// Keeps the root scale's held PanelSettings factor out of every file (docs/findings/viewport-classes.md): a design screen
    /// on a runtime panel at a scaled viewport writes its PanelSettings' <c>scale</c> in memory, also in Edit mode, where
    /// that object is the project's asset. Unity writes assets only through a save, and every save (an asset save, the
    /// Editor's File > Save, a save after an Inspector edit, the save when the Editor quits) asks
    /// <see cref="AssetModificationProcessor"/> first with the paths it writes: a held PanelSettings among them gets its own
    /// factor for the write and is held again from the Editor's next update. A scene file only references the asset.
    /// </summary>
    internal static class RootScaleSaveGuard
    {
        /// <summary>Gives back the factor of every held PanelSettings asset among <paramref name="paths"/>; returns how many (tests).</summary>
        internal static int BeforeSave(IReadOnlyCollection<string> paths)
        {
            if (paths == null || paths.Count == 0) return 0;
            var set = new HashSet<string>(paths, StringComparer.Ordinal);
            return DesignRootScalePanels.GiveBackForSave(settings =>
            {
                if (!EditorUtility.IsPersistent(settings)) return false;
                var path = AssetDatabase.GetAssetPath(settings);
                return !string.IsNullOrEmpty(path) && set.Contains(path);
            });
        }

        sealed class Saves : AssetModificationProcessor
        {
            static string[] OnWillSaveAssets(string[] paths)
            {
                BeforeSave(paths);
                return paths;
            }
        }
    }
}
