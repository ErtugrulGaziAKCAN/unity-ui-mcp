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
    /// </summary>
    [UxmlElement]
    public partial class DesignOverflowLabel : Label
    {
        public DesignOverflowLabel() : this(string.Empty) { }

        public DesignOverflowLabel(string text) : base(text)
        {
            RegisterCallback<CustomStyleResolvedEvent>(_ => OnStylesResolved());
            RegisterCallback<GeometryChangedEvent>(_ => OnGeometry());
            RegisterCallback<ChangeEvent<string>>(e => { if (e.target == this) Align(); });
            RegisterCallback<AttachToPanelEvent>(_ => m_Measured = false);
        }

        /// <summary>Whether the text was wider than the box at the last check (the label is aligned at its start then).</summary>
        public bool Overflows { get; private set; }

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
            if (ws == WhiteSpace.Normal || ws == WhiteSpace.PreWrap || float.IsNaN(room) || room <= 0 || string.IsNullOrEmpty(text))
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
            if (m_Measured && m_Text == text && m_FontDefinition == s.unityFontDefinition && m_Font == s.unityFont && m_Size == s.fontSize &&
                m_Style == s.unityFontStyleAndWeight && m_Letter == s.letterSpacing && m_Word == s.wordSpacing && m_Room == room && m_Ppp == ppp)
                return m_Width;
            m_Measured = true;
            m_Text = text;
            m_FontDefinition = s.unityFontDefinition;
            m_Font = s.unityFont;
            m_Size = s.fontSize;
            m_Style = s.unityFontStyleAndWeight;
            m_Letter = s.letterSpacing;
            m_Word = s.wordSpacing;
            m_Room = room;
            m_Ppp = ppp;
            Measurements++;
            float width = MeasureTextSize(text, 0, MeasureMode.Undefined, 0, MeasureMode.Undefined).x;
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
