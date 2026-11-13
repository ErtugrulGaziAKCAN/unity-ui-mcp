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
    /// <see cref="LocaleFontController"/>: the screen root follows the selected locale (font twin, <c>locale-*</c> and
    /// <c>rtl</c> classes, advanced text generator for scripts that need shaping, start-aligned text flipped for RTL
    /// without mirroring the layout) and the game's text size (class and exact scaled sizes, with a report when a step
    /// leaves kit line boxes off whole device pixels at a declared viewport).
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
        Func<IPanel, bool> _advancedCheck;
        IDisposable _advancedText;

        [SetUp]
        public void Remember()
        {
            _advancedCheck = LocaleFontController.AdvancedTextCheck;
            _advancedText = new AdvancedTextScope(true); // Unity's own check (the controller's default) says "on" in these tests
        }

        [TearDown]
        public void Cleanup()
        {
            _controller?.Dispose();
            _controller = null;
            LocaleFontController.AdvancedTextCheck = _advancedCheck;
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            if (_rt != null) Object.DestroyImmediate(_rt);
            foreach (var o in _objects) if (o != null) Object.DestroyImmediate(o);
            _objects.Clear();
            _advancedText?.Dispose(); // after the panel's text is gone: its handles ask for the generator while they are released
            _advancedText = null;
            if (AssetDatabase.IsValidFolder(ArabicFolder)) AssetDatabase.DeleteAsset(ArabicFolder);
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
            Assert.AreEqual(LanguageDirection.RTL, root.languageDirection);
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

        [Test]
        public void AdvancedGenerator_Missing_IsReported_AndNotRequested()
        {
            var root = Root();
            LocaleFontController.AdvancedTextCheck = _ => false;
            LogAssert.Expect(LogType.Warning, new Regex("ar.*Enable Advanced Text"));
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("ar"));
            Assert.AreEqual(StyleKeyword.Null, root.style.unityTextGenerator.keyword,
                "not requested: Unity would log that the generator is disabled and render unshaped anyway");
            Assert.IsFalse(_controller.UsesAdvancedText);
            Assert.IsTrue(root.ClassListContains(LocaleFontController.RtlClass), "direction and alignment still follow the locale");
            Assert.AreEqual(1, _controller.Issues.Count);
            StringAssert.Contains("Enable Advanced Text", _controller.Issues[0]);
        }

        /// <summary>Labels with every kind of horizontal alignment and a row whose order must not change.</summary>
        static (Label inherited, Label middleLeft, Label center, Label right, Label gameInline, VisualElement a, VisualElement b) Texts(VisualElement root)
        {
            var inherited = new Label("inherited");          // the theme's upper-left, inherited
            var middleLeft = new Label("middle-left");
            middleLeft.style.unityTextAlign = TextAnchor.MiddleLeft;
            var center = new Label("center");
            center.style.unityTextAlign = TextAnchor.UpperCenter;
            var right = new Label("right");
            right.style.unityTextAlign = TextAnchor.UpperRight;
            var gameInline = new Label("game inline");
            gameInline.style.unityTextAlign = TextAnchor.LowerLeft;
            foreach (var l in new[] { inherited, middleLeft, center, right, gameInline })
            {
                l.style.width = 300;
                root.Add(l);
            }
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
            root.Add(row);
            return (inherited, middleLeft, center, right, gameInline, a, b);
        }

        [UnityTest]
        public IEnumerator Rtl_FlipsStartAlignedText_KeepsCenteredAndEndAligned_DoesNotMirrorLayout()
        {
            var root = Root();
            var t = Texts(root);
            yield return null;
            yield return null;
            Assert.AreEqual(TextAnchor.UpperLeft, t.inherited.resolvedStyle.unityTextAlign, "precondition: the runtime theme starts text at the left");
            var locales = new Locales("en");
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), locales);

            locales.Set("ar");
            yield return null;
            Assert.AreEqual(TextAnchor.UpperRight, t.inherited.resolvedStyle.unityTextAlign);
            Assert.AreEqual(TextAnchor.MiddleRight, t.middleLeft.resolvedStyle.unityTextAlign);
            Assert.AreEqual(TextAnchor.UpperCenter, t.center.resolvedStyle.unityTextAlign);
            Assert.AreEqual(TextAnchor.UpperRight, t.right.resolvedStyle.unityTextAlign, "start-aligned flips; end-aligned stays (profile rule)");
            Assert.AreEqual(TextAnchor.LowerRight, t.gameInline.resolvedStyle.unityTextAlign);
            Assert.Less(t.a.layout.x, t.b.layout.x, "layout is not mirrored");

            var late = new Label("added later");
            root.Add(late);
            for (int i = 0; i < 30 && late.resolvedStyle.unityTextAlign != TextAnchor.UpperRight; i++) yield return null;
            Assert.AreEqual(TextAnchor.UpperRight, late.resolvedStyle.unityTextAlign, "text added while RTL is shown flips too (within frames)");

            locales.Set("en");
            yield return null;
            Assert.AreEqual(TextAnchor.UpperLeft, t.inherited.resolvedStyle.unityTextAlign);
            Assert.AreEqual(StyleKeyword.Null, t.inherited.style.unityTextAlign.keyword, "the inline value it had (none) comes back");
            Assert.AreEqual(TextAnchor.MiddleLeft, t.middleLeft.resolvedStyle.unityTextAlign);
            Assert.AreEqual(TextAnchor.LowerLeft, t.gameInline.style.unityTextAlign.value, "a game's own inline alignment comes back");
            Assert.AreEqual(TextAnchor.UpperLeft, late.resolvedStyle.unityTextAlign);

            locales.Set("ar");
            locales.Set("en");
            locales.Set("he"); // several switches before a style pass: the design alignment is remembered, never re-read from a flip
            yield return null;
            Assert.AreEqual(TextAnchor.UpperRight, t.inherited.resolvedStyle.unityTextAlign);
            Assert.AreEqual(TextAnchor.UpperCenter, t.center.resolvedStyle.unityTextAlign);
        }

        [UnityTest]
        public IEnumerator Rtl_AlignmentRules_MirrorAndKeep()
        {
            var root = Root();
            var t = Texts(root);
            yield return null;
            yield return null;
            var locales = new Locales("ar");
            _controller = new LocaleFontController(root, null, new DesignLocaleRules { rtlAlignment = RtlTextAlignment.Mirror }, locales);
            yield return null;
            Assert.AreEqual(TextAnchor.UpperRight, t.inherited.resolvedStyle.unityTextAlign);
            Assert.AreEqual(TextAnchor.UpperLeft, t.right.resolvedStyle.unityTextAlign, "mirror: end-aligned goes to the left");
            Assert.AreEqual(TextAnchor.UpperCenter, t.center.resolvedStyle.unityTextAlign);
            _controller.Dispose();
            yield return null;
            Assert.AreEqual(TextAnchor.UpperLeft, t.inherited.resolvedStyle.unityTextAlign, "disposing restores the design alignment");

            _controller = new LocaleFontController(root, null, new DesignLocaleRules { rtlAlignment = RtlTextAlignment.Keep }, locales);
            yield return null;
            Assert.AreEqual(TextAnchor.UpperLeft, t.inherited.resolvedStyle.unityTextAlign, "keep: nothing flips");
            Assert.IsTrue(root.ClassListContains(LocaleFontController.RtlClass));
        }

        [UnityTest]
        public IEnumerator TextSize_SetsTheClass_AndScalesTextExactly()
        {
            var root = Root();
            var body = new Label("body");
            body.style.fontSize = 24;
            var caption = new Label("caption");
            caption.style.fontSize = 12;
            root.Add(body);
            root.Add(caption);
            yield return null;
            yield return null;
            var sizes = new Sizes("normal", 1f);
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("en"), sizes);
            Assert.IsTrue(root.ClassListContains("text-size-normal"));

            sizes.Set("large", 1.5f);
            yield return null;
            Assert.IsTrue(root.ClassListContains("text-size-large"));
            Assert.IsFalse(root.ClassListContains("text-size-normal"), "one text-size class at a time");
            Assert.AreEqual(36f, body.resolvedStyle.fontSize, 1e-4f);
            Assert.AreEqual(18f, caption.resolvedStyle.fontSize, 1e-4f);
            Assert.AreEqual(1.5f, _controller.TextScale);

            var late = new Label("added later");
            late.style.fontSize = 16;
            root.Add(late);
            for (int i = 0; i < 30 && Math.Abs(late.resolvedStyle.fontSize - 24f) > 1e-4f; i++) yield return null;
            Assert.AreEqual(24f, late.resolvedStyle.fontSize, 1e-4f, "text added later scales too (within frames)");

            sizes.Set("normal", 1f);
            yield return null;
            Assert.AreEqual(24f, body.resolvedStyle.fontSize, 1e-4f, "back to the design size");
            Assert.AreEqual(24f, body.style.fontSize.value.value, 1e-4f, "the inline size it had comes back");
            Assert.AreEqual(12f, caption.resolvedStyle.fontSize, 1e-4f);
            Assert.AreEqual(16f, late.resolvedStyle.fontSize, 1e-4f);
        }

        [UnityTest]
        public IEnumerator TextSize_ThatLeavesKitLineBoxesOffWholeDevicePixels_IsReported_NotRounded()
        {
            FontFixture.RequireInter();
            var root = Root();
            FontAsset plain = Inter("en twin"), box = LineBox("en r125", 1.25f);
            var fonts = Set(("en", new[] { plain, box }));
            var label = new Label("label 16/20");
            label.style.fontSize = 16;
            label.style.unityFontDefinition = FontDefinition.FromSDFFont(box);
            root.Add(label);
            yield return null;
            yield return null;
            var sizes = new Sizes("normal", 1f);
            _controller = new LocaleFontController(root, fonts, new DesignLocaleRules(), new Locales("en"), sizes, new[] { 1f, 0.75f, 0.5f });

            sizes.Set("x2", 2f); // 32/40: 24/30 and 16/20 device px — whole everywhere
            yield return null;
            CollectionAssert.IsEmpty(_controller.Issues, string.Join("\n", _controller.Issues));

            LogAssert.Expect(LogType.Warning, new Regex("text size 'large'"));
            sizes.Set("large", 1.25f); // 20/25: line 18.75 device px at 0.75, 12.5 at 0.5
            yield return null;
            Assert.AreEqual(20f, label.resolvedStyle.fontSize, 1e-4f, "applied exactly, not rounded");
            Assert.AreEqual(1, _controller.Issues.Count, string.Join("\n", _controller.Issues));
            StringAssert.Contains("text size 'large'", _controller.Issues[0]);
            StringAssert.Contains("0.75", _controller.Issues[0]);
            StringAssert.Contains("18.75", _controller.Issues[0]);

            sizes.Set("normal", 1f);
            yield return null;
            CollectionAssert.IsEmpty(_controller.Issues, "the design sizes are whole by the kit's table");
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

        [UnityTest]
        public IEnumerator PerFramePass_InSteadyState_AllocatesNothing()
        {
            var root = Root();
            Texts(root);
            var body = new Label("body");
            body.style.fontSize = 24;
            root.Add(body);
            yield return null;
            yield return null;
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new Locales("ar"), new Sizes("large", 1.5f));
            yield return null;
            _controller.Tick();
            Assert.That(() => _controller.Tick(), UnityEngine.TestTools.Constraints.Is.Not.AllocatingGCMemory(), "the per-frame pass while RTL and a text size are active");
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

            public AdvancedTextScope(bool enabled)
            {
                if (Field == null) Assert.Inconclusive("UnityEngine.UIElements.TextUtilities.IsAdvancedTextEnabled not found in this Unity version");
                _previous = Field.GetValue(null);
                Field.SetValue(null, (Func<bool>)(() => enabled));
            }

            public void Dispose() => Field.SetValue(null, _previous);
        }

        [UnityTest]
        public IEnumerator Arabic_IsShapedByTheAdvancedGenerator()
        {
            var arabic = ArabicFont();
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
