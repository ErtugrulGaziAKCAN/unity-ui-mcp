using System;
using System.Collections.Generic;
using System.Linq;
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
        /// <summary>
        /// Assigns <paramref name="text"/> to <paramref name="element"/> after adding its characters, with their kerning pairs,
        /// to the font the element renders with (its resolved <c>-unity-font-definition</c>, so the element must be in a
        /// panel with its styles resolved; otherwise the text is only assigned).
        /// </summary>
        public static void SetText(TextElement element, string text)
        {
            if (element == null) throw new ArgumentNullException(nameof(element));
            var font = element.panel != null ? element.resolvedStyle.unityFontDefinition.fontAsset : null;
            if (font != null) Prepare(font, text);
            element.text = text;
        }

        /// <summary>
        /// Adds every character of <paramref name="text"/> to a dynamic <paramref name="font"/> now, with its font features
        /// (kerning pairs, mark positioning, ligatures); characters the font lacks go to its fallbacks, in order. Every face of
        /// its weight table gets the whole text too (bold text renders from those). Returns the characters no font of the
        /// chain has (control characters are ignored). Static fonts are only searched.
        /// </summary>
        public static string Prepare(FontAsset font, string text)
        {
            if (font == null || string.IsNullOrEmpty(text)) return "";
            var codes = CodePoints(text);
            if (codes.Length == 0) return "";
            var missing = Add(font, codes, new HashSet<FontAsset>());
            var faces = new HashSet<FontAsset>();
            foreach (var pair in font.fontWeightTable ?? new UnityEngine.TextCore.Text.FontWeightPair[0])
            {
                if (pair.regularTypeface != null && pair.regularTypeface != font && faces.Add(pair.regularTypeface)) Add(pair.regularTypeface, codes, new HashSet<FontAsset> { font });
                if (pair.italicTypeface != null && pair.italicTypeface != font && faces.Add(pair.italicTypeface)) Add(pair.italicTypeface, codes, new HashSet<FontAsset> { font });
            }
            return string.Concat(missing.Select(c => char.ConvertFromUtf32((int)c)));
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

        /// <summary>Adds what it can to <paramref name="font"/>, the rest to its fallbacks; returns what none has.</summary>
        static uint[] Add(FontAsset font, uint[] codes, HashSet<FontAsset> visited)
        {
            if (font == null || codes.Length == 0 || !visited.Add(font)) return codes;
            uint[] missing;
            if (font.atlasPopulationMode == UnityEngine.TextCore.Text.AtlasPopulationMode.Static)
                missing = codes.Where(c => !font.characterLookupTable.ContainsKey(c)).ToArray();
            else
            {
                var toAdd = codes.Where(c => !font.characterLookupTable.ContainsKey(c)).ToArray();
                if (toAdd.Length == 0) missing = new uint[0];
                else
                {
                    font.TryAddCharacters(toAdd, out var notAdded, true);
                    missing = notAdded ?? new uint[0];
                }
            }
            foreach (var fallback in font.fallbackFontAssetTable ?? new List<FontAsset>())
            {
                if (missing.Length == 0) break;
                missing = Add(fallback, missing, visited);
            }
            return missing;
        }
    }
}
