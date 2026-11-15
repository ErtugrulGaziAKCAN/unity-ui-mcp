using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
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
    /// Scaled viewports through a uniform root scale (docs/findings/viewport-classes.md): at a panel scale none of the
    /// profile's exact viewports has, a compiled screen root (DesignScreen, <c>exact-scales</c>) makes its panel lay out at
    /// the next exact scale up (the PanelSettings' scale factor) and draws itself scaled by actual / exact from its top-left
    /// corner, so every length is whole device pixels where it is laid out and every edge falls where the design puts it at
    /// the actual scale. Panels here render into textures of the viewport's size.
    /// </summary>
    public class RootScaleTests
    {
        const string Out = "Assets/DesignUiRootScaleTests";
        static readonly Vector2Int Reference = new Vector2Int(2560, 1440);
        /// <summary>The exact viewports' panel scales of the default kit: 2560×1440, 1920×1080, 1280×720, 3840×2160.</summary>
        static readonly double[] Exact = { 1, 0.75, 0.5, 1.5 };

        readonly List<Object> _objects = new List<Object>();
        readonly List<string> _temp = new List<string>();
        PanelSettings _settings;
        DesignViewportScales.BaseRule _rule;

        [SetUp]
        public void KeepRule()
        {
            _rule = DesignViewportScales.Rule;
            DesignRootScalePanels.Playing = () => Application.isPlaying;
            // a test that failed half-way leaves no held factor behind for the next
            DesignRootScalePanels.RestoreAll();
            DesignRootScalePanels.ForgetReleased();
        }

        [TearDown]
        public void Cleanup()
        {
            DesignViewportScales.Rule = _rule;
            DesignRootScalePanels.Playing = () => Application.isPlaying;
            DesignRootScalePanels.RestoreAll();
            DesignRootScalePanels.ForgetReleased();
            for (int i = _objects.Count - 1; i >= 0; i--)
                if (_objects[i] is GameObject g && g != null) Object.DestroyImmediate(g);
            for (int i = _objects.Count - 1; i >= 0; i--)
                if (_objects[i] != null) Object.DestroyImmediate(_objects[i]);
            _objects.Clear();
            _settings = null;
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
            FontFixture.Delete();
        }

        T Track<T>(T o) where T : Object
        {
            _objects.Add(o);
            return o;
        }

        static double ScaleOf(int w, int h) => BoxesWriter.Scale(new Vector2Int(w, h), Reference, 0.5f);

        static IEnumerator Frames(int n)
        {
            for (int i = 0; i < n; i++) yield return null;
        }

        [Test]
        public void LayoutScale_IsThePanelsOwnWhereExact_ElseTheNextExactScaleUp_OrTheRulesNeighbour()
        {
            double s1366 = ScaleOf(1366, 768);
            Assert.AreEqual(DesignViewportScales.BaseRule.Up, DesignViewportScales.Rule, "the default: drawn at most 1, so layout's rounding stays within half a device pixel");
            Assert.AreEqual(0.75, DesignViewportScales.LayoutScale(Exact, 0.75));
            Assert.AreEqual(0.75, DesignViewportScales.LayoutScale(Exact, 0.75 + 5e-5), "within the tolerance");
            Assert.AreEqual(0.75, DesignViewportScales.LayoutScale(Exact, 0.625));
            Assert.AreEqual(0.75, DesignViewportScales.LayoutScale(Exact, s1366), "0.5335: the next up, not the nearer 0.5");
            Assert.AreEqual(1.5, DesignViewportScales.LayoutScale(Exact, 2.0), "above every exact scale: the largest");
            Assert.AreEqual(0.5, DesignViewportScales.LayoutScale(Exact, 0.4), "below every exact scale: the smallest");
            Assert.AreEqual(0.6, DesignViewportScales.LayoutScale(null, 0.6), "no exact scales: the panel's own");
            DesignViewportScales.Rule = DesignViewportScales.BaseRule.Nearest;
            Assert.AreEqual(0.75, DesignViewportScales.LayoutScale(Exact, 0.625), "|ln 1.2| < |ln 0.8|");
            Assert.AreEqual(0.5, DesignViewportScales.LayoutScale(Exact, s1366));
            Assert.AreEqual(1.5, DesignViewportScales.LayoutScale(Exact, 2.0));
            DesignViewportScales.Rule = DesignViewportScales.BaseRule.Down;
            Assert.AreEqual(0.5, DesignViewportScales.LayoutScale(Exact, 0.625));
            Assert.AreEqual(0.5, DesignViewportScales.LayoutScale(Exact, 0.4));
            Assert.AreEqual(1, DesignViewportScales.LayoutScale(Exact, 1), "an exact scale is its own under any rule");
            CollectionAssert.AreEqual(Exact, DesignViewportScales.Parse(DesignViewportScales.Encode(Exact)));
            Assert.AreEqual(1, DesignViewportScales.Parse("0.5;x;-1;0").Length, "malformed and non-positive entries are left out");
        }

        // ---- a compiled screen ------------------------------------------------------------------------------------------

        DesignUiProfile Profile()
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            Track(p);
            p.outputFolder = Out;
            p.viewports = new[] { new Vector2Int(2560, 1440), new Vector2Int(1920, 1080), new Vector2Int(1280, 720), new Vector2Int(3840, 2160) };
            p.scaledViewports = new[] { new Vector2Int(1600, 900), new Vector2Int(1366, 768) };
            FontFixture.Use(p);
            return p;
        }

        /// <summary>
        /// A screen with odd design lengths: a box at (397, 101) of 403×37 px, a column of ten rows with 4 px padding above and
        /// below a 20 px child (UI Toolkit lays 4 px out as 3 device px at 0.625 and 2 at 0.5335), a caption, and width
        /// breakpoints that only the design's size tells apart from the panel's laid-out size: <c>wide</c> (at least 2400) and
        /// <c>narrow</c> (at most 2400) at 1600×900 and 1366×768, <c>mid</c> (at least 2000) at 1366×768 and 1280×1024. The
        /// design is 2560 px wide at every 16:9 viewport and 2114 at 1280×1024; the panel, laid out at the next exact scale up,
        /// is 2133 px wide at 1600×900, 1821 at 1366×768 and 1707 at 1280×1024.
        /// </summary>
        string Export(Action<IrNode> edit = null)
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-rootscale-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            var family = "\"" + FontFixture.Regular.faceInfo.familyName + "\"";
            var box = Node("box", "container", ("position", "absolute"), ("left", "397px"), ("top", "101px"), ("width", "403px"), ("height", "37px"), ("background-color", "#ff0000"));
            var rows = Node("rows", "container", ("position", "absolute"), ("left", "40px"), ("top", "200px"), ("width", "400px"), ("display", "flex"), ("flex-direction", "column"));
            for (int i = 0; i < 10; i++)
                rows.Add(Node("row" + i, "container", ("padding-top", "4px"), ("padding-bottom", "4px"), ("display", "flex"), ("flex-direction", "column"))
                    .Add(Node("cell" + i, "container", ("height", "20px"), ("background-color", "#00ff00"))));
            var caption = Text("caption", "Merhaba dünya, bugün", ("color", "#ffffff"), ("position", "absolute"), ("left", "801px"), ("top", "203px"), ("font-size", "12px"),
                ("font-family", family), ("white-space", "nowrap"));
            var root = Node("root", "container", ("position", "relative"), ("width", "2560px"), ("height", "1440px"), ("font-family", family)).Add(box, rows, caption);
            edit?.Invoke(root);
            var screen = TestIr.Screen(root, "rootscale.screen");
            screen.Breakpoints = new[] { new IrBreakpoint { Name = "wide", MinWidth = 2400 }, new IrBreakpoint { Name = "narrow", MaxWidth = 2400 }, new IrBreakpoint { Name = "mid", MinWidth = 2000 } };
            if (root.Style.Keys.Any(k => k.StartsWith("state:", StringComparison.Ordinal)))
                screen.States = new[] { "default" }.Concat(root.Style.Keys.Where(k => k.StartsWith("state:", StringComparison.Ordinal)).Select(k => k.Substring(6)).Distinct()).ToArray();
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(screen, Formatting.Indented));
            File.WriteAllText(Path.Combine(dir, KitTextStyles.FileName), "{ \"caption\": { \"fontSize\": 12, \"lineHeight\": 16, \"weight\": 400 } }");
            return dir;
        }

        VisualTreeAsset CompileScreen(Action<IrNode> edit = null)
        {
            var result = ScreenCompiler.Compile(Export(edit), Profile(), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            return AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/RootscaleScreen/RootscaleScreen.uxml");
        }

        [Test]
        public void Compile_TheRootCarriesTheExactScales_AndACustomProperty_AndNoScaledViewportTwinsAreMade()
        {
            CompileScreen();
            var uxml = File.ReadAllText(Out + "/RootscaleScreen/RootscaleScreen.uxml");
            StringAssert.Contains("exact-scales=\"" + DesignViewportScales.Encode(Exact) + "\"", uxml);
            StringAssert.DoesNotContain("viewport-scales", uxml);
            var uss = File.ReadAllText(Out + "/RootscaleScreen/RootscaleScreen.uss");
            StringAssert.Contains("DesignScreen {\n    " + ScreenBuilder.ScaleWatchProperty + ": 1;\n}", uss);
            StringAssert.DoesNotContain(".vs-", File.ReadAllText(Out + "/" + FontMap.FileName));
            Assert.IsEmpty(Directory.GetFiles(FontFixture.TwinFolder, "*x0p*.asset"), "no twin is made for a scaled viewport");
        }

        RenderTexture Texture(int w, int h) => Track(new RenderTexture(w, h, 24));

        /// <summary>A full-screen document on a copy of the package's PanelSettings (scale with screen size, 2560×1440, match 0.5).</summary>
        UIDocument Document(int w, int h)
        {
            _settings = Track(Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings()));
            // a copy no save writes, as a capture's or a region's: the Editor holds a factor only there outside Play mode
            _settings.hideFlags = HideFlags.DontSave;
            _settings.scaleMode = PanelScaleMode.ScaleWithScreenSize;
            _settings.referenceResolution = Reference;
            _settings.screenMatchMode = PanelScreenMatchMode.MatchWidthOrHeight;
            _settings.match = 0.5f;
            _settings.scale = 1f;
            _settings.targetTexture = Texture(w, h);
            var doc = Track(new GameObject("RootScaleTests")).AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            return doc;
        }

        static void AreDevice(Rect expected, Rect worldBound, double ppp, double tolerance, string what)
        {
            var actual = new Rect((float)(worldBound.x * ppp), (float)(worldBound.y * ppp), (float)(worldBound.width * ppp), (float)(worldBound.height * ppp));
            Assert.AreEqual(expected.x, actual.x, tolerance, what + ": x, device " + actual);
            Assert.AreEqual(expected.y, actual.y, tolerance, what + ": y, device " + actual);
            Assert.AreEqual(expected.width, actual.width, tolerance, what + ": width, device " + actual);
            Assert.AreEqual(expected.height, actual.height, tolerance, what + ": height, device " + actual);
        }

        /// <summary>
        /// The design at the actual scale: a full-screen document moved through every default viewport by new target textures,
        /// with no call into the screen (the root follows the panel's scale by itself, also from 1920×1080 to 1600×900, where
        /// the panel keeps its size in panel pixels). At a scaled viewport the panel lays out at the next exact scale up and every
        /// edge is the design's times the actual scale (the box at 397.0 px is at 248.125 device px at 0.625, as in Chromium),
        /// padded rows add up to the design's height, text keeps its width; at an exact one nothing is scaled. The PanelSettings
        /// get their own factor back when the screen leaves.
        /// </summary>
        [UnityTest]
        public IEnumerator FullScreenDocument_AtEveryViewport_HasTheDesignsGeometryAtTheActualScale()
        {
            var tree = CompileScreen();
            var doc = Document(1920, 1080);
            yield return Frames(2);
            var instance = tree.Instantiate();
            doc.rootVisualElement.Add(instance);
            var screen = instance.Q<DesignScreen>("root");
            Assert.IsNotNull(screen);
            yield return Frames(6);
            var captionAt1 = 0.0;
            var report = new List<string>();
            foreach (var (w, h) in new[] { (1920, 1080), (2560, 1440), (1600, 900), (1366, 768), (3840, 2160), (1280, 720), (1280, 1024), (1600, 900) })
            {
                if (_settings.targetTexture.width != w || _settings.targetTexture.height != h) _settings.targetTexture = Texture(w, h);
                yield return Frames(6);
                double actual = ScaleOf(w, h), ppp = screen.panel.scaledPixelsPerPoint, exact = DesignViewportScales.LayoutScale(Exact, actual);
                string at = w + "×" + h;
                Assert.AreEqual(actual, screen.DesignScale ?? double.NaN, 1e-4, at + ": the design's scale");
                Assert.AreEqual(exact, ppp, 1e-4, at + ": the panel lays out at the exact scale");
                Assert.AreEqual(actual / exact, screen.RootScale, 1e-4, at + ": the root's scale");
                Assert.AreEqual(exact / actual, _settings.scale, 1e-4, at + ": the PanelSettings' factor");
                Assert.AreEqual(actual == exact, screen.style.scale.keyword == StyleKeyword.Null, at + ": an inline scale only where scaled");
                // Yoga puts each edge on the device grid of the scale it lays out at: half a device pixel there, times the root's scale
                double grid = 0.5 * screen.RootScale + 0.01;
                AreDevice(new Rect(0, 0, (float)(2560 * actual), (float)(1440 * actual)), screen.worldBound, ppp, 0.01, at + " root (the reference size at the actual scale)");
                AreDevice(new Rect((float)(397 * actual), (float)(101 * actual), (float)(403 * actual), (float)(37 * actual)), instance.Q("box").worldBound, ppp, 2 * grid, at + " box");
                AreDevice(new Rect((float)(40 * actual), (float)(200 * actual), (float)(400 * actual), (float)(280 * actual)), instance.Q("rows").worldBound, ppp, 2 * grid, at + " ten padded rows");
                // the rows' own height has no rounding to add: 10 × (4 + 20 + 4) px, each part whole device pixels where laid out
                Assert.AreEqual(280 * actual, instance.Q("rows").layout.height * screen.panel.scaledPixelsPerPoint * screen.RootScale, 0.01, at + ": ten padded rows add up to the design's height");
                var caption = instance.Q<Label>("caption");
                double width = caption.worldBound.width * ppp;
                if (w == 2560) captionAt1 = width;
                if (captionAt1 > 0) Assert.AreEqual(captionAt1 * actual, width, 1.0, at + ": the caption keeps its width (the panel's text is whole device px)");
                // the design's width: 2560 at 16:9, 1280 / 0.6056 = 2114 at 1280×1024 (the panel's laid-out width at the exact
                // scale: 2133 at 1600×900, 1821 at 1366×768, 1280 / 0.75 = 1707 at 1280×1024)
                double designWidth = w / actual;
                Assert.AreEqual(designWidth >= 2400, screen.ClassListContains("bp-wide"), at + ": min-width 2400 at the design's width " + designWidth.ToString("0"));
                Assert.AreEqual(designWidth <= 2400, screen.ClassListContains("bp-narrow"), at + ": max-width 2400 at the design's width " + designWidth.ToString("0"));
                Assert.AreEqual(designWidth >= 2000, screen.ClassListContains("bp-mid"), at + ": min-width 2000 at the design's width " + designWidth.ToString("0"));
                report.Add(at + ": panel " + ppp.ToString("0.#####") + ", root " + screen.RootScale.ToString("0.#####") + ", caption " + width.ToString("0.###") + " device px");
            }
            Debug.Log("Root scale across the default viewports:\n" + string.Join("\n", report));
            Assert.AreEqual(1, DesignRootScalePanels.Count);
            Object.DestroyImmediate(doc.gameObject);
            Assert.AreEqual(1f, _settings.scale, "the PanelSettings' own factor is back");
            Assert.AreEqual(0, DesignRootScalePanels.Count);
        }

        /// <summary>A factor the game sets while a screen holds the panel is the settings' own: the exact scale is applied on top, and it is kept.</summary>
        [UnityTest]
        public IEnumerator AGamesOwnScaleFactor_IsKept_AndTheExactScaleAppliedOnTop()
        {
            var tree = CompileScreen();
            var doc = Document(1600, 900);
            yield return Frames(2);
            var instance = tree.Instantiate();
            doc.rootVisualElement.Add(instance);
            var screen = instance.Q<DesignScreen>("root");
            yield return Frames(6);
            Assert.AreEqual(0.75, screen.panel.scaledPixelsPerPoint, 1e-4);
            _settings.scale = 0.9f; // the game's UI scale option: 0.625 × 0.9 = 0.5625, the next exact scale up 0.75
            screen.panel.visualTree.MarkDirtyRepaint(); // a panel applies its settings when it updates: every frame in Play mode, here when dirty
            yield return Frames(6);
            Assert.AreEqual(0.5625, screen.DesignScale ?? double.NaN, 1e-4);
            Assert.AreEqual(0.75, screen.panel.scaledPixelsPerPoint, 1e-4);
            Assert.AreEqual(0.75, screen.RootScale, 1e-4);
            Assert.AreEqual(0.9f * 0.75f / 0.5625f, _settings.scale, 1e-4, "the game's factor times exact / actual");
            AreDevice(new Rect((float)(397 * 0.5625), (float)(101 * 0.5625), (float)(403 * 0.5625), (float)(37 * 0.5625)), instance.Q("box").worldBound, 0.75, 0.75 + 0.01, "box");
            instance.RemoveFromHierarchy();
            Assert.AreEqual(0.9f, _settings.scale, 1e-6, "the game's factor is back");
        }

        // ---- a region on a sort-order copy, through the gamma composite ---------------------------------------------------

        /// <summary>
        /// A uGUI shell frames the screen (DesignUiPanelRegion with its own sort order: its document renders on a runtime copy
        /// of the PanelSettings) and a gamma composite renders the asset and the copy into screen-sized textures (Linear
        /// projects). At 1600×900 and, after a resize, 1366×768: the copy starts with the asset's own factor and the screen
        /// holds the copy's (the asset keeps its own), the screen's top-left corner is the frame's and an element is where the
        /// design puts it at the actual scale, and a pointer at its screen position is over the panel and picks it through the
        /// composite's mapping. Detached, every PanelSettings has its own factor back.
        /// </summary>
        [UnityTest]
        public IEnumerator ARegionsSortOrderCopy_ThroughTheGammaComposite_HoldsTheExactScale_AndMapsThePointer()
        {
            if (QualitySettings.activeColorSpace != ColorSpace.Linear) Assert.Ignore("the composite does nothing in a Gamma project");
            var locales = DesignLocaleSources.Default;
            DesignLocaleSources.Default = null;
            DesignUiGammaComposite composite = null;
            DesignUiPanelRegion region = null;
            Camera camera = null;
            try
            {
                var rt = Texture(1600, 900);
                camera = Track(new GameObject("RootScaleTests camera")).AddComponent<Camera>();
                camera.targetTexture = rt;
                var canvasGo = Track(new GameObject("RootScaleTests shell", typeof(RectTransform)));
                var canvas = canvasGo.AddComponent<Canvas>();
                canvas.renderMode = RenderMode.ScreenSpaceCamera;
                canvas.worldCamera = camera;
                canvas.planeDistance = 10;
                var frame = (RectTransform)new GameObject("frame", typeof(RectTransform)).transform;
                frame.SetParent(canvasGo.transform, false);
                frame.anchorMin = new Vector2(0.1f, 0.2f);
                frame.anchorMax = new Vector2(0.7f, 0.9f);
                frame.offsetMin = Vector2.zero;
                frame.offsetMax = Vector2.zero;

                var settings = Track(Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings()));
                settings.hideFlags = HideFlags.DontSave;
                settings.scale = 1f;
                settings.sortingOrder = 0;
                composite = Track(new GameObject("RootScaleTests composite")).AddComponent<DesignUiGammaComposite>();
                composite.panelSettings = settings;
                composite.Attach(settings, new Vector2Int(1600, 900), new Vector2Int(1600, 900));
                var doc = Track(new GameObject("RootScaleTests screen")).AddComponent<UIDocument>();
                doc.panelSettings = settings;
                region = frame.gameObject.AddComponent<DesignUiPanelRegion>();
                region.Settings = new DesignUiHostSettings { sortingOrder = 5 };
                region.Document = doc;
                region.Attach();
                var copy = doc.panelSettings;
                Assert.AreNotSame(settings, copy, "the region renders on a sort-order copy");
                Assert.IsTrue(DesignUiGammaComposite.Drives(copy), "the composite renders the copy");

                var screen = new DesignScreen { name = "root", ExactScales = DesignViewportScales.Encode(Exact) };
                screen.style.width = 2560;
                screen.style.height = 1440;
                Place(new VisualElement { name = "target" }, screen, 100, 100, 200, 50).style.backgroundColor = Color.red;
                doc.rootVisualElement.Add(screen);

                foreach (var (w, h) in new[] { (1600, 900), (1366, 768) })
                {
                    if (rt.width != w)
                    {
                        rt = Texture(w, h);
                        camera.targetTexture = rt;
                        composite.Resize(new Vector2Int(w, h), new Vector2Int(w, h));
                    }
                    for (int i = 0; i < 8; i++)
                    {
                        Canvas.ForceUpdateCanvases();
                        camera.Render();
                        region.Refresh();
                        yield return null;
                    }
                    string at = w + "×" + h;
                    double actual = ScaleOf(w, h), exact = DesignViewportScales.LayoutScale(Exact, actual);
                    var panel = screen.panel;
                    Assert.AreSame(copy, ((IRuntimePanel)panel).panelSettings, at + ": the screen is on the copy's panel");
                    Assert.AreEqual(exact, panel.scaledPixelsPerPoint, 1e-4, at + ": the copy's panel lays out at the exact scale");
                    Assert.AreEqual(exact / actual, copy.scale, 1e-4, at + ": the copy's factor");
                    Assert.AreEqual(1f, settings.scale, at + ": the asset keeps its own factor");
                    Assert.AreEqual(actual / exact, screen.RootScale, 1e-4, at + ": the root's scale");
                    Assert.AreEqual(new Vector2Int(w, h), new Vector2Int(copy.targetTexture.width, copy.targetTexture.height), at + ": the composite's texture is the screen's");
                    // the frame's top-left corner in device px (origin top left): x 0.1 w, y 0.1 h
                    var target = screen.Q("target");
                    double ppp = panel.scaledPixelsPerPoint;
                    Assert.AreEqual(0.1 * w + 100 * actual, target.worldBound.x * ppp, 0.5 + 0.01, at + ": the element's x in device px");
                    Assert.AreEqual(0.1 * h + 100 * actual, target.worldBound.y * ppp, 0.5 + 0.01, at + ": the element's y in device px");
                    Assert.AreEqual(200 * actual, target.worldBound.width * ppp, 0.5 + 0.01, at + ": the element's width in device px");
                    var centre = new Vector2((float)(0.1 * w + 200 * actual), (float)(0.1 * h + 125 * actual));
                    Assert.AreEqual("target", panel.Pick(RuntimePanelUtils.ScreenToPanel(panel, centre))?.name, at + ": a pointer at the element's screen position picks it");
                    Assert.IsTrue(region.IsPointerOverPanel(new Vector2(centre.x, h - centre.y)), at + ": over the panel (uGUI's position, origin bottom left)");
                    var beside = new Vector2((float)(0.1 * w + 310 * actual), centre.y);
                    Assert.AreNotEqual("target", panel.Pick(RuntimePanelUtils.ScreenToPanel(panel, beside))?.name, at + ": beside the element");
                }
                region.Detach();
                Assert.AreSame(settings, doc.panelSettings);
                Assert.AreEqual(1, DesignRootScalePanels.Count, "the copy's factor went with it; the screen now holds the asset's panel");
                screen.RemoveFromHierarchy();
                Assert.AreEqual(1f, settings.scale, "the asset's own factor");
                Assert.AreEqual(0, DesignRootScalePanels.Count);
                yield return null;
            }
            finally
            {
                if (region != null) region.Detach();
                if (composite != null) composite.Detach();
                if (camera != null) camera.targetTexture = null;
                DesignLocaleSources.Default = locales;
            }
        }

        // ---- input under the root scale ----------------------------------------------------------------------------------

        static readonly PropertyInfo s_PseudoStates = typeof(VisualElement).GetProperty("pseudoStates", BindingFlags.Instance | BindingFlags.NonPublic);

        static string States(VisualElement e) => s_PseudoStates?.GetValue(e)?.ToString() ?? "";

        static void Send(IPanel panel, EventType type, Vector2 at, Vector2 delta = default)
        {
            var e = new Event { type = type, mousePosition = at, button = 0, clickCount = type == EventType.MouseDown ? 1 : 0, delta = delta };
            EventBase evt;
            switch (type)
            {
                case EventType.MouseMove: evt = PointerMoveEvent.GetPooled(e); break;
                case EventType.MouseDown: evt = PointerDownEvent.GetPooled(e); break;
                case EventType.MouseUp: evt = PointerUpEvent.GetPooled(e); break;
                case EventType.ScrollWheel: evt = WheelEvent.GetPooled(e); break;
                default: throw new ArgumentException(type.ToString());
            }
            using (evt) panel.visualTree.SendEvent(evt);
        }

        static VisualElement Place(VisualElement e, VisualElement parent, float x, float y, float w, float h)
        {
            e.style.position = Position.Absolute;
            e.style.left = x;
            e.style.top = y;
            e.style.width = w;
            e.style.height = h;
            parent.Add(e);
            return e;
        }

        /// <summary>
        /// Picking and pointer events through the scaled root at 1600×900 (panel at 0.75, root 0.8333) and 1366×768 (panel at
        /// 0.75, root 0.7113): the pointer reaches an element where the design draws it at the actual scale and nowhere else
        /// (a point inside the unscaled box but outside the drawn one misses); hover, active, a click, a toggle, a wheel over a
        /// scroll view and a drag (the event's position in the dragged element's space). A text field is focused directly (a
        /// synthesized press does not pick a runtime TextField in Edit mode at any scale) and typing is not covered: keyboard
        /// input has no geometry, and synthesized keys hit the field's selection state in Edit mode.
        /// </summary>
        [UnityTest]
        public IEnumerator PickingAndPointerEvents_FollowTheScaledRoot()
        {
            foreach (var (w, h) in new[] { (1920, 1080), (1600, 900), (1366, 768) })
            {
                var doc = Document(w, h);
                yield return Frames(2);
                var screen = new DesignScreen { name = "root", ExactScales = DesignViewportScales.Encode(Exact) };
                screen.style.width = 2560;
                screen.style.height = 1440;
                doc.rootVisualElement.Add(screen);
                int clicks = 0;
                var button = (Button)Place(new Button(() => clicks++) { name = "button", text = "OK" }, screen, 400, 300, 300, 80);
                var toggle = (Toggle)Place(new Toggle { name = "toggle" }, screen, 400, 500, 300, 60);
                var field = (TextField)Place(new TextField { name = "field" }, screen, 400, 700, 600, 60);
                var scroll = (ScrollView)Place(new ScrollView(ScrollViewMode.Vertical) { name = "scroll" }, screen, 1200, 300, 400, 300);
                for (int i = 0; i < 30; i++)
                {
                    var item = new VisualElement { name = "item" + i };
                    item.style.height = 60;
                    item.style.flexShrink = 0;
                    scroll.Add(item);
                }
                var pad = Place(new VisualElement { name = "pad" }, screen, 1200, 800, 600, 40);
                yield return Frames(8);
                var panel = screen.panel;
                float r = screen.RootScale;
                Assert.AreEqual(w == 1920, r == 1f, "the root is scaled at " + w + "×" + h + " only");
                // a design point to the panel point where the scaled root draws it
                Vector2 At(float x, float y) => new Vector2(x * r, y * r);
                string at = w + "×" + h;

                Assert.AreEqual("button", panel.Pick(At(550, 340))?.name, at + ": the button's centre");
                if (r != 1f)
                    Assert.AreNotEqual("button", panel.Pick(r < 1 ? new Vector2(700 * r + 5, 340 * r) : new Vector2(400 * r - 5, 340 * r))?.name,
                        at + ": next to the drawn button, inside its unscaled box");

                Send(panel, EventType.MouseMove, At(550, 340));
                yield return Frames(2);
                StringAssert.Contains("Hover", States(button), at + ": hover");
                Send(panel, EventType.MouseDown, At(550, 340));
                // read at once: in Edit mode the pointer capture behind :active can end with the next Editor update
                StringAssert.Contains("Active", States(button), at + ": active");
                yield return Frames(1);
                Send(panel, EventType.MouseUp, At(550, 340));
                yield return Frames(2);
                Assert.AreEqual(1, clicks, at + ": a click");

                Send(panel, EventType.MouseMove, At(420, 530));
                Send(panel, EventType.MouseDown, At(420, 530));
                Send(panel, EventType.MouseUp, At(420, 530));
                yield return Frames(2);
                Assert.IsTrue(toggle.value, at + ": the toggle was clicked on");

                // a synthesized press does not pick a runtime TextField in Edit mode at any scale (measured at 1920×1080 too) and
                // synthesized keys hit the field's selection state there; keyboard input has no geometry: focus under the root
                field.Focus();
                yield return Frames(2);
                StringAssert.Contains("Focus", States(field), at + ": focus");
                Send(panel, EventType.MouseMove, At(1400, 450));
                Send(panel, EventType.ScrollWheel, At(1400, 450), new Vector2(0, 3));
                yield return Frames(4);
                Assert.Greater(scroll.scrollOffset.y, 0, at + ": the wheel scrolled");

                // a drag: what a drag manipulator reads (the event's position in the element's own space, the pointer captured)
                // is the design's position under the pointer
                var downAt = Vector2.zero;
                var moves = new List<Vector2>();
                pad.RegisterCallback<PointerDownEvent>(e => { downAt = e.localPosition; pad.CapturePointer(e.pointerId); });
                pad.RegisterCallback<PointerMoveEvent>(e => { if (pad.HasPointerCapture(e.pointerId)) moves.Add(e.localPosition); });
                Send(panel, EventType.MouseMove, At(1250, 820));
                Send(panel, EventType.MouseDown, At(1250, 820));
                Send(panel, EventType.MouseMove, At(1450, 830));
                Send(panel, EventType.MouseMove, At(1900, 830)); // past the pad's edge: still captured
                Send(panel, EventType.MouseUp, At(1900, 830));
                pad.ReleasePointer(PointerId.mousePointerId);
                Assert.AreEqual(50, downAt.x, 0.01, at + ": the press at the design's x in the pad");
                Assert.AreEqual(20, downAt.y, 0.01, at + ": the press at the design's y in the pad");
                Assert.AreEqual(2, moves.Count, at + ": the captured moves");
                Assert.AreEqual(250, moves[0].x, 0.01, at + ": a move of 200 design px");
                Assert.AreEqual(700, moves[1].x, 0.01, at + ": a move outside the pad");
                yield return Frames(2);

                Object.DestroyImmediate(doc.gameObject);
                yield return null;
            }
        }

        // ---- the held factor and the project's files --------------------------------------------------------------------

        static string ScaleInFile(string path)
        {
            foreach (var line in File.ReadAllLines(path))
                if (line.TrimStart().StartsWith("m_Scale:", StringComparison.Ordinal)) return line.Trim().Substring("m_Scale:".Length).Trim();
            return null;
        }

        static string SortingOrderInFile(string path)
        {
            foreach (var line in File.ReadAllLines(path))
                if (line.TrimStart().StartsWith("m_SortingOrder:", StringComparison.Ordinal)) return line.Trim().Substring("m_SortingOrder:".Length).Trim();
            return null;
        }

        /// <summary>A PanelSettings asset (a scale-with-screen-size copy of the package's) with a 1600×900 target texture asset, in the test folder.</summary>
        PanelSettings SettingsAsset(string name = "Held")
        {
            if (!AssetDatabase.IsValidFolder(Out)) AssetDatabase.CreateFolder("Assets", Out.Substring("Assets/".Length));
            var rt = new RenderTexture(1600, 900, 24);
            AssetDatabase.CreateAsset(rt, Out + "/" + name + "Target.renderTexture");
            var asset = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            asset.scaleMode = PanelScaleMode.ScaleWithScreenSize;
            asset.referenceResolution = Reference;
            asset.screenMatchMode = PanelScreenMatchMode.MatchWidthOrHeight;
            asset.match = 0.5f;
            asset.scale = 1f;
            asset.targetTexture = rt;
            AssetDatabase.CreateAsset(asset, Out + "/" + name + ".asset");
            AssetDatabase.SaveAssets();
            return asset;
        }

        DesignScreen ShowOn(PanelSettings settings, out UIDocument doc)
        {
            doc = Track(new GameObject("RootScaleTests document")).AddComponent<UIDocument>();
            doc.panelSettings = settings;
            var screen = PlainScreen("root");
            doc.rootVisualElement.Add(screen);
            return screen;
        }

        static string PresetScale(PanelSettings settings)
        {
            var preset = new UnityEditor.Presets.Preset(settings);
            try
            {
                foreach (var m in preset.PropertyModifications) if (m.propertyPath == "m_Scale") return m.value;
                return null;
            }
            finally { Object.DestroyImmediate(preset); }
        }

        /// <summary>
        /// In Edit mode the root scale writes no PanelSettings a save could write: neither an asset nor settings a scene could
        /// save (not <c>DontSave</c>). A screen on them at 1600×900 lays out at the actual scale itself (root scale 1, design
        /// scale 0.625); the asset's object, its file, a preset made of it and the scene-savable settings keep 1, so no save,
        /// build, preset, copy or Undo snapshot in Edit mode can carry a held factor.
        /// </summary>
        [UnityTest]
        public IEnumerator InEditMode_NoSavableSettingsHoldAFactor_TheScreenLaysOutAtTheActualScale()
        {
            var asset = SettingsAsset();
            var path = Out + "/Held.asset";
            var screen = ShowOn(asset, out var doc);
            yield return Frames(6);
            Assert.AreEqual(1f, asset.scale, "the asset's object is never written");
            Assert.AreEqual(1f, screen.RootScale, "laid out at the actual scale, unscaled");
            Assert.AreEqual(ScaleOf(1600, 900), screen.DesignScale ?? double.NaN, 1e-4, "the design's scale");
            Assert.AreEqual(ScaleOf(1600, 900), screen.panel.scaledPixelsPerPoint, 1e-4);
            Assert.AreEqual(0, DesignRootScalePanels.Count);
            Assert.AreEqual("1", PresetScale(asset), "a preset made now");
            EditorUtility.SetDirty(asset);
            AssetDatabase.SaveAssets();
            Assert.AreEqual("1", ScaleInFile(path));
            Object.DestroyImmediate(doc.gameObject);

            // settings a scene could save (in memory, not DontSave)
            var embedded = Track(Object.Instantiate(asset));
            embedded.targetTexture = Texture(1600, 900);
            var screen2 = ShowOn(embedded, out var doc2);
            yield return Frames(6);
            Assert.AreEqual(1f, embedded.scale, "settings a scene could save are never written either");
            Assert.AreEqual(1f, screen2.RootScale);
            Object.DestroyImmediate(doc2.gameObject);
        }

        /// <summary>
        /// In Play mode (simulated: <c>DesignRootScalePanels.Playing</c>) a screen holds the asset's factor in memory: a save
        /// after an Inspector edit (<c>AssetDatabase.SaveAssets</c>, which File > Save runs too) and a save of that asset alone
        /// write its own factor 1 with the edit, and the factor is held again after each save; a build gives it back first
        /// and says so.
        /// </summary>
        [UnityTest]
        public IEnumerator InPlayMode_AHeldAssetsSaves_WriteItsOwnFactor_AndABuildGivesItBack()
        {
            DesignRootScalePanels.Playing = () => true;
            var asset = SettingsAsset();
            var path = Out + "/Held.asset";
            var screen = ShowOn(asset, out var doc);
            yield return Frames(6);
            Assert.AreEqual(1.2f, asset.scale, 1e-4, "held: the panel lays out at 0.75");
            using (var so = new SerializedObject(asset))
            {
                so.FindProperty("m_SortingOrder").floatValue = 7;
                so.ApplyModifiedProperties();
            }
            AssetDatabase.SaveAssets();
            Assert.AreEqual("1", ScaleInFile(path), "the save wrote the asset's own factor");
            Assert.AreEqual("7", SortingOrderInFile(path), "and the edit");
            yield return Frames(2);
            Assert.AreEqual(1.2f, asset.scale, 1e-4, "held again after the save");
            asset.sortingOrder = 8;
            EditorUtility.SetDirty(asset);
            AssetDatabase.SaveAssetIfDirty(asset);
            Assert.AreEqual("1", ScaleInFile(path));
            yield return Frames(2);
            Assert.AreEqual(1.2f, asset.scale, 1e-4);

            LogAssert.Expect(LogType.Warning, new System.Text.RegularExpressions.Regex("a build started while 1 PanelSettings held"));
            Assert.AreEqual(1, RootScaleBuildGuard.BeforeBuild());
            Assert.AreEqual(1f, asset.scale, "a build sees the asset's own factor");
            Assert.AreEqual(0, DesignRootScalePanels.Count);
            Object.DestroyImmediate(doc.gameObject);
        }

        /// <summary>
        /// Only the factor last written counts as the root scale's own (in players too): a game that sets its own UI scale to a
        /// value the panel once held (1.2, held at 1600×900 before the resolution changed to 1920×1080) keeps it, the exact
        /// scale is applied on top, and it is the settings' factor after the screen leaves.
        /// </summary>
        [UnityTest]
        public IEnumerator AGamesOwnFactor_EqualToAFactorHeldEarlier_IsTheGames()
        {
            var doc = Document(1600, 900);
            yield return Frames(2);
            var screen = PlainScreen("root");
            doc.rootVisualElement.Add(screen);
            yield return Frames(6);
            Assert.AreEqual(1.2f, _settings.scale, 1e-4, "held at 1600×900");
            _settings.targetTexture = Texture(1920, 1080);
            yield return Frames(6);
            Assert.AreEqual(1f, _settings.scale, 1e-6, "exact at 1920×1080: the own factor");
            _settings.scale = 1.2f; // the game's "120 %"
            screen.panel.visualTree.MarkDirtyRepaint();
            yield return Frames(6);
            Assert.AreEqual(1.2f, DesignRootScalePanels.OwnScale(_settings) ?? float.NaN, 1e-6, "the game's factor is the own one");
            Assert.AreEqual(0.9, screen.DesignScale ?? double.NaN, 1e-4, "0.75 × 1.2");
            screen.RemoveFromHierarchy();
            Assert.AreEqual(1.2f, _settings.scale, 1e-6, "and it stays when the screen leaves");
        }

        /// <summary>
        /// An Undo acts only on the PanelSettings it touched, and only for a factor this wrote: an asset held at 1600×900 in Play
        /// mode (factor 1.2) and given back keeps the user's own 1.2 set later in the Inspector (equal to the held factor) through
        /// an Undo of another object's change and a save, also after a script reload.
        /// </summary>
        [UnityTest]
        public IEnumerator AUsersOwnFactor_EqualToAnEarlierHeldOne_SurvivesAnUnrelatedUndo_AndASave()
        {
            DesignRootScalePanels.Playing = () => true;
            var asset = SettingsAsset("User");
            var screen = ShowOn(asset, out var doc);
            yield return Frames(6);
            Assert.AreEqual(1.2f, asset.scale, 1e-4, "held at 1600×900");
            screen.RemoveFromHierarchy();
            Assert.AreEqual(1f, asset.scale, "given back");
            Object.DestroyImmediate(doc.gameObject);
            DesignRootScalePanels.Playing = () => false;
            // the user's 120 %, through the Inspector (a recorded change)
            var so = new SerializedObject(asset);
            so.FindProperty("m_Scale").floatValue = 1.2f;
            so.ApplyModifiedProperties();
            yield return null;
            var other = Track(new GameObject("RootScaleTests other"));
            Undo.IncrementCurrentGroup();
            Undo.RecordObject(other.transform, "move");
            other.transform.position = new Vector3(3, 0, 0);
            Undo.PerformUndo();
            Assert.AreEqual(1.2f, asset.scale, 1e-6, "an Undo of another object's change leaves the user's factor");
            AssetDatabase.SaveAssetIfDirty(asset);
            Assert.AreEqual("1.2", ScaleInFile(AssetDatabase.GetAssetPath(asset)), "a save writes it");
            // after a script reload too
            DesignRootScalePanels.ForgetStatics();
            Undo.IncrementCurrentGroup();
            Undo.RecordObject(other.transform, "move");
            other.transform.position = new Vector3(5, 0, 0);
            Undo.PerformUndo();
            Assert.AreEqual(1.2f, asset.scale, 1e-6, "after a script reload");
        }

        /// <summary>
        /// A game's own factor equal to a factor held earlier survives an Undo in Play mode: held at 1600×900 (1.2), exact at
        /// 1920×1080, the game's 120 % option writes 1.2, an Undo of another object's change runs while a screen holds a factor
        /// on top of it and after the screen closed: the factor stays the game's 1.2.
        /// </summary>
        [UnityTest]
        public IEnumerator AGamesOwnFactor_SurvivesAnUndo_InPlayMode()
        {
            DesignRootScalePanels.Playing = () => true;
            var doc = Document(1600, 900);
            _settings.hideFlags = HideFlags.None;
            yield return Frames(2);
            var screen = PlainScreen("root");
            doc.rootVisualElement.Add(screen);
            yield return Frames(6);
            Assert.AreEqual(1.2f, _settings.scale, 1e-4, "held at 1600×900");
            _settings.targetTexture = Texture(1920, 1080);
            yield return Frames(6);
            _settings.scale = 1.2f; // the game's "120 %"
            screen.panel.visualTree.MarkDirtyRepaint();
            yield return Frames(6);
            Assert.AreEqual(1.2f, DesignRootScalePanels.OwnScale(_settings) ?? float.NaN, 1e-6);
            // (0.75 × 1.2 = 0.9 lays out at the next exact scale up, 1: the held factor is 1.2 / 0.9)
            Assert.AreEqual(1.2f / 0.9f, _settings.scale, 1e-4);
            var other = Track(new GameObject("RootScaleTests other"));
            void UndoAMove()
            {
                Undo.IncrementCurrentGroup();
                Undo.RecordObject(other.transform, "move");
                other.transform.position += new Vector3(3, 0, 0);
                Undo.PerformUndo();
            }
            UndoAMove();
            yield return Frames(6);
            Assert.AreEqual(1.2f, DesignRootScalePanels.OwnScale(_settings) ?? float.NaN, 1e-6, "the game's 120 % stays the own factor");
            Assert.AreEqual(1.2f / 0.9f, _settings.scale, 1e-4, "held on top of it");
            // the screen closed (a menu without design screens): the game's 1.2, equal to the factor held at 1600×900
            screen.RemoveFromHierarchy();
            Assert.AreEqual(1.2f, _settings.scale, 1e-6, "given back as the game's");
            UndoAMove();
            yield return Frames(2);
            Assert.AreEqual(1.2f, _settings.scale, 1e-6, "an Undo leaves the game's 120 %");
            Object.DestroyImmediate(doc.gameObject);
        }

        /// <summary>
        /// An Undo of an edit of the factor while a screen held it gives back the factor of the snapshot's own (a factor/own pair):
        /// held at 1600×900 (own 1, factor 1.2), the own factor set to 1.3 (factor 1.56), Undo: own 1 and factor 1.2 again. An
        /// Undo after the screen left and a script reload (the statics forgotten, the session's record kept) still gives the
        /// asset its own factor.
        /// </summary>
        [UnityTest]
        public IEnumerator AnUndo_RestoresTheSnapshotsOwnFactor_AlsoAfterAScriptReload()
        {
            // in Play mode (simulated), on settings the Undo system records (not DontSave)
            DesignRootScalePanels.Playing = () => true;
            var doc = Document(1600, 900);
            _settings.hideFlags = HideFlags.None;
            yield return Frames(2);
            var screen = PlainScreen("root");
            doc.rootVisualElement.Add(screen);
            yield return Frames(6);
            Assert.AreEqual(1.2f, _settings.scale, 1e-4);
            Undo.IncrementCurrentGroup();
            Undo.RecordObject(_settings, "scale");
            _settings.scale = 1.3f;
            screen.panel.visualTree.MarkDirtyRepaint();
            yield return Frames(6);
            Assert.AreEqual(1.3f, DesignRootScalePanels.OwnScale(_settings) ?? float.NaN, 1e-6);
            // (1.3 × 0.625 = 0.8125 lays out at the next exact scale up, 1)
            Assert.AreEqual(1.6f, _settings.scale, 1e-4);
            Undo.PerformUndo();
            yield return Frames(6);
            Assert.AreEqual(1f, DesignRootScalePanels.OwnScale(_settings) ?? float.NaN, 1e-6, "the snapshot's own factor");
            Assert.AreEqual(1.2f, _settings.scale, 1e-4, "and its exact scale's factor");
            Object.DestroyImmediate(doc.gameObject);

            // an asset held in Play mode and given back, then a script reload (the statics forgotten, the session's record
            // kept): an Undo of a group in which the factor was held, which brings the held 1.2 back, gives the asset its own
            // factor. Unity's Undo does not apply an asset's recorded property in the test runner, so the test writes the value
            // such an Undo restores and sends the Undo system's event (AfterUndoRedo with that group) itself.
            var asset = SettingsAsset("Reload");
            Undo.IncrementCurrentGroup();
            int heldGroup = Undo.GetCurrentGroup();
            var screen2 = ShowOn(asset, out var doc2);
            yield return Frames(6);
            Assert.AreEqual(1.2f, asset.scale, 1e-4);
            screen2.RemoveFromHierarchy();
            Assert.AreEqual(1f, asset.scale);
            Object.DestroyImmediate(doc2.gameObject);
            DesignRootScalePanels.ForgetStatics(); // what a script reload empties
            asset.scale = 1.2f; // the snapshot's value, taken while held
            DesignRootScalePanels.AfterUndoRedo(heldGroup);
            Assert.AreEqual(1f, asset.scale, 1e-6, "the snapshot's own factor, from the session's record");
            // the same Undo without the session's record (what the mapping above came from) leaves the value as it is
            DesignRootScalePanels.ForgetReleased();
            asset.scale = 1.2f;
            DesignRootScalePanels.AfterUndoRedo(heldGroup);
            Assert.AreEqual(1.2f, asset.scale, 1e-6, "no record: nothing maps it");
        }

        /// <summary>
        /// A new hold of a PanelSettings keeps what an earlier hold of it wrote: held at 1600×900 in Play mode (1.2 over the own
        /// 1), the user's 130 % set in the Inspector while held (Unity's Undo records the changed property, 1.2 → 1.3), the screen
        /// closed, the resolution changed to 1366×768 and a screen opened (held again): Ctrl+Z brings 1.2 back, the factor held
        /// over the own 1 then, so the own factor is 1 again and leaving gives 1 back (before, the new hold forgot what the
        /// earlier one wrote and 1.2 became the own factor, which leaving Play then left on the settings).
        /// </summary>
        [UnityTest]
        public IEnumerator AnUndo_OfASnapshotFromAnEarlierHold_GivesItsOwnFactor_AfterANewHold()
        {
            // in Play mode (simulated), on settings the Undo system records (not DontSave)
            DesignRootScalePanels.Playing = () => true;
            var doc = Document(1600, 900);
            _settings.hideFlags = HideFlags.None;
            yield return Frames(2);
            var screen = PlainScreen("root");
            doc.rootVisualElement.Add(screen);
            yield return Frames(6);
            Assert.AreEqual(1.2f, _settings.scale, 1e-4, "held at 1600×900");
            Undo.IncrementCurrentGroup();
            Undo.RecordObject(_settings, "scale"); // the user's 130 % in the Inspector while held: the Undo record holds 1.2 → 1.3
            _settings.scale = 1.3f;
            screen.panel.visualTree.MarkDirtyRepaint();
            yield return Frames(6);
            Assert.AreEqual(1.3f, DesignRootScalePanels.OwnScale(_settings) ?? float.NaN, 1e-6);
            screen.RemoveFromHierarchy();
            Assert.AreEqual(1.3f, _settings.scale, 1e-6, "given back");
            Undo.IncrementCurrentGroup();
            _settings.targetTexture = Texture(1366, 768);
            var screen2 = PlainScreen("root");
            doc.rootVisualElement.Add(screen2);
            yield return Frames(6);
            Assert.AreEqual(0.75 / ScaleOf(1366, 768), _settings.scale, 1e-4, "held again at 1366×768 (1.3 × 0.53346 lays out at 0.75)");
            float held = _settings.scale;
            Undo.PerformUndo(); // brings back 1.2, the factor held over the own 1 when the Inspector edit was made
            Assert.AreNotEqual(held, _settings.scale, "the Undo ran");
            yield return Frames(6);
            Assert.AreEqual(1f, DesignRootScalePanels.OwnScale(_settings) ?? float.NaN, 1e-6, "the snapshot's own factor, not its held 1.2");
            screen2.RemoveFromHierarchy();
            Assert.AreEqual(1f, _settings.scale, 1e-6, "leaving gives the own factor back");
            Object.DestroyImmediate(doc.gameObject);
        }

        /// <summary>
        /// A factor written again over an own it was written over before keeps the earlier groups it was held in: held at
        /// 1600×900 in Play mode (1.2 over the own 1), the user's 150 % set in the Inspector while held (the Undo record holds
        /// 1.2 → 1.5), then the game's own 1 (held 1.2 over it again, a later group) and 0.8 (exact: nothing held), unrecorded;
        /// Ctrl+Z of the user's edit brings 1.2 back, a snapshot taken while 1.2 was held over the own 1, so the own factor is 1
        /// and leaving gives 1 back (before, the factor written again took the later group, the snapshot's 1.2 became the own
        /// factor and leaving Play left it on the settings).
        /// </summary>
        [UnityTest]
        public IEnumerator AnUndo_OfAnEditWhileHeld_GivesItsOwnFactor_AfterTheFactorWasWrittenAgainLater()
        {
            DesignRootScalePanels.Playing = () => true;
            var doc = Document(1600, 900);
            _settings.hideFlags = HideFlags.None; // settings the Undo system records
            yield return Frames(2);
            var screen = PlainScreen("root");
            doc.rootVisualElement.Add(screen);
            yield return Frames(6);
            Assert.AreEqual(1.2f, _settings.scale, 1e-4, "held at 1600×900 over the own 1");
            Undo.IncrementCurrentGroup();
            Undo.RecordObject(_settings, "scale"); // the user's 150 % while held: the Undo record holds 1.2 → 1.5
            _settings.scale = 1.5f;
            screen.panel.visualTree.MarkDirtyRepaint();
            yield return Frames(6);
            Assert.AreEqual(1.5f, DesignRootScalePanels.OwnScale(_settings) ?? float.NaN, 1e-6);
            // the game's own factors (not recorded): 1, held at 1.2 again; 0.8 (× 0.625 = 0.5, exact): nothing held
            foreach (var (own, held) in new[] { (1f, 1.2f), (0.8f, 0.8f) })
            {
                Undo.IncrementCurrentGroup();
                _settings.scale = own;
                screen.panel.visualTree.MarkDirtyRepaint();
                yield return Frames(6);
                Assert.AreEqual(own, DesignRootScalePanels.OwnScale(_settings) ?? float.NaN, 1e-6, "the game's " + own);
                Assert.AreEqual(held, _settings.scale, 1e-4, "held over the game's " + own);
            }
            Undo.PerformUndo(); // the user's edit: 1.2 back, the factor held over the own 1 when it was recorded
            Assert.AreNotEqual(0.8f, _settings.scale, "the Undo ran");
            yield return Frames(6);
            Assert.AreEqual(1f, DesignRootScalePanels.OwnScale(_settings) ?? float.NaN, 1e-6, "the snapshot's own factor, not its held 1.2");
            screen.RemoveFromHierarchy();
            Assert.AreEqual(1f, _settings.scale, 1e-6, "leaving gives the own factor back");
            Object.DestroyImmediate(doc.gameObject);
        }

        /// <summary>
        /// An Undo that brings back a value the user set before a hold keeps it, also when it equals the held factor: in Edit
        /// mode the user types 1.2 and then 1 (both recorded), plays at 1600×900 (held 1.2 over the own 1) and stops; Ctrl+Z
        /// brings the user's 1.2 back, a snapshot recorded before 1.2 was ever held, so it is the user's own value (before, it
        /// was taken for the held factor and reset to 1).
        /// </summary>
        [UnityTest]
        public IEnumerator AnUndo_ToTheUsersEarlierValue_EqualToAHeldFactor_KeepsTheUsersValue()
        {
            var doc = Document(1600, 900);
            _settings.hideFlags = HideFlags.None; // settings the Undo system records
            DesignRootScalePanels.Playing = () => false;
            yield return Frames(2);
            foreach (var value in new[] { 1.2f, 1f })
            {
                Undo.IncrementCurrentGroup();
                Undo.RecordObject(_settings, "scale"); // the Inspector's edit
                _settings.scale = value;
                yield return null;
            }
            Undo.IncrementCurrentGroup();
            DesignRootScalePanels.Playing = () => true;
            var screen = PlainScreen("root");
            doc.rootVisualElement.Add(screen);
            yield return Frames(6);
            Assert.AreEqual(1.2f, _settings.scale, 1e-4, "held at 1600×900 over the user's 1");
            screen.RemoveFromHierarchy();
            DesignRootScalePanels.Playing = () => false;
            Assert.AreEqual(1f, _settings.scale, "given back");
            yield return null;
            Undo.PerformUndo(); // the user's own 1 → 1.2 back
            yield return null;
            Assert.AreEqual(1.2f, _settings.scale, 1e-6, "the user's own earlier value");
            Object.DestroyImmediate(doc.gameObject);
        }

        // ---- an overflowing line the design aligns right ------------------------------------------------------------------

        /// <summary>
        /// The browser start-aligns a line wider than its box (CSS Text) before it puts the ellipsis where the line is cut, so
        /// the visible text starts at the box's left edge; UI Toolkit right-aligned the cut text (3.3 CSS px further right in
        /// the fixture). A right-aligned text that does not wrap compiles to a DesignOverflowLabel: left-aligned while its text
        /// overflows, right-aligned when it fits, at 2560×1440 and 1600×900.
        /// </summary>
        [UnityTest]
        public IEnumerator ARightAlignedLine_WiderThanItsBox_StartsAtTheLeftEdge_AsTheBrowserDrawsIt()
        {
            var family = "\"" + FontFixture.Regular.faceInfo.familyName + "\"";
            (string, string)[] Cut(int top) => new[] { ("position", "absolute"), ("left", "100px"), ("top", top + "px"), ("width", "200px"), ("height", "16px"),
                ("white-space", "nowrap"), ("overflow-x", "hidden"), ("overflow-y", "hidden"), ("text-overflow", "ellipsis"), ("text-align", "right"),
                ("color", "#ffffff"), ("font-size", "12px"), ("font-family", family) };
            var tree = CompileScreen(root => root.Add(Text("cut", "Transfer dönemi bu gece yarısı kapanıyor, kulüpler son tekliflerini veriyor", Cut(600)),
                Text("fits", "Kısa", Cut(640))));
            var uxml = File.ReadAllText(Out + "/RootscaleScreen/RootscaleScreen.uxml");
            StringAssert.Contains("<" + ScreenBuilder.OverflowLabelTag + " name=\"cut\"", uxml);
            StringAssert.Contains("<" + ScreenBuilder.OverflowLabelTag + " name=\"fits\"", uxml);
            StringAssert.DoesNotContain("<" + ScreenBuilder.OverflowLabelTag + " name=\"caption\"", uxml, "a left-aligned text stays a Label");
            foreach (var (w, h) in new[] { (2560, 1440), (1600, 900) })
            {
                var doc = Document(w, h);
                yield return Frames(2);
                var instance = tree.Instantiate();
                doc.rootVisualElement.Add(instance);
                yield return Frames(8);
                var cut = instance.Q<DesignOverflowLabel>("cut");
                var fits = instance.Q<DesignOverflowLabel>("fits");
                Assert.IsNotNull(cut);
                Assert.IsTrue(cut.Overflows, w + "×" + h + ": the long line overflows");
                Assert.AreEqual(DesignOverflowLabel.StartOf(fits.resolvedStyle.unityTextAlign) == fits.resolvedStyle.unityTextAlign, false, "the design aligns right");
                Assert.AreEqual(DesignOverflowLabel.StartOf(fits.resolvedStyle.unityTextAlign), cut.resolvedStyle.unityTextAlign, w + "×" + h + ": the overflowing line starts at the left edge");
                Assert.IsFalse(fits.Overflows, w + "×" + h + ": the short line fits");
                Assert.AreEqual(StyleKeyword.Null, fits.style.unityTextAlign.keyword, w + "×" + h + ": the short line keeps the design's alignment");
                // the text changes to one that fits: the design's alignment again
                cut.text = "Kısa";
                yield return Frames(4);
                Assert.IsFalse(cut.Overflows);
                Assert.AreEqual(fits.resolvedStyle.unityTextAlign, cut.resolvedStyle.unityTextAlign, w + "×" + h + ": right-aligned when it fits");
                Object.DestroyImmediate(doc.gameObject);
                yield return null;
            }
        }

        const string LongLine = "Transfer dönemi bu gece yarısı kapanıyor, kulüpler son tekliflerini veriyor";

        (string, string)[] OverflowCss(int top, string align)
        {
            var family = "\"" + FontFixture.Regular.faceInfo.familyName + "\"";
            return new[] { ("position", "absolute"), ("left", "100px"), ("top", top + "px"), ("width", "200px"), ("height", "16px"),
                ("white-space", "nowrap"), ("overflow-x", "hidden"), ("overflow-y", "hidden"), ("text-overflow", "ellipsis"), ("text-align", align),
                ("color", "#ffffff"), ("font-size", "12px"), ("font-family", family) };
        }

        /// <summary>
        /// In right-to-left text (the resolved language direction, which <see cref="LocaleFontController"/> sets on the root of
        /// an RTL locale with the advanced text generator) the start of a line is its right edge: an overflowing right-aligned
        /// line stays right-aligned and an overflowing centred one becomes right-aligned, so the beginning of the text shows;
        /// back in left-to-right text (with the locale's class change, as the controller makes it) both start at the left.
        /// </summary>
        [UnityTest]
        public IEnumerator AnOverflowingLine_StartsAtItsRightEdge_InRightToLeftText()
        {
            var tree = CompileScreen(root => root.Add(Text("right", LongLine, OverflowCss(600, "right")), Text("centred", LongLine, OverflowCss(640, "center")),
                Text("fits-right", "Kısa", OverflowCss(680, "right")), Text("fits-centred", "Kısa", OverflowCss(720, "center"))));
            StringAssert.Contains("DesignOverflowLabel {\n    " + ScreenBuilder.TextFitProperty + ": 1;\n}", File.ReadAllText(Out + "/RootscaleScreen/RootscaleScreen.uss"),
                "the type has a custom property: UI Toolkit tells it when its styles resolve");
            var doc = Document(2560, 1440);
            yield return Frames(2);
            var instance = tree.Instantiate();
            instance.languageDirection = LanguageDirection.RTL;
            doc.rootVisualElement.Add(instance);
            yield return Frames(8);
            var right = instance.Q<DesignOverflowLabel>("right");
            var centred = instance.Q<DesignOverflowLabel>("centred");
            var designRight = instance.Q<DesignOverflowLabel>("fits-right").resolvedStyle.unityTextAlign;
            var designCentred = instance.Q<DesignOverflowLabel>("fits-centred").resolvedStyle.unityTextAlign;
            Assert.IsTrue(right.Overflows && centred.Overflows);
            Assert.IsTrue(DesignOverflowLabel.RightToLeft(right));
            Assert.AreEqual(designRight, right.resolvedStyle.unityTextAlign, "right to left: a right-aligned line starts where it is aligned");
            Assert.AreEqual(StyleKeyword.Null, right.style.unityTextAlign.keyword, "no alignment of its own");
            Assert.AreEqual(DesignOverflowLabel.StartOf(designCentred, true), centred.resolvedStyle.unityTextAlign, "a centred line starts at the right edge");
            Assert.AreNotEqual(designCentred, centred.resolvedStyle.unityTextAlign);
            // left to right again (the locale's class changes with it)
            instance.languageDirection = LanguageDirection.Inherit;
            instance.EnableInClassList("locale-test", true);
            yield return Frames(4);
            Assert.AreEqual(DesignOverflowLabel.StartOf(designRight), right.resolvedStyle.unityTextAlign, "left to right: the right-aligned line starts at the left");
            Assert.AreEqual(DesignOverflowLabel.StartOf(designCentred), centred.resolvedStyle.unityTextAlign);
            Object.DestroyImmediate(doc.gameObject);
        }

        /// <summary>
        /// The label measures its text only when the text, its font, its width or the panel's scale changed: a colour change
        /// resolves its styles again (it gets <c>CustomStyleResolvedEvent</c>) and measures nothing; a style-only change of its
        /// font size on the open screen (a text-size step, the box fixed) is seen and aligns it; a layer where its text wraps
        /// gives it the design's alignment; two text changes in one frame keep the design's alignment as the one to return to.
        /// </summary>
        [UnityTest]
        public IEnumerator AnOverflowLabel_MeasuresOnlyWhenItsTextFontWidthOrScaleChanges_AndFollowsStyleOnlyChanges()
        {
            var tree = CompileScreen(root => root.Add(Text("cut", LongLine, OverflowCss(600, "right")), Text("fits", "Kısa", OverflowCss(640, "right"))));
            var doc = Document(2560, 1440);
            yield return Frames(2);
            var instance = tree.Instantiate();
            doc.rootVisualElement.Add(instance);
            yield return Frames(8);
            var cut = instance.Q<DesignOverflowLabel>("cut");
            var fits = instance.Q<DesignOverflowLabel>("fits");
            var design = fits.resolvedStyle.unityTextAlign;
            var start = DesignOverflowLabel.StartOf(design);
            Assert.IsTrue(cut.Overflows);
            Assert.AreEqual(start, cut.resolvedStyle.unityTextAlign);
            int resolved = 0;
            cut.RegisterCallback<CustomStyleResolvedEvent>(_ => resolved++);
            int measured = cut.Measurements;
            cut.style.color = Color.red;
            yield return Frames(4);
            Assert.Greater(resolved, 0, "its styles resolved again");
            Assert.AreEqual(measured, cut.Measurements, "an unrelated style change measures nothing");
            Assert.AreEqual(start, cut.resolvedStyle.unityTextAlign);
            // a larger font on the open screen (the box does not change): the short line overflows now
            fits.style.fontSize = 120;
            yield return Frames(4);
            Assert.IsTrue(fits.Overflows, "a style-only change of its font is seen");
            Assert.AreEqual(start, fits.resolvedStyle.unityTextAlign);
            fits.style.fontSize = StyleKeyword.Null;
            yield return Frames(4);
            Assert.IsFalse(fits.Overflows);
            Assert.AreEqual(design, fits.resolvedStyle.unityTextAlign);
            // where the text wraps, a line never overflows its box: the design's alignment
            cut.style.whiteSpace = WhiteSpace.Normal;
            yield return Frames(4);
            Assert.IsFalse(cut.Overflows, "a wrapping text");
            Assert.AreEqual(design, cut.resolvedStyle.unityTextAlign);
            cut.style.whiteSpace = StyleKeyword.Null;
            yield return Frames(4);
            Assert.AreEqual(start, cut.resolvedStyle.unityTextAlign);
            // two text changes in one frame: one that fits, then one that overflows again
            measured = cut.Measurements;
            cut.text = "Kısa";
            cut.text = LongLine;
            yield return Frames(4);
            Assert.AreEqual(measured + 2, cut.Measurements, "each text change measures once");
            Assert.IsTrue(cut.Overflows);
            Assert.AreEqual(start, cut.resolvedStyle.unityTextAlign, "the overflowing line starts at the left edge");
            cut.text = "Kısa";
            yield return Frames(4);
            Assert.AreEqual(design, cut.resolvedStyle.unityTextAlign, "and the design's alignment comes back");
            Object.DestroyImmediate(doc.gameObject);
        }

        // ---- nested borders ---------------------------------------------------------------------------------------------

        /// <summary>
        /// UI Toolkit lays each 4 px border out as 3 device px of the exact scale (0.75) and draws it through the root scale:
        /// 2.5 device px at 1600×900 and 2.13 at 1366×768, the border's width at the actual scale, where the golden lays a
        /// box's border out too (measured with docs/findings/viewport-classes/nested-borders.html through the fidelity suite:
        /// the label inside three levels within 0.16 device px of the golden at 1600×900). Three nested levels put the
        /// content 7.5 and 6.4 device px in, with no rounding added up.
        /// </summary>
        [UnityTest]
        public IEnumerator NestedBorders_AreDrawnAtTheirWidthAtTheActualScale_AtAScaledViewport()
        {
            foreach (var (w, h) in new[] { (1600, 900), (1366, 768) })
            {
                var doc = Document(w, h);
                yield return Frames(2);
                var screen = PlainScreen("root");
                doc.rootVisualElement.Add(screen);
                VisualElement parent = screen;
                var levels = new List<VisualElement>();
                for (int n = 0; n < 3; n++)
                {
                    var box = new VisualElement();
                    if (n == 0)
                    {
                        box.style.position = Position.Absolute;
                        box.style.left = 400;
                        box.style.top = 400;
                    }
                    box.style.paddingLeft = box.style.paddingTop = 0;
                    box.style.borderLeftWidth = box.style.borderTopWidth = box.style.borderRightWidth = box.style.borderBottomWidth = 4;
                    box.style.borderLeftColor = box.style.borderTopColor = Color.white;
                    parent.Add(box);
                    levels.Add(box);
                    parent = box;
                }
                var content = new VisualElement();
                content.style.width = 40;
                content.style.height = 40;
                parent.Add(content);
                yield return Frames(6);
                string at = w + "×" + h;
                double actual = ScaleOf(w, h), ppp = screen.panel.scaledPixelsPerPoint;
                Assert.AreNotEqual(1f, screen.RootScale, at + ": scaled");
                var report = new List<string>();
                for (int n = 1; n <= 3; n++)
                {
                    var inner = n < 3 ? levels[n] : content;
                    double drawn = inner.worldBound.x * ppp - 400 * actual;
                    report.Add(n + " level(s): " + drawn.ToString("0.###") + " device px");
                    // n × 3 device px at 0.75 drawn through the root scale is n × 4 × the actual scale: the golden's layout of the
                    // same borders (pinned by design-export's viewport-classes test on docs/findings/viewport-classes/nested-borders.html)
                    Assert.AreEqual(n * 4 * actual, drawn, 0.02, at + ": " + n + " level(s) of 3 device px at 0.75, drawn through the root scale");
                }
                Debug.Log("Nested 4 px borders at " + at + ": " + string.Join("; ", report));
                Object.DestroyImmediate(doc.gameObject);
                yield return null;
            }
        }

        // ---- the design's own transform of the root ------------------------------------------------------------------------

        /// <summary>
        /// The root scale composes with the design's transform of the root (the root's own player and rules), at 1600×900 (root
        /// 0.8333) and at the exact 1920×1080: an open animation (keyframes scale 0.96 to 1 about the root's centre) draws the
        /// box where the design's scale puts it at the actual scale in every frame, and when it ends the root scale and its
        /// top-left origin are back; a state's translate (100, 50) moves the root by design pixels at the actual scale, and a
        /// state's rotation of 10° about a % origin (25% 75%) with a % translate (5% 10%) turns it as the design does.
        /// </summary>
        [UnityTest]
        public IEnumerator AnAnimatedRoot_ComposesTheDesignsTransformWithTheRootScale_AndTheRootScaleComesBack()
        {
            var tree = CompileScreen(root =>
            {
                root.With("state:moved", ("translate", "100px 50px"));
                root.With("state:turned", ("rotate", "10deg"), ("transform-origin", "25% 75%"), ("translate", "5% 10%"));
                root.Anims.Add(AnimationPlayerTests.Keyframes("show", "enter", 400, 0, "linear", 1, "normal", "none",
                    (0, null, new[] { ("scale", "0.96") }), (1, null, new[] { ("scale", "1") })));
            });
            StringAssert.Contains(DesignScreen.TranslateProperty + ": \"100px 50px\"", File.ReadAllText(Out + "/RootscaleScreen/RootscaleScreen.uss"),
                "the root's rules carry the design's transform for the runtime");
            foreach (var (w, h) in new[] { (1600, 900), (1920, 1080) })
            {
                var doc = Document(w, h);
                yield return Frames(2);
                var clock = new DesignManualClock();
                var instance = tree.Instantiate();
                doc.rootVisualElement.Add(instance);
                var screen = instance.Q<DesignScreen>("root");
                var player = screen.Animations;
                Assert.IsNotNull(player);
                player.Clock = clock;
                yield return Frames(6);
                string at = w + "×" + h;
                double actual = ScaleOf(w, h), ppp = screen.panel.scaledPixelsPerPoint;
                float r = screen.RootScale;
                Assert.AreEqual(w == 1600, r != 1f, at);
                double tolerance = 0.5 * r + 0.05;
                var box = instance.Q("box");
                // the design's scale k about the root's centre (1280, 720), in design px, times the actual scale
                Rect Scaled(double k, double dx = 0, double dy = 0) => new Rect(
                    (float)((1280 + k * (397 - 1280) + dx) * actual), (float)((720 + k * (101 - 720) + dy) * actual), (float)(403 * k * actual), (float)(37 * k * actual));
                foreach (var ms in new[] { 0.0, 100, 200, 399 })
                {
                    clock.Milliseconds = ms;
                    player.Tick();
                    yield return Frames(2);
                    double k = 0.96 + 0.04 * ms / 400;
                    AreDevice(Scaled(k), box.worldBound, ppp, tolerance, at + " box at " + ms + " ms (scale " + k.ToString("0.###") + ")");
                }
                clock.Milliseconds = 1000;
                player.Tick();
                yield return Frames(4);
                AreDevice(Scaled(1), box.worldBound, ppp, tolerance, at + " box after the animation");
                Assert.AreEqual(r, screen.resolvedStyle.scale.value.x, 1e-5, at + ": the root scale is back");
                if (r != 1f)
                {
                    Assert.AreEqual(0f, screen.resolvedStyle.transformOrigin.x, 1e-5, at + ": its origin is the top-left corner");
                    Assert.AreEqual(0f, screen.resolvedStyle.transformOrigin.y, 1e-5, at);
                }
                else Assert.AreEqual(StyleKeyword.Null, screen.style.scale.keyword, at + ": nothing inline where unscaled");

                screen.AddToClassList(ScreenBuilder.StateClassPrefix + "moved");
                yield return Frames(4);
                AreDevice(Scaled(1, 100, 50), box.worldBound, ppp, tolerance, at + " box in the state that moves the root");
                screen.RemoveFromClassList(ScreenBuilder.StateClassPrefix + "moved");
                yield return Frames(4);
                AreDevice(Scaled(1), box.worldBound, ppp, tolerance, at + " box back");

                // a state that rotates the root 10° about 25% 75% (640, 1080) and translates it by 5% 10% of its own size
                // (128, 144): each corner p of the box goes to origin + translate + R·(p − origin), clockwise with y down
                screen.AddToClassList(ScreenBuilder.StateClassPrefix + "turned");
                yield return Frames(4);
                double rad = 10 * Math.PI / 180, cos = Math.Cos(rad), sin = Math.Sin(rad);
                double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue;
                foreach (var (px, py) in new[] { (397.0, 101.0), (800.0, 101.0), (800.0, 138.0), (397.0, 138.0) })
                {
                    double qx = 640 + 128 + (px - 640) * cos - (py - 1080) * sin, qy = 1080 + 144 + (px - 640) * sin + (py - 1080) * cos;
                    minX = Math.Min(minX, qx); maxX = Math.Max(maxX, qx); minY = Math.Min(minY, qy); maxY = Math.Max(maxY, qy);
                }
                var turned = new Rect((float)(minX * actual), (float)(minY * actual), (float)((maxX - minX) * actual), (float)((maxY - minY) * actual));
                AreDevice(turned, box.worldBound, ppp, tolerance + 0.5, at + " box in the state that rotates the root about a % origin and translates it by %");
                Assert.AreEqual(10f, screen.resolvedStyle.rotate.angle.ToDegrees(), 1e-3, at + ": the design's rotation");
                screen.RemoveFromClassList(ScreenBuilder.StateClassPrefix + "turned");
                yield return Frames(4);
                AreDevice(Scaled(1), box.worldBound, ppp, tolerance, at + " box back after the rotation");
                Object.DestroyImmediate(doc.gameObject);
                yield return null;
            }
        }

        // ---- several screens --------------------------------------------------------------------------------------------

        static DesignScreen PlainScreen(string name)
        {
            var screen = new DesignScreen { name = name, ExactScales = DesignViewportScales.Encode(Exact) };
            screen.style.width = 2560;
            screen.style.height = 1440;
            return screen;
        }

        /// <summary>
        /// A screen inside another screen (both with exact scales) is drawn scaled with it and never scales itself again: at
        /// 1600×900 an element of the inner screen is where the design puts it at the actual scale, the inner root's scale is 1
        /// and its design scale the outer's.
        /// </summary>
        [UnityTest]
        public IEnumerator AScreenInsideAnother_IsScaledWithIt_NotTwice()
        {
            var doc = Document(1600, 900);
            yield return Frames(2);
            var outer = PlainScreen("outer");
            var inner = PlainScreen("inner");
            outer.Add(inner);
            var target = Place(new VisualElement { name = "target" }, inner, 400, 200, 300, 100);
            doc.rootVisualElement.Add(outer);
            yield return Frames(8);
            double actual = ScaleOf(1600, 900), ppp = outer.panel.scaledPixelsPerPoint;
            Assert.AreEqual(actual / 0.75, outer.RootScale, 1e-4);
            Assert.AreEqual(1f, inner.RootScale, "the inner screen is not scaled again");
            Assert.AreEqual(actual, inner.DesignScale ?? double.NaN, 1e-4, "it has the design's scale");
            AreDevice(new Rect((float)(400 * actual), (float)(200 * actual), (float)(300 * actual), (float)(100 * actual)), target.worldBound, ppp, 0.5 * outer.RootScale + 0.05, "the inner screen's element");
            Object.DestroyImmediate(doc.gameObject);
        }

        /// <summary>
        /// Two screens on one PanelSettings: the factor stays held while either is on the panel and comes back when the last
        /// leaves; a screen with other exact viewports on the same PanelSettings is reported (it lays out at the first's).
        /// </summary>
        [UnityTest]
        public IEnumerator TwoScreensOnOnePanelSettings_HoldTheFactorUntilTheLastLeaves_AndOtherExactViewportsAreReported()
        {
            var doc = Document(1600, 900);
            yield return Frames(2);
            var a = PlainScreen("a");
            var b = PlainScreen("b");
            doc.rootVisualElement.Add(a);
            doc.rootVisualElement.Add(b);
            yield return Frames(6);
            Assert.AreEqual(1, DesignRootScalePanels.Count);
            Assert.AreEqual(1.2f, _settings.scale, 1e-4);
            a.RemoveFromHierarchy();
            yield return Frames(2);
            Assert.AreEqual(1.2f, _settings.scale, 1e-4, "held while a screen is on the panel");
            Assert.AreEqual(b.RootScale, (float)(ScaleOf(1600, 900) / 0.75), 1e-4);
            var other = new DesignScreen { name = "other", ExactScales = DesignViewportScales.Encode(new double[] { 1, 0.5 }) };
            LogAssert.Expect(LogType.Warning, new System.Text.RegularExpressions.Regex("screens with different exact viewports share the PanelSettings"));
            doc.rootVisualElement.Add(other);
            yield return Frames(4);
            other.RemoveFromHierarchy();
            b.RemoveFromHierarchy();
            Assert.AreEqual(1f, _settings.scale, "the last screen gave the factor back");
            Assert.AreEqual(0, DesignRootScalePanels.Count);
            Object.DestroyImmediate(doc.gameObject);
        }

        /// <summary>A held PanelSettings destroyed before its screen leaves: the screen leaves without an error and nothing stays held.</summary>
        [UnityTest]
        public IEnumerator AHeldPanelSettingsDestroyedFirst_LeavesNothingHeld()
        {
            var doc = Document(1600, 900);
            yield return Frames(2);
            var screen = PlainScreen("root");
            doc.rootVisualElement.Add(screen);
            yield return Frames(6);
            Assert.AreEqual(1, DesignRootScalePanels.Count);
            Object.DestroyImmediate(_settings);
            Object.DestroyImmediate(doc.gameObject);
            yield return null;
            Assert.AreEqual(0, DesignRootScalePanels.Count);
            LogAssert.NoUnexpectedReceived();
        }

        /// <summary>
        /// While the panel has no size for a moment (here its root's size taken away, as between target textures) the factor
        /// stays held and the root keeps its scale, so the screen is not drawn at the exact scale unscaled meanwhile.
        /// </summary>
        [UnityTest]
        public IEnumerator APanelWithoutASizeForAMoment_KeepsTheRootScale()
        {
            var doc = Document(1600, 900);
            yield return Frames(2);
            var screen = PlainScreen("root");
            doc.rootVisualElement.Add(screen);
            yield return Frames(6);
            float r = screen.RootScale;
            Assert.AreNotEqual(1f, r);
            var tree = screen.panel.visualTree;
            var width = tree.style.width;
            tree.style.width = StyleKeyword.Null;
            screen.ApplyRootScale();
            Assert.AreEqual(r, screen.RootScale, "the root keeps its scale");
            Assert.AreEqual(ScaleOf(1600, 900), screen.DesignScale ?? double.NaN, 1e-4, "and its design scale");
            Assert.AreEqual(1.2f, _settings.scale, 1e-4, "the factor stays held");
            tree.style.width = width;
            tree.MarkDirtyRepaint();
            yield return Frames(4);
            Assert.AreEqual(r, screen.RootScale, 1e-6);
            Object.DestroyImmediate(doc.gameObject);
        }
    }
}
