using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UIElements;
using Object = UnityEngine.Object;

namespace DesignUi
{
    /// <summary>
    /// Frames a design screen inside a uGUI shell: the UIDocument's root takes the screen rect of this RectTransform (in
    /// the document's panel points), so the shell's layout, anchors and Canvas Scaler place the screen, and it follows
    /// resolution and scale changes every frame. The panel's sort order and the screen's order on its panel come from
    /// <see cref="Settings"/> (copied from the project's DesignUiProfile when the component is added in the Editor); a
    /// different sort order renders the document on a runtime copy of its PanelSettings, so the shared asset never
    /// changes. Hosts that route pointer input themselves (and block uGUI raycasts over the screen) ask
    /// <see cref="IsPointerOverPanel"/>; focus entering and leaving the screen and a cancel (Escape) inside it are events.
    /// The region also hands the screens' font set to <see cref="DesignText"/> on attach and runs a
    /// <see cref="LocaleFontController"/> on the document root (the locale from <see cref="LocaleSource"/>, by default Unity
    /// Localization's selected locale; the game's text size from <see cref="TextSizes"/>). It reads no input itself.
    /// When the document re-creates its root (Unity does it, for example, when Enable Advanced Text is switched in a running
    /// Editor and every PanelSettings asset is rewritten), the region follows the new root and raises
    /// <see cref="RootRebuilt"/>: a generated view built on the old root still writes into a tree nobody shows, so the
    /// host builds its view again on the new root.
    /// Runs in Play mode and in players; nothing is applied in Edit mode.
    /// </summary>
    [AddComponentMenu("Design UI/Panel Region")]
    [RequireComponent(typeof(RectTransform))]
    [DisallowMultipleComponent]
    public sealed class DesignUiPanelRegion : MonoBehaviour
    {
        [Tooltip("The design screen's document. Empty: a UIDocument on this GameObject or below it.")]
        [SerializeField] UIDocument m_Document;
        [SerializeField] DesignUiHostSettings m_Settings = new DesignUiHostSettings();
        [Tooltip("The screens' font set (DesignFonts.asset next to the generated screens). Filled in by the Editor when the component is added.")]
        [SerializeField] DesignFontSet m_Fonts;
        [SerializeField] DesignLocaleRules m_LocaleRules = new DesignLocaleRules();
        [Tooltip("Panel scales of the profile's viewports, filled in by the Editor: a text-size step is checked at each (whole device pixels).")]
        [SerializeField] float[] m_ViewportScales = { 1f };
        [Tooltip("Optional: the game's component that implements IDesignTextSizeSource (its text-size setting).")]
        [SerializeField] MonoBehaviour m_TextSizeSource;

        static readonly Vector3[] s_Corners = new Vector3[4];

        UIDocument m_Attached;
        VisualElement m_Root;
        PanelSettings m_Source, m_Copy;
        Canvas m_Canvas;
        bool m_IsAttached, m_WarnedNoFonts;
        float m_PreviousDocumentOrder;
        IDesignLocaleSource m_LocaleSource, m_OwnedLocaleSource;
        IDesignTextSizeSource m_TextSizes;
        LocaleFontController m_LocaleFonts;
        bool m_WarnedRebuilt;

        /// <summary>The framed document (see the field's tooltip for the default).</summary>
        public UIDocument Document
        {
            get => m_Document != null ? m_Document : (m_Document = FindDocument());
            set
            {
                if (m_Document == value) return;
                bool attach = m_IsAttached || isActiveAndEnabled && Application.isPlaying;
                Detach();
                m_Document = value;
                if (attach) Attach();
            }
        }

        /// <summary>Sort order and document order; a change applies on the next attach.</summary>
        public DesignUiHostSettings Settings
        {
            get => m_Settings;
            set => m_Settings = value ?? new DesignUiHostSettings();
        }

        /// <summary>The screens' font set, assigned to <see cref="DesignText.Fonts"/> on attach.</summary>
        public DesignFontSet Fonts
        {
            get => m_Fonts;
            set => m_Fonts = value;
        }

