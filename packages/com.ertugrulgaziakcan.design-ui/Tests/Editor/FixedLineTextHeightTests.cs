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
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// Drift-free stacked text (docs/findings/viewport-classes.md): UI Toolkit rounds a text element's measured height up to
    /// whole device pixels, so where a line box is a fraction of a device pixel (16/20 at 1600×900: 12.5 px) each text is up to
    /// a pixel taller than the design's and a column of them drifts. A text whose line count the design fixes (no wrapping)
    /// and whose height is its content's gets an explicit height of lines × line box plus its vertical padding and borders;
    /// wrapping text keeps its measured height.
    /// </summary>
    public class FixedLineTextHeightTests
    {
        const string Out = "Assets/DesignUiFixedLineTextHeightTests";
        static readonly Dictionary<string, double> Sizes = new Dictionary<string, double> { { "label", 16 }, { "caption", 12 } };

        readonly List<string> _temp = new List<string>();
        readonly List<Object> _objects = new List<Object>();
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            if (_rt != null) Object.DestroyImmediate(_rt);
            foreach (var o in _objects) if (o != null) Object.DestroyImmediate(o);
            _objects.Clear();
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
            FontFixture.Delete();
        }

        static ScreenBuildOptions Options(params DesignTextSize[] steps) => new ScreenBuildOptions
        {
            TextStyleSizes = Sizes,
            TextStyleLineBoxes = new Dictionary<string, string> { { "label", FontTwinGenerator.LineBox.KeyOf(16, 20) }, { "caption", FontTwinGenerator.LineBox.KeyOf(12, 16) } },
            LineBoxes = FontTwinGenerator.LineBox.Of(new[] { (16.0, 20.0), (12.0, 16.0) }),
            TextSizes = steps,
        };

        /// <summary>A text in the kit style label (16/20), no wrapping unless <paramref name="wrap"/>.</summary>
        static IrNode Label(string id, string tr, bool wrap = false, params (string k, string v)[] css)
        {
            var t = Text(id, tr, css.Concat(new[] { ("font-family", "Inter"), ("font-size", "16px"), ("color", "#ffffff"), ("text-wrap-mode", wrap ? "wrap" : "nowrap") }).ToArray());
            t.Text.Style = "label";
            return t;
        }

        static CompiledScreen Build(IrNode root, ScreenBuildOptions options = null) => ScreenBuilder.Build(TestIr.Screen(root), options ?? Options(), RelativeAsset, null);

        static string Cls(CompiledScreen s, string name) => s.Find(name).Classes.Single(c => c.StartsWith("s-", StringComparison.Ordinal));

        /// <summary>The height a rule of the element writes, or null.</summary>
        static string Height(CompiledScreen s, string name, string suffix = "", string rootClass = null)
        {
            var selector = (rootClass != null ? rootClass + " " : "") + "." + Cls(s, name) + suffix;
            var rule = s.Rules.SingleOrDefault(r => r.Selector == selector);
            Assert.IsNotNull(rule, "rule '" + selector + "' in:\n" + UssWriter.Write(s));
            return rule.Declarations.Where(d => d.Property == "height").Select(d => d.Value).SingleOrDefault();
        }

        [Test]
        public void NoWrapText_InAColumn_IsLinesTimesTheLineBoxPlusPaddingAndBorders()
        {
            var s = Build(Root(
                Label("one", "Işık"),
                Label("two", "Işık\nGol"),
                Label("padded", "Işık", false, ("padding-top", "4px"), ("padding-bottom", "8px"), ("border-top-width", "4px"), ("border-top-style", "solid"), ("border-bottom-width", "4px")),
                Label("wraps", "Uzun bir paragraf", true)));
            Assert.AreEqual("20px", Height(s, "one"));
            Assert.AreEqual("40px", Height(s, "two"), "its lines are its explicit breaks");
            Assert.AreEqual("36px", Height(s, "padded"), "20 + 4 + 8 + the top border; the bottom border has no style, so no width");
            Assert.IsNull(Height(s, "wraps"), "wrapping text keeps its measured height");
        }

        [Test]
        public void NoWrapText_ThatIsSizedGrownOrStretched_KeepsItsLayout()
        {
            var row = Node("row", "container", ("display", "flex"), ("flex-direction", "row")).Add(Label("stretched", "Işık"), Label("self", "Işık", false, ("align-self", "center")));
            var aligned = Node("aligned", "container", ("display", "flex"), ("flex-direction", "row"), ("align-items", "center")).Add(Label("centred", "Işık"), Label("selfStretch", "Işık", false, ("align-self", "stretch")));
            var abs = Node("abs", "container", ("position", "relative")).Add(
                Label("pinned", "Işık", false, ("position", "absolute"), ("top", "0px"), ("bottom", "0px")),
                Label("top", "Işık", false, ("position", "absolute"), ("top", "8px")));
            var s = Build(Root(
                Label("grows", "Işık", false, ("flex-grow", "1")),
                Label("sized", "Işık", false, ("height", "48px")),
                Label("min", "Işık", false, ("min-height", "48px")),
                Label("lines", "Işık\nGol").With("hover", ("color", "#ff0000")),
                row, aligned, abs));
            Assert.IsNull(Height(s, "grows"), "flex-grow in a column");
            Assert.AreEqual("48px", Height(s, "sized"), "its own height");
            Assert.IsNull(Height(s, "min"), "a min-height can make it taller");
            Assert.AreEqual("40px", Height(s, "lines"));
            Assert.IsNull(Height(s, "stretched"), "a row stretches its items by default");
            Assert.AreEqual("20px", Height(s, "self"), "aligned by itself");
            Assert.AreEqual("20px", Height(s, "centred"), "aligned by the row");
            Assert.IsNull(Height(s, "selfStretch"));
            Assert.IsNull(Height(s, "pinned"), "absolute between top and bottom");
            Assert.AreEqual("20px", Height(s, "top"));
        }

        [Test]
        public void NoWrapText_ALayerThatChangesSizeOrPadding_WritesItsHeight_AndATextSizeStepScalesTheLineBox()
        {
            var t = Label("t", "Işık", false, ("padding-top", "4px"))
                .With("hover", ("padding-top", "8px"))
                .With("state:loading", ("font-size", "12px"))
                .With("active", ("color", "#ff0000"));
            var s = Build(Root(t), Options(new DesignTextSize { key = "large", scale = 1.5f }));
            Assert.AreEqual("24px", Height(s, "t"));
            Assert.AreEqual("28px", Height(s, "t", ":hover"));
            Assert.AreEqual("19px", Height(s, "t", "", ".state-loading"), "12 px in the label style's 5:4 line box: 15 + 4");
            Assert.IsNull(Height(s, "t", ":active"), "a layer that changes neither keeps the base height");
            Assert.AreEqual("34px", Height(s, "t", "", ".text-size-large"), "30 px line box at 1.5, the padding unscaled");
            Assert.AreEqual("38px", Height(s, "t", ":hover", ".text-size-large"), "the hover layer's height under the step too");
        }

        [Test]
        public void NoWrapText_WithDifferentLineCountsPerLocale_OrAnimatedPadding_KeepsItsMeasuredHeight()
        {
            var locale = Label("locale", "Işık\nGol");
            locale.Text.En = "Light";
            var animated = Label("animated", "Işık", false, ("padding-top", "4px"));
            animated.Anims = new List<IrAnim> { new IrAnim
            {
                Kind = "transition", Trigger = "hover", Phase = "enter", Properties = new[] { "padding-top" }, Duration = 150, Timing = "ease",
                Iterations = 1, Direction = "normal", FillMode = "none", PlayState = "running", Restart = true,
            } };
            animated.With("hover", ("padding-top", "8px"));
            var s = Build(Root(locale, animated));
            Assert.IsNull(Height(s, "locale"));
            Assert.IsNull(Height(s, "animated"));
        }

        DesignUiProfile Profile()
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            _objects.Add(p);
            p.outputFolder = Out;
            p.viewports = new[] { new Vector2Int(2560, 1440) };
            p.scaledViewports = new[] { new Vector2Int(1600, 900), new Vector2Int(1366, 768) };
            FontFixture.Use(p);
            return p;
        }

        /// <summary>
        /// A column of 14 single-line labels (16/20) beside a column of the same labels that may wrap, at the panel scales of
        /// 1600×900 (0.625: a 12.5 device px line box) and 1366×768 (≈ 0.5335: 10.67): the fixed column ends where 14 line
        /// boxes end (within a device pixel), the wrapping one drifts by up to a pixel per label.
        /// </summary>
        [UnityTest]
        public IEnumerator FourteenSingleLineLabels_StackWithoutDrift_AtScaledPanels()
        {
            var fixedCol = Node("fixed", "container", ("display", "flex"), ("flex-direction", "column"), ("position", "absolute"), ("left", "0px"), ("top", "0px"), ("width", "400px"));
            var autoCol = Node("auto", "container", ("display", "flex"), ("flex-direction", "column"), ("position", "absolute"), ("left", "800px"), ("top", "0px"), ("width", "400px"));
            for (int i = 0; i < 14; i++)
            {
                fixedCol.Add(Label("f" + i, "Satır " + i));
                autoCol.Add(Label("a" + i, "Satır " + i, true));
            }
            var root = Node("root", "container", ("position", "relative"), ("width", "2560px"), ("height", "1440px")).Add(fixedCol, autoCol);
            root.Style["base"]["font-family"] = "\"" + FontFixture.Regular.faceInfo.familyName + "\"";
            foreach (var c in fixedCol.Children.Concat(autoCol.Children)) c.Style["base"]["font-family"] = "\"" + FontFixture.Regular.faceInfo.familyName + "\"";
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-fixed-lines-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(TestIr.Screen(root, "fixed.lines"), Formatting.Indented));
            File.WriteAllText(Path.Combine(dir, KitTextStyles.FileName), "{ \"label\": { \"fontSize\": 16, \"lineHeight\": 20, \"weight\": 400 } }");
            var result = ScreenCompiler.Compile(dir, Profile(), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));

            var report = new List<string>();
            foreach (var scale in new[] { 0.625, BoxesWriter.Scale(new Vector2Int(1366, 768), new Vector2Int(2560, 1440), 0.5f) })
            {
                _rt = new RenderTexture(1600, 900, 24);
                _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
                _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
                _settings.scale = (float)scale;
                _settings.targetTexture = _rt;
                _go = new GameObject("FixedLineTextHeightTests");
                var doc = _go.AddComponent<UIDocument>();
                doc.panelSettings = _settings;
                for (int f = 0; f < 2; f++) yield return null;
                var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/FixedLines/FixedLines.uxml").Instantiate();
                doc.rootVisualElement.Add(tree);
                for (int f = 0; f < 6; f++) yield return null;
                (tree.Q<DesignScreen>("root"))?.ApplyViewportScale();
                for (int f = 0; f < 4; f++) yield return null;
                double Bottom(string name) { var e = tree.Q(name); return (e.worldBound.yMax) * scale; }
                double exact = 14 * 20 * scale;
                double fixedDrift = Bottom("f13") - exact, autoDrift = Bottom("a13") - exact;
                report.Add("scale " + scale.ToString("0.######") + ": 14 rows end " + exact.ToString("0.###") + " device px in CSS; fixed " + fixedDrift.ToString("+0.###;-0.###;0") + ", wrapping " + autoDrift.ToString("+0.###;-0.###;0"));
                Assert.AreEqual(exact, Bottom("f13"), 1.0 + 1e-3, "the fixed-line column at scale " + scale);
                Assert.Greater(autoDrift, 1.0, "the measured-height column drifts at scale " + scale + " (the fixture shows the rounding)");
                Object.DestroyImmediate(_go);
                Object.DestroyImmediate(_settings);
                Object.DestroyImmediate(_rt);
                _go = null;
                _settings = null;
                _rt = null;
            }
            Debug.Log("Stacked single-line labels:\n" + string.Join("\n", report));
        }
    }
}
