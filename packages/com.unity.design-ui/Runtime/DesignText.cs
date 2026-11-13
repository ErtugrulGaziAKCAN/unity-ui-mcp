using System;
using System.Collections.Generic;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace DesignUi
{
    /// <summary>
    /// Kerned text from the first layout. A dynamic font asset adds a glyph the moment text needs it, but the kerning pairs
    /// of that glyph only in its update queue, after the text was laid out; UI Toolkit keeps that unkerned layout (Unity
    /// 6000.3, standard text generator). Adding the characters with their font features before the text is laid out avoids
    /// it: the compiler does it for every string of a screen, and runtime code assigns a bound text with
    /// <see cref="SetText"/>.
    /// </summary>
    public static class DesignText
    {
        /// <summary>The screens' font set <see cref="SetText"/> uses when none is passed (the compiler's <c>DesignFonts.asset</c>).</summary>
        public static DesignFontSet Fonts { get; set; }

        /// <summary>
        /// Assigns <paramref name="text"/> to <paramref name="element"/> after adding its characters, with their kerning pairs,
        /// to the twins of the element's locale in <paramref name="fonts"/> (or <see cref="Fonts"/>): the locale is the class
        /// <c>locale-&lt;code&gt;</c> of the element or an ancestor (the compiled screen root carries it), else the set's
        /// reference locale. This needs no resolved style, so it works right after the screen is cloned or attached. The
        /// element's resolved font, when it has one, is prepared too.
        /// </summary>
        public static void SetText(TextElement element, string text, DesignFontSet fonts = null)
        {
            if (element == null) throw new ArgumentNullException(nameof(element));
            var set = fonts != null ? fonts : Fonts;
            if (set != null && !string.IsNullOrEmpty(text))
                foreach (var font in set.FontsFor(DesignFontSet.LocaleOf(element))) Prepare(font, text);
            var resolved = element.panel != null ? element.resolvedStyle.unityFontDefinition.fontAsset : null;
            if (resolved != null) Prepare(resolved, text);
            element.text = text;
        }

        /// <summary>
        /// Adds every character of <paramref name="text"/> to a dynamic <paramref name="font"/> now, with its font features
        /// (kerning pairs, mark positioning, ligatures); characters the font lacks go to its fallbacks, in order. Every face of
        /// the weight tables of the fonts that take characters gets them too (bold text renders from those). Returns the
        /// characters no font of the chain has (control characters are ignored). Static fonts are only searched. A text whose
        /// characters are all present returns at once.
        /// </summary>
        public static string Prepare(FontAsset font, string text)
        {
            if (font == null || string.IsNullOrEmpty(text) || AllPresent(font, text)) return "";
            var codes = CodePoints(text);
            if (codes.Length == 0) return "";
            var missing = Add(font, codes, new HashSet<FontAsset>(), true);
            var sb = new System.Text.StringBuilder();
            foreach (var c in missing) sb.Append(char.ConvertFromUtf32((int)c));
            return sb.ToString();
        }

        /// <summary>Whether the font and every face of its weight table already have every character (no allocation).</summary>
        static bool AllPresent(FontAsset font, string text)
        {
            if (!Has(font, text)) return false;
            foreach (var pair in font.fontWeightTable ?? new UnityEngine.TextCore.Text.FontWeightPair[0])
                if (pair.regularTypeface != null && !Has(pair.regularTypeface, text) || pair.italicTypeface != null && !Has(pair.italicTypeface, text)) return false;
            return true;
        }

        static bool Has(FontAsset font, string text)
        {
            var table = font.characterLookupTable;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (char.IsControl(c)) continue;
                if (char.IsSurrogate(c)) return false; // the slow path handles code points beyond the BMP
                if (!table.ContainsKey(c)) return false;
            }
            return true;
        }

        /// <summary>The distinct Unicode code points of <paramref name="text"/> without control characters.</summary>
        static uint[] CodePoints(string text)
        {
            var codes = new List<uint>();
            var seen = new HashSet<uint>();
            for (int i = 0; i < text.Length; i++)
            {
                int cp;
                if (char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) cp = char.ConvertToUtf32(text[i], text[++i]);
                else if (char.IsSurrogate(text[i]) || char.IsControl(text[i])) continue;
                else cp = text[i];
                if (seen.Add((uint)cp)) codes.Add((uint)cp);
            }
            return codes.ToArray();
        }

        /// <summary>
        /// Adds what it can to <paramref name="font"/> and to its weight faces, the rest to its fallbacks (each with its own
        /// weight faces); returns what none has.
        /// </summary>
        static uint[] Add(FontAsset font, uint[] codes, HashSet<FontAsset> visited, bool withFaces)
        {
            if (font == null || codes.Length == 0 || !visited.Add(font)) return codes;
            var missing = AddTo(font, codes);
            if (withFaces)
                foreach (var pair in font.fontWeightTable ?? new UnityEngine.TextCore.Text.FontWeightPair[0])
                {
                    if (pair.regularTypeface != null && pair.regularTypeface != font) AddTo(pair.regularTypeface, codes);
                    if (pair.italicTypeface != null && pair.italicTypeface != font) AddTo(pair.italicTypeface, codes);
                }
            foreach (var fallback in font.fallbackFontAssetTable ?? new List<FontAsset>())
            {
                if (missing.Length == 0) break;
                missing = Add(fallback, missing, visited, true);
            }
            return missing;
        }

        /// <summary>Adds the characters one font lacks (with font features); returns those it does not have.</summary>
        static uint[] AddTo(FontAsset font, uint[] codes)
        {
            var table = font.characterLookupTable;
            var toAdd = new List<uint>();
            foreach (var c in codes) if (!table.ContainsKey(c)) toAdd.Add(c);
            if (toAdd.Count == 0) return new uint[0];
            if (font.atlasPopulationMode == UnityEngine.TextCore.Text.AtlasPopulationMode.Static) return toAdd.ToArray();
            font.TryAddCharacters(toAdd.ToArray(), out var notAdded, true);
            return notAdded ?? new uint[0];
        }
    }
}