        /// <summary>Right-to-left and shaping locales and the RTL alignment rule; a change applies on the next attach.</summary>
        public DesignLocaleRules LocaleRules
        {
            get => m_LocaleRules;
            set => m_LocaleRules = value ?? new DesignLocaleRules();
        }

        /// <summary>Panel scales of the declared viewports a text-size step is checked at; a change applies on the next attach.</summary>
        public float[] ViewportScales
        {
            get => m_ViewportScales;
            set => m_ViewportScales = value;
        }

        /// <summary>
        /// The locale the screen follows. Null (the default) uses <see cref="DesignLocaleSources.Default"/>: Unity
        /// Localization's selected locale when the package is installed. The default source is created when the region is
        /// enabled (and starts Unity Localization's initialization), so a game with its own source sets this before the
        /// region is enabled, or replaces <see cref="DesignLocaleSources.Default"/>.
        /// </summary>
        public IDesignLocaleSource LocaleSource
        {
            get => m_LocaleSource;
            set
            {
                m_LocaleSource = value;
                Restart();
            }
        }

        /// <summary>The game's text-size setting: set in code, else the component in the Text Size Source field, else none.</summary>
        public IDesignTextSizeSource TextSizes
        {
            get => m_TextSizes ?? m_TextSizeSource as IDesignTextSizeSource;
            set
            {
                m_TextSizes = value;
                Restart();
            }
        }

        /// <summary>The controller that keeps the screen root on the locale and text size while attached, or null.</summary>
        public LocaleFontController LocaleFonts => m_LocaleFonts;

        /// <summary>The root's rect in panel points, as last applied.</summary>
        public Rect PanelRect { get; private set; }

        /// <summary>
        /// Raised when UI Toolkit sends a cancel (<see cref="NavigationCancelEvent"/>: Escape, a gamepad's cancel button)
        /// to an element of the screen, after the element and its ancestors inside the screen had it (one that stops the
        /// event keeps it). UI Toolkit sends it to the focused element, so it arrives while the screen has focus; a host
        /// that also reads Escape itself skips its own handling while <see cref="HasFocus"/> is true.
        /// </summary>
        public event Action EscapePressed;

        /// <summary>
        /// The document replaced the root the region had bound (the argument is the new root). Views built on the old root
        /// write into a detached tree: the host recreates its view on the new root here (<c>new &lt;Screen&gt;View(root)</c>,
        /// then binds its data and events again). Logged once as a warning when nobody listens.
        /// </summary>
        public event Action<VisualElement> RootRebuilt;

        /// <summary>Raised when the focus moves from outside the screen (or from nothing) to an element of the screen.</summary>
        public event Action FocusEntered;

        /// <summary>Raised when the focus moves from an element of the screen to outside it, or to nothing.</summary>
        public event Action FocusLeft;

        /// <summary>Whether an element of the screen has the panel's focus.</summary>
        public bool HasFocus => m_Root?.panel?.focusController?.focusedElement is VisualElement f && Inside(f);

#if UNITY_EDITOR
        /// <summary>Set by the Editor assembly: fills a newly added region from the project's profile and font set.</summary>
        internal static Action<DesignUiPanelRegion> EditorDefaults;

        void Reset() => EditorDefaults?.Invoke(this);

        void OnValidate()
        {
            if (m_TextSizeSource != null && !(m_TextSizeSource is IDesignTextSizeSource))
            {
                Debug.LogWarning(m_TextSizeSource.GetType().Name + " does not implement IDesignTextSizeSource; the region's Text Size Source is cleared.", this);
                m_TextSizeSource = null;
            }
        }
#endif

        void OnEnable() => Attach();
        void OnDisable() => Detach();
        void LateUpdate() => Refresh();
        void OnTransformParentChanged() => m_Canvas = null;
        void OnCanvasHierarchyChanged() => m_Canvas = null;

