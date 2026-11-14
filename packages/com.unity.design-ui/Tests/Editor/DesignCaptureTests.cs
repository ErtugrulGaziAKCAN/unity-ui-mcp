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
        /// Several exports in one run: <c>DESIGN_UI_EXPORT</c> and <c>DESIGN_UI_OUT</c> are PATH-style lists
        /// (<see cref="System.IO.Path.PathSeparator"/>) paired by position, each export with its default compiled screen
        /// (<see cref="DesignCapture.CaptureEach"/>); one that cannot be captured fails the test but not the others.
        /// <c>DESIGN_UI_RUN_ID</c> (optional) is the run id the done markers carry, so a runner accepts only this run's.
        /// </summary>
        [UnityTest]
        [Timeout(1700000)] // only until the test sets its own from the job count (SetTestTimeout); the clone tool stops Unity at 1800 s
        public IEnumerator CaptureFromEnv()
        {
            var export = Env("DESIGN_UI_EXPORT", "DESIGN_UI_EXPORT_DIR");
            // not a capture run: nothing to do; a runner reads a capture only from the capture-done marker of its output folder
            if (export == null) Assert.Pass("not configured; nothing captured (set DESIGN_UI_EXPORT and DESIGN_UI_OUT)");
            var outDir = Env("DESIGN_UI_OUT", "DESIGN_UI_OUT_DIR");
            Assert.IsNotNull(outDir, "DESIGN_UI_OUT names the folder the captures are written to");
            var profile = DesignCapture.LoadProfile(Env("DESIGN_UI_PROFILE"));
            var exports = DesignUiBatch.PathList(export);
            // the test's own limit follows the job count (a large screen captures hundreds of jobs)
            var jobs = exports.Sum(e => DesignCapture.JobCount(e));
            var timeout = DesignCapture.TestTimeoutMs(jobs);
            var set = SetTestTimeout(timeout);
            var line = "Design UI capture: " + jobs + " jobs; test timeout " + timeout / 1000 + " s (120 s + 2 s per job)" +
                       (set ? "" : "; the test runner did not take it, its Timeout attribute applies");
            Debug.Log(line);
            TestContext.WriteLine(line);
            if (exports.Count > 1)
            {
                Assert.IsNull(Env("DESIGN_UI_SCREEN"), "DESIGN_UI_SCREEN names one compiled screen; with several exports each uses its default");
                var errors = new List<string>();
                yield return DesignCapture.CaptureEach(exports, DesignUiBatch.PathList(outDir), profile, errors, Env("DESIGN_UI_RUN_ID"));
                Assert.IsEmpty(errors, string.Join("\n", errors));
                yield break;
            }
            var screen = Env("DESIGN_UI_SCREEN") ?? DesignCapture.DefaultScreenFolder(export, profile);
            var result = new CaptureResult();
            yield return DesignCapture.CaptureAll(export, screen, profile, outDir, result, Env("DESIGN_UI_RUN_ID"));
            Debug.Log("Design UI capture: " + result.Captured.Count + " captured, " + result.NotCaptured.Count + " not captured into " + outDir +
                      string.Concat(result.NotCaptured.Select(n => "\n  not captured " + n.Capture + ": " + n.Reason)));
            Assert.IsEmpty(result.Errors, string.Join("\n", result.Errors));
        }

        /// <summary>
        /// Sets the running test's timeout (the Unity Test Framework checks it every frame of a UnityTest); false when this
        /// framework version has no such setting. The framework keeps it on its internal execution context.
        /// </summary>
        internal static bool SetTestTimeout(int ms)
        {
            var type = typeof(UnityTestAttribute).Assembly.GetType("UnityEngine.TestRunner.NUnitExtensions.Runner.UnityTestExecutionContext");
            var context = type?.GetProperty("CurrentContext", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)?.GetValue(null);
            var timeout = context?.GetType().GetProperty("TestCaseTimeout");
            if (timeout == null || !timeout.CanWrite) return false;
            timeout.SetValue(context, ms);
            return (int)timeout.GetValue(context) == ms;
        }

        [Test]
        public void TestTimeout_FollowsTheJobCount()
        {
            Assert.AreEqual(120_000, DesignCapture.TestTimeoutMs(0));
            Assert.AreEqual(120_000 + 486 * 2_000, DesignCapture.TestTimeoutMs(486), "a screen of 486 jobs gets 18 minutes");
            var dir = TempDir();
            Directory.CreateDirectory(Path.Combine(dir, "goldens"));
            File.WriteAllText(Path.Combine(dir, DesignCapture.MatrixPath), "{ \"captures\": [ { \"name\": \"default@320x180\", \"state\": \"default\", \"viewport\": [320, 180], \"apply\": [] }, " +
                                                                             "{ \"name\": \"default@160x90\", \"state\": \"default\", \"viewport\": [160, 90], \"apply\": [] } ] }");
            Assert.AreEqual(2, DesignCapture.JobCount(dir));
            Assert.AreEqual(0, DesignCapture.JobCount(TempDir()), "no matrix");
        }

        [UnityTest]
        public IEnumerator SetTestTimeout_ChangesTheRunningTestsLimit()
        {
            Assert.IsTrue(SetTestTimeout(600_000), "the Unity Test Framework takes a test's own timeout");
            yield return null;
            Assert.IsTrue(SetTestTimeout(180_000));
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

        /// <summary>String Tables that accept everything and write nothing (the capture never reads them).</summary>
        sealed class NoTables : IDesignStringTables
        {
            public IReadOnlyList<string> Check(StringTableRequest request) => new string[0];
            public LocalizationReport Write(StringTableRequest request) => new LocalizationReport { Collection = request.Collection };
            public IReadOnlyDictionary<string, IReadOnlyList<string>> Strings(string collection, IEnumerable<string> keys) => new Dictionary<string, IReadOnlyList<string>>();
        }

        [UnityTest]
        public IEnumerator Run_ALocalizedScreen_ShowsTheDesignsReferenceText_AsTheStaticCompileDoes()
        {
            // keyed texts as a fidelity fixture writes them: a plain one, one with an argument from the sample data, a button
            // label and an input's placeholder; compiled once with static design text and once bound to String Tables
            var title = Words("title", "Kulüp", ("align-self", "flex-start"));
            title.Text.Key = "capture.title";
            title.Text.En = "Club";
            var score = Words("score", "{team}: 3 maç", ("align-self", "flex-start"));
            score.Text.Key = "capture.score";
            score.Text.En = "{team}: 3 matches";
            score.Text.Args = new[] { "team" };
            var query = Node("query", "input", ("width", "200px"), ("height", "30px"), ("flex-shrink", "0"), ("background-color", "#123c47"),
                ("color", "#ffffff"), ("font-family", "Inter"), ("font-size", "16px"));
            query.Initial = new IrInitial();
            query.Field = new IrField { PlaceholderColor = "#9be9f2" };
            query.AttrTexts["placeholder"] = new IrText { Key = "capture.search", Tr = "Ara", En = "Search", Style = "label" };
            var export = Export(Small(BlackRoot(title, score, query)), "{ \"team\": \"Kartal\" }");

            var plain = Profile(new Vector2Int(320, 180), 0.5f);
            var plainScreen = Compile(export, plain);
            var localizing = Profile(new Vector2Int(320, 180), 0.5f);
            localizing.outputFolder = Out + "/Localized";
            localizing.localization.enabled = true;
            localizing.localization.screenTables = new[] { new DesignScreenTable { screen = "capture.test", collection = "CaptureTest" } };
            var compiled = ScreenCompiler.Compile(export, localizing, false, new CompileHooks { ViewCode = _ => null, Tables = new NoTables() });
            Assert.IsTrue(compiled.Ok, string.Join("\n", compiled.Errors));
            var localScreen = Out + "/Localized/" + Naming.Pascal("capture.test");
            var uxml = File.ReadAllText(localScreen + "/" + Naming.Pascal("capture.test") + ".uxml");
            StringAssert.DoesNotContain("Kulüp", uxml, "the localized compile holds no design text");
            StringAssert.Contains("DesignUi.DesignLocalizedString", uxml);

            var a = Request(export, plainScreen, "default@320x180", 320, 180);
            yield return DesignCapture.Run(a, plain);
            var b = Request(export, localScreen, "default@320x180", 320, 180);
            string titleText = null, scoreText = null, placeholder = null;
            b.Inspect = tree =>
            {
                titleText = tree.Q<Label>("title").text;
                scoreText = tree.Q<Label>("score").text;
                placeholder = tree.Q<TextField>("query").textEdition.placeholder;
            };
            yield return DesignCapture.Run(b, localizing);
            Assert.AreEqual("Kulüp", titleText, "the reference locale's text (the IR's tr)");
            Assert.AreEqual("Kartal: 3 maç", scoreText, "its argument from the sample data");
            Assert.AreEqual("Ara", placeholder);
            var pa = Png(a).GetPixels32();
            var pb = Png(b).GetPixels32();
            Assert.AreEqual(pa.Length, pb.Length);
            int differing = 0;
            for (int i = 0; i < pa.Length; i++) if (!pa[i].Equals(pb[i])) differing++;
            Assert.AreEqual(0, differing, "the localized screen's capture is the static compile's, pixel for pixel");
        }

        /// <summary>Weeks of days of cards (nested inline repeats) whose written-out items carry their own classes, states and hidden elements.</summary>
        static IrScreen NestedItems()
        {
            var pick = Node("pick", "button", ("width", "30px"), ("height", "16px"), ("flex-shrink", "0"), ("background-color", "#123c47")).With("disabled", ("background-color", "#ff0000"));
            pick.Initial = new IrInitial();
            var card = Box("card", "#19505d", ("width", "30px"), ("height", "10px"));
            var day = Node("day", "container", ("display", "flex"), ("flex-direction", "column"), ("width", "40px"), ("height", "40px"), ("flex-shrink", "0"),
                ("background-color", "#0f2a33")).With("class:is-today", ("background-color", "#16c2d5")).Add(pick, card);
            var week = Node("week", "container", ("display", "flex"), ("flex-direction", "row"), ("height", "40px"), ("flex-shrink", "0")).Add(day);
            week.Repeat = new IrRepeat { Name = "days", Mode = "inline", Count = 2 };
            var weeks = Node("weeks", "container", ("display", "flex"), ("flex-direction", "column"), ("flex-shrink", "0")).Add(week);
            weeks.Repeat = new IrRepeat { Name = "weeks", Mode = "inline", Count = 2 };
            return Small(BlackRoot(weeks));
        }

        const string NestedFixtures = "{ \"weeks\": [ { \"days\": [ {}, {} ] }, { \"days\": [ " +
                                      "{ \"$classes\": { \"day\": [\"is-today\"] }, \"$states\": { \"pick\": [\"disabled\"] }, \"$hidden\": { \"card\": true } }, {} ] } ] }";

        [UnityTest]
        public IEnumerator Run_RepeatItems_ShowTheirOwnClassesStatesAndHiddenElements_InNestedRepeats()
        {
            var export = Export(NestedItems(), NestedFixtures);
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var req = Request(export, screen, "default@320x180", 320, 180);
            float todayY = 0;
            req.Inspect = tree =>
            {
                var weeks = tree.Q("weeks").Children().ToList();
                Assert.AreEqual(2, weeks.Count);
                var days = weeks[1].Children().ToList();
                Assert.AreEqual(2, days.Count);
                Assert.IsTrue(days[0].ClassListContains("is-today"), "the second week's first day is today (its own $classes)");
                Assert.IsFalse(days[1].ClassListContains("is-today"));
                Assert.IsFalse(weeks[0].Children().First().ClassListContains("is-today"));
                Assert.IsFalse(days[0].Q<Button>().enabledSelf, "its pick button is disabled ($states)");
                Assert.IsTrue(days[1].Q<Button>().enabledSelf);
                Assert.IsTrue(weeks[0].Children().First().Q<Button>().enabledSelf, "the template's own state elsewhere");
                Assert.AreEqual(DisplayStyle.None, days[0].Children().Last().resolvedStyle.display, "its card is hidden ($hidden)");
                Assert.AreEqual(DisplayStyle.Flex, days[1].Children().Last().resolvedStyle.display);
                todayY = days[0].worldBound.yMax - 2;
            };
            yield return DesignCapture.Run(req, profile);
            var tex = Png(req);
            Assert.AreEqual("#16c2d5", Hex(Pixel(tex, 20, (int)todayY)), "today's background in the capture");
        }

        /// <summary>
        /// A job in a later written-out repeat item (matrix.json <c>item</c>, for an element only that item shows): the
        /// capture hovers that item's copy, found by its own name even in nested repeats (the second week's first day is
        /// not the first week's second day).
        /// </summary>
        [UnityTest]
        public IEnumerator Run_AJobInALaterRepeatItem_PointsAtThatItemsCopy_InNestedRepeats()
        {
            var more = Node("more", "button", ("display", "none"), ("width", "30px"), ("height", "16px"), ("flex-shrink", "0"), ("background-color", "#123c47"))
                .With("hover", ("background-color", "#16c2d5"));
            more.Initial = new IrInitial();
            var day = Node("day", "container", ("display", "flex"), ("flex-direction", "column"), ("width", "40px"), ("height", "40px"), ("flex-shrink", "0"),
                ("background-color", "#0f2a33")).Add(more);
            var week = Node("week", "container", ("display", "flex"), ("flex-direction", "row"), ("height", "40px"), ("flex-shrink", "0")).Add(day);
            week.Repeat = new IrRepeat { Name = "days", Mode = "inline", Count = 2 };
            var weeks = Node("weeks", "container", ("display", "flex"), ("flex-direction", "column"), ("flex-shrink", "0")).Add(week);
            weeks.Repeat = new IrRepeat { Name = "weeks", Mode = "inline", Count = 2 };
            // only the second week's first day shows its "more" button
            var export = Export(Small(BlackRoot(weeks)), "{ \"weeks\": [ { \"days\": [ {}, {} ] }, { \"days\": [ { \"$hidden\": { \"more\": false } }, {} ] } ] }");
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var hover = CaptureApply.Pseudo("hover", "more");
            hover.Item = new[] { 1, 0 };
            Assert.AreEqual("more#0#1", hover.Target);
            var req = Request(export, screen, "default@320x180.hover.more~1-0", 320, 180, hover);
            Rect at = default;
            req.Inspect = tree =>
            {
                CollectionAssert.AreEqual(new[] { "day", "day#1", "day#0#1", "day#1#1" }, tree.Query(className: null).ToList().Select(e => e.name).Where(n => n.StartsWith("day")).ToArray(),
                    "every written-out day has its own name");
                at = tree.Q("more#0#1").worldBound;
            };
            yield return DesignCapture.Run(req, profile);
            Assert.Greater(at.width, 0, "the second week's first day shows its button");
            Assert.AreEqual("#16c2d5", Hex(Pixel(Png(req), (int)at.center.x, (int)at.center.y)), "the pointer is on that copy");
        }

        [Test]
        public void ReadMatrix_ReadsTheRepeatItemsAJobAppliesTo()
        {
            var dir = TempDir();
            Directory.CreateDirectory(Path.Combine(dir, "goldens"));
            File.WriteAllText(Path.Combine(dir, DesignCapture.MatrixPath), "{ \"captures\": [ { \"name\": \"default@320x180.hover.more~2\", \"state\": \"default\", " +
                "\"viewport\": [320, 180], \"apply\": [ { \"kind\": \"pseudo\", \"pseudo\": \"hover\", \"elementId\": \"more\", \"item\": [2] } ] } ] }");
            var job = CaptureJob.ReadMatrix(Path.Combine(dir, DesignCapture.MatrixPath)).Single();
            CollectionAssert.AreEqual(new[] { 2 }, job.Apply[0].Item);
            Assert.AreEqual("more#2", job.Apply[0].Target);
            Assert.AreEqual("more", CaptureApply.Pseudo("hover", "more").Target, "the IR's own element");
            Assert.AreEqual("more#3#2", new CaptureApply { ElementId = "more", Item = new[] { 2, 3 } }.Target);
            Assert.AreEqual("more#3", new CaptureApply { ElementId = "more", Item = new[] { 0, 3 } }.Target);
        }

        [UnityTest]
        public IEnumerator Run_ALocalizingProfileWithIndexedArguments_FillsTheArgumentsFromTheSampleData()
        {
            // the String Tables hold {0} (indexed), the design writes {count}: the capture shows the design's reference text with
            // the sample value, at the root and inside repeat items, never a placeholder
            var count = Words("count", "{count} olay", ("align-self", "flex-start"));
            count.Text.Key = "capture.count";
            count.Text.En = "{count} events";
            count.Text.Args = new[] { "count" };
            var more = Words("more", "+{hidden} daha", ("align-self", "flex-start"));
            more.Text.Key = "capture.more";
            more.Text.En = "+{hidden} more";
            more.Text.Args = new[] { "hidden" };
            var row = Node("row", "container", ("height", "20px"), ("flex-shrink", "0")).Add(more);
            var rows = Node("rows", "container", ("display", "flex"), ("flex-direction", "column")).Add(row);
            rows.Repeat = new IrRepeat { Name = "rows", Mode = "inline", Count = 2 };
            var export = Export(Small(BlackRoot(count, rows)), "{ \"count\": \"4\", \"rows\": [ { \"hidden\": \"2\" }, { \"hidden\": \"5\" } ] }");
            var localizing = Profile(new Vector2Int(320, 180), 0.5f);
            localizing.outputFolder = Out + "/Indexed";
            localizing.localization.enabled = true;
            localizing.localization.argumentFormat = DesignArgumentFormat.Indexed;
            localizing.localization.screenTables = new[] { new DesignScreenTable { screen = "capture.test", collection = "CaptureTest" } };
            var compiled = ScreenCompiler.Compile(export, localizing, false, new CompileHooks { ViewCode = _ => null, Tables = new NoTables() });
            Assert.IsTrue(compiled.Ok, string.Join("\n", compiled.Errors));
            var screen = Out + "/Indexed/" + Naming.Pascal("capture.test");
            StringAssert.Contains("DesignUi.DesignLocalizedString", File.ReadAllText(screen + "/" + Naming.Pascal("capture.test") + ".uxml"));
            var req = Request(export, screen, "default@320x180", 320, 180);
            string countText = null;
            List<string> moreTexts = null;
            req.Inspect = tree =>
            {
                countText = tree.Q<Label>("count").text;
                moreTexts = tree.Q("rows").Query<Label>().ToList().Select(l => l.text).ToList();
            };
            yield return DesignCapture.Run(req, localizing);
            Assert.AreEqual("4 olay", countText, "the design's reference (tr) text with the sample value");
            CollectionAssert.AreEqual(new[] { "+2 daha", "+5 daha" }, moreTexts, "each item's own value");
        }

        /// <summary>
        /// A capture run keeps a viewport's screen mounted from job to job (hover, press, focus, disabled, checked, classes,
        /// states in between); every job's PNG and boxes are those of a freshly mounted screen (<see cref="DesignCapture.Run"/>).
        /// </summary>
        [UnityTest]
        public IEnumerator CaptureAll_MovesOneMountedScreenFromJobToJob_WithEveryCaptureAsAFreshMountsCapture()
        {
            var go = Node("go", "button", ("width", "60px"), ("height", "30px"), ("flex-shrink", "0"), ("background-color", "#123c47"))
                .With("hover", ("background-color", "#16c2d5")).With("active", ("background-color", "#ff8800")).With("focus", ("background-color", "#00ff00"))
                .With("disabled", ("background-color", "#444444"));
            go.Initial = new IrInitial();
            var off = Node("off", "button", ("width", "60px"), ("height", "30px"), ("flex-shrink", "0"), ("background-color", "#123c47")).With("disabled", ("background-color", "#444444"));
            off.Initial = new IrInitial { Disabled = true };
            var tick = Node("tick", "toggle", ("width", "20px"), ("height", "20px"), ("flex-shrink", "0"), ("background-color", "#123c47")).With("checked", ("background-color", "#16c2d5"));
            tick.Initial = new IrInitial();
            var panel = Box("panel", "#0f2a33").With("class:is-open", ("background-color", "#216372")).With("state:loading", ("background-color", "#ff00ff"));
            // a class the screen already shows (markup, or an item's sample class): a job that applies it again leaves it on
            var tag = Box("tag", "#0f2a33").With("class:is-on", ("background-color", "#3ccf7a"));
            tag.Classes = new[] { "is-on" };
            // a container its child covers everywhere: hovering it makes the child ignore the pointer; a later job on the
            // child picks it again
            var dayNumber = Node("day-number", "container", ("width", "100%"), ("height", "100%"), ("background-color", "#2a5966"))
                .With("hover", ("background-color", "#ffcc00"));
            var day = Node("day", "container", ("width", "40px"), ("height", "20px"), ("flex-shrink", "0"), ("background-color", "#0f2a33"))
                .With("hover", ("background-color", "#3ccf7a")).Add(dayNumber);
            // a class that moves the hovered element: the pointer follows it
            var opt = Node("opt", "container", ("width", "40px"), ("height", "20px"), ("flex-shrink", "0"), ("background-color", "#123c47"))
                .With("hover", ("background-color", "#16c2d5"));
            var strip = Node("strip", "container", ("display", "flex"), ("flex-direction", "row"), ("width", "120px"), ("height", "20px"), ("flex-shrink", "0"))
                .With("class:is-shifted", ("padding-left", "60px")).Add(opt);
            // a dropdown a press opens: the next job shows no menu
            var pick = Words("pick", "Bir", ("width", "60px"), ("height", "20px"), ("flex-shrink", "0"), ("background-color", "#123c47"));
            pick.Kind = "dropdown";
            pick.Initial = new IrInitial();
            // the row paints the dropdown's colour: a DropdownField's first frames draw a faint corner fringe that later frames
            // do not (UI Toolkit's tessellation, on a fresh mount as on a kept one), which this test does not measure
            var row = Node("row", "container", ("display", "flex"), ("flex-direction", "row"), ("height", "20px"), ("flex-shrink", "0"),
                ("background-color", "#123c47")).Add(day, strip, pick);
            var ir = Small(BlackRoot(go, off, tick, panel, tag, row));
            string J(string name, string state, params string[] apply) =>
                "{ \"name\": \"" + name + "\", \"state\": \"" + state + "\", \"viewport\": [320, 180], \"apply\": [" + string.Join(", ", apply) + "] }";
            string P(string pseudo, string id) => "{ \"kind\": \"pseudo\", \"pseudo\": \"" + pseudo + "\", \"elementId\": \"" + id + "\" }";
            string C(string cls, string id) => "{ \"kind\": \"class\", \"name\": \"" + cls + "\", \"elementId\": \"" + id + "\" }";
            var jobs = new[]
            {
                J("default@320x180", "default"), J("default@320x180.hover.go", "default", P("hover", "go")), J("default@320x180.active.go", "default", P("active", "go")),
                J("default@320x180.checked.tick", "default", P("checked", "tick")), J("default@320x180.active.tick", "default", P("active", "tick")),
                J("default@320x180.hover.tick", "default", P("hover", "tick")), J("default@320x180.focus.go", "default", P("focus", "go")),
                J("default@320x180.disabled.go", "default", P("disabled", "go")), J("default@320x180.hover.off", "default", P("hover", "off")),
                J("default@320x180.is-open.panel", "default", C("is-open", "panel")), J("default@320x180.is-on.tag", "default", C("is-on", "tag")),
                J("loading@320x180", "loading"),
                J("default@320x180.again", "default"),
                J("default@320x180.hover.day", "default", P("hover", "day")), J("default@320x180.hover.day-number", "default", P("hover", "day-number")),
                J("default@320x180.active.day", "default", P("active", "day")), J("default@320x180.active.day-number", "default", P("active", "day-number")),
                J("default@320x180.hover.opt", "default", P("hover", "opt")),
                J("default@320x180.hover.opt.is-shifted.strip", "default", P("hover", "opt"), C("is-shifted", "strip")),
                J("default@320x180.active.pick", "default", P("active", "pick")), J("default@320x180.after-menu", "default"),
                J("default@320x180.hover.tag", "default", P("hover", "tag")),
            };
            var export = Export(ir, null, "{ \"captures\": [" + string.Join(", ", jobs) + "] }");
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);

            var outAll = TempDir();
            var result = new CaptureResult();
            yield return DesignCapture.CaptureAll(export, screen, profile, outAll, result);
            Assert.IsEmpty(result.Errors, string.Join("\n", result.Errors));
            Assert.AreEqual(jobs.Length, result.Captured.Count, string.Join("\n", result.NotCaptured.Select(n => n.Capture + ": " + n.Reason)));
            var all = JObject.Parse(File.ReadAllText(Path.Combine(outAll, BoxesWriter.FileName)));
            foreach (var job in CaptureJob.ReadMatrix(Path.Combine(export, DesignCapture.MatrixPath)))
            {
                var one = new CaptureRequest
                {
                    ExportDir = export, ScreenFolder = screen, CaptureName = job.Name, Viewport = job.Viewport, OutDir = TempDir(), State = job.State, Apply = job.Apply,
                };
                yield return DesignCapture.Run(one, profile);
                var fresh = Png(one).GetPixels32();
                var shared = new Texture2D(2, 2);
                _objects.Add(shared);
                Assert.IsTrue(shared.LoadImage(File.ReadAllBytes(Path.Combine(outAll, job.Name + ".png"))));
                var pixels = shared.GetPixels32();
                Assert.AreEqual(fresh.Length, pixels.Length, job.Name);
                int differing = 0;
                var where = new List<string>();
                for (int i = 0; i < fresh.Length; i++)
                    if (!fresh[i].Equals(pixels[i]) && differing++ < 5)
                        where.Add("(" + i % shared.width + ", " + (shared.height - 1 - i / shared.width) + ") " + Hex(fresh[i]) + " vs " + Hex(pixels[i]));
                Assert.AreEqual(0, differing, job.Name + ": the mounted screen's capture is a fresh mount's, pixel for pixel; first: " + string.Join(", ", where));
                Assert.IsTrue(JToken.DeepEquals(Boxes(one), all[job.Name]), job.Name + ": the same boxes");
            }
            // "again" (nothing applied) after the press on the toggle: had the release clicked it, it would show checked
        }

        /// <summary>
        /// A job that leaves an overlay open on the panel (a dropdown's menu, which a press opens in some Unity versions and
        /// which stays open until a click elsewhere) makes the next job mount the screen again: it shows no overlay.
        /// </summary>
        [UnityTest]
        public IEnumerator CaptureAll_AnOverlayAJobLeavesOpen_IsGoneInTheNextJob()
        {
            string J(string name, string apply) => "{ \"name\": \"" + name + "\", \"state\": \"default\", \"viewport\": [320, 180], \"apply\": [" + apply + "] }";
            var export = Export(Small(BlackRoot(Box("top", "#222222").With("hover", ("background-color", "#16c2d5")))), null,
                "{ \"captures\": [" + J("default@320x180", "") + ", " + J("default@320x180.hover.top", Pseudo("hover", "top")) + ", " + J("default@320x180.again", "") + "] }");
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outAll = TempDir();
            var result = new CaptureResult();
            var run = DesignCapture.CaptureAll(export, screen, profile, outAll, result);
            bool opened = false;
            try
            {
                while (run.MoveNext())
                {
                    yield return run.Current;
                    if (opened || result.Captured.Count != 1) continue;
                    // while the second job runs, something opens an overlay on the document, as a dropdown's menu would
                    var doc = Resources.FindObjectsOfTypeAll<UnityEngine.UIElements.UIDocument>().FirstOrDefault(d => d.name == "DesignCapture" && d.rootVisualElement?.panel != null);
                    Assert.IsNotNull(doc, "the run's mounted screen");
                    var menu = new VisualElement { name = "menu" };
                    menu.style.position = Position.Absolute;
                    menu.style.left = 200;
                    menu.style.top = 100;
                    menu.style.width = 60;
                    menu.style.height = 40;
                    menu.style.backgroundColor = Color.red;
                    doc.rootVisualElement.Add(menu);
                    opened = true;
                }
            }
            finally { (run as IDisposable)?.Dispose(); }
            Assert.IsTrue(opened);
            Assert.AreEqual(3, result.Captured.Count, string.Join("\n", result.NotCaptured.Select(n => n.Capture + ": " + n.Reason)));
            var tex = new Texture2D(2, 2);
            _objects.Add(tex);
            Assert.IsTrue(tex.LoadImage(File.ReadAllBytes(Path.Combine(outAll, "default@320x180.again.png"))));
            Assert.AreEqual("#000000", Hex(Pixel(tex, 230, 120)), "the next job shows the screen without the overlay");
        }

        /// <summary>
        /// A list repeat's slots are cloned again whenever the ListView binds them again (after a scroll or a refresh): the
        /// next job measures the elements the list shows now, as a fresh mount does, not the ones it showed before.
        /// </summary>
        [UnityTest]
        public IEnumerator CaptureAll_AListThatBindsItsSlotsAgainBetweenJobs_MeasuresItsNewElements()
        {
            var subject = Words("subject", "Konu");
            subject.Bind = "subject";
            var row = Node("row", "container", ("height", "20px"), ("flex-shrink", "0"), ("background-color", "#123456"))
                .With("class:is-on", ("background-color", "#3ccf7a")).Add(subject);
            var rows = Node("rows", "list", ("display", "flex"), ("flex-direction", "column"), ("height", "100px"), ("flex-shrink", "0"),
                ("overflow-y", "auto"), ("gap", "8px")).Add(row);
            rows.Repeat = new IrRepeat { Name = "mails", Mode = "list", Count = 2 };
            string J(string name, string apply) => "{ \"name\": \"" + name + "\", \"state\": \"default\", \"viewport\": [320, 180], \"apply\": [" + apply + "] }";
            var export = Export(Small(Root(Box("top", "#222222"), rows)), "{ \"mails\": [ { \"subject\": \"Bir\" }, { \"subject\": \"İki\" } ] }",
                "{ \"captures\": [" + J("default@320x180", "") + ", " + J("default@320x180.hover.top", Pseudo("hover", "top")) + ", " +
                J("default@320x180.is-on.row", ClassApply("is-on", "row")) + "] }");
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outAll = TempDir();
            var result = new CaptureResult();
            var run = DesignCapture.CaptureAll(export, screen, profile, outAll, result);
            bool refreshed = false;
            try
            {
                while (run.MoveNext())
                {
                    yield return run.Current;
                    if (refreshed || result.Captured.Count != 1) continue;
                    // while the second job runs (the first one measured the list) the list binds its slots again (bindItem
                    // clones the item anew); the third job puts a class on the item
                    var doc = Resources.FindObjectsOfTypeAll<UnityEngine.UIElements.UIDocument>().FirstOrDefault(d => d.name == "DesignCapture" && d.rootVisualElement?.panel != null);
                    Assert.IsNotNull(doc, "the run's mounted screen");
                    var before = doc.rootVisualElement.Q("row");
                    doc.rootVisualElement.Q<ListView>("rows").RefreshItems();
                    Assert.AreNotSame(before, doc.rootVisualElement.Q("row"), "the slot holds a new item element");
                    refreshed = true;
                }
            }
            finally { (run as IDisposable)?.Dispose(); }
            Assert.IsTrue(refreshed);
            Assert.AreEqual(3, result.Captured.Count, string.Join("\n", result.NotCaptured.Select(n => n.Capture + ": " + n.Reason)));
            // the class goes on the item the list shows now
            var one = Request(export, screen, "default@320x180.is-on.row", 320, 180, CaptureApply.Class("is-on", "row"));
            yield return DesignCapture.Run(one, profile);
            var shared = (JObject)JObject.Parse(File.ReadAllText(Path.Combine(outAll, BoxesWriter.FileName)))["default@320x180.is-on.row"];
            Assert.IsTrue(JToken.DeepEquals(Boxes(one), shared), "the boxes of a fresh mount:\n" + Boxes(one)["elements"]?["row"] + "\nvs\n" + shared["elements"]?["row"]);
            var tex = new Texture2D(2, 2);
            _objects.Add(tex);
            Assert.IsTrue(tex.LoadImage(File.ReadAllBytes(Path.Combine(outAll, "default@320x180.is-on.row.png"))));
            var y = (int)(double)shared["elements"]["row"]["y"] + 2;
            Assert.AreEqual(Hex(Pixel(Png(one), 90, y)), Hex(Pixel(tex, 90, y)), "the item shows the class, as on a fresh mount");
        }

        [UnityTest]
        public IEnumerator CaptureAll_KeepsBoxesAndTheMetaFileUpToDate_SoARunStoppedMidwayLeavesItsCaptures()
        {
            // every other job opens the panel, so each job takes editor frames (the run yields between jobs)
            var export = Export(Small(BlackRoot(Box("panel", "#0f2a33").With("class:is-open", ("background-color", "#216372")))), null,
                "{ \"captures\": [" + string.Join(", ", Enumerable.Range(0, 40).Select(i =>
                    "{ \"name\": \"default@320x180.n" + i + "\", \"state\": \"default\", \"viewport\": [320, 180], \"apply\": [" +
                    (i % 2 == 1 ? "{ \"kind\": \"class\", \"name\": \"is-open\", \"elementId\": \"panel\" }" : "") + "] }")) + "] }");
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outDir = TempDir();
            var run = DesignCapture.CaptureAll(export, screen, profile, outDir, new CaptureResult());
            JObject meta = null;
            try
            {
                // the run is stopped (disposed) once the meta file lists the first 24 captures (written every 25 jobs), as a killed Unity would stop it
                while (run.MoveNext())
                {
                    yield return run.Current;
                    var path = Path.Combine(outDir, DesignCapture.MetaFileName);
                    meta = File.Exists(path) ? JObject.Parse(File.ReadAllText(path)) : null;
                    if (meta != null && ((JArray)meta["captured"]).Count >= 24) break;
                }
            }
            finally { (run as IDisposable)?.Dispose(); }
            Assert.IsNotNull(meta);
            Assert.AreEqual("running", (string)meta["status"]);
            // every 25 jobs or 10 s, whichever comes first: a slow machine may have flushed earlier and later again
            var captured = ((JArray)meta["captured"]).Count;
            Assert.GreaterOrEqual(captured, 24);
            Assert.Less(captured, 40);
            Assert.IsFalse(File.Exists(Path.Combine(outDir, DesignCapture.DoneFileName)), "a stopped run has no done marker");
            var boxes = JObject.Parse(File.ReadAllText(Path.Combine(outDir, BoxesWriter.FileName)));
            Assert.AreEqual(captured, boxes.Count, "the captures so far are in boxes.json, as the meta file lists them");
            Assert.IsTrue(File.Exists(Path.Combine(outDir, "default@320x180.n0.png")));
        }

        /// <summary>
        /// PNGs are encoded off the main thread, but a run never has more than a few of them pending (each holds a whole
        /// frame until it is on disk): the meta file records the most it had.
        /// </summary>
        [UnityTest]
        public IEnumerator CaptureAll_KeepsFewPngEncodesPending()
        {
            var ir = Small(BlackRoot(Box("panel", "#0f2a33").With("class:is-open", ("background-color", "#216372"))));
            ir.Viewports = new[] { new[] { 320, 180 }, new[] { 1280, 720 } };
            var export = Export(ir, null, "{ \"captures\": [" + string.Join(", ", Enumerable.Range(0, 40).Select(i =>
                "{ \"name\": \"default@1280x720.n" + i + "\", \"state\": \"default\", \"viewport\": [1280, 720], \"apply\": [" +
                (i % 2 == 1 ? "{ \"kind\": \"class\", \"name\": \"is-open\", \"elementId\": \"panel\" }" : "") + "] }")) + "] }");
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outDir = TempDir();
            var result = new CaptureResult();
            yield return DesignCapture.CaptureAll(export, screen, profile, outDir, result);
            Assert.AreEqual(40, result.Captured.Count, string.Join("\n", result.NotCaptured.Select(n => n.Capture + ": " + n.Reason)));
            var meta = JObject.Parse(File.ReadAllText(Path.Combine(outDir, DesignCapture.MetaFileName)));
            var peak = meta["timings"]?["pngPendingPeak"];
            Assert.IsNotNull(peak, "the meta file records the PNG backlog");
            Assert.LessOrEqual((int)peak, 8 + 1, "DesignCapture.MaxPendingPngs, and the one just started");
            Assert.GreaterOrEqual((int)peak, 1);
            Assert.AreEqual(40, Directory.GetFiles(outDir, "*.png").Length);
        }

        /// <summary>
        /// data-u-external (a host's shell drawn around the screen): the compiled element keeps its box, so the layout around
        /// it is the design's, but paints nothing (no background, border colour or shadow) and takes no pointer.
        /// </summary>
        [UnityTest]
        public IEnumerator Run_AnExternalElement_KeepsItsBox_AndPaintsNothing()
        {
            var shell = Shadowed(Node("shell", "container", ("width", "200px"), ("height", "40px"), ("flex-shrink", "0"), ("background-color", "#ff00ff"),
                ("border-top-width", "4px"), ("border-top-color", "#00ff00"), ("margin-bottom", "10px")).With("hover", ("background-color", "#00ffff")));
            shell.External = true;
            var after = Box("after", "#123c47");
            var export = Export(Small(BlackRoot(shell, after)));
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var uxml = File.ReadAllText(screen + "/" + Path.GetFileName(screen) + ".uxml");
            StringAssert.Contains("name=\"shell\"", uxml, "the external element stays in the tree");
            StringAssert.DoesNotContain("shell__shadowhost", uxml, "no shadow host");
            StringAssert.DoesNotContain("#ff00ff", File.ReadAllText(screen + "/" + Path.GetFileName(screen) + ".uss"), "no background colour");

            var req = Request(export, screen, "default@320x180", 320, 180);
            float afterY = 0;
            req.Inspect = tree =>
            {
                var el = tree.Q("shell");
                Assert.AreEqual(200f, el.layout.width, 0.01f, "its box: width");
                Assert.AreEqual(40f, el.layout.height, 0.01f, "its box: height");
                Assert.AreEqual(4f, el.resolvedStyle.borderTopWidth, 0.01f, "border widths are layout: kept");
                Assert.AreEqual(0f, el.resolvedStyle.borderTopColor.a, "but painted in no colour");
                Assert.AreEqual(0f, el.resolvedStyle.backgroundColor.a, "no background");
                Assert.AreEqual(PickingMode.Ignore, el.pickingMode, "the host's UI below takes the pointer");
                Assert.AreEqual(0, el.childCount);
                afterY = tree.Q("after").layout.y;
            };
            yield return DesignCapture.Run(req, profile);
            Assert.AreEqual(50f, afterY, 0.01f, "the next element sits where the design puts it (40 + 10 margin)");
            var tex = Png(req);
            Assert.AreEqual("#000000", Hex(Pixel(tex, 100, 20)), "the screen's own background shows where the external element is");
            Assert.AreEqual("#000000", Hex(Pixel(tex, 100, 1)), "no border colour");
        }

        [UnityTest]
        public IEnumerator Run_ABoundText_GetsItsCharactersAndKerningBeforeItIsAssigned()
        {
            // the bound value shares no glyph with the design text, so only the fill can have added its kerning pairs
            var name = Words("name", "Konu", ("align-self", "flex-start"));
            name.Bind = "name";
            var export = Export(Small(BlackRoot(name)), "{ \"name\": \"AVATAR Toyota Wave\" }");
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);

            var req = Request(export, screen, "default@320x180", 320, 180);
            float width = 0, unkerned = 0;
            req.Inspect = tree =>
            {
                var label = tree.Q<Label>("name");
                Assert.AreEqual("AVATAR Toyota Wave", label.text);
                var font = label.resolvedStyle.unityFontDefinition.fontAsset;
                width = label.layout.width;
                unkerned = label.text.Sum(c => font.characterLookupTable[c].glyph.metrics.horizontalAdvance) * label.resolvedStyle.fontSize / font.faceInfo.pointSize;
            };
            yield return DesignCapture.Run(req, profile);
            Assert.Greater(unkerned, 0);
            Assert.Less(width, unkerned - 2, "the capture's first layout of the bound text is kerned");
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

        /// <summary>
        /// A text field takes the pointer on its own parts (the visual input and its text element, which are not design
        /// elements): a real pointer there hovers the field, so the capture can hover it.
        /// </summary>
        [UnityTest]
        public IEnumerator Run_Hover_OnATextField_PointsAtItsOwnInputPart()
        {
            var field = Node("field", "input", ("position", "absolute"), ("left", "20px"), ("top", "20px"), ("width", "200px"), ("height", "40px"),
                ("background-color", "#112233")).With("hover", ("background-color", "#445566"));
            var export = Export(Small(BlackRoot(field)));
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var req = Request(export, screen, "default@320x180.hover.field", 320, 180, CaptureApply.Pseudo("hover", "field"));
            yield return DesignCapture.Run(req, profile);
            Assert.AreEqual("#445566", Hex(Pixel(Png(req), 30, 30)), "the field is hovered");
        }

        [UnityTest]
        public IEnumerator Run_Breakpoints_HoldAtTheViewportsLogicalWidth_AndTheirLayersApply()
        {
            // 320×180 reference at match 0.5: 240×180 renders at scale lerp(0.75, 1, 0.5) = 0.875, a logical width of 274 px
            var hero = Box("hero", "#16c2d5").With("bp:narrow", ("height", "24px")).With("bp:narrow+state:loading", ("background-color", "#ff8800"));
            var ir = Small(BlackRoot(hero));
            ir.States = new[] { "default", "loading" };
            ir.Breakpoints = new[] { new IrBreakpoint { Name = "narrow", MaxWidth = 300 }, new IrBreakpoint { Name = "tall", MaxAspect = 1.2f } };
            var export = Export(ir);
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);

            CollectionAssert.AreEqual(new[] { "narrow" }, DesignCapture.ActiveBreakpoints(ir, new Vector2Int(240, 180)).ToArray());
            CollectionAssert.AreEqual(new string[0], DesignCapture.ActiveBreakpoints(ir, new Vector2Int(320, 180)).ToArray());
            CollectionAssert.AreEqual(new[] { "narrow", "tall" }, DesignCapture.ActiveBreakpoints(ir, new Vector2Int(160, 180)).ToArray(), "160×180: 213 × 240 logical px, aspect 0.89");

            var wide = Request(export, screen, "default@320x180", 320, 180);
            yield return DesignCapture.Run(wide, profile);
            Assert.AreEqual(40.0, (double)Boxes(wide)["elements"]["hero"]["h"], 1e-3, "no breakpoint holds at the reference");

            var narrow = Request(export, screen, "default@240x180", 240, 180);
            yield return DesignCapture.Run(narrow, profile);
            Assert.AreEqual(24 * 0.875, (double)Boxes(narrow)["elements"]["hero"]["h"], 0.5, "the bp:narrow height");

            var both = Request(export, screen, "loading@240x180", 240, 180);
            yield return DesignCapture.Run(both, profile);
            Assert.AreEqual("#ff8800", Hex(Pixel(Png(both), 20, 10)), "a breakpoint and a state together");
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

        static string AnimJob(string name, string state, int w, int h, string apply, string sampled, string runs, string from, int sample, double time) =>
            "{ \"name\": \"" + name + "\", \"state\": \"" + state + "\", \"viewport\": [" + w + ", " + h + "], \"apply\": [" + apply + "], \"pseudo\": null, \"coverage\": null, " +
            "\"anim\": { \"sampled\": [" + sampled + "], \"runs\": [" + runs + "], \"from\": " + (from ?? "null") + ", \"sample\": " + sample + ", \"time\": " +
            time.ToString(System.Globalization.CultureInfo.InvariantCulture) + " } }";

        static string Ref(string id, int index) => "{ \"elementId\": \"" + id + "\", \"index\": " + index + " }";

        /// <summary>A tile whose hover transitions its background (400 ms, linear) and a dot that slides 0 → 100px on show (1000 ms, linear, fill both).</summary>
        static IrScreen AnimatedSmall()
        {
            var tile = Box("tile", "#112233").With("hover", ("background-color", "#445566"));
            tile.Anims.AddRange(AnimationPlayerTests.BothWays("hover", 400, 0, "linear", "background-color"));
            var dot = Box("dot", "#ff8800");
            dot.Anims.Add(AnimationPlayerTests.Keyframes("show", "slide", 1000, 0, "linear", 1, "normal", "both",
                (0, null, new[] { ("translate", "0px") }), (1, null, new[] { ("translate", "100px") })));
            return Small(BlackRoot(tile, dot));
        }

        /// <summary>The periodic flush counts jobs: an animation series of 30 samples is 30 jobs, so the next job finds them on disk.</summary>
        [UnityTest]
        public IEnumerator CaptureAll_CountsEverySampleOfASeries_ForThePeriodicFlush()
        {
            var samples = Enumerable.Range(0, 30).Select(i => AnimJob("default@320x180.anim.dot." + i, "default", 320, 180, "", Ref("dot", 0), Ref("dot", 0), null, i, i * 30));
            var matrix = "{ \"captures\": [" + string.Join(",", samples) + ", { \"name\": \"default@320x180\", \"state\": \"default\", \"viewport\": [320, 180], \"apply\": [] } ] }";
            var export = Export(AnimatedSmall(), null, matrix);
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outDir = TempDir();
            var run = DesignCapture.CaptureAll(export, screen, profile, outDir, new CaptureResult());
            bool flushed = false;
            try
            {
                while (run.MoveNext())
                {
                    yield return run.Current;
                    if (File.Exists(Path.Combine(outDir, DesignCapture.DoneFileName))) break;
                    var path = Path.Combine(outDir, DesignCapture.MetaFileName);
                    var meta = File.Exists(path) ? JObject.Parse(File.ReadAllText(path)) : null;
                    if (meta != null && ((JArray)meta["captured"]).Count == 30) { flushed = true; break; }
                }
            }
            finally { (run as IDisposable)?.Dispose(); }
            Assert.IsTrue(flushed, "the 30 samples were flushed before the run went on (every 25 jobs)");
        }

        [UnityTest]
        public IEnumerator CaptureAll_CapturesEveryJob_AnimationSamplesAtTheirTimes_AndCopiesTheManifest()
        {
            var hover = Pseudo("hover", "tile");
            var from = "{ \"state\": \"default\", \"apply\": [] }";
            var matrix = "{ \"captures\": [" +
                         "{ \"name\": \"default@320x180\", \"state\": \"default\", \"viewport\": [320, 180], \"apply\": [], \"pseudo\": null, \"coverage\": null, \"anim\": null, \"frozen\": [[\"dot\", \"slide\"]] }," +
                         "{ \"name\": \"default@320x180.hover.tile\", \"state\": \"default\", \"viewport\": [320, 180], \"apply\": [ " + hover + " ], \"pseudo\": { \"kind\": \"hover\", \"elementId\": \"tile\" }, \"coverage\": null, \"anim\": null }," +
                         "{ \"name\": \"loading@160x90\", \"state\": \"loading\", \"viewport\": [160, 90], \"apply\": [], \"pseudo\": null, \"coverage\": null, \"anim\": null }," +
                         AnimJob("default@320x180.anim.dot.0", "default", 320, 180, "", Ref("dot", 0), Ref("dot", 0), null, 0, 0) + "," +
                         AnimJob("default@320x180.anim.dot.1", "default", 320, 180, "", Ref("dot", 0), Ref("dot", 0), null, 1, 500) + "," +
                         AnimJob("default@320x180.anim.tile.0", "default", 320, 180, hover, Ref("tile", 0), Ref("tile", 0), from, 0, 0) + "," +
                         AnimJob("default@320x180.anim.tile.1", "default", 320, 180, hover, Ref("tile", 0), Ref("tile", 0), from, 1, 200) + "," +
                         AnimJob("default@320x180.anim.tile.2", "default", 320, 180, hover, Ref("tile", 0), Ref("tile", 0), from, 2, 400) +
                         "], \"unsampled\": [] }";
            var export = Export(AnimatedSmall(), null, matrix);
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outDir = TempDir();
            File.WriteAllText(Path.Combine(outDir, "default@320x180.anim.tile.0.png"), "stale");

            var result = new CaptureResult();
            yield return DesignCapture.CaptureAll(export, screen, profile, outDir, result);

            Assert.IsEmpty(result.Errors, string.Join("\n", result.Errors));
            Assert.IsEmpty(result.NotCaptured.Select(n => n.Capture + ": " + n.Reason));
            Assert.AreEqual(8, result.Captured.Count);
            var boxes = JObject.Parse(File.ReadAllText(Path.Combine(outDir, "boxes.json")));
            CollectionAssert.AreEquivalent(result.Captured, boxes.Properties().Select(p => p.Name), "boxes.json holds every capture");
            Assert.AreEqual(0.5, (double)boxes["loading@160x90"]["scale"], 1e-9);
            double DotX(string capture) => (double)boxes[capture]["elements"]["dot"]["x"];
            Assert.AreEqual(100, DotX("default@320x180") - DotX("default@320x180.anim.dot.0"), 0.51, "a static capture shows the slide's end frame (the golden's freeze)");
            Assert.AreEqual(50, DotX("default@320x180.anim.dot.1") - DotX("default@320x180.anim.dot.0"), 0.51, "500 of 1000 ms after the screen opened");
            Color32 TileAt(string capture)
            {
                var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false, true);
                Assert.IsTrue(tex.LoadImage(File.ReadAllBytes(Path.Combine(outDir, capture + ".png"))));
                var b = (JObject)boxes[capture]["elements"]["tile"];
                var c = Pixel(tex, (int)((double)b["x"] + 10), (int)((double)b["y"] + 10));
                UnityEngine.Object.DestroyImmediate(tex);
                return c;
            }
            AssertNear("#112233", TileAt("default@320x180.anim.tile.0"), 1, "the change at 0 ms");
            AssertNear("#2b3c4d", TileAt("default@320x180.anim.tile.1"), 2, "half-way at 200 ms (linear)");
            AssertNear("#445566", TileAt("default@320x180.anim.tile.2"), 1, "the hover value at 400 ms");
            AssertNear("#445566", TileAt("default@320x180.hover.tile"), 1, "a static hover capture shows the end of the transition");
            var copied = GeneratedManifest.Load(Path.Combine(outDir, ScreenCompiler.ManifestFileName));
            Assert.IsNotNull(copied, "the compiled manifest (removed wrappers) is next to the captures");
            Assert.AreEqual("capture.test", copied.screen);
        }

        [UnityTest]
        public IEnumerator CaptureAll_ATriggerClassTheMarkupHas_IsTakenOffForTheOffSide_AndPutBack()
        {
            // the panel starts open (is-open in its markup); leaving the class slides it out, entering slides it in
            var panel = Box("panel", "#ff8800").With("class:is-open", ("translate", "0px"));
            panel.Style["base"]["translate"] = "-100px";
            panel.Classes = new[] { "panel", "is-open" };
            panel.Anims.AddRange(AnimationPlayerTests.BothWays("class:is-open", 200, 0, "linear", "translate"));
            const string on = "{ \"kind\": \"class\", \"name\": \"is-open\", \"elementId\": \"panel\" }";
            const string off = "{ \"kind\": \"class\", \"name\": \"is-open\", \"elementId\": \"panel\", \"absent\": true }";
            var matrix = "{ \"captures\": [" +
                         "{ \"name\": \"default@320x180\", \"state\": \"default\", \"viewport\": [320, 180], \"apply\": [], \"pseudo\": null, \"coverage\": null, \"anim\": null }," +
                         AnimJob("default@320x180.anim.panel.0", "default", 320, 180, on, Ref("panel", 0), Ref("panel", 0), "{ \"state\": \"default\", \"apply\": [" + off + "] }", 0, 100) + "," +
                         AnimJob("default@320x180.anim.panel.1", "default", 320, 180, off, Ref("panel", 1), Ref("panel", 1), "{ \"state\": \"default\", \"apply\": [" + on + "] }", 1, 100) +
                         "] }";
            var export = Export(Small(BlackRoot(panel)), null, matrix);
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outDir = TempDir();
            var result = new CaptureResult();
            yield return DesignCapture.CaptureAll(export, screen, profile, outDir, result);
            Assert.IsEmpty(result.Errors, string.Join("\n", result.Errors));
            Assert.IsEmpty(result.NotCaptured.Select(n => n.Capture + ": " + n.Reason));
            var boxes = JObject.Parse(File.ReadAllText(Path.Combine(outDir, "boxes.json")));
            double X(string capture) => (double)boxes[capture]["elements"]["panel"]["x"];
            Assert.AreEqual(0, X("default@320x180"), 0.51, "the screen starts open, nothing running");
            Assert.AreEqual(-50, X("default@320x180.anim.panel.0"), 0.51, "entering again: half way in at 100 of 200 ms");
            Assert.AreEqual(-50, X("default@320x180.anim.panel.1"), 0.51, "leaving: half way out");
        }

        [UnityTest]
        public IEnumerator CaptureAll_ListsTheSamplesOfAScreenWithoutAnimationData_AsNotCaptured()
        {
            var tile = Box("tile", "#112233").With("hover", ("background-color", "#445566"));
            var matrix = "{ \"captures\": [" +
                         AnimJob("default@320x180.anim.tile.0", "default", 320, 180, "", Ref("tile", 0), Ref("tile", 0), null, 0, 0) + "," +
                         AnimJob("default@320x180.anim.tile.1", "default", 320, 180, "", Ref("tile", 0), Ref("tile", 0), null, 1, 100) + "] }";
            var export = Export(Small(Root(tile)), null, matrix);
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outDir = TempDir();
            var result = new CaptureResult();
            yield return DesignCapture.CaptureAll(export, screen, profile, outDir, result);
            Assert.IsEmpty(result.Errors, string.Join("\n", result.Errors));
            Assert.AreEqual(2, result.NotCaptured.Count);
            StringAssert.Contains("no animation player", result.NotCaptured[0].Reason);
            Assert.IsFalse(File.Exists(Path.Combine(outDir, "default@320x180.anim.tile.0.png")));
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

        [UnityTest]
        public IEnumerator CaptureEach_CapturesEveryExportIntoItsOwnFolder_AndAFailingExportDoesNotStopTheNext()
        {
            string Named(string screen, string color)
            {
                var ir = Small(BlackRoot(Box("tile", color)));
                ir.Screen = screen;
                return Export(ir, null, "{ \"captures\": [" + Job("default@320x180", "default", 320, 180) + "] }");
            }
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var a = Named("capture.a", "#112233");
            var b = Named("capture.b", "#445566");
            var notCompiled = Named("capture.none", "#778899");
            foreach (var export in new[] { a, b }) Assert.IsTrue(ScreenCompiler.Compile(export, profile, false, NoView()).Ok);
            var outs = new[] { TempDir(), TempDir(), TempDir() };

            var errors = new List<string>();
            yield return DesignCapture.CaptureEach(new[] { a, notCompiled, b }, outs, profile, errors);

            Assert.AreEqual(1, errors.Count, string.Join("\n", errors));
            StringAssert.StartsWith(notCompiled + ": ", errors[0]);
            StringAssert.Contains("not a compiled screen", errors[0]);
            foreach (var i in new[] { 0, 2 })
            {
                Assert.IsTrue(File.Exists(Path.Combine(outs[i], DesignCapture.DoneFileName)), "captured " + i);
                Assert.IsTrue(File.Exists(Path.Combine(outs[i], "default@320x180.png")), "png " + i);
            }
            Assert.IsFalse(File.Exists(Path.Combine(outs[1], DesignCapture.DoneFileName)), "the export that failed has no done marker");
            AssertNear("#112233", Pixel(LoadPng(outs[0]), 20, 10), 1, "first export's own screen");
            AssertNear("#445566", Pixel(LoadPng(outs[2]), 20, 10), 1, "third export's own screen");

            var mismatch = new List<string>();
            yield return DesignCapture.CaptureEach(new[] { a, b }, new[] { outs[0] }, profile, mismatch);
            StringAssert.Contains("2 export folders but 1 output folder", mismatch.Single());
        }

        Texture2D LoadPng(string outDir)
        {
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false, true);
            _objects.Add(tex);
            Assert.IsTrue(tex.LoadImage(File.ReadAllBytes(Path.Combine(outDir, "default@320x180.png"))));
            return tex;
        }

        [UnityTest]
        public IEnumerator CaptureAll_WritesTheRunnersRunId_IntoTheDoneMarkerAndTheMeta()
        {
            var export = Export(Small(BlackRoot(Box("tile", "#112233"))), null, "{ \"captures\": [" + Job("default@320x180", "default", 320, 180) + "] }");
            var profile = Profile(new Vector2Int(320, 180), 0.5f);
            var screen = Compile(export, profile);
            var outDir = TempDir();
            yield return DesignCapture.CaptureAll(export, screen, profile, outDir, new CaptureResult(), "fidelity-1234");
            Assert.AreEqual("fidelity-1234", (string)JObject.Parse(File.ReadAllText(Path.Combine(outDir, DesignCapture.DoneFileName)))["runId"]);
            Assert.AreEqual("fidelity-1234", (string)JObject.Parse(File.ReadAllText(Path.Combine(outDir, DesignCapture.MetaFileName)))["runId"]);
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
