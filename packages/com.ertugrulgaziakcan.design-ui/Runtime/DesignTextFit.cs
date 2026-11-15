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
    /// Lays a text element whose width is its content's out at the browser's width for its text. Chromium ceils a text's
    /// width to whole device pixels at the page's scale (measured on the kit's buttons and tabs at every default viewport:
    /// a text of 69.469 px makes its button 70 px of content at 2560×1440, 105 device px at 3840×2160). UI Toolkit ceils too,
    /// but on the device grid of the scale it lays out at, which under a scaled root is not the design's (at 1600×900 the
    /// panel lays out at 0.75, the design is at 0.625), and with no tolerance: a text the browser measures at exactly 86 px
    /// measures 86.003 in Unity and takes 87, so every element after it in a row moves a pixel. A measure override cannot
    /// help, because UI Toolkit rounds a measured size after it. Instead the element gets an inline width of the
    /// generator's unrounded width ceiled on the design's device grid (<see cref="Snap"/>) plus its horizontal padding and
    /// borders (each as the browser lays a border out, <see cref="SnapBorder"/>), which layout keeps exactly (only each edge
    /// is put on the device grid), and <c>white-space: nowrap</c> (<c>pre</c> for a text that keeps its spaces), because a
    /// box as wide as its text must not break it when the grid takes a fraction of a pixel off. It is measured again when the text, the element's styles (a state, the locale's fonts, a
    /// text size) or its geometry change. When the layout holds the element narrower than its text (the parent has no room,
    /// so the design would wrap it), the inline width and white-space are taken off until the element has room again.
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

        /// <summary>The inline width this applied (border box, panel px), or NaN while the element has UI Toolkit's own width.</summary>
        public float Width { get; private set; } = float.NaN;

        public DesignTextFit(TextElement element)
        {
            m_Element = element ?? throw new ArgumentNullException(nameof(element));
            if (!Supported) return;
            element.RegisterCallback<AttachToPanelEvent>(_ => Update());
            element.RegisterCallback<CustomStyleResolvedEvent>(_ => Update());
            element.RegisterCallback<GeometryChangedEvent>(_ =>
            {
                m_Laid = true;
                Update();
            });
            element.RegisterCallback<ChangeEvent<string>>(e => { if (e.target == element) Update(); });
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
            var font = e.resolvedStyle.unityFontDefinition.fontAsset;
            if (font == null || font.atlasTexture == null || !DesignText.AllPresent(font, text)) return float.NaN;
            Vector2 rounded;
            try { rounded = e.MeasureTextSize(text, 0, VisualElement.MeasureMode.Undefined, 0, VisualElement.MeasureMode.Undefined); }
            catch (MissingReferenceException) { return float.NaN; }
            if (float.IsNaN(rounded.x)) return float.NaN;
            var handle = s_Handle.GetValue(e);
            return handle != null && s_MeasuredWidth.GetValue(handle) is float w ? w : float.NaN;
        }

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
            float box = Snap(text, scale) + rs.paddingLeft + rs.paddingRight + SnapBorder(rs.borderLeftWidth, scale) + SnapBorder(rs.borderRightWidth, scale);
            // only a layout made since the width last changed says whether the parent has room (a style callback can come
            // between a change and the layout that follows it)
            float laidOut = m_Laid ? e.layout.width : float.NaN;
            // layout puts each edge on the device grid: a laid-out width is within a device pixel of the width it was given
            float grid = 1f / Mathf.Max(e.scaledPixelsPerPoint, 1e-3f) + 0.01f;
            if (!float.IsNaN(Width))
            {
                // held narrower than the width this gave it: the parent has no room, the text may wrap there
                if (!float.IsNaN(laidOut) && laidOut < Width - grid && laidOut < box - grid)
                {
                    Release();
                    return;
                }
            }
            else if (!float.IsNaN(laidOut) && laidOut > 0 && laidOut < box - grid)
                return; // UI Toolkit's own (rounded up) width does not fit either: keep it, wrapping as the design would
            if (Mathf.Abs(Width - box) < 1e-4f) return;
            // the design's own white-space keeps its spaces (pre) and only stops wrapping
            if (float.IsNaN(Width))
            {
                var own = rs.whiteSpace;
                m_NoWrap = own == WhiteSpace.Pre || own == WhiteSpace.PreWrap ? WhiteSpace.Pre : WhiteSpace.NoWrap;
            }
            Width = box;
            m_Laid = false;
            e.style.width = box;
            if (e.style.whiteSpace != m_NoWrap) e.style.whiteSpace = m_NoWrap;
        }

        WhiteSpace m_NoWrap = WhiteSpace.NoWrap;
        bool m_Laid;

        /// <summary>
        /// How much wider than the browser's a text may measure in Unity and still be the browser's width: the two renderers'
        /// widths of one text differ by up to 0.021 device px (measured on the kit's buttons and tabs at the four exact
        /// viewports), so a text the browser measures at exactly 86 px (Unity: 86.003) is not a pixel wider in Unity.
        /// </summary>
        public const float Tolerance = 0.025f;

        /// <summary>
        /// The width layout gives a text of unrounded width <paramref name="width"/> (panel px) at <paramref name="scale"/>
        /// device px per panel px: the browser's, up to the next whole device pixel (Chromium ceils a text's width to the
        /// device grid of the page's scale: a button's text of 69.469 px at 3840×2160, 104.2 device px, takes 105), forgiving
        /// <see cref="Tolerance"/>.
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
            m_Laid = false;
            m_Element.style.width = StyleKeyword.Null;
            m_Element.style.whiteSpace = StyleKeyword.Null;
        }
    }
}
