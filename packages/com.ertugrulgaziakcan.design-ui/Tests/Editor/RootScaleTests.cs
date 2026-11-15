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
    /// the nearest exact scale (the PanelSettings' scale factor) and draws itself scaled by actual / exact from its top-left
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
        public void KeepRule() => _rule = DesignViewportScales.Rule;

        [TearDown]
        public void Cleanup()
        {
            DesignViewportScales.Rule = _rule;
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
        public void LayoutScale_IsThePanelsOwnWhereExact_ElseTheNearestExactScaleInLogScale_OrTheRulesNeighbour()
        {
            double s1366 = ScaleOf(1366, 768);
            Assert.AreEqual(0.75, DesignViewportScales.LayoutScale(Exact, 0.75));
            Assert.AreEqual(0.75, DesignViewportScales.LayoutScale(Exact, 0.75 + 5e-5), "within the tolerance");
            Assert.AreEqual(0.75, DesignViewportScales.LayoutScale(Exact, 0.625), "|ln 1.2| < |ln 0.8|");
            Assert.AreEqual(0.5, DesignViewportScales.LayoutScale(Exact, s1366));
            Assert.AreEqual(1.5, DesignViewportScales.LayoutScale(Exact, 2.0), "above every exact scale: the largest");
            Assert.AreEqual(0.5, DesignViewportScales.LayoutScale(Exact, 0.4), "below every exact scale: the smallest");
            Assert.AreEqual(0.6, DesignViewportScales.LayoutScale(null, 0.6), "no exact scales: the panel's own");
            DesignViewportScales.Rule = DesignViewportScales.BaseRule.Up;
            Assert.AreEqual(0.75, DesignViewportScales.LayoutScale(Exact, 0.625));
            Assert.AreEqual(0.75, DesignViewportScales.LayoutScale(Exact, s1366));
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
        /// below a 20 px child (UI Toolkit lays 4 px out as 3 device px at 0.625 and 2 at 0.5335), a caption, and a breakpoint
        /// that holds below 1600 px of design width.
        /// </summary>
        string Export()
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
            var screen = TestIr.Screen(root, "rootscale.screen");
            screen.Breakpoints = new[] { new IrBreakpoint { Name = "wide", MinAspect = 1.7f } };
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(screen, Formatting.Indented));
            File.WriteAllText(Path.Combine(dir, KitTextStyles.FileName), "{ \"caption\": { \"fontSize\": 12, \"lineHeight\": 16, \"weight\": 400 } }");
            return dir;
        }

        VisualTreeAsset CompileScreen()
        {
            var result = ScreenCompiler.Compile(Export(), Profile(), false, NoView());
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
        /// the panel keeps its size in panel pixels). At a scaled viewport the panel lays out at the nearest exact scale and every
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
            foreach (var (w, h) in new[] { (1920, 1080), (2560, 1440), (1600, 900), (1366, 768), (3840, 2160), (1280, 720), (1600, 900) })
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
                Assert.AreEqual(w / (double)h >= 1.7, screen.ClassListContains("bp-wide"), at + ": the breakpoint at the design's size");
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
            _settings.scale = 0.9f; // the game's UI scale option: 0.625 × 0.9 = 0.5625, nearest exact 0.5
            screen.panel.visualTree.MarkDirtyRepaint(); // a panel applies its settings when it updates: every frame in Play mode, here when dirty
            yield return Frames(6);
            Assert.AreEqual(0.5625, screen.DesignScale ?? double.NaN, 1e-4);
            Assert.AreEqual(0.5, screen.panel.scaledPixelsPerPoint, 1e-4);
            Assert.AreEqual(1.125, screen.RootScale, 1e-4);
            AreDevice(new Rect((float)(397 * 0.5625), (float)(101 * 0.5625), (float)(403 * 0.5625), (float)(37 * 0.5625)), instance.Q("box").worldBound, 0.5, 1.125 + 0.01, "box");
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
        /// 0.5, root 1.067): the pointer reaches an element where the design draws it at the actual scale and nowhere else
        /// (a point inside the unscaled box but outside the drawn one misses); hover, active, a click, a toggle, focus and
        /// typing in a text field, a wheel over a scroll view and a drag (the event's position in the dragged element's space).
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
    }
}
