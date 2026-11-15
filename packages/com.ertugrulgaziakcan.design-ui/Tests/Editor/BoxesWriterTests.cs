using System;
using System.Collections;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using static DesignUi.Editor.Tests.TestIr;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace DesignUi.Editor.Tests
{
    /// <summary>Unity boxes in the exporter's boxes.json schema (device px, visibility rule, text lines with baselines).</summary>
    public class BoxesWriterTests
    {
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;
        string _temp;

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) UnityEngine.Object.DestroyImmediate(_go);
            if (_settings != null) UnityEngine.Object.DestroyImmediate(_settings);
            if (_rt != null) UnityEngine.Object.DestroyImmediate(_rt);
            if (_temp != null && Directory.Exists(_temp)) Directory.Delete(_temp, true);
            _temp = null;
        }

        [OneTimeTearDown]
        public void DeleteFonts() => FontFixture.Delete();

        /// <summary>A write goes to a temporary file first: one that fails (or a run killed midway) leaves the previous file whole.</summary>
        [Test]
        public void WriteAll_ThatFailsMidway_LeavesThePreviousFileWhole()
        {
            _temp = Path.Combine(Path.GetTempPath(), "design-ui-boxes-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_temp);
            var path = Path.Combine(_temp, BoxesWriter.FileName);
            BoxesWriter.WriteAll(path, new JObject { ["a"] = new JObject { ["capture"] = "a" } });
            var before = File.ReadAllText(path);
            Directory.CreateDirectory(path + ".tmp"); // the temporary file cannot be written
            Assert.Catch(() => BoxesWriter.WriteAll(path, new JObject { ["b"] = new JObject { ["capture"] = "b" } }));
            Assert.AreEqual(before, File.ReadAllText(path), "the previous file, whole");
            Directory.Delete(path + ".tmp");
            BoxesWriter.WriteAll(path, new JObject { ["b"] = new JObject { ["capture"] = "b" } });
            StringAssert.Contains("\"b\"", File.ReadAllText(path));
            Assert.IsFalse(File.Exists(path + ".tmp"), "no temporary file left");
        }

        [TestCase(2560, 1440, 1.0)]
        [TestCase(1920, 1080, 0.75)]
        [TestCase(1280, 720, 0.5)]
        public void Scale_At16By9_IsTheViewportOverTheReference(int w, int h, double expected)
        {
            Assert.AreEqual(expected, BoxesWriter.Scale(new Vector2Int(w, h), new Vector2Int(2560, 1440), 0.5f), 1e-12);
        }

        [Test]
        public void Scale_OfAnotherAspect_LerpsTheRatiosLinearly_AsPanelSettingsDoes()
        {
            // PanelSettings.ResolveScale (6000.3): Mathf.Lerp(W / refW, H / refH, match), not a lerp of the logarithms
            Assert.AreEqual(Math.Round((2400 / 2560.0 + 1.0) / 2 * 1e9) / 1e9, BoxesWriter.Scale(new Vector2Int(2400, 1440), new Vector2Int(2560, 1440), 0.5f), 1e-12);
            Assert.AreEqual(Math.Round((0.75 * 2000 / 2560.0 + 0.25 * 1000 / 1440.0) * 1e9) / 1e9, BoxesWriter.Scale(new Vector2Int(2000, 1000), new Vector2Int(2560, 1440), 0.25f), 1e-12);
        }

        /// <summary>A panel at 1 panel px = 1 RenderTexture px with the given tree under its document root.</summary>
        VisualElement Panel(VisualElement tree)
        {
            _rt = new RenderTexture(400, 300, 24);
            _settings = UnityEngine.Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _go = new GameObject("BoxesWriterTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            doc.rootVisualElement.Add(tree);
            return tree;
        }

        static IrNode TextNode(string id, string kind, string text)
        {
            var n = Node(id, kind);
            n.Text = new IrText { Tr = text };
            return n;
        }

        [UnityTest]
        public IEnumerator Measure_WritesDevicePixels_TheVisibilityRule_AndTextLinesWithBaselines()
        {
            var twin = FontTwinGenerator.GetOrCreateTwin(FontFixture.Regular, FontFixture.TwinFolder);
            var root = new VisualElement { name = "root" };
            root.style.width = 400;
            root.style.height = 300;
            root.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
            root.style.fontSize = 20;
            var label = new Label("alpha beta gamma delta epsilon") { name = "label" };
            label.style.width = 90;
            label.style.paddingTop = 4;
            label.style.paddingLeft = 3;
            label.style.marginLeft = 10;
            var hidden = new Label("gone") { name = "hidden" };
            hidden.style.display = DisplayStyle.None;
            var ghostParent = new VisualElement { name = "ghost-parent" };
            ghostParent.style.opacity = 0;
            var ghost = new VisualElement { name = "ghost" };
            ghost.style.height = 10;
            ghostParent.Add(ghost);
            var invisible = new VisualElement { name = "invisible" };
            invisible.style.height = 6;
            invisible.style.visibility = Visibility.Hidden;
            var button = new Button { name = "btn", text = "Go" };
            var field = new TextField { name = "field", value = "abc" };
            var empty = new Label("") { name = "empty" };
            root.Add(label);
            root.Add(hidden);
            root.Add(ghostParent);
            root.Add(invisible);
            root.Add(button);
            root.Add(field);
            root.Add(empty);
            Panel(root);
            for (int i = 0; i < 6; i++) yield return null;

            var ghostNode = Node("ghost", "container");
            ghostNode.External = true;
            var ir = TestIr.Screen(Root(TextNode("label", "text", "alpha"), TextNode("hidden", "text", "gone"),
                Node("ghost-parent", "container").Add(ghostNode), Node("invisible", "container"), TextNode("btn", "button", "Go"),
                TextNode("field", "input", "abc"), TextNode("empty", "text", ""), Node("not-in-unity", "container")));
            const double scale = 0.5;
            var capture = BoxesWriter.Measure("default@200x150", root, new Vector2Int(200, 150), scale, ir);

            CollectionAssert.AreEquivalent(new[] { "capture", "viewport", "scale", "elements", "external" }, capture.Properties().Select(p => p.Name));
            Assert.AreEqual("default@200x150", (string)capture["capture"]);
            CollectionAssert.AreEqual(new[] { 200, 150 }, capture["viewport"].Values<int>());
            Assert.AreEqual(scale, (double)capture["scale"]);
            CollectionAssert.AreEqual(new[] { "ghost" }, capture["external"].Values<string>());
            var els = (JObject)capture["elements"];
            Assert.IsNull(els["not-in-unity"], "an IR element Unity does not have is left out (removed wrappers)");
            foreach (var p in els.Properties())
                CollectionAssert.AreEquivalent(new[] { "x", "y", "w", "h", "visible", "text", "lines" }, ((JObject)p.Value).Properties().Select(x => x.Name), p.Name);

            var lb = (JObject)els["label"];
            var wb = label.worldBound;
            Assert.AreEqual(wb.x * scale, (double)lb["x"], 1e-4);
            Assert.AreEqual(wb.y * scale, (double)lb["y"], 1e-4);
            Assert.AreEqual(wb.width * scale, (double)lb["w"], 1e-4);
            Assert.AreEqual(wb.height * scale, (double)lb["h"], 1e-4);
            Assert.IsTrue((bool)lb["visible"]);
            Assert.IsTrue((bool)lb["text"]);
            var lines = (JArray)lb["lines"];
            Assert.Greater(lines.Count, 1, "the 90 px wide label wraps");
            var face = twin.faceInfo;
            double ascent = face.ascentLine * 20.0 / face.pointSize, pitch = face.lineHeight * 20.0 / face.pointSize;
            Assert.AreEqual((wb.y + 4 + ascent) * scale, (double)lines[0]["baseline"], 0.01, "line top (the content box top) + the font's ascent");
            Assert.AreEqual((wb.y + 4) * scale, (double)lines[0]["y"], 0.01);
            Assert.AreEqual((wb.x + 3) * scale, (double)lines[0]["x"], 0.01, "a left-aligned line starts at the content box");
            for (int i = 1; i < lines.Count; i++)
                Assert.AreEqual(pitch * scale, (double)lines[i]["baseline"] - (double)lines[i - 1]["baseline"], 0.01, "UI Toolkit's line pitch");
            foreach (var l in lines)
                CollectionAssert.AreEquivalent(new[] { "x", "y", "w", "h", "baseline" }, ((JObject)l).Properties().Select(x => x.Name));

            var hb = (JObject)els["hidden"];
            Assert.IsFalse((bool)hb["visible"]);
            Assert.AreEqual(0.0, (double)hb["x"] + (double)hb["y"] + (double)hb["w"] + (double)hb["h"], "no box: display none");
            Assert.IsTrue((bool)hb["text"]);
            Assert.IsEmpty((JArray)hb["lines"]);

            var gb = (JObject)els["ghost"];
            Assert.IsFalse((bool)gb["visible"], "an ancestor with opacity 0");
            Assert.Greater((double)gb["h"], 0.0, "it keeps its box");
            Assert.IsFalse((bool)els["invisible"]["visible"], "visibility hidden");
            Assert.Greater((double)els["invisible"]["h"], 0.0);

            Assert.AreEqual(1, ((JArray)els["btn"]["lines"]).Count, "a button that carries its own text reports its line");
            Assert.IsTrue((bool)els["field"]["text"]);
            Assert.IsEmpty((JArray)els["field"]["lines"], "form controls report no lines (not compared)");
            Assert.IsEmpty((JArray)els["empty"]["lines"], "an empty text has no line");
            Assert.IsFalse((bool)els["ghost-parent"]["text"]);
        }

        /// <summary>
        /// The repeat items' copies (named by the sample filler: <c>row#2</c>, the first item inside a later outer item
        /// <c>cell#0#1</c>) are written as <c>items</c>, with their boxes and visibility; elements outside a repeat, names that are
        /// no item suffix and the IR's own elements are not. Without an items root, or without repeat copies, there is no
        /// <c>items</c>.
        /// </summary>
        [UnityTest]
        public IEnumerator Measure_WritesTheRepeatItemsCopies_ByTheirNames()
        {
            var twin = FontTwinGenerator.GetOrCreateTwin(FontFixture.Regular, FontFixture.TwinFolder);
            var root = new VisualElement { name = "root" };
            root.style.width = 400;
            root.style.height = 300;
            root.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
            var list = new VisualElement { name = "list" };
            root.Add(list);
            VisualElement Row(string suffix, bool shown)
            {
                var row = new VisualElement { name = "row" + suffix };
                row.style.height = 20;
                row.style.marginTop = 4;
                row.style.flexDirection = FlexDirection.Row;
                if (!shown) row.style.visibility = Visibility.Hidden;
                var inner = suffix == "" ? "" : "#0" + suffix;
                var cell = new VisualElement { name = "cell" + inner };
                cell.style.height = 10;
                cell.style.width = 30;
                row.Add(cell);
                var label = new Label("Row " + suffix.TrimStart('#')) { name = "label" + inner };
                label.style.fontSize = 12;
                row.Add(label);
                list.Add(row);
                return row;
            }
            Row("", true);
            Row("#1", true);
            Row("#2", false);
            root.Add(new VisualElement { name = "loose#1" });     // not inside a repeat in the IR
            root.Add(new VisualElement { name = "row#x" });       // not an item suffix
            Panel(root);
            for (int i = 0; i < 6; i++) yield return null;

            var rows = Node("list", "container");
            rows.Repeat = new IrRepeat { Name = "rows", Mode = "inline", Count = 3 };
            var cells = Node("row", "container");
            cells.Repeat = new IrRepeat { Name = "cells", Mode = "inline", Count = 1 };
            var ir = TestIr.Screen(Root(rows.Add(cells.Add(Node("cell", "container"), TextNode("label", "text", "Row"))), Node("loose", "container")));
            const double scale = 0.5;
            var capture = BoxesWriter.Measure("default@200x150", id => BoxesWriter.Find(root, id), new Vector2Int(200, 150), scale, ir, root);
            var items = (JObject)capture["items"];
            Assert.IsNotNull(items);
            CollectionAssert.AreEqual(new[] { "cell#0#1", "cell#0#2", "label#0#1", "label#0#2", "row#1", "row#2" }, items.Properties().Select(p => p.Name));
            var r1 = list[1].worldBound;
            Assert.AreEqual(r1.y * scale, (double)items["row#1"]["y"], 1e-4);
            Assert.AreEqual(r1.height * scale, (double)items["row#1"]["h"], 1e-4);
            Assert.IsTrue((bool)items["row#1"]["visible"]);
            Assert.IsFalse((bool)items["row#2"]["visible"], "visibility hidden");
            Assert.AreEqual((list[0].worldBound.y + 24) * scale, (double)items["row#1"]["y"], 1e-4, "a pitch below the first row");
            CollectionAssert.AreEquivalent(new[] { "x", "y", "w", "h", "visible", "text", "lines" }, ((JObject)items["row#1"]).Properties().Select(p => p.Name));
            Assert.IsFalse((bool)items["row#1"]["text"]);
            Assert.IsEmpty((JArray)items["cell#0#1"]["lines"]);
            // a copy of a text has its own lines, measured as the IR element's (ruling R133): a pitch below the first row's
            var first = (JArray)capture["elements"]["label"]["lines"];
            var copy = (JArray)items["label#0#1"]["lines"];
            Assert.IsTrue((bool)items["label#0#1"]["text"]);
            Assert.AreEqual(1, first.Count);
            Assert.AreEqual(1, copy.Count);
            Assert.AreEqual((double)first[0]["baseline"] + 24 * scale, (double)copy[0]["baseline"], 1e-4);
            Assert.AreEqual((double)first[0]["x"], (double)copy[0]["x"], 1e-4);
            Assert.Greater((double)copy[0]["w"], 0);
            Assert.IsNull(BoxesWriter.Measure("default@200x150", root, new Vector2Int(200, 150), scale, ir)["items"], "no items root: no items");
            var plain = TestIr.Screen(Root(Node("list", "container").Add(Node("row", "container"))));
            Assert.IsNull(BoxesWriter.Measure("c", id => BoxesWriter.Find(root, id), new Vector2Int(200, 150), scale, plain, root)["items"], "no repeat in the IR: no items");
        }

        [UnityTest]
        public IEnumerator Measure_FractionalFontSize_UsesTheWholePixelSizeTheStandardGeneratorSetsTheTextAt()
        {
            var twin = FontTwinGenerator.GetOrCreateTwin(FontFixture.Regular, FontFixture.TwinFolder);
            var root = new VisualElement { name = "root" };
            root.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
            var label = new Label("one two three four five six") { name = "label" };
            label.style.fontSize = 16.515625f;
            label.style.width = 60;
            root.Add(label);
            Panel(root);
            for (int i = 0; i < 6; i++) yield return null;

            var face = twin.faceInfo;
            double ratio = face.lineHeight / face.pointSize;
            var ir = TestIr.Screen(Root(TextNode("label", "text", "x")));
            var lines = (JArray)BoxesWriter.Measure("default@400x300", root, new Vector2Int(400, 300), 1, ir)["elements"]["label"]["lines"];
            Assert.Greater(lines.Count, 1);
            Assert.AreEqual(Math.Ceiling(lines.Count * 17 * ratio), label.worldBound.height, 1e-3, "measured on 6000.3: the standard text generator lays 16.515625 px out at 17 px");
            Assert.AreEqual(label.worldBound.y, (double)lines[0]["y"], 0.01, "the first line starts at the top of the label");
            Assert.AreEqual(label.worldBound.y + face.ascentLine * 17.0 / face.pointSize, (double)lines[0]["baseline"], 0.01);
            Assert.AreEqual(17 * ratio, (double)lines[1]["baseline"] - (double)lines[0]["baseline"], 0.01);
        }

        [Test]
        public void Merge_KeepsOtherCaptures_ReplacesTheSameName_AndRemoveDeletesOne()
        {
            _temp = Path.Combine(Path.GetTempPath(), "design-ui-boxes-" + Guid.NewGuid().ToString("N"));
            var file = Path.Combine(_temp, "boxes.json");
            JObject Capture(string name, double x) => new JObject
            {
                ["capture"] = name, ["viewport"] = new JArray(10, 10), ["scale"] = 1.0, ["external"] = new JArray(),
                ["elements"] = new JObject { ["root"] = new JObject { ["x"] = x, ["y"] = 0.0, ["w"] = 10.0, ["h"] = 10.0, ["visible"] = true, ["text"] = false, ["lines"] = new JArray() } },
            };
            BoxesWriter.Merge(file, Capture("b@10x10", 1));
            BoxesWriter.Merge(file, Capture("a@10x10", 2));
            BoxesWriter.Merge(file, Capture("b@10x10", 3));
            var all = JObject.Parse(File.ReadAllText(file));
            CollectionAssert.AreEqual(new[] { "a@10x10", "b@10x10" }, all.Properties().Select(p => p.Name), "sorted keys");
            Assert.AreEqual(3.0, (double)all["b@10x10"]["elements"]["root"]["x"]);
            Assert.AreEqual(2.0, (double)all["a@10x10"]["elements"]["root"]["x"]);
            StringAssert.DoesNotContain("\r", File.ReadAllText(file));

            BoxesWriter.Remove(file, "a@10x10");
            CollectionAssert.AreEqual(new[] { "b@10x10" }, JObject.Parse(File.ReadAllText(file)).Properties().Select(p => p.Name));
        }
    }
}
