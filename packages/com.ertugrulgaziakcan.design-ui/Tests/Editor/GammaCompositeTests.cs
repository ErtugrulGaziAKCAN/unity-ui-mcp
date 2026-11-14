using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// DesignUiGammaComposite in a Linear-colour-space project: the panel renders into its UNorm texture with
    /// forceGammaRendering, and the composite over an sRGB target (the screen's stand-in) stores the panel's colours:
    /// opaque ones unchanged, translucent ones inside the panel as the design's browser blends them. What the panel shows
    /// over the game's own image is blended in linear light. Also: the PanelSettings get their own settings back, and the
    /// cost of one composite.
    /// </summary>
    public class GammaCompositeTests
    {
        readonly List<Object> _objects = new List<Object>();

        [SetUp]
        public void LinearOnly()
        {
            if (QualitySettings.activeColorSpace != ColorSpace.Linear) Assert.Ignore("the composite does nothing in a Gamma project");
        }

        System.Func<IDesignLocaleSource> _defaultLocales;
        bool _localesSaved;

        [TearDown]
        public void Cleanup()
        {
            if (_localesSaved) DesignLocaleSources.Default = _defaultLocales;
            _localesSaved = false;
            foreach (var o in _objects)
                if (o is GameObject g && g.TryGetComponent<DesignUiPanelRegion>(out var r)) r.Detach();
            foreach (var o in _objects)
            {
                if (o is GameObject go && go.TryGetComponent<DesignUiGammaComposite>(out var c)) c.Detach();
                if (o != null) Object.DestroyImmediate(o);
            }
            _objects.Clear();
        }

        (DesignUiGammaComposite composite, PanelSettings settings, VisualElement root) Panel(int width, int height)
        {
            var settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            settings.scale = 1f;
            var go = new GameObject("GammaCompositeTests");
            _objects.Add(go);
            _objects.Add(settings);
            var composite = go.AddComponent<DesignUiGammaComposite>();
            composite.panelSettings = settings;
            composite.Attach(settings, new Vector2Int(width, height), new Vector2Int(width, height)); // OnEnable does this in Play mode, at the screen's size
            var doc = go.AddComponent<UIDocument>();
            doc.panelSettings = settings;
            return (composite, settings, doc.rootVisualElement);
        }

        static VisualElement Box(VisualElement parent, float x, float y, float w, float h, Color color)
        {
            var e = new VisualElement();
            e.style.position = Position.Absolute;
            e.style.left = x;
            e.style.top = y;
            e.style.width = w;
            e.style.height = h;
            e.style.backgroundColor = color;
            parent.Add(e);
            return e;
        }

        static Color Hex(string hex)
        {
            ColorUtility.TryParseHtmlString(hex, out var c);
            return c;
        }

        RenderTexture Screen(int width, int height, Color clear)
        {
            var rt = new RenderTexture(new RenderTextureDescriptor(width, height, GraphicsFormat.R8G8B8A8_SRGB, 0) { sRGB = true });
            rt.Create();
            _objects.Add(rt);
            var active = RenderTexture.active;
            RenderTexture.active = rt;
            GL.Clear(true, true, clear);
            RenderTexture.active = active;
            return rt;
        }

        /// <summary>The stored bytes of a texture (an sRGB texture is read into an sRGB Texture2D: no conversion).</summary>
        Color32[] Bytes(RenderTexture rt)
        {
            var tex = new Texture2D(rt.width, rt.height, TextureFormat.RGBA32, false, !rt.sRGB);
            _objects.Add(tex);
            var active = RenderTexture.active;
            RenderTexture.active = rt;
            tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0, false);
            RenderTexture.active = active;
            return tex.GetPixels32();
        }

        /// <summary>The pixel at (x, y), y from the top.</summary>
        static Color32 At(Color32[] px, int width, int height, int x, int y) => px[(height - 1 - y) * width + x];

        static void AssertNear(string expected, Color32 actual, int tolerance, string what)
        {
            var e = (Color32)Hex(expected);
            Assert.IsTrue(Mathf.Abs(e.r - actual.r) <= tolerance && Mathf.Abs(e.g - actual.g) <= tolerance && Mathf.Abs(e.b - actual.b) <= tolerance,
                what + ": expected " + expected + ", got #" + actual.r.ToString("x2") + actual.g.ToString("x2") + actual.b.ToString("x2"));
        }

        static IEnumerator Frames(int n)
        {
            for (int i = 0; i < n; i++) yield return null;
        }

        [UnityTest]
        public IEnumerator Composite_StoresThePanelsColours_AndBlendsInsideThePanelAsTheDesign()
        {
            const int W = 320, H = 120;
            var (composite, settings, root) = Panel(W, H);
            Assert.AreSame(composite.Target, settings.targetTexture);
            Assert.IsTrue(settings.forceGammaRendering);
            Box(root, 0, 0, 100, 50, Hex("#16c2d5"));                                    // opaque
            Box(Box(root, 100, 0, 100, 50, Hex("#0b1f26")), 0, 0, 100, 50, new Color(1, 1, 1, 0.25f)); // 25 % white over the panel's own colour
            Box(root, 200, 0, 100, 50, new Color(1, 1, 1, 0.25f));                       // 25 % white over the game's image
            yield return Frames(4);

            var screen = Screen(W, H, Color.black);
            composite.Composite(screen);
            var px = Bytes(screen);
            AssertNear("#16c2d5", At(px, W, H, 50, 25), 1, "an opaque colour is stored unchanged");
            AssertNear("#48575c", At(px, W, H, 150, 25), 1, "translucent over the panel: blended in gamma space, as Chromium");
            // over the game's image the composite blends in linear light: 25 % white over black is 0.25 in linear light
            AssertNear("#898989", At(px, W, H, 250, 25), 2, "translucent over the game's image: blended in linear light");
            AssertNear("#000000", At(px, W, H, 250, 80), 0, "where the panel draws nothing the screen shows through");
        }

        [UnityTest]
        public IEnumerator Detach_GivesThePanelSettingsTheirOwnSettingsBack()
        {
            var (composite, settings, _) = Panel(64, 64);
            yield return null;
            composite.Detach();
            Assert.IsNull(settings.targetTexture);
            Assert.IsFalse(settings.forceGammaRendering, "the package's DesignUiPanelSettings has it off");
            Assert.IsNull(composite.Target);
        }

        // ---- pointer input ---------------------------------------------------------------------------------------------

        /// <summary>An on-screen panel (no target texture) with a box near the top and one below it, named top and bottom.</summary>
        (GameObject go, PanelSettings settings, VisualElement root) OnScreenPanel(float scale)
        {
            var settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            settings.scale = scale;
            var go = new GameObject("GammaCompositeTests");
            _objects.Add(go);
            _objects.Add(settings);
            var doc = go.AddComponent<UIDocument>();
            doc.panelSettings = settings;
            var root = doc.rootVisualElement;
            Box(root, 20, 20, 160, 60, Color.red).name = "top";
            Box(root, 20, 120, 160, 60, Color.blue).name = "bottom";
            return (go, settings, root);
        }

        /// <summary>
        /// The element a pointer at <paramref name="screen"/> (screen pixels, origin top left, as UI Toolkit's event
        /// handling passes them) reaches: the panel's screen-to-panel mapping, then a pick.
        /// </summary>
        static string Under(VisualElement root, Vector2 screen)
        {
            var at = RuntimePanelUtils.ScreenToPanel(root.panel, screen);
            return root.panel.Pick(at)?.name;
        }

        static void AssertMapping(VisualElement root, string when)
        {
            Assert.AreEqual("top", Under(root, new Vector2(60, 40)), when + ": a point on the top box");
            Assert.AreEqual("bottom", Under(root, new Vector2(60, 140)), when + ": a point on the bottom box (the y axis is not flipped)");
            Assert.AreEqual("top", Under(root, new Vector2(170, 75)), when + ": near the top box's bottom right corner");
        }

        [UnityTest]
        public IEnumerator Pointer_AtAScreenPoint_ReachesTheSameElement_WithTheCompositeOnAndOff()
        {
            var (go, settings, root) = OnScreenPanel(1f);
            yield return Frames(3);
            AssertMapping(root, "an ordinary on-screen panel");

            var composite = go.AddComponent<DesignUiGammaComposite>();
            composite.panelSettings = settings;
            composite.Attach(settings, new Vector2Int(400, 300), new Vector2Int(400, 300));
            yield return Frames(3);
            Assert.AreSame(composite.Target, settings.targetTexture);
            AssertMapping(root, "the composite, its texture the screen's size");

            composite.Detach();
            yield return Frames(3);
            Assert.IsNull(settings.targetTexture);
            AssertMapping(root, "the on-screen panel again");
        }

        [UnityTest]
        public IEnumerator Pointer_ATextureOfAnotherSizeThanTheScreen_MapsScreenPixelsToItsPixels()
        {
            // a texture twice the screen's size with the panel at scale 2: the same logical layout as the screen at scale 1
            var (go, settings, root) = OnScreenPanel(2f);
            var composite = go.AddComponent<DesignUiGammaComposite>();
            composite.panelSettings = settings;
            composite.Attach(settings, new Vector2Int(800, 600), new Vector2Int(400, 300));
            yield return Frames(3);
            AssertMapping(root, "the composite, its texture twice the screen's size");
        }

        [UnityTest]
        public IEnumerator Resize_FollowsTheScreen_AndKeepsThePointerMapping()
        {
            var (go, settings, root) = OnScreenPanel(1f);
            var composite = go.AddComponent<DesignUiGammaComposite>();
            composite.panelSettings = settings;
            composite.Attach(settings, new Vector2Int(400, 300), new Vector2Int(400, 300));
            yield return Frames(3);
            var first = composite.Target;
            composite.Resize(new Vector2Int(640, 480), new Vector2Int(640, 480));
            yield return Frames(3);
            Assert.AreEqual(new Vector2Int(640, 480), new Vector2Int(settings.targetTexture.width, settings.targetTexture.height));
            Assert.AreSame(composite.Target, settings.targetTexture);
            Assert.IsTrue(first == null, "the earlier texture is released");
            AssertMapping(root, "after a resize");
        }

        [UnityTest]
        public IEnumerator Detach_RestoresThePanelSettingsOwnPointerMapping()
        {
            var (go, settings, root) = OnScreenPanel(1f);
            // the game's own mapping: everything 100 px lower
            settings.SetScreenToPanelSpaceFunction(p => p + new Vector2(0, 100));
            yield return Frames(3);
            Assert.AreEqual("bottom", Under(root, new Vector2(60, 40)), "the game's mapping");
            var composite = go.AddComponent<DesignUiGammaComposite>();
            composite.panelSettings = settings;
            composite.Attach(settings, new Vector2Int(400, 300), new Vector2Int(400, 300));
            yield return Frames(3);
            Assert.AreEqual("top", Under(root, new Vector2(60, 40)), "the composite maps the screen to its texture");
            composite.Detach();
            yield return Frames(3);
            Assert.AreEqual("bottom", Under(root, new Vector2(60, 40)), "the game's mapping is back");
            composite.Detach(); // twice is harmless
            Assert.AreEqual("bottom", Under(root, new Vector2(60, 40)));
        }

        [Test]
        public void ARegion_WarnsAboutAPanelNoCompositeRenders_AndNotAboutOneItDoes()
        {
            var settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            settings.name = "Design Panel";
            _objects.Add(settings);
            StringAssert.Contains("renders the screen on PanelSettings 'Design Panel' without DesignUiGammaComposite",
                DesignUiPanelRegion.ColourWarning("Inbox", settings, false));
            StringAssert.Contains("the PanelSettings asset this copy was made from", DesignUiPanelRegion.ColourWarning("Inbox", settings, true));

            var go = new GameObject("GammaCompositeTests");
            _objects.Add(go);
            var composite = go.AddComponent<DesignUiGammaComposite>();
            composite.Attach(settings, new Vector2Int(64, 64), new Vector2Int(64, 64));
            Assert.IsTrue(DesignUiGammaComposite.Drives(settings));
            Assert.IsNull(DesignUiPanelRegion.ColourWarning("Inbox", settings, false));
            var stray = Object.Instantiate(settings); // a copy no region made: nothing tells the composite about it
            _objects.Add(stray);
            Assert.IsNotNull(DesignUiPanelRegion.ColourWarning("Inbox", stray, true));
            composite.Detach();
            Assert.IsFalse(DesignUiGammaComposite.Drives(settings));
        }

        // ---- a region's sort-order copy -------------------------------------------------------------------------------

        /// <summary>
        /// A region whose document renders on a runtime copy of <paramref name="settings"/> (sort order 7; the asset has 0),
        /// framing the whole <paramref name="w"/>×<paramref name="h"/> texture, with a #16c2d5 box at (10, 10, 40, 30).
        /// </summary>
        (DesignUiPanelRegion region, UIDocument doc) Region(PanelSettings settings, int w, int h)
        {
            var go = new GameObject("GammaCompositeTests region", typeof(RectTransform));
            _objects.Add(go);
            var rect = (RectTransform)go.transform;
            rect.sizeDelta = new Vector2(w, h);
            rect.position = new Vector3(w / 2f, h / 2f, 0);
            var docGo = new GameObject("GammaCompositeTests region document");
            _objects.Add(docGo);
            var doc = docGo.AddComponent<UIDocument>();
            doc.panelSettings = settings;
            Box(doc.rootVisualElement, 10, 10, 40, 30, Hex("#16c2d5"));
            if (!_localesSaved)
            {
                // the Unity Localization adapter registers itself as the default source when the package is installed
                _defaultLocales = DesignLocaleSources.Default;
                _localesSaved = true;
                DesignLocaleSources.Default = null;
            }
            var region = go.AddComponent<DesignUiPanelRegion>();
            region.Document = doc;
            region.Settings = new DesignUiHostSettings { sortingOrder = 7 };
            return (region, doc);
        }

        PanelSettings DesignPanel()
        {
            var settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            settings.scale = 1f;
            settings.sortingOrder = 0;
            _objects.Add(settings);
            return settings;
        }

        /// <summary>The composite renders the copy into a texture of its own and stores the region's colours.</summary>
        IEnumerator AssertRendersTheCopy(DesignUiGammaComposite composite, PanelSettings copy, int w, int h, string when)
        {
            var own = composite.TargetOf(copy);
            Assert.IsNotNull(own, when + ": the composite drives the region's copy");
            Assert.AreSame(own, copy.targetTexture, when);
            Assert.AreNotSame(composite.Target, own, when + ": a texture of its own (a panel clears its target)");
            Assert.IsTrue(copy.forceGammaRendering, when);
            Assert.IsTrue(DesignUiGammaComposite.Drives(copy), when);
            Assert.AreEqual(new Vector2Int(w, h), new Vector2Int(own.width, own.height), when + ": the composite's size");
            yield return Frames(4);
            var screen = Screen(w, h, Color.black);
            composite.Composite(screen);
            AssertNear("#16c2d5", At(Bytes(screen), w, h, 30, 25), 1, when + ": the region's box through the composite");
        }

        [UnityTest]
        public IEnumerator RegionCopy_MadeBeforeTheCompositeAttaches_IsRendered_AndGetsItsOwnSettingsBack()
        {
            const int W = 160, H = 90;
            var settings = DesignPanel();
            var (region, doc) = Region(settings, W, H);
            region.Attach();
            var copy = doc.panelSettings;
            Assert.AreNotSame(settings, copy, "the region renders on a copy for its sort order");
            Assert.IsNull(copy.targetTexture);
            var go = new GameObject("GammaCompositeTests composite");
            _objects.Add(go);
            var composite = go.AddComponent<DesignUiGammaComposite>();
            composite.Attach(settings, new Vector2Int(W, H), new Vector2Int(W, H));
            yield return AssertRendersTheCopy(composite, copy, W, H, "copy made before");

            composite.Detach();
            Assert.IsNull(copy.targetTexture, "the copy's own target is back");
            Assert.IsFalse(copy.forceGammaRendering);
            Assert.IsFalse(DesignUiGammaComposite.Drives(copy));
            region.Detach();
        }

        [UnityTest]
        public IEnumerator RegionCopy_MadeAfterTheCompositeAttached_IsRendered_FollowsAResize_AndGetsTheAssetsSettingsBack()
        {
            const int W = 160, H = 90;
            var settings = DesignPanel();
            var go = new GameObject("GammaCompositeTests composite");
            _objects.Add(go);
            var composite = go.AddComponent<DesignUiGammaComposite>();
            composite.Attach(settings, new Vector2Int(W, H), new Vector2Int(W, H));
            var (region, doc) = Region(settings, W, H);
            region.Attach();
            var copy = doc.panelSettings;
            Assert.AreNotSame(settings, copy);
            yield return AssertRendersTheCopy(composite, copy, W, H, "copy made after");

            // a resize gives the copy a new texture of the new size; the old one is released
            var before = composite.TargetOf(copy);
            composite.Resize(new Vector2Int(2 * W, 2 * H), new Vector2Int(2 * W, 2 * H));
            Assert.IsTrue(before == null, "the copy's earlier texture is released");
            // the shell's frame follows the screen too
            var rect = (RectTransform)region.transform;
            rect.sizeDelta = new Vector2(2 * W, 2 * H);
            rect.position = new Vector3(W, H, 0);
            region.Refresh();
            yield return AssertRendersTheCopy(composite, copy, 2 * W, 2 * H, "after a resize");

            composite.Detach();
            Assert.IsNull(copy.targetTexture, "what the asset had before the composite (the copy was made from the driven asset)");
            Assert.IsFalse(copy.forceGammaRendering);
            Assert.IsNull(settings.targetTexture);
            region.Detach();
            Assert.AreSame(settings, doc.panelSettings);
        }

        [UnityTest]
        public IEnumerator RegionCopy_Released_IsNoLongerDriven_TheAssetStillIs()
        {
            const int W = 64, H = 64;
            var settings = DesignPanel();
            var go = new GameObject("GammaCompositeTests composite");
            _objects.Add(go);
            var composite = go.AddComponent<DesignUiGammaComposite>();
            composite.Attach(settings, new Vector2Int(W, H), new Vector2Int(W, H));
            var (region, doc) = Region(settings, W, H);
            region.Attach();
            var copy = doc.panelSettings;
            Assert.IsTrue(DesignUiGammaComposite.Drives(copy));
            region.Detach(); // its last user: the copy goes
            yield return null;
            Assert.IsFalse(DesignUiGammaComposite.Drives(copy));
            Assert.IsTrue(DesignUiGammaComposite.Drives(settings));
            Assert.AreSame(composite.Target, settings.targetTexture);
            composite.Detach();
        }

        /// <summary>The cost of one composite at 2560×1440 (logged; the findings quote it).</summary>
        [UnityTest]
        public IEnumerator Composite_Cost_At2560x1440()
        {
            var (composite, _, root) = Panel(2560, 1440);
            Box(root, 0, 0, 2560, 1440, Hex("#0b1f26"));
            yield return Frames(4);
            var screen = Screen(2560, 1440, Color.black);
            var probe = new Texture2D(1, 1, TextureFormat.RGBA32, false, false);
            _objects.Add(probe);
            void Sync()
            {
                var active = RenderTexture.active;
                RenderTexture.active = screen;
                probe.ReadPixels(new Rect(0, 0, 1, 1), 0, 0, false); // waits for the GPU
                RenderTexture.active = active;
            }
            composite.Composite(screen);
            Sync();
            const int N = 200;
            var sw = Stopwatch.StartNew();
            for (int i = 0; i < N; i++) composite.Composite(screen);
            Sync();
            sw.Stop();
            var ms = sw.Elapsed.TotalMilliseconds / N;
            Debug.Log("DesignUiGammaComposite: " + ms.ToString("0.000") + " ms per composite at 2560x1440 (" + SystemInfo.graphicsDeviceType + ", " +
                      SystemInfo.graphicsDeviceName + "); texture " + (2560 * 1440 * 8 / 1048576.0).ToString("0.0") + " MB with its depth-stencil");
            Assert.Less(ms, 50, "a composite is one full-screen pass");
        }
    }
}
