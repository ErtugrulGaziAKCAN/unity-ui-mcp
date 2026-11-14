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

        [TearDown]
        public void Cleanup()
        {
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
            composite.Attach(settings, width, height); // OnEnable does this in Play mode, at the screen's size
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
