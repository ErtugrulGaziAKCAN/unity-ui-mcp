using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
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
    /// Text at scaled viewports (docs/findings/viewport-classes.md): Unity sets text at whole device pixels, halves up, so at a
    /// scale where a kit size is a fraction of a device pixel (1600×900: 12 px is 7.5; 1366×768: every size) the twin made for
    /// that scale scales its face by exact / rounded size, and the compiled screen root takes the scale's class, under which
    /// <c>DesignFonts.uss</c> points the line-box variables at those twins.
    /// </summary>
    public class ViewportScaleTextTests
    {
        const string Out = "Assets/DesignUiViewportScaleTextTests";
        /// <summary>1366×768 with the 2560×1440 reference at match 0.5 (Unity's linear blend).</summary>
        static readonly double Scale1366 = BoxesWriter.Scale(new Vector2Int(1366, 768), new Vector2Int(2560, 1440), 0.5f);

        readonly List<string> _temp = new List<string>();
        readonly List<Object> _objects = new List<Object>();
        GameObject _go;
        PanelSettings _settings;
        readonly List<RenderTexture> _rts = new List<RenderTexture>();

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            foreach (var rt in _rts) if (rt != null) Object.DestroyImmediate(rt);
            _rts.Clear();
            foreach (var o in _objects) if (o != null) Object.DestroyImmediate(o);
            _objects.Clear();
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
            FontFixture.Delete();
        }

        static string RepositoryRoot() => Path.GetFullPath(Path.Combine(IrReaderTests.PackagePath(), "..", ".."));

        [Test]
        public void LineBox_AtDeviceScale_IsAVariantOnlyWhereTheSizeIsAFractionOfADevicePixel()
        {
            var caption = FontTwinGenerator.LineBox.For(12, 16);
            var label = FontTwinGenerator.LineBox.For(16, 20);
            var at1600 = caption.AtDeviceScale(0.625);
            Assert.AreEqual("r13333s12x0p625", at1600.Key);
            Assert.AreEqual(caption.Key, at1600.BaseKey);
            Assert.AreEqual(7.5 / 8, at1600.FaceScale, 1e-12, "7.5 device px, which Unity sets at 8");
            Assert.IsNull(label.AtDeviceScale(0.625), "16 px is 10 device px at 0.625: the style's own variant is exact");
            var at1366 = label.AtDeviceScale(Scale1366);
            Assert.AreEqual("r125s16x0p533464", at1366.Key);
            Assert.AreEqual(16 * Scale1366 / 9, at1366.FaceScale, 1e-12, "8.535 device px, which Unity sets at 9");
            Assert.IsNull(at1366.AtDeviceScale(0.625), "a variant has no variants");
            Assert.AreEqual(8, FontTwinGenerator.LineBox.UnitySize(7.5));
            Assert.AreEqual(23, FontTwinGenerator.LineBox.UnitySize(22.5), "halves up, measured");
            Assert.AreEqual(6, FontTwinGenerator.LineBox.UnitySize(6.4016));

            var all = FontTwinGenerator.LineBox.WithDeviceScales(new[] { caption, label }, new[] { 0.625, Scale1366 });
            CollectionAssert.AreEqual(new[] { "r125s16", "r125s16x0p533464", "r13333s12", "r13333s12x0p533464", "r13333s12x0p625" }, all.Select(b => b.Key).ToArray());
            var face = at1600.Face(new UnityEngine.TextCore.FaceInfo { pointSize = 72, ascentLine = 70, descentLine = -18, lineHeight = 87, scale = 1 });
            Assert.AreEqual((float)(7.5 / 8), face.scale);
        }

        [Test]
        public void ViewportScales_EncodeParseAndMatchThePanelScale()
        {
            var encoded = DesignViewportScales.Encode(new[] { 0.625, Scale1366 });
            CollectionAssert.AreEqual(new[] { 0.625, Scale1366 }, DesignViewportScales.Parse(encoded));
            Assert.AreEqual("vs-0p625", DesignViewportScales.ClassOf(0.625));
            Assert.AreEqual("vs-0p533464", DesignViewportScales.ClassOf(Scale1366));
            Assert.AreEqual(Scale1366, DesignViewportScales.Matching(new[] { 0.625, Scale1366 }, (float)Scale1366));
            Assert.IsNull(DesignViewportScales.Matching(new[] { 0.625, Scale1366 }, 0.5));
            Assert.AreEqual(1, DesignViewportScales.Parse("0.625;x;-1").Length, "malformed and non-positive entries are left out");
        }

        DesignUiProfile Profile(params Vector2Int[] scaled)
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            _objects.Add(p);
            p.outputFolder = Out;
            p.viewports = new[] { new Vector2Int(2560, 1440), new Vector2Int(1280, 720) };
            p.scaledViewports = scaled;
            FontFixture.Use(p);
            return p;
        }

        string Export()
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-vs-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            var caption = Text("caption", "Merhaba dünya, bugün", ("color", "#ffffff"), ("position", "absolute"), ("left", "16px"), ("top", "16px"));
            caption.Text.Style = "caption";
            var label = Text("label", "Merhaba dünya, bugün", ("color", "#ffffff"), ("position", "absolute"), ("left", "16px"), ("top", "64px"));
            label.Text.Style = "label";
            var root = Root(caption, label);
            root.Style["base"]["font-family"] = "\"" + FontFixture.Regular.faceInfo.familyName + "\"";
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(TestIr.Screen(root, "vs.screen"), Formatting.Indented));
            File.WriteAllText(Path.Combine(dir, KitTextStyles.FileName),
                "{ \"label\": { \"fontSize\": 16, \"lineHeight\": 20, \"weight\": 400 }, \"caption\": { \"fontSize\": 12, \"lineHeight\": 16, \"weight\": 400 } }");
            return dir;
        }

        [Test]
        public void Compile_ScaledViewports_TheRootCarriesTheirScales_AndDesignFontsSelectsTheirTwins()
        {
            var result = ScreenCompiler.Compile(Export(), Profile(new Vector2Int(1600, 900), new Vector2Int(1366, 768)), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var uxml = File.ReadAllText(Out + "/VsScreen/VsScreen.uxml");
            StringAssert.Contains("viewport-scales=\"" + DesignViewportScales.Encode(new[] { 0.625, Scale1366 }) + "\"", uxml);
            var uss = File.ReadAllText(Out + "/" + FontMap.FileName);
            var slug = Regex.Replace(FontFixture.Regular.faceInfo.familyName.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
            var twin = FontFixture.TwinFolder + "/" + FontFixture.Regular.name + " UITK ";
            // the base block names the styles' own variants only; each scale's block those made for it (1600: caption only)
            var head = uss.Substring(0, uss.IndexOf(".locale-tr.vs-", StringComparison.Ordinal));
            StringAssert.DoesNotContain("x0p", head);
            StringAssert.Contains(".locale-tr.vs-0p625 {\n    --font-" + slug + "-r13333s12: url(\"project://database/" + twin + "r13333s12x0p625.asset", uss);
            var block1600 = Regex.Match(uss, @"\.locale-tr\.vs-0p625 \{[^}]*\}").Value;
            StringAssert.DoesNotContain("r125s16", block1600, "16 px is whole at 0.625");
            var block1366 = Regex.Match(uss, @"\.locale-tr\.vs-0p533464 \{[^}]*\}").Value;
            StringAssert.Contains("-r125s16: url(\"project://database/" + twin + "r125s16x0p533464.asset", block1366);
            StringAssert.Contains("-r13333s12: url(\"project://database/" + twin + "r13333s12x0p533464.asset", block1366);
            var variant = AssetDatabase.LoadAssetAtPath<FontAsset>(twin + "r13333s12x0p625.asset");
            Assert.IsNotNull(variant, "the twin made for 1600×900");
            Assert.AreEqual(7.5f / 8f, variant.faceInfo.scale, 1e-6f);
            // the manifest records the styles' line boxes, not the scaled twins
            var manifest = GeneratedManifest.Load(Out + "/VsScreen/" + ScreenCompiler.ManifestFileName);
            CollectionAssert.AreEquivalent(new[] { "12/16", "16/20" }, manifest.lineBoxes);
        }

        [Test]
        public void Compile_WithoutScaledViewports_WritesNeitherTheScalesNorScaledTwins()
        {
            var result = ScreenCompiler.Compile(Export(), Profile(), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            StringAssert.DoesNotContain("viewport-scales", File.ReadAllText(Out + "/VsScreen/VsScreen.uxml"));
            StringAssert.DoesNotContain(".vs-", File.ReadAllText(Out + "/" + FontMap.FileName));
        }

        RenderTexture Texture(int w, int h)
        {
            var rt = new RenderTexture(w, h, 24);
            _rts.Add(rt);
            return rt;
        }

        static IEnumerator Frames(int n)
        {
            for (int i = 0; i < n; i++) yield return null;
        }

        static string[] ScaleClasses(VisualElement e) =>
            e.GetClasses().Where(c => c.StartsWith(DesignViewportScales.ClassPrefix, StringComparison.Ordinal)).OrderBy(c => c, StringComparer.Ordinal).ToArray();

        [UnityTest]
        public IEnumerator Runtime_TheRootTakesThePanelScalesClass_AndTheTextKeepsTheDesignSizeThere()
        {
            var result = ScreenCompiler.Compile(Export(), Profile(new Vector2Int(1600, 900)), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = Texture(1600, 900);
            _go = new GameObject("ViewportScaleTextTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            yield return Frames(2);
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/VsScreen/VsScreen.uxml").Instantiate();
            doc.rootVisualElement.Add(tree);
            var screen = tree.Q<DesignScreen>("root");
            var caption = tree.Q<Label>("caption");
            yield return Frames(4);
            CollectionAssert.IsEmpty(ScaleClasses(screen), "scale 1");
            float width1 = caption.layout.width;
            Assert.AreEqual(16f, caption.layout.height, 1e-3f);

            // the same texture at scale 0.625: no geometry change of the panel's root size, the scale watch applies the class
            _settings.scale = 0.625f;
            _settings.targetTexture = Texture(1600, 900);
            yield return Frames(4);
            screen.ApplyViewportScale();
            yield return Frames(4);
            CollectionAssert.AreEqual(new[] { "vs-0p625" }, ScaleClasses(screen));
            Assert.AreEqual(Path.GetFileName(FontFixture.TwinFolder + "/" + FontFixture.Regular.name + " UITK r13333s12x0p625.asset"),
                Path.GetFileName(AssetDatabase.GetAssetPath(caption.resolvedStyle.unityFontDefinition.fontAsset)));
            // 12 px at 0.625 is 7.5 device px: the text is the design's width (scale 1's, scaled), not 8/7.5 of it
            Assert.AreEqual(width1 * 0.625, caption.layout.width * 0.625, 1.0, "device width");
            Assert.AreEqual(10, Math.Ceiling(caption.layout.height * 0.625 - 1e-4), "one 16 px line box: 10 device px");

            _settings.scale = 1f;
            _settings.targetTexture = Texture(1600, 900);
            yield return Frames(4);
            screen.ApplyViewportScale();
            yield return Frames(2);
            CollectionAssert.IsEmpty(ScaleClasses(screen), "back at scale 1");
        }

        /// <summary>
        /// Every kit style through the twin made for each scaled viewport of the repository's kit: a kerned line is Chromium's
        /// width at that scale (the scale-1 width times the scale; Chromium lays text out at the exact size) within the box limit,
        /// and n lines are within one device pixel of n line boxes (UI Toolkit ceils a text element's height).
        /// </summary>
        [UnityTest]
        public IEnumerator EveryKitStyle_AtEveryScaledViewport_IsTheDesignsWidthAndLineBox()
        {
            var stylesPath = Path.Combine(RepositoryRoot(), "design-kit", KitTextStyles.FileName);
            var kitConfig = Path.Combine(RepositoryRoot(), "design-kit", "kit.config.json");
            if (!File.Exists(stylesPath) || !File.Exists(kitConfig))
            {
                Assert.Pass("the package is not inside the unity-ui-mcp repository");
                yield break;
            }
            var config = JObject.Parse(File.ReadAllText(kitConfig));
            var scales = ((JArray)config["viewports"]).OfType<JObject>().Where(v => (string)v["class"] == "scaled")
                .Select(v => BoxesWriter.Scale(new Vector2Int((int)v["size"][0], (int)v["size"][1]), new Vector2Int(2560, 1440), 0.5f)).ToList();
            Assert.IsNotEmpty(scales, "the kit declares scaled viewports");
            var kerning = JObject.Parse(File.ReadAllText(IrReaderTests.PackagePath("Tests", "Editor", "Data", "chromium-kerning-line.json")));
            var text = (string)kerning["text"];
            var styles = JObject.Parse(File.ReadAllText(stylesPath)).Properties().Where(p => (int?)p.Value["weight"] == 400)
                .Select(p => (name: p.Name, size: (double)p.Value["fontSize"], line: (double)p.Value["lineHeight"])).ToList();
            var regular = FontFixture.Kept(FontFixture.RegularTtf, "Kept Table Regular");
            var failures = new List<string>();
            var summary = new List<string>();
            foreach (var scale in scales)
            {
                _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
                _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
                _settings.scale = (float)scale;
                _settings.targetTexture = Texture(1024, 1024);
                _go = new GameObject("ScaledKitStyles");
                var doc = _go.AddComponent<UIDocument>();
                doc.panelSettings = _settings;
                var labels = new List<(Label line, Label stack, (string name, double size, double line) style)>();
                int i = 0;
                foreach (var s in styles)
                {
                    var box = FontTwinGenerator.LineBox.For(s.size, s.line);
                    // its own kept folder: getting LineBoxStyleTableTests' kept variants again would unlink them while pooled text still draws with them
                    var twin = FontTwinGenerator.GetOrCreateTwin(regular, FontFixture.KeptFolder + "/ScaledTwins", box.AtDeviceScale(scale) ?? box);
                    DesignText.Prepare(twin, text + "Hg");
                    var line = new Label(text);
                    var stack = new Label(string.Join("\n", Enumerable.Repeat("Hg", 5)));
                    foreach (var (l, x) in new[] { (line, 8), (stack, 1200) })
                    {
                        l.style.position = Position.Absolute;
                        l.style.left = x;
                        l.style.top = 8 + 96 * i;
                        l.style.fontSize = (float)s.size;
                        l.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
                        doc.rootVisualElement.Add(l);
                    }
                    labels.Add((line, stack, s));
                    i++;
                }
                yield return Frames(8);
                double worstW = 0, worstH = 0;
                foreach (var (line, stack, s) in labels)
                {
                    var chromium = (double)kerning["widths"][s.size.ToString(System.Globalization.CultureInfo.InvariantCulture) + "/400"]["1"] * scale;
                    double w = line.layout.width * scale, h = stack.layout.height * scale, css = 5 * s.line * scale;
                    worstW = Math.Max(worstW, Math.Abs(w - chromium));
                    worstH = Math.Max(worstH, Math.Abs(h - css));
                    if (Math.Abs(w - chromium) > 1 + 1e-3) failures.Add(s.name + " at scale " + scale + ": width " + w + " device px, Chromium " + chromium);
                    if (h - css < -1e-3 || h - css > 1 + 1e-3) failures.Add(s.name + " at scale " + scale + ": 5 lines " + h + " device px, CSS " + css);
                }
                summary.Add("scale " + scale + ": largest |width − Chromium| " + worstW.ToString("0.###") + ", largest |5 lines − 5 line boxes| " + worstH.ToString("0.###") + " device px");
                Object.DestroyImmediate(_go);
                Object.DestroyImmediate(_settings);
                _go = null;
                _settings = null;
            }
            Debug.Log("Kit styles at the scaled viewports:\n" + string.Join("\n", summary));
            Assert.IsEmpty(failures, string.Join("\n", failures));
        }

        /// <summary>
        /// Measured, pinned (docs/findings/viewport-classes.md): UI Toolkit 6000.3 lays every padding, margin and border width
        /// out as whole device pixels (halves up), an explicit height as it is. At a scaled viewport a stack of padded, spaced or
        /// bordered elements therefore drifts from Chromium, which lays the fractions out. A Unity version that changes this
        /// fails here, and the scaled class can be measured again.
        /// </summary>
        /// <summary>
        /// Which lengths UI Toolkit puts on whole device pixels before layout at an exact viewport's scale (0.75, 1920×1080),
        /// where a length that is not a multiple of 4 px is a fraction of a device pixel (10 px is 7.5). Each chain nests ten
        /// elements, each moved 10 px from its parent by one property: CSS puts the last one 75 device px from the first
        /// one's parent; a length snapped to 8 before layout puts it at 80. Measured: padding, margin (a lowered gap is a
        /// margin) and border widths are snapped, halves up; position offsets (left, right, top, relative or absolute) and
        /// translate are not (lint U-CSS-046 and U-CSS-040 hold the snapped ones to the device grid).
        /// </summary>
        [UnityTest]
        public IEnumerator LengthsUiToolkitSnaps_AtAnExactViewport_BoxModelYes_OffsetsAndTranslateNo()
        {
            const double scale = 0.75;
            _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = (float)scale;
            _settings.targetTexture = Texture(800, 600);
            _go = new GameObject("SnappedLengths");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            var chains = new Dictionary<string, (VisualElement first, VisualElement last, bool vertical)>();
            int row = 0;
            void Chain(string name, Action<VisualElement, int> style, bool vertical = false)
            {
                var top = new VisualElement();
                top.style.position = Position.Absolute;
                top.style.left = 40 + (vertical ? 200 * row : 0);
                top.style.top = vertical ? 20 : 20 + 30 * row;
                top.style.width = 600;
                top.style.height = 600;
                row++;
                doc.rootVisualElement.Add(top);
                var parent = top;
                for (int level = 1; level <= 10; level++)
                {
                    var e = new VisualElement();
                    e.style.width = 600 - 20 * level;
                    e.style.height = 600 - 20 * level;
                    e.style.flexShrink = 0;
                    parent.Add(e);
                    style(e, level);
                    parent = e;
                }
                chains[name] = (top, parent, vertical);
            }
            row = 0;
            Chain("padding-left", (e, _) => e.parent.style.paddingLeft = 10);
            Chain("margin-left (a lowered gap too)", (e, _) => e.style.marginLeft = 10);
            Chain("border-left-width", (e, _) => e.parent.style.borderLeftWidth = 10);
            Chain("left, relative", (e, _) => { e.style.position = Position.Relative; e.style.left = 10; });
            Chain("left, absolute", (e, _) => { e.style.position = Position.Absolute; e.style.left = 10; });
            Chain("right, absolute", (e, level) => { e.style.position = Position.Absolute; e.style.right = 10; });
            Chain("translate", (e, _) => e.style.translate = new Translate(10, 0));
            Chain("width (explicit, shrinking 20 px a level)", (e, _) => { });
            row = 0;
            Chain("top, absolute", (e, _) => { e.style.position = Position.Absolute; e.style.top = 10; }, vertical: true);
            Chain("padding-top", (e, _) => e.parent.style.paddingTop = 10, vertical: true);
            yield return Frames(4);
            var moved = chains.ToDictionary(kv => kv.Key, kv => kv.Value.vertical
                ? ((double)kv.Value.last.worldBound.y - kv.Value.first.worldBound.y) * scale
                : ((double)kv.Value.last.worldBound.x - kv.Value.first.worldBound.x) * scale);
            Debug.Log("Ten nested 10 px moves at scale 0.75, device px (CSS 75; snapped lengths 80):\n" +
                      string.Join("\n", moved.Select(kv => kv.Key + ": " + kv.Value.ToString("0.###"))));
            foreach (var what in new[] { "padding-left", "margin-left (a lowered gap too)", "border-left-width", "padding-top" })
                Assert.AreEqual(80, moved[what], 0.01, what + ": 10 px laid out as 8 device px, not 7.5");
            foreach (var what in new[] { "left, relative", "left, absolute", "right, absolute", "top, absolute", "translate" })
                Assert.AreEqual(75, moved[what], 0.01, what + ": not snapped, 10 px is 7.5 device px");
            Assert.AreEqual(0, moved["width (explicit, shrinking 20 px a level)"], 0.01, "the chain without moves stays put");
        }

        [UnityTest]
        public IEnumerator BoxModelLengths_AreWholeDevicePixelsAtAScaledViewport_ExplicitHeightsAreNot()
        {
            var results = new Dictionary<string, double>();
            foreach (var scale in new[] { 0.625, Scale1366 })
            {
                _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
                _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
                _settings.scale = (float)scale;
                _settings.targetTexture = Texture(800, 600);
                _go = new GameObject("BoxModelLengths");
                var doc = _go.AddComponent<UIDocument>();
                doc.panelSettings = _settings;
                VisualElement Column(Action<VisualElement> style)
                {
                    var col = new VisualElement();
                    col.style.position = Position.Absolute;
                    for (int i = 0; i < 10; i++)
                    {
                        var row = new VisualElement();
                        style(row);
                        var child = new VisualElement();
                        child.style.height = 20;
                        row.Add(child);
                        col.Add(row);
                    }
                    doc.rootVisualElement.Add(col);
                    return col;
                }
                var columns = new Dictionary<string, VisualElement>
                {
                    { "padding", Column(r => { r.style.paddingTop = 4; r.style.paddingBottom = 4; }) },
                    { "margin", Column(r => { r.style.marginTop = 4; r.style.marginBottom = 4; }) },
                    { "border", Column(r => { r.style.borderTopWidth = 4; r.style.borderBottomWidth = 4; }) },
                    { "height", Column(r => r.style.height = 28) },
                };
                yield return Frames(4);
                foreach (var kv in columns) results[kv.Key + "@" + scale.ToString("0.###")] = kv.Value.layout.height * scale;
                Object.DestroyImmediate(_go);
                Object.DestroyImmediate(_settings);
                _go = null;
                _settings = null;
            }
            Debug.Log("Ten 20 px rows with 4 px on both sides, device px:\n" + string.Join("\n", results.Select(kv => kv.Key + ": " + kv.Value.ToString("0.###"))));
            // 0.625: 4 px is 2.5 device px, laid out as 3; CSS 10 × 17.5 = 175
            foreach (var what in new[] { "padding", "margin", "border" }) Assert.AreEqual(185, results[what + "@0.625"], 0.01, what + " at 0.625");
            Assert.AreEqual(175, results["height@0.625"], 0.01, "an explicit height is laid out exactly");
            // 0.53346: 4 px is 2.134 device px, laid out as 2; CSS 10 × 14.94 = 149.37
            foreach (var what in new[] { "padding", "margin", "border" }) Assert.AreEqual(147, results[what + "@0.533"], 0.6, what + " at 0.53346");
            Assert.AreEqual(28 * 10 * Scale1366, results["height@0.533"], 1.0, "an explicit height is laid out exactly (edges rounded)");
        }
    }
}
