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
    /// Keeps design screens on the selected locale and the game's text size (spec 13). It works by classes only: the
    /// compiled screens carry the rules.
    /// <list type="bullet">
    /// <item>Screen roots: its root and every compiled screen root below it (the elements that carry a <c>locale-*</c>
    /// class) get the classes below. A <see cref="DesignScreen"/> root (or the root of a generated view) attached anywhere
    /// below the root reports itself; other screens are found when the controller starts, on <see cref="Refresh"/> and,
    /// directly below the root, on the next frame.</item>
    /// <item>Locale: <c>locale-&lt;code&gt;</c> of the font set's locale for the selection (its language's, else the
    /// reference locale's), so <c>DesignFonts.uss</c> points every font variable at that locale's twins and
    /// <see cref="DesignText"/> prepares bound text in them; the root gets the locale's primary twin as
    /// <c>-unity-font-definition</c> (inherited by text that names no family).</item>
    /// <item>Right to left (<see cref="DesignLocaleRules"/>): the <c>rtl</c> class on the root, and an RTL language
    /// direction only while the advanced generator is known to be on: the standard generator has no bidirectional
    /// algorithm and reverses a whole RTL string, digits and Latin included ("6202" for 2026), so with the generator off or
    /// unknown the direction stays left to right and <see cref="Issues"/> says the locale needs Enable Advanced Text. The
    /// compiler writes the alignment rule as <c>.rtl</c> rules (start-aligned text to the end); the layout is not
    /// mirrored.</item>
    /// <item>Shaping: <c>-unity-text-generator: advanced</c> on the root for right-to-left and complex-script locales only
    /// (the standard generator stays for the rest, where it measured exact). Unity's own check decides: on — requested;
    /// off (Project Settings > UI Toolkit > Enable Advanced Text unchecked) — not requested, the locale is reported in
    /// <see cref="Issues"/>; unknown (a Unity version whose check this package does not know) — requested, and a warning
    /// to verify the setting is reported once per session. Unity 6000.3 answers through an internal method
    /// (<c>TextUtilities.IsAdvancedTextEnabledForPanel</c>: the project setting in the Editor, the PanelSettings' ICU data
    /// in a player); there is no public or Editor API for it. Unity 6000.6 has no switch (the generator is always
    /// available), which the check knows.</item>
    /// <item>Text size (<see cref="IDesignTextSizeSource"/>): the <c>text-size-&lt;key&gt;</c> class. The compiler writes
    /// each profile step's rules (every font size times its scale, kit line boxes with their scaled twins, validated at
    /// compile time), so state and class layers keep working under a step. A key or scale the font set does not list as
    /// compiled is reported in <see cref="Issues"/>.</item>
    /// </list>
    /// Nothing runs per frame but a check of the root's direct children (no allocation). The controller hears about
    /// attached screens only while its root is in a panel (no static list holds a detached tree). Disposing unsubscribes
    /// and removes the text-size class; the screens keep their last locale.
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

        static readonly List<LocaleFontController> s_Live = new List<LocaleFontController>();

        readonly VisualElement m_Root;
        readonly DesignFontSet m_Fonts;
        readonly DesignLocaleRules m_Rules;
        readonly IDesignLocaleSource m_Locales;
        readonly IDesignTextSizeSource m_TextSizes;
        readonly List<VisualElement> m_LocaleRoots = new List<VisualElement>();
        readonly List<VisualElement> m_Children = new List<VisualElement>();
        readonly List<string> m_LocaleIssues = new List<string>();
        readonly List<string> m_SizeIssues = new List<string>();
        readonly List<string> m_Issues = new List<string>();
        readonly HashSet<string> m_Logged = new HashSet<string>();
        readonly IVisualElementScheduledItem m_Tick;
        string m_LocaleClass, m_SizeClass;
        float m_Scale = 1f;
        bool m_Disposed;

        /// <param name="root">The screen root (a UIDocument's root or a compiled screen root).</param>
        /// <param name="fonts">The screens' font set (<c>DesignFonts.asset</c>); null leaves fonts to the theme.</param>
        /// <param name="rules">Right-to-left and shaping locales and the alignment rule; null uses the defaults.</param>
        /// <param name="locales">The locale source; null: set the locale with <see cref="SetLocale"/>.</param>
        /// <param name="textSizes">The game's text size; null keeps the design's sizes (or use <see cref="SetTextSize"/>).</param>
        /// <param name="viewportScales">Not used any more: the compiler validates each text-size step at the profile's viewports.</param>
        public LocaleFontController(VisualElement root, DesignFontSet fonts, DesignLocaleRules rules = null, IDesignLocaleSource locales = null,
            IDesignTextSizeSource textSizes = null, IReadOnlyList<float> viewportScales = null)
        {
            m_Root = root ?? throw new ArgumentNullException(nameof(root));
            m_Fonts = fonts;
            m_Rules = rules ?? new DesignLocaleRules();
            m_Locales = locales;
            m_TextSizes = textSizes;
            m_Root.RegisterCallback<AttachToPanelEvent>(OnAttach);
            m_Root.RegisterCallback<DetachFromPanelEvent>(OnDetach);
            m_Tick = m_Root.schedule.Execute(Tick).Every(0);
            if (m_Root.panel != null) s_Live.Add(this); // listed only while its root is in a panel: no static list keeps a detached tree
            FindLocaleRoots();
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
        /// advanced generator, a text size without compiled rules. Each is also logged once as a warning.
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

            var twins = m_Fonts != null ? m_Fonts.FontsFor(Locale) : null;
            var primary = twins != null && twins.Count > 0 ? twins[0] : null;
            m_Root.style.unityFontDefinition = primary != null ? FontDefinition.FromSDFFont(primary) : new StyleFontDefinition(StyleKeyword.Null);

            IsRightToLeft = m_Rules.IsRightToLeft(code);
            ApplyGenerator();
            ApplyClasses();
        }

        /// <summary>
        /// Applies the text-size option <paramref name="key"/>: the class <c>text-size-&lt;key&gt;</c> on the screen roots,
        /// whose compiled rules scale the text. <paramref name="scale"/> is the game's scale for the key; one that differs
        /// from the compiled step's is reported.
        /// </summary>
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
            else if (cls != null) CheckCompiled(key, scale);
            if (m_SizeClass != null && m_SizeClass != cls)
                foreach (var e in m_LocaleRoots) e.RemoveFromClassList(m_SizeClass);
            m_SizeClass = cls;
            ApplyClasses();
            UpdateIssues();
        }

        /// <summary>
        /// Finds the compiled screen roots below the root again and gives them the current classes. Screens with a
        /// <see cref="DesignScreen"/> root or a generated view report themselves when they are attached; call this after
        /// inserting another screen deeper than the root's direct children to have its classes before the next frame.
        /// </summary>
        public void Refresh()
        {
            if (m_Disposed) return;
            FindLocaleRoots();
        }

        public void Dispose()
        {
            if (m_Disposed) return;
            m_Disposed = true;
            s_Live.Remove(this);
            m_Tick.Pause();
            if (m_SizeClass != null)
                foreach (var e in m_LocaleRoots) e.RemoveFromClassList(m_SizeClass); // the sizes go back to the design's
            m_Root.UnregisterCallback<AttachToPanelEvent>(OnAttach);
            m_Root.UnregisterCallback<DetachFromPanelEvent>(OnDetach);
            if (m_Locales != null) m_Locales.LocaleChanged -= SetLocale;
            if (m_TextSizes != null) m_TextSizes.TextSizeChanged -= OnTextSizeChanged;
        }

        void OnTextSizeChanged() => SetTextSize(m_TextSizes.TextSize, m_TextSizes.TextScale);

        void OnAttach(AttachToPanelEvent e)
        {
            if (m_Disposed) return;
            if (!s_Live.Contains(this)) s_Live.Add(this);
            FindLocaleRoots(); // the tree may have changed while it was out of a panel
            if (RequestedLocale != null) ApplyGenerator();
        }

        void OnDetach(DetachFromPanelEvent e) => s_Live.Remove(this);

        /// <summary>Entering Play mode without a domain reload keeps statics: start with no listed controller.</summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetLive() => s_Live.Clear();

        /// <summary>Every frame: screens added directly below the root get the classes (allocates nothing when nothing changed).</summary>
        internal void Tick()
        {
            if (ChildrenChanged()) FindLocaleRoots();
        }

        /// <summary>A compiled screen root was attached to a panel: the controllers whose root is above it give it their classes.</summary>
        internal static void ScreenAttached(VisualElement screen)
        {
            if (screen == null || s_Live.Count == 0) return;
            for (var e = screen.hierarchy.parent; e != null; e = e.hierarchy.parent)
                for (int i = 0; i < s_Live.Count; i++)
                    if (s_Live[i].m_Root == e) s_Live[i].AddScreen(screen);
        }

        /// <summary>A compiled screen root was detached from its panel: the controllers forget it.</summary>
        internal static void ScreenDetached(VisualElement screen)
        {
            if (screen == null) return;
            for (int i = 0; i < s_Live.Count; i++)
                if (s_Live[i].m_Root != screen) s_Live[i].m_LocaleRoots.Remove(screen);
        }

        void AddScreen(VisualElement screen)
        {
            if (m_Disposed || m_LocaleRoots.Contains(screen)) return;
            m_LocaleRoots.Add(screen);
            Apply(screen);
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

        /// <summary>The root and every element below it that carries a locale class (compiled screen roots, nested ones too).</summary>
        void FindLocaleRoots()
        {
            m_LocaleRoots.Clear();
            m_LocaleRoots.Add(m_Root);
            var children = m_Root.hierarchy;
            for (int i = 0; i < children.childCount; i++) FindLocaleRoots(children[i]);
            ApplyClasses();
        }

        void FindLocaleRoots(VisualElement e)
        {
            if (HasLocaleClass(e)) m_LocaleRoots.Add(e);
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

        /// <summary>The locale, right-to-left and text-size classes on every screen root.</summary>
        void ApplyClasses()
        {
            if (m_LocaleRoots.Count == 0) m_LocaleRoots.Add(m_Root);
            foreach (var e in m_LocaleRoots) Apply(e);
        }

        void Apply(VisualElement e)
        {
            if (m_LocaleClass != null && (!e.ClassListContains(m_LocaleClass) || HasOtherLocaleClass(e)))
            {
                s_Remove.Clear();
                foreach (var c in e.GetClasses())
                    if (c != m_LocaleClass && c.StartsWith(DesignFontSet.LocaleClassPrefix, StringComparison.Ordinal)) s_Remove.Add(c);
                foreach (var c in s_Remove) e.RemoveFromClassList(c);
                e.AddToClassList(m_LocaleClass);
            }
            if (RequestedLocale != null && e.ClassListContains(RtlClass) != IsRightToLeft) e.EnableInClassList(RtlClass, IsRightToLeft);
            // exactly the current step: a screen detached while the step changed still carries the old one
            s_Remove.Clear();
            foreach (var c in e.GetClasses())
                if (c != m_SizeClass && c.StartsWith(TextSizeClassPrefix, StringComparison.Ordinal)) s_Remove.Add(c);
            foreach (var c in s_Remove) e.RemoveFromClassList(c);
            if (m_SizeClass != null && !e.ClassListContains(m_SizeClass)) e.AddToClassList(m_SizeClass);
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
            bool use = false, on = false;
            var code = RequestedLocale;
            var panel = m_Root.panel; // without a panel it is decided when the root is attached (OnAttach)
            if (code != null && m_Rules.NeedsShaping(code) && panel != null)
            {
                var state = AdvancedTextCheck(panel);
                use = state != AdvancedTextState.Off;
                on = state == AdvancedTextState.On;
                if (state == AdvancedTextState.Unknown)
                    m_LocaleIssues.Add(UnknownAdvancedText + (IsRightToLeft ? " Until it can tell, locale '" + code + "' keeps left-to-right direction." : ""));
                else if (state == AdvancedTextState.Off)
                    m_LocaleIssues.Add("locale '" + code + "' needs the advanced text generator (" + (IsRightToLeft ? "bidirectional text and shaping" : "shaping") +
                                       ") but the project has it off: enable Project Settings > UI Toolkit > Enable Advanced Text (players also need the PanelSettings' ICU data). " +
                                       (IsRightToLeft
                                           ? "Until then its text renders unshaped and left to right: the standard generator would reverse a right-to-left string, digits included."
                                           : "Its text renders unshaped."));
            }
            UsesAdvancedText = use;
            if (use && !TextAssetRegistry.Supported)
                m_LocaleIssues.Add("font assets unloaded and loaded again may render nothing with the advanced generator on this Unity version: " + TextAssetRegistry.Lookup);
            // the other TextCore members the package reaches by reflection: a renamed one turns a fix off, never silently
            var features = DesignText.FeatureMembersMissing;
            if (features != null)
                m_LocaleIssues.Add("kerning pairs keep TextCore's stray lookup flags (letter-spaced text may lose its spacing around kerned pairs) and font twins " +
                                   "keep the font features of glyphs they do not hold, on this Unity version: no " + features);
            if (m_Fonts != null && (m_Fonts.links?.Length ?? 0) > 0 && !FontTwinLink.Supported)
                m_LocaleIssues.Add("line-box variants render with glyphs of their own (rasterized on first use, the first layout unkerned) on this Unity version: " + FontTwinLink.Lookup);
            // the advanced generator finds a font by its instance ID: twins unloaded and loaded again must be registered again
            // (TextAssetRegistry); a screen may request the generator in its own styles too, so this runs for every locale
            if (panel != null && m_Fonts != null && Locale != null) TextAssetRegistry.Repair(m_Fonts.FontsFor(Locale));
            // line-box variants share their twins' glyphs (FontTwinLink); a twin that gained glyphs since is linked again
            if (m_Fonts != null) m_Fonts.LinkTwins();
            m_Root.style.unityTextGenerator = use ? new StyleEnum<TextGeneratorType>(TextGeneratorType.Advanced) : new StyleEnum<TextGeneratorType>(StyleKeyword.Null);
            // right to left only where the advanced generator lays it out: the standard one reverses the whole string
            m_Root.languageDirection = IsRightToLeft && on ? LanguageDirection.RTL : LanguageDirection.Inherit;
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

        // ---- text size check ----------------------------------------------------------------------------------------

        /// <summary>
        /// Reports a game text size the compiled screens have no rules for: a key the font set does not list, or another
        /// scale than the compiled step's. Without a font set there is nothing to compare with.
        /// </summary>
        void CheckCompiled(string key, float scale)
        {
            if (m_Fonts == null) return;
            var step = m_Fonts.TextSizeFor(key);
            if (step == null)
            {
                if (Mathf.Approximately(scale, 1f)) return; // the design's sizes need no rules
                m_SizeIssues.Add("text size '" + key + "' (x" + F(scale) + ") has no compiled rules: the profile's text sizes are " + Steps() +
                                 ". Add it to the DesignUiProfile's text sizes and recompile the screens; the design's sizes are shown.");
            }
            else if (!Mathf.Approximately(step.scale, scale))
                m_SizeIssues.Add("text size '" + key + "' is x" + F(scale) + " in the game but compiled as x" + F(step.scale) +
                                 ": the screens show x" + F(step.scale) + ". Make the profile's text size match the game's and recompile the screens.");
        }

        string Steps()
        {
            var list = new List<string>();
            foreach (var s in m_Fonts.textSizes ?? new DesignTextSize[0])
                if (s != null) list.Add(s.key + " (x" + F(s.scale) + ")");
            return list.Count == 0 ? "none" : string.Join(", ", list);
        }

        static string F(float x) => x.ToString("0.###", CultureInfo.InvariantCulture);

        void UpdateIssues()
        {
            m_Issues.Clear();
            m_Issues.AddRange(m_LocaleIssues);
            m_Issues.AddRange(m_SizeIssues);
            foreach (var issue in m_Issues)
            {
                if (!m_Logged.Add(issue)) continue;
                if (issue.StartsWith(UnknownAdvancedText, StringComparison.Ordinal))
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
    }
}
