using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.TextCore;
using UnityEngine.TextCore.LowLevel;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using TextCorePopulation = UnityEngine.TextCore.Text.AtlasPopulationMode;

namespace DesignUi.Editor
{
    /// <summary>
    /// UI Toolkit font twins (spec 6; docs/findings/m0.md, font twin). UI Toolkit text needs a TextCore <see cref="FontAsset"/>; a
    /// <see cref="TMP_FontAsset"/> cannot be referenced from USS. The twin of a TMP font asset is
    /// <c>&lt;folder&gt;/&lt;tmp.name&gt; UITK.asset</c>, made from the same source font with the TMP asset's sampling
    /// point size, padding and atlas size, always dynamic (the advanced text generator accepts no static font asset) with
    /// multi-atlas on. The render mode is the TMP asset's when it is an SDF or colour mode; a bitmap mode (SMOOTH, RASTER)
    /// becomes SDFAA, the mode the fidelity measurements used, and is logged.
    /// <para>Fallbacks follow TMP's search order: the TMP asset's own fallback list, then the global fallbacks (TMP
    /// Settings' list), as twins, without duplicates or the twin itself. The weight table is mirrored as twins.</para>
    /// <para>Idempotent: an up-to-date twin is returned as it is. Changed fallbacks or weights update the twin; changed
    /// atlas settings or source font rebuild it in place, keeping its GUID, so every reference to it survives. Tables are
    /// written through SerializedObject, so the font asset refreshes its lookup and native data (OnValidate). Writes use
    /// asset-specific saves only.</para>
    /// </summary>
    public static class FontTwinGenerator
    {
        public const string Suffix = " UITK";

        /// <summary>The twin of <paramref name="tmp"/>, with TMP Settings' global fallbacks after its own.</summary>
        public static FontAsset GetOrCreateTwin(TMP_FontAsset tmp, string folder) =>
            GetOrCreateTwin(tmp, folder, new TwinRun(TmpSettingsFontResolver.GlobalFallbacks()));

        /// <summary>The twin of <paramref name="tmp"/> with the given global fallbacks after its own.</summary>
        internal static FontAsset GetOrCreateTwin(TMP_FontAsset tmp, string folder, IEnumerable<TMP_FontAsset> globals) =>
            GetOrCreateTwin(tmp, folder, new TwinRun(globals));

        /// <summary>The twin's asset path; throws <see cref="FontSetupException"/> when the folder is not inside Assets/.</summary>
        public static string TwinPath(TMP_FontAsset tmp, string folder)
        {
            if (tmp == null) throw new ArgumentNullException(nameof(tmp));
            return CheckFolder(folder) + "/" + tmp.name + Suffix + ".asset";
        }

        /// <summary>The twin's render mode: the TMP asset's, except bitmap modes (SMOOTH, RASTER), which become SDFAA.</summary>
        public static GlyphRenderMode TwinRenderMode(TMP_FontAsset tmp) => IsBitmap(tmp.atlasRenderMode) ? GlyphRenderMode.SDFAA : tmp.atlasRenderMode;

        static bool IsBitmap(GlyphRenderMode mode) =>
            mode == GlyphRenderMode.SMOOTH || mode == GlyphRenderMode.SMOOTH_HINTED || mode == GlyphRenderMode.RASTER || mode == GlyphRenderMode.RASTER_HINTED;

        internal static string BitmapNote(TMP_FontAsset tmp) =>
            "TMP font asset '" + tmp.name + "' renders in " + tmp.atlasRenderMode + "; its UI Toolkit twin uses SDFAA (the fidelity measurements used SDF, " +
            "and a bitmap atlas blurs when UI Toolkit scales text)";

