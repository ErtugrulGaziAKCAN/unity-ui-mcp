using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.TextCore;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using FontFeatureTable = UnityEngine.TextCore.Text.FontFeatureTable;
using Object = UnityEngine.Object;

namespace DesignUi.Editor
{
    /// <summary>
    /// The Editor's side of <see cref="FontTwinLink"/>: a line-box variant's file holds no glyphs (only its face metrics,
    /// settings, fallbacks and weight table, with a 1×1 page), while the loaded variant renders its plain twin's glyphs.
    /// <para>Every save leaves a linked variant out, unless the package saves it itself (<see cref="Saving"/>), which it does
    /// only after <see cref="Unlink"/> gave the variant its own page, material and empty tables back. The Editor links the
    /// variants of every loaded font set after a script reload and after font assets were imported, and the generator links
    /// those of every run it makes.</para>
    /// </summary>
    [InitializeOnLoad]
    public static class TwinLinks
    {
        static int s_Saving;

        static TwinLinks()
        {
            EditorApplication.delayCall += () => LinkLoaded();
        }

        /// <summary>While the returned scope is open, saves keep linked variants (the package saves an unlinked variant).</summary>
        internal static IDisposable Saving() => new Scope();

        sealed class Scope : IDisposable
        {
            bool m_Done;
            public Scope() => s_Saving++;
            public void Dispose()
            {
                if (m_Done) return;
                m_Done = true;
                s_Saving--;
            }
        }

        /// <summary>Links the variants of every loaded font set (<see cref="DesignFontSet.LinkTwins"/>); returns how many it linked.</summary>
        public static int LinkLoaded()
        {
            int n = 0;
            foreach (var set in Resources.FindObjectsOfTypeAll<DesignFontSet>())
                if (set != null)
                    try { n += set.LinkTwins(); }
                    catch (Exception e) { Debug.LogException(e, set); }
            return n;
        }

        /// <summary>Links every line-box variant of a generator run to its plain twin; returns how many it linked.</summary>
        internal static int Link(FontTwinGenerator.TwinRun run)
        {
            int n = 0;
            foreach (var kv in run.Sources)
                if (kv.Key != null && kv.Value != null && FontTwinLink.Link(kv.Key, kv.Value)) n++;
            return n;
        }

        const BindingFlags Instance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        static void Set(FontAsset f, string field, object value) =>
            (typeof(FontAsset).GetField(field, Instance) ?? throw new FontSetupException("this Unity version's TextCore FontAsset has no " + field + " field"))
            .SetValue(f, value);

        /// <summary>
        /// Gives a linked variant its own state back, the state its file holds: empty glyph, character and font feature tables,
        /// its own first page (1×1) and material, and no page added since (those leave its file, without being destroyed).
        /// Does nothing to a variant that is not linked. Returns whether it changed.
        /// </summary>
        public static bool Unlink(FontAsset variant)
        {
            if (variant == null || !FontTwinLink.IsLinked(variant) && !SharesPages(variant)) return false;
            var path = AssetDatabase.GetAssetPath(variant);
            var subs = string.IsNullOrEmpty(path) ? new Object[0] : AssetDatabase.LoadAllAssetsAtPath(path);
            var material = subs.OfType<Material>().FirstOrDefault();
            var page = material != null && material.HasProperty("_MainTex") ? material.GetTexture("_MainTex") as Texture2D : null;
            if (page == null || AssetDatabase.GetAssetPath(page) != path) page = subs.OfType<Texture2D>().FirstOrDefault(t => t.name == variant.name + " Atlas") ?? subs.OfType<Texture2D>().FirstOrDefault();
            if (page == null || material == null)
                throw new FontSetupException("the line-box variant '" + path + "' has no atlas page or material of its own in its file; delete it, the next kit sync or import makes it again");
            // pages and materials TextCore added while it was linked leave the file, and are neither destroyed nor unloaded:
            // laid-out text and TextCore's material for that page may still draw from them (UI Toolkit keeps pooled text
            // meshes), and a page unloaded under them leaves a material without a texture
            foreach (var o in subs)
                if (o != null && o != variant && o != page && o != material && (o is Texture2D || o is Material))
                {
                    AssetDatabase.RemoveObjectFromAsset(o);
                    o.hideFlags |= HideFlags.DontUnloadUnusedAsset;
                }
            // pages TextCore made in memory for glyphs the variant added itself (not in any file) stay loaded too
            foreach (var p in variant.atlasTextures ?? new Texture2D[0])
                if (p != null && p != page && !EditorUtility.IsPersistent(p)) p.hideFlags |= HideFlags.DontUnloadUnusedAsset;
            FontTwinLink.Forget(variant);
            Set(variant, "m_GlyphTable", new List<UnityEngine.TextCore.Glyph>());
            Set(variant, "m_CharacterTable", new List<UnityEngine.TextCore.Text.Character>());
            Set(variant, "m_FontFeatureTable", Activator.CreateInstance(typeof(FontFeatureTable), true));
            Set(variant, "m_AtlasTextures", new[] { page });
            Set(variant, "m_AtlasTexture", null);
            Set(variant, "m_AtlasTextureIndex", 0);
            if (page.width > 1 || page.height > 1) page.Reinitialize(1, 1);
            Set(variant, "m_UsedGlyphRects", new List<GlyphRect>());
            Set(variant, "m_FreeGlyphRects", new List<GlyphRect> { new GlyphRect(0, 0, variant.atlasWidth - 1, variant.atlasHeight - 1) });
            variant.material = material;
            variant.ReadFontAssetDefinition();
            return true;
        }