        /// <summary>Applies the settings and the font set, starts following the frame. Called on enable.</summary>
        internal void Attach()
        {
            if (m_IsAttached) return;
            var doc = Document;
            if (doc == null) return;
            m_IsAttached = true;
            m_Attached = doc;
            if (m_Fonts != null) DesignText.Fonts = m_Fonts;
            else if (!m_WarnedNoFonts)
            {
                m_WarnedNoFonts = true;
                Debug.LogWarning("DesignUiPanelRegion '" + name + "' has no DesignFontSet: bound text is prepared only in its resolved font, so its first layout " +
                                 "may be unkerned. Assign the generated DesignFonts.asset (the region's Reset fills it in once the asset exists).", this);
            }
            var settings = m_Settings ?? new DesignUiHostSettings();
            var source = doc.panelSettings;
            if (source != null && !Mathf.Approximately(source.sortingOrder, settings.sortingOrder))
            {
                m_Source = source;
                m_Copy = SortedPanelSettings.Acquire(source, settings.sortingOrder);
                doc.panelSettings = m_Copy;
            }
            m_PreviousDocumentOrder = doc.sortingOrder;
            doc.sortingOrder = settings.documentOrder;
            Canvas.willRenderCanvases += Refresh;
            Refresh();
        }

        /// <summary>Stops following the frame and gives the document its own PanelSettings back. Called on disable.</summary>
        internal void Detach()
        {
            if (!m_IsAttached) return;
            m_IsAttached = false;
            Canvas.willRenderCanvases -= Refresh;
            Bind(null);
            (m_OwnedLocaleSource as IDisposable)?.Dispose();
            m_OwnedLocaleSource = null;
            if (m_Attached != null) m_Attached.sortingOrder = m_PreviousDocumentOrder;
            if (m_Copy != null || m_Source != null)
            {
                if (m_Attached != null && m_Attached.panelSettings == m_Copy) m_Attached.panelSettings = m_Source;
                SortedPanelSettings.Release(m_Copy);
            }
            m_Copy = null;
            m_Source = null;
            m_Attached = null;
        }

        /// <summary>
        /// Places the document's root on this RectTransform's screen rect now (the region does it every frame after the
        /// shell's layout). A change from outside, such as UIDocument re-creating its root, is written again.
        /// </summary>
        public void Refresh()
        {
            if (!m_IsAttached || m_Attached == null) return;
            var root = m_Attached.rootVisualElement;
            if (root != m_Root)
            {
                var rebuilt = m_Root != null && root != null;
                Bind(root);
                if (rebuilt) OnRootRebuilt(root);
            }
            var panel = root?.panel;
            if (panel == null) return;
            var screen = ScreenRect();
            var height = ScreenHeight(m_Attached.panelSettings);
            var min = RuntimePanelUtils.ScreenToPanel(panel, new Vector2(screen.xMin, height - screen.yMax));
            var max = RuntimePanelUtils.ScreenToPanel(panel, new Vector2(screen.xMax, height - screen.yMin));
            var rect = Rect.MinMaxRect(min.x, min.y, max.x, max.y);
            PanelRect = rect;
            var style = root.style;
            if (style.position != Position.Absolute) style.position = Position.Absolute;
            // written only when different, so a frame without change dirties no layout
            if (!Is(style.left, rect.x)) style.left = rect.x;
            if (!Is(style.top, rect.y)) style.top = rect.y;
            if (!Is(style.width, rect.width)) style.width = rect.width;
            if (!Is(style.height, rect.height)) style.height = rect.height;
        }

        static bool Is(StyleLength current, float px) =>
            current.keyword == StyleKeyword.Undefined && current.value.unit == LengthUnit.Pixel && current.value.value == px;