        /// <summary>
        /// The face info the twin of <paramref name="tmp"/> has (the font engine at the twin's sampling size), without
        /// creating or touching any asset. The kit's text styles are checked against it before twins are written.
        /// </summary>
        internal static FaceInfo TwinFaceInfo(TMP_FontAsset tmp)
        {
            var font = TmpSourceFont.GetSourceFont(tmp);
            CheckSettings(tmp);
            FontEngine.InitializeFontEngine();
            if (FontEngine.LoadFontFace(font, SamplingSize(tmp)) != FontEngineError.Success)
                throw new FontSetupException(NoFace(tmp, font));
            return FontEngine.GetFaceInfo();
        }

        /// <summary>One generation pass: the global fallbacks, the twins made or checked (reused within the pass) and notes.</summary>
        internal sealed class TwinRun
        {
            public readonly IReadOnlyList<TMP_FontAsset> Globals;
            public readonly Dictionary<TMP_FontAsset, FontAsset> Twins = new Dictionary<TMP_FontAsset, FontAsset>();
            /// <summary>Render-mode substitutions of this pass, one per TMP asset.</summary>
            public readonly List<string> Notes = new List<string>();
            readonly Dictionary<string, TMP_FontAsset> _paths = new Dictionary<string, TMP_FontAsset>(StringComparer.OrdinalIgnoreCase);

            public TwinRun(IEnumerable<TMP_FontAsset> globals)
            {
                Globals = (globals ?? new TMP_FontAsset[0]).Where(f => f != null).Distinct().ToList();
            }

            public void Claim(string path, TMP_FontAsset tmp)
            {
                if (_paths.TryGetValue(path, out var other) && other != tmp)
                    throw new FontSetupException("TMP font assets '" + AssetDatabase.GetAssetPath(other) + "' and '" + AssetDatabase.GetAssetPath(tmp) +
                                                 "' have the same name, so their UI Toolkit twins would both be '" + path + "'. Rename one of them.");
                _paths[path] = tmp;
            }
        }

        internal static FontAsset GetOrCreateTwin(TMP_FontAsset tmp, string folder, TwinRun run)
        {
            if (tmp == null) throw new ArgumentNullException(nameof(tmp));
            if (run.Twins.TryGetValue(tmp, out var known)) return known;
            var path = TwinPath(tmp, folder);
            run.Claim(path, tmp);
            var font = TmpSourceFont.GetSourceFont(tmp);
            CheckSettings(tmp);
            var mode = TwinRenderMode(tmp);
            if (mode != tmp.atlasRenderMode) run.Notes.Add(BitmapNote(tmp));

            var twin = AssetDatabase.LoadAssetAtPath<FontAsset>(path);
            if (twin == null && File.Exists(path))
                throw new FontSetupException("'" + path + "' is in the way of the UI Toolkit twin of TMP font asset '" + tmp.name + "': it is not a font asset. Move or delete it.");
            bool built = false;
            if (twin == null)
            {
                twin = Create(tmp, font, mode, path);
                built = true;
            }
            else if (!SameSettings(twin, font, tmp, mode))
            {
                Rebuild(twin, tmp, font, mode, path);
                Debug.Log("Design UI: rebuilt the UI Toolkit font twin '" + path + "' in place (the source font or atlas settings of '" + tmp.name + "' changed)", twin);
                built = true;
            }
            if (built && mode != tmp.atlasRenderMode) Debug.LogWarning(BitmapNote(tmp), twin);
            run.Twins[tmp] = twin; // before the recursion: fallback lists may form cycles

            // TMP's search order: the asset's own fallbacks, then the global ones; twins without duplicates or itself
            var fallbacks = new List<FontAsset>();
            foreach (var f in (tmp.fallbackFontAssetTable ?? new List<TMP_FontAsset>()).Concat(run.Globals))
            {
                if (f == null || f == tmp) continue;
                var t = GetOrCreateTwin(f, folder, run);
                if (t != twin && !fallbacks.Contains(t)) fallbacks.Add(t);
            }
            var weights = tmp.fontWeightTable ?? new TMP_FontWeightPair[0];
            var regular = weights.Select(w => w.regularTypeface != null ? GetOrCreateTwin(w.regularTypeface, folder, run) : null).ToArray();
            var italic = weights.Select(w => w.italicTypeface != null ? GetOrCreateTwin(w.italicTypeface, folder, run) : null).ToArray();

            if (Mirror(twin, fallbacks, regular, italic) || built)
            {
                EditorUtility.SetDirty(twin);
                AssetDatabase.SaveAssetIfDirty(twin);
            }
            return twin;
        }

