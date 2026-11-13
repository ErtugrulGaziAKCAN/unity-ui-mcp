using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using UnityEngine;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace DesignUi
{
    /// <summary>Whether a panel can use the advanced text generator: Unity's answer, or Unknown when this version gives none.</summary>
    internal enum AdvancedTextState { On, Off, Unknown }

    /// <summary>
    /// Keeps a design screen's root on the selected locale and the game's text size (spec 13).
    /// <list type="bullet">
    /// <item>Locale: the root and every compiled screen root below it (the elements that carry a <c>locale-*</c> class)
    /// get <c>locale-&lt;code&gt;</c> of the font set's locale for the selection (its language's, else the reference
    /// locale's), so <c>DesignFonts.uss</c> points every font variable at that locale's twins and
    /// <see cref="DesignText"/> prepares bound text in them; the root gets the locale's primary twin as
    /// <c>-unity-font-definition</c> (inherited by text that names no family).</item>
    /// <item>Right to left (<see cref="DesignLocaleRules"/>): the <c>rtl</c> class, an RTL language direction, and the
    /// rule's alignment flip of start-aligned text (inline, per text element, from its design alignment; the layout is
    /// not mirrored).</item>
    /// <item>Shaping: <c>-unity-text-generator: advanced</c> on the root for right-to-left and complex-script locales only
    /// (the standard generator stays for the rest, where it measured exact). Unity's own check decides: on — requested;
    /// off (Project Settings > UI Toolkit > Enable Advanced Text unchecked) — not requested, the locale is reported in
    /// <see cref="Issues"/>; unknown (a Unity version whose check this package does not know) — requested, and a warning
    /// to verify the setting is reported once per session. Unity 6000.3 answers through an internal method
    /// (<c>TextUtilities.IsAdvancedTextEnabledForPanel</c>: the project setting in the Editor, the PanelSettings' ICU data
    /// in a player); there is no public or Editor API for it. Unity 6000.6 has no switch (the generator is always
    /// available), which the check knows.</item>
    /// <item>Text size (<see cref="IDesignTextSizeSource"/>): the root's <c>text-size-&lt;key&gt;</c> class, and every
    /// text's design size times the scale, applied exactly (inline). A step that leaves a size or a kit line box off
    /// whole device pixels at a declared viewport scale is reported, never rounded.</item>
    /// </list>
    /// Text added later is handled at its first layout, a screen added directly below the root on the next frame; the
    /// per-frame pass allocates nothing in steady state. Disposing unsubscribes, gives every text its own alignment and
    /// size back and removes the text-size class; the root keeps its last locale.
    /// Never blocks on a locale: a source that does not know it yet (null) keeps the screen as it is.
    /// </summary>
    public sealed class LocaleFontController : IDisposable
    {
        public const string RtlClass = "rtl";
        public const string TextSizeClassPrefix = "text-size-";

        /// <summary>Whether the panel can use the advanced text generator (Project Settings > UI Toolkit > Enable Advanced Text).</summary>
        internal static Func<IPanel, AdvancedTextState> AdvancedTextCheck = UnityAdvancedText;

        /// <summary>How this Unity version answers the Advanced Text check, or null when it cannot tell (every answer is Unknown).</summary>
        internal static string AdvancedTextLookup
        {
            get
            {
                LookUpAdvancedText();
                return s_AdvancedTextLookup;
            }
        }

        /// <summary>Lets the next Unknown answer log its warning again (tests).</summary>
        internal static void ResetAdvancedTextReport() => s_UnknownReported = false;

        const string UnknownAdvancedText =
            "Design UI cannot tell whether this Unity version has the advanced text generator enabled, so it requests it for right-to-left and complex-script locales: " +
            "verify Project Settings > UI Toolkit > Enable Advanced Text (where the setting exists), or their text renders unshaped.";

        sealed class Saved
        {
            public StyleEnum<TextAnchor> InlineAlign;
            public StyleLength InlineSize;
            public TextAnchor DesignAlign;
            public float DesignSize;
            public int Pass;
        }

        readonly VisualElement m_Root;
        readonly DesignFontSet m_Fonts;
        readonly DesignLocaleRules m_Rules;
        readonly float[] m_ViewportScales;
        readonly IDesignLocaleSource m_Locales;
        readonly IDesignTextSizeSource m_TextSizes;
        readonly Dictionary<TextElement, Saved> m_Saved = new Dictionary<TextElement, Saved>();
        readonly List<TextElement> m_Gone = new List<TextElement>();
        readonly List<VisualElement> m_LocaleRoots = new List<VisualElement>();
        readonly List<VisualElement> m_Children = new List<VisualElement>();
        readonly HashSet<FontAsset> m_LineBoxFonts = new HashSet<FontAsset>();
        readonly HashSet<(float, float)> m_Checked = new HashSet<(float, float)>();
        readonly List<string> m_LocaleIssues = new List<string>();
        readonly List<string> m_SizeIssues = new List<string>();
        readonly List<string> m_Issues = new List<string>();
        readonly HashSet<string> m_Logged = new HashSet<string>();
        readonly HashSet<TextElement> m_AwaitingLayout = new HashSet<TextElement>();
        readonly EventCallback<GeometryChangedEvent> m_OnLaidOut;
        readonly IVisualElementScheduledItem m_Tick;
        string m_LocaleClass, m_SizeClass;
        bool m_FlipAlignment;
        float m_Scale = 1f;
        int m_Pass;
        bool m_Disposed;

        /// <param name="root">The screen root (a UIDocument's root or a compiled screen root).</param>
        /// <param name="fonts">The screens' font set (<c>DesignFonts.asset</c>); null leaves fonts to the theme.</param>
        /// <param name="rules">Right-to-left and shaping locales and the alignment rule; null uses the defaults.</param>
        /// <param name="locales">The locale source; null: set the locale with <see cref="SetLocale"/>.</param>
        /// <param name="textSizes">The game's text size; null keeps the design's sizes (or use <see cref="SetTextSize"/>).</param>
        /// <param name="viewportScales">Panel scales of the declared viewports a text size is checked at (default: 1).</param>
        public LocaleFontController(VisualElement root, DesignFontSet fonts, DesignLocaleRules rules = null, IDesignLocaleSource locales = null,
            IDesignTextSizeSource textSizes = null, IReadOnlyList<float> viewportScales = null)
        {
            m_Root = root ?? throw new ArgumentNullException(nameof(root));
            m_Fonts = fonts;
            m_Rules = rules ?? new DesignLocaleRules();
            m_ViewportScales = Scales(viewportScales);
            m_Locales = locales;
            m_TextSizes = textSizes;
            if (fonts != null)
                foreach (var l in fonts.locales ?? new DesignFontSet.LocaleFonts[0])
                    if (l?.fonts != null)
                        for (int i = 1; i < l.fonts.Length; i++)
                            if (l.fonts[i] != null) m_LineBoxFonts.Add(l.fonts[i]);
            m_OnLaidOut = OnLaidOut;
            m_Root.RegisterCallback<AttachToPanelEvent>(OnAttach);
            m_Tick = m_Root.schedule.Execute(Tick).Every(0);
            if (m_Locales != null)
            {
                m_Locales.LocaleChanged += SetLocale;
                SetLocale(m_Locales.LocaleCode);
            }
            if (m_TextSizes != null)
            {
                m_TextSizes.TextSizeChanged += OnTextSizeChanged;
                OnTextSizeChanged();
            }
        }

        /// <summary>The font set's locale the screen renders with (its class is <c>locale-&lt;Locale&gt;</c>), or null before the first locale.</summary>
        public string Locale { get; private set; }

        /// <summary>The locale code last selected (may have no fonts of its own).</summary>
        public string RequestedLocale { get; private set; }

        public bool IsRightToLeft { get; private set; }

        /// <summary>Whether the root requests the advanced text generator.</summary>
        public bool UsesAdvancedText { get; private set; }

        /// <summary>The text-size option applied, or null.</summary>
        public string TextSize { get; private set; }

        public float TextScale => m_Scale;

        /// <summary>
        /// What the screen cannot show as designed with the current locale and text size: a shaping locale without the
        /// advanced generator, text sizes off whole device pixels. Each is also logged once as a warning.
        /// </summary>
        public IReadOnlyList<string> Issues => m_Issues;

        /// <summary>
        /// Shows <paramref name="code"/>. Null or empty (a source still loading) keeps the current locale.
        /// </summary>
        public void SetLocale(string code)
        {
            if (m_Disposed || string.IsNullOrEmpty(code)) return;
            RequestedLocale = code;
            Locale = FontLocale(code);
            m_LocaleClass = DesignFontSet.LocaleClassPrefix + Locale;
            ApplyLocaleClass();

            var twins = m_Fonts != null ? m_Fonts.FontsFor(Locale) : null;
            var primary = twins != null && twins.Count > 0 ? twins[0] : null;
            m_Root.style.unityFontDefinition = primary != null ? FontDefinition.FromSDFFont(primary) : new StyleFontDefinition(StyleKeyword.Null);

            IsRightToLeft = m_Rules.IsRightToLeft(code);
            m_Root.EnableInClassList(RtlClass, IsRightToLeft);
            m_Root.languageDirection = IsRightToLeft ? LanguageDirection.RTL : LanguageDirection.Inherit;
            m_FlipAlignment = IsRightToLeft && m_Rules.rtlAlignment != RtlTextAlignment.Keep;
            ApplyGenerator();
            Refresh();
        }

        /// <summary>Applies the text-size option <paramref name="key"/> with <paramref name="scale"/> (1: the design's sizes).</summary>
        public void SetTextSize(string key, float scale)
        {
            if (m_Disposed) return;
            m_SizeIssues.Clear();
            if (!(scale > 0f) || float.IsInfinity(scale))
            {
                m_SizeIssues.Add("text size '" + key + "' has scale " + scale.ToString(CultureInfo.InvariantCulture) + "; the design's sizes are used");
                scale = 1f;
            }
            TextSize = key;
            m_Scale = scale;
            var cls = ValidKey(key) ? TextSizeClassPrefix + key : null;
            if (key != null && cls == null) m_SizeIssues.Add("text size '" + key + "' cannot be a USS class (lower-case ASCII letters, digits, '-' and '_'); no text-size class is set");
            if (m_SizeClass != null && m_SizeClass != cls) m_Root.RemoveFromClassList(m_SizeClass);
            m_SizeClass = cls;
            if (cls != null) m_Root.AddToClassList(cls);
            m_Checked.Clear();
            Refresh();
            UpdateIssues();
        }

        /// <summary>
        /// Applies the locale class to compiled screen roots, the alignment and the text size to every text below the root
        /// now. The controller does it every frame while RTL alignment or a text size is active, and finds new screens
        /// added directly below the root; call it after adding text deeper in the tree to have it before the next frame.
        /// </summary>
        public void Refresh()
        {
            if (m_Disposed) return;
            FindLocaleRoots();
            Pass();
        }

        public void Dispose()
        {
            if (m_Disposed) return;
            m_FlipAlignment = false;
            m_Scale = 1f;
            Pass();
            m_Saved.Clear();
            m_Disposed = true;
            m_Tick.Pause();
            if (m_SizeClass != null) m_Root.RemoveFromClassList(m_SizeClass); // the sizes went back to the design's
            m_Root.UnregisterCallback<AttachToPanelEvent>(OnAttach);
            foreach (var t in m_AwaitingLayout) t.UnregisterCallback(m_OnLaidOut);
            m_AwaitingLayout.Clear();
            if (m_Locales != null) m_Locales.LocaleChanged -= SetLocale;
            if (m_TextSizes != null) m_TextSizes.TextSizeChanged -= OnTextSizeChanged;
        }

        void OnTextSizeChanged() => SetTextSize(m_TextSizes.TextSize, m_TextSizes.TextScale);

        void OnAttach(AttachToPanelEvent e)
        {
            if (RequestedLocale != null) ApplyGenerator();
        }

        /// <summary>Every frame: new screens directly below the root get the locale class; active alignment or size is applied to new text.</summary>
        internal void Tick()
        {
            if (ChildrenChanged()) FindLocaleRoots();
            if (m_FlipAlignment || m_Scale != 1f) Pass();
        }

        bool ChildrenChanged()
        {
            int n = m_Root.hierarchy.childCount;
            bool changed = n != m_Children.Count;
            for (int i = 0; !changed && i < n; i++) changed = m_Root.hierarchy[i] != m_Children[i];
            if (!changed) return false;
            m_Children.Clear();
            for (int i = 0; i < n; i++) m_Children.Add(m_Root.hierarchy[i]);
            return true;
        }

        // ---- locale ---------------------------------------------------------------------------------------------------

        /// <summary>
        /// The font set's locale for <paramref name="code"/>: the same code, else the same language in the same script (when
        /// both name one: <c>zh-Hant</c> never gets <c>zh-Hans</c> twins), else the reference locale.
        /// </summary>
        string FontLocale(string code)
        {
            var locales = m_Fonts != null ? m_Fonts.locales : null;
            if (locales == null || locales.Length == 0) return code;
            string language = Language(code), sameLanguage = null;
            foreach (var l in locales)
            {
                if (string.IsNullOrEmpty(l?.locale)) continue;
                if (string.Equals(l.locale, code, StringComparison.OrdinalIgnoreCase)) return l.locale;
                if (sameLanguage == null && string.Equals(Language(l.locale), language, StringComparison.OrdinalIgnoreCase) &&
                    (Script(code) == null || Script(l.locale) == null || string.Equals(Script(code), Script(l.locale), StringComparison.OrdinalIgnoreCase)))
                    sameLanguage = l.locale;
            }
            return sameLanguage ?? (string.IsNullOrEmpty(m_Fonts.referenceLocale) ? code : m_Fonts.referenceLocale);
        }

        /// <summary>The script subtag (four letters, as in <c>zh-Hant</c>), or null.</summary>
        static string Script(string code)
        {
            foreach (var part in code.Split('-', '_')) if (part.Length == 4 && char.IsLetter(part[0])) return part;
            return null;
        }

        static string Language(string code)
        {
            int cut = code.IndexOfAny(new[] { '-', '_' });
            return cut < 0 ? code : code.Substring(0, cut);
        }

        /// <summary>The root and the elements below it that carry a locale class (compiled screen roots).</summary>
        void FindLocaleRoots()
        {
            m_LocaleRoots.Clear();
            m_LocaleRoots.Add(m_Root);
            var children = m_Root.hierarchy;
            for (int i = 0; i < children.childCount; i++) FindLocaleRoots(children[i]);
            ApplyLocaleClass();
        }

        void FindLocaleRoots(VisualElement e)
        {
            if (HasLocaleClass(e))
            {
                m_LocaleRoots.Add(e);
                return;
            }
            var children = e.hierarchy;
            for (int i = 0; i < children.childCount; i++) FindLocaleRoots(children[i]);
        }

        static bool HasLocaleClass(VisualElement e)
        {
            foreach (var c in e.GetClasses())
                if (c.StartsWith(DesignFontSet.LocaleClassPrefix, StringComparison.Ordinal)) return true;
            return false;
        }

        static readonly List<string> s_Remove = new List<string>();

        void ApplyLocaleClass()
        {
            if (m_LocaleClass == null) return;
            if (m_LocaleRoots.Count == 0) m_LocaleRoots.Add(m_Root);
            foreach (var e in m_LocaleRoots)
            {
                if (e.ClassListContains(m_LocaleClass) && !HasOtherLocaleClass(e)) continue;
                s_Remove.Clear();
                foreach (var c in e.GetClasses())
                    if (c != m_LocaleClass && c.StartsWith(DesignFontSet.LocaleClassPrefix, StringComparison.Ordinal)) s_Remove.Add(c);
                foreach (var c in s_Remove) e.RemoveFromClassList(c);
                e.AddToClassList(m_LocaleClass);
            }
        }

        bool HasOtherLocaleClass(VisualElement e)
        {
            foreach (var c in e.GetClasses())
                if (c != m_LocaleClass && c.StartsWith(DesignFontSet.LocaleClassPrefix, StringComparison.Ordinal)) return true;
            return false;
        }

        void ApplyGenerator()
        {
            m_LocaleIssues.Clear();
            bool use = false;
            var code = RequestedLocale;
            var panel = m_Root.panel; // without a panel it is decided when the root is attached (OnAttach)
            if (code != null && m_Rules.NeedsShaping(code) && panel != null)
            {
                var state = AdvancedTextCheck(panel);
                use = state != AdvancedTextState.Off;
                if (state == AdvancedTextState.Unknown) m_LocaleIssues.Add(UnknownAdvancedText);
                else if (state == AdvancedTextState.Off)
                    m_LocaleIssues.Add("locale '" + code + "' needs the advanced text generator (" + (IsRightToLeft ? "bidirectional text and shaping" : "shaping") +
                                       ") but the project has it off: enable Project Settings > UI Toolkit > Enable Advanced Text. Its text renders unshaped.");
            }
            UsesAdvancedText = use;
            m_Root.style.unityTextGenerator = use ? new StyleEnum<TextGeneratorType>(TextGeneratorType.Advanced) : new StyleEnum<TextGeneratorType>(StyleKeyword.Null);
            UpdateIssues();
        }

        static Func<IPanel, bool> s_PanelGate;
        static string s_AdvancedTextLookup;
        static bool s_LookedUp, s_UnknownReported;

        /// <summary>Unity's answer for a panel (see the class summary): On, Off, or Unknown on a version this package does not know.</summary>
        static AdvancedTextState UnityAdvancedText(IPanel panel)
        {
            LookUpAdvancedText();
            if (s_PanelGate != null) return s_PanelGate(panel) ? AdvancedTextState.On : AdvancedTextState.Off;
            return s_AdvancedTextLookup != null ? AdvancedTextState.On : AdvancedTextState.Unknown;
        }

        static void LookUpAdvancedText()
        {
            if (s_LookedUp) return;
            s_LookedUp = true;
            const BindingFlags any = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
            var utilities = typeof(VisualElement).Assembly.GetType("UnityEngine.UIElements.TextUtilities");
            var gate = utilities?.GetMethod("IsAdvancedTextEnabledForPanel", any, null, new[] { typeof(IPanel) }, null);
            if (gate != null && gate.ReturnType == typeof(bool))
            {
                s_PanelGate = (Func<IPanel, bool>)Delegate.CreateDelegate(typeof(Func<IPanel, bool>), gate);
                s_AdvancedTextLookup = "TextUtilities.IsAdvancedTextEnabledForPanel (internal; Unity 6000.3)";
            }
            // 6000.6 (read on 6000.6.8f1): the switch, its delegate and the panel gate are gone; the element check reads only
            // -unity-text-generator, so a requested generator is used
            else if (utilities != null && utilities.GetField("IsAdvancedTextEnabled", any) == null && AtLeast(6000, 6))
                s_AdvancedTextLookup = "no Advanced Text switch (Unity 6000.6 and newer: always available)";
        }

        static bool AtLeast(int major, int minor)
        {
            var parts = Application.unityVersion.Split('.');
            return parts.Length > 1 && int.TryParse(parts[0], out var a) && int.TryParse(parts[1], out var b) && (a > major || a == major && b >= minor);
        }

        // ---- alignment and size, per text element -------------------------------------------------------------------

        void Pass()
        {
            m_Pass++;
            if (m_FlipAlignment || m_Scale != 1f) Walk(m_Root);
            // texts this pass did not reach (outside the root now, or every text when nothing is active) get their own values back
            m_Gone.Clear();
            foreach (var kv in m_Saved)
            {
                if (kv.Value.Pass == m_Pass) continue;
                Write(kv.Key, kv.Value, false, 1f);
                if (kv.Key.panel == null) m_Gone.Add(kv.Key);
            }
            foreach (var t in m_Gone) m_Saved.Remove(t);
        }

        void Walk(VisualElement e)
        {
            if (e is TextElement t) Visit(t);
            var children = e.hierarchy;
            int n = children.childCount;
            for (int i = 0; i < n; i++) Walk(children[i]);
        }

        void Visit(TextElement t)
        {
            if (!m_Saved.TryGetValue(t, out var s))
            {
                if (float.IsNaN(t.layout.width))
                {
                    // not styled yet: handled at its first layout (styles are resolved by then)
                    if (m_AwaitingLayout.Add(t)) t.RegisterCallback(m_OnLaidOut);
                    return;
                }
                s = new Saved
                {
                    InlineAlign = t.style.unityTextAlign,
                    InlineSize = t.style.fontSize,
                    DesignAlign = t.resolvedStyle.unityTextAlign,
                    DesignSize = t.resolvedStyle.fontSize,
                };
                m_Saved.Add(t, s);
            }
            s.Pass = m_Pass;
            Write(t, s, m_FlipAlignment, m_Scale);
            if (m_Scale != 1f) Check(t, s);
        }

        void OnLaidOut(GeometryChangedEvent e)
        {
            if (!(e.target is TextElement t)) return;
            t.UnregisterCallback(m_OnLaidOut);
            m_AwaitingLayout.Remove(t);
            if (!m_Disposed && (m_FlipAlignment || m_Scale != 1f) && !float.IsNaN(t.layout.width)) Visit(t);
        }

        void Write(TextElement t, Saved s, bool flip, float scale)
        {
            var style = t.style;
            var align = flip ? Flip(s.DesignAlign, m_Rules.rtlAlignment) : s.DesignAlign;
            if (align != s.DesignAlign)
            {
                if (!Is(style.unityTextAlign, align)) style.unityTextAlign = align;
            }
            else if (!Same(style.unityTextAlign, s.InlineAlign)) style.unityTextAlign = s.InlineAlign;

            if (scale != 1f)
            {
                float px = s.DesignSize * scale;
                if (!Is(style.fontSize, px)) style.fontSize = px;
            }
            else if (!Same(style.fontSize, s.InlineSize)) style.fontSize = s.InlineSize;
        }

        static TextAnchor Flip(TextAnchor a, RtlTextAlignment rule)
        {
            switch (a)
            {
                case TextAnchor.UpperLeft: return TextAnchor.UpperRight;
                case TextAnchor.MiddleLeft: return TextAnchor.MiddleRight;
                case TextAnchor.LowerLeft: return TextAnchor.LowerRight;
                case TextAnchor.UpperRight: return rule == RtlTextAlignment.Mirror ? TextAnchor.UpperLeft : a;
                case TextAnchor.MiddleRight: return rule == RtlTextAlignment.Mirror ? TextAnchor.MiddleLeft : a;
                case TextAnchor.LowerRight: return rule == RtlTextAlignment.Mirror ? TextAnchor.LowerLeft : a;
                default: return a;
            }
        }

        static bool Is(StyleEnum<TextAnchor> v, TextAnchor a) => v.keyword == StyleKeyword.Undefined && v.value == a;
        static bool Same(StyleEnum<TextAnchor> a, StyleEnum<TextAnchor> b) => a.keyword == b.keyword && (a.keyword != StyleKeyword.Undefined || a.value == b.value);
        static bool Is(StyleLength v, float px) => v.keyword == StyleKeyword.Undefined && v.value.unit == LengthUnit.Pixel && v.value.value == px;
        static bool Same(StyleLength a, StyleLength b) =>
            a.keyword == b.keyword && (a.keyword != StyleKeyword.Undefined || a.value.unit == b.value.unit && a.value.value == b.value.value);

        // ---- text size check ----------------------------------------------------------------------------------------

        /// <summary>
        /// Reports a design size whose scaled size, or whose kit line box (a line-box twin: line height = ratio × size),
        /// is not a whole number of device pixels at a declared viewport scale. Each size and line box once per text size.
        /// </summary>
        void Check(TextElement t, Saved s)
        {
            var font = t.resolvedStyle.unityFontDefinition.fontAsset;
            float ratio = 0f;
            if (font != null && m_LineBoxFonts.Contains(font))
            {
                var face = font.faceInfo;
                if (face.pointSize > 0) ratio = face.lineHeight / face.pointSize;
            }
            if (!m_Checked.Add((s.DesignSize, ratio))) return;
            float size = s.DesignSize * m_Scale;
            string bad = null;
            foreach (var v in m_ViewportScales)
            {
                float px = size * v, line = size * ratio * v;
                if (!Whole(px)) bad = (bad == null ? "" : bad + "; ") + "font " + F(px) + " device px at viewport scale " + F(v);
                if (ratio > 0 && !Whole(line)) bad = (bad == null ? "" : bad + "; ") + "line box " + F(line) + " device px at viewport scale " + F(v);
            }
            if (bad == null) return;
            m_SizeIssues.Add("text size '" + TextSize + "' (x" + F(m_Scale) + "): " + F(s.DesignSize) + " px text" +
                             (ratio > 0 ? " in a " + F(ratio) + " line box" : "") + " becomes " + F(size) + " px: " + bad +
                             ". Not whole device pixels: Unity rounds font sizes and stacked lines drift from the design. Applied unrounded.");
            UpdateIssues();
        }

        static bool Whole(float x) => Mathf.Abs(x - Mathf.Round(x)) < 1e-3f;
        static string F(float x) => x.ToString("0.###", CultureInfo.InvariantCulture);

        void UpdateIssues()
        {
            m_Issues.Clear();
            m_Issues.AddRange(m_LocaleIssues);
            m_Issues.AddRange(m_SizeIssues);
            foreach (var issue in m_Issues)
            {
                if (!m_Logged.Add(issue)) continue;
                if (issue == UnknownAdvancedText)
                {
                    if (s_UnknownReported) continue; // a fact of the Unity version: once per session
                    s_UnknownReported = true;
                }
                Debug.LogWarning("Design UI: " + issue);
            }
        }

        static bool ValidKey(string key)
        {
            if (string.IsNullOrEmpty(key)) return false;
            foreach (var c in key)
                if (!(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_')) return false;
            return true;
        }

        static float[] Scales(IReadOnlyList<float> scales)
        {
            if (scales == null || scales.Count == 0) return new[] { 1f };
            var copy = new List<float>();
            foreach (var s in scales) if (s > 0f && !copy.Contains(s)) copy.Add(s);
            return copy.Count > 0 ? copy.ToArray() : new[] { 1f };
        }
    }
}
