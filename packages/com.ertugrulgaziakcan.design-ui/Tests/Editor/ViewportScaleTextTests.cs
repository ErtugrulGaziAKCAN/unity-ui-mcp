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
    /// Text and lengths at scaled viewports (docs/findings/viewport-classes.md): what UI Toolkit puts on whole device pixels
    /// at a panel scale (font sizes, paddings, margins, borders; measured and pinned), and kit text laid out at an exact scale
    /// under the screen root's scale (<see cref="DesignScreen.ApplyRootScale"/>), which keeps the design's widths and line
    /// boxes at the actual one.
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

        /// <summary>The panel scales of the repository kit's exact and scaled viewports (kit.config.json), or null outside the repository.</summary>
        static (List<double> exact, List<double> scaled)? KitScales()
        {
            var kitConfig = Path.Combine(RepositoryRoot(), "design-kit", "kit.config.json");
            if (!File.Exists(kitConfig)) return null;
            var exact = new List<double>();
            var scaled = new List<double>();
            foreach (var v in (JArray)JObject.Parse(File.ReadAllText(kitConfig))["viewports"])
            {
                bool isScaled = v is JObject o && (string)o["class"] == "scaled";
                var size = v is JObject so ? (JArray)so["size"] : (JArray)v;
                var scale = BoxesWriter.Scale(new Vector2Int((int)size[0], (int)size[1]), new Vector2Int(2560, 1440), 0.5f);
                (isScaled ? scaled : exact).Add(scale);
            }
            return (exact, scaled);
        }

        /// <summary>
        /// Every kit style at each scaled viewport of the repository's kit, inside a screen root that lays its panel out at an
        /// exact scale and draws scaled (each candidate exact scale: the nearest in log scale, the next up, the next down): a
        /// kerned line is Chromium's width at the actual scale (the scale-1 width times the scale; Chromium lays text out at the
        /// exact size) within the box limit, and five lines are within one device pixel of five line boxes. The measured table
        /// is logged (docs/findings/viewport-classes.md).
        /// </summary>
        [UnityTest]
        public IEnumerator EveryKitStyle_UnderTheRootScale_IsTheDesignsWidthAndLineBox()
        {
            var stylesPath = Path.Combine(RepositoryRoot(), "design-kit", KitTextStyles.FileName);
            var kit = KitScales();
            if (!File.Exists(stylesPath) || kit == null)
            {
                Assert.Pass("the package is not inside the unity-ui-mcp repository");
                yield break;
            }
            var (exact, scales) = kit.Value;
            Assert.IsNotEmpty(scales, "the kit declares scaled viewports");
            var kerning = JObject.Parse(File.ReadAllText(IrReaderTests.PackagePath("Tests", "Editor", "Data", "chromium-kerning-line.json")));
            var text = (string)kerning["text"];
            var styles = JObject.Parse(File.ReadAllText(stylesPath)).Properties().Where(p => (int?)p.Value["weight"] == 400)
                .Select(p => (name: p.Name, size: (double)p.Value["fontSize"], line: (double)p.Value["lineHeight"])).ToList();
            var regular = FontFixture.Kept(FontFixture.RegularTtf, "Kept Table Regular");
            var failures = new List<string>();
            var summary = new List<string>();
            var rule = DesignViewportScales.Rule;
            var done = new HashSet<(double, double)>();
            try
            {
                foreach (var scale in scales)
                    foreach (var baseRule in new[] { DesignViewportScales.BaseRule.Nearest, DesignViewportScales.BaseRule.Up, DesignViewportScales.BaseRule.Down })
                    {
                        DesignViewportScales.Rule = baseRule;
                        double layoutScale = DesignViewportScales.LayoutScale(exact, scale);
                        if (!done.Add((scale, layoutScale))) continue;
                        _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
                        _settings.hideFlags = HideFlags.DontSave; // a runtime copy: the editor holds factors only on settings no save writes
                        _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
                        _settings.scale = (float)scale;
                        _settings.targetTexture = Texture(1600, 1600);
                        _go = new GameObject("ScaledKitStyles");
                        var doc = _go.AddComponent<UIDocument>();
                        doc.panelSettings = _settings;
                        var screen = new DesignScreen { ExactScales = DesignViewportScales.Encode(exact) };
                        screen.style.width = 2560;
                        screen.style.height = 1440;
                        doc.rootVisualElement.Add(screen);
                        var labels = new List<(Label line, Label stack, (string name, double size, double line) style)>();
                        int i = 0;
                        foreach (var s in styles)
                        {
                            // its own kept folder: getting LineBoxStyleTableTests' kept variants again would unlink them while pooled text still draws with them
                            var twin = FontTwinGenerator.GetOrCreateTwin(regular, FontFixture.KeptFolder + "/ScaledTwins", FontTwinGenerator.LineBox.For(s.size, s.line));
                            DesignText.Prepare(twin, text + "Hg");
                            var line = new Label(text);
                            var stack = new Label(string.Join("\n", Enumerable.Repeat("Hg", 5)));
                            foreach (var (l, x) in new[] { (line, 8), (stack, 1800) })
                            {
                                l.style.position = Position.Absolute;
                                l.style.left = x;
                                l.style.top = 8 + 96 * i;
                                l.style.fontSize = (float)s.size;
                                l.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
                                screen.Add(l);
                            }
                            labels.Add((line, stack, s));
                            i++;
                        }
                        yield return Frames(8);
                        double ppp = screen.panel.scaledPixelsPerPoint;
                        Assert.AreEqual(layoutScale, ppp, 1e-4, "the panel lays out at the exact scale " + layoutScale);
                        double worstW = 0, worstH = 0;
                        foreach (var (line, stack, s) in labels)
                        {
                            var chromium = (double)kerning["widths"][s.size.ToString(System.Globalization.CultureInfo.InvariantCulture) + "/400"]["1"] * scale;
                            double w = line.worldBound.width * ppp, h = stack.worldBound.height * ppp, css = 5 * s.line * scale;
                            worstW = Math.Max(worstW, Math.Abs(w - chromium));
                            worstH = Math.Max(worstH, Math.Abs(h - css));
                            if (Math.Abs(w - chromium) > 1 + 1e-3) failures.Add(s.name + " at scale " + scale + " from " + layoutScale + ": width " + w + " device px, Chromium " + chromium);
                            if (Math.Abs(h - css) > 1 + 1e-3) failures.Add(s.name + " at scale " + scale + " from " + layoutScale + ": 5 lines " + h + " device px, CSS " + css);
                        }
                        summary.Add("scale " + scale.ToString("0.#####") + " from " + layoutScale.ToString("0.##") + ": largest |width − Chromium| " + worstW.ToString("0.###") +
                                    ", largest |5 lines − 5 line boxes| " + worstH.ToString("0.###") + " device px");
                        Object.DestroyImmediate(_go);
                        Object.DestroyImmediate(_settings);
                        _go = null;
                        _settings = null;
                    }
            }
            finally { DesignViewportScales.Rule = rule; }
            Debug.Log("Kit styles under the root scale:\n" + string.Join("\n", summary));
            Assert.IsEmpty(failures, string.Join("\n", failures));
        }

        /// <summary>
        /// UI Toolkit draws text through a scaled root as it lays it out, at the panel's whole-pixel size, and does not set it
        /// again at the world scale: the ink of a run of 30 H at 12 px drawn at 1600×900 through the root scale (panel 0.75, root
        /// 0.8333) spans the ink of the run at scale 1 times 0.625 (within a device pixel), where a panel at 0.625 without the
        /// root scale sets it at 8 device px (8/7.5 of it). The extents are logged.
        /// </summary>
        [UnityTest]
        public IEnumerator TextInk_ThroughTheRootScale_IsTheDesignsSizeAtTheActualScale()
        {
            var kit = KitScales();
            var exact = kit?.exact ?? new List<double> { 1, 0.75, 0.5, 1.5 };
            var regular = FontFixture.Kept(FontFixture.RegularTtf, "Kept Table Regular");
            var twin = FontTwinGenerator.GetOrCreateTwin(regular, FontFixture.KeptFolder + "/ScaledTwins", FontTwinGenerator.LineBox.For(12, 16));
            var run = new string('H', 30);
            DesignText.Prepare(twin, run);
            var results = new Dictionary<string, double>();
            foreach (var (what, scale, rooted) in new[] { ("scale 1", 1.0, false), ("0.625 through the root scale", 0.625, true), ("0.625 without it", 0.625, false) })
            {
                _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
                _settings.hideFlags = HideFlags.DontSave; // a runtime copy: the editor holds factors only on settings no save writes
                _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
                _settings.scale = (float)scale;
                _settings.clearColor = true;
                _settings.colorClearValue = Color.black;
                var rt = Texture(800, 200);
                _settings.targetTexture = rt;
                _go = new GameObject("RootScaleInk");
                var doc = _go.AddComponent<UIDocument>();
                doc.panelSettings = _settings;
                var host = rooted ? new DesignScreen { ExactScales = DesignViewportScales.Encode(exact) } : new VisualElement();
                host.style.width = 1000;
                host.style.height = 300;
                doc.rootVisualElement.Add(host);
                var label = new Label(run);
                label.style.position = Position.Absolute;
                label.style.left = 20;
                label.style.top = 20;
                label.style.fontSize = 12;
                label.style.color = Color.white;
                label.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
                host.Add(label);
                yield return Frames(8);
                if (rooted) Assert.AreEqual(0.75, host.panel.scaledPixelsPerPoint, 1e-4);
                var tex = new Texture2D(rt.width, rt.height, TextureFormat.RGBA32, false);
                _objects.Add(tex);
                var active = RenderTexture.active;
                RenderTexture.active = rt;
                tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0, false);
                RenderTexture.active = active;
                var px = tex.GetPixels32();
                // the ink's horizontal extent, coverage-weighted at its two ends (half-covered columns count half)
                double first = double.NaN, last = double.NaN;
                for (int x = 0; x < rt.width; x++)
                {
                    int max = 0;
                    for (int y = 0; y < rt.height; y++) max = Math.Max(max, px[y * rt.width + x].r);
                    if (max < 8) continue;
                    if (double.IsNaN(first)) first = x + 1 - max / 255.0;
                    last = x + max / 255.0;
                }
                results[what] = last - first;
                Object.DestroyImmediate(_go);
                Object.DestroyImmediate(_settings);
                _go = null;
                _settings = null;
            }
            Debug.Log("Ink extent of 30 H at 12 px, device px:\n" + string.Join("\n", results.Select(kv => kv.Key + ": " + kv.Value.ToString("0.###"))));
            Assert.AreEqual(results["scale 1"] * 0.625, results["0.625 through the root scale"], 1.0, "through the root scale: the design's size");
            Assert.Greater(Math.Abs(results["0.625 without it"] - results["scale 1"] * 0.625), 1.0, "without it UI Toolkit sets 8 device px (the fixture shows the rounding)");
        }

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
            _settings.hideFlags = HideFlags.DontSave; // a runtime copy: the editor holds factors only on settings no save writes
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

        /// <summary>
        /// Measured, pinned (docs/findings/viewport-classes.md): UI Toolkit 6000.3 lays every padding, margin and border width
        /// out as whole device pixels (halves up), an explicit height as it is. At a scaled viewport a stack of padded, spaced or
        /// bordered elements therefore drifts from Chromium, which lays the fractions out. A Unity version that changes this
        /// fails here, and the scaled class can be measured again.
        /// </summary>
        [UnityTest]
        public IEnumerator BoxModelLengths_AreWholeDevicePixelsAtAScaledViewport_ExplicitHeightsAreNot()
        {
            var results = new Dictionary<string, double>();
            foreach (var scale in new[] { 0.625, Scale1366 })
            {
                _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
                _settings.hideFlags = HideFlags.DontSave; // a runtime copy: the editor holds factors only on settings no save writes
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