        /// <summary>
        /// Writes the fallback list and the weight table through SerializedObject when they differ, so the font asset's
        /// OnValidate refreshes its lookup tables and native font data. Returns whether anything changed.
        /// </summary>
        static bool Mirror(FontAsset twin, List<FontAsset> fallbacks, FontAsset[] regular, FontAsset[] italic)
        {
            using (var so = new SerializedObject(twin))
            {
                var list = so.FindProperty("m_FallbackFontAssetTable");
                var table = so.FindProperty("m_FontWeightTable");
                if (list == null || table == null) throw new FontSetupException("this Unity version's TextCore FontAsset has no fallback list or weight table field");
                bool same = list.arraySize == fallbacks.Count;
                for (int i = 0; same && i < fallbacks.Count; i++) same = list.GetArrayElementAtIndex(i).objectReferenceValue == fallbacks[i];
                if (!same)
                {
                    list.arraySize = fallbacks.Count;
                    for (int i = 0; i < fallbacks.Count; i++) list.GetArrayElementAtIndex(i).objectReferenceValue = fallbacks[i];
                }
                for (int i = 0; i < table.arraySize; i++)
                {
                    var pair = table.GetArrayElementAtIndex(i);
                    Set(pair.FindPropertyRelative("regularTypeface"), i < regular.Length ? regular[i] : null);
                    Set(pair.FindPropertyRelative("italicTypeface"), i < italic.Length ? italic[i] : null);
                }
                return so.ApplyModifiedPropertiesWithoutUndo();
            }
        }

        static void Set(SerializedProperty p, FontAsset value)
        {
            if (p != null && p.objectReferenceValue != value) p.objectReferenceValue = value;
        }

        /// <summary>A new dynamic TextCore font asset, in memory.</summary>
        static FontAsset Build(TMP_FontAsset tmp, Font font, GlyphRenderMode mode)
        {
            var asset = FontAsset.CreateFontAsset(font, SamplingSize(tmp), tmp.atlasPadding, mode, tmp.atlasWidth, tmp.atlasHeight, TextCorePopulation.Dynamic, true);
            if (asset == null) throw new FontSetupException(NoFace(tmp, font));
            return asset;
        }

        /// <summary>The twin as a new asset, with its first atlas texture and its material stored inside it.</summary>
        static FontAsset Create(TMP_FontAsset tmp, Font font, GlyphRenderMode mode, string path)
        {
            var twin = Build(tmp, font, mode);
            twin.name = Path.GetFileNameWithoutExtension(path);
            EnsureFolder(Path.GetDirectoryName(path)?.Replace('\\', '/'));
            AssetDatabase.CreateAsset(twin, path);
            StoreSubAssets(twin);
            return twin;
        }

        /// <summary>Unity's object header fields, which stay the existing asset's when it is rebuilt.</summary>
        static readonly HashSet<string> Header = new HashSet<string>(StringComparer.Ordinal)
        {
            "m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset", "m_GameObject", "m_Enabled", "m_EditorHideFlags",
            "m_Script", "m_Name", "m_EditorClassIdentifier",
        };

