using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using static DesignUi.Editor.Tests.TestIr;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// Exact text widths (<see cref="DesignTextFit"/>): UI Toolkit rounds a text's measured width up to whole device pixels,
    /// so text-sized elements in a row drift right by up to a device pixel each. A text or button whose width is its text's
    /// is compiled as a DesignLabel or DesignButton, which lays out at the generator's unrounded width.
    /// </summary>
    public class TextFitTests
    {
        static readonly Vector2Int Reference = new Vector2Int(2560, 1440);
        static readonly double[] Exact = { 1, 0.75, 0.5, 1.5 };
        static readonly (int w, int h)[] DefaultViewports = { (2560, 1440), (1920, 1080), (1280, 720), (3840, 2160), (1600, 900), (1366, 768) };
        static readonly string[] Words = { "Onayla", "Vazgeç", "Kaydet", "Geri", "Sil", "Paylaş", "Yenile", "Düzenle", "Ekle", "Kapat" };

        readonly List<Object> _objects = new List<Object>();

        [TearDown]
        public void Cleanup()
        {
            for (int i = _objects.Count - 1; i >= 0; i--)
                if (_objects[i] is GameObject g && g != null) Object.DestroyImmediate(g);
            for (int i = _objects.Count - 1; i >= 0; i--)
                if (_objects[i] != null) Object.DestroyImmediate(_objects[i]);
            _objects.Clear();
        }

        static IEnumerator Frames(int n)
        {
            for (int i = 0; i < n; i++) yield return null;
        }

        // ---- the compiler ---------------------------------------------------------------------------------------------

        static IrNode Button(string id, string text, params (string k, string v)[] style)
        {
            var n = Node(id, "button", style);
            n.Text = new IrText { Key = "test." + id, Tr = text, En = text };
            return n;
        }

        [Test]
        public void Compile_ATextOrButtonWhoseWidthIsItsTexts_IsADesignLabelOrButton_OthersStayAsTheyAre()
        {
            var row = Node("row", "container", ("display", "flex"), ("flex-direction", "row"), ("align-items", "center")).Add(
                Button("fit-button", "Onayla", ("padding-left", "32px"), ("padding-right", "32px")),
                Text("fit-label", "Kadro"),
                Text("sized", "Taktik", ("width", "120px")),
                Text("grown", "Maçlar", ("flex-grow", "1")),
                Text("min", "Finans", ("min-width", "80px")),
                Text("percent-padding", "Basın", ("padding-left", "5%")));
            var animated = Text("animated", "Gençlik");
            animated.Anims.AddRange(AnimationPlayerTests.BothWays("hover", 200, 0, "linear", "font-size"));
            row.Add(animated);
            var stretched = Node("stretched-col", "container", ("display", "flex"), ("flex-direction", "column")).Add(Text("stretched", "Tesisler"));
            var aligned = Node("aligned-col", "container", ("display", "flex"), ("flex-direction", "column"), ("align-items", "flex-start")).Add(Text("aligned", "Ayarlar"));
            var spanning = Text("spanning", "Yardım", ("position", "absolute"), ("left", "0px"), ("right", "0px"));
            var pinned = Text("pinned", "Kapat", ("position", "absolute"), ("left", "10px"), ("top", "10px"));
            var screen = ScreenBuilder.Build(TestIr.Screen(Root(row, stretched, aligned, spanning, pinned)), RelativeAsset, null, null);
            var fit = screen.Root.DescendantsAndSelf().Where(e => e.FitWidth).Select(e => e.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray();
            CollectionAssert.AreEqual(new[] { "aligned", "fit-button", "fit-label", "pinned" }, fit);
            var uxml = UxmlWriter.Write(screen, "s.uss");
            StringAssert.Contains("<" + ScreenBuilder.FitButtonTag + " name=\"fit-button\"", uxml);
            StringAssert.Contains("<" + ScreenBuilder.FitLabelTag + " name=\"fit-label\"", uxml);
            StringAssert.Contains("<ui:Label name=\"sized\"", uxml);
            StringAssert.Contains("<ui:Label name=\"stretched\"", uxml);
            var uss = UssWriter.Write(screen);
            StringAssert.Contains("DesignLabel, DesignButton {\n    " + ScreenBuilder.TextFitProperty + ": 1;\n}", uss);
        }

        [Test]
        public void Compile_AnItemTemplateWithAnExactWidthText_DeclaresTheRuntimeNamespace()
        {
            var item = Node("item", "container", ("display", "flex"), ("flex-direction", "row")).Add(Text("item-name", "Ad"));
            var list = Node("list", "container", ("display", "flex"), ("flex-direction", "column")).Add(item);
            list.Repeat = new IrRepeat { Name = "item", Mode = "inline", Count = 2 };
            var screen = ScreenBuilder.Build(TestIr.Screen(Root(list)), RelativeAsset, null, null);
            var repeat = screen.Repeats.Single();
            Assert.IsTrue(repeat.Items.SelectMany(i => i.DescendantsAndSelf()).Any(e => e.FitWidth));
            StringAssert.Contains("xmlns:dui=\"" + ScreenBuilder.RuntimeNamespace + "\"", UxmlWriter.WriteItemTemplate(repeat));
        }

        [Test]
        public void Snap_CeilsOnTheDeviceGridOfTheScale_ForgivingTheRenderersDifference()
        {
            Assert.AreEqual(70, DesignTextFit.Snap(69.469f, 1), 1e-4, "a tab's text at 2560×1440 (Chromium: 70)");
            Assert.AreEqual(105 / 1.5, DesignTextFit.Snap(69.469f, 1.5), 1e-4, "at 3840×2160: 104.2 device px takes 105");
            Assert.AreEqual(44 / 0.625, DesignTextFit.Snap(69.469f, 0.625), 1e-4, "at 1600×900: 43.4 device px takes 44");
            Assert.AreEqual(86, DesignTextFit.Snap(86.003f, 1), 1e-4, "86.003 is the browser's 86, not 87");
            Assert.AreEqual(87, DesignTextFit.Snap(86.03f, 1), 1e-4, "beyond the tolerance it is the next pixel");
            Assert.AreEqual(4, DesignTextFit.SnapBorder(4, 1), 1e-6, "whole at an exact scale");
            Assert.AreEqual(3 / 0.625, DesignTextFit.SnapBorder(4, 0.625), 1e-4, "2.5 device px at 1600×900: Chromium's 3");
            Assert.AreEqual(3 / 0.62499994, DesignTextFit.SnapBorder(4, 0.62499994), 1e-4, "also at a panel's float 0.625");
            Assert.AreEqual(2 / 0.533464, DesignTextFit.SnapBorder(4, 0.533464), 1e-4, "2.13 device px at 1366×768: 2");
            Assert.AreEqual(1 / 0.5, DesignTextFit.SnapBorder(1, 0.5), 1e-6, "at least one device pixel");
            Assert.AreEqual(0, DesignTextFit.SnapBorder(0, 0.625), "no border");
        }

        // ---- the runtime ------------------------------------------------------------------------------------------------

        static double ScaleOf(int w, int h) => BoxesWriter.Scale(new Vector2Int(w, h), Reference, 0.5f);

        UIDocument Document(int w, int h)
        {
            var settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _objects.Add(settings);
            settings.scaleMode = PanelScaleMode.ScaleWithScreenSize;
            settings.referenceResolution = Reference;
            settings.match = 0.5f;
            settings.scale = 1f;
            var rt = new RenderTexture(w, h, 24);
            _objects.Add(rt);
            settings.targetTexture = rt;
            var go = new GameObject("TextFitTests");
            _objects.Add(go);
            var doc = go.AddComponent<UIDocument>();
            doc.panelSettings = settings;
            return doc;
        }

        static FontDefinition BodyBold()
        {
            var bold = FontFixture.Kept(FontFixture.BoldTtf, "Kept Table Bold");
            var twin = FontTwinGenerator.GetOrCreateTwin(bold, FontFixture.KeptFolder + "/FitTwins", FontTwinGenerator.LineBox.For(24, 32));
            DesignText.Prepare(twin, string.Concat(Words));
            return FontDefinition.FromSDFFont(twin);
        }

        /// <summary>A row of ten text-sized buttons at (64, y): 32 px padding, 4 px borders, 24 px apart, body bold.</summary>
        static List<Button> Row(VisualElement parent, float y, bool fit, FontDefinition font)
        {
            var row = new VisualElement();
            row.style.position = Position.Absolute;
            row.style.left = 64;
            row.style.top = y;
            row.style.flexDirection = FlexDirection.Row;
            row.style.alignItems = Align.Center;
            parent.Add(row);
            var buttons = new List<Button>();
            foreach (var word in Words)
            {
                var b = fit ? new DesignButton() : new Button();
                b.text = word;
                b.style.height = 64;
                b.style.paddingLeft = 32;
                b.style.paddingRight = 32;
                b.style.paddingTop = 0;
                b.style.paddingBottom = 0;
                b.style.marginLeft = 0;
                b.style.marginRight = 24;
                foreach (var side in new Action<float>[] { v => b.style.borderLeftWidth = v, v => b.style.borderRightWidth = v, v => b.style.borderTopWidth = v, v => b.style.borderBottomWidth = v })
                    side(4);
                b.style.fontSize = 24;
                b.style.unityFontDefinition = font;
                b.style.flexShrink = 0;
                row.Add(b);
                buttons.Add(b);
            }
            return buttons;
        }

        /// <summary>
        /// A row of ten text-sized buttons at every default viewport (the scaled ones through the root scale). Each DesignButton
        /// starts where the browser puts it: the sum of the widths before it, each text's width ceiled on the device grid of the
        /// actual scale (Chromium's rule, <see cref="DesignTextFit.Snap"/>) plus paddings, borders on whole device pixels
        /// (<see cref="DesignTextFit.SnapBorder"/>) and gaps, times the actual
        /// scale, within a device pixel however far along the row; the same row of plain Buttons is logged beside it (UI
        /// Toolkit ceils on the grid of the scale it lays out at).
        /// </summary>
        [UnityTest]
        public IEnumerator ARowOfTenTextSizedButtons_StartsWhereTheDesignPutsEach_AtEveryDefaultViewport()
        {
            var font = BodyBold();
            // one layout first: a font the test made a moment ago lays its first text out before the kerning pairs of its new
            // glyphs arrive (docs/findings/text-ink.md), and an element keeps that first width until something changes it
            var warm = Document(2560, 1440);
            yield return Frames(2);
            Row(warm.rootVisualElement, 100, false, font);
            yield return Frames(6);
            Object.DestroyImmediate(warm.gameObject);
            var report = new List<string>();
            var failures = new List<string>();
            foreach (var (w, h) in DefaultViewports)
            {
                var doc = Document(w, h);
                yield return Frames(2);
                var screen = new DesignScreen { ExactScales = DesignViewportScales.Encode(Exact) };
                screen.style.width = 2560;
                screen.style.height = 1440;
                doc.rootVisualElement.Add(screen);
                var fit = Row(screen, 100, true, font);
                var plain = Row(screen, 300, false, font);
                yield return Frames(10);
                double actual = ScaleOf(w, h), ppp = screen.panel.scaledPixelsPerPoint;
                double x = 64, worstFit = 0, worstPlain = 0;
                for (int i = 0; i < Words.Length; i++)
                {
                    var exactText = ((DesignButton)fit[i]).Fit.TextWidth();
                    Assert.IsFalse(float.IsNaN(exactText), "the text's exact width");
                    double expected = x * actual;
                    double fitX = fit[i].worldBound.x * ppp, plainX = plain[i].worldBound.x * ppp;
                    worstFit = Math.Max(worstFit, Math.Abs(fitX - expected));
                    worstPlain = Math.Max(worstPlain, Math.Abs(plainX - expected));
                    if (Math.Abs(fitX - expected) > 1 + 1e-3) failures.Add(w + "×" + h + " button " + (i + 1) + ": x " + fitX.ToString("0.###") + " device px, the design's " + expected.ToString("0.###") +
                        " (fit width " + ((DesignButton)fit[i]).Fit.Width + ", border " + fit[i].resolvedStyle.borderLeftWidth + ", text " + exactText + ", layout " + fit[i].layout.width + ")");
                    // the browser's width: the text's, ceiled on the device grid of the actual scale
                    x += DesignTextFit.Snap(exactText, actual) + 2 * 32 + 2 * DesignTextFit.SnapBorder(4, actual) + 24;
                }
                report.Add(w + "×" + h + ": largest |x − design| " + worstFit.ToString("0.###") + " device px with exact widths, " + worstPlain.ToString("0.###") + " without");
                Object.DestroyImmediate(doc.gameObject);
                yield return null;
            }
            Debug.Log("A row of ten text-sized buttons:\n" + string.Join("\n", report));
            Assert.IsEmpty(failures, string.Join("\n", failures));
        }

        /// <summary>
        /// A new text is measured again; a parent without room for the text takes the exact width off (the element keeps UI
        /// Toolkit's own width and may wrap, as the design would) and it comes back when the parent has room again.
        /// </summary>
        [UnityTest]
        public IEnumerator ANewText_IsMeasuredAgain_AndAParentWithoutRoomTakesTheExactWidthOff()
        {
            var font = BodyBold();
            var doc = Document(2560, 1440);
            yield return Frames(2);
            var box = new VisualElement();
            box.style.position = Position.Absolute;
            box.style.left = 10;
            box.style.top = 10;
            box.style.width = 1000;
            box.style.flexDirection = FlexDirection.Row;
            doc.rootVisualElement.Add(box);
            var label = new DesignLabel("Kadro");
            label.style.fontSize = 24;
            label.style.unityFontDefinition = font;
            box.Add(label);
            yield return Frames(4);
            var short1 = label.Fit.TextWidth();
            Assert.AreEqual(DesignTextFit.Snap(short1, 1), label.Fit.Width, 1e-3, "laid out at the browser's width for its text");
            Assert.AreEqual(Math.Ceiling(short1 - DesignTextFit.Tolerance), label.layout.width, 1e-3, "a whole device pixel at scale 1");
            Assert.AreEqual(WhiteSpace.NoWrap, label.resolvedStyle.whiteSpace);

            label.text = "Kadro ve taktik";
            yield return Frames(4);
            var longer = label.Fit.TextWidth();
            Assert.Greater(longer, short1 + 50);
            Assert.AreEqual(DesignTextFit.Snap(longer, 1), label.Fit.Width, 1e-3, "measured again for the new text");

            box.style.width = 60; // no room: the design wraps the text there
            yield return Frames(6);
            Assert.IsNaN(label.Fit.Width, "the exact width is off");
            Assert.AreEqual(StyleKeyword.Null, label.style.width.keyword);
            Assert.AreNotEqual(WhiteSpace.NoWrap, label.resolvedStyle.whiteSpace, "the design's white-space");
            Assert.Greater(label.layout.height, 40, "the text wraps");

            box.style.width = 1000;
            yield return Frames(6);
            Assert.AreEqual(DesignTextFit.Snap(longer, 1), label.Fit.Width, 1e-3, "back to the browser's width");
        }
    }
}