        /// <summary>
        /// Whether the pointer at <paramref name="screenPosition"/> (pixels, origin bottom-left, as the Input System's
        /// <c>Pointer.position</c> and uGUI's <c>PointerEventData.position</c> report it) is over an element of the screen
        /// that takes the pointer (picking mode Position): the place where a host that routes input itself blocks its uGUI
        /// raycasts. Elements of other documents on the same panel do not count.
        /// </summary>
        public bool IsPointerOverPanel(Vector2 screenPosition)
        {
            var doc = m_IsAttached ? m_Attached : Document;
            var root = doc != null ? doc.rootVisualElement : null;
            var panel = root?.panel;
            if (panel == null) return false;
            var p = RuntimePanelUtils.ScreenToPanel(panel, new Vector2(screenPosition.x, ScreenHeight(doc.panelSettings) - screenPosition.y));
            var picked = panel.Pick(p);
            return picked != null && (picked == root || root.Contains(picked));
        }

        /// <summary>Focuses the screen's first focusable element (tree order); false when it has none.</summary>
        public bool FocusFirst()
        {
            var root = m_Root ?? Document?.rootVisualElement;
            var first = root != null ? FirstFocusable(root) : null;
            if (first == null) return false;
            first.Focus();
            return true;
        }

        static Focusable FirstFocusable(VisualElement e)
        {
            if (e.canGrabFocus && e.tabIndex >= 0) return e;
            if (e.resolvedStyle.display == DisplayStyle.None) return null;
            var children = e.hierarchy;
            for (int i = 0; i < children.childCount; i++)
            {
                var found = FirstFocusable(children[i]);
                if (found != null) return found;
            }
            return null;
        }

        void OnRootRebuilt(VisualElement root)
        {
            if (RootRebuilt != null)
            {
                RootRebuilt(root);
                return;
            }
            if (m_WarnedRebuilt) return;
            m_WarnedRebuilt = true;
            Debug.LogWarning("DesignUiPanelRegion '" + name + "': the UIDocument re-created its root (its PanelSettings or tree changed, for example when Enable Advanced " +
                             "Text is switched in the Editor during Play; a player never changes it while running). A view built on the old root no longer shows: " +
                             "recreate the view on the new root in a RootRebuilt handler (region.RootRebuilt += root => view = new <Screen>View(root), then bind its " +
                             "data and events again).", this);
        }

        void Bind(VisualElement root)
        {
            m_LocaleFonts?.Dispose();
            m_LocaleFonts = null;
            if (m_Root != null)
            {
                m_Root.UnregisterCallback<NavigationCancelEvent>(OnCancel);
                m_Root.UnregisterCallback<FocusInEvent>(OnFocusIn);
                m_Root.UnregisterCallback<FocusOutEvent>(OnFocusOut);
            }
            m_Root = root;
            if (m_Root != null)
            {
                m_Root.RegisterCallback<NavigationCancelEvent>(OnCancel);
                m_Root.RegisterCallback<FocusInEvent>(OnFocusIn);
                m_Root.RegisterCallback<FocusOutEvent>(OnFocusOut);
                m_LocaleFonts = CreateLocaleFonts(m_Root);
            }
        }

        /// <summary>
        /// The screen root's locale and text-size controller: the game's locale source, else the default one (owned by
        /// the region until it detaches); none when there is neither a locale source nor a text size.
        /// </summary>
        LocaleFontController CreateLocaleFonts(VisualElement root)
        {
            var locales = m_LocaleSource;
            if (locales == null)
            {
                if (m_OwnedLocaleSource == null) m_OwnedLocaleSource = DesignLocaleSources.Default?.Invoke();
                locales = m_OwnedLocaleSource;
            }
            var sizes = TextSizes;
            if (locales == null && sizes == null) return null;
            return new LocaleFontController(root, m_Fonts, m_LocaleRules, locales, sizes, m_ViewportScales);
        }

        /// <summary>A new locale source or text size while attached: a new controller for the root.</summary>
        void Restart()
        {
            if (!m_IsAttached || m_Root == null) return;
            m_LocaleFonts?.Dispose();
            m_LocaleFonts = CreateLocaleFonts(m_Root);
        }

        void OnCancel(NavigationCancelEvent e) => EscapePressed?.Invoke();

        // FocusIn: relatedTarget is the element losing focus; FocusOut: the element gaining it
        void OnFocusIn(FocusInEvent e)
        {
            if (!Inside(e.relatedTarget as VisualElement)) FocusEntered?.Invoke();
        }

