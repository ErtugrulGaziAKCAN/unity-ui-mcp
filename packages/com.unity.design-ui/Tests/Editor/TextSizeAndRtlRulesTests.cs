using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using static DesignUi.Editor.Tests.TestIr;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// Text-size steps and right-to-left alignment are compiled USS rules under a screen-root class
    /// (<c>.text-size-&lt;key&gt;</c>, <c>.rtl</c>): every rule that sets a size or an alignment gets a twin under the class,
    /// so state and class layers keep working; the locale controller only swaps the classes.
    /// </summary>
    public class TextSizeAndRtlRulesTests
    {
        const string Out = "Assets/DesignUiTextSizeRulesTests";
        const string StylesJson = "{ \"label\": { \"fontSize\": 16, \"lineHeight\": 20, \"weight\": 400 }, \"body\": { \"fontSize\": 24, \"lineHeight\": 32, \"weight\": 400 } }";

        static readonly Dictionary<string, double> Sizes = new Dictionary<string, double> { { "label", 16 }, { "body", 24 } };

        readonly List<string> _temp = new List<string>();
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;
        LocaleFontController _controller;
        Func<IPanel, AdvancedTextState> _advancedCheck;

        [SetUp]
        public void Remember() => _advancedCheck = LocaleFontController.AdvancedTextCheck;

        [TearDown]
        public void Cleanup()
        {
            _controller?.Dispose();
            _controller = null;
            LocaleFontController.AdvancedTextCheck = _advancedCheck;
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            if (_rt != null) Object.DestroyImmediate(_rt);
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
        }

        [OneTimeTearDown]
        public void DeleteFonts() => FontFixture.Delete();

        static ScreenBuildOptions Options(DesignUi.RtlTextAlignment? rtl = null, params DesignTextSize[] steps) => new ScreenBuildOptions
        {
            TextStyleSizes = Sizes,
            TextStyleLineBoxes = new Dictionary<string, string>
            {
                { "label", FontTwinGenerator.LineBox.KeyOf(16, 20) }, { "body", FontTwinGenerator.LineBox.KeyOf(24, 32) },
            },
            LineBoxes = FontTwinGenerator.LineBox.Of(new[] { (16.0, 20.0), (24.0, 32.0) }),
            TextSizes = steps,
            RtlAlignment = rtl,
            Viewports = new[] { (new Vector2Int(2560, 1440), 1.0), (new Vector2Int(1920, 1080), 0.75), (new Vector2Int(1280, 720), 0.5) },
        };

        static IrNode Styled(string id, string tr, string style, params (string k, string v)[] css)
        {
            var t = Text(id, tr, css.Concat(new[] { ("font-family", "Inter"), ("font-size", style == "label" ? "16px" : "24px"), ("color", "#ffffff") }).ToArray());
            t.Text.Style = style;
            return t;
        }

        static CompiledScreen Build(IrNode root, ScreenBuildOptions options) => ScreenBuilder.Build(TestIr.Screen(root), options, RelativeAsset, null);

        static string Cls(CompiledScreen s, string name) => s.Find(name).Classes.Single(c => c.StartsWith("s-", StringComparison.Ordinal));

        static UssRule Rule(CompiledScreen s, string selector)
        {
            var rules = s.Rules.Where(r => r.Selector == selector).ToList();
            Assert.AreEqual(1, rules.Count, "one rule '" + selector + "' in:\n" + UssWriter.Write(s));
            return rules[0];
        }

        static string Decl(UssRule r, string property) => r.Declarations.Single(d => d.Property == property).Value;

        // ---- the rules --------------------------------------------------------------------------------------------------

        [Test]
        public void Steps_TwinEveryRuleThatSetsASize_UnderTheStepsRootClass()
        {
            var t = Styled("t", "Metin", "label").With("state:loading", ("font-size", "24px")).With("hover", ("color", "#ff0000"));
            var s = Build(Root(t), Options(null, new DesignTextSize { key = "large", scale = 1.5f }, new DesignTextSize { key = "normal", scale = 1f }));
            var cls = Cls(s, "t");
            var base_ = Rule(s, ".text-size-large ." + cls);
            Assert.AreEqual("24px", Decl(base_, "font-size"), "16 px x 1.5");
            Assert.AreEqual("var(--font-inter-" + FontTwinGenerator.LineBox.KeyOf(24, 30) + ")", Decl(base_, "-unity-font-definition"), "the scaled line box's twin");
            Assert.AreEqual("36px", Decl(Rule(s, ".text-size-large.state-loading ." + cls), "font-size"), "the state layer's size, scaled: the state keeps working under the step");
            Assert.IsFalse(s.Rules.Any(r => r.Selector.Contains(".text-size-large") && r.Selector.EndsWith(":hover", StringComparison.Ordinal)), "a layer that sets no size needs no twin");
            Assert.IsFalse(s.Rules.Any(r => r.Selector.Contains(".text-size-normal")), "a step of scale 1 is the design: no rules");
            var uss = UssWriter.Write(s);
            Assert.Less(uss.IndexOf("." + cls + " {", StringComparison.Ordinal), uss.IndexOf(".text-size-large ." + cls, StringComparison.Ordinal), "twins follow the element's rules");
        }

        [Test]
        public void Steps_TwinALayerThatSwitchesTheLineBoxFont_EvenWithoutASize()
        {
            // the hover layer names the family again (another face of it): its line-box variable must be scaled too, or the
            // base twin (one class more than .s-t, later) wins over it under a step
            var t = Styled("t", "Metin", "label").With("hover", ("font-family", "Inter"));
            var s = Build(Root(t), Options(null, new DesignTextSize { key = "large", scale = 1.5f }));
            var cls = Cls(s, "t");
            Assert.That(Decl(Rule(s, "." + cls + ":hover"), "-unity-font-definition"), Does.Contain(FontTwinGenerator.LineBox.KeyOf(16, 20)), "fixture");
            var twin = Rule(s, ".text-size-large ." + cls + ":hover");
            Assert.AreEqual("var(--font-inter-" + FontTwinGenerator.LineBox.KeyOf(24, 30) + ")", Decl(twin, "-unity-font-definition"));
            Assert.IsFalse(twin.Declarations.Any(d => d.Property == "font-size"), "the layer sets no size; the base twin's applies");
        }

        [Test]
        public void Steps_WithAFloatScale_WriteTheDecimalSize()
        {
            var s = Build(Root(Styled("t", "Metin", "label")), Options(null, new DesignTextSize { key = "large", scale = 1.1f }));
            var twin = Rule(s, ".text-size-large ." + Cls(s, "t"));
            Assert.AreEqual("17.6px", Decl(twin, "font-size"), "16 x 1.1, not the float's binary expansion");
            Assert.AreEqual("var(--font-inter-" + FontTwinGenerator.LineBox.KeyOf(17.6, 22) + ")", Decl(twin, "-unity-font-definition"));
            CollectionAssert.Contains(ScreenCompiler.ScaledLineBoxes(FontTwinGenerator.LineBox.Of(new[] { (16.0, 20.0) }), new[] { new DesignTextSize { key = "large", scale = 1.1f } })
                .Select(b => b.Key).ToArray(), FontTwinGenerator.LineBox.KeyOf(17.6, 22), "the twin the compiler makes has the same key");
        }

        [Test]
        public void Steps_ThatAreNotWholeDevicePixelsAtAViewport_AreNoted()
        {
            var s = Build(Root(Styled("t", "Metin", "label")), Options(null, new DesignTextSize { key = "large", scale = 1.25f }, new DesignTextSize { key = "x2", scale = 2f }));
            Assert.AreEqual(1, s.Notes.Count, string.Join("\n", s.Notes));
            StringAssert.Contains("'large'", s.Notes[0]);
            StringAssert.Contains("20/25 px", s.Notes[0]);
            StringAssert.Contains("15/18.75 device px at 1920x1080", s.Notes[0], "the first viewport where it is not whole");
        }

        [TestCase("Large")]
        [TestCase("x 2")]
        [TestCase("")]
        public void Steps_WithAKeyThatIsNotAClass_AreErrors(string key)
        {
            var e = Assert.Throws<IrFormatException>(() => Build(Root(Styled("t", "Metin", "label")), Options(null, new DesignTextSize { key = key, scale = 2f })));
            StringAssert.Contains("text size", e.Message);
        }

        [Test]
        public void Rtl_TwinsEveryRuleThatSetsAnAlignment_AndTheRootFlipsTheInheritedStart()
        {
            var start = Styled("start", "Başla", "label", ("text-align", "left")).With("hover", ("text-align", "center"));
            var ends = Styled("ends", "Son", "label", ("text-align", "right"));
            var s = Build(Root(start, ends), Options(DesignUi.RtlTextAlignment.StartToEnd));
            Assert.AreEqual("upper-right", Decl(Rule(s, ".rtl ." + Cls(s, "start")), "-unity-text-align"), "start-aligned text goes to the end");
            Assert.AreEqual("upper-center", Decl(Rule(s, ".rtl ." + Cls(s, "start") + ":hover"), "-unity-text-align"),
                "the hover layer's twin, so the hover keeps beating the base twin");
            Assert.AreEqual("upper-right", Decl(Rule(s, ".rtl ." + Cls(s, "ends")), "-unity-text-align"), "end-aligned text stays");
            Assert.AreEqual("upper-right", Decl(Rule(s, "." + Cls(s, "root") + ".rtl"), "-unity-text-align"), "text without an alignment of its own inherits the root's");

            var mirrored = Build(Root(Styled("start", "Başla", "label", ("text-align", "left")), Styled("ends", "Son", "label", ("text-align", "right"))),
                Options(DesignUi.RtlTextAlignment.Mirror));
            Assert.AreEqual("upper-left", Decl(Rule(mirrored, ".rtl ." + Cls(mirrored, "ends")), "-unity-text-align"), "mirror: end-aligned goes to the left");

            var kept = Build(Root(Styled("start", "Başla", "label", ("text-align", "left"))), Options(DesignUi.RtlTextAlignment.Keep));
            Assert.IsFalse(kept.Rules.Any(r => r.Selector.Contains(".rtl")), "keep: no rules");
        }

        [Test]
        public void Rtl_TheRootFlipsTheInheritedStart_WhenOnlyAStateLayerOfItAligns()
        {
            var root = Styled("root", "Kök", "label", ("width", "100%")).With("state:loading", ("text-align", "center"));
            var s = Build(root, Options(DesignUi.RtlTextAlignment.StartToEnd));
            var cls = Cls(s, "root");
            Assert.AreEqual("upper-center", Decl(Rule(s, "." + cls + ".rtl.state-loading"), "-unity-text-align"));
            Assert.AreEqual("upper-right", Decl(Rule(s, "." + cls + ".rtl"), "-unity-text-align"), "the default state still flips the inherited start");
        }

        // ---- the compiler -----------------------------------------------------------------------------------------------

        string Export(IrNode root)
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-textsize-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(TestIr.Screen(root, "text.sizes"), Formatting.Indented));
            File.WriteAllText(Path.Combine(dir, KitTextStyles.FileName), StylesJson);
            return dir;
        }

        CompileResult Compile(IrNode root, params DesignTextSize[] steps)
        {
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            profile.outputFolder = Out;
            profile.textSizes = steps;
            FontFixture.Use(profile);
            var result = ScreenCompiler.Compile(Export(root), profile, false, NoView());
            Object.DestroyImmediate(profile);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            return result;
        }

        [Test]
        public void Compile_WritesTheScaledTwinsAndVariables_RecordsTheSteps_AndNotesInexactOnes()
        {
            var result = Compile(Root(Styled("t", "Metin", "label")), new DesignTextSize { key = "large", scale = 1.5f });
            var key = FontTwinGenerator.LineBox.KeyOf(24, 30);
            StringAssert.Contains("--font-inter-" + key + ": url(", File.ReadAllText(Out + "/" + FontMap.FileName), "DesignFonts.uss defines the scaled line box's variable");
            Assert.IsNotNull(AssetDatabase.LoadAssetAtPath<FontAsset>(FontFixture.TwinFolder + "/Inter Fixture UITK " + key + ".asset"), "and its twin exists");
            var set = AssetDatabase.LoadAssetAtPath<DesignFontSet>(Out + "/" + DesignFontSet.FileName);
            Assert.AreEqual(1, set.textSizes.Length);
            Assert.AreEqual("large", set.textSizes[0].key);
            Assert.AreEqual(1.5f, set.textSizes[0].scale);
            CollectionAssert.Contains(set.FontsFor("tr").Select(AssetDatabase.GetAssetPath).ToArray(), FontTwinGenerator.TwinPath(FontFixture.Regular, FontFixture.TwinFolder,
                FontTwinGenerator.LineBox.For(24, 30)), "bound text is prepared in the scaled twin too");
            Assert.IsTrue(result.Notes.Any(n => n.Contains("'large'") && n.Contains("22.5")), "30 px lines are 22.5 device px at 0.75:\n" + string.Join("\n", result.Notes));
        }

        // ---- on a panel -------------------------------------------------------------------------------------------------

        VisualElement Mount()
        {
            _rt = new RenderTexture(640, 360, 24);
            _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _go = new GameObject("TextSizeAndRtlRulesTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/TextSizes/TextSizes.uxml").Instantiate();
            doc.rootVisualElement.Add(tree);
            return doc.rootVisualElement;
        }

        static IEnumerator Frames(int n)
        {
            for (int i = 0; i < n; i++) yield return null;
        }

        [UnityTest]
        public IEnumerator AStateThatChangesASize_KeepsWorkingUnderATextSizeStep()
        {
            var t = Styled("t", "Metin", "label", ("align-self", "flex-start")).With("state:loading", ("font-size", "24px"));
            Compile(Root(t), new DesignTextSize { key = "large", scale = 1.5f });
            var root = Mount();
            yield return Frames(2);
            var label = root.Q<Label>("t");
            var screen = root.Q("root");
            Assert.AreEqual(16f, label.resolvedStyle.fontSize, 1e-4f);
            var sizes = new LocaleFontControllerTests.Sizes("normal", 1f);
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), new LocaleFontControllerTests.Locales("tr"), sizes);

            sizes.Set("large", 1.5f);
            yield return Frames(2);
            Assert.AreEqual(24f, label.resolvedStyle.fontSize, 1e-4f, "16 x 1.5");
            var variant = FontTwinGenerator.TwinPath(FontFixture.Regular, FontFixture.TwinFolder, FontTwinGenerator.LineBox.For(24, 30));
            Assert.AreEqual(variant, AssetDatabase.GetAssetPath(label.resolvedStyle.unityFontDefinition.fontAsset), "with the scaled line box's twin");

            screen.AddToClassList("state-loading");
            yield return Frames(2);
            Assert.AreEqual(36f, label.resolvedStyle.fontSize, 1e-4f, "the state's 24 px, scaled");

            sizes.Set("normal", 1f);
            yield return Frames(2);
            Assert.AreEqual(24f, label.resolvedStyle.fontSize, 1e-4f, "the state's own size again");
            screen.RemoveFromClassList("state-loading");
            yield return Frames(2);
            Assert.AreEqual(16f, label.resolvedStyle.fontSize, 1e-4f);
        }

        [UnityTest]
        public IEnumerator RightToLeft_FlipsStartAlignedText_ThroughTheClass_AndStateLayersKeepWorking()
        {
            LocaleFontController.AdvancedTextCheck = _ => AdvancedTextState.Off; // no generator request in this Editor's project
            var start = Styled("start", "Başla", "label", ("text-align", "left"), ("width", "200px"));
            var plain = Styled("plain", "Düz", "label", ("width", "200px"));
            var centered = Styled("centered", "Orta", "label", ("text-align", "center"), ("width", "200px"));
            var ends = Styled("ends", "Son", "label", ("text-align", "right"), ("width", "200px"));
            var stateful = Styled("stateful", "Durum", "label", ("text-align", "left"), ("width", "200px")).With("state:loading", ("text-align", "center"));
            Compile(Root(start, plain, centered, ends, stateful));
            var root = Mount();
            yield return Frames(2);
            Label L(string id) => root.Q<Label>(id);
            var locales = new LocaleFontControllerTests.Locales("en");
            _controller = new LocaleFontController(root, null, new DesignLocaleRules(), locales);
            yield return Frames(2);
            Assert.AreEqual(TextAnchor.UpperLeft, L("start").resolvedStyle.unityTextAlign);
            Assert.AreEqual(TextAnchor.UpperLeft, L("plain").resolvedStyle.unityTextAlign);

            locales.Set("ar");
            yield return Frames(2);
            Assert.AreEqual(TextAnchor.UpperRight, L("start").resolvedStyle.unityTextAlign, "start-aligned text goes to the end");
            Assert.AreEqual(TextAnchor.UpperRight, L("plain").resolvedStyle.unityTextAlign, "so does text that inherits the start alignment");
            Assert.AreEqual(TextAnchor.UpperCenter, L("centered").resolvedStyle.unityTextAlign);
            Assert.AreEqual(TextAnchor.UpperRight, L("ends").resolvedStyle.unityTextAlign);
            Assert.AreEqual(TextAnchor.UpperRight, L("stateful").resolvedStyle.unityTextAlign);
            root.Q("root").AddToClassList("state-loading");
            yield return Frames(2);
            Assert.AreEqual(TextAnchor.UpperCenter, L("stateful").resolvedStyle.unityTextAlign, "the state's alignment still applies in RTL");
            Assert.AreEqual(L("start").layout.x, L("plain").layout.x, "the layout is not mirrored");

            locales.Set("en");
            yield return Frames(2);
            Assert.AreEqual(TextAnchor.UpperLeft, L("start").resolvedStyle.unityTextAlign);
            Assert.AreEqual(TextAnchor.UpperLeft, L("plain").resolvedStyle.unityTextAlign);
            Assert.AreEqual(TextAnchor.UpperCenter, L("stateful").resolvedStyle.unityTextAlign);
        }
    }
}
