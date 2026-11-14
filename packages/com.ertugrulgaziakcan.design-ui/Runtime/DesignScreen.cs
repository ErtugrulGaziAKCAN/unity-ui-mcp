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
    /// Otherwise it is a plain VisualElement: it adds no style and no class.
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

        double[] m_ViewportScales;
        string m_ViewportScalesText;
        IVisualElementScheduledItem m_ScaleWatch;

        /// <summary>
        /// The panel scales of the profile's scaled viewports (written by the compiler, <see cref="DesignViewportScales.Encode"/>):
        /// while the screen is in a panel that renders at one of them it carries that scale's class
        /// (<see cref="DesignViewportScales.ClassOf"/>), under which the compiled fonts keep the design's text size and line box.
        /// </summary>
        [UxmlAttribute("viewport-scales")]
        public string ViewportScales
        {
            get => m_ViewportScalesText;
            set
            {
                m_ViewportScalesText = value;
                m_ViewportScales = string.IsNullOrEmpty(value) ? null : DesignViewportScales.Parse(value);
                ApplyViewportScale();
            }
        }

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
            RegisterCallback<GeometryChangedEvent>(m_OnGeometry = e => { ApplyBreakpoints(); ApplyViewportScale(); });
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
            ApplyBreakpoints();
            ApplyViewportScale();
            // a resolution change of the same aspect ratio keeps the panel's logical size (no geometry change): watch the scale
            if (m_ViewportScales != null && m_ScaleWatch == null) m_ScaleWatch = schedule.Execute(ApplyViewportScale).Every(100);
        }

        /// <summary>
        /// Sets the class of the declared scaled viewport whose scale the panel renders at (<see cref="IPanel.scaledPixelsPerPoint"/>,
        /// within <see cref="DesignViewportScales.Tolerance"/>) and removes the others. Does nothing outside a panel; called on
        /// attach, on geometry changes and every 100 ms while attached.
        /// </summary>
        public void ApplyViewportScale()
        {
            if (m_ViewportScales == null || panel == null) return;
            var current = DesignViewportScales.Matching(m_ViewportScales, panel.scaledPixelsPerPoint);
            foreach (var s in m_ViewportScales)
            {
                var cls = DesignViewportScales.ClassOf(s);
                bool on = current.HasValue && current.Value == s;
                if (ClassListContains(cls) != on) EnableInClassList(cls, on);
            }
        }

        /// <summary>
        /// Sets the <c>bp-*</c> class of every breakpoint that holds at the panel's logical size (its root's layout, rounded
        /// to whole pixels as the exporter rounds it) and removes the others. Does nothing outside a panel or before the panel
        /// has a size; called on attach and on every geometry change of the screen root or the panel's root (a resized
        /// panel, or a changed scale, lays them out again).
        /// </summary>
        public void ApplyBreakpoints()
        {
            if (m_Breakpoints == null || panel == null) return;
            var size = panel.visualTree.layout.size;
            if (float.IsNaN(size.x) || float.IsNaN(size.y) || size.x <= 0 || size.y <= 0) return;
            var active = new System.Collections.Generic.HashSet<string>(m_Breakpoints.Active(size.x, size.y));
            foreach (var b in m_Breakpoints.All)
                EnableInClassList(DesignBreakpoints.ClassPrefix + b.Name, active.Contains(b.Name));
        }

        void OnDetach(DetachFromPanelEvent e)
        {
            m_PanelRoot?.UnregisterCallback(m_OnGeometry);
            m_PanelRoot = null;
            LocaleFontController.ScreenDetached(this);
        }
    }
}
