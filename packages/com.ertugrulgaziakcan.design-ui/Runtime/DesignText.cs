using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine.TextCore.LowLevel;
using FontFeatureTable = UnityEngine.TextCore.Text.FontFeatureTable;
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

        // a region sets Fonts in Play; with domain reload off it would outlive Play and keep edit-mode SetText preparing glyphs
        [UnityEngine.RuntimeInitializeOnLoadMethod(UnityEngine.RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetFonts() => Fonts = null;
#if UNITY_EDITOR
        [UnityEditor.InitializeOnLoadMethod]
        static void ResetFontsAfterPlay() => UnityEditor.EditorApplication.playModeStateChanged +=
            s => { if (s == UnityEditor.PlayModeStateChange.EnteredEditMode) Fonts = null; };
#endif

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
            Prepare(element, text, fonts);
            if (element is DesignOverflowLabel cut) cut.FullText = text; // the label displays its cut (ruling R144)
            else element.text = text;
        }

        /// <summary>
        /// Adds the characters of <paramref name="text"/> to the fonts <paramref name="element"/> will render it with, as
        /// <see cref="SetText"/> does, without assigning it: for controls whose text is not a TextElement's own (a Toggle's
        /// label, a TextField's value, a DropdownField's value).
        /// </summary>
        public static void Prepare(VisualElement element, string text, DesignFontSet fonts = null)
        {
            if (element == null) throw new ArgumentNullException(nameof(element));
            if (string.IsNullOrEmpty(text)) return;
            var set = fonts != null ? fonts : Fonts;
            if (set != null)
            {
                var list = set.FontsFor(DesignFontSet.LocaleOf(element));
                for (int i = 0; i < list.Count; i++) Prepare(list[i], text);
            }
            var resolved = element.panel != null ? element.resolvedStyle.unityFontDefinition.fontAsset : null;
            if (resolved != null) Prepare(resolved, text);
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

        /// <summary>
        /// The face UI Toolkit draws <paramref name="font"/>'s text with in <paramref name="style"/> (<c>-unity-font-style</c>, which
        /// picks the 400 and 700 faces, upright and italic): TextCore takes the weight table's 700 face for bold, its italic face of
        /// 400 (of 700 for bold italic) for italic, and the font itself for normal text or when that entry is empty (it then
        /// synthesizes the style from the font). Reads the public weight table only.
        /// </summary>
        public static FontAsset DrawingFace(FontAsset font, UnityEngine.FontStyle style)
        {
            if (font == null) return null;
            bool bold = style == UnityEngine.FontStyle.Bold || style == UnityEngine.FontStyle.BoldAndItalic;
            bool italic = style == UnityEngine.FontStyle.Italic || style == UnityEngine.FontStyle.BoldAndItalic;
            if (!bold && !italic) return font;
            var table = font.fontWeightTable;
            int i = bold ? 7 : 4;
            if (table == null || table.Length <= i) return font;
            var face = italic ? table[i].italicTypeface : table[i].regularTypeface;
            return face != null ? face : font;
        }

        /// <summary>
        /// Whether the face that draws <paramref name="font"/>'s text in <paramref name="style"/> (<see cref="DrawingFace"/>)
        /// already has every character (no allocation): measuring the text adds no glyph to it.
        /// </summary>
        internal static bool Drawable(FontAsset font, UnityEngine.FontStyle style, string text)
        {
            var face = DrawingFace(font, style);
            return face != null && Has(face, text);
        }

        /// <summary>Whether the font and every face of its weight table already have every character (no allocation).</summary>
        internal static bool AllPresent(FontAsset font, string text)
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

        /// <summary>
        /// Adds the characters one font lacks (with font features); returns those it does not have. A line-box variant linked
        /// to its twin (<see cref="FontTwinLink"/>) gets them through the twin: they go to the twin's shared atlas, and every
        /// variant linked to it is linked again.
        /// </summary>
        static uint[] AddTo(FontAsset font, uint[] codes)
        {
            var source = FontTwinLink.SourceOf(font);
            if (source != null)
            {
                int before = source.characterTable.Count;
                var lacking = AddTo(source, codes);
                if (source.characterTable.Count != before) FontTwinLink.Refresh();
                FontTwinLink.Link(font, source);
                return lacking;
            }
            var table = font.characterLookupTable;
            var toAdd = new List<uint>();
            foreach (var c in codes) if (!table.ContainsKey(c)) toAdd.Add(c);
            if (toAdd.Count == 0) return new uint[0];
            if (font.atlasPopulationMode == UnityEngine.TextCore.Text.AtlasPopulationMode.Static) return toAdd.ToArray();
            int glyphs = font.glyphTable.Count;
            font.TryAddCharacters(toAdd.ToArray(), out var notAdded, true);
            // the pairs and mark records of every two of its glyphs, the new glyphs second too; then the new pairs, and any that
            // runtime text added since (TextCore adds those in its own queue), lose their lookup flags
            if (font.glyphTable.Count != glyphs) CompleteFeatures(font);
            ClearPairFlags(font);
            return notAdded ?? new uint[0];
        }

        static readonly FieldInfo s_NewlyAdded = typeof(FontAsset).GetField("m_GlyphIndexListNewlyAdded", Internal);
        static readonly MethodInfo s_UpdatePairs = typeof(FontAsset).GetMethod("UpdateGlyphAdjustmentRecords", Internal, null, Type.EmptyTypes, null);
        static readonly MethodInfo s_UpdateMarks = typeof(FontAsset).GetMethod("UpdateDiacriticalMarkAdjustmentRecords", Internal, null, Type.EmptyTypes, null);
        static readonly FieldInfo s_MarkToBase = typeof(FontFeatureTable).GetField("m_MarkToBaseAdjustmentRecords", Internal);
        static readonly FieldInfo s_MarkToMark = typeof(FontFeatureTable).GetField("m_MarkToMarkAdjustmentRecords", Internal);

        /// <summary>Removes the records of a mark list (TextCore's internal record types) whose two glyphs are not both held.</summary>
        static int RemoveRecords(System.Collections.IList list, string first, string second, HashSet<uint> have)
        {
            if (list == null || list.Count == 0) return 0;
            var type = list.GetType().IsGenericType ? list.GetType().GetGenericArguments()[0] : null;
            var a = type?.GetProperty(first, Internal);
            var b = type?.GetProperty(second, Internal);
            if (a == null || b == null) return 0;
            int removed = 0;
            for (int i = list.Count - 1; i >= 0; i--)
            {
                var r = list[i];
                if (have.Contains(Convert.ToUInt32(a.GetValue(r))) && have.Contains(Convert.ToUInt32(b.GetValue(r)))) continue;
                list.RemoveAt(i);
                removed++;
            }
            return removed;
        }

        /// <summary>
        /// Whether glyphs of <paramref name="font"/> wait for their kerning pairs in TextCore's update queue (a glyph UI Toolkit
        /// added while it laid text out; TextCore's newly added list), or null when this Unity version does not tell.
        /// </summary>
        internal static bool? FeaturesPending(FontAsset font) =>
            font == null || s_NewlyAdded == null ? (bool?)null : s_NewlyAdded.GetValue(font) is List<uint> l && l.Count > 0;

        /// <summary>How many kerning pairs <paramref name="font"/> holds (0 when this Unity version does not tell).</summary>
        internal static int PairCount(FontAsset font) => PairRecords(font)?.Count ?? 0;

        /// <summary>Whether this Unity version's FontAsset lets <see cref="CompleteFeatures"/> query its font engine records.</summary>
        internal static bool CanCompleteFeatures => s_NewlyAdded != null && s_UpdatePairs != null && s_UpdateMarks != null && s_PairList != null;

        /// <summary>
        /// Null when this Unity version's TextCore has every member <see cref="ClearPairFlags"/> and <see cref="CompleteFeatures"/>
        /// use, else what is missing (TextCore has no API for them: they are found by reflection, and a renamed one would turn
        /// them off silently). The locale controller reports it as an issue.
        /// </summary>
        public static string FeatureMembersMissing => s_FeatureCheck();

        internal static Func<string> s_FeatureCheck = MissingFeatureMembers;

        static string MissingFeatureMembers()
        {
            var missing = new List<string>();
            if (s_PairList == null) missing.Add("FontFeatureTable.glyphPairAdjustmentRecords");
            if (s_PairLookup == null) missing.Add("FontFeatureTable.m_GlyphPairAdjustmentRecordLookup");
            if (s_NewlyAdded == null) missing.Add("FontAsset.m_GlyphIndexListNewlyAdded");
            if (s_UpdatePairs == null) missing.Add("FontAsset.UpdateGlyphAdjustmentRecords()");
            if (s_UpdateMarks == null) missing.Add("FontAsset.UpdateDiacriticalMarkAdjustmentRecords()");
            return missing.Count == 0 ? null : string.Join(", ", missing) + " (Unity " + UnityEngine.Application.unityVersion + ")";
        }

        /// <summary>
        /// Gives a dynamic font every kerning pair and mark record of two of its own glyphs, and no record with a glyph it does
        /// not hold; returns how many records it removed. TextCore stores a new glyph's pairs with the new glyph first only,
        /// against every glyph of the font file (measured on 6000.3: 'T' alone brings 1004 pairs, 'T' never second; Inter holds
        /// about 280 per glyph), so a pair whose second glyph came later exists only in the first glyph's list of every glyph.
        /// Asking the font engine for the records of all its glyphs and keeping those of two of them keeps the pairs complete
        /// in any order the glyphs were added, and a twin's file small (docs/findings/font-twin-footprint.md).
        /// </summary>
        internal static int CompleteFeatures(FontAsset font)
        {
            if (font == null || font.fontFeatureTable == null || !CanCompleteFeatures || font.atlasPopulationMode == UnityEngine.TextCore.Text.AtlasPopulationMode.Static)
                return 0;
            var newly = s_NewlyAdded.GetValue(font) as List<uint>;
            if (newly == null) return 0;
            var have = new HashSet<uint>();
            foreach (var g in font.glyphTable) have.Add(g.index);
            newly.Clear();
            newly.AddRange(have);
            try
            {
                s_UpdatePairs.Invoke(font, null);
                s_UpdateMarks.Invoke(font, null);
            }
            catch (TargetInvocationException) { }
            finally { newly.Clear(); }
            int removed = 0;
            var table = font.fontFeatureTable;
            if (s_PairList.GetValue(table) is List<GlyphPairAdjustmentRecord> pairs)
                removed += pairs.RemoveAll(r => !have.Contains(r.firstAdjustmentRecord.glyphIndex) || !have.Contains(r.secondAdjustmentRecord.glyphIndex));
            removed += RemoveRecords(s_MarkToBase?.GetValue(table) as System.Collections.IList, "baseGlyphID", "markGlyphID", have);
            removed += RemoveRecords(s_MarkToMark?.GetValue(table) as System.Collections.IList, "baseMarkGlyphID", "combiningMarkGlyphID", have);
            // the lookups follow the lists
            font.ReadFontAssetDefinition();
            return removed;
        }

        /// <summary>
        /// Gives a dynamic font every kerning pair and mark record of two of its own glyphs that it lacks, and removes none;
        /// returns how many pairs it added. The text fit calls it before a measure while glyphs of the face wait for their pairs
        /// in TextCore's queue (a glyph UI Toolkit added while it laid text out). A line-box variant shares its twin's feature
        /// table (<see cref="FontTwinLink"/>), and the twin and each variant can hold glyphs the other lacks (each adds what its
        /// own text needs at runtime): taking out the records of glyphs this one does not hold, as <see cref="CompleteFeatures"/>
        /// does for a twin's file, would take the others' pairs away (fix round 3, N-7). TextCore's own queue adds them the same
        /// way, against every glyph of the font file; an import prunes a twin to its own glyphs' records (<see cref="CompleteFeatures"/>).
        /// </summary>
        internal static int AddFeatures(FontAsset font)
        {
            if (font == null || font.fontFeatureTable == null || !CanCompleteFeatures || font.atlasPopulationMode == UnityEngine.TextCore.Text.AtlasPopulationMode.Static)
                return 0;
            var newly = s_NewlyAdded.GetValue(font) as List<uint>;
            if (newly == null) return 0;
            int before = PairCount(font);
            newly.Clear();
            foreach (var g in font.glyphTable) newly.Add(g.index);
            try
            {
                // TextCore adds a glyph's records with the glyph first, against every glyph of the file, and keeps its lookups
                s_UpdatePairs.Invoke(font, null);
                s_UpdateMarks.Invoke(font, null);
            }
            catch (TargetInvocationException) { }
            finally { newly.Clear(); }
            return PairCount(font) - before;
        }

        const BindingFlags Internal = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
        static readonly PropertyInfo s_PairList = typeof(FontFeatureTable).GetProperty("glyphPairAdjustmentRecords", Internal);
        static readonly FieldInfo s_PairLookup = typeof(FontFeatureTable).GetField("m_GlyphPairAdjustmentRecordLookup", Internal);

        static List<GlyphPairAdjustmentRecord> PairRecords(FontAsset font) =>
            font != null && font.fontFeatureTable != null ? s_PairList?.GetValue(font.fontFeatureTable) as List<GlyphPairAdjustmentRecord> : null;

        /// <summary>
        /// Clears the lookup flags of a font's kerning pairs from record <paramref name="from"/> on; returns how many it
        /// changed. TextCore copies pair records from the font engine with flags it does not set (measured on 6000.3: values
        /// that change from run to run, such as 480 or 1137016832), and a record whose flags carry
        /// <c>IgnoreSpacingAdjustments</c> makes the standard generator drop the letter-spacing of both characters of the pair:
        /// a word with -0.72 px spacing and two such pairs was 1.44 px wider than in Chromium, which spaces every character.
        /// OpenType kerning has no such per-pair switch, so no pair of a twin keeps one.
        /// </summary>
        internal static int ClearPairFlags(FontAsset font, int from = 0)
        {
            var records = PairRecords(font);
            if (records == null) return 0;
            var lookup = s_PairLookup?.GetValue(font.fontFeatureTable) as Dictionary<uint, GlyphPairAdjustmentRecord>;
            int changed = 0;
            for (int i = Math.Max(0, from); i < records.Count; i++)
            {
                var r = records[i];
                if (r.featureLookupFlags == FontFeatureLookupFlags.None) continue;
                r.featureLookupFlags = FontFeatureLookupFlags.None;
                records[i] = r;
                if (lookup != null) lookup[(r.secondAdjustmentRecord.glyphIndex << 16) | r.firstAdjustmentRecord.glyphIndex] = r;
                changed++;
            }
            return changed;
        }
    }
}
