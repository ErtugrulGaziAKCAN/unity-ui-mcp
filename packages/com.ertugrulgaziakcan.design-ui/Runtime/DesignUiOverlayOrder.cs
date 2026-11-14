using System;
using System.Collections;
using System.Reflection;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// Draws the panels a <see cref="DesignUiGammaComposite"/> renders into textures at the place UI Toolkit would draw them on
    /// screen, among Screen Space - Overlay canvases and other runtime panels, so drawing and input agree.
    /// <para>
    /// How Unity 6000.3 orders them (measured, docs/findings/composite-order.md): while it draws the overlay canvases of a
    /// display in sort order, it calls <c>Canvas.externBeginRenderOverlays(display)</c> first, then
    /// <c>Canvas.externRenderOverlaysBefore(display, canvas.sortingOrder)</c> before each canvas, and
    /// <c>Canvas.externEndRenderOverlays(display)</c> last. UI Toolkit answers each call by walking its screen panels in
    /// sort order (<c>sortingOrder</c>, then the order the panels were made in) from where the last call stopped, drawing
    /// each one whose sort order is below the canvas's: a panel draws over every canvas of a lower or the same sort order and
    /// under every canvas of a higher one. A panel that renders into a texture is skipped by that walk; this class wraps the
    /// three calls and draws the texture of a composited panel when the walk reaches it, through the composite's pass.
    /// </para>
    /// <para>
    /// It reaches internals of UI Toolkit (the sorted panel list, the walk's position, the walk and one panel's draw) and
    /// the three hooks by reflection. When one of them is missing (another Unity version),
    /// <see cref="DesignUiGammaComposite"/> composites at the end of the frame instead, over everything, and says so once;
    /// a frame whose overlay pass did not reach these wrappers is composited at its end too.
    /// </para>
    /// </summary>
    internal static class DesignUiOverlayOrder
    {
        static readonly System.Collections.Generic.List<DesignUiGammaComposite> s_Sources = new System.Collections.Generic.List<DesignUiGammaComposite>();

        // ---- UI Toolkit's side (UnityEngine.UIElementsModule, internal) --------------------------------------------------
        static readonly Type s_Utility = typeof(PanelSettings).Assembly.GetType("UnityEngine.UIElements.UIElementsRuntimeUtility");
        static readonly Type s_BasePanel = typeof(PanelSettings).Assembly.GetType("UnityEngine.UIElements.BaseRuntimePanel");
        static readonly Type s_RuntimePanel = typeof(PanelSettings).Assembly.GetType("UnityEngine.UIElements.RuntimePanel");
        const BindingFlags Static = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        const BindingFlags Instance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        static readonly MethodInfo s_Sorted = s_Utility?.GetMethod("GetSortedScreenOverlayPlayerPanels", Static, null, Type.EmptyTypes, null);
        static readonly FieldInfo s_Cursor = s_Utility?.GetField("currentOverlayIndex", Static);
        static readonly MethodInfo s_RenderBefore = s_Utility?.GetMethod("RenderOverlaysBeforePriority", Static, null, new[] { typeof(int), typeof(float) }, null);
        static readonly MethodInfo s_RenderPanel = s_BasePanel == null ? null : s_Utility?.GetMethod("RenderPanel", Static, null, new[] { s_BasePanel, typeof(bool) }, null);
        static readonly PropertyInfo s_Priority = s_BasePanel?.GetProperty("sortingPriority", Instance);
        static readonly PropertyInfo s_Display = s_BasePanel?.GetProperty("targetDisplay", Instance);
        static readonly FieldInfo s_Target = s_BasePanel?.GetField("targetTexture", Instance);
        static readonly PropertyInfo s_Settings = s_RuntimePanel?.GetProperty("panelSettings", Instance);
        static readonly PropertyInfo s_Transient = typeof(PanelSettings).GetProperty("isTransient", Instance);

        // ---- uGUI's side (UnityEngine.UIModule, internal) ----------------------------------------------------------------
        static readonly PropertyInfo s_BeginHook = typeof(Canvas).GetProperty("externBeginRenderOverlays", Static);
        static readonly PropertyInfo s_BeforeHook = typeof(Canvas).GetProperty("externRenderOverlaysBefore", Static);
        static readonly PropertyInfo s_EndHook = typeof(Canvas).GetProperty("externEndRenderOverlays", Static);

        static readonly Action<int> s_OurBegin = Begin, s_OurEnd = End;
        static readonly Action<int, int> s_OurBefore = Before;
        static Action<int> s_Begin, s_End;
        static Action<int, int> s_Before;
        static readonly object[] s_Args2 = new object[2], s_PanelArgs = new object[2];

        /// <summary>Whether this Unity version has every member the ordered drawing needs.</summary>
        internal static bool Supported =>
            s_Sorted != null && s_Cursor != null && s_Cursor.FieldType == typeof(int) && s_RenderBefore != null && s_RenderPanel != null &&
            s_Priority != null && s_Priority.PropertyType == typeof(float) && s_Display != null && s_Display.PropertyType == typeof(int) &&
            s_Target != null && s_Settings != null && s_Transient?.PropertyType == typeof(bool) && s_BeginHook?.PropertyType == typeof(Action<int>) &&
            s_BeforeHook?.PropertyType == typeof(Action<int, int>) && s_EndHook?.PropertyType == typeof(Action<int>);

        /// <summary>Whether all three hooks are ours (the outermost wrappers).</summary>
        internal static bool Installed =>
            s_BeginHook != null && (Action<int>)s_BeginHook.GetValue(null) == s_OurBegin &&
            (Action<int, int>)s_BeforeHook.GetValue(null) == s_OurBefore && (Action<int>)s_EndHook.GetValue(null) == s_OurEnd;

        /// <summary>
        /// The frame of the last overlay pass that reached these wrappers (any display): a composite whose panels were not
        /// drawn in one (no overlay pass, or the hooks were replaced) composites at the end of the frame instead.
        /// </summary>
        internal static int LastPassFrame { get; private set; } = -1;

        /// <summary>Starts drawing <paramref name="source"/>'s textures in the overlay passes; false when this Unity version cannot.</summary>
        internal static bool Add(DesignUiGammaComposite source)
        {
            if (!s_Sources.Contains(source)) s_Sources.Add(source);
            return Install();
        }

        internal static void Remove(DesignUiGammaComposite source)
        {
            s_Sources.Remove(source);
            if (s_Sources.Count == 0) Uninstall();
        }

        /// <summary>
        /// Puts the wrappers in place: around whatever each hook holds the first time, and again only around UI Toolkit's
        /// own hook (it sets its hooks when it starts). A hook that holds another wrapper (code that wrapped ours) is left
        /// alone: ours is inside it, and wrapping it again would call itself. False when this Unity version lacks a member.
        /// </summary>
        internal static bool Install()
        {
            if (!Supported) return false;
            // UI Toolkit sets its hooks in its utility's static constructor: run it first, or it would replace ours later
            System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(s_Utility.TypeHandle);
            Wrap(s_BeginHook, s_OurBegin, ref s_Begin);
            Wrap(s_BeforeHook, s_OurBefore, ref s_Before);
            Wrap(s_EndHook, s_OurEnd, ref s_End);
            return s_Begin != null && s_Before != null && s_End != null;
        }

        static void Wrap<T>(PropertyInfo hook, T ours, ref T inner) where T : Delegate
        {
            var current = (T)hook.GetValue(null);
            if (current == null || current == ours) return;
            if (inner != null && current.Method.DeclaringType?.Assembly != s_Utility.Assembly) return;
            inner = current;
            hook.SetValue(null, ours);
        }

        static void Uninstall()
        {
            Unwrap(s_BeginHook, s_OurBegin, ref s_Begin);
            Unwrap(s_BeforeHook, s_OurBefore, ref s_Before);
            Unwrap(s_EndHook, s_OurEnd, ref s_End);
        }

        /// <summary>Gives a hook back when ours is still the outermost; inside another wrapper ours stays and passes through.</summary>
        static void Unwrap<T>(PropertyInfo hook, T ours, ref T inner) where T : Delegate
        {
            if (hook == null || inner == null || (T)hook.GetValue(null) != ours) return;
            hook.SetValue(null, inner);
            inner = null;
        }

        static void Begin(int display)
        {
            LastPassFrame = Time.frameCount;
            s_Begin?.Invoke(display);
        }

        static void Before(int display, int sortOrder)
        {
            if (s_Sources.Count > 0) Walk(display, sortOrder);
            s_Before?.Invoke(display, sortOrder);
        }

        static void End(int display)
        {
            if (s_Sources.Count > 0) Walk(display, float.MaxValue);
            s_End?.Invoke(display);
        }

        /// <summary>
        /// UI Toolkit's walk up to (not including) <paramref name="max"/>, with the composited panels drawn where it passes
        /// them: the panels before a composited one are drawn by UI Toolkit (its own walk up to the composited panel's sort
        /// order, then those of the same sort order made before it), the composited one by its composite.
        /// </summary>
        static void Walk(int display, float max)
        {
            if (!(s_Sorted.Invoke(null, null) is IList list)) return;
            int cursor = (int)s_Cursor.GetValue(null);
            if (cursor < 0) return; // not inside an overlay pass
            while (cursor < list.Count)
            {
                var panel = list[cursor];
                float priority = Priority(panel);
                if (!(priority < max)) return;
                if (Composited(panel, display) is DesignUiGammaComposite source)
                {
                    source.DrawInPass(SettingsOf(panel));
                    s_Cursor.SetValue(null, ++cursor);
                    continue;
                }
                int next = NextComposited(list, cursor, display, max);
                if (next < 0) return; // the rest is UI Toolkit's own: the hook it wraps draws it
                s_Args2[0] = display;
                s_Args2[1] = Priority(list[next]);
                s_RenderBefore.Invoke(null, s_Args2);
                cursor = (int)s_Cursor.GetValue(null);
                // panels of the composited panel's sort order made before it: drawn first, one by one, as UI Toolkit would
                for (; cursor >= 0 && cursor < next; s_Cursor.SetValue(null, ++cursor)) RenderOne(list[cursor], display);
                if (cursor < 0) return;
            }
        }

        static int NextComposited(IList list, int from, int display, float max)
        {
            for (int i = from; i < list.Count; i++)
            {
                if (!(Priority(list[i]) < max)) return -1;
                if (Composited(list[i], display) != null) return i;
            }
            return -1;
        }

        /// <summary>UI Toolkit's own step for one panel: a transient panel is skipped, an on-screen panel of the display drawn.</summary>
        static void RenderOne(object panel, int display)
        {
            var settings = SettingsOf(panel);
            if (settings != null && (bool)s_Transient.GetValue(settings)) return;
            if ((int)s_Display.GetValue(panel) != display || s_Target.GetValue(panel) as RenderTexture != null) return;
            s_PanelArgs[0] = panel;
            s_PanelArgs[1] = true;
            s_RenderPanel.Invoke(null, s_PanelArgs);
        }

        static float Priority(object panel) => (float)s_Priority.GetValue(panel);

        static PanelSettings SettingsOf(object panel) => s_RuntimePanel.IsInstanceOfType(panel) ? s_Settings.GetValue(panel) as PanelSettings : null;

        /// <summary>The composite that renders <paramref name="panel"/> into a texture, when the panel is on <paramref name="display"/>.</summary>
        static DesignUiGammaComposite Composited(object panel, int display)
        {
            var settings = SettingsOf(panel);
            if (settings == null || (int)s_Display.GetValue(panel) != display) return null;
            foreach (var c in s_Sources)
                if (c != null && c.TargetOf(settings) != null) return c;
            return null;
        }
    }
}
