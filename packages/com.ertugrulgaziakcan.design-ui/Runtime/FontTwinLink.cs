using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;
using UnityEngine.TextCore;
using UnityEngine.TextCore.Text;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace DesignUi
{
    /// <summary>
    /// Line-box variants that share their source twin's glyphs instead of carrying copies (Unity 6000.3).
    /// <para>A line-box variant of a font twin differs from its twin only in its face metrics (line height, ascent and
    /// descent lines). On disk it holds only those and its settings: no glyphs, no characters, no font features, a 1×1 atlas
    /// page. <see cref="Link"/> gives the loaded variant its source's glyphs in memory: the same glyph objects and font
    /// feature table, characters of its own (TextCore takes a character's font asset as the one whose face metrics lay the
    /// line out), and the source's atlas pages and material by reference, with no free atlas space, so a glyph the variant
    /// adds later goes to a page of its own and never into the shared pages. A variant never linked still renders: it is an
    /// ordinary dynamic font asset that adds its glyphs when text needs them.</para>
    /// <para>The compiled font set (<see cref="DesignFontSet"/>) lists every variant with its source and links them when it
    /// is loaded; a compiled screen's UXML references its font set, so loading a screen links its fonts before any text is
    /// laid out. The locale controller and <see cref="DesignText"/> link again when a source gained glyphs since.</para>
    /// <para>TextCore has no API for this: the fields are set by reflection. On a Unity version whose FontAsset lacks one of
    /// them, nothing is linked and the variants render as ordinary dynamic font assets (<see cref="Lookup"/> says why).</para>
    /// </summary>
    public static class FontTwinLink
    {
        const BindingFlags Instance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        static readonly FieldInfo s_Glyphs = Field("m_GlyphTable");
        static readonly FieldInfo s_Characters = Field("m_CharacterTable");
        static readonly FieldInfo s_Features = Field("m_FontFeatureTable");
        static readonly FieldInfo s_Pages = Field("m_AtlasTextures");
        static readonly FieldInfo s_Page0 = Field("m_AtlasTexture");
        static readonly FieldInfo s_PageIndex = Field("m_AtlasTextureIndex");
        static readonly FieldInfo s_Used = Field("m_UsedGlyphRects");
        static readonly FieldInfo s_Free = Field("m_FreeGlyphRects");
        static readonly FieldInfo s_Width = Field("m_AtlasWidth");
        static readonly FieldInfo s_Height = Field("m_AtlasHeight");
        static readonly FieldInfo s_IsClone = Field("m_IsClone");

        static FieldInfo Field(string name) => typeof(FontAsset).GetField(name, Instance);

        static readonly FieldInfo[] s_All = { s_Glyphs, s_Characters, s_Features, s_Pages, s_Page0, s_PageIndex, s_Used, s_Free, s_Width, s_Height, s_IsClone };

        /// <summary>What the variant links are set through on this Unity version, or why there are none.</summary>
        public static string Lookup
        {
            get
            {
                var missing = new List<string>();
                string[] names = { "m_GlyphTable", "m_CharacterTable", "m_FontFeatureTable", "m_AtlasTextures", "m_AtlasTexture", "m_AtlasTextureIndex",
                    "m_UsedGlyphRects", "m_FreeGlyphRects", "m_AtlasWidth", "m_AtlasHeight", "m_IsClone" };
                for (int i = 0; i < s_All.Length; i++) if (s_All[i] == null) missing.Add(names[i]);
                return missing.Count == 0
                    ? "UnityEngine.TextCore.Text.FontAsset fields (tables, atlas pages, glyph rects, m_IsClone)"
                    : "none: UnityEngine.TextCore.Text.FontAsset has no " + string.Join(", ", missing) + " on Unity " + Application.unityVersion;
            }
        }

        /// <summary>What kit sync and imports report when <see cref="Supported"/> is false.</summary>
        public static string FallbackNote =>
            "line-box font variants are not linked to their twins' atlases on this Unity version (" + Lookup + "): each keeps glyphs and atlas pages of " +
            "its own, so the twin folder takes more disk (they render the same)";

        /// <summary>Whether this Unity version's FontAsset has every field a link sets.</summary>
        public static bool Supported => Array.TrueForAll(s_All, f => f != null);

        sealed class State
        {
            public FontAsset Source;
            public int Glyphs, Characters, Pages;
            public Texture2D Page0;
        }

        static readonly Dictionary<FontAsset, State> s_Links = new Dictionary<FontAsset, State>();

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics() => s_Links.Clear();

        /// <summary>The twin <paramref name="variant"/> is linked to, or null.</summary>
        public static FontAsset SourceOf(FontAsset variant)
        {
            if (variant == null || !s_Links.TryGetValue(variant, out var s)) return null;
            if (s.Source == null || !Holds(variant, s)) { s_Links.Remove(variant); return null; }
            return s.Source;
        }

        /// <summary>Whether <paramref name="variant"/> renders its source's glyphs now.</summary>
        public static bool IsLinked(FontAsset variant) => SourceOf(variant) != null;

        /// <summary>The variants linked now (for the Editor's save filter and Play guard).</summary>
        public static List<FontAsset> Linked()
        {
            var list = new List<FontAsset>();
            foreach (var kv in s_Links) if (kv.Key != null && kv.Value.Source != null && Holds(kv.Key, kv.Value)) list.Add(kv.Key);
            return list;
        }

        // the variant still has the source's first page (nothing replaced its pages since the link: a reload from its file does)
        static bool Holds(FontAsset variant, State s)
        {
            var pages = variant.atlasTextures;
            return pages != null && pages.Length > 0 && pages[0] == s.Page0;
        }

        static bool Current(FontAsset variant, State s) =>
            Holds(variant, s) && s.Source.glyphTable.Count == s.Glyphs && s.Source.characterTable.Count == s.Characters &&
            (s.Source.atlasTextures?.Length ?? 0) == s.Pages && s.Source.atlasTextures[0] == s.Page0;

        /// <summary>
        /// Gives <paramref name="variant"/> the glyphs of <paramref name="source"/> (see the class summary). Does nothing when
        /// it is linked to that source already and the source gained nothing since, or when either is null, they are the same,
        /// the source has no atlas page, or this Unity version cannot link (<see cref="Supported"/>). Returns whether it linked.
        /// A variant that had glyphs of its own (pages added since an earlier link) loses them: its text adds them again.
        /// </summary>
        public static bool Link(FontAsset variant, FontAsset source)
        {
            if (variant == null || source == null || variant == source || !Supported) return false;
            var pages = source.atlasTextures;
            if (pages == null || pages.Length == 0 || pages[0] == null) return false;
            if (s_Links.TryGetValue(variant, out var known) && known.Source == source && Current(variant, known)) return false;
            bool relink = known != null;

            // the source's lookups and its characters' glyphs are set (a font loaded but not used yet has none)
            _ = source.characterLookupTable;
            var glyphs = new List<Glyph>(source.glyphTable);
            var characters = new List<Character>(source.characterTable.Count);
            foreach (var c in source.characterTable)
            {
                if (c?.glyph == null) continue;
                characters.Add(new Character(c.unicode, variant, c.glyph) { scale = c.scale });
            }
            int pageIndex = (int)s_PageIndex.GetValue(source);
            int width = source.atlasWidth, height = source.atlasHeight;
            s_Glyphs.SetValue(variant, glyphs);
            s_Characters.SetValue(variant, characters);
            s_Features.SetValue(variant, s_Features.GetValue(source));
            s_Pages.SetValue(variant, (Texture2D[])pages.Clone());
            s_Page0.SetValue(variant, null);
            s_PageIndex.SetValue(variant, pageIndex);
            s_Width.SetValue(variant, width);
            s_Height.SetValue(variant, height);
            // no free space: a glyph the variant adds goes to a new page of its own
            s_Used.SetValue(variant, new List<GlyphRect> { new GlyphRect(0, 0, width, height) });
            s_Free.SetValue(variant, new List<GlyphRect>());
            variant.material = source.material;
            // the shared pages and material are the source's: destroying the variant must not destroy them
            s_IsClone.SetValue(variant, true);
            variant.ReadFontAssetDefinition();

            s_Links[variant] = new State
            {
                Source = source, Glyphs = source.glyphTable.Count, Characters = source.characterTable.Count, Pages = pages.Length, Page0 = pages[0],
            };
            // other fonts may cache this variant's old characters as fallback characters; they look them up again
            if (relink) ClearFallbackCaches();
            return true;
        }

        /// <summary>Links each pair; returns how many changed.</summary>
        public static int Link(IReadOnlyList<(FontAsset variant, FontAsset source)> pairs)
        {
            int n = 0;
            if (pairs == null) return 0;
            for (int i = 0; i < pairs.Count; i++) if (Link(pairs[i].variant, pairs[i].source)) n++;
            return n;
        }

        /// <summary>
        /// Links again every linked variant whose source gained glyphs or pages since (<see cref="DesignText"/> adds a text's
        /// characters to the sources); returns how many.
        /// </summary>
        public static int Refresh()
        {
            int n = 0;
            foreach (var kv in new List<KeyValuePair<FontAsset, State>>(s_Links))
                if (kv.Key != null && kv.Value.Source != null && !Current(kv.Key, kv.Value) && Holds(kv.Key, kv.Value) && Link(kv.Key, kv.Value.Source)) n++;
            return n;
        }

        /// <summary>
        /// Forgets the link of <paramref name="variant"/> (the Editor, after it gave the variant its own pages and empty tables
        /// back, before saving it). Does not change the variant.
        /// </summary>
        internal static void Forget(FontAsset variant)
        {
            if (variant != null) s_Links.Remove(variant);
            if (variant != null && s_IsClone != null) s_IsClone.SetValue(variant, false);
        }

        static MethodInfo s_ClearFallback;
        static readonly FieldInfo s_Lookup = Field("m_CharacterLookupDictionary");

        static void ClearFallbackCaches()
        {
            s_ClearFallback = s_ClearFallback ?? typeof(FontAsset).GetMethod("ClearFallbackCharacterTable", Instance);
            if (s_ClearFallback == null || s_Lookup == null) return;
            foreach (var f in Resources.FindObjectsOfTypeAll<FontAsset>())
                if (f != null && s_Lookup.GetValue(f) != null)
                    try { s_ClearFallback.Invoke(f, null); }
                    catch (TargetInvocationException) { }
        }
    }
}
