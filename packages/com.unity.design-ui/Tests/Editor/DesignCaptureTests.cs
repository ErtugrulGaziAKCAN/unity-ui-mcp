using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using static DesignUi.Editor.Tests.TestIr;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The Unity capture of a compiled screen (spec 15) and its batch entry point. <see cref="CaptureFromEnv"/> runs every
    /// job of an export's <c>goldens/matrix.json</c> when <c>DESIGN_UI_EXPORT</c> is set (see the repository README);
    /// otherwise it passes without capturing ("not configured"). A capture counts only with the capture-done marker in
    /// its output folder.
    /// </summary>
    public class DesignCaptureTests
    {
        const string Out = "Assets/DesignUiCaptureTests";
        const string Labels = "{ \"label\": { \"fontSize\": 16, \"lineHeight\": 20, \"weight\": 400 }, " +
                              "\"body\": { \"fontSize\": 24, \"lineHeight\": 30, \"weight\": 400 }, " +
                              "\"title\": { \"fontSize\": 32, \"lineHeight\": 36, \"weight\": 400 } }";

        readonly List<string> _temp = new List<string>();
        readonly List<UnityEngine.Object> _objects = new List<UnityEngine.Object>();

        // ---- the batch entry point ---------------------------------------------------------------------------

        static string Env(params string[] names) =>
            names.Select(Environment.GetEnvironmentVariable).FirstOrDefault(v => !string.IsNullOrEmpty(v));

        /// <summary>
        /// Captures every job of <c>$DESIGN_UI_EXPORT/goldens/matrix.json</c> into <c>$DESIGN_UI_OUT</c>, named like the
        /// goldens, with the compiled screen <c>$DESIGN_UI_SCREEN</c> (default: the profile's output folder and the
        /// screen's name) and the profile <c>$DESIGN_UI_PROFILE</c> (default: the project's only DesignUiProfile).
        /// </summary>
        [UnityTest]
        public IEnumerator CaptureFromEnv()
        {
            var export = Env("DESIGN_UI_EXPORT", "DESIGN_UI_EXPORT_DIR");
            // not a capture run: nothing to do; a runner reads a capture only from the capture-done marker of its output folder
            if (export == null) Assert.Pass("not configured; nothing captured (set DESIGN_UI_EXPORT and DESIGN_UI_OUT)");
            var outDir = Env("DESIGN_UI_OUT", "DESIGN_UI_OUT_DIR");
            Assert.IsNotNull(outDir, "DESIGN_UI_OUT names the folder the captures are written to");
            var profile = DesignCapture.LoadProfile(Env("DESIGN_UI_PROFILE"));
            var screen = Env("DESIGN_UI_SCREEN") ?? DesignCapture.DefaultScreenFolder(export, profile);
            var result = new CaptureResult();
            yield return DesignCapture.CaptureAll(export, screen, profile, outDir, result);
            Debug.Log("Design UI capture: " + result.Captured.Count + " captured, " + result.NotCaptured.Count + " not captured into " + outDir +
                      string.Concat(result.NotCaptured.Select(n => "\n  not captured " + n.Capture + ": " + n.Reason)));
            Assert.IsEmpty(result.Errors, string.Join("\n", result.Errors));
        }

        // ---- fixtures ----------------------------------------------------------------------------------------

        [TearDown]
        public void Cleanup()
        {
            foreach (var o in _objects) if (o != null) UnityEngine.Object.DestroyImmediate(o);
            _objects.Clear();
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
        }

        [OneTimeTearDown]
        public void DeleteFonts() => FontFixture.Delete();

        string TempDir()
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-capture-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            return dir;
        }

        DesignUiProfile Profile(Vector2Int reference, float match)
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            _objects.Add(p);
            p.outputFolder = Out;
            p.referenceResolution = reference;
            p.screenMatch = match;
            FontFixture.Use(p);
            return p;
        }

        /// <summary>A 320×180 reference screen (small captures), match 0.5, states default and loading.</summary>
        static IrScreen Small(IrNode root)
        {
            var ir = TestIr.Screen(root, "capture.test");
            ir.ReferenceViewport = new[] { 320, 180 };
            ir.Viewports = new[] { new[] { 320, 180 } };
            ir.ScreenMatch = 0.5f;
            ir.Breakpoints = new IrBreakpoint[0];
            return ir;
        }

        static IrNode Box(string id, string color, params (string k, string v)[] more) =>
            Node(id, "container", new[] { ("height", "40px"), ("width", "100px"), ("flex-shrink", "0"), ("background-color", color) }.Concat(more).ToArray());

        /// <summary>A baked 9-slice shadow below the element: the compiler wraps it in a shadow host.</summary>
        static IrNode Shadowed(IrNode n)
        {
            n.Shadow = new IrShadow
            {
                Kind = "shadow9", File = ShadowFile, Sha256 = new string('d', 64), Width = 8, Height = 8,
                Slice = new float[] { 2, 2, 2, 2 }, Offset = new BoxRect { X = 0, Y = 4, W = 0, H = 0 },
            };
            return n;
        }

        /// <summary>A screen root that paints the whole panel black.</summary>
        static IrNode BlackRoot(params IrNode[] kids) =>
            Root(kids).With("base", ("background-color", "#000000"), ("display", "flex"), ("flex-direction", "column"), ("width", "100%"), ("height", "100%"));

        static void AssertNear(string expected, Color32 actual, int tolerance, string message = null)
        {
            Assert.IsTrue(ColorUtility.TryParseHtmlString(expected, out var e));
            var c = (Color32)e;
            Assert.IsTrue(Math.Abs(c.r - actual.r) <= tolerance && Math.Abs(c.g - actual.g) <= tolerance && Math.Abs(c.b - actual.b) <= tolerance,
                (message ?? "") + ": expected " + expected + ", got " + Hex(actual));
        }

        static IrNode Words(string id, string tr, params (string k, string v)[] more)
        {
            var n = Text(id, tr, new[] { ("color", "#ffffff"), ("font-family", "Inter"), ("font-size", "16px") }.Concat(more).ToArray());
            n.Text.Style = "label";
            return n;
        }

        /// <summary>An export folder: screen.ir.json, text-styles.json, optional fixtures and goldens/matrix.json.</summary>
        string Export(IrScreen ir, string fixtures = null, string matrix = null)
        {
            var dir = TempDir();
            if (Assets(ir.Root).Any(a => a.File == ShadowFile))
            {
                var tex = new Texture2D(8, 8, TextureFormat.RGBA32, false);
                tex.SetPixels32(Enumerable.Repeat(new Color32(0, 0, 0, 128), 64).ToArray());
                var png = tex.EncodeToPNG();
                UnityEngine.Object.DestroyImmediate(tex);
                Directory.CreateDirectory(Path.Combine(dir, "assets"));
                File.WriteAllBytes(Path.Combine(dir, ShadowFile), png);
                SetHash(ir, ShadowFile, png);
            }
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));
            File.WriteAllText(Path.Combine(dir, KitTextStyles.FileName), Labels);
            if (fixtures != null)
            {
                Directory.CreateDirectory(Path.Combine(dir, "fixtures"));
                File.WriteAllText(Path.Combine(dir, "fixtures", IrFixtures.FileName), fixtures);
            }
            if (matrix != null)
            {
                Directory.CreateDirectory(Path.Combine(dir, "goldens"));
                File.WriteAllText(Path.Combine(dir, "goldens", "matrix.json"), matrix);
            }
            return dir;
        }

        /// <summary>Compiles the export without the view class (no script compilation in the test run); returns the screen folder.</summary>
        static string Compile(string export, DesignUiProfile profile)
        {
            var result = ScreenCompiler.Compile(export, profile, false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            return Out + "/" + Naming.Pascal(IrReader.Read(Path.Combine(export, ScreenCompiler.IrFileName)).Screen);
        }

        CaptureRequest Request(string export, string screen, string name, int w, int h, params CaptureApply[] apply) => new CaptureRequest
        {
            ExportDir = export, ScreenFolder = screen, CaptureName = name, Viewport = new Vector2Int(w, h), OutDir = TempDir(),
            State = name.Split('@')[0], Apply = apply.ToList(),
        };

        static Texture2D Png(CaptureRequest req)
        {
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false, true);
            Assert.IsTrue(tex.LoadImage(File.ReadAllBytes(Path.Combine(req.OutDir, req.CaptureName + ".png"))));
            return tex;
        }

        /// <summary>The pixel at device px (x, y), y from the top.</summary>
        static Color32 Pixel(Texture2D tex, int x, int y) => tex.GetPixel(x, tex.height - 1 - y);

        static string Hex(Color32 c) => "#" + c.r.ToString("x2") + c.g.ToString("x2") + c.b.ToString("x2");

        static JObject Boxes(CaptureRequest req) => (JObject)JObject.Parse(File.ReadAllText(Path.Combine(req.OutDir, "boxes.json")))[req.CaptureName];

        // ---- capture -----------------------------------------------------------------------------------------

        [UnityTest]
        public IEnumerator Run_Sample_At1920x1080_WritesAPngOfExactlyThatSize_AndBoxesInTheContractShape()
        {
            var ir = IrReader.Read(IrReaderTests.SamplePath());
            var export = TempDir();
            var fixtures = new Dictionary<string, string> { ["svg"] = "icon.svg", ["image"] = "image.png", ["shadow9"] = "shadow9.png" };
            foreach (var a in Assets(ir.Root))
            {
                var bytes = File.ReadAllBytes(IrReaderTests.PackagePath("Tests", "Editor", "Data", "assets~", fixtures[a.Kind]));
                Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(export, a.File)));
                File.WriteAllBytes(Path.Combine(export, a.File), bytes);
                SetHash(ir, a.File, bytes);
            }
            File.WriteAllText(Path.Combine(export, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));
            File.WriteAllText(Path.Combine(export, KitTextStyles.FileName), Labels);
            var profile = Profile(new Vector2Int(2560, 1440), ir.ScreenMatch);
            var screen = Compile(export, profile);

            var req = Request(export, screen, "default@1920x1080", 1920, 1080);
            yield return DesignCapture.Run(req, profile);

            var png = File.ReadAllBytes(Path.Combine(req.OutDir, "default@1920x1080.png"));
            Assert.AreEqual(1920, (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19], "PNG width");
            Assert.AreEqual(1080, (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23], "PNG height");

            var contract = JObject.Parse(File.ReadAllText(IrReaderTests.PackagePath("Tests", "Editor", "Data", "boxes-sample.json")));
            var boxes = Boxes(req);
            CollectionAssert.AreEquivalent(contract.Properties().Select(p => p.Name), boxes.Properties().Select(p => p.Name));
            var elementKeys = ((JObject)contract["elements"]["title"]).Properties().Select(p => p.Name).ToList();
            var lineKeys = ((JObject)contract["elements"]["title"]["lines"][0]).Properties().Select(p => p.Name).ToList();
            foreach (var e in ((JObject)boxes["elements"]).Properties())
            {
                CollectionAssert.AreEquivalent(elementKeys, ((JObject)e.Value).Properties().Select(p => p.Name), e.Name);
                foreach (var l in (JArray)e.Value["lines"]) CollectionAssert.AreEquivalent(lineKeys, ((JObject)l).Properties().Select(p => p.Name), e.Name);
            }
            CollectionAssert.AreEqual(new[] { 1920, 1080 }, boxes["viewport"].Values<int>());
            Assert.AreEqual(0.75, (double)boxes["scale"], 1e-9);
            var root = (JObject)boxes["elements"]["root"];
            Assert.AreEqual(1920.0, (double)root["w"], 1e-3, "the document root is stretched over the panel");
            Assert.AreEqual(1080.0, (double)root["h"], 1e-3);
            Assert.IsTrue((bool)boxes["elements"]["title"]["text"]);
            Assert.IsNull(boxes["elements"]["card__shadowhost"], "only IR elements are reported");
        }

        [UnityTest]
        public IEnumerator Run_FillsBindsArgumentsAndInlineRepeatItemsFromTheFixtures()
        {
            var title = Words("title", "Hoş geldin {name}");
            title.Text.Args = new[] { "name" };
            var club = Words("club", "Takım");
            club.Bind = "club";
            var subject = Words("subject", "Konu");
            subject.Bind = "subject";
            var row = Node("row", "container", ("height", "20px"), ("flex-shrink", "0"), ("background-color", "#123456"))
                .With("class:is-unread", ("background-color", "#16c2d5")).Add(subject);
            var mails = Node("mails", "container", ("display", "flex"), ("flex-direction", "column"), ("gap", "4px")).Add(row);
            mails.Repeat = new IrRepeat { Name = "mails", Mode = "inline", Count = 3 };
            var ir = Small(Root(title, club, mails));
            const string fixtures = "{ \"name\": \"Ali\", \"club\": \"Kartal\", \"mails\": [" +
                                    "{ \"subject\": \"Bir\", \"$classes\": { \"row\": [\"is-unread\"] } }, { \"subject\": \"İki\" }, " +
                                    "{ \"subject\": \"Üç\", \"$classes\": { \"row\": [\"is-unread\"] } } ] }";
            var export = Export(ir, fixtures);
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);

            var req = Request(export, screen, "default@320x180", 320, 180);
            var seen = false;
            req.Inspect = tree =>
            {
                seen = true;
                Assert.AreEqual("Hoş geldin Ali", tree.Q<Label>("title").text, "a Smart String argument");
                Assert.AreEqual("Kartal", tree.Q<Label>("club").text, "a bind");
                var container = tree.Q("mails");
                var items = container.Children().ToList();
                Assert.AreEqual(3, items.Count, "the fixture's three items");
                Assert.AreEqual("row", items[0].name, "the first item keeps the design ids");
                Assert.AreNotEqual("row", items[1].name);
                Assert.AreNotEqual("row", items[2].name);
                Assert.IsTrue(items[0].ClassListContains(ScreenBuilder.FirstItemClass));
                Assert.IsFalse(items[1].ClassListContains(ScreenBuilder.FirstItemClass), "only the first item is the first");
                CollectionAssert.AreEqual(new[] { true, false, true }, items.Select(i => i.ClassListContains("is-unread")), "each item's $classes");
                CollectionAssert.AreEqual(new[] { "Bir", "İki", "Üç" }, items.Select(i => i.Q<Label>().text));
                Assert.AreEqual(1, tree.Query(name: "subject").ToList().Count, "only the first item's elements carry the design ids");
                Assert.AreEqual(4f, items[1].resolvedStyle.marginTop, 0.01f, "the gap between items");
            };
            yield return DesignCapture.Run(req, profile);
            Assert.IsTrue(seen);
            var els = (JObject)Boxes(req)["elements"];
            Assert.AreEqual(1, ((JArray)els["subject"]["lines"]).Count);
            var tex = Png(req);
            var y = (int)((double)els["row"]["y"] + 2);
            Assert.AreEqual("#16c2d5", Hex(Pixel(tex, 90, y)), "the first item shows its fixture class");
        }

        [UnityTest]
        public IEnumerator Run_ListRepeat_FillsTheListViewSlotsFromTheFixtures()
        {
            var subject = Words("subject", "Konu");
            subject.Bind = "subject";
            var row = Node("row", "container", ("height", "20px"), ("flex-shrink", "0"), ("background-color", "#123456"))
                .With("class:is-unread", ("background-color", "#16c2d5")).Add(subject);
            var rows = Node("rows", "list", ("display", "flex"), ("flex-direction", "column"), ("height", "100px"), ("flex-shrink", "0"),
                ("overflow-y", "auto"), ("gap", "8px")).Add(row);
            rows.Repeat = new IrRepeat { Name = "mails", Mode = "list", Count = 2 };
            var ir = Small(Root(Box("top", "#222222"), rows));
            var export = Export(ir, "{ \"mails\": [ { \"subject\": \"Bir\", \"$classes\": { \"row\": [\"is-unread\"] } }, { \"subject\": \"İki\" } ] }");
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);

            var req = Request(export, screen, "default@320x180", 320, 180);
            var seen = false;
            req.Inspect = tree =>
            {
                seen = true;
                var list = tree.Q<ListView>("rows");
                Assert.AreEqual(2, list.itemsSource.Count);
                Assert.AreEqual("Bir", tree.Q<Label>("subject").text, "the first slot holds the first item with the design ids");
                Assert.IsTrue(tree.Q("row").ClassListContains("is-unread"));
                Assert.AreEqual(1, tree.Query(name: "row").ToList().Count);
                Assert.AreEqual(2, list.Query<Label>().ToList().Count(l => l.text == "Bir" || l.text == "İki"), "both items are bound");
            };
            yield return DesignCapture.Run(req, profile);
            Assert.IsTrue(seen);
            var els = (JObject)Boxes(req)["elements"];
            Assert.AreEqual((double)els["rows"]["y"], (double)els["row"]["y"], 1e-3, "the first item starts at the top of the list");
            Assert.AreEqual(20.0, (double)els["row"]["h"], 1e-3, "an item keeps its own height inside its slot");
            Assert.AreEqual("#16c2d5", Hex(Pixel(Png(req), 90, (int)(double)els["row"]["y"] + 2)));
        }

        [UnityTest]
        public IEnumerator Run_StatesClassesAndPseudoStates_AreAppliedLikeTheGoldens()
        {
            var tile = Box("tile", "#112233").With("hover", ("background-color", "#445566")).With("active", ("background-color", "#778899"));
            var tab = Box("tab", "#202020").With("class:is-selected", ("background-color", "#16c2d5"));
            var panel = Box("panel", "#303030").With("state:loading", ("background-color", "#ff8800"));
            var ir = Small(Root(tile, tab, panel).With("base", ("background-color", "#000000"), ("display", "flex"), ("flex-direction", "column"),
                ("width", "100%"), ("height", "100%")));
            var export = Export(ir);
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);

            IEnumerator Shot(string name, Action<Texture2D> check, params CaptureApply[] apply)
            {
                var req = Request(export, screen, name, 320, 180, apply);
                yield return DesignCapture.Run(req, profile);
                check(Png(req));
            }

            yield return Shot("default@320x180", t =>
            {
                Assert.AreEqual("#112233", Hex(Pixel(t, 50, 20)));
                Assert.AreEqual("#202020", Hex(Pixel(t, 50, 60)));
                Assert.AreEqual("#303030", Hex(Pixel(t, 50, 100)));
                Assert.AreEqual("#000000", Hex(Pixel(t, 200, 170)), "no sentinel left: the screen root covers the panel");
            });
            yield return Shot("default@320x180.hover.tile", t => Assert.AreEqual("#445566", Hex(Pixel(t, 50, 20)), ":hover from a real pointer move"),
                CaptureApply.Pseudo("hover", "tile"));
            yield return Shot("default@320x180.active.tile", t => Assert.AreEqual("#778899", Hex(Pixel(t, 50, 20)), ":active needs the manifest's Clickable"),
                CaptureApply.Pseudo("active", "tile"));
            yield return Shot("default@320x180.is-selected.tab", t => Assert.AreEqual("#16c2d5", Hex(Pixel(t, 50, 60))),
                CaptureApply.Class("is-selected", "tab"));
            yield return Shot("loading@320x180", t => Assert.AreEqual("#ff8800", Hex(Pixel(t, 50, 100)), "state class on the root"));
        }

        [UnityTest]
        public IEnumerator Run_DisabledAndChecked_UseTheControlsAndReachTheShadowHostMirror()
        {
            // opacity of a shadowed element moves to its shadow host, which shows the element's states as dui-* classes
            var go = Shadowed(Node("go", "button", ("height", "30px"), ("width", "80px"), ("flex-shrink", "0"), ("background-color", "#2fd1c5"))
                .With("disabled", ("opacity", "0.4")));
            var check = Shadowed(Node("check", "toggle", ("height", "20px"), ("width", "20px"), ("flex-shrink", "0"), ("margin-top", "20px"),
                ("background-color", "#ffffff")).With("checked", ("opacity", "0.5")));
            var export = Export(Small(BlackRoot(go, check)));
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var req = Request(export, screen, "default@320x180.disabled.go.checked.check", 320, 180,
                CaptureApply.Pseudo("disabled", "go"), CaptureApply.Pseudo("checked", "check"));
            var seen = false;
            req.Inspect = tree =>
            {
                seen = true;
                Assert.IsFalse(tree.Q<Button>("go").enabledSelf, "SetEnabled(false)");
                Assert.IsTrue(tree.Q<Toggle>("check").value, "value = true");
                Assert.IsTrue(tree.Q("go__shadowhost").ClassListContains(PseudoStateMirror.DisabledClass), "the host mirrors :disabled");
                Assert.IsTrue(tree.Q("check__shadowhost").ClassListContains(PseudoStateMirror.CheckedClass), "the host mirrors :checked");
            };
            yield return DesignCapture.Run(req, profile);
            Assert.IsTrue(seen);
            var els = (JObject)Boxes(req)["elements"];
            var tex = Png(req);
            AssertNear("#13544f", Pixel(tex, 40, (int)(double)els["go"]["y"] + 15), 2, "the button at the host's 0.4 opacity over black");
            AssertNear("#808080", Pixel(tex, 10, (int)(double)els["check"]["y"] + 10), 2, "the toggle at the host's 0.5 opacity over black");
        }

        [UnityTest]
        public IEnumerator Run_Focus_IsTakenByTheElement_AndShowsItsFocusStyle()
        {
            var field = Box("field", "#112233").With("focus", ("background-color", "#ff0000"));
            var export = Export(Small(BlackRoot(field)));
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var req = Request(export, screen, "default@320x180.focus.field", 320, 180, CaptureApply.Pseudo("focus", "field"));
            var seen = false;
            req.Inspect = tree =>
            {
                seen = true;
                Assert.AreSame(tree.Q("field"), tree.panel.focusController.focusedElement);
            };
            yield return DesignCapture.Run(req, profile);
            Assert.IsTrue(seen);
            Assert.AreEqual("#ff0000", Hex(Pixel(Png(req), 50, 20)));
        }

        [UnityTest]
        public IEnumerator Run_Active_DoesNotAlsoFocusThePressedControl()
        {
            // a press focuses a focusable element in UI Toolkit; the golden forces :active (and :hover) only
            var go = Node("go", "button", ("height", "40px"), ("width", "100px"), ("flex-shrink", "0"), ("background-color", "#112233"))
                .With("active", ("background-color", "#778899")).With("focus", ("opacity", "0.5"));
            var export = Export(Small(BlackRoot(go)));
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var req = Request(export, screen, "default@320x180.active.go", 320, 180, CaptureApply.Pseudo("active", "go"));
            var seen = false;
            req.Inspect = tree =>
            {
                seen = true;
                Assert.IsNull(tree.panel.focusController.focusedElement, "nothing is focused");
            };
            yield return DesignCapture.Run(req, profile);
            Assert.IsTrue(seen);
            Assert.AreEqual("#778899", Hex(Pixel(Png(req), 50, 20)), ":active without :focus");
        }

        [UnityTest]
        public IEnumerator Run_Hover_PointsAtTheElementItself_NotAtAChildWithItsOwnHover()
        {
            var badge = Node("badge", "container", ("position", "absolute"), ("left", "40px"), ("top", "10px"), ("width", "20px"), ("height", "20px"),
                ("background-color", "#aa0000")).With("hover", ("background-color", "#00aa00"));
            var card = Box("card", "#112233", ("position", "relative")).With("hover", ("background-color", "#445566")).Add(badge);
            var export = Export(Small(BlackRoot(card)));
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var req = Request(export, screen, "default@320x180.hover.card", 320, 180, CaptureApply.Pseudo("hover", "card"));
            yield return DesignCapture.Run(req, profile);
            var tex = Png(req);
            Assert.AreEqual("#445566", Hex(Pixel(tex, 5, 5)), "the card is hovered");
            Assert.AreEqual("#aa0000", Hex(Pixel(tex, 50, 20)), "the badge at the card's centre is not");
        }

        [UnityTest]
        public IEnumerator Run_ViewportOfAnotherAspect_BoxesUseThePanelsScale_AndMatchThePng()
        {
            // 400×180 against a 320×180 reference at match 0.5: Unity scales by lerp(1.25, 1, 0.5) = 1.125
            var mark = Node("mark", "container", ("position", "absolute"), ("left", "180px"), ("top", "40px"), ("width", "100px"), ("height", "40px"),
                ("background-color", "#ff8800"));
            var export = Export(Small(BlackRoot(mark)));
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var req = Request(export, screen, "default@400x180", 400, 180);
            yield return DesignCapture.Run(req, profile);

            var boxes = Boxes(req);
            Assert.AreEqual(1.125, (double)boxes["scale"], 1e-6, "the panel's own scale");
            var box = (JObject)boxes["elements"]["mark"];
            Assert.AreEqual(202.5, (double)box["x"], 0.501, "180 × 1.125 (UI Toolkit snaps the layout to device pixels)");
            Assert.AreEqual(112.5, (double)box["w"], 1.0, "100 × 1.125");
            var tex = Png(req);
            var y = (int)((double)box["y"] + (double)box["h"] / 2);
            var orange = Enumerable.Range(0, tex.width).Where(x => Hex(Pixel(tex, x, y)) == "#ff8800").ToList();
            Assert.IsNotEmpty(orange);
            Assert.AreEqual((double)box["x"], orange.First(), 1.0, "the box starts where the PNG shows the element");
            Assert.AreEqual((double)box["x"] + (double)box["w"], orange.Last() + 1, 1.0, "and ends there");
        }

        [UnityTest]
        public IEnumerator CaptureAll_CapturesEveryStaticJob_ListsAnimationSamplesAsNotCaptured_AndCopiesTheManifest()
        {
            var tile = Box("tile", "#112233").With("hover", ("background-color", "#445566"));
            var ir = Small(Root(tile));
            const string matrix = "{ \"captures\": [" +
                                  "{ \"name\": \"default@320x180\", \"state\": \"default\", \"viewport\": [320, 180], \"apply\": [], \"pseudo\": null, \"coverage\": null, \"anim\": null }," +
                                  "{ \"name\": \"default@320x180.hover.tile\", \"state\": \"default\", \"viewport\": [320, 180], \"apply\": [ { \"kind\": \"pseudo\", \"pseudo\": \"hover\", \"elementId\": \"tile\" } ], \"pseudo\": { \"kind\": \"hover\", \"elementId\": \"tile\" }, \"coverage\": null, \"anim\": null }," +
                                  "{ \"name\": \"loading@160x90\", \"state\": \"loading\", \"viewport\": [160, 90], \"apply\": [], \"pseudo\": null, \"coverage\": null, \"anim\": null }," +
                                  "{ \"name\": \"default@320x180.anim.tile.0\", \"state\": \"default\", \"viewport\": [320, 180], \"apply\": [], \"pseudo\": null, \"coverage\": null, " +
                                  "\"anim\": { \"sampled\": [ { \"elementId\": \"tile\", \"index\": 0 } ], \"runs\": [ { \"elementId\": \"tile\", \"index\": 0 } ], \"from\": null, \"sample\": 0, \"time\": 0 } }" +
                                  "], \"unsampled\": [] }";
            var export = Export(ir, null, matrix);
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outDir = TempDir();
            File.WriteAllText(Path.Combine(outDir, "default@320x180.anim.tile.0.png"), "stale");

            var result = new CaptureResult();
            yield return DesignCapture.CaptureAll(export, screen, profile, outDir, result);

            Assert.IsEmpty(result.Errors, string.Join("\n", result.Errors));
            CollectionAssert.AreEqual(new[] { "default@320x180", "default@320x180.hover.tile", "loading@160x90" }, result.Captured);
            Assert.AreEqual("default@320x180.anim.tile.0", result.NotCaptured.Single().Capture);
            foreach (var name in result.Captured) Assert.IsTrue(File.Exists(Path.Combine(outDir, name + ".png")), name);
            Assert.IsFalse(File.Exists(Path.Combine(outDir, "default@320x180.anim.tile.0.png")), "a not-captured job leaves no stale PNG");
            var boxes = JObject.Parse(File.ReadAllText(Path.Combine(outDir, "boxes.json")));
            CollectionAssert.AreEquivalent(result.Captured, boxes.Properties().Select(p => p.Name), "boxes.json holds only captures, as the comparison expects");
            Assert.AreEqual(0.5, (double)boxes["loading@160x90"]["scale"], 1e-9);
            var meta = JObject.Parse(File.ReadAllText(Path.Combine(outDir, DesignCapture.MetaFileName)));
            Assert.AreEqual("default@320x180.anim.tile.0", (string)meta["notCaptured"][0]["capture"]);
            StringAssert.Contains("animation", (string)meta["notCaptured"][0]["reason"]);
            var copied = GeneratedManifest.Load(Path.Combine(outDir, ScreenCompiler.ManifestFileName));
            Assert.IsNotNull(copied, "the compiled manifest (removed wrappers) is next to the captures");
            Assert.AreEqual("capture.test", copied.screen);
        }

        static string Job(string name, string state, int w, int h, params string[] apply) =>
            "{ \"name\": \"" + name + "\", \"state\": \"" + state + "\", \"viewport\": [" + w + ", " + h + "], \"apply\": [" + string.Join(", ", apply) +
            "], \"pseudo\": null, \"coverage\": null, \"anim\": null }";

        static string Pseudo(string pseudo, string id) => "{ \"kind\": \"pseudo\", \"pseudo\": \"" + pseudo + "\", \"elementId\": \"" + id + "\" }";

        static string ClassApply(string name, string id) => "{ \"kind\": \"class\", \"name\": \"" + name + "\", \"elementId\": \"" + id + "\" }";

        [UnityTest]
        public IEnumerator CaptureAll_ClearsThePreviousRun_SoAJobThatFailsNowLeavesNothingStale()
        {
            var export = Export(Small(BlackRoot(Box("tile", "#112233"))), null,
                "{ \"captures\": [" + Job("default@320x180", "default", 320, 180) + ", " +
                Job("default@320x180.is-x.ghost", "default", 320, 180, ClassApply("is-x", "ghost")) + "] }");
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outDir = TempDir();
            foreach (var stale in new[] { "default@320x180.is-x.ghost", "old@10x10" })
            {
                File.WriteAllBytes(Path.Combine(outDir, stale + ".png"), new byte[] { 1, 2, 3 });
                BoxesWriter.Merge(Path.Combine(outDir, BoxesWriter.FileName), new JObject
                {
                    ["capture"] = stale, ["viewport"] = new JArray(10, 10), ["scale"] = 1.0, ["external"] = new JArray(), ["elements"] = new JObject(),
                });
            }
            File.WriteAllText(Path.Combine(outDir, "notes.txt"), "a file the capture does not own");
            File.WriteAllText(Path.Combine(outDir, DesignCapture.DoneFileName), "{ \"runId\": \"old\" }");

            var result = new CaptureResult();
            yield return DesignCapture.CaptureAll(export, screen, profile, outDir, result);

            CollectionAssert.AreEqual(new[] { "default@320x180" }, result.Captured);
            StringAssert.Contains("ghost", result.Errors.Single(), "a class on an element the screen does not have is an error");
            CollectionAssert.AreEquivalent(new[] { "default@320x180.png" }, Directory.GetFiles(outDir, "*.png").Select(Path.GetFileName), "no PNG of an earlier run");
            CollectionAssert.AreEqual(new[] { "default@320x180" }, JObject.Parse(File.ReadAllText(Path.Combine(outDir, BoxesWriter.FileName))).Properties().Select(p => p.Name));
            Assert.IsTrue(File.Exists(Path.Combine(outDir, "notes.txt")), "files the capture does not own stay");
            var meta = JObject.Parse(File.ReadAllText(Path.Combine(outDir, DesignCapture.MetaFileName)));
            Assert.AreEqual("complete", (string)meta["status"]);
            Assert.IsFalse(string.IsNullOrEmpty((string)meta["runId"]));
            var done = JObject.Parse(File.ReadAllText(Path.Combine(outDir, DesignCapture.DoneFileName)));
            Assert.AreEqual((string)meta["runId"], (string)done["runId"], "this run's marker, not the earlier one");
            Assert.AreEqual(2, (int)done["jobs"]);
            Assert.AreEqual(1, (int)done["captured"]);
            Assert.AreEqual(1, (int)done["notCaptured"]);
        }

        [Test]
        public void CaptureAll_ThatStopsBeforeTheEnd_LeavesNoDoneMarker()
        {
            var export = Export(Small(BlackRoot(Box("tile", "#112233")))); // no goldens/matrix.json
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outDir = TempDir();
            File.WriteAllText(Path.Combine(outDir, DesignCapture.DoneFileName), "{ \"runId\": \"old\" }");
            var run = DesignCapture.CaptureAll(export, screen, profile, outDir, new CaptureResult());
            Assert.Throws<IrFormatException>(() => { while (run.MoveNext()) { } });
            Assert.IsFalse(File.Exists(Path.Combine(outDir, DesignCapture.DoneFileName)), "a folder without the marker was not captured");
            Assert.AreEqual("running", (string)JObject.Parse(File.ReadAllText(Path.Combine(outDir, DesignCapture.MetaFileName)))["status"]);
        }

        [UnityTest]
        public IEnumerator CaptureAll_JobsThatCannotBeMadeAsTheGoldenShowsThem_AreListedWithTheirReasons()
        {
            var ghost = Box("ghost", "#202020", ("pointer-events", "none"));
            var export = Export(Small(BlackRoot(Box("tile", "#112233"), Box("tab", "#203040"), ghost)), null,
                "{ \"captures\": [" +
                Job("default@320x180.hover.tab.hover.tile", "default", 320, 180, Pseudo("hover", "tab"), Pseudo("hover", "tile")) + ", " +
                Job("default@320x180.hover.ghost", "default", 320, 180, Pseudo("hover", "ghost")) + ", " +
                Job("default@320x180.checked.tile", "default", 320, 180, Pseudo("checked", "tile")) + ", " +
                Job("default@320x180.focus.tab", "default", 320, 180, Pseudo("focus", "tab")) + "] }");
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outDir = TempDir();
            var result = new CaptureResult();
            yield return DesignCapture.CaptureAll(export, screen, profile, outDir, result);

            Assert.IsEmpty(result.Errors, string.Join("\n", result.Errors));
            CollectionAssert.IsEmpty(result.Captured);
            var reasons = result.NotCaptured.ToDictionary(n => n.Capture, n => n.Reason);
            StringAssert.Contains("one pointer", reasons["default@320x180.hover.tab.hover.tile"]);
            StringAssert.Contains("picks it", reasons["default@320x180.hover.ghost"]);
            StringAssert.Contains("not a toggle", reasons["default@320x180.checked.tile"]);
            StringAssert.Contains("focus", reasons["default@320x180.focus.tab"]);
            CollectionAssert.IsEmpty(Directory.GetFiles(outDir, "*.png"));
        }

        [Test]
        public void DefaultScreenFolder_IsTheProfilesOutputFolderAndTheScreenName()
        {
            var export = Export(Small(Root()));
            Assert.AreEqual(Out + "/CaptureTest", DesignCapture.DefaultScreenFolder(export, Profile(new Vector2Int(320, 180), 0.5f)));
        }

        [Test]
        public void Run_ProfileWhoseReferenceDiffersFromTheExport_Fails()
        {
            var export = Export(Small(Root()));
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            profile.referenceResolution = new Vector2Int(2560, 1440);
            var run = DesignCapture.Run(Request(export, screen, "default@320x180", 320, 180), profile);
            var e = Assert.Throws<InvalidOperationException>(() => { while (run.MoveNext()) { } });
            StringAssert.Contains("2560", e.Message);
        }
    }
}
