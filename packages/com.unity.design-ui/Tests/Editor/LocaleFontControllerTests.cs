using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.TestTools.Constraints;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// <see cref="LocaleFontController"/>: the screen roots follow the selected locale (font twin, <c>locale-*</c> and
    /// <c>rtl</c> classes, advanced text generator for scripts that need shaping; the layout is not mirrored) and the game's
    /// text size (its class, with a report when the screens have no compiled rules for it). The compiled rules the classes
    /// select are tested with compiled screens (TextSizeAndRtlRulesTests).
    /// </summary>
    public class LocaleFontControllerTests
    {
        internal sealed class Locales : IDesignLocaleSource, IDisposable
        {
            public string LocaleCode { get; private set; }
            public event Action<string> LocaleChanged;
            public Locales(string code) { LocaleCode = code; }
            public void Set(string code)
            {
                LocaleCode = code;
                LocaleChanged?.Invoke(code);
            }
            public bool HasListeners => LocaleChanged != null;
            public bool Disposed { get; private set; }
            public void Dispose() => Disposed = true;
        }

        internal sealed class Sizes : IDesignTextSizeSource
        {
            public string TextSize { get; private set; }
            public float TextScale { get; private set; }
            public event Action TextSizeChanged;
            public Sizes(string key, float scale) { TextSize = key; TextScale = scale; }
            public void Set(string key, float scale)
            {
                TextSize = key;
                TextScale = scale;
                TextSizeChanged?.Invoke();
            }
            public bool HasListeners => TextSizeChanged != null;
        }

        readonly List<Object> _objects = new List<Object>();
        LocaleFontController _controller;
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;
        Func<IPanel, AdvancedTextState> _advancedCheck;
        IDisposable _advancedText;

        [SetUp]
        public void Remember() => _advancedCheck = LocaleFontController.AdvancedTextCheck;

        /// <summary>
        /// The answer of the Advanced Text check for this test. Tests that render text in a shaping locale say Off, so the
        /// generator is not requested on an Editor whose project setting is off (Unity would log an error).
        /// </summary>
        static void AdvancedText(AdvancedTextState state) => LocaleFontController.AdvancedTextCheck = _ => state;

        [TearDown]
        public void Cleanup()
        {
            try
            {
                _controller?.Dispose();
                _controller = null;
                if (_go != null) Object.DestroyImmediate(_go);
                if (_settings != null) Object.DestroyImmediate(_settings);
                if (_rt != null) Object.DestroyImmediate(_rt);
                foreach (var o in _objects) if (o != null) Object.DestroyImmediate(o);
                _objects.Clear();
                if (AssetDatabase.IsValidFolder(ArabicFolder)) AssetDatabase.DeleteAsset(ArabicFolder);
            }
            finally
            {
                LocaleFontController.AdvancedTextCheck = _advancedCheck;
                _advancedText?.Dispose(); // after the panel's text is gone: its handles ask for the generator while they are released
                _advancedText = null;
            }
        }

        T Track<T>(T o) where T : Object
        {
            _objects.Add(o);
            return o;
        }

        /// <summary>A screen root on a 1280×720 panel at scale 1.</summary>
        VisualElement Root()
        {
            _rt = new RenderTexture(1280, 720, 24);
            _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _go = new GameObject("LocaleFontControllerTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            var root = new VisualElement { name = "screen-root" };
            root.style.width = 1280;
            root.style.height = 720;
            doc.rootVisualElement.Add(root);
            return root;
        }

        FontAsset Inter(string name)
        {
            var font = Track(FontAsset.CreateFontAsset(AssetDatabase.LoadAssetAtPath<Font>(FontFixture.RegularTtf)));
            font.name = name;
            return font;
        }

        /// <summary>A copy of <paramref name="font"/> whose line box is <paramref name="ratio"/> × its point size (a kit line-box twin).</summary>
        FontAsset LineBox(string name, float ratio)
        {
            var font = Inter(name);
            var face = font.faceInfo;
            face.lineHeight = ratio * face.pointSize;
            font.faceInfo = face;
            return font;
        }

        DesignFontSet Set(params (string locale, FontAsset[] fonts)[] locales)
        {
            var set = Track(ScriptableObject.CreateInstance<DesignFontSet>());
            set.referenceLocale = locales[0].locale;
            set.locales = locales.Select(l => new DesignFontSet.LocaleFonts { locale = l.locale, fonts = l.fonts }).ToArray();
            return set;
        }

        static string[] LocaleClasses(VisualElement e) =>
            e.GetClasses().Where(c => c.StartsWith(DesignFontSet.LocaleClassPrefix, StringComparison.Ordinal)).ToArray();

        static FontAsset RootFont(VisualElement e) => e.style.unityFontDefinition.value.fontAsset;

        [Test]
        public void Locale_SwapsTheLocaleClassTheRootFontAndDirection()
        {
            FontFixture.RequireInter();
            var root = Root();
            FontAsset tr = Inter("tr twin"), en = Inter("en twin"), ar = Inter("ar twin"), trBox = LineBox("tr r125", 1.25f);
            var fonts = Set(("tr", new[] { tr, trBox }), ("en", new[] { en }), ("ar", new[] { ar }));
            var locales = new Locales("tr");
            AdvancedText(AdvancedTextState.Off);
            _controller = new LocaleFontController(root, fonts, new DesignLocaleRules(), locales);

            CollectionAssert.AreEqual(new[] { "locale-tr" }, LocaleClasses(root));
            Assert.AreSame(tr, RootFont(root), "the locale's primary twin on the root (text below inherits it)");
            Assert.IsFalse(root.ClassListContains(LocaleFontController.RtlClass));
            Assert.AreEqual("tr", _controller.Locale);

            locales.Set("en");
            CollectionAssert.AreEqual(new[] { "locale-en" }, LocaleClasses(root), "the previous locale class goes");
            Assert.AreSame(en, RootFont(root));

            locales.Set("ar-SA");
            CollectionAssert.AreEqual(new[] { "locale-ar" }, LocaleClasses(root), "a regional code uses its language's fonts");
            Assert.AreSame(ar, RootFont(root));
            Assert.IsTrue(root.ClassListContains(LocaleFontController.RtlClass));
            Assert.AreNotEqual(LanguageDirection.RTL, root.languageDirection, "no RTL direction without the advanced generator (the standard one reverses the string)");
            Assert.IsTrue(_controller.IsRightToLeft);
            var bound = new Label();
            root.Add(bound);
            Assert.AreEqual("ar", DesignFontSet.LocaleOf(bound), "DesignText prepares bound text in the locale's twins");

            locales.Set("pt-BR");
            CollectionAssert.AreEqual(new[] { "locale-tr" }, LocaleClasses(root), "a locale without fonts renders with the reference locale's");
            Assert.AreSame(tr, RootFont(root));
            Assert.IsFalse(root.ClassListContains(LocaleFontController.RtlClass));
            Assert.AreNotEqual(LanguageDirection.RTL, root.languageDirection);
            Assert.AreEqual("pt-BR", _controller.RequestedLocale);

            locales.Set(null);
            CollectionAssert.AreEqual(new[] { "locale-tr" }, LocaleClasses(root), "an unknown selection (still loading) keeps the current locale");

            _controller.Dispose();
            Assert.IsFalse(locales.HasListeners, "disposing unsubscribes");
            _controller = null;
        }

        [Test]
        public void Locale_WithoutAFontSet_StillSetsClassesAndDirection()
        {
            var root = Root();
            AdvancedText(AdvancedTextState.On);
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("he"));
            CollectionAssert.AreEqual(new[] { "locale-he" }, LocaleClasses(root));
            Assert.IsTrue(root.ClassListContains(LocaleFontController.RtlClass));
            Assert.AreEqual(StyleKeyword.Null, root.style.unityFontDefinition.keyword, "no font of its own: the theme's inherits");
        }

        [TestCase("ar", true, true)]
        [TestCase("fa-IR", true, true)]
        [TestCase("he", true, true)]
        [TestCase("ur", true, true)]
        [TestCase("pa-Arab", true, true)]
        [TestCase("th", false, true)]
        [TestCase("hi", false, true)]
        [TestCase("en", false, false)]
        [TestCase("tr", false, false)]
        [TestCase("zh-Hans", false, false)]
        [TestCase("sat-Deva", false, true)]
        [TestCase("ks-Arab", true, true)]
        [TestCase("sr-Latn", false, false)]
        [TestCase("ja", false, false)]
        public void Rules_KnowRightToLeftAndShapingLocales(string code, bool rtl, bool shaping)
        {
            var rules = new DesignLocaleRules();
            Assert.AreEqual(rtl, rules.IsRightToLeft(code), "rtl");
            Assert.AreEqual(shaping, rules.NeedsShaping(code), "shaping");
        }

        [Test]
        public void AdvancedGenerator_IsSetForShapingLocales_WhenTheProjectEnablesIt()
        {
            var root = Root();
            var locales = new Locales("ar");
            AdvancedText(AdvancedTextState.On);
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), locales);
            Assert.AreEqual(TextGeneratorType.Advanced, root.style.unityTextGenerator.value, "Arabic: shaping and bidi");
            Assert.IsTrue(_controller.UsesAdvancedText);
            locales.Set("th");
            Assert.AreEqual(TextGeneratorType.Advanced, root.style.unityTextGenerator.value, "Thai: complex script, left to right");
            Assert.IsFalse(root.ClassListContains(LocaleFontController.RtlClass));
            locales.Set("en");
            Assert.AreEqual(StyleKeyword.Null, root.style.unityTextGenerator.keyword, "Latin keeps the standard generator (measured exact)");
            Assert.IsFalse(_controller.UsesAdvancedText);
            CollectionAssert.IsEmpty(_controller.Issues);
        }

        /// <summary>
        /// The standard text generator has no bidirectional algorithm: with an RTL direction it reverses the whole string,
        /// digits and Latin included ("6202" for 2026). The direction is RTL only while the advanced generator is known to
        /// be on; off or unknown, it stays left to right and the issue says the locale needs Enable Advanced Text.
        /// </summary>
        [Test]
        public void RightToLeft_DirectionOnlyWhileTheAdvancedGeneratorIsOn()
        {
            var root = Root();
            var locales = new Locales("en");
            AdvancedText(AdvancedTextState.Off);
            LogAssert.Expect(LogType.Warning, new Regex("ar.*Enable Advanced Text.*left to right.*reverse"));
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), locales);
            locales.Set("ar");
            Assert.IsTrue(_controller.IsRightToLeft);
            Assert.IsTrue(root.ClassListContains(LocaleFontController.RtlClass), "the alignment rule still applies");
            Assert.AreEqual(LanguageDirection.Inherit, root.languageDirection, "off: never an RTL direction the standard generator reverses");
            Assert.AreEqual(StyleKeyword.Null, root.style.unityTextGenerator.keyword);
            StringAssert.Contains("Enable Advanced Text", _controller.Issues[0]);
            StringAssert.Contains("left to right", _controller.Issues[0]);
            _controller.Dispose();

            AdvancedText(AdvancedTextState.Unknown);
            LocaleFontController.ResetAdvancedTextReport();
            LogAssert.Expect(LogType.Warning, new Regex("cannot tell whether"));
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("he"));
            Assert.AreEqual(LanguageDirection.Inherit, root.languageDirection, "unknown: requested for shaping, but no RTL direction");
            Assert.AreEqual(TextGeneratorType.Advanced, root.style.unityTextGenerator.value);
            StringAssert.Contains("left-to-right", _controller.Issues[0]);
            _controller.Dispose();

            AdvancedText(AdvancedTextState.On);
            var on = new Locales("ar");
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), on);
            Assert.AreEqual(LanguageDirection.RTL, root.languageDirection, "on: the advanced generator lays out right to left");
            CollectionAssert.IsEmpty(_controller.Issues);
            on.Set("tr");
            Assert.AreEqual(LanguageDirection.Inherit, root.languageDirection);
        }

        [Test]
        public void AdvancedGenerator_Off_IsReported_AndNotRequested()
        {
            var root = Root();
            AdvancedText(AdvancedTextState.Off);
            LogAssert.Expect(LogType.Warning, new Regex("ar.*Enable Advanced Text"));
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("ar"));
            Assert.AreEqual(StyleKeyword.Null, root.style.unityTextGenerator.keyword,
                "not requested: Unity would log that the generator is disabled and render unshaped anyway");
            Assert.IsFalse(_controller.UsesAdvancedText);
            Assert.IsTrue(root.ClassListContains(LocaleFontController.RtlClass), "direction and alignment still follow the locale");
            Assert.AreEqual(1, _controller.Issues.Count);
            StringAssert.Contains("Enable Advanced Text", _controller.Issues[0]);
        }

        [Test]
        public void AdvancedGenerator_Unknown_IsRequested_AndReportedOnce()
        {
            var root = Root();
            AdvancedText(AdvancedTextState.Unknown);
            LocaleFontController.ResetAdvancedTextReport();
            LogAssert.Expect(LogType.Warning, new Regex("cannot tell whether.*Project Settings > UI Toolkit > Enable Advanced Text"));
            var locales = new Locales("ar");
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), locales);
            Assert.AreEqual(TextGeneratorType.Advanced, root.style.unityTextGenerator.value, "requested: shaping needs it");
            Assert.IsTrue(_controller.UsesAdvancedText);
            Assert.AreEqual(1, _controller.Issues.Count);
            StringAssert.Contains("Enable Advanced Text", _controller.Issues[0]);

            locales.Set("th");
            _controller.Dispose();
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("fa"));
            Assert.AreEqual(1, _controller.Issues.Count, "every controller lists it");
            LogAssert.NoUnexpectedReceived(); // logged once per session, not per locale or screen
        }

        [Test]
        public void AdvancedTextLookup_KnowsThisEditorVersion()
        {
            Assert.IsNotNull(LocaleFontController.AdvancedTextLookup,
                "Unity " + Application.unityVersion + ": LocaleFontController cannot find how this version enables the advanced text " +
                "generator, so it reports 'unknown' for every shaping locale. Find the version's switch (6000.3: the internal " +
                "UnityEngine.UIElements.TextUtilities.IsAdvancedTextEnabledForPanel; 6000.6: none, always on) and extend UnityAdvancedText.");
        }

        [Test]
        public void DefaultCheck_FollowsUnitysAdvancedTextSwitch()
        {
            if (!AdvancedTextScope.Available)
                Assert.Ignore("Unity " + Application.unityVersion + " has no Advanced Text switch to turn (lookup: " + LocaleFontController.AdvancedTextLookup + ")");
            var root = Root();
            using (new AdvancedTextScope(false))
            {
                LogAssert.Expect(LogType.Warning, new Regex("ar.*Enable Advanced Text"));
                _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("ar"));
                Assert.IsFalse(_controller.UsesAdvancedText, "off in the project: not requested");
                Assert.AreEqual(StyleKeyword.Null, root.style.unityTextGenerator.keyword);
                Assert.AreEqual(1, _controller.Issues.Count, "and reported");
                _controller.Dispose();
            }
            using (new AdvancedTextScope(true))
            {
                _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("ar"));
                Assert.IsTrue(_controller.UsesAdvancedText, "on in the project: requested");
                CollectionAssert.IsEmpty(_controller.Issues);
                _controller.Dispose();
                _controller = null;
            }
        }

        [Test]
        public void Locale_OfTheSameLanguageInAnotherScript_UsesTheReferenceFonts()
        {
            FontFixture.RequireInter();
            var root = Root();
            var fonts = Set(("en", new[] { Inter("en twin") }), ("zh-Hans", new[] { Inter("zh-Hans twin") }));
            var locales = new Locales("zh-Hans");
            _controller = new LocaleFontController(root, fonts, new DesignLocaleRules(), locales);
            CollectionAssert.AreEqual(new[] { "locale-zh-Hans" }, LocaleClasses(root));
            locales.Set("zh-Hant");
            CollectionAssert.AreEqual(new[] { "locale-en" }, LocaleClasses(root), "another script's twins could lack its glyphs");
            locales.Set("zh");
            CollectionAssert.AreEqual(new[] { "locale-zh-Hans" }, LocaleClasses(root), "no script given: the language's fonts");
        }

        /// <summary>A compiled screen root below the root: it carries its reference locale's class, inside a TemplateContainer.</summary>
        static VisualElement CompiledScreen(VisualElement root)
        {
            var container = new TemplateContainer();
            var screen = new VisualElement();
            screen.AddToClassList("locale-tr");
            screen.Add(new Label("text"));
            container.Add(screen);
            root.Add(container);
            return screen;
        }

        [UnityTest]
        public IEnumerator Rtl_IsAClassOnEveryScreenRoot_TheLayoutIsNotMirrored()
        {
            var root = Root();
            var screen = CompiledScreen(root);
            var row = new VisualElement();
            row.style.flexDirection = FlexDirection.Row;
            var a = new VisualElement { name = "a" };
            var b = new VisualElement { name = "b" };
            foreach (var x in new[] { a, b })
            {
                x.style.width = 100;
                x.style.height = 20;
                row.Add(x);
            }
            screen.Add(row);
            yield return null;
            var locales = new Locales("en");
            AdvancedText(AdvancedTextState.Off);
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), locales);
            Assert.IsFalse(root.ClassListContains(LocaleFontController.RtlClass));

            locales.Set("ar");
            Assert.IsTrue(root.ClassListContains(LocaleFontController.RtlClass));
            Assert.IsTrue(screen.ClassListContains(LocaleFontController.RtlClass), "the compiled .rtl rules sit on the screen root's class");
            Assert.AreNotEqual(LanguageDirection.RTL, root.languageDirection, "the generator is off: left to right, never reversed");
            yield return null;
            Assert.Less(a.layout.x, b.layout.x, "layout is not mirrored");

            locales.Set("en");
            Assert.IsFalse(root.ClassListContains(LocaleFontController.RtlClass));
            Assert.IsFalse(screen.ClassListContains(LocaleFontController.RtlClass));
        }

        [Test]
        public void TextSize_IsAClassOnEveryScreenRoot_OneAtATime_RemovedOnDispose()
        {
            var root = Root();
            var screen = CompiledScreen(root);
            var sizes = new Sizes("normal", 1f);
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("en"), sizes);
            Assert.IsTrue(root.ClassListContains("text-size-normal"));
            Assert.IsTrue(screen.ClassListContains("text-size-normal"), "a compiled screen's step rules need the class on its root");

            sizes.Set("large", 1.5f);
            Assert.IsTrue(screen.ClassListContains("text-size-large"));
            Assert.IsFalse(screen.ClassListContains("text-size-normal"), "one text-size class at a time");
            Assert.IsFalse(root.ClassListContains("text-size-normal"));
            Assert.AreEqual("large", _controller.TextSize);
            Assert.AreEqual(1.5f, _controller.TextScale);

            var later = CompiledScreen(root);
            _controller.Refresh();
            Assert.IsTrue(later.ClassListContains("text-size-large"));

            _controller.Dispose();
            _controller = null;
            Assert.IsFalse(screen.ClassListContains("text-size-large"), "disposing gives the design's sizes back");
            Assert.IsFalse(root.ClassListContains("text-size-large"));
            Assert.IsFalse(sizes.HasListeners);
        }

        [Test]
        public void TextSize_ThatTheScreensHaveNoRulesFor_IsReported()
        {
            var fonts = Set(("en", new FontAsset[0]));
            fonts.textSizes = new[] { new DesignTextSize { key = "large", scale = 1.25f } };
            var sizes = new Sizes("normal", 1f);
            _controller = new LocaleFontController(Root(), fonts, new DesignLocaleRules(), new Locales("en"), sizes);
            CollectionAssert.IsEmpty(_controller.Issues, string.Join("\n", _controller.Issues));

            LogAssert.Expect(LogType.Warning, new Regex("text size 'huge'"));
            sizes.Set("huge", 2f);
            Assert.AreEqual(1, _controller.Issues.Count, string.Join("\n", _controller.Issues));
            StringAssert.Contains("'huge'", _controller.Issues[0]);
            StringAssert.Contains("large (x1.25)", _controller.Issues[0], "names the compiled steps");

            LogAssert.Expect(LogType.Warning, new Regex("text size 'large' is x1.5"));
            sizes.Set("large", 1.5f);
            Assert.AreEqual(1, _controller.Issues.Count);
            StringAssert.Contains("compiled as x1.25", _controller.Issues[0]);

            sizes.Set("large", 1.25f);
            CollectionAssert.IsEmpty(_controller.Issues);
            sizes.Set("normal", 1f);
            CollectionAssert.IsEmpty(_controller.Issues, "the design's sizes need no rules");
        }

        [UnityTest]
        public IEnumerator Locale_ReachesCompiledScreenRootsBelowTheRoot()
        {
            var root = Root();
            VisualElement Compiled()
            {
                // a compiled screen carries its reference locale's class; cloned UXML sits in a TemplateContainer
                var container = new TemplateContainer();
                var screen = new VisualElement();
                screen.AddToClassList("locale-tr");
                screen.Add(new Label("text"));
                container.Add(screen);
                root.Add(container);
                return screen;
            }
            var first = Compiled();
            yield return null;
            var locales = new Locales("tr");
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), locales);
            locales.Set("en");
            CollectionAssert.AreEqual(new[] { "locale-en" }, LocaleClasses(first), "the nearest locale class decides the font variables");
            Assert.AreEqual("en", DesignFontSet.LocaleOf(first.Q<Label>()));

            var later = Compiled();
            for (int i = 0; i < 30 && !later.ClassListContains("locale-en"); i++) yield return null;
            CollectionAssert.AreEqual(new[] { "locale-en" }, LocaleClasses(later), "a screen added later follows the locale");
        }

        /// <summary>The controllers that hear about screens being attached (the controller's private registry).</summary>
        static IList LiveControllers() =>
            (IList)typeof(LocaleFontController).GetField("s_Live", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);

        /// <summary>A controller over a root that was attached and then detached, never disposed; only a weak reference survives.</summary>
        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
        static WeakReference DetachedAndDropped(VisualElement panelRoot)
        {
            var root = new VisualElement();
            panelRoot.Add(root);
            var controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("en"));
            Assert.IsTrue(LiveControllers().Contains(controller));
            root.RemoveFromHierarchy();
            return new WeakReference(controller);
        }

        [UnityTest]
        public IEnumerator Controller_IsListedOnlyWhileItsRootIsInAPanel_AndADetachedDroppedOneIsCollected()
        {
            var screen = Root();
            var panelRoot = screen.parent;
            var controller = new LocaleFontController(screen, null, new DesignLocaleRules(), new Locales("en"));
            try
            {
                Assert.IsTrue(LiveControllers().Contains(controller), "attached: it hears about screens");
                screen.RemoveFromHierarchy();
                Assert.IsFalse(LiveControllers().Contains(controller), "detached: no static list keeps it or its tree");
                var later = CompiledScreen(screen); // added while out of a panel
                panelRoot.Add(screen);
                Assert.IsTrue(LiveControllers().Contains(controller), "attached again");
                Assert.IsTrue(later.ClassListContains("locale-en"), "and it gives the screens it finds its classes at once");
            }
            finally { controller.Dispose(); }
            Assert.IsFalse(LiveControllers().Contains(controller), "disposed");

            var weak = DetachedAndDropped(panelRoot);
            yield return null;
            yield return null;
            for (int i = 0; i < 3 && weak.IsAlive; i++)
            {
                GC.Collect();
                GC.WaitForPendingFinalizers();
                yield return null;
            }
            Assert.IsFalse(weak.IsAlive, "a detached controller nobody holds is collected");
        }

        [UnityTest]
        public IEnumerator PerFrameTick_InSteadyState_AllocatesNothing()
        {
            var root = Root();
            CompiledScreen(root);
            root.Add(new Label("body"));
            yield return null;
            AdvancedText(AdvancedTextState.Off);
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("ar"), new Sizes("large", 1.5f));
            yield return null;
            _controller.Tick();
            Assert.That(() => _controller.Tick(), UnityEngine.TestTools.Constraints.Is.Not.AllocatingGCMemory(), "the per-frame check while RTL and a text size are active");
        }

        // ---- Arabic shaping on the real advanced generator --------------------------------------------------------

        const string ArabicFontPath = "/System/Library/Fonts/SFArabic.ttf";
        const string ArabicFolder = "Assets/DesignUiLocaleFixture";

        /// <summary>
        /// A dynamic font asset of the macOS Arabic system font, imported into a temporary folder: the advanced generator
        /// needs the font's source file (a font asset made from a file path alone has none).
        /// </summary>
        FontAsset ArabicFont()
        {
            if (!File.Exists(ArabicFontPath)) Assert.Ignore("no Arabic system font at " + ArabicFontPath + " (macOS)");
            if (!AssetDatabase.IsValidFolder(ArabicFolder)) AssetDatabase.CreateFolder("Assets", "DesignUiLocaleFixture");
            var path = ArabicFolder + "/SFArabic.ttf";
            File.Copy(ArabicFontPath, path, true);
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
            var font = AssetDatabase.LoadAssetAtPath<Font>(path);
            Assert.IsNotNull(font, "imported " + path);
            return Track(FontAsset.CreateFontAsset(font));
        }

        /// <summary>
        /// Switches UI Toolkit's "Enable Advanced Text" check for this Editor session only. The project setting itself is
        /// not touched: changing it rewrites every PanelSettings asset (AssetDatabase.SaveAssets), the package's included.
        /// </summary>
        sealed class AdvancedTextScope : IDisposable
        {
            static readonly FieldInfo Field = typeof(VisualElement).Assembly.GetType("UnityEngine.UIElements.TextUtilities")
                ?.GetField("IsAdvancedTextEnabled", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
            readonly object _previous;

            /// <summary>Whether this Unity version has the switch (6000.3 does; 6000.6 has none: the generator is always available).</summary>
            public static bool Available => Field != null && Field.FieldType == typeof(Func<bool>);

            public AdvancedTextScope(bool enabled)
            {
                if (!Available) return;
                _previous = Field.GetValue(null);
                Field.SetValue(null, (Func<bool>)(() => enabled));
            }

            public void Dispose()
            {
                if (Available) Field.SetValue(null, _previous);
            }
        }

        /// <summary>
        /// Project Settings > UI Toolkit > Enable Advanced Text switched on the way the settings window does it
        /// (<c>UIToolkitProjectSettings.enableAdvancedText</c>: Unity writes the ICU data into every PanelSettings asset and
        /// saves them), and back off with every file it wrote restored. Documents that exist while it is switched are
        /// rebuilt by Unity, so a test switches it before it makes its panel.
        /// </summary>
        sealed class ProjectAdvancedText : IDisposable
        {
            static readonly PropertyInfo Setting = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("UnityEditor.UIElements.UIToolkitProjectSettings"))
                .FirstOrDefault(t => t != null)?.GetProperty("enableAdvancedText", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            readonly Dictionary<string, byte[]> _files = new Dictionary<string, byte[]>();
            /// <summary>Each PanelSettings asset with the ICU data it had (the switch assigns it in memory and on disk).</summary>
            readonly List<(PanelSettings settings, Object icu)> _icu = new List<(PanelSettings, Object)>();
            readonly bool _was;
            readonly Action<bool> _set;

            public static bool Available => Setting != null && Setting.CanWrite;

            /// <param name="set">Switches the setting (the project setting itself by default; a test passes a stand-in).</param>
            public ProjectAdvancedText(bool on, Action<bool> set = null)
            {
                _set = set ?? (v => Setting.SetValue(null, v));
                foreach (var p in AssetDatabase.FindAssets("t:PanelSettings").Select(AssetDatabase.GUIDToAssetPath))
                {
                    var asset = AssetDatabase.LoadAssetAtPath<PanelSettings>(p);
                    if (asset != null) using (var so = new SerializedObject(asset)) _icu.Add((asset, so.FindProperty("m_ICUDataAsset")?.objectReferenceValue));
                }
                foreach (var p in AssetDatabase.FindAssets("t:PanelSettings").Select(AssetDatabase.GUIDToAssetPath).Concat(new[] { "ProjectSettings/UIToolkitProjectSettings.asset" }))
                    if (File.Exists(p)) _files[p] = File.ReadAllBytes(p);
                _was = set == null && (bool)Setting.GetValue(null);
                // a switch that fails midway may already have rewritten PanelSettings files: they are restored before it throws
                try { _set(on); }
                catch
                {
                    try { Restore(false); } catch (Exception e) { Debug.LogException(e); }
                    throw;
                }
            }

            public void Dispose() => Restore(true);

            /// <summary>Every step runs even when an earlier one throws; the first failure is thrown at the end.</summary>
            void Restore(bool setBack)
            {
                Exception first = null;
                void Step(Action a) { try { a(); } catch (Exception e) { first = first ?? e; } }
                if (setBack) Step(() => _set(_was));
                // the loaded assets first (a later save would write them again), then the files as they were
                foreach (var (settings, icu) in _icu)
                {
                    if (settings == null) continue;
                    Step(() =>
                    {
                        using (var so = new SerializedObject(settings))
                        {
                            var p = so.FindProperty("m_ICUDataAsset");
                            if (p != null && p.objectReferenceValue != icu)
                            {
                                p.objectReferenceValue = icu;
                                so.ApplyModifiedPropertiesWithoutUndo();
                                AssetDatabase.SaveAssetIfDirty(settings);
                            }
                        }
                    });
                }
                foreach (var kv in _files) Step(() => File.WriteAllBytes(kv.Key, kv.Value));
                foreach (var kv in _files) if (!kv.Key.StartsWith("ProjectSettings", StringComparison.Ordinal)) Step(() => AssetDatabase.ImportAsset(kv.Key, ImportAssetOptions.ForceUpdate));
                if (first != null) throw first;
            }
        }

        /// <summary>
        /// The setting-on helper restores every file it saw even when the switch fails midway (after Unity rewrote some
        /// PanelSettings files) and when a step of its own restore throws; the failure still surfaces. The switch here is a
        /// stand-in that rewrites a PanelSettings file of the test and throws.
        /// </summary>
        [Test]
        public void ProjectAdvancedText_RestoresEveryFile_WhenTheSwitchOrARestoreStepFails()
        {
            if (!AssetDatabase.IsValidFolder(ArabicFolder)) AssetDatabase.CreateFolder("Assets", "DesignUiLocaleFixture");
            var path = ArabicFolder + "/Switched.asset";
            var asset = ScriptableObject.CreateInstance<PanelSettings>();
            AssetDatabase.CreateAsset(asset, path);
            var before = File.ReadAllBytes(path);
            void Rewrite() => File.WriteAllText(path, "rewritten by the switch");
            Assert.Throws<InvalidOperationException>(() => new ProjectAdvancedText(true, on => { Rewrite(); throw new InvalidOperationException("switch failed"); }));
            CollectionAssert.AreEqual(before, File.ReadAllBytes(path), "a failed switch restores the files it may have rewritten");
            var calls = 0;
            var scope = new ProjectAdvancedText(true, on => { if (calls++ == 0) Rewrite(); else throw new InvalidOperationException("restore failed"); });
            Assert.Throws<InvalidOperationException>(scope.Dispose, "the restore's failure surfaces");
            CollectionAssert.AreEqual(before, File.ReadAllBytes(path), "the files come back although switching the setting back failed");
        }

        /// <summary>Ink per column of the lit pixels in rows [y0, y1), cropped to the ink and resampled to 64 bins (sum 1).</summary>
        static float[] InkProfile(Color32[] px, int width, int height, int y0, int y1)
        {
            var cols = new float[width];
            for (int y = y0; y < y1; y++)
                for (int x = 0; x < width; x++) cols[x] += px[(height - 1 - y) * width + x].r / 255f;
            int a = Array.FindIndex(cols, v => v > 0.5f), b = Array.FindLastIndex(cols, v => v > 0.5f);
            Assert.GreaterOrEqual(a, 0, "ink in rows " + y0 + "–" + y1);
            var bins = new float[64];
            for (int x = a; x <= b; x++) bins[Math.Min(63, (x - a) * 64 / (b - a + 1))] += cols[x];
            var sum = bins.Sum();
            for (int i = 0; i < bins.Length; i++) bins[i] /= sum;
            return bins;
        }

        static float Distance(float[] p, float[] q) => p.Zip(q, (x, y) => Math.Abs(x - y)).Sum();

        /// <summary>
        /// With the project setting on, a design screen's twins render Arabic through the locale controller as it should: the
        /// advanced generator shapes it, the RTL direction leaves digits in their order (2026, never 6202), and switching to a
        /// Latin locale gives the standard generator and left to right back. Twins are made the way kit sync makes them.
        /// </summary>
        [UnityTest]
        public IEnumerator ProjectSettingOn_ArabicTwinText_IsShaped_AndItsDigitsKeepTheirOrder()
        {
            if (!ProjectAdvancedText.Available) Assert.Ignore("this Unity version has no Enable Advanced Text project setting");
            if (!File.Exists(ArabicFontPath)) Assert.Ignore("no Arabic system font at " + ArabicFontPath + " (macOS)");
            if (!AssetDatabase.IsValidFolder(ArabicFolder)) AssetDatabase.CreateFolder("Assets", "DesignUiLocaleFixture");
            File.Copy(ArabicFontPath, ArabicFolder + "/SFArabic.ttf", true);
            AssetDatabase.ImportAsset(ArabicFolder + "/SFArabic.ttf", ImportAssetOptions.ForceSynchronousImport);
            var arabic = FontTwinGenerator.GetOrCreateTwin(FontFixture.CreateTmp(ArabicFolder + "/SFArabic.ttf", "Locale Arabic", folder: ArabicFolder), ArabicFolder + "/Twins");
            var latin = FontTwinGenerator.GetOrCreateTwin(FontFixture.CreateTmp(FontFixture.RegularTtf, "Locale Latin", folder: ArabicFolder), ArabicFolder + "/Twins");
            _advancedText = new ProjectAdvancedText(true); // before the panel exists: Unity rebuilds documents that exist while it switches
            LocaleFontController.AdvancedTextCheck = _advancedCheck; // Unity's own answer

            var root = Root();
            _settings.clearColor = true;
            _settings.colorClearValue = Color.black;
            yield return null;
            var locales = new Locales("ar");
            _controller = new LocaleFontController(root, Set(("tr", new[] { latin }), ("ar", new[] { arabic })), new DesignLocaleRules(), locales);
            Assert.IsTrue(_controller.UsesAdvancedText, "Unity's check says the generator is on: " + string.Join(" | ", _controller.Issues));
            Assert.AreEqual(LanguageDirection.RTL, root.languageDirection);

            Label Line(string text, int row, bool reference)
            {
                var l = new Label(text);
                l.style.position = Position.Absolute;
                l.style.left = 20;
                l.style.top = 60 * row;
                l.style.fontSize = 40;
                l.style.color = Color.white;
                if (reference)
                {
                    l.style.unityFontDefinition = FontDefinition.FromSDFFont(arabic);
                    l.style.unityTextGenerator = TextGeneratorType.Standard;
                    l.languageDirection = LanguageDirection.LTR;
                }
                root.Add(l);
                return l;
            }
            var salam = Line("سلام", 0, false);
            var digits = Line("2026", 1, false);
            Line("2026", 2, true);
            Line("6202", 3, true);
            var plain = Line("سلام", 4, true);
            int shapedGlyphs = -1, plainGlyphs = -1;
            salam.PostProcessTextVertices = g => shapedGlyphs = g.Count;
            plain.PostProcessTextVertices = g => plainGlyphs = g.Count;
            for (int i = 0; i < 20; i++)
            {
                root.Query<Label>().ForEach(l => l.MarkDirtyRepaint());
                yield return null;
            }
            Assert.AreEqual(TextGeneratorType.Advanced, digits.resolvedStyle.unityTextGenerator);
            Assert.AreSame(arabic, digits.resolvedStyle.unityFontDefinition.fontAsset, "the Arabic locale's twin");
            Assert.AreEqual(4, plainGlyphs, "the standard generator draws the four letters unshaped");
            Assert.AreEqual(3, shapedGlyphs, "the advanced generator shapes lam + alef into one glyph");

            var tex = Track(new Texture2D(_rt.width, _rt.height, TextureFormat.RGBA32, false, true));
            var active = RenderTexture.active;
            RenderTexture.active = _rt;
            tex.ReadPixels(new Rect(0, 0, _rt.width, _rt.height), 0, 0, false);
            tex.Apply(false);
            RenderTexture.active = active;
            var px = tex.GetPixels32();
            var shown = InkProfile(px, _rt.width, _rt.height, 60, 110);
            float toOrder = Distance(shown, InkProfile(px, _rt.width, _rt.height, 120, 170)), toReversed = Distance(shown, InkProfile(px, _rt.width, _rt.height, 180, 230));
            Assert.Less(toOrder, toReversed / 2, "2026 reads 2026 in the right-to-left paragraph (ink distance to 2026: " + toOrder + ", to 6202: " + toReversed + ")");

            locales.Set("tr");
            Assert.IsFalse(_controller.UsesAdvancedText, "a Latin locale keeps the standard generator");
            Assert.AreEqual(LanguageDirection.Inherit, root.languageDirection);
            yield return null;
            Assert.AreSame(latin, digits.resolvedStyle.unityFontDefinition.fontAsset);
        }

        [UnityTest]
        public IEnumerator Arabic_IsShapedByTheAdvancedGenerator()
        {
            var arabic = ArabicFont();
            _advancedText = new AdvancedTextScope(true); // a no-op where Unity has no switch
            {
                var root = Root();
                yield return null;
                var fonts = Set(("ar", new[] { arabic }));
                _controller = new LocaleFontController(root, fonts, new DesignLocaleRules(), new Locales("ar"));
                Assert.IsTrue(_controller.UsesAdvancedText, "Unity's own check says the generator is on");

                const string salam = "سلام"; // seen, lam, alef, meem: lam + alef shape into one ligature
                var shaped = new Label(salam);
                var plain = new Label(salam);
                plain.style.unityTextGenerator = TextGeneratorType.Standard;
                foreach (var l in new[] { shaped, plain })
                {
                    l.style.fontSize = 48;
                    root.Add(l);
                }
                int shapedGlyphs = -1, plainGlyphs = -1;
                shaped.PostProcessTextVertices = g => shapedGlyphs = g.Count;
                plain.PostProcessTextVertices = g => plainGlyphs = g.Count;
                for (int i = 0; i < 20 && (shapedGlyphs < 0 || plainGlyphs < 0); i++)
                {
                    shaped.MarkDirtyRepaint();
                    plain.MarkDirtyRepaint();
                    yield return null;
                }

                Assert.AreEqual(TextGeneratorType.Advanced, shaped.resolvedStyle.unityTextGenerator, "inherited from the screen root");
                Assert.AreSame(arabic, shaped.resolvedStyle.unityFontDefinition.fontAsset, "the locale's twin, inherited from the root");
                Assert.Greater(shapedGlyphs, 0, "a non-empty glyph run (standard: " + plainGlyphs + ", width " + shaped.layout.width + ")");
                Assert.AreEqual(4, plainGlyphs, "the standard generator draws the four letters unshaped");
                Assert.AreEqual(3, shapedGlyphs, "the advanced generator shapes lam + alef into one glyph");
                Assert.Greater(shaped.layout.width, 0f);
            }
        }
    }
}
