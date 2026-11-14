using UnityEditor;

namespace DesignUi.Editor
{
    /// <summary>
    /// The Editor's points for <see cref="TextAssetRegistry"/>: after a script reload (the Editor unloads assets then), when
    /// Play starts or stops, and after font assets were imported (a twin written or reimported is loaded again).
    /// </summary>
    [InitializeOnLoad]
    static class TextAssetRegistryHooks
    {
        static TextAssetRegistryHooks()
        {
            EditorApplication.delayCall += Repair;
            EditorApplication.playModeStateChanged += OnPlayMode;
        }

        static void OnPlayMode(PlayModeStateChange change)
        {
            if (change == PlayModeStateChange.EnteredPlayMode || change == PlayModeStateChange.EnteredEditMode) Repair();
        }

        static void Repair() => TextAssetRegistry.RepairLoaded();

        sealed class Imports : AssetPostprocessor
        {
            static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
            {
                foreach (var path in imported)
                    if (path.EndsWith(".asset", System.StringComparison.OrdinalIgnoreCase) &&
                        AssetDatabase.GetMainAssetTypeAtPath(path) == typeof(UnityEngine.TextCore.Text.FontAsset))
                    {
                        EditorApplication.delayCall -= Repair;
                        EditorApplication.delayCall += Repair;
                        return;
                    }
            }
        }
    }
}
