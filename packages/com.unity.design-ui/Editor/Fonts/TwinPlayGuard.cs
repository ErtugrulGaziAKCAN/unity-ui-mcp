using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditorInternal;
using UnityEngine;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor
{
    /// <summary>
    /// Keeps what Play mode adds to the font twins out of their files. A twin is a dynamic font asset: text in Play adds
    /// glyphs to it (its tables, its atlas pixels, sometimes a new atlas page that TextCore stores in the asset), and the
    /// Editor writes all of that with the next save of the twin (any save, or the next import's pre-add), so every Play
    /// session changed the twins in version control. The characters an import pre-adds are added in Edit mode and are kept.
    /// <para>While Play runs, every twin TextCore reports as changed (its glyph and texture callbacks) is noted, and a save
    /// during Play leaves it out. When Play stops, each noted twin gets its file's state back: its tables, its atlas pixels,
    /// no page added in Play, nothing left to save.</para>
    /// </summary>
    [InitializeOnLoad]
    public static class TwinPlayGuard
    {
        const string ActiveKey = "DesignUi.TwinPlayGuard.Active", TouchedKey = "DesignUi.TwinPlayGuard.Touched";

        /// <summary>A twin's file: <c>&lt;name&gt; UITK.asset</c> or a line-box variant <c>&lt;name&gt; UITK r125s16.asset</c>.</summary>
        static readonly Regex TwinFile = new Regex(Regex.Escape(FontTwinGenerator.Suffix) + @"( r\d+s\d+(p\d+)?)?\.asset$", RegexOptions.CultureInvariant);

        static readonly HashSet<string> s_Touched = new HashSet<string>(StringComparer.Ordinal);
        static bool s_Hooked;

        static TwinPlayGuard()
        {
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            Hook();
            foreach (var p in SessionState.GetString(TouchedKey, "").Split('\n')) if (p.Length > 0) s_Touched.Add(p);
            if (EditorApplication.isPlaying && !Active) Begin(); // a script reload in Play
        }

        /// <summary>Whether twin changes are being noted (Play mode).</summary>
        public static bool Active
        {
            get => SessionState.GetBool(ActiveKey, false);
            private set => SessionState.SetBool(ActiveKey, value);
        }

        /// <summary>The twins changed since Play started.</summary>
        public static IReadOnlyCollection<string> Touched => s_Touched;

        static void Hook()
        {
            if (s_Hooked) return;
            s_Hooked = true;
            const BindingFlags F = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
            var update = typeof(FontAsset).GetField("RegisterResourceForUpdate", F);
            if (update != null && update.FieldType == typeof(Action<FontAsset>))
                update.SetValue(null, (Action<FontAsset>)update.GetValue(null) + OnChanged);
            var texture = typeof(FontAsset).GetField("OnFontAssetTextureChanged", F);
            if (texture != null && texture.FieldType == typeof(Action<Texture, FontAsset>))
                texture.SetValue(null, (Action<Texture, FontAsset>)texture.GetValue(null) + ((t, f) => OnChanged(f)));
        }

        /// <summary>Whether this Unity version tells the guard about changed font assets (TextCore's editor callbacks).</summary>
        public static bool Supported
        {
            get
            {
                var update = typeof(FontAsset).GetField("RegisterResourceForUpdate", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
                return update != null && update.FieldType == typeof(Action<FontAsset>);
            }
        }

        /// <summary>Whether <paramref name="path"/> is a twin's file.</summary>
        public static bool IsTwin(string path) => path != null && path.StartsWith("Assets/", StringComparison.Ordinal) && TwinFile.IsMatch(path);

        internal static void OnChanged(FontAsset font)
        {
            if (!Active || font == null || !EditorUtility.IsPersistent(font)) return;
            var path = AssetDatabase.GetAssetPath(font);
            if (!IsTwin(path) || !s_Touched.Add(path)) return;
            SessionState.SetString(TouchedKey, string.Join("\n", s_Touched));
        }

        internal static void OnPlayModeChanged(PlayModeStateChange change)
        {
            if (change == PlayModeStateChange.EnteredPlayMode) Begin();
            else if (change == PlayModeStateChange.EnteredEditMode) End();
        }

        /// <summary>Starts noting twin changes (Play started).</summary>
        internal static void Begin()
        {
            s_Touched.Clear();
            SessionState.EraseString(TouchedKey);
            Active = true;
        }

        /// <summary>Stops noting and gives every noted twin its file's state back (Play stopped). Returns the twins restored.</summary>
        internal static IReadOnlyList<string> End()
        {
            Active = false;
            var restored = new List<string>();
            foreach (var path in s_Touched.OrderBy(p => p, StringComparer.Ordinal).ToList())
            {
                try
                {
                    if (Restore(path)) restored.Add(path);
                }
                catch (Exception e)
                {
                    Debug.LogWarning("Design UI: could not give the font twin '" + path + "' its saved state back after Play (" + e.Message + "); " +
                                     "what Play added to it is saved with it unless you reimport it", AssetDatabase.LoadMainAssetAtPath(path));
                }
            }
            s_Touched.Clear();
            SessionState.EraseString(TouchedKey);
            if (restored.Count > 0) TextAssetRegistry.RepairLoaded();
            return restored;
        }

        static readonly HashSet<string> Kept = new HashSet<string>(StringComparer.Ordinal)
        {
            "m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset", "m_GameObject", "m_Enabled", "m_EditorHideFlags",
            "m_Script", "m_Name", "m_EditorClassIdentifier", "m_AtlasTextures", "m_Material",
        };

        /// <summary>
        /// Gives the loaded twin at <paramref name="path"/> the state its file holds: every serialized field but its atlas and
        /// material references, the pixels of its atlas pages, and no page the file does not have. Returns false when the
        /// twin is not loaded or its file cannot be read.
        /// </summary>
        public static bool Restore(string path)
        {
            var twin = AssetDatabase.LoadAssetAtPath<FontAsset>(path);
            if (twin == null) return false;
            var saved = InternalEditorUtility.LoadSerializedFileAndForget(path);
            try
            {
                var file = saved?.OfType<FontAsset>().FirstOrDefault();
                if (file == null) return false;
                var filePages = file.atlasTextures ?? new Texture2D[0];
                var pages = twin.atlasTextures ?? new Texture2D[0];
                if (pages.Length < filePages.Length) return false; // pages only grow in Play
                using (var source = new SerializedObject(file))
                using (var target = new SerializedObject(twin))
                {
                    var it = source.GetIterator();
                    for (var enter = true; it.Next(enter); enter = false)
                        if (!Kept.Contains(it.name)) target.CopyFromSerializedProperty(it);
                    var list = target.FindProperty("m_AtlasTextures");
                    list.arraySize = filePages.Length;
                    for (int i = 0; i < filePages.Length; i++) list.GetArrayElementAtIndex(i).objectReferenceValue = pages[i];
                    target.ApplyModifiedPropertiesWithoutUndo();
                }
                for (int i = 0; i < filePages.Length; i++)
                {
                    var page = pages[i];
                    var data = filePages[i] != null ? filePages[i].GetRawTextureData<byte>() : default;
                    if (page == null || !data.IsCreated || page.width != filePages[i].width || page.height != filePages[i].height || page.format != filePages[i].format) continue;
                    page.SetPixelData(data, 0);
                    page.Apply(false, false);
                    EditorUtility.ClearDirty(page);
                }
                for (int i = filePages.Length; i < pages.Length; i++)
                    if (pages[i] != null && AssetDatabase.GetAssetPath(pages[i]) == path)
                    {
                        AssetDatabase.RemoveObjectFromAsset(pages[i]);
                        Object.DestroyImmediate(pages[i], true);
                    }
                twin.ReadFontAssetDefinition();
                EditorUtility.ClearDirty(twin);
                if (twin.material != null) EditorUtility.ClearDirty(twin.material);
                return true;
            }
            finally
            {
                foreach (var o in saved ?? new Object[0]) if (o != null && !EditorUtility.IsPersistent(o)) Object.DestroyImmediate(o);
            }
        }

        /// <summary>A save during Play leaves out the twins Play changed.</summary>
        sealed class Saves : AssetModificationProcessor
        {
            static string[] OnWillSaveAssets(string[] paths) =>
                Active && s_Touched.Count > 0 ? paths.Where(p => !s_Touched.Contains(p)).ToArray() : paths;
        }
    }
}
