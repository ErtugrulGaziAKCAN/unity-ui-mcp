using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine.UIElements;

namespace DesignUi.Editor
{
    /// <summary>
    /// Keeps a factor the root scale holds in Play mode out of a file saved during Play (DesignRootScalePanels): in Play mode a
    /// design screen at a scaled viewport writes its PanelSettings' <c>scale</c> in memory, and that object is the project's
    /// asset. Unity writes assets only through a save, and every save that writes it asks
    /// <see cref="AssetModificationProcessor"/> first with the paths it writes: a held PanelSettings among them gets its own
    /// factor for the write and is held again from the Editor's next update. Outside Play mode nothing a save writes is held.
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
