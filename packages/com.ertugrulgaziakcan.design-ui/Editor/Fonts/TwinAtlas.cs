using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.TextCore.LowLevel;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using FontFeatureTable = UnityEngine.TextCore.Text.FontFeatureTable;

namespace DesignUi.Editor
{
    /// <summary>
    /// Keeps a plain font twin's file as small as its glyphs allow (docs/findings/font-twin-footprint.md).
    /// <para><b>Atlas pages sized to the glyphs.</b> A twin's pages are never larger than its TMP font asset's atlas, and no
    /// larger than the glyphs it holds need: the smallest power-of-two page (<see cref="MinPage"/> or more, never wider than
    /// twice its height) whose area holds the glyphs' padded rectangles with a quarter to spare. A twin whose page is larger, or whose
    /// glyphs take more than one page while a larger page would hold them, gets its glyphs again on a page of that size
    /// (characters, then glyphs added by index, with their font features), the next size up when they do not fit. Glyphs
    /// render the same on any page: a page only places them.</para>
    /// <para><b>Font features of its own glyphs only.</b> TextCore stores every kerning pair and mark position of a new glyph
    /// with any glyph of the font (Inter: about 280 pairs per glyph, 39,000 for 138 glyphs). A pair or mark record is kept only
    /// when the twin holds both of its glyphs: text never pairs a glyph the twin does not hold, and TextCore adds a new
    /// glyph's records with every glyph again.</para>
    /// </summary>
    internal static class TwinAtlas
    {
        /// <summary>
        /// The smallest page side a twin gets, within the TMP asset's atlas: room for text a game adds at runtime (a full page
        /// makes TextCore add a page, and in the Editor it then reimports the twin, which destroys a page added in memory while
        /// text still draws from it).
        /// </summary>
        public const int MinPage = 1024;

        /// <summary>Spare area over the glyphs' padded rectangles (the packer does not fill a page).</summary>
        const double Slack = 1.25;

        /// <summary>The first page size of a new plain twin: <see cref="MinPage"/>, within the TMP asset's atlas.</summary>
        public static Vector2Int InitialPage(TMP_FontAsset tmp) =>
            new Vector2Int(Math.Min(tmp.atlasWidth, MinPage), Math.Min(tmp.atlasHeight, MinPage));

        /// <summary>The page area the glyphs of <paramref name="twin"/> take, padding and packing border included, and the largest glyph.</summary>
        internal static (long area, int maxWidth, int maxHeight) GlyphArea(FontAsset twin)
        {
            long area = 0;
            int w = 0, h = 0, pad = twin.atlasPadding;
            foreach (var g in twin.glyphTable)
            {
                var r = g.glyphRect;
                if (r.width <= 0 || r.height <= 0) continue;
                int gw = r.width + pad * 2 + 1, gh = r.height + pad * 2 + 1;
                area += (long)gw * gh;
                w = Math.Max(w, gw);
                h = Math.Max(h, gh);
            }
            return (area, w, h);
        }

        /// <summary>
        /// The page that holds glyphs of <paramref name="area"/> (with <see cref="Slack"/>) and the largest glyph: powers of
        /// two from <see cref="MinPage"/>, the width at most twice the height, within <paramref name="cap"/>.
        /// </summary>
        internal static Vector2Int PageFor(long area, int maxWidth, int maxHeight, Vector2Int cap)
        {
            int w = Math.Min(MinPage, cap.x), h = Math.Min(MinPage, cap.y);
            long want = (long)Math.Ceiling(area * Slack);
            while (((long)w * h < want || w < maxWidth || h < maxHeight) && (w < cap.x || h < cap.y))
            {
                if (w <= h && w < cap.x || h >= cap.y) w *= 2;
                else h *= 2;
            }
            return new Vector2Int(Math.Min(w, cap.x), Math.Min(h, cap.y));
        }

        static Vector2Int Larger(Vector2Int p, Vector2Int cap) =>
            p.x <= p.y && p.x < cap.x ? new Vector2Int(Math.Min(p.x * 2, cap.x), p.y) : new Vector2Int(p.x, Math.Min(p.y * 2, cap.y));

