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
            Assert.AreEqual(39 / 0.625, DesignTextFit.Snap(38.0174f / 0.625f, 0.625), 1e-3, "a text just over a pixel (Unity 38.0174, the browser 38.0176 device px) takes the next one");
            Assert.AreEqual(129 / 1.5, DesignTextFit.Snap(129.01f / 1.5f, 1.5), 1e-3, "the browser's 129 px at 3840×2160 is Unity's 129.0100");
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
            settings.hideFlags = HideFlags.DontSave; // a copy no save writes: the Editor holds the exact scale's factor only there
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

        static FontDefinition BodyBold(string name = "Kept Table Bold")
        {
            var bold = FontFixture.Kept(FontFixture.BoldTtf, name);
            var twin = FontTwinGenerator.GetOrCreateTwin(bold, FontFixture.KeptFolder + "/FitTwins", FontTwinGenerator.LineBox.For(24, 32));
            DesignText.Prepare(twin, string.Concat(Words) + " ");
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
        /// A row of ten text-sized buttons at every default viewport (the scaled ones through the root scale), against the
        /// golden's row: Chromium's text width of each word at that viewport (<c>Data/chromium-row-buttons.json</c>, measured with
        /// the kit's fonts) ceiled on the device grid as the exporter lays a text-sized box out (pageTextCeil), plus padding,
        /// borders on whole device pixels and gaps. Each DesignButton starts within half a device pixel of it however far
        /// along the row; plain Buttons (UI Toolkit ceils on the grid of the scale it lays out at, with no tolerance) are a
        /// whole device pixel off at an exact viewport ("Vazgeç" is 86 px in Chromium and 86.0100 in Unity, and takes 87),
        /// so the limit tells the two apart.
        /// </summary>
        [UnityTest]
        public IEnumerator ARowOfTenTextSizedButtons_StartsWhereTheGoldenPutsEach_AtEveryDefaultViewport()
        {
            var golden = Newtonsoft.Json.Linq.JObject.Parse(File.ReadAllText(IrReaderTests.PackagePath("Tests", "Editor", "Data", "chromium-row-buttons.json")));
            CollectionAssert.AreEqual(Words, golden["words"].ToObject<string[]>(), "the words Data/tools~/chromium-row-buttons.mts measured");
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
            double worstPlainExact = 0;
            foreach (var (w, h) in DefaultViewports)
            {
                var chromium = golden["widths"]?[w + "x" + h]?.ToObject<double[]>();
                Assert.IsNotNull(chromium, "Chromium's widths at " + w + "×" + h + " (rebuild Data/chromium-row-buttons.json with Data/tools~/chromium-row-buttons.mts)");
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
                double x = 64 * actual, worstFit = 0, worstPlain = 0;
                double border = Math.Max(1, Math.Floor(4 * actual + 0.5)); // device px
                for (int i = 0; i < Words.Length; i++)
                {
                    Assert.IsTrue(DesignTextFit.Supported, "DesignTextFit reads the text handle's unrounded width through internal members " +
                                  "(TextElement.uitkTextHandle, UITKTextHandle.MeasuredWidth) that Unity " + Application.unityVersion + " does not have: find their replacement");
                    double fitX = fit[i].worldBound.x * ppp, plainX = plain[i].worldBound.x * ppp;
                    worstFit = Math.Max(worstFit, Math.Abs(fitX - x));
                    worstPlain = Math.Max(worstPlain, Math.Abs(plainX - x));
                    if (Math.Abs(fitX - x) > 0.5 + 1e-3) failures.Add(w + "×" + h + " button " + (i + 1) + ": x " + fitX.ToString("0.###") + " device px, the golden's " + x.ToString("0.###") +
                        " (fit width " + ((DesignButton)fit[i]).Fit.Width + ", Unity's text " + ((DesignButton)fit[i]).Fit.TextWidth() + ", Chromium's " + chromium[i] / actual + ")");
                    // the golden's box: Chromium's text width ceiled on the device grid forgiving the exporter's tolerance
                    // (pageTextCeil, TEXT_CEIL_TOLERANCE, the same as DesignTextFit.Tolerance), padding, borders, the gap
                    x += Math.Ceiling(chromium[i] - DesignTextFit.Tolerance) + 2 * 32 * actual + 2 * border + 24 * actual;
                }
                report.Add(w + "×" + h + ": largest |x − golden| " + worstFit.ToString("0.###") + " device px with exact widths, " + worstPlain.ToString("0.###") + " without; Unity − Chromium text, device px: " +
                           string.Join(" ", Enumerable.Range(0, Words.Length).Select(i => (((DesignButton)fit[i]).Fit.TextWidth() * actual - chromium[i]).ToString("+0.0000;-0.0000"))));
                if (Math.Abs(actual - DesignViewportScales.LayoutScale(Exact, actual)) < 1e-4) worstPlainExact = Math.Max(worstPlainExact, worstPlain);
                Object.DestroyImmediate(doc.gameObject);
                yield return null;
            }
            Debug.Log("A row of ten text-sized buttons:\n" + string.Join("\n", report));
            Assert.IsEmpty(failures, string.Join("\n", failures));
            Assert.Greater(worstPlainExact, 0.5 + 1e-3, "plain Buttons drift past the limit at an exact viewport (the limit tells the two apart)");
        }

        /// <summary>
        /// A new text is measured again; a row without room for the text takes the exact width off (the element keeps UI
        /// Toolkit's own width and wraps, as the design does) and it comes back when the row has room again.
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
            Assert.AreEqual(DesignTextFit.Snap(short1, 1), label.layout.width, 1e-3, "a whole device pixel at scale 1");
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
            Assert.IsFalse(label.Fit.Wrapping, "one line again");
            Assert.AreEqual(DesignTextFit.Snap(longer, 1), label.Fit.Width, 1e-3, "back to the browser's width");
            Assert.AreEqual(WhiteSpace.NoWrap, label.resolvedStyle.whiteSpace);
        }

        /// <summary>
        /// Ruling R134: a text whose font lacks its characters when the fit first measures it still lays out at the browser's
        /// width. The fit checks only the face that draws the text (<see cref="DesignText.DrawingFace"/>: the weight table's
        /// bold face for a bold text, the font itself for a normal one), so a face of the weight table that never draws it (the
        /// bold face under a normal text, which nothing ever gives the characters) does not hold it at UI Toolkit's width for
        /// good; a face that lacks the characters gets them when UI Toolkit lays the text out or draws it, and the fit measures
        /// once more after that draw, with their kerning pairs: the same width as a bold text whose characters and pairs were
        /// added before it was laid out (the compiler's and <see cref="DesignText.SetText"/>'s path).
        /// </summary>
        [UnityTest]
        public IEnumerator AText_WhoseFaceLacksItsCharactersAtTheFirstMeasure_GetsTheBrowsersWidthAfterTheDraw()
        {
            const string text = "BÖLÜM BAŞLIĞI AVATAR";
            UnityEngine.TextCore.Text.FontAsset Twin(string name)
            {
                var regular = FontFixture.Kept(FontFixture.RegularTtf, name);
                var bold = FontFixture.Kept(FontFixture.BoldTtf, name + " Bold");
                if (regular.fontWeightTable[7].regularTypeface != bold) FontFixture.SetWeight(regular, 700, bold);
                return FontTwinGenerator.GetOrCreateTwin(regular, FontFixture.KeptTwinFolder + "/R134");
            }
            var twin = Twin("Kept R134");
            var boldTwin = twin.fontWeightTable[7].regularTypeface;
            Assert.IsNotNull(boldTwin, "the bold face in the twin's weight table");
            Assert.AreSame(boldTwin, DesignText.DrawingFace(twin, FontStyle.Bold));
            Assert.AreSame(twin, DesignText.DrawingFace(twin, FontStyle.Normal));
            // the normal face holds the text with its kerning pairs, the bold face none of it
            twin.TryAddCharacters(text, out _, true);
            DesignText.CompleteFeatures(twin);
            DesignText.ClearPairFlags(twin);
            Assert.IsTrue(DesignText.Drawable(twin, FontStyle.Normal, text));
            Assert.IsFalse(DesignText.Drawable(twin, FontStyle.Bold, text), "the bold face lacks the text");

            var doc = Document(2560, 1440);
            yield return Frames(2);
            DesignLabel Add(UnityEngine.TextCore.Text.FontAsset font, FontStyle style, float top)
            {
                var l = new DesignLabel(text);
                l.style.position = Position.Absolute;
                l.style.left = 100;
                l.style.top = top;
                l.style.fontSize = 24;
                l.style.unityFontDefinition = FontDefinition.FromSDFFont(font);
                l.style.unityFontStyleAndWeight = style;
                doc.rootVisualElement.Add(l);
                return l;
            }
            // a normal text: its bold face never draws it, so never gets the characters
            var normal = Add(twin, FontStyle.Normal, 100);
            yield return Frames(8);
            Assert.IsFalse(DesignText.Drawable(twin, FontStyle.Bold, text), "nothing gave the bold face the text");
            Assert.IsFalse(float.IsNaN(normal.Fit.Width), "a face of the weight table that does not draw the text does not hold it at UI Toolkit's width");
            Assert.AreEqual(DesignTextFit.Snap(normal.Fit.TextWidth(), 1), normal.Fit.Width, 1e-3);
            Assert.AreEqual(normal.Fit.Width, normal.layout.width, 1e-3, "laid out at it");

            // a bold text: the face that draws it lacks the characters at the first measure
            var bold = Add(twin, FontStyle.Bold, 200);
            yield return Frames(8);
            Assert.IsTrue(DesignText.Drawable(twin, FontStyle.Bold, text), "UI Toolkit gave the bold face the text when it laid it out or drew it");
            Assert.IsFalse(float.IsNaN(bold.Fit.Width), "measured once more after the draw");
            Assert.AreEqual(DesignTextFit.Snap(bold.Fit.TextWidth(), 1), bold.Fit.Width, 1e-3);
            Assert.AreEqual(bold.Fit.Width, bold.layout.width, 1e-3, "laid out at it");

            // the same bold text on a twin whose faces got the characters and their pairs before it was laid out
            var prepared = Twin("Kept R134 Prepared");
            DesignText.Prepare(prepared, text);
            Assert.IsTrue(DesignText.Drawable(prepared, FontStyle.Bold, text));
            var reference = Add(prepared, FontStyle.Bold, 300);
            yield return Frames(8);
            Assert.IsFalse(float.IsNaN(reference.Fit.Width));
            Assert.AreEqual(reference.Fit.TextWidth(), bold.Fit.TextWidth(), 1e-3, "the same text width: the pairs of the characters the draw added count");
            Assert.AreEqual(reference.Fit.Width, bold.Fit.Width, 1e-3);
        }

        /// <summary>
        /// Ruling R136 (a language switched while a screen is open kept its labels at their earlier text's width): a
        /// text-sized label measures its text again whenever the text changes after its first layout, however it is written
        /// (a <c>text</c> write, which sends a change event, and a write without one, as a binding or a list makes it), and
        /// when its font changes with it (a locale switch brings the locale's font and its text in one frame); nothing is
        /// measured on frames where neither changed.
        /// </summary>
        [UnityTest]
        public IEnumerator AText_ChangedAfterItsFirstLayout_IsMeasuredAgain_HoweverItIsWritten()
        {
            var bold = BodyBold();
            var regular = FontFixture.Kept(FontFixture.RegularTtf, "Kept R136 Regular");
            var regularTwin = FontTwinGenerator.GetOrCreateTwin(regular, FontFixture.KeptFolder + "/FitTwins", FontTwinGenerator.LineBox.For(24, 32));
            DesignText.Prepare(regularTwin, string.Concat(Words) + " ");
            var doc = Document(2560, 1440);
            yield return Frames(2);
            var label = new DesignLabel("Düzenle Paylaş Yenile");
            label.style.position = Position.Absolute;
            label.style.left = 100;
            label.style.top = 100;
            label.style.fontSize = 24;
            label.style.unityFontDefinition = bold;
            doc.rootVisualElement.Add(label);
            yield return Frames(6);
            void Laid(string what)
            {
                var text = label.Fit.TextWidth();
                Assert.IsFalse(float.IsNaN(text), what + ": measured");
                Assert.AreEqual(DesignTextFit.Snap(text, 1), label.Fit.Width, 1e-3, what + ": the browser's width for " + label.text);
                Assert.AreEqual(label.Fit.Width, label.layout.width, 1e-3, what + ": laid out at it");
            }
            Laid("the first text");
            float first = label.Fit.Width;

            label.text = "Sil";
            yield return Frames(6);
            Laid("a much shorter text");
            Assert.Less(label.Fit.Width, first / 3);
            label.text = "Düzenle Paylaş Yenile Kaydet Onayla Vazgeç";
            yield return Frames(6);
            Laid("a much longer text");
            Assert.Greater(label.Fit.Width, first * 1.5f);

            // written without a change event (a binding, a list rebinding an item)
            ((INotifyValueChanged<string>)label).SetValueWithoutNotify("Geri");
            yield return Frames(6);
            Laid("a much shorter text written without a change event");
            ((INotifyValueChanged<string>)label).SetValueWithoutNotify("Kaydet Onayla Vazgeç Paylaş Düzenle");
            yield return Frames(6);
            Laid("a much longer text written without a change event");

            // a locale switch: another font and another text in one frame
            float boldWidth = label.Fit.Width;
            label.style.unityFontDefinition = FontDefinition.FromSDFFont(regularTwin);
            ((INotifyValueChanged<string>)label).SetValueWithoutNotify("Kaydet Onayla Vazgeç Paylaş Düzenle");
            yield return Frames(6);
            Laid("the same text in another font");
            Assert.Less(label.Fit.Width, boldWidth - 4, "the regular face is narrower than the bold one");
            label.style.unityFontDefinition = bold;
            ((INotifyValueChanged<string>)label).SetValueWithoutNotify("Ekle");
            yield return Frames(6);
            Laid("another font and another text in one frame");

            // nothing changes: nothing is measured
            int measures = label.Fit.Measures;
            for (int i = 0; i < 10; i++) { label.MarkDirtyRepaint(); yield return null; }
            Assert.AreEqual(measures, label.Fit.Measures, "a repaint of the same text in the same font measures nothing");
        }

        /// <summary>
        /// Fix round 1, I-2: a label whose text is empty repaints without asking for another measure (its font and style are
        /// recorded with its text, so a repaint of the same empty text shows nothing new), also when its font changes.
        /// </summary>
        [UnityTest]
        public IEnumerator AnEmptyLabel_RepaintsWithoutAskingForAnotherMeasure()
        {
            var font = BodyBold();
            var doc = Document(2560, 1440);
            yield return Frames(2);
            var label = new DesignLabel("");
            label.style.position = Position.Absolute;
            label.style.left = 100;
            label.style.top = 100;
            label.style.fontSize = 24;
            label.style.unityFontDefinition = font;
            doc.rootVisualElement.Add(label);
            yield return Frames(6);
            int requests = label.Fit.ChangeRequests;
            for (int i = 0; i < 10; i++) { label.MarkDirtyRepaint(); yield return null; }
            Assert.AreEqual(requests, label.Fit.ChangeRequests, "ten repaints of the same empty text ask for no measure");
            Assert.IsTrue(float.IsNaN(label.Fit.Width), "an empty text keeps UI Toolkit's own width");
            label.text = "Kaydet";
            yield return Frames(6);
            Assert.AreEqual(DesignTextFit.Snap(label.Fit.TextWidth(), 1), label.Fit.Width, 1e-3, "a text after it is measured");
        }

        /// <summary>
        /// Fix round 1, M-1: a label measured while its face holds the characters but not yet their kerning pairs (another
        /// label's layout added them this frame, TextCore brings their pairs through its update queue) is measured again once
        /// the pairs are there: the same width as the same text measured on that face afterwards (before: 262.23 against
        /// 249.41 panel px). The pairs TextCore's own add brings are not all of them (a pair whose first glyph the face held
        /// before is missing: 248.54 with <see cref="DesignText.Prepare"/>'s complete pairs); UI Toolkit draws with the face's.
        /// </summary>
        [UnityTest]
        public IEnumerator ALabelMeasuredBeforeItsFacesKerningPairsArrive_IsMeasuredAgainWithThem()
        {
            const string first = "Kaydet", text = "AVATAR Toyota Wave";
            UnityEngine.TextCore.Text.FontAsset Twin(string name) =>
                FontTwinGenerator.GetOrCreateTwin(FontFixture.Kept(FontFixture.BoldTtf, name), FontFixture.KeptTwinFolder + "/M1");
            var twin = Twin("Kept M1 Bold");
            DesignText.Prepare(twin, first);
            var doc = Document(2560, 1440);
            yield return Frames(2);
            var label = new DesignLabel(first);
            label.style.position = Position.Absolute;
            label.style.left = 100;
            label.style.top = 100;
            label.style.fontSize = 24;
            label.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
            doc.rootVisualElement.Add(label);
            yield return Frames(6);
            Assert.IsFalse(float.IsNaN(label.Fit.Width));

            // another label's layout adds the characters to the face (TextCore brings their kerning pairs through its update
            // queue), and this label's text is set in that label's geometry callback, before the pairs are there
            var newly = typeof(UnityEngine.TextCore.Text.FontAsset).GetField("m_GlyphIndexListNewlyAdded",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
            int pendingThen = -1;
            var other = new Label(text);
            other.style.position = Position.Absolute;
            other.style.left = 100;
            other.style.top = 300;
            other.style.fontSize = 24;
            other.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
            EventCallback<GeometryChangedEvent> rebind = null;
            rebind = _ =>
            {
                other.UnregisterCallback(rebind);
                pendingThen = (newly?.GetValue(twin) as System.Collections.IList)?.Count ?? -1;
                label.text = text;
            };
            other.RegisterCallback(rebind);
            doc.rootVisualElement.Add(other);
            yield return Frames(8);
            Assert.AreEqual(text, label.text);
            Debug.Log("M-1: glyphs waiting for their pairs when the label's text was set: " + pendingThen);
            // the same text measured on the same face now that the queue brought the pairs (what UI Toolkit draws it with)
            var reference = new DesignLabel(text);
            reference.style.position = Position.Absolute;
            reference.style.left = 100;
            reference.style.top = 200;
            reference.style.fontSize = 24;
            reference.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
            doc.rootVisualElement.Add(reference);
            yield return Frames(8);
            Debug.Log("M-1 widths: label " + label.Fit.Width + " (text " + label.Fit.TextWidth() + "), measured after the pairs " + reference.Fit.Width + " (text " + reference.Fit.TextWidth() + ")");
            Assert.AreEqual(reference.Fit.TextWidth(), label.Fit.TextWidth(), 1e-3, "the text width with the pairs");
            Assert.AreEqual(reference.Fit.Width, label.Fit.Width, 1e-3, "and its box");
            Assert.AreEqual(label.Fit.Width, label.layout.width, 1e-3, "laid out at it");
        }

        /// <summary>
        /// A row of bordered tabs at 1600×900 just too short for the golden's widths: the golden's box of each (Chromium's
        /// border on whole device pixels, 4.8 panel px a side, the text ceiled on the 0.625 grid) is wider than UI Toolkit's own
        /// (borders 4, the text on the 0.75 grid), and the row's width lies between the two sums. The row takes the exact
        /// widths off once and keeps UI Toolkit's own; they come back when the row has room again, and in a row of the same
        /// width with room (a list binding the label elsewhere) and at another resolution (1920×1080), where what the first row
        /// had no room for says nothing. Each tab's width is the same on every frame after the release, with no width written.
        /// </summary>
        [UnityTest]
        public IEnumerator ATightRowOfBorderedTabs_AtAScaledViewport_KeepsItsWidths()
        {
            // a twin of its own: the shared one can come from earlier tests with characters UI Toolkit added while laying text
            // out, whose kerning pairs came later, and UI Toolkit's own widths keep that unkerned layout (the fit measures the
            // kerned text since ruling R134), so the plain row would not be UI Toolkit's own widths of the prepared text
            var font = BodyBold("Kept Tabs Bold");
            var doc = Document(1600, 900);
            yield return Frames(2);
            var screen = new DesignScreen { ExactScales = DesignViewportScales.Encode(Exact) };
            screen.style.width = 2560;
            screen.style.height = 1440;
            doc.rootVisualElement.Add(screen);
            var words = Words.Take(6).ToArray();
            VisualElement MakeRow(float y, bool fit, out List<Button> tabs)
            {
                var row = new VisualElement();
                row.style.position = Position.Absolute;
                row.style.left = 64;
                row.style.top = y;
                row.style.flexDirection = FlexDirection.Row;
                screen.Add(row);
                tabs = new List<Button>();
                foreach (var word in words)
                {
                    var b = fit ? new DesignButton() : new Button();
                    b.text = word;
                    b.style.height = 64;
                    b.style.paddingLeft = 16;
                    b.style.paddingRight = 16;
                    b.style.marginLeft = 0;
                    b.style.marginRight = 0;
                    foreach (var side in new Action<float>[] { v => b.style.borderLeftWidth = v, v => b.style.borderRightWidth = v, v => b.style.borderTopWidth = v, v => b.style.borderBottomWidth = v })
                        side(4);
                    b.style.fontSize = 24;
                    b.style.unityFontDefinition = font;
                    if (!fit) b.style.flexShrink = 0;
                    row.Add(b);
                    tabs.Add(b);
                }
                return row;
            }
            var fitRow = MakeRow(100, true, out var fitTabs);
            MakeRow(300, false, out var plainTabs);
            yield return Frames(10);
            float box = fitTabs.Sum(t => ((DesignButton)t).Fit.Width), own = plainTabs.Sum(t => t.layout.width);
            float grid = 1f / screen.panel.scaledPixelsPerPoint + 0.01f;
            Assert.Greater(box - own, words.Length * grid, "the golden's boxes are wider than UI Toolkit's own by more than the layout grid each");
            // between the sums: UI Toolkit's own widths fit, the golden's do not (a tab flipping between the two widths writes
            // its width on every layout, until UI Toolkit gives up on the frame's layout with "Layout update is struggling")
            var before = fitTabs.Select(t => ((DesignButton)t).Fit.Writes).ToArray();
            fitRow.style.width = own + 0.25f * words.Length;
            yield return null;
            var widths = fitTabs.Select(t => t.layout.width).ToArray();
            for (int frame = 0; frame < 10; frame++)
            {
                yield return null;
                for (int i = 0; i < words.Length; i++)
                    Assert.AreEqual(widths[i], fitTabs[i].layout.width, 1e-4, "tab " + (i + 1) + " on frame " + frame);
            }
            int released = 0;
            for (int i = 0; i < words.Length; i++)
            {
                var fit = ((DesignButton)fitTabs[i]).Fit;
                Assert.LessOrEqual(fit.Writes - before[i], 1, "tab " + (i + 1) + ": its width taken off at most once, never put back in the same room");
                if (float.IsNaN(fit.Width)) released++;
                else Assert.GreaterOrEqual(fitTabs[i].layout.width, fit.Width - grid, "tab " + (i + 1) + ": an exact width the row has room for");
            }
            Assert.Greater(released, 0, "the row took the exact width off its tabs (UI Toolkit's own widths fit, the golden's do not)");
            // (the struggling layout logs an error, which fails the test too)

            // a released tab bound into another row of the same width with room for it (a list rebinding a label): what its
            // first row had no room for says nothing there
            var movedTab = fitTabs.First(t => float.IsNaN(((DesignButton)t).Fit.Width));
            var row2 = new VisualElement();
            row2.style.position = Position.Absolute;
            row2.style.left = 64;
            row2.style.top = 500;
            row2.style.flexDirection = FlexDirection.Row;
            row2.style.width = fitRow.style.width;
            screen.Add(row2);
            row2.Add(movedTab);
            yield return Frames(8);
            Assert.IsFalse(float.IsNaN(((DesignButton)movedTab).Fit.Width), movedTab.text + ": its exact width in a row with room");
            fitRow.Insert(fitTabs.IndexOf(movedTab), movedTab);
            yield return Frames(8);

            // a resolution change to 1920×1080 (the same exact scale, the golden's widths at it fit the row): what the row had no
            // room for at 1600×900 says nothing there, every tab takes its exact width
            var rt1920 = new RenderTexture(1920, 1080, 24);
            _objects.Add(rt1920);
            doc.panelSettings.targetTexture = rt1920;
            yield return Frames(8);
            Assert.AreEqual(0.75, screen.DesignScale ?? double.NaN, 1e-4, "1920×1080");
            foreach (var t in fitTabs)
            {
                var fit = ((DesignButton)t).Fit;
                Assert.IsFalse(float.IsNaN(fit.Width), t.text + ": its exact width at 1920×1080");
                Assert.AreEqual(fit.Width, t.layout.width, 1f / screen.panel.scaledPixelsPerPoint + 0.01f, t.text + ": laid out at it");
            }
            doc.panelSettings.targetTexture = (RenderTexture)_objects.Find(o => o is RenderTexture r && r.width == 1600);
            yield return Frames(8);
            // room again: the golden's widths
            fitRow.style.width = box + 50;
            yield return Frames(8);
            foreach (var t in fitTabs) Assert.IsFalse(float.IsNaN(((DesignButton)t).Fit.Width), t.text + ": the golden's width when the row has room");
        }

        // ---- text the design wraps -------------------------------------------------------------------------------------

        static T Styled<T>(T label, FontDefinition font) where T : Label
        {
            label.style.fontSize = 24;
            label.style.unityFontDefinition = font;
            return label;
        }

        static VisualElement Container(VisualElement parent, float x, float y, FlexDirection direction, float height = float.NaN)
        {
            var c = new VisualElement();
            c.style.position = Position.Absolute;
            c.style.left = x;
            c.style.top = y;
            c.style.width = 300;
            if (!float.IsNaN(height)) c.style.height = height;
            c.style.flexDirection = direction;
            c.style.alignItems = Align.FlexStart;
            parent.Add(c);
            return c;
        }

        /// <summary>
        /// A text the design wraps keeps wrapping where its line has no room, as the browser lays it out: in a 300 px column
        /// whose items are aligned to the start and as an absolute child at left 10 px of a 300 px box, its box is as wide as
        /// its room (the browser's fit-content: 300 and 290 px) and the text wraps there with the design's white-space (a plain
        /// Label is as wide as its widest line in the column and does not wrap at all as an absolute child); in a row inside
        /// such a column the row narrows it, the exact width comes off and it lays out as a Label does (its widest line, 297
        /// px; the browser's row shrinks it to 300). A short text in the same places gets its exact width on one line.
        /// </summary>
        [UnityTest]
        public IEnumerator AWrappingText_WithoutRoom_InAColumn_AsAnAbsoluteChild_OrInARowInAColumn_WrapsAtItsRoom()
        {
            var font = BodyBold();
            var doc = Document(2560, 1440);
            yield return Frames(2);
            var root = doc.rootVisualElement;
            string longText = string.Join(" ", Words) + " " + string.Join(" ", Words);
            var cases = new List<(string what, DesignLabel fit, Label plain, bool wraps, float room)>();
            float x = 10;
            foreach (var (text, wraps) in new[] { (longText, true), ("Kaydet", false) })
            {
                {
                    var fit = Styled(new DesignLabel(text), font);
                    var plain = Styled(new Label(text), font);
                    Container(root, x, 10, FlexDirection.Column).Add(fit);
                    Container(root, x, 700, FlexDirection.Column).Add(plain);
                    cases.Add(("a flex-start column", fit, plain, wraps, 300));
                    x += 320;
                }
                {
                    var fit = Styled(new DesignLabel(text), font);
                    var plain = Styled(new Label(text), font);
                    foreach (var l in new Label[] { fit, plain })
                    {
                        l.style.position = Position.Absolute;
                        l.style.left = 10;
                        l.style.top = 10;
                    }
                    Container(root, x, 10, FlexDirection.Column, 600).Add(fit);
                    Container(root, x, 700, FlexDirection.Column, 600).Add(plain);
                    cases.Add(("an absolute child", fit, plain, wraps, 290));
                    x += 320;
                }
                {
                    var fit = Styled(new DesignLabel(text), font);
                    var plain = Styled(new Label(text), font);
                    var fitRow = new VisualElement();
                    fitRow.style.flexDirection = FlexDirection.Row;
                    fitRow.Add(fit);
                    var plainRow = new VisualElement();
                    plainRow.style.flexDirection = FlexDirection.Row;
                    plainRow.Add(plain);
                    Container(root, x, 10, FlexDirection.Column).Add(fitRow);
                    Container(root, x, 700, FlexDirection.Column).Add(plainRow);
                    cases.Add(("a row in a flex-start column", fit, plain, wraps, float.NaN));
                    x += 320;
                }
            }
            yield return Frames(10);
            var failures = new List<string>();
            var report = new List<string>();
            foreach (var (what, fit, plain, wraps, room) in cases)
            {
                string at = (wraps ? "a long text in " : "a short text in ") + what;
                report.Add(at + ": " + fit.layout.size + " (Label " + plain.layout.size + ")");
                if (fit.resolvedStyle.whiteSpace == WhiteSpace.NoWrap && wraps) failures.Add(at + ": nowrap");
                if (wraps && float.IsNaN(room))
                {
                    if (!float.IsNaN(fit.Fit.Width)) failures.Add(at + ": still has an exact width " + fit.Fit.Width);
                    if (Math.Abs(fit.layout.width - plain.layout.width) > 0.01f || Math.Abs(fit.layout.height - plain.layout.height) > 0.01f)
                        failures.Add(at + ": " + fit.layout.size + ", a Label " + plain.layout.size);
                    if (fit.layout.height < 40) failures.Add(at + ": does not wrap (" + fit.layout.size + ")");
                }
                else if (wraps)
                {
                    if (!fit.Fit.Wrapping) failures.Add(at + ": not wrapping at its room (width " + fit.Fit.Width + ")");
                    if (Math.Abs(fit.layout.width - room) > 0.01f) failures.Add(at + ": " + fit.layout.width + " px wide, its room " + room);
                    if (fit.layout.height < 40) failures.Add(at + ": does not wrap (" + fit.layout.size + ")");
                }
                else
                {
                    var text = fit.Fit.TextWidth();
                    if (fit.Fit.Wrapping || Math.Abs(fit.Fit.Width - DesignTextFit.Snap(text, 1)) > 1e-3) failures.Add(at + ": no exact width (" + fit.Fit.Width + ", text " + text + ")");
                    if (fit.layout.height > 40) failures.Add(at + ": wraps (" + fit.layout.size + ")");
                }
            }
            Debug.Log("Wrapping texts:\n" + string.Join("\n", report));
            Assert.IsEmpty(failures, string.Join("\n", failures));

            // the room grows: the long text in the column fits on one line again and gets its exact width
            var column = cases[0].fit;
            column.parent.style.width = 2000;
            yield return Frames(6);
            Assert.IsFalse(column.Fit.Wrapping, "one line again");
            Assert.AreEqual(DesignTextFit.Snap(column.Fit.TextWidth(), 1), column.Fit.Width, 1e-3);
            Assert.AreEqual(WhiteSpace.NoWrap, column.resolvedStyle.whiteSpace);
        }

        // ---- a compiled screen: state changes reach the exact width -----------------------------------------------------

        const string Out = "Assets/DesignUiTextFitTests";

        /// <summary>
        /// A compiled exact-width label (its rule's custom property makes UI Toolkit report style changes) is measured again when
        /// a state changes its size, and back; an animated colour (the animation player's inline writes, every frame) measures
        /// nothing: the measure is kept for the same text in the same style at the same scale.
        /// </summary>
        [UnityTest]
        public IEnumerator ACompiledExactWidthText_IsMeasuredAgainForAState_AndAnAnimatedColourMeasuresNothing()
        {
            try
            {
                var dir = Path.Combine(Path.GetTempPath(), "design-ui-textfit-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
                Directory.CreateDirectory(dir);
                var family = "\"" + FontFixture.Regular.faceInfo.familyName + "\"";
                var tab = Text("tab", "Kadro", ("font-size", "24px"), ("font-family", family), ("color", "#ffffff"));
                tab.With("state:big", ("font-size", "32px"));
                var row = Node("row", "container", ("display", "flex"), ("flex-direction", "row"), ("position", "absolute"), ("left", "100px"), ("top", "100px")).Add(tab);
                var ir = TestIr.Screen(Node("root", "container", ("position", "relative"), ("width", "2560px"), ("height", "1440px")).Add(row), "textfit.screen");
                ir.States = new[] { "default", "big" };
                File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), Newtonsoft.Json.JsonConvert.SerializeObject(ir, Newtonsoft.Json.Formatting.Indented));
                var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
                _objects.Add(profile);
                profile.outputFolder = Out;
                FontFixture.Use(profile);
                var result = ScreenCompiler.Compile(dir, profile, false, NoView());
                Directory.Delete(dir, true);
                Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
                var tree = UnityEditor.AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/TextfitScreen/TextfitScreen.uxml");
                var doc = Document(2560, 1440);
                yield return Frames(2);
                var instance = tree.Instantiate();
                doc.rootVisualElement.Add(instance);
                var screen = instance.Q<DesignScreen>("root");
                var label = instance.Q<DesignLabel>("tab");
                Assert.IsNotNull(label, "compiled as a DesignLabel");
                DesignText.Prepare(label.resolvedStyle.unityFontDefinition.fontAsset, "Kadro");
                yield return Frames(4);
                // a style change after the glyphs arrived (a text whose glyphs arrive when drawn keeps UI Toolkit's width until one)
                screen.AddToClassList(ScreenBuilder.StateClassPrefix + "big");
                yield return Frames(4);
                screen.RemoveFromClassList(ScreenBuilder.StateClassPrefix + "big");
                yield return Frames(4);
                float small = label.Fit.Width;
                Assert.IsFalse(float.IsNaN(small), "the exact width");
                Assert.AreEqual(DesignTextFit.Snap(label.Fit.TextWidth(), 1), small, 1e-3);
                screen.AddToClassList(ScreenBuilder.StateClassPrefix + "big");
                yield return Frames(4);
                Assert.AreEqual(32, label.resolvedStyle.fontSize, 1e-3);
                Assert.AreEqual(DesignTextFit.Snap(label.Fit.TextWidth(), 1), label.Fit.Width, 1e-3, "measured again in the state");
                Assert.Greater(label.Fit.Width, small * 1.25f, "the state's larger text");
                screen.RemoveFromClassList(ScreenBuilder.StateClassPrefix + "big");
                yield return Frames(4);
                Assert.AreEqual(small, label.Fit.Width, 1e-3, "and back");

                int events = 0;
                label.RegisterCallback<CustomStyleResolvedEvent>(_ => events++);
                int measures = label.Fit.Measures;
                for (int i = 0; i < 10; i++)
                {
                    DesignAnimProperties.Write(label, DesignAnimProperty.Color, new DesignAnimValue { X = i / 10f, Y = 1, Z = 1, W = 1 });
                    yield return null;
                }
                DesignAnimProperties.Clear(label, DesignAnimProperty.Color);
                yield return Frames(2);
                Debug.Log("An inline colour written on 10 frames: " + events + " CustomStyleResolvedEvent(s) on the label, " + (label.Fit.Measures - measures) + " measure(s)");
                Assert.AreEqual(measures, label.Fit.Measures, "an animated colour measures nothing");
            }
            finally
            {
                if (UnityEditor.AssetDatabase.IsValidFolder(Out)) UnityEditor.AssetDatabase.DeleteAsset(Out);
                FontFixture.Delete();
            }
        }
    }
}