        void OnFocusOut(FocusOutEvent e)
        {
            if (!Inside(e.relatedTarget as VisualElement)) FocusLeft?.Invoke();
        }

        bool Inside(VisualElement e) => e != null && m_Root != null && (e == m_Root || m_Root.Contains(e));

        UIDocument FindDocument()
        {
            var doc = GetComponent<UIDocument>();
            return doc != null ? doc : GetComponentInChildren<UIDocument>(true);
        }

        /// <summary>
        /// This RectTransform's rect in screen pixels (origin bottom-left) through its root canvas's camera: none for Screen
        /// Space - Overlay, the canvas camera otherwise. A World Space canvas is not supported (the panel cannot follow a
        /// perspective, and without a camera its world coordinates would be read as pixels).
        /// </summary>
        Rect ScreenRect()
        {
            if (m_Canvas == null) m_Canvas = GetComponentInParent<Canvas>();
            Camera cam = null;
            if (m_Canvas != null)
            {
                var rootCanvas = m_Canvas.rootCanvas;
                if (rootCanvas.renderMode != RenderMode.ScreenSpaceOverlay) cam = rootCanvas.worldCamera;
            }
            ((RectTransform)transform).GetWorldCorners(s_Corners);
            float xMin = float.MaxValue, yMin = float.MaxValue, xMax = float.MinValue, yMax = float.MinValue;
            for (int i = 0; i < 4; i++)
            {
                var p = RectTransformUtility.WorldToScreenPoint(cam, s_Corners[i]);
                xMin = Mathf.Min(xMin, p.x); xMax = Mathf.Max(xMax, p.x);
                yMin = Mathf.Min(yMin, p.y); yMax = Mathf.Max(yMax, p.y);
            }
            return Rect.MinMaxRect(xMin, yMin, xMax, yMax);
        }

        /// <summary>
        /// The height of what the panel draws into, in pixels: its target texture, else its display (the main display's
        /// <see cref="Screen.height"/>, a secondary display's system height, as uGUI's PanelRaycaster does).
        /// </summary>
        static float ScreenHeight(PanelSettings settings)
        {
            if (settings != null && settings.targetTexture != null) return settings.targetTexture.height;
            int display = settings != null ? settings.targetDisplay : 0;
            if (display > 0 && display < Display.displays.Length) return Display.displays[display].systemHeight;
            return Screen.height;
        }

        /// <summary>
        /// Runtime copies of PanelSettings assets with another sort order, shared by the regions that ask for the same
        /// source and order (one panel each, not one per region) and destroyed with their last user.
        /// </summary>
        static class SortedPanelSettings
        {
            sealed class Entry
            {
                public PanelSettings Source, Copy;
                public float Order;
                public int Users;
            }

            static readonly List<Entry> s_Entries = new List<Entry>();

            public static PanelSettings Acquire(PanelSettings source, float order)
            {
                s_Entries.RemoveAll(x => x.Copy == null); // a copy whose source is gone stays until its users release it
                foreach (var x in s_Entries)
                    if (x.Source == source && x.Order == order)
                    {
                        x.Users++;
                        return x.Copy;
                    }
                var copy = Object.Instantiate(source);
                copy.name = source.name + " (sort order " + order.ToString(System.Globalization.CultureInfo.InvariantCulture) + ")";
                copy.hideFlags = HideFlags.DontSave;
                copy.sortingOrder = order;
                s_Entries.Add(new Entry { Source = source, Copy = copy, Order = order, Users = 1 });
                return copy;
            }

            public static void Release(PanelSettings copy)
            {
                for (int i = 0; i < s_Entries.Count; i++)
                {
                    var x = s_Entries[i];
                    if (x.Copy != copy) continue;
                    if (--x.Users > 0) return;
                    s_Entries.RemoveAt(i);
                    if (x.Copy == null) return;
                    if (Application.isPlaying) Object.Destroy(x.Copy);
                    else Object.DestroyImmediate(x.Copy);
                    return;
                }
            }
        }
    }
}
