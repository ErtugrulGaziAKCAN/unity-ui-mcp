using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using UnityEditor;
using UnityEditorInternal;
using UnityEngine;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor
{
    /// <summary>
    /// Keeps what Play mode adds to the font twins out of their files. A twin is a dynamic font asset: text in Play adds
    /// glyphs to it (its tables, its atlas pixels, a first page grown from 1×1 to the atlas size, new pages that TextCore
    /// stores in the asset), with either generator: the standard one through <c>TryAddCharacters</c>, the advanced one
    /// through <c>TryAddGlyphs</c>, which reports nothing. The Editor would write all of that with the next save of the twin,
    /// so every Play session changed the twins in version control.
    /// <para>The guard works at the save layer, so it holds however glyphs get added: while Play runs (from the moment Play
    /// is requested), every save leaves out every twin; when Play stops, every loaded twin that differs from its state when
    /// Play started (its character, glyph and page counts and page sizes), or that is dirty, is reloaded from its file: its
    /// tables, its pages at the file's size with the file's pixels, its material, and no page the file does not have, with
    /// nothing left to save. A twin that cannot be reloaded is an error naming it. Imports and kit syncs refuse to run in
    /// Play (<see cref="DesignUiOps.PlayModeError"/>), so the characters an import pre-adds are always added in Edit mode and
    /// saved.</para>
    /// </summary>
    [InitializeOnLoad]
    public static class TwinPlayGuard
    {
        const string ActiveKey = "DesignUi.TwinPlayGuard.Active", StateKey = "DesignUi.TwinPlayGuard.State";

        /// <summary>A twin's file: <c>&lt;name&gt; UITK.asset</c> or a line-box variant <c>&lt;name&gt; UITK r125s16.asset</c>.</summary>
        static readonly Regex TwinFile = new Regex(Regex.Escape(FontTwinGenerator.Suffix) + @"( r\d+s\d+(p\d+)?(x\d+(p\d+)?)?)?\.asset$", RegexOptions.CultureInvariant);

        static bool s_SaveNoted;

        static TwinPlayGuard()
        {
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            // a guard left on in Edit mode (the Editor stopped during Play) gives its twins back once the Editor is ready; in
            // Play (a domain reload while entering it) the watch for a given-up Play entry resumes
            if (Active && !EditorApplication.isPlayingOrWillChangePlaymode)
                EditorApplication.delayCall += () => { if (Active && !EditorApplication.isPlayingOrWillChangePlaymode) End(); };
            else if (Active) EditorApplication.update += WatchAbortedPlay;
        }

        /// <summary>Whether Play's changes to the twins are being kept out of their files.</summary>
        public static bool Active
        {
            get => SessionState.GetBool(ActiveKey, false);
            private set => SessionState.SetBool(ActiveKey, value);
        }

        /// <summary>Whether <paramref name="path"/> is a twin's file.</summary>
        public static bool IsTwin(string path) => path != null && path.StartsWith("Assets/", StringComparison.Ordinal) && TwinFile.IsMatch(path);

        internal static void OnPlayModeChanged(PlayModeStateChange change)
        {
            // ExitingEditMode: before Play's domain reload and before any of Play's text; EnteredPlayMode: entered another way
            if (change == PlayModeStateChange.ExitingEditMode || change == PlayModeStateChange.EnteredPlayMode && !Active) Begin();
            else if (change == PlayModeStateChange.EnteredEditMode) End();
        }

        /// <summary>Whether the Editor is in or entering Play mode; tests replace it.</summary>
        internal static Func<bool> Playing = () => EditorApplication.isPlayingOrWillChangePlaymode;

        /// <summary>
        /// Ends a guard whose Play entry was given up (compile errors, a script or a dialog that cancelled it after
        /// ExitingEditMode): Unity sends no EnteredEditMode then, and the guard would keep every twin out of every save in Edit
        /// mode, an import's pre-added characters included. Runs on every editor update while the guard is on.
        /// </summary>
        internal static void WatchAbortedPlay()
        {
            if (!Active) { EditorApplication.update -= WatchAbortedPlay; return; }
            if (Playing()) return;
            EditorApplication.update -= WatchAbortedPlay;
            End();
        }

        /// <summary>The twins loaded now, by path.</summary>
        static Dictionary<string, FontAsset> LoadedTwins()
        {
            var twins = new Dictionary<string, FontAsset>(StringComparer.Ordinal);
            foreach (var f in Resources.FindObjectsOfTypeAll<FontAsset>())
            {
                if (f == null || !EditorUtility.IsPersistent(f)) continue;
                var path = AssetDatabase.GetAssetPath(f);
                if (IsTwin(path) && AssetDatabase.GetMainAssetTypeAtPath(path) == typeof(FontAsset) && AssetDatabase.LoadMainAssetAtPath(path) == f) twins[path] = f;
            }
            return twins;
        }

        /// <summary>What a glyph added in Play changes: character, glyph and page counts and the pages' sizes.</summary>
        internal static string Fingerprint(FontAsset f)
        {
            var pages = f.atlasTextures ?? new Texture2D[0];
            return f.characterTable.Count + "/" + f.glyphTable.Count + "/" + string.Join(",", pages.Select(p => p == null ? "-" : p.width + "x" + p.height));
        }

        static bool Dirty(FontAsset f) =>
            EditorUtility.IsDirty(f) || (f.atlasTextures ?? new Texture2D[0]).Any(p => p != null && EditorUtility.IsDirty(p)) || f.material != null && EditorUtility.IsDirty(f.material);

        /// <summary>Play starts: every save leaves the twins out from now on, and the loaded twins' state is noted.</summary>
        internal static void Begin()
        {
            var state = LoadedTwins().ToDictionary(kv => kv.Key, kv => Fingerprint(kv.Value), StringComparer.Ordinal);
            SessionState.SetString(StateKey, JsonConvert.SerializeObject(state));
            Active = true;
            s_SaveNoted = false;
            EditorApplication.update -= WatchAbortedPlay;
            EditorApplication.update += WatchAbortedPlay;
        }

        /// <summary>
        /// Play stops: every loaded twin that Play changed is reloaded from its file. Returns the twins reloaded; a twin that
        /// cannot be reloaded is an error naming it and is not returned.
        /// </summary>
        internal static IReadOnlyList<string> End()
        {
            Dictionary<string, string> state;
            try { state = JsonConvert.DeserializeObject<Dictionary<string, string>>(SessionState.GetString(StateKey, "{}")) ?? new Dictionary<string, string>(); }
            catch (JsonException) { state = new Dictionary<string, string>(); }
            Active = false;
            SessionState.EraseString(StateKey);
            var restored = new List<string>();
            // a line-box variant renders its plain twin's glyphs from that twin's pages (FontTwinLink): it first gets its own
            // state back, so a reload from its file never touches the shared pages, and it is linked again at the end
            foreach (var kv in LoadedTwins())
                if (IsVariant(kv.Key))
                    try { TwinLinks.Unlink(kv.Value); }
                    catch (FontSetupException e) { Debug.LogError("Design UI: " + e.Message, kv.Value); }
            foreach (var kv in LoadedTwins().OrderBy(kv => kv.Key, StringComparer.Ordinal))
            {
                bool changed = !state.TryGetValue(kv.Key, out var before) || before != Fingerprint(kv.Value) || Dirty(kv.Value);
                if (!changed) continue;
                if (!state.ContainsKey(kv.Key) && !Dirty(kv.Value)) continue; // loaded during Play and untouched as far as can be seen
                string error;
                try { if (Restore(kv.Key, out error)) { restored.Add(kv.Key); continue; } }
                catch (Exception e) { error = e.GetType().Name + ": " + e.Message; }
                Debug.LogError("Design UI: the font twin '" + kv.Key + "' could not be reloaded from its file after Play (" + error + "). What Play added to it is still in memory " +
                               "and would be written by its next save: reimport it (Assets > Reimport) before saving.", kv.Value);
            }
            TwinLinks.LinkLoaded();
            if (restored.Count > 0) TextAssetRegistry.RepairLoaded();
            return restored;
        }

        static readonly Regex VariantFile = new Regex(Regex.Escape(FontTwinGenerator.Suffix) + @" r\d+s\d+(p\d+)?(x\d+(p\d+)?)?\.asset$", RegexOptions.CultureInvariant);

        /// <summary>Whether <paramref name="path"/> is a line-box variant's file.</summary>
        internal static bool IsVariant(string path) => path != null && VariantFile.IsMatch(path);

        static readonly HashSet<string> Kept = new HashSet<string>(StringComparer.Ordinal)
        {
            "m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset", "m_GameObject", "m_Enabled", "m_EditorHideFlags",
            "m_Script", "m_Name", "m_EditorClassIdentifier", "m_AtlasTextures", "m_Material",
        };

        /// <summary>
        /// Reloads the loaded twin at <paramref name="path"/> from its file, read without importing it: every serialized field
        /// but its atlas and material references (which keep their objects), each page at the file's size and format with the
        /// file's pixels, the material's settings, no page the file does not have, and nothing dirty. False with the reason when
        /// it cannot.
        /// </summary>
        public static bool Restore(string path, out string error)
        {
            error = null;
            var twin = AssetDatabase.LoadAssetAtPath<FontAsset>(path);
            if (twin == null) { error = "no font asset is loaded from it"; return false; }
            if (!File.Exists(path)) { error = "its file is missing"; return false; }
            var saved = InternalEditorUtility.LoadSerializedFileAndForget(path);
            try
            {
                var file = saved?.OfType<FontAsset>().FirstOrDefault();
                if (file == null) { error = "its file holds no font asset"; return false; }
                var filePages = file.atlasTextures ?? new Texture2D[0];
                var pages = twin.atlasTextures ?? new Texture2D[0];
                if (pages.Length < filePages.Length) { error = "it has " + pages.Length + " atlas pages, its file " + filePages.Length; return false; }
                for (int i = 0; i < filePages.Length; i++)
                    if (filePages[i] == null || pages[i] == null) { error = "atlas page " + i + " is missing"; return false; }

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
                    Texture2D page = pages[i], from = filePages[i];
                    if (page.width != from.width || page.height != from.height || page.format != from.format)
                        page.Reinitialize(from.width, from.height, from.format, from.mipmapCount > 1);
                    page.SetPixelData(from.GetRawTextureData<byte>(), 0);
                    page.Apply(false, false);
                    EditorUtility.ClearDirty(page);
                }
                // pages Play added leave the file; they are not destroyed (text generation may still hold a queued texture)
                for (int i = filePages.Length; i < pages.Length; i++)
                    if (pages[i] != null && AssetDatabase.GetAssetPath(pages[i]) == path) AssetDatabase.RemoveObjectFromAsset(pages[i]);
                var material = twin.material;
                if (material != null && file.material != null)
                {
                    EditorUtility.CopySerialized(file.material, material);
                    if (filePages.Length > 0 && material.HasProperty("_MainTex")) material.SetTexture("_MainTex", pages[0]);
                }
                twin.ReadFontAssetDefinition();
                EditorUtility.ClearDirty(twin);
                if (material != null) EditorUtility.ClearDirty(material);
                return true;
            }
            finally
            {
                foreach (var o in saved ?? new Object[0]) if (o != null && !EditorUtility.IsPersistent(o)) Object.DestroyImmediate(o);
            }
        }

        /// <summary>While Play runs, a save leaves out every twin.</summary>
        sealed class Saves : AssetModificationProcessor
        {
            static string[] OnWillSaveAssets(string[] paths)
            {
                if (!Active) return paths;
                var kept = paths.Where(p => !IsTwin(p)).ToArray();
                if (kept.Length != paths.Length && !s_SaveNoted)
                {
                    s_SaveNoted = true;
                    Debug.LogWarning("Design UI: font twins are not saved during Play (what Play adds to them is taken back when Play stops): " +
                                     string.Join(", ", paths.Where(IsTwin)));
                }
                return kept;
            }
        }
    }
}
