using System;
using System.Reflection;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// A label whose width the design leaves to its text (written by the compiler in place of a Label): it lays out at the
    /// browser's width for its text, not UI Toolkit's (<see cref="DesignTextFit"/>). Otherwise a Label.
    /// </summary>
    [UxmlElement]
    public partial class DesignLabel : Label
    {
        public DesignLabel() : this(string.Empty) { }

        public DesignLabel(string text) : base(text) => Fit = new DesignTextFit(this);

        /// <summary>The element's exact-width layout.</summary>
        public DesignTextFit Fit { get; }
    }

    /// <summary>
    /// A button whose width the design leaves to its text (written by the compiler in place of a Button): it lays out at the
    /// browser's width for its text plus its padding and borders (<see cref="DesignTextFit"/>). Otherwise a Button.
    /// </summary>
    [UxmlElement]
    public partial class DesignButton : Button
    {
        public DesignButton() => Fit = new DesignTextFit(this);

        /// <summary>The element's exact-width layout.</summary>
        public DesignTextFit Fit { get; }
    }

    /// <summary>
    /// Lays a text element whose width is its content's out at the golden's width for its text. The golden lays such a box
    /// out with Chromium's text width ceiled to whole device pixels at the viewport's scale (the exporter's pageTextCeil:
    /// a text of 69.469 px makes its button 70 px of content at 2560×1440, 105 device px at 3840×2160). UI Toolkit ceils too,
    /// but on the device grid of the scale it lays out at, which under a scaled root is not the design's (at 1600×900 the
    /// panel lays out at 0.75, the design is at 0.625), and with no tolerance: a text the browser measures at exactly 86 px
    /// measures 86.0100 in Unity and takes 87, so every element after it in a row moves a pixel. A measure override cannot
    /// help, because UI Toolkit rounds a measured size after it. Instead the element gets an inline width of the
    /// generator's unrounded width ceiled on the design's device grid (<see cref="Snap"/>) plus its horizontal padding and
    /// borders as the golden lays them out (<see cref="BrowserWidth"/>, which counts letter-spacing as the golden does),
    /// which layout keeps exactly (only each edge is put on the device grid), and <c>white-space: nowrap</c> (<c>pre</c> for a text that keeps its spaces), because a
    /// box as wide as its text must not break it when the grid takes a fraction of a pixel off. It is measured again when
    /// the text, the element's styles (a state, the locale's fonts, a text size) or its geometry change. A text the design
    /// lets wrap keeps wrapping where its line does not fit. In a row the layout shows that (it holds the element narrower
    /// than its text) and the inline width and white-space come off (UI Toolkit's own layout, which wraps it: a row that a
    /// column sizes to its content does not shrink an explicit flex basis, so the browser's width cannot stay as the basis).
    /// They come back only when the row's content box grows past the width it had then, or the text needs less than the
    /// box it had no room for: under a scaled root UI Toolkit's own box can be narrower than the golden's (its borders and
    /// its text grid), and a row between the two would otherwise flip the element between them on every layout. In a column, and for an absolutely positioned text, layout never narrows an explicit
    /// width (and UI Toolkit does not wrap an absolute Label at its parent's width at all), so the room is measured (the
    /// parent's content width less the element's margins; for an absolute text the parent's padding box right of its left
    /// edge) and a longer line gets that width with the design's own white-space: the browser's fit-content box, as wide as
    /// its room, wrapping there (<see cref="Wrapping"/>).
    /// <para>Unity has no public unrounded text width: it is read from the text handle's last measure (an internal member,
    /// found by reflection; <see cref="Supported"/> is false and nothing changes when a Unity version renames it).</para>
    /// </summary>
    public sealed class DesignTextFit
    {
        const BindingFlags Internal = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
        static readonly PropertyInfo s_Handle = typeof(TextElement).GetProperty("uitkTextHandle", Internal);
        static readonly PropertyInfo s_MeasuredWidth = s_Handle?.PropertyType.GetProperty("MeasuredWidth", Internal);

        /// <summary>Whether this Unity version exposes the text handle's unrounded width (else elements keep UI Toolkit's own width).</summary>
        public static bool Supported => s_MeasuredWidth != null;

        readonly TextElement m_Element;

        /// <summary>
        /// The inline width this applied (border box, panel px): the browser's width for the text on one line, or the room a
        /// wrapping text wraps at (<see cref="Wrapping"/>); NaN while the element has UI Toolkit's own width.
        /// </summary>
        public float Width { get; private set; } = float.NaN;

        public DesignTextFit(TextElement element)
        {
            m_Element = element ?? throw new ArgumentNullException(nameof(element));
            if (!Supported) return;
            m_OnParentGeometry = _ => Update();
            element.RegisterCallback<AttachToPanelEvent>(_ =>
            {
                // another panel, row or scale: what a row had no room for before says nothing here
                ForgetRelease();
                WatchParent(element.hierarchy.parent);
                Update();
            });
            element.RegisterCallback<DetachFromPanelEvent>(_ => WatchParent(null));
            element.RegisterCallback<CustomStyleResolvedEvent>(_ => Update());
            element.RegisterCallback<GeometryChangedEvent>(_ =>
            {
                m_Laid = true;
                Update();
            });
            element.RegisterCallback<ChangeEvent<string>>(e => { if (e.target == element) Update(); });
        }

        readonly EventCallback<GeometryChangedEvent> m_OnParentGeometry;
        VisualElement m_Parent;

        /// <summary>
        /// The parent's geometry changes the room of a text whose width is explicit (layout does not change the element itself
        /// then): it is measured again on the parent's geometry changes too.
        /// </summary>
        void WatchParent(VisualElement parent)
        {
            if (ReferenceEquals(parent, m_Parent)) return;
            ForgetRelease();
            m_Parent?.UnregisterCallback(m_OnParentGeometry);
            m_Parent = parent;
            m_Parent?.RegisterCallback(m_OnParentGeometry);
        }

        /// <summary>The unrounded width of the element's text on one line in its resolved style (panel px), or NaN.</summary>
        public float TextWidth()
        {
            var e = m_Element;
            var text = e.text;
            if (!Supported || e.panel == null || string.IsNullOrEmpty(text)) return float.NaN;
            // only text whose characters the font holds: a measure that adds glyphs to a dynamic font queues its atlas update
            // outside the panel's repaint (a font deleted before the next repaint breaks TextCore's queue), and a glyph added
            // now would bring its kerning pairs only later; the element keeps UI Toolkit's width until the text is drawn
            var rs = e.resolvedStyle;
            var font = rs.unityFontDefinition.fontAsset;
            if (font == null || font.atlasTexture == null) return float.NaN;
            // the same text in the same style at the same scale measures the same: style and geometry callbacks (an animated
            // colour, a moved parent) measure nothing
            float size = rs.fontSize, letter = rs.letterSpacing, word = rs.wordSpacing, ppp = e.scaledPixelsPerPoint;
            var fontStyle = rs.unityFontStyleAndWeight;
            // (a font that gained characters since may have gained their kerning pairs too)
            int characters = font.characterTable.Count;
            if (!float.IsNaN(m_Measured) && string.Equals(text, m_MeasuredText, StringComparison.Ordinal) && ReferenceEquals(font, m_MeasuredFont) && size == m_MeasuredSize &&
                letter == m_MeasuredLetter && word == m_MeasuredWord && ppp == m_MeasuredPpp && fontStyle == m_MeasuredStyle && characters == m_MeasuredCharacters)
                return m_Measured;
            if (!DesignText.AllPresent(font, text)) return float.NaN;
            Vector2 rounded;
            try { rounded = e.MeasureTextSize(text, 0, VisualElement.MeasureMode.Undefined, 0, VisualElement.MeasureMode.Undefined); }
            catch (MissingReferenceException) { return float.NaN; }
            if (float.IsNaN(rounded.x)) return float.NaN;
            var handle = s_Handle.GetValue(e);
            float width = handle != null && s_MeasuredWidth.GetValue(handle) is float w ? w : float.NaN;
            m_Measured = width;
            m_MeasuredRounded = rounded.x;
            m_MeasuredText = text;
            m_MeasuredFont = font;
            m_MeasuredSize = size;
            m_MeasuredLetter = letter;
            m_MeasuredWord = word;
            m_MeasuredPpp = ppp;
            m_MeasuredStyle = fontStyle;
            m_MeasuredCharacters = characters;
            Measures++;
            return width;
        }

        float m_Measured = float.NaN, m_MeasuredRounded, m_MeasuredSize, m_MeasuredLetter, m_MeasuredWord, m_MeasuredPpp;
        string m_MeasuredText;
        UnityEngine.TextCore.Text.FontAsset m_MeasuredFont;
        FontStyle m_MeasuredStyle;
        int m_MeasuredCharacters;

        /// <summary>How many times the text was measured (tests: a style or geometry change that changes nothing measures nothing).</summary>
        internal int Measures { get; private set; }

        /// <summary>Measures the text again and applies the browser's width for it (or UI Toolkit's own, see the class summary).</summary>
        public void Update()
        {
            var e = m_Element;
            float text = TextWidth();
            if (float.IsNaN(text))
            {
                Release();
                return;
            }
            var rs = e.resolvedStyle;
            double scale = DesignScaleOf(e);
            float box = BrowserWidth(text, rs, scale, e.scaledPixelsPerPoint);
            // only a layout made since the width last changed says whether the parent has room (a style callback can come
            // between a change and the layout that follows it)
            float laidOut = m_Laid ? e.layout.width : float.NaN;
            // layout puts each edge on the device grid: a laid-out width is within a device pixel of the width it was given
            float grid = 1f / Mathf.Max(e.scaledPixelsPerPoint, 1e-3f) + 0.01f;
            bool exact = !float.IsNaN(Width) && !Wrapping;
            // the design's white-space (while the exact width is applied, the element's own is the one this set)
            bool wraps = exact ? m_DesignWraps : rs.whiteSpace == WhiteSpace.Normal || rs.whiteSpace == WhiteSpace.PreWrap;
            if (wraps)
            {
                // in a column or absolutely positioned, a line wider than its room wraps at the room: the design's box (fit
                // content) is as wide as the room then, which layout keeps
                float room = Room();
                if (!float.IsNaN(room) && box > room + grid)
                {
                    WrapAt(room);
                    return;
                }
            }
            if (exact)
            {
                // held narrower than the width this gave it: the row has no room, the text may wrap there (UI Toolkit's own
                // width: a row inside a column that sizes it to its content does not shrink an explicit flex basis). A layout
                // at the width this gave it before is not one (a geometry report of the layout before the last write can
                // follow it: the parent's geometry callback writes in the same layout pass, the element's own report of that
                // pass comes after; it took the width off for good at that scale)
                if (!float.IsNaN(laidOut) && !(Mathf.Abs(laidOut - m_Given) < 1e-3f) && laidOut < Width - grid && laidOut < box - grid)
                {
                    Release();
                    // it comes back only once the row has more room than now or the text needs less: UI Toolkit's own width
                    // can be narrower than the box (its borders and rounding, not the golden's), so a row between the two
                    // would otherwise take it off and put it back on every layout
                    m_ReleasedRoom = ParentRoom();
                    m_ReleasedBox = box;
                    m_ReleasedScale = scale;
                    m_ReleasedPpp = e.scaledPixelsPerPoint;
                    return;
                }
                if (Mathf.Abs(Width - box) < 1e-4f) return;
            }
            else if (!Wrapping)
            {
                // a release at another design scale or panel scale (a resolution change) says nothing about this one
                if (!float.IsNaN(m_ReleasedBox) && (scale != m_ReleasedScale || e.scaledPixelsPerPoint != m_ReleasedPpp)) ForgetRelease();
                if (!float.IsNaN(m_ReleasedBox))
                {
                    // the one way back after a row took it off: the row grew or the text needs less (tried once: a row
                    // still without room takes it off again and remembers its new room)
                    float room = ParentRoom();
                    bool grew = !float.IsNaN(room) && !float.IsNaN(m_ReleasedRoom) && room > m_ReleasedRoom + grid;
                    if (!grew && box >= m_ReleasedBox - grid) return;
                    m_ReleasedRoom = m_ReleasedBox = float.NaN;
                }
                else
                {
                    // UI Toolkit's own width: applied once a layout of it since the last change shows the room (a callback
                    // right after the width came off, before the next layout, would put it back where the row has no room)
                    if (float.IsNaN(laidOut)) return;
                    // narrower than UI Toolkit's own width for the text (its rounding and borders, not the browser's): the row
                    // has no room for it either; keep it, wrapping as the design would
                    float own = m_MeasuredRounded + rs.paddingLeft + rs.paddingRight + rs.borderLeftWidth + rs.borderRightWidth;
                    if (laidOut > 0 && laidOut < own - grid) return;
                }
            }
            if (!exact)
            {
                // the design's own white-space keeps its spaces (pre) and only stops wrapping
                var own = rs.whiteSpace;
                m_NoWrap = own == WhiteSpace.Pre || own == WhiteSpace.PreWrap ? WhiteSpace.Pre : WhiteSpace.NoWrap;
                m_DesignWraps = wraps;
            }
            Wrapping = false;
            m_Given = Width;
            Width = box;
            m_Laid = false;
            Writes++;
            e.style.width = box;
            if (e.style.whiteSpace != m_NoWrap) e.style.whiteSpace = m_NoWrap;
        }

        /// <summary>
        /// The border-box width the design gives a text of unrounded width <paramref name="text"/> (UI Toolkit's measure) in
        /// <paramref name="rs"/>, as the golden lays it out (the exporter's pageTextCeil: Chromium's text width ceiled on the
        /// device grid, borders whole device pixels): the text ceiled on the design's device grid (<see cref="Snap"/>) plus
        /// padding and borders (<see cref="SnapBorder"/>). With letter-spacing the design's text has one spacing more than UI
        /// Toolkit's standard generator lays out (after its last character); the compiler wrote that spacing as extra right
        /// padding, which UI Toolkit put on its device grid. The design's box is the text ceiled, plus the spacing, the
        /// design's padding (the right padding less the spacing, whole device pixels where it lays out: lint U-CSS-046) and
        /// the borders, rounded to whole device pixels (Yoga snaps such a box's edges).
        /// </summary>
        internal static float BrowserWidth(float text, IResolvedStyle rs, double scale, float ppp)
        {
            float spacing = rs.letterSpacing * rs.fontSize / 100f; // USS letter-spacing is hundredths of an em
            float borders = SnapBorder(rs.borderLeftWidth, scale) + SnapBorder(rs.borderRightWidth, scale);
            if (spacing == 0 || !(ppp > 0) || !(scale > 0)) return Snap(text, scale) + rs.paddingLeft + rs.paddingRight + borders;
            float right = Mathf.Max(0, Mathf.Round((rs.paddingRight - spacing) * ppp) / ppp);
            double box = Snap(text, scale) + spacing + rs.paddingLeft + right + borders;
            return (float)(Math.Round(box * scale, MidpointRounding.AwayFromZero) / scale);
        }

        /// <summary>Whether the element's text wraps at the room of a column or of an absolute text (<see cref="Width"/>), with the design's white-space.</summary>
        public bool Wrapping { get; private set; }

        void WrapAt(float room)
        {
            if (Wrapping && Mathf.Abs(Width - room) < 1e-4f) return;
            Wrapping = true;
            Width = room;
            m_Laid = false;
            Writes++;
            m_Element.style.width = room;
            m_Element.style.whiteSpace = StyleKeyword.Null;
        }

        WhiteSpace m_NoWrap = WhiteSpace.NoWrap;
        bool m_Laid, m_DesignWraps;
        /// <summary>The exact width this gave the element before its current one (NaN: none); a layout at it is not a narrowing.</summary>
        float m_Given = float.NaN;
        /// <summary>After a row took the width off: the parent's content width then and the box it had no room for (NaN: none).</summary>
        float m_ReleasedRoom = float.NaN, m_ReleasedBox = float.NaN;
        /// <summary>The design scale and panel scale of that release.</summary>
        double m_ReleasedScale = double.NaN;
        float m_ReleasedPpp = float.NaN;

        void ForgetRelease()
        {
            m_ReleasedRoom = m_ReleasedBox = m_ReleasedPpp = float.NaN;
            m_ReleasedScale = double.NaN;
        }

        /// <summary>How many times the inline width was written (tests: a layout that changes nothing writes nothing).</summary>
        internal int Writes { get; private set; }

        float ParentRoom()
        {
            var parent = m_Element.hierarchy.parent;
            return parent != null ? parent.contentRect.width : float.NaN;
        }

        /// <summary>
        /// The room the element's border box has where layout does not narrow an explicit width (panel px), or NaN (in a row,
        /// which narrows it itself, or before the parent is laid out): in a column, the parent's content width less the
        /// element's margins; absolutely positioned, the parent's padding box right of the element's left edge, less its
        /// right margin (the browser's available width of a box pinned by its left side).
        /// </summary>
        float Room()
        {
            var e = m_Element;
            var parent = e.hierarchy.parent;
            if (parent == null) return float.NaN;
            var rs = e.resolvedStyle;
            float room;
            if (rs.position == Position.Absolute)
                room = parent.layout.width - parent.resolvedStyle.borderRightWidth - e.layout.x - rs.marginRight;
            else
            {
                var direction = parent.resolvedStyle.flexDirection;
                if (direction == FlexDirection.Row || direction == FlexDirection.RowReverse) return float.NaN;
                room = parent.contentRect.width - rs.marginLeft - rs.marginRight;
            }
            return !float.IsNaN(room) && room > 0 ? room : float.NaN;
        }

        /// <summary>
        /// How much over a whole device pixel a text may measure and still be that pixel, in device px; the golden's rule
        /// forgives the same (the exporter's TEXT_CEIL_TOLERANCE). Unity's unrounded width (the text handle's measure) is
        /// Chromium's within −0.0175…+0.0453 device px (984 text-sized texts of the fidelity suite at all six viewports, median
        /// +0.0037; a text the browser measures at exactly 86 px is 86.0100 in Unity at every exact scale). With 0.012 on both
        /// sides 2 of them are a pixel apart (letter-spaced display text, inside their box limits); with 1e-4 on the golden's
        /// side 4, and with the earlier 0.025 here 8. docs/findings/viewport-classes.md.
        /// </summary>
        public const float Tolerance = 0.012f;

        /// <summary>
        /// The width layout gives a text of unrounded width <paramref name="width"/> (panel px) at <paramref name="scale"/>
        /// device px per panel px: the golden's, up to the next whole device pixel (the exporter lays a text-sized box out with
        /// Chromium's text width ceiled on the device grid: a button's text of 69.469 px at 3840×2160, 104.2 device px, takes
        /// 105), forgiving <see cref="Tolerance"/>.
        /// </summary>
        public static float Snap(float width, double scale)
        {
            if (!(scale > 0) || float.IsNaN(width)) return width;
            return (float)(Math.Ceiling(width * scale - Tolerance) / scale);
        }

        /// <summary>
        /// The width a border of <paramref name="width"/> panel px takes in the browser's layout at <paramref name="scale"/>:
        /// Chromium puts border widths on whole device pixels (halves up, at least one; measured: a 4 px border is 3 device
        /// px at 1600×900, where it is 2.5, and 2 at 1366×768), while paddings and margins keep their fractions. At an exact
        /// scale the width is unchanged; under a scaled root the border itself is still drawn at its exact width, only the
        /// box the element takes is the browser's.
        /// </summary>
        public static float SnapBorder(float width, double scale)
        {
            if (!(width > 0) || !(scale > 0)) return width;
            // halves up, a float's error forgiven (a panel's 0.625 is 0.62499994)
            return (float)(Math.Max(1, Math.Floor(width * scale + 0.5 + 1e-4)) / scale);
        }

        /// <summary>
        /// The design's scale where the element is: the screen root's (<see cref="DesignScreen.DesignScale"/>: the actual scale
        /// of a root laid out at an exact one), else the panel's.
        /// </summary>
        static double DesignScaleOf(VisualElement e)
        {
            for (var p = e.hierarchy.parent; p != null; p = p.hierarchy.parent)
                if (p is DesignScreen screen && screen.DesignScale.HasValue)
                    return screen.DesignScale.Value; // inside the root a panel px is a design px at any root scale
            return e.panel?.scaledPixelsPerPoint ?? 1;
        }

        void Release()
        {
            if (float.IsNaN(Width)) return;
            Width = float.NaN;
            Wrapping = false;
            m_Laid = false;
            Writes++;
            m_Element.style.width = StyleKeyword.Null;
            m_Element.style.whiteSpace = StyleKeyword.Null;
        }
    }
}