        /// <summary>Whether the variant's first page is another asset's (it was linked before a script reload).</summary>
        static bool SharesPages(FontAsset variant)
        {
            var pages = variant.atlasTextures;
            if (pages == null || pages.Length == 0 || pages[0] == null) return false;
            var own = AssetDatabase.GetAssetPath(variant);
            var at = AssetDatabase.GetAssetPath(pages[0]);
            return !string.IsNullOrEmpty(at) && at != own;
        }

        /// <summary>
        /// Whether a variant holds what its file must hold: no glyphs, characters or font features and one empty page. A linked
        /// variant counts as empty when its file is small (an older package wrote every variant with its own atlas and tables).
        /// </summary>
        internal static bool IsEmpty(FontAsset variant)
        {
            if (FontTwinLink.IsLinked(variant) || SharesPages(variant))
            {
                var path = AssetDatabase.GetAssetPath(variant);
                return !File.Exists(path) || new FileInfo(path).Length < EmptyFileLimit;
            }
            var pages = variant.atlasTextures ?? new Texture2D[0];
            var table = variant.fontFeatureTable;
            var pairs = table != null ? s_Pairs?.GetValue(table) as System.Collections.ICollection : null;
            return variant.glyphTable.Count == 0 && variant.characterTable.Count == 0 && pages.Length == 1 && pages[0] != null && pages[0].width <= 1 &&
                   (pairs == null || pairs.Count == 0);
        }

        static readonly FieldInfo s_Pairs = typeof(FontFeatureTable).GetField("m_GlyphPairAdjustmentRecords", Instance);

        /// <summary>An empty variant's file is a few KB; one an older package wrote holds an atlas and tables (MB).</summary>
        const long EmptyFileLimit = 256 * 1024;

        /// <summary>Saves leave out linked variants (their files hold no glyphs), except the package's own saves.</summary>
        sealed class Saves : AssetModificationProcessor
        {
            static string[] OnWillSaveAssets(string[] paths)
            {
                if (s_Saving > 0) return paths;
                var linked = new HashSet<string>(FontTwinLink.Linked().Select(AssetDatabase.GetAssetPath).Where(p => !string.IsNullOrEmpty(p)), StringComparer.Ordinal);
                if (linked.Count == 0) return paths;
                return paths.Where(p => !linked.Contains(p)).ToArray();
            }
        }

        /// <summary>A variant about to be deleted keeps its shared pages: it is unlinked first (TextCore destroys a font asset's pages with it).</summary>
        sealed class Deletes : AssetModificationProcessor
        {
            static AssetDeleteResult OnWillDeleteAsset(string path, RemoveAssetOptions options)
            {
                if (!TwinPlayGuard.IsTwin(path)) return AssetDeleteResult.DidNotDelete;
                foreach (var v in FontTwinLink.Linked())
                    if (v != null && AssetDatabase.GetAssetPath(v) == path)
                        try { Unlink(v); }
                        catch (FontSetupException) { }
                return AssetDeleteResult.DidNotDelete;
            }
        }
    }
}
