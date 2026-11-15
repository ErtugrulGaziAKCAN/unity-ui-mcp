using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// The root element of a compiled design screen. It carries the screen's own reference to the compiled font set
    /// (<c>DesignFonts.asset</c>, the UXML attribute <c>fonts</c>), so the generated view prepares bound text in the locale's
    /// twins without any wiring by the game, and it tells a <see cref="LocaleFontController"/> above it that it was attached
    /// (anywhere below the controller's root), so the screen gets the locale, right-to-left and text-size classes at once.
    /// When the design animates (the UXML attribute <c>animated</c>, written by the compiler), it attaches the screen's
    /// <see cref="DesignUiAnimationPlayer"/> on attach, so transitions and keyframe animations play without any wiring.
    /// On a runtime panel whose scale is not one of the profile's exact viewports' (<see cref="ExactScales"/>), it lays the
    /// screen out at the nearest exact scale and draws its root scaled to the actual one (inline <c>scale</c>,
    /// <c>transform-origin</c> and <c>flex-shrink: 0</c>: the root keeps its design size); it applies the design's breakpoints.
    /// Otherwise it is a plain VisualElement.
    /// </summary>
    [UxmlElement]
    public partial class DesignScreen : VisualElement
    {
        DesignFontSet m_Fonts;

        /// <summary>
        /// The compiled font set of the screen (written by the compiler), or null. Setting it links its line-box variants to
        /// their twins (<see cref="DesignFontSet.LinkTwins"/>), before the screen's text is laid out.
        /// </summary>
        [UxmlAttribute("fonts")]
        public DesignFontSet Fonts
        {
            get => m_Fonts;
            set
            {
                m_Fonts = value;
                if (value != null) value.LinkTwins();
            }
        }

        DesignBreakpoints m_Breakpoints;
        string m_BreakpointsText;

        /// <summary>
        /// The design's <c>@media</c> breakpoints (written by the compiler, <see cref="DesignBreakpoints.Encode"/>): while the
        /// screen is in a panel it carries <c>bp-&lt;name&gt;</c> for each one that holds at the panel's size, updated when its
        /// geometry changes, as the goldens were captured.
        /// </summary>
        [UxmlAttribute("breakpoints")]
        public string Breakpoints
        {
            get => m_BreakpointsText;
            set
            {
                m_BreakpointsText = value;
                m_Breakpoints = string.IsNullOrEmpty(value) ? null : DesignBreakpoints.Parse(value);
                ApplyBreakpoints();
            }
        }

        double[] m_ExactScales;
        string m_ExactScalesText;

        /// <summary>
        /// The panel scales of the profile's exact viewports (written by the compiler, <see cref="DesignViewportScales.Encode"/>).
        /// While the screen is on a runtime panel whose scale is none of them (a scaled viewport, or a resolution the profile does
        /// not declare), the panel lays out at the nearest exact scale and the root draws scaled by <see cref="RootScale"/>
        /// (actual / exact, its top-left corner fixed), so the screen has the design's geometry at the actual scale
        /// (<see cref="ApplyRootScale"/>).
        /// </summary>
        [UxmlAttribute("exact-scales")]
        public string ExactScales
        {
            get => m_ExactScalesText;
            set
            {
                m_ExactScalesText = value;
                m_ExactScales = string.IsNullOrEmpty(value) ? null : DesignViewportScales.Parse(value);
                if (m_ExactScales != null && m_ExactScales.Length == 0) m_ExactScales = null;
                ApplyRootScale();
            }
        }

        /// <summary>The scale the root draws at (actual / the exact scale its panel lays out at); 1 at an exact scale or outside a runtime panel.</summary>
        public float RootScale { get; private set; } = 1f;

        /// <summary>
        /// The panel scale the design is shown at on this screen (device pixels per design pixel): the scale the panel resolves
        /// without the exact-scale factor; null outside a runtime panel, before it has a size or without exact scales.
        /// </summary>
        public double? DesignScale { get; private set; }

        /// <summary>Whether the screen has transitions or keyframe animations (written by the compiler).</summary>
        [UxmlAttribute("animated")]
        public bool Animated { get; set; }

        /// <summary>The screen's animation player (attached on first use or on the first attach of an animated screen), or null.</summary>
        public DesignUiAnimationPlayer Animations => Animated ? DesignUiAnimationPlayer.Attach(this) : null;

        /// <summary>
        /// The locale code of English, the source and fallback language of the screen's localized texts (written by the
        /// compiler when the profile localizes), or null.
        /// </summary>
        [UxmlAttribute("source-locale")]
        public string SourceLocale { get; set; }

        public DesignScreen()
        {
            RegisterCallback<AttachToPanelEvent>(OnAttach);
            RegisterCallback<DetachFromPanelEvent>(OnDetach);
            RegisterCallback<GeometryChangedEvent>(m_OnGeometry = e => ApplyRootScale());
            // UI Toolkit resolves every style again when a panel's scale changes (a new resolution, or the exact-scale factor
            // taking effect), also when the panel's size in panel pixels stays (16:9 to 16:9): the root, which has custom
            // properties (the compiler writes one, DesignFonts.uss its locale's fonts), gets this event then
            RegisterCallback<CustomStyleResolvedEvent>(e => ApplyRootScale());
        }

        readonly EventCallback<GeometryChangedEvent> m_OnGeometry;
        VisualElement m_PanelRoot;

        void OnAttach(AttachToPanelEvent e)
        {
            LocaleFontController.ScreenAttached(this);
            if (Animated) DesignUiAnimationPlayer.Attach(this);
            // the panel's own root too: a screen root of a fixed size keeps its geometry when the panel is resized
            m_PanelRoot?.UnregisterCallback(m_OnGeometry);
            m_PanelRoot = e.destinationPanel?.visualTree;
            m_PanelRoot?.RegisterCallback(m_OnGeometry);
            ApplyRootScale();
        }

        /// <summary>
        /// Lays the screen out at an exact scale: on a runtime panel whose scale (without the exact-scale factor) is none of
        /// <see cref="ExactScales"/>, sets the panel's PanelSettings factor so it lays out at the nearest exact one
        /// (<see cref="DesignViewportScales.LayoutScale"/>; given back when the last such screen leaves the panel) and scales the
        /// root by actual / exact from its top-left corner; at an exact scale the root is not scaled. Then applies the
        /// breakpoints at the design's size. Called on attach, on geometry changes of the root and of the panel's root, and when
        /// the root's styles are resolved again (a panel scale change); a screen without exact scales only applies the
        /// breakpoints.
        /// </summary>
        public void ApplyRootScale()
        {
            float r = 1f;
            double? design = null;
            var p = panel;
            if (p != null && m_ExactScales != null && p is IRuntimePanel runtime && runtime.panelSettings != null)
            {
                if (DesignRootScalePanels.Evaluate(this, p, runtime.panelSettings, m_ExactScales, out var actual, out r)) design = actual;
            }
            else DesignRootScalePanels.Leave(this);
            DesignScale = design;
            SetRootScale(r);
            ApplyBreakpoints();
        }

        void SetRootScale(float r)
        {
            if (r != RootScale)
            {
                RootScale = r;
                if (r == 1f)
                {
                    style.scale = StyleKeyword.Null;
                    style.transformOrigin = StyleKeyword.Null;
                    style.flexShrink = StyleKeyword.Null;
                    return;
                }
                style.transformOrigin = new TransformOrigin(new Length(0), new Length(0), 0);
                style.scale = new Scale(new UnityEngine.Vector3(r, r, 1));
            }
            // the parent is laid out in panel pixels of the exact scale, 1 / r of the design's: the root keeps its design size
            if (r != 1f && style.flexShrink != 0f) style.flexShrink = 0f;
        }


        /// <summary>
        /// Sets the <c>bp-*</c> class of every breakpoint that holds at the design's size of the panel (its logical size at
        /// the design's scale: the panel's root over <see cref="RootScale"/>, rounded to whole pixels as the exporter rounds
        /// it) and removes the others. Does nothing outside a panel or before the panel has a size; called by
        /// <see cref="ApplyRootScale"/>.
        /// </summary>
        public void ApplyBreakpoints()
        {
            if (m_Breakpoints == null || panel == null) return;
            var size = panel.visualTree.layout.size;
            if (float.IsNaN(size.x) || float.IsNaN(size.y) || size.x <= 0 || size.y <= 0) return;
            if (DesignScale.HasValue)
            {
                // the panel's target over the design's scale (the panel's root may still be laid out at the previous scale)
                var w = panel.visualTree.style.width;
                var h = panel.visualTree.style.height;
                float ppp = panel.scaledPixelsPerPoint;
                if (w.keyword == StyleKeyword.Undefined && h.keyword == StyleKeyword.Undefined && ppp > 0)
                    size = new UnityEngine.Vector2((float)(w.value.value * ppp / DesignScale.Value), (float)(h.value.value * ppp / DesignScale.Value));
            }
            var active = new System.Collections.Generic.HashSet<string>(m_Breakpoints.Active(size.x, size.y));
            foreach (var b in m_Breakpoints.All)
                EnableInClassList(DesignBreakpoints.ClassPrefix + b.Name, active.Contains(b.Name));
        }

        void OnDetach(DetachFromPanelEvent e)
        {
            m_PanelRoot?.UnregisterCallback(m_OnGeometry);
            m_PanelRoot = null;
            DesignRootScalePanels.Leave(this);
            DesignScale = null;
            SetRootScale(1f);
            LocaleFontController.ScreenDetached(this);
        }
    }
}
