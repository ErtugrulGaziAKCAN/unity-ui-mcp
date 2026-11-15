using System;
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
    /// screen out at an exact scale (the next one up) and draws its root scaled to the actual one (an inline transform that composes
    /// the root scale with the design's own transform of the root and its animations, and <c>flex-shrink: 0</c>: the root
    /// keeps its design size); it applies the design's breakpoints. A screen inside another screen that has exact scales
    /// is scaled with it (it never scales itself again). Otherwise it is a plain VisualElement.
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
        string[] m_BreakpointClasses;
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
                m_BreakpointClasses = null;
                if (m_Breakpoints != null)
                {
                    m_BreakpointClasses = new string[m_Breakpoints.All.Count];
                    for (int i = 0; i < m_BreakpointClasses.Length; i++) m_BreakpointClasses[i] = DesignBreakpoints.ClassPrefix + m_Breakpoints.All[i].Name;
                }
                ApplyBreakpoints();
            }
        }

        double[] m_ExactScales;
        string m_ExactScalesText;

        /// <summary>
        /// The panel scales of the profile's exact viewports (written by the compiler, <see cref="DesignViewportScales.Encode"/>).
        /// While the screen is on a runtime panel whose scale is none of them (a scaled viewport, or a resolution the profile does
        /// not declare), the panel lays out at an exact scale (the next one up) and the root draws scaled by <see cref="RootScale"/>
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
            RegisterCallback<GeometryChangedEvent>(m_OnGeometry = e =>
            {
                ApplyRootScale();
                // laid out at the new scale: the exact-width texts measure their paddings and borders again
                if (m_RefitPending) RefitTexts();
            });
            // UI Toolkit resolves every style again when a panel's scale changes (a new resolution, or the exact-scale factor
            // taking effect), also when the panel's size in panel pixels stays (16:9 to 16:9): the root, which has custom
            // properties (the compiler writes one, DesignFonts.uss its locale's fonts), gets this event then
            RegisterCallback<CustomStyleResolvedEvent>(e =>
            {
                ReadRuleTransform();
                ApplyRootScale();
            });
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
        /// <see cref="ExactScales"/>, sets the panel's PanelSettings factor so it lays out at the next exact one up
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
                else if (DesignRootScalePanels.Holds(runtime.panelSettings))
                {
                    // the panel has no size for a moment (a target texture swap): the factor is still held, so is the root scale
                    r = RootScale;
                    design = DesignScale;
                }
                // inside a screen that applies the root scale: drawn scaled with it, never scaled again
                if (OuterScreen() != null) r = 1f;
            }
            else DesignRootScalePanels.Leave(this);
            bool changed = design != DesignScale || r != RootScale;
            DesignScale = design;
            SetRootScale(r);
            ApplyBreakpoints();
            if (changed) RefitTextsLater();
        }

        /// <summary>The nearest screen above this one that lays out at an exact scale, or null.</summary>
        DesignScreen OuterScreen()
        {
            for (var e = hierarchy.parent; e != null; e = e.hierarchy.parent)
                if (e is DesignScreen outer && outer.m_ExactScales != null) return outer;
            return null;
        }

        IVisualElementScheduledItem m_Refit;
        bool m_RefitPending;

        /// <summary>
        /// Measures the screen's exact-width texts again (<see cref="DesignTextFit"/>) once the panel has laid them out at its
        /// new scale (their paddings and borders are the previous scale's until then): on the next geometry change of the root
        /// or the panel's root, or on the panel's next update, whichever comes first.
        /// </summary>
        void RefitTextsLater()
        {
            m_RefitPending = true;
            if (panel == null) return;
            if (m_Refit == null) m_Refit = schedule.Execute(RefitTexts);
            else m_Refit.ExecuteLater(0);
            DesignRootScalePanels.RequestUpdate(panel.visualTree);
        }

        void RefitTexts()
        {
            m_RefitPending = false;
            this.Query<TextElement>().ForEach(t =>
            {
                if (t is DesignLabel label) label.Fit.Update();
                else if (t is DesignButton button) button.Fit.Update();
            });
        }

        void SetRootScale(float r)
        {
            RootScale = r;
            // the design's transform of the root with the root scale on top (or only the design's where unscaled), written
            // whenever it differs from what the root holds (an animation that ended, a state's transform)
            ComposeTransform();
            if (r == 1f)
            {
                if (style.flexShrink.keyword != StyleKeyword.Null) style.flexShrink = StyleKeyword.Null;
                return;
            }
            // the parent is laid out in panel pixels of the exact scale, 1 / r of the design's: the root keeps its design size
            if (style.flexShrink.keyword != StyleKeyword.Undefined || style.flexShrink.value != 0f) style.flexShrink = 0f;
        }

        /// <summary>
        /// Sets the <c>bp-*</c> class of every breakpoint that holds at the design's size of the panel and removes the others.
        /// The design's size is the panel's target in device pixels over <see cref="DesignScale"/> (not the panel's laid-out
        /// size, which is the exact scale's: 2133 px wide at 1600×900, where the design is 2560), rounded to whole pixels as
        /// the exporter rounds it; without a design scale, the panel's laid-out size. Does nothing outside a panel or before
        /// the panel has a size; called by <see cref="ApplyRootScale"/>.
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
            // the exporter's rounding of the logical size (DesignBreakpoints.Active)
            double width = Math.Round(size.x, MidpointRounding.AwayFromZero), height = Math.Round(size.y, MidpointRounding.AwayFromZero);
            for (int i = 0; i < m_BreakpointClasses.Length; i++)
                EnableInClassList(m_BreakpointClasses[i], m_Breakpoints.All[i].Holds(width, height));
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