        static readonly FieldInfo s_PageIndex = typeof(FontAsset).GetField("m_AtlasTextureIndex", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
        static readonly MethodInfo s_TryAddGlyphs = typeof(FontAsset).GetMethod("TryAddGlyphs", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public,
            null, new[] { typeof(List<uint>) }, null);

        /// <summary>How many pages hold glyphs.</summary>
        internal static int PagesInUse(FontAsset twin) => s_PageIndex != null ? (int)s_PageIndex.GetValue(twin) + 1 : twin.atlasTextures?.Length ?? 1;

        /// <summary>
        /// Gives <paramref name="twin"/> pages sized to its glyphs (see the class summary) when its pages are larger, or when its
        /// glyphs take more pages than they need. Its tables, fallbacks and weight table stay; nothing is saved. Returns whether
        /// it changed. Its line-box variants must be linked again afterwards.
        /// </summary>
        internal static bool Compact(FontAsset twin, TMP_FontAsset tmp)
        {
            var cap = new Vector2Int(Math.Max(1, tmp.atlasWidth), Math.Max(1, tmp.atlasHeight));
            var pages = twin.atlasTextures ?? new Texture2D[0];
            if (pages.Length == 0 || pages[0] == null) return false;
            if (twin.glyphTable.Count == 0)
            {
                // an empty twin keeps an empty page (a fresh twin's 1×1); a grown page goes
                if (pages[0].width <= 1 && PagesInUse(twin) == 1) return false;
                Repack(twin, InitialPage(tmp), new uint[0], new List<uint>());
                return true;
            }
            var (area, gw, gh) = GlyphArea(twin);
            var page = PageFor(area, gw, gh, cap);
            int used = PagesInUse(twin);
            bool larger = twin.atlasWidth > page.x || twin.atlasHeight > page.y;
            bool morePages = used > 1 && (twin.atlasWidth < cap.x || twin.atlasHeight < cap.y);
            if (!larger && !morePages) return false;

            var characters = twin.characterTable.Where(c => c != null).Select(c => c.unicode).Distinct().ToArray();
            var glyphs = twin.glyphTable.Select(g => g.index).Distinct().ToList();
            while (true)
            {
                Repack(twin, page, characters, glyphs);
                if (PagesInUse(twin) == 1 || page.x >= cap.x && page.y >= cap.y) break;
                page = Larger(page, cap);
            }
            return true;
        }

        /// <summary>Clears the twin's glyphs and pages (no page destroyed), sets its page size and adds the glyphs again.</summary>
        static void Repack(FontAsset twin, Vector2Int page, uint[] characters, List<uint> glyphs)
        {
            var path = AssetDatabase.GetAssetPath(twin);
            var pages = twin.atlasTextures ?? new Texture2D[0];
            // pages after the first leave the file without being destroyed (text generation may still hold a queued texture)
            if (pages.Length > 1)
            {
                for (int i = 1; i < pages.Length; i++)
                    if (pages[i] != null && !string.IsNullOrEmpty(path) && AssetDatabase.GetAssetPath(pages[i]) == path) AssetDatabase.RemoveObjectFromAsset(pages[i]);
                twin.atlasTextures = new[] { pages[0] };
            }
            using (var so = new SerializedObject(twin))
            {
                so.FindProperty("m_AtlasWidth").intValue = page.x;
                so.FindProperty("m_AtlasHeight").intValue = page.y;
                so.FindProperty("m_AtlasTextureIndex").intValue = 0;
                so.ApplyModifiedPropertiesWithoutUndo();
            }
            var material = twin.material;
            if (material != null)
            {
                if (material.HasProperty("_TextureWidth")) material.SetFloat("_TextureWidth", page.x);
                if (material.HasProperty("_TextureHeight")) material.SetFloat("_TextureHeight", page.y);
                if (material.HasProperty("_MainTex")) material.SetTexture("_MainTex", pages[0]);
            }
            // tables, font features and the first page (back to 1×1, grown to the new size by the first glyph)
            twin.ClearFontAssetData(true);
            if (characters.Length > 0) twin.TryAddCharacters(characters, out _, true);
            if (glyphs.Count > 0 && s_TryAddGlyphs != null)
            {
                var have = new HashSet<uint>(twin.glyphTable.Select(g => g.index));
                var rest = glyphs.Where(g => !have.Contains(g)).ToList();
                if (rest.Count > 0) s_TryAddGlyphs.Invoke(twin, new object[] { rest });
            }
            FontTwinGenerator.StoreSubAssets(twin);
        }

        /// <summary>
        /// Gives <paramref name="twin"/> every kerning pair and mark record of two of its own glyphs and no other
        /// (<see cref="DesignUi.DesignText.CompleteFeatures"/>); returns how many records it removed.
        /// </summary>
        internal static int PruneFeatures(FontAsset twin) => DesignUi.DesignText.CompleteFeatures(twin);

        /// <summary>
        /// Brings the plain twins of a run to their smallest form (<see cref="Compact"/>, <see cref="PruneFeatures"/>, kerning
        /// pairs without lookup flags), saves each twin that changed (asset-specific) and links every line-box variant of the run
        /// to its plain twin. Returns the twins saved.
        /// </summary>
        internal static List<string> Maintain(FontTwinGenerator.TwinRun run, IEnumerable<FontAsset> changedTwins = null)
        {
            var changed = new HashSet<FontAsset>(changedTwins ?? Enumerable.Empty<FontAsset>());
            var saved = new List<string>();
            foreach (var (twin, tmp) in run.Plains.ToList())
            {
                bool dirty = changed.Contains(twin);
                dirty |= Compact(twin, tmp);
                dirty |= PruneFeatures(twin) > 0;
                dirty |= DesignUi.DesignText.ClearPairFlags(twin) > 0;
                if (!dirty) continue;
                FontTwinGenerator.StoreSubAssets(twin); // a new atlas page belongs in the twin's file too
                EditorUtility.SetDirty(twin);
                AssetDatabase.SaveAssetIfDirty(twin);
                saved.Add(AssetDatabase.GetAssetPath(twin));
            }
            TwinLinks.Link(run);
            return saved;
        }
    }
}
