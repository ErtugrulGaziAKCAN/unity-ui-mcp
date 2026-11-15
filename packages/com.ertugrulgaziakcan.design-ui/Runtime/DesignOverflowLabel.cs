using System;
using System.Globalization;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// A label the design aligns right or centred (or at the end) whose line can overflow its box (written by the compiler in
    /// place of a Label): the browser start-aligns a line that does not fit (CSS Text: an overflowing line is start-aligned),
    /// then clips it or puts the ellipsis where it is cut, so the visible text starts at the box's start edge; UI Toolkit
    /// aligns the cut text right or centred, which moved an ellipsized right-aligned line by up to a glyph. While its text
    /// does not wrap and is wider than its box this label is aligned at the start of its line (the design's vertical
    /// alignment kept): the left edge, or the right edge where its resolved language direction is right to left (an RTL
    /// locale with the advanced text generator, <see cref="LocaleFontController"/>); otherwise the design's alignment
    /// applies. Otherwise a Label.
    /// <para>It measures its text only when the text, its font (font asset, size, style, letter and word spacing), its width
    /// or the panel's scale changed since the last measurement: a style change that changes none of them (a colour, a
    /// state) only aligns it again. The compiler gives the type a custom property, so UI Toolkit tells it when its styles are
    /// resolved again (<c>CustomStyleResolvedEvent</c>); the design's alignment is read there, while no alignment of this
    /// label's own is set.</para>
    /// <para>A line that does not wrap and ends in an ellipsis (<c>text-overflow: ellipsis</c>) is cut by the browser's rule
    /// (ruling R144), not by UI Toolkit's text generator: the longest prefix (whole grapheme clusters) whose width plus the
    /// ellipsis's own width fits the content box, both measured as the fit measures text (<see cref="DesignTextFit"/>) at the
    /// layout scale, with the label's font, size and spacing. UI Toolkit's own elision depended on the root scale at the
    /// scaled viewports and kept a character the browser drops (a pilot's "Bayview…" against "Bayvie…"). The label keeps
    /// the whole text (<see cref="FullText"/>: what a view setter, <see cref="DesignView.GetText"/> and a String Table binding
    /// write or read), the layout measures it, and only the displayed text (<see cref="TextElement.text"/>, which UI Toolkit
    /// draws) is cut; a text written to it is taken as the new whole text. It cuts again only when the text, its font, size,
    /// spacing, its width or the panel's scale changed (a written text at the panel's next update). Right-to-left text and text the advanced generator lays out are left to UI Toolkit's own ellipsis: the
    /// shaper joins and reorders glyphs, so a cut of the logical text does not give the browser's visual cut.</para>
    /// </summary>
    [UxmlElement]
    public partial class DesignOverflowLabel : Label
    {
        public DesignOverflowLabel() : this(string.Empty) { }

        public DesignOverflowLabel(string text) : base(text)
        {
            // a new width, font, size, spacing or scale cuts the line again (after layout, before the draw)
            RegisterCallback<CustomStyleResolvedEvent>(_ => { OnStylesResolved(); Cut(); });
            RegisterCallback<GeometryChangedEvent>(_ => { OnGeometry(); Cut(); });
            // a text written to the label (a view setter, a binding) is its new whole text: cut at the next panel update
            RegisterCallback<ChangeEvent<string>>(e =>
            {
                if (e.target != this) return;
                if (!m_Writing) { Adopt(); RequestCut(); }
                Align();
            });
            RegisterCallback<AttachToPanelEvent>(_ => { m_Measured = false; m_CutDone = false; RequestCut(); });
        }

        /// <summary>Whether the text was wider than the box at the last check (the label is aligned at its start then).</summary>
        public bool Overflows { get; private set; }

        /// <summary>The ellipsis the browser and the label draw.</summary>
        internal const string Ellipsis = "\u2026";

        /// <summary>The whole text as written (null until one is written through <see cref="text"/>).</summary>
        string m_Full;
        /// <summary>The cut text this label displays, or null while it displays the whole text.</summary>
        string m_Cut;

        /// <summary>The text this label displays (its <see cref="TextElement.text"/>): the whole text, or its cut with the ellipsis (ruling R144).</summary>
        public string DisplayedText => text;

        /// <summary>
        /// The whole text: what was last written to the label, through this property or through <see cref="TextElement.text"/>
        /// (a view setter, a String Table binding), before the label cut it for display. Writing it cuts it again.
        /// </summary>
        public string FullText
        {
            get { Adopt(); return m_Full ?? text; }
            set
            {
                // shown whole at once (UI Toolkit's own ellipsis), cut at the panel's next update
                m_Full = value ?? string.Empty;
                m_Cut = null;
                m_CutDone = false;
                if (!string.Equals(text, m_Full, StringComparison.Ordinal))
                {
                    m_Writing = true;
                    try { text = m_Full; }
                    finally { m_Writing = false; }
                }
                RequestCut();
            }
        }

        /// <summary>A text written past <see cref="text"/> (the value interface, SetValueWithoutNotify) becomes the whole text.</summary>
        void Adopt()
        {
            if (m_Writing) return; // UI Toolkit reads the text while this label writes its display
            var shown = text;
            if (m_Full == null || !string.Equals(shown, m_Cut ?? m_Full, StringComparison.Ordinal))
            {
                m_Full = shown;
                m_Cut = null;
            }
        }

        /// <summary>How many times the label worked out a cut (tests: a repaint without a change cuts nothing).</summary>
        internal int Cuts { get; private set; }

        // the inputs of the last cut
        bool m_CutDone;
        string m_CutText;
        UnityEngine.TextCore.Text.FontAsset m_CutFont;
        float m_CutSize, m_CutLetter, m_CutWord, m_CutRoom, m_CutPpp;
        FontStyle m_CutStyle;

        /// <summary>The layout measures the whole text, so the box does not follow the cut (a cut shorter than its box would shrink a box that fits its text).</summary>
        protected override Vector2 DoMeasure(float desiredWidth, MeasureMode widthMode, float desiredHeight, MeasureMode heightMode) =>
            m_Cut != null && m_Full != null
                ? MeasureTextSize(m_Full, desiredWidth, widthMode, desiredHeight, heightMode)
                : base.DoMeasure(desiredWidth, widthMode, desiredHeight, heightMode);

        /// <summary>Displays the whole text, or its cut by the browser's rule where the line ends in an ellipsis and does not fit.</summary>
        void Cut()
        {
            Adopt();
            var full = m_Full;
            string shown = full;
            if (Cuttable(out float room)) shown = CutOf(full, room);
            m_Cut = string.Equals(shown, full, StringComparison.Ordinal) ? null : shown;
            if (string.Equals(text, shown, StringComparison.Ordinal)) return;
            m_Writing = true;
            try { text = shown; }
            finally { m_Writing = false; }
        }

        bool m_Writing;

        /// <summary>Cuts at the panel's next update (once, however many requests come before it): a text written to the label, its attach.</summary>
        void RequestCut()
        {
            if (m_Retry != null || panel == null) return;
            m_Retry = schedule.Execute(() => { m_Retry = null; Cut(); });
        }

        /// <summary>
        /// A text's width as the fit measures it, in this label's style (NaN when it cannot be measured). Measured on the label
        /// itself: its next draw lays its own text out again.
        /// </summary>
        float WidthOf(string t) => DesignTextFit.MeasureWidth(this, t);

        IVisualElementScheduledItem m_Retry;
        /// <summary>The drawing face's character count when it last lacked a character of the text (-2: none lacked).</summary>
        int m_LackingCount = -2;

        /// <summary>Whether the line is cut by the package: on a panel, one line ending in an ellipsis, left to right, the standard generator.</summary>
        bool Cuttable(out float room)
        {
            room = 0;
            if (panel == null || string.IsNullOrEmpty(m_Full)) return false;
            var s = resolvedStyle;
            if (s.textOverflow != TextOverflow.Ellipsis || (s.whiteSpace != WhiteSpace.NoWrap && s.whiteSpace != WhiteSpace.Pre)) return false;
            if (RightToLeft(this) || DesignTextFit.Advanced(this)) return false;
            room = contentRect.width;
            return !float.IsNaN(room) && room > 0;
        }

        /// <summary>The longest prefix of whole grapheme clusters whose width plus the ellipsis's fits <paramref name="room"/>, with the ellipsis; the text when it fits.</summary>
        string CutOf(string full, float room)
        {
            var s = resolvedStyle;
            var font = s.unityFontDefinition.fontAsset;
            float ppp = panel.scaledPixelsPerPoint;
            if (m_CutDone && string.Equals(m_CutText, full, StringComparison.Ordinal) && ReferenceEquals(m_CutFont, font) && m_CutSize == s.fontSize &&
                m_CutStyle == s.unityFontStyleAndWeight && m_CutLetter == s.letterSpacing && m_CutWord == s.wordSpacing && m_CutRoom == room && m_CutPpp == ppp)
                return m_Cut ?? full;
            m_CutDone = true;
            m_CutText = full;
            m_CutFont = font;
            m_CutSize = s.fontSize;
            m_CutStyle = s.unityFontStyleAndWeight;
            m_CutLetter = s.letterSpacing;
            m_CutWord = s.wordSpacing;
            m_CutRoom = room;
            m_CutPpp = ppp;
            Cuts++;
            // only text whose characters the face that draws it holds: a measure that adds glyphs to a dynamic font queues its
            // atlas update outside the panel's draw (as the fit measures, DesignTextFit). Until then the line keeps UI Toolkit's
            // own ellipsis, whose draw adds the glyphs; it is cut again after that draw, and not polled while nothing is added
            // (the import pre-adds the ellipsis of every screen that has one)
            var face = font == null ? null : DesignText.DrawingFace(font, s.unityFontStyleAndWeight);
            if (face == null || !DesignText.Drawable(font, s.unityFontStyleAndWeight, full + Ellipsis))
            {
                m_CutDone = false;
                int count = face == null ? -1 : face.characterTable.Count;
                if (count != m_LackingCount) { m_LackingCount = count; RequestCut(); }
                return full;
            }
            // the browser's widths: UI Toolkit's standard generator leaves out the spacing after the last character
            float spacing = s.letterSpacing * s.fontSize / 100f;
            float Width(string t) { var w = WidthOf(t); return float.IsNaN(w) ? float.NaN : w + spacing; }
            const float Tolerance = 1e-3f;
            float whole = Width(full);
            if (float.IsNaN(whole) || whole <= room + Tolerance) return full;
            float ellipsis = Width(Ellipsis);
            if (float.IsNaN(ellipsis)) return full;
            // cuts only between grapheme clusters (never inside a surrogate pair or a combining sequence)
            var starts = StringInfo.ParseCombiningCharacters(full);
            int lo = 0, hi = starts.Length - 1; // the number of clusters kept: 0 always fits (the ellipsis alone)
            while (lo < hi)
            {
                int mid = (lo + hi + 1) / 2;
                float w = Width(full.Substring(0, starts[mid]));
                if (!float.IsNaN(w) && w + ellipsis <= room + Tolerance) lo = mid; else hi = mid - 1;
            }
            return (lo == 0 ? string.Empty : full.Substring(0, starts[lo])) + Ellipsis;
        }

        /// <summary>How many times the label measured its text (tests: a style change that changes no input measures nothing).</summary>
        internal int Measurements { get; private set; }

        /// <summary>The design's alignment, read when styles resolved while no alignment of this label's own was set.</summary>
        TextAnchor m_DesignAlign;
        bool m_HasDesignAlign;
        /// <summary>Whether this label set its own (inline) alignment.</summary>
        bool m_Own;

        // the inputs of the last measurement and its width
        bool m_Measured;
        string m_Text;
        FontDefinition m_FontDefinition;
        Font m_Font;
        float m_Size, m_Letter, m_Word, m_Room, m_Ppp, m_Width;
        FontStyle m_Style;

        void OnStylesResolved()
        {
            // resolvedStyle carries the design's alignment only while this label sets none of its own
            if (!m_Own)
            {
                m_DesignAlign = resolvedStyle.unityTextAlign;
                m_HasDesignAlign = true;
            }
            Align();
        }

        void OnGeometry()
        {
            // after a layout styles are resolved: a screen compiled before the type had its custom property never sends the
            // event above, so the design's alignment is read here while this label has set none of its own
            if (!m_HasDesignAlign && !m_Own)
            {
                m_DesignAlign = resolvedStyle.unityTextAlign;
                m_HasDesignAlign = true;
            }
            Align();
        }

        void Align()
        {
            if (panel == null || !m_HasDesignAlign) return;
            var ws = resolvedStyle.whiteSpace;
            float room = contentRect.width;
            // a line that wraps never overflows its box: the design's alignment
            if (ws == WhiteSpace.Normal || ws == WhiteSpace.PreWrap || float.IsNaN(room) || room <= 0 || string.IsNullOrEmpty(FullText))
            {
                Overflows = false;
                SetOwn(null);
                return;
            }
            Overflows = MeasuredWidth(room) > room + 0.01f;
            var start = StartOf(m_DesignAlign, RightToLeft(this));
            SetOwn(Overflows && start != m_DesignAlign ? start : (TextAnchor?)null);
        }

        /// <summary>The text's unwrapped width, measured again only when an input changed.</summary>
        float MeasuredWidth(float room)
        {
            var s = resolvedStyle;
            float ppp = panel.scaledPixelsPerPoint;
            var full = FullText;
            if (m_Measured && m_Text == full && m_FontDefinition == s.unityFontDefinition && m_Font == s.unityFont && m_Size == s.fontSize &&
                m_Style == s.unityFontStyleAndWeight && m_Letter == s.letterSpacing && m_Word == s.wordSpacing && m_Room == room && m_Ppp == ppp)
                return m_Width;
            m_Measured = true;
            m_Text = full;
            m_FontDefinition = s.unityFontDefinition;
            m_Font = s.unityFont;
            m_Size = s.fontSize;
            m_Style = s.unityFontStyleAndWeight;
            m_Letter = s.letterSpacing;
            m_Word = s.wordSpacing;
            m_Room = room;
            m_Ppp = ppp;
            Measurements++;
            float width = MeasureTextSize(full, 0, MeasureMode.Undefined, 0, MeasureMode.Undefined).x;
            m_Width = float.IsNaN(width) ? 0 : width;
            return m_Width;
        }

        void SetOwn(TextAnchor? align)
        {
            if (align.HasValue)
            {
                m_Own = true;
                if (style.unityTextAlign.keyword != StyleKeyword.Undefined || style.unityTextAlign.value != align.Value) style.unityTextAlign = align.Value;
            }
            else
            {
                m_Own = false;
                if (style.unityTextAlign.keyword != StyleKeyword.Null) style.unityTextAlign = StyleKeyword.Null;
            }
        }

        /// <summary>
        /// Whether the element's resolved language direction is right to left: the nearest <see cref="VisualElement.languageDirection"/>
        /// that is not Inherit, on the element or an ancestor (none: left to right), as UI Toolkit resolves it.
        /// </summary>
        internal static bool RightToLeft(VisualElement e)
        {
            for (var x = e; x != null; x = x.hierarchy.parent)
            {
                if (x.languageDirection == LanguageDirection.RTL) return true;
                if (x.languageDirection == LanguageDirection.LTR) return false;
            }
            return false;
        }

        /// <summary>The start alignment on the same row (upper, middle or lower): left, or right in right-to-left text.</summary>
        internal static TextAnchor StartOf(TextAnchor a, bool rightToLeft = false)
        {
            switch (a)
            {
                case TextAnchor.UpperLeft: case TextAnchor.UpperCenter: case TextAnchor.UpperRight: return rightToLeft ? TextAnchor.UpperRight : TextAnchor.UpperLeft;
                case TextAnchor.MiddleLeft: case TextAnchor.MiddleCenter: case TextAnchor.MiddleRight: return rightToLeft ? TextAnchor.MiddleRight : TextAnchor.MiddleLeft;
                case TextAnchor.LowerLeft: case TextAnchor.LowerCenter: case TextAnchor.LowerRight: return rightToLeft ? TextAnchor.LowerRight : TextAnchor.LowerLeft;
                default: return a;
            }
        }
    }
}
