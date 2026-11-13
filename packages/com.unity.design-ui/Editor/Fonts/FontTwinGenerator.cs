using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEngine;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using TextCorePopulation = UnityEngine.TextCore.Text.AtlasPopulationMode;

namespace DesignUi.Editor
{
    /// <summary>
    /// UI Toolkit font twins (spec 6; docs/findings/m0.md, font twin). UI Toolkit text needs a TextCore <see cref="FontAsset"/>; a
    /// <see cref="TMP_FontAsset"/> cannot be referenced from USS. The twin of a TMP font asset is
    /// <c>&lt;folder&gt;/&lt;tmp.name&gt; UITK.asset</c>, made from the same source font with the TMP asset's sampling
    /// point size, padding, render mode and atlas size, always dynamic (the advanced text generator accepts no static
    /// font asset) with multi-atlas on. Its fallback list and weight table mirror the TMP asset's, as twins, in order.
    /// Idempotent: an up-to-date twin is returned as it is; a changed fallback list or weight table updates the twin in
    /// place; changed atlas settings or source font regenerate it. Writes use asset-specific saves only.
    /// </summary>
    public static class FontTwinGenerator
    {
        public const string Suffix = " UITK";

        public static FontAsset GetOrCreateTwin(TMP_FontAsset tmp, string folder) => GetOrCreateTwin(tmp, folder, new TwinRun());

        /// <summary>The twin's asset path; throws <see cref="FontSetupException"/> when the folder is not inside Assets/.</summary>
        public static string TwinPath(TMP_FontAsset tmp, string folder)
        {
            if (tmp == null) throw new ArgumentNullException(nameof(tmp));
            return CheckFolder(folder) + "/" + tmp.name + Suffix + ".asset";
        }

        /// <summary>One generation pass: the twins it made or checked (reused within the pass) and whether one was regenerated.</summary>
        internal sealed class TwinRun
        {
            public readonly Dictionary<TMP_FontAsset, FontAsset> Twins = new Dictionary<TMP_FontAsset, FontAsset>();
            /// <summary>An existing twin was deleted and made again: its GUID changed, so style sheets that reference it need a re-import.</summary>
            public bool Regenerated;
            readonly Dictionary<string, TMP_FontAsset> _paths = new Dictionary<string, TMP_FontAsset>(StringComparer.OrdinalIgnoreCase);

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

            var twin = AssetDatabase.LoadAssetAtPath<FontAsset>(path);
            if (twin == null && File.Exists(path))
                throw new FontSetupException("'" + path + "' is in the way of the UI Toolkit twin of TMP font asset '" + tmp.name + "': it is not a font asset. Move or delete it.");
            if (twin != null && !SameSettings(twin, tmp, font))
            {
                if (!AssetDatabase.DeleteAsset(path)) throw new FontSetupException("cannot delete the outdated UI Toolkit twin '" + path + "'");
                twin = null;
                run.Regenerated = true;
            }
            bool created = twin == null;
            if (created) twin = Create(tmp, font, path);
            run.Twins[tmp] = twin; // before the recursion: fallback lists may form cycles

            bool changed = created;
            var fallbacks = (tmp.fallbackFontAssetTable ?? new List<TMP_FontAsset>()).Where(f => f != null).Select(f => GetOrCreateTwin(f, folder, run)).ToList();
            if (twin.fallbackFontAssetTable == null || !twin.fallbackFontAssetTable.SequenceEqual(fallbacks))
            {
                twin.fallbackFontAssetTable = fallbacks;
                changed = true;
            }

            // fontWeightTable has an internal setter, but its getter returns the live array (docs/findings/m0.md, font twin)
            var source = tmp.fontWeightTable;
            var target = twin.fontWeightTable;
            if (target != null)
                for (int i = 0; i < target.Length; i++)
                {
                    var regular = source != null && i < source.Length && source[i].regularTypeface != null ? GetOrCreateTwin(source[i].regularTypeface, folder, run) : null;
                    var italic = source != null && i < source.Length && source[i].italicTypeface != null ? GetOrCreateTwin(source[i].italicTypeface, folder, run) : null;
                    if (target[i].regularTypeface != regular) { target[i].regularTypeface = regular; changed = true; }
                    if (target[i].italicTypeface != italic) { target[i].italicTypeface = italic; changed = true; }
                }

            if (changed)
            {
                EditorUtility.SetDirty(twin);
                AssetDatabase.SaveAssetIfDirty(twin);
            }
            return twin;
        }

        /// <summary>The dynamic twin as a new asset, with its first atlas texture and its material stored inside it.</summary>
        static FontAsset Create(TMP_FontAsset tmp, Font font, string path)
        {
            var twin = FontAsset.CreateFontAsset(font, SamplingSize(tmp), tmp.atlasPadding, tmp.atlasRenderMode, tmp.atlasWidth, tmp.atlasHeight,
                TextCorePopulation.Dynamic, true);
            if (twin == null)
                throw new FontSetupException("cannot load the font face of '" + AssetDatabase.GetAssetPath(font) + "' for the UI Toolkit twin of '" + tmp.name +
                                             "'; check that its importer includes the font data.");
            twin.name = Path.GetFileNameWithoutExtension(path);
            EnsureFolder(Path.GetDirectoryName(path)?.Replace('\\', '/'));
            AssetDatabase.CreateAsset(twin, path);
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
            return twin;
        }

        static int SamplingSize(TMP_FontAsset tmp) => Mathf.RoundToInt(tmp.faceInfo.pointSize);

        static void CheckSettings(TMP_FontAsset tmp)
        {
            if (SamplingSize(tmp) <= 0 || tmp.atlasWidth <= 0 || tmp.atlasHeight <= 0)
                throw new FontSetupException("TMP font asset '" + tmp.name + "' has no sampling point size or atlas size (" + SamplingSize(tmp) + ", " + tmp.atlasWidth + "×" +
                                             tmp.atlasHeight + "); regenerate it with the Font Asset Creator.");
        }

        static bool SameSettings(FontAsset twin, TMP_FontAsset tmp, Font font) =>
            twin.sourceFontFile == font &&
            twin.atlasPopulationMode == TextCorePopulation.Dynamic &&
            Mathf.RoundToInt(twin.faceInfo.pointSize) == SamplingSize(tmp) &&
            twin.atlasPadding == tmp.atlasPadding &&
            twin.atlasRenderMode == tmp.atlasRenderMode &&
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
