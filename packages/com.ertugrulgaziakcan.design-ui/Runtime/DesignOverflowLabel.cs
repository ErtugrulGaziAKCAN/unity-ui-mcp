using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// A label the design aligns right or centred whose line can overflow its box (written by the compiler in place of a
    /// Label): the browser start-aligns a line that does not fit (CSS Text: an overflowing line is start-aligned), then
    /// clips it or puts the ellipsis where it is cut, so the visible text starts at the box's left edge; UI Toolkit aligns
    /// the cut text right or centred, which moved an ellipsized right-aligned line by up to a glyph. While its text is wider
    /// than its box this label is left-aligned (the design's vertical alignment kept); otherwise the design's alignment
    /// applies. Otherwise a Label.
    /// </summary>
    [UxmlElement]
    public partial class DesignOverflowLabel : Label
    {
        public DesignOverflowLabel() : this(string.Empty) { }

        public DesignOverflowLabel(string text) : base(text)
        {
            RegisterCallback<GeometryChangedEvent>(_ => Align());
            RegisterCallback<CustomStyleResolvedEvent>(_ => Align());
            RegisterCallback<ChangeEvent<string>>(e => { if (e.target == this) Align(); });
        }

        /// <summary>Whether the text was wider than the box at the last check (the label is left-aligned then).</summary>
        public bool Overflows { get; private set; }

        /// <summary>The design's alignment, read while no inline alignment is set.</summary>
        TextAnchor m_DesignAlign;

        void Align()
        {
            if (panel == null) return;
            if (style.unityTextAlign.keyword == StyleKeyword.Null) m_DesignAlign = resolvedStyle.unityTextAlign;
            float room = contentRect.width;
            if (float.IsNaN(room) || room <= 0 || string.IsNullOrEmpty(text)) return;
            float width = MeasureTextSize(text, 0, MeasureMode.Undefined, 0, MeasureMode.Undefined).x;
            bool overflows = !float.IsNaN(width) && width > room + 0.01f;
            var start = StartOf(m_DesignAlign);
            Overflows = overflows;
            if (overflows && start != m_DesignAlign)
            {
                if (style.unityTextAlign.keyword != StyleKeyword.Undefined || style.unityTextAlign.value != start) style.unityTextAlign = start;
            }
            else if (style.unityTextAlign.keyword != StyleKeyword.Null) style.unityTextAlign = StyleKeyword.Null;
        }

        /// <summary>The left (start) alignment on the same row: upper, middle or lower.</summary>
        internal static TextAnchor StartOf(TextAnchor a)
        {
            switch (a)
            {
                case TextAnchor.UpperCenter: case TextAnchor.UpperRight: return TextAnchor.UpperLeft;
                case TextAnchor.MiddleCenter: case TextAnchor.MiddleRight: return TextAnchor.MiddleLeft;
                case TextAnchor.LowerCenter: case TextAnchor.LowerRight: return TextAnchor.LowerLeft;
                default: return a;
            }
        }
    }
}
