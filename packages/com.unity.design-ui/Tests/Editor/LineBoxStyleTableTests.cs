using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// Table-driven panel proof of the kit's line-box text styles (docs/findings/m0.md, line height and text styles): every
    /// style of the repository's <c>design-kit/text-styles.json</c> (both ratios, regular and bold) at 1, 2, 5 and 10 lines,
    /// laid out on a real panel at the viewport scales 1, 0.75 and 0.5 with its line-box font twin, is
    /// <c>n × lineHeight</c> tall and has every line's baseline where Chromium puts it, both within the comparison's
    /// <c>boxPx</c> / <c>baselinePx</c> (device px, <c>tools/design-export/fidelity-thresholds.json</c>). Chromium's first
    /// baseline: <c>round(ascent) + (L − round(ascent) − round(descent)) / 2</c> in device px, with the font's own ascent and
    /// descent; each further line one line box lower. Each style also sets one line with kerned pairs whose width must be
    /// Chromium's (<c>Data/chromium-kerning-line.json</c>, from the exporter's goldens) within <c>boxPx</c> on its first
    /// layout: its characters reach the twins through <see cref="DesignText.Prepare"/> before it is laid out, as a bound text's
    /// do. The line-box variants are the table's own ratios. Skips when the package is not inside the repository.
    /// </summary>
    public class LineBoxStyleTableTests
    {
        // regular and bold render in one panel (multi-material text): the fonts stay for the session (FontFixture.KeptFolder)
        const string Twins = FontFixture.KeptTwinFolder;
        static readonly int[] LineCounts = { 1, 2, 5, 10 };
        static readonly float[] Scales = { 1f, 0.75f, 0.5f };

        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;

        static string RepositoryRoot() => Path.GetFullPath(Path.Combine(IrReaderTests.PackagePath(), "..", ".."));

        [TearDown]
        public void Cleanup() => Dispose();

        void Dispose()
        {
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            if (_rt != null) Object.DestroyImmediate(_rt);
            _go = null;
            _settings = null;
            _rt = null;
        }

        sealed class Style
        {
            public string Name;
            public double Size, Line;
            public int Weight;
        }

        [UnityTest]
        public IEnumerator EveryKitStyle_IsNLineBoxesTall_WithChromiumsBaselines_AtEveryViewportScale()
        {
            var stylesPath = Path.Combine(RepositoryRoot(), "design-kit", KitTextStyles.FileName);
            var thresholdsPath = Path.Combine(RepositoryRoot(), "tools", "design-export", "fidelity-thresholds.json");
            if (!File.Exists(stylesPath) || !File.Exists(thresholdsPath))
            {
                Assert.Pass("the package is not inside the unity-ui-mcp repository; no kit text styles here");
                yield break;
            }
            var thresholds = JObject.Parse(File.ReadAllText(thresholdsPath));
            double boxPx = (double)thresholds["boxPx"], baselinePx = (double)thresholds["baselinePx"];
            var styles = JObject.Parse(File.ReadAllText(stylesPath)).Properties()
                .Where(p => !p.Name.StartsWith("$", StringComparison.Ordinal))
                .Select(p => new Style { Name = p.Name, Size = (double)p.Value["fontSize"], Line = (double)p.Value["lineHeight"], Weight = (int?)p.Value["weight"] ?? 400 })
                .ToList();
            Assert.IsNotEmpty(styles);
            // every ratio the table holds gets its line-box variant (table-driven: no fixed ratio list)
            var ratios = styles.Select(s => FontTwinGenerator.LineBox.ForRatio(s.Line / s.Size)).ToList();
            for (int i = 0; i < styles.Count; i++) Assert.IsNotNull(ratios[i], styles[i].Name + ": " + styles[i].Line + "/" + styles[i].Size + " is no line box");
            var boxes = KitTextStyles.LineBoxesOf(stylesPath);
            CollectionAssert.AreEquivalent(ratios.Select(r => r.Key).Distinct().ToList(), boxes.Select(b => b.Key).ToList(), "the table's line boxes");

            var bold = FontFixture.Kept(FontFixture.BoldTtf, "Kept Table Bold");
            var regular = FontFixture.Kept(FontFixture.RegularTtf, "Kept Table Regular");
            if (regular.fontWeightTable[7].regularTypeface != bold) FontFixture.SetWeight(regular, 700, bold);
            var variants = boxes.ToDictionary(b => b.Key, b => FontTwinGenerator.GetOrCreateTwin(regular, Twins, b));
            // Chromium's metrics are the font's own: the plain twins' faces (equal to the TTF's)
            var plain = FontTwinGenerator.GetOrCreateTwin(regular, Twins).faceInfo;
            var plainBold = FontTwinGenerator.GetOrCreateTwin(bold, Twins).faceInfo;

            var kerning = JObject.Parse(File.ReadAllText(IrReaderTests.PackagePath("Tests", "Editor", "Data", "chromium-kerning-line.json")));
            var kerningText = (string)kerning["text"];
            foreach (var v in variants.Values) Assert.AreEqual("", DesignText.Prepare(v, kerningText), "Inter has every character of the line");

            var failures = new List<string>();
            var summary = new List<string>();
            int checkedLabels = 0;
            foreach (var scale in Scales)
            {
                _rt = new RenderTexture(512, 512, 24, RenderTextureFormat.ARGB32);
                _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
                _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
                _settings.scale = scale;
                _settings.targetTexture = _rt;
                _go = new GameObject("LineBoxStyleTable");
                var doc = _go.AddComponent<UIDocument>();
                doc.panelSettings = _settings;
                var root = doc.rootVisualElement;

                var labels = new List<(Label label, Style style, int lines)>();
                foreach (var (style, i) in styles.Select((s, i) => (s, i)))
                    foreach (var (lines, k) in LineCounts.Select((n, k) => (n, k)))
                    {
                        var l = new Label(string.Join("\n", Enumerable.Repeat("Hg", lines))) { name = style.Name + "-" + lines };
                        l.style.position = Position.Absolute;
                        l.style.left = 8 + 96 * k;
                        l.style.top = 8 + 8 * i; // whole device px at every scale (multiples of 8 panel px)
                        l.style.fontSize = (float)style.Size;
                        l.style.unityFontDefinition = FontDefinition.FromSDFFont(variants[ratios[i].Key]);
                        l.style.unityFontStyleAndWeight = style.Weight >= 700 ? FontStyle.Bold : FontStyle.Normal;
                        root.Add(l);
                        labels.Add((l, style, lines));
                    }
                var kerned = styles.Select((style, i) =>
                {
                    var l = new Label(kerningText) { name = "kern-" + style.Name };
                    l.style.position = Position.Absolute;
                    l.style.left = 8 + 96 * LineCounts.Length;
                    l.style.top = 8 + 8 * i;
                    l.style.fontSize = (float)style.Size;
                    l.style.unityFontDefinition = FontDefinition.FromSDFFont(variants[ratios[i].Key]);
                    l.style.unityFontStyleAndWeight = style.Weight >= 700 ? FontStyle.Bold : FontStyle.Normal;
                    root.Add(l);
                    return (label: l, style);
                }).ToList();
                for (int f = 0; f < 10; f++) yield return null;

                var ir = TestIr.Screen(TestIr.Root(), "linebox.table");
                ir.Root.Children = labels.Select(x => x.label.name).Concat(kerned.Select(x => x.label.name))
                    .Select(id => { var n = TestIr.Node(id, "text"); n.Text = new IrText { Tr = "Hg" }; return n; }).ToArray();
                var measured = BoxesWriter.Measure("c", root, new Vector2Int(_rt.width, _rt.height), scale, ir);
                double worstH = 0, worstB = 0;
                foreach (var (label, style, lines) in labels)
                {
                    var face = style.Weight >= 700 ? plainBold : plain;
                    double dev = style.Size * scale, lineBox = style.Line * scale;
                    double ascent = Math.Round(face.ascentLine * dev / face.pointSize, MidpointRounding.AwayFromZero);
                    double descent = Math.Round(-face.descentLine * dev / face.pointSize, MidpointRounding.AwayFromZero);
                    double top = (8 + 8 * styles.IndexOf(style)) * scale;
                    double chromiumFirst = top + ascent + (lineBox - ascent - descent) / 2;
                    var el = measured["elements"][label.name];
                    var where = style.Name + " (" + style.Size + "/" + style.Line + ", " + style.Weight + ") × " + lines + " lines at scale " + scale;
                    double h = (double)el["h"], y = (double)el["y"];
                    if (Math.Abs(y - top) > boxPx + 1e-6) failures.Add(where + ": top " + y + " device px, expected " + top);
                    worstH = Math.Max(worstH, Math.Abs(h - lines * lineBox));
                    if (Math.Abs(h - lines * lineBox) > boxPx + 1e-6) failures.Add(where + ": height " + h + " device px, CSS " + lines * lineBox + " (limit ±" + boxPx + ")");
                    var measuredLines = (JArray)el["lines"];
                    if (measuredLines.Count != lines) { failures.Add(where + ": " + measuredLines.Count + " lines"); continue; }
                    for (int k = 0; k < lines; k++)
                    {
                        double expected = chromiumFirst + k * lineBox, got = (double)measuredLines[k]["baseline"];
                        worstB = Math.Max(worstB, Math.Abs(got - expected));
                        if (Math.Abs(got - expected) > baselinePx + 1e-6)
                            failures.Add(where + ": line " + (k + 1) + " baseline " + got.ToString("0.###") + " device px, Chromium " + expected.ToString("0.###") + " (limit ±" + baselinePx + ")");
                    }
                }
                double worstW = 0;
                foreach (var (label, style) in kerned)
                {
                    var key = style.Size.ToString(System.Globalization.CultureInfo.InvariantCulture) + "/" + style.Weight;
                    var chromium = (double?)kerning["widths"]?[key]?[scale.ToString(System.Globalization.CultureInfo.InvariantCulture)];
                    if (chromium == null) { failures.Add(style.Name + ": no Chromium width for " + key + " at scale " + scale + " (rebuild Data/chromium-kerning-line.json with Data/tools~/chromium-kerning-line.mts)"); continue; }
                    double w = (double)measured["elements"][label.name]["w"];
                    worstW = Math.Max(worstW, Math.Abs(w - chromium.Value));
                    if (Math.Abs(w - chromium.Value) > boxPx + 1e-6)
                        failures.Add(style.Name + " kerned line at scale " + scale + ": width " + w + " device px, Chromium " + chromium.Value + " (limit ±" + boxPx + ")");
                }
                checkedLabels += labels.Count;
                summary.Add("scale " + scale + ": " + labels.Count + " labels, largest |height − n×L| " + worstH.ToString("0.###") + " device px, largest |baseline − Chromium| " + worstB.ToString("0.###") + " device px, largest |kerned line width − Chromium| " + worstW.ToString("0.###") + " device px");
                Dispose();
            }
            Debug.Log("Kit line-box styles on a panel (" + styles.Count + " styles × " + string.Join("/", LineCounts) + " lines):\n" + string.Join("\n", summary));
            Assert.AreEqual(styles.Count * LineCounts.Length * Scales.Length, checkedLabels);
            Assert.IsEmpty(failures, string.Join("\n", failures));
        }
    }
}
