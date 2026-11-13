using System.Collections;
using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.TestTools.Constraints;
using UnityEngine.UIElements;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// <see cref="DesignUiPanelRegion"/>: a uGUI shell frames a design screen's UIDocument through a RectTransform. The
    /// shell here is a Screen Space - Camera canvas whose camera renders into the same render texture the panel renders
    /// into, so a "resolution change" is a new texture for both.
    /// </summary>
    public class PanelRegionTests
    {
        readonly List<Object> _objects = new List<Object>();
        Camera _camera;
        Canvas _canvas;
        RectTransform _frame;
        UIDocument _doc;
        PanelSettings _settings;
        DesignUiPanelRegion _region;

        [TearDown]
        public void Cleanup()
        {
            if (_region != null) _region.Detach();
            DesignText.Fonts = null;
            if (_camera != null) _camera.targetTexture = null; // before the textures go
            if (_settings != null) _settings.targetTexture = null;
            for (int i = _objects.Count - 1; i >= 0; i--)
                if (_objects[i] != null) Object.DestroyImmediate(_objects[i]);
            _objects.Clear();
        }

        T Track<T>(T o) where T : Object
        {
            _objects.Add(o);
            return o;
        }

        static PanelSettings DesignSettings() => Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());

        /// <summary>
        /// A shell canvas with a frame anchored to (0.1, 0.2)–(0.7, 0.9) of the screen (asymmetric, so a wrong y flip
        /// shows) and a design screen's document on the package's PanelSettings (scale with screen size, 2560×1440,
        /// match 0.5), both rendering into a <paramref name="w"/>×<paramref name="h"/> texture.
        /// </summary>
        void Shell(int w, int h)
        {
            var rt = Track(new RenderTexture(w, h, 24));
            _camera = Track(new GameObject("PanelRegionTests camera")).AddComponent<Camera>();
            _camera.targetTexture = rt;
            _camera.clearFlags = CameraClearFlags.SolidColor;

            var canvasGo = Track(new GameObject("PanelRegionTests shell", typeof(RectTransform)));
            _canvas = canvasGo.AddComponent<Canvas>();
            _canvas.renderMode = RenderMode.ScreenSpaceCamera;
            _canvas.worldCamera = _camera;
            _canvas.planeDistance = 10;

            var frameGo = new GameObject("frame", typeof(RectTransform));
            _frame = (RectTransform)frameGo.transform;
            _frame.SetParent(canvasGo.transform, false);
            _frame.anchorMin = new Vector2(0.1f, 0.2f);
            _frame.anchorMax = new Vector2(0.7f, 0.9f);
            _frame.offsetMin = Vector2.zero;
            _frame.offsetMax = Vector2.zero;

            _settings = Track(DesignSettings());
            _settings.targetTexture = rt;
            _doc = Track(new GameObject("PanelRegionTests screen")).AddComponent<UIDocument>();
            _doc.panelSettings = _settings;

            _region = frameGo.AddComponent<DesignUiPanelRegion>();
            _region.Document = _doc;
        }

        void Resize(int w, int h)
        {
            var rt = Track(new RenderTexture(w, h, 24));
            _camera.targetTexture = rt;
            _settings.targetTexture = rt;
        }

        /// <summary>Lets the canvas and the panel take the current texture size.</summary>
        IEnumerator Settle()
        {
            for (int i = 0; i < 3; i++)
            {
                Canvas.ForceUpdateCanvases();
                _camera.Render();
                yield return null;
            }
        }

        /// <summary>The panel scale Unity resolves for a texture (linear blend, spec 12 / R49).</summary>
        static float Scale(int w, int h) => Mathf.Lerp(w / 2560f, h / 1440f, 0.5f);

        static void AreClose(Rect expected, Rect actual, string what)
        {
            const float tol = 0.05f;
            Assert.AreEqual(expected.x, actual.x, tol, what + ": x " + actual);
            Assert.AreEqual(expected.y, actual.y, tol, what + ": y " + actual);
            Assert.AreEqual(expected.width, actual.width, tol, what + ": width " + actual);
            Assert.AreEqual(expected.height, actual.height, tol, what + ": height " + actual);
        }

        /// <summary>The frame's rect in panel points: screen pixels (top-left origin) divided by the panel scale.</summary>
        static Rect Expected(int w, int h)
        {
            var s = Scale(w, h);
            return new Rect(0.1f * w / s, 0.1f * h / s, 0.6f * w / s, 0.7f * h / s);
        }

        [UnityTest]
        public IEnumerator Root_FollowsTheFrame_AcrossResolutionChanges()
        {
            Shell(2560, 1440);
            _region.Attach();
            foreach (var (w, h) in new[] { (2560, 1440), (1280, 720), (1920, 1200), (2560, 1440) })
            {
                Resize(w, h);
                yield return Settle();
                var canvasRect = ((RectTransform)_canvas.transform).rect;
                Assert.AreEqual(w, canvasRect.width, 0.01f, "precondition: the shell canvas takes the texture size");
                Assert.AreEqual(h, canvasRect.height, 0.01f, "precondition: the shell canvas takes the texture size");
                Assert.AreEqual(Scale(w, h), _doc.rootVisualElement.panel.scaledPixelsPerPoint, 1e-4f, "precondition: the panel scale");

                _region.Refresh();
                yield return null;
                var expected = Expected(w, h);
                AreClose(expected, _region.PanelRect, w + "x" + h + " region rect");
                AreClose(expected, _doc.rootVisualElement.layout, w + "x" + h + " root layout");
            }
        }

        [UnityTest]
        public IEnumerator Refresh_ReappliesTheRect_WhenTheDocumentResetsItsRootStyle()
        {
            Shell(1280, 720);
            _region.Attach();
            yield return Settle();
            _region.Refresh();
            _doc.rootVisualElement.style.width = StyleKeyword.Null; // what UIDocument does when it re-creates its root
            _region.Refresh();
            yield return null;
            AreClose(Expected(1280, 720), _doc.rootVisualElement.layout, "root layout");
            Assert.That(() => _region.Refresh(), UnityEngine.TestTools.Constraints.Is.Not.AllocatingGCMemory(), "a frame without a change allocates nothing");
        }

        [Test]
        public void SortingOrder_ComesFromTheSettings_ThroughACopyOfThePanelSettings()
        {
            Shell(640, 360);
            var source = _settings;
            Assert.AreEqual(0f, source.sortingOrder);
            _region.Settings = new DesignUiHostSettings { sortingOrder = 7, documentOrder = 3 };
            _region.Attach();

            var applied = _doc.panelSettings;
            Assert.AreNotSame(source, applied, "the shared PanelSettings asset is never changed");
            Assert.AreEqual(7f, applied.sortingOrder, "panel sort order");
            Assert.AreEqual(0f, source.sortingOrder);
            Assert.AreEqual(3f, _doc.sortingOrder, "document order within the panel");
            Assert.AreSame(source.themeStyleSheet, applied.themeStyleSheet, "the copy keeps the source's settings");
            Assert.AreSame(source.targetTexture, applied.targetTexture);

            // a second region with the same source and order shares the copy (one panel, not one per region)
            var other = Track(new GameObject("other screen")).AddComponent<UIDocument>();
            other.panelSettings = source;
            var otherRegion = Track(new GameObject("other frame", typeof(RectTransform))).AddComponent<DesignUiPanelRegion>();
            otherRegion.Document = other;
            otherRegion.Settings = new DesignUiHostSettings { sortingOrder = 7 };
            otherRegion.Attach();
            Assert.AreSame(applied, other.panelSettings);

            _region.Detach();
            Assert.AreSame(source, _doc.panelSettings, "detaching restores the document's PanelSettings");
            Assert.IsTrue(applied != null, "still used by the other region");
            otherRegion.Detach();
            Assert.AreSame(source, other.panelSettings);
            Assert.IsTrue(applied == null, "the copy is destroyed with its last user");
        }

        [Test]
        public void SortingOrder_EqualToTheAssets_UsesTheAssetItself()
        {
            Shell(640, 360);
            _settings.sortingOrder = 4;
            _region.Settings = new DesignUiHostSettings { sortingOrder = 4 };
            _region.Attach();
            Assert.AreSame(_settings, _doc.panelSettings);
        }

        [UnityTest]
        public IEnumerator IsPointerOverPanel_IsTrueOverTheScreensElementsOnly()
        {
            Shell(1280, 720);
            _region.Attach();
            yield return Settle();
            _region.Refresh();
            var card = new VisualElement { name = "card" };
            card.style.position = Position.Absolute;
            card.style.left = 100; card.style.top = 50; card.style.width = 400; card.style.height = 200;
            card.style.backgroundColor = Color.white;
            _doc.rootVisualElement.Add(card);

            // another document on the same panel, outside the region's screen
            var other = Track(new GameObject("other screen")).AddComponent<UIDocument>();
            other.panelSettings = _settings;
            var foreign = new VisualElement();
            foreign.style.position = Position.Absolute;
            foreign.style.left = 0; foreign.style.top = 0; foreign.style.width = 100; foreign.style.height = 100;
            foreign.style.backgroundColor = Color.red;
            other.rootVisualElement.Add(foreign);
            yield return null;
            yield return null;

            const float s = 0.5f; // panel scale at 1280×720
            const int h = 720;
            // screen positions as Input System / uGUI report them: pixels, origin bottom-left
            Vector2 ScreenAt(float panelX, float panelY) => new Vector2(panelX * s, h - panelY * s);
            var root = _region.PanelRect;
            Assert.IsTrue(_region.IsPointerOverPanel(ScreenAt(root.x + 300, root.y + 150)), "over the card");
            Assert.IsFalse(_region.IsPointerOverPanel(ScreenAt(root.x + 50, root.y + 150)), "inside the frame, nothing pickable (the root ignores picking)");
            Assert.IsFalse(_region.IsPointerOverPanel(ScreenAt(root.xMax + 20, root.y + 150)), "outside the frame");
            Assert.IsFalse(_region.IsPointerOverPanel(ScreenAt(50, 50)), "over another document of the same panel");
            Assert.IsTrue(_region.IsPointerOverPanel(ScreenAt(root.x + 101, root.y + 51)), "card edge");
        }

        [UnityTest]
        public IEnumerator FocusAndEscape_AreRaisedAsEvents()
        {
            Shell(640, 360);
            _region.Attach();
            yield return null;
            var a = new Button { name = "a", text = "a" };
            var b = new Button { name = "b", text = "b" };
            _doc.rootVisualElement.Add(a);
            _doc.rootVisualElement.Add(b);
            var other = Track(new GameObject("other screen")).AddComponent<UIDocument>();
            other.panelSettings = _settings;
            var outside = new Button { name = "outside", text = "outside" };
            other.rootVisualElement.Add(outside);
            yield return null;

            int entered = 0, left = 0, escapes = 0;
            _region.FocusEntered += () => entered++;
            _region.FocusLeft += () => left++;
            _region.EscapePressed += () => escapes++;

            Assert.IsFalse(_region.HasFocus);
            a.Focus();
            Assert.AreEqual((1, 0), (entered, left), "focus moves into the screen");
            Assert.IsTrue(_region.HasFocus);
            b.Focus();
            Assert.AreEqual((1, 0), (entered, left), "focus moves inside the screen: no event");
            outside.Focus();
            Assert.AreEqual((1, 1), (entered, left), "focus leaves the screen");
            Assert.IsFalse(_region.HasFocus);
            Assert.IsTrue(_region.FocusFirst(), "focuses the screen's first focusable element");
            Assert.AreSame(a, a.panel.focusController.focusedElement);
            Assert.AreEqual((2, 1), (entered, left));

            // UI Toolkit sends a cancel to the focused element, whichever element it is sent to
            b.Focus();
            using (var e = NavigationCancelEvent.GetPooled(EventModifiers.None)) b.SendEvent(e);
            Assert.AreEqual(1, escapes, "a cancel (Escape, gamepad cancel) while the screen has focus");

            b.RegisterCallback<NavigationCancelEvent>(e => e.StopPropagation());
            using (var e = NavigationCancelEvent.GetPooled(EventModifiers.None)) b.SendEvent(e);
            Assert.AreEqual(1, escapes, "an element that handles the cancel itself keeps it");

            outside.Focus();
            using (var e = NavigationCancelEvent.GetPooled(EventModifiers.None)) outside.SendEvent(e);
            Assert.AreEqual(1, escapes, "a cancel while another document has focus is not the screen's");

            a.Focus();
            _region.Detach();
            using (var e = NavigationCancelEvent.GetPooled(EventModifiers.None)) a.SendEvent(e);
            Assert.AreEqual(1, escapes, "no events after detaching");
        }

        [Test]
        public void Attach_AssignsTheFontSet_ToDesignText()
        {
            Shell(640, 360);
            var fonts = Track(ScriptableObject.CreateInstance<DesignFontSet>());
            _region.Fonts = fonts;
            _region.Attach();
            Assert.AreSame(fonts, DesignText.Fonts, "bound texts are prepared in the screens' twins without the game wiring the set");
        }

        [Test]
        public void EditorDefaults_CopyTheProfilesHostSettingsAndFindTheFontSet()
        {
            Shell(640, 360);
            var profile = Track(ScriptableObject.CreateInstance<DesignUiProfile>());
            profile.host = new DesignUiHostSettings { sortingOrder = 12, documentOrder = 2 };
            var fonts = Track(ScriptableObject.CreateInstance<DesignFontSet>());
            _region.Fonts = null; // Reset may have found the project's own set already
            DesignUiHostDefaults.Apply(_region, profile, fonts);
            Assert.AreEqual(12f, _region.Settings.sortingOrder);
            Assert.AreEqual(2f, _region.Settings.documentOrder);
            Assert.AreNotSame(profile.host, _region.Settings, "a copy: the region keeps its own values");
            Assert.AreSame(fonts, _region.Fonts);
            var other = Track(ScriptableObject.CreateInstance<DesignFontSet>());
            DesignUiHostDefaults.Apply(_region, profile, other);
            Assert.AreSame(fonts, _region.Fonts, "a set already chosen stays");
        }
    }
}