        /// <summary>
        /// Rebuilds an outdated twin in place: the existing asset object (and so its GUID and every reference to it) stays,
        /// its old atlas textures and material are removed, and the state of a freshly built font asset is copied in.
        /// </summary>
        static void Rebuild(FontAsset twin, TMP_FontAsset tmp, Font font, GlyphRenderMode mode, string path)
        {
            var fresh = Build(tmp, font, mode);
            // the old sub-assets leave the file; they are not destroyed: text generation may still hold a queued atlas texture
            foreach (var sub in AssetDatabase.LoadAllAssetsAtPath(path).Where(o => o != null && o != twin).ToList())
                AssetDatabase.RemoveObjectFromAsset(sub);
            using (var source = new SerializedObject(fresh))
            using (var target = new SerializedObject(twin))
            {
                var it = source.GetIterator();
                for (var enter = true; it.Next(enter); enter = false)
                    if (!Header.Contains(it.name)) target.CopyFromSerializedProperty(it);
                target.ApplyModifiedPropertiesWithoutUndo();
            }
            // the atlas texture and material now belong to the twin: detach them before the in-memory asset is destroyed
            fresh.atlasTextures = new Texture2D[0];
            fresh.material = null;
            UnityEngine.Object.DestroyImmediate(fresh);
            StoreSubAssets(twin);
        }

        static void StoreSubAssets(FontAsset twin)
        {
            foreach (var texture in twin.atlasTextures ?? new Texture2D[0])
                if (texture != null && !AssetDatabase.Contains(texture))
                {
                    texture.name = twin.name + " Atlas";
                    AssetDatabase.AddObjectToAsset(texture, twin);
                }
            var material = twin.material;
            if (material != null && !AssetDatabase.Contains(material))
            {
                material.name = twin.name + " Material";
                AssetDatabase.AddObjectToAsset(material, twin);
            }
        }

        static string NoFace(TMP_FontAsset tmp, Font font) =>
            "cannot load the font face of '" + AssetDatabase.GetAssetPath(font) + "' for the UI Toolkit twin of '" + tmp.name + "'; check that its importer includes the font data.";

        static int SamplingSize(TMP_FontAsset tmp) => Mathf.RoundToInt(tmp.faceInfo.pointSize);

        static void CheckSettings(TMP_FontAsset tmp)
        {
            if (SamplingSize(tmp) <= 0 || tmp.atlasWidth <= 0 || tmp.atlasHeight <= 0)
                throw new FontSetupException("TMP font asset '" + tmp.name + "' has no sampling point size or atlas size (" + SamplingSize(tmp) + ", " + tmp.atlasWidth + "×" +
                                             tmp.atlasHeight + "); regenerate it with the Font Asset Creator.");
        }

        static bool SameSettings(FontAsset twin, Font font, TMP_FontAsset tmp, GlyphRenderMode mode) =>
            twin.sourceFontFile == font &&
            twin.atlasPopulationMode == TextCorePopulation.Dynamic &&
            Mathf.RoundToInt(twin.faceInfo.pointSize) == SamplingSize(tmp) &&
            twin.atlasPadding == tmp.atlasPadding &&
            twin.atlasRenderMode == mode &&
            twin.atlasWidth == tmp.atlasWidth &&
            twin.atlasHeight == tmp.atlasHeight &&
            twin.isMultiAtlasTexturesEnabled;

        static string CheckFolder(string folder)
        {
            var f = (folder ?? "").Replace('\\', '/').Trim().TrimEnd('/');
            if (f != "Assets" && !f.StartsWith("Assets/", StringComparison.Ordinal) || f.Split('/').Any(part => part.Length == 0 || part == "." || part == ".."))
                throw new FontSetupException("the font twin folder must be a folder inside Assets/ (the profile's fontTwinFolder is '" + folder + "')");
            return f;
        }

        static void EnsureFolder(string folder)
        {
            if (string.IsNullOrEmpty(folder) || AssetDatabase.IsValidFolder(folder)) return;
            var slash = folder.LastIndexOf('/');
            if (slash <= 0) return;
            EnsureFolder(folder.Substring(0, slash));
            AssetDatabase.CreateFolder(folder.Substring(0, slash), folder.Substring(slash + 1));
        }
    }
}
