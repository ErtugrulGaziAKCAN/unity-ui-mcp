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
    /// It reaches internals of UI Toolkit (the sorted panel list, the walk, one panel's draw and, in a rare case, the walk's
    /// position) and the three hooks by reflection, bound once to typed delegates: a frame allocates nothing. It follows the
    /// walk's position itself (each step of UI Toolkit's walk is decided by the sorted list alone). When a member is missing
    /// (another Unity version), <see cref="DesignUiGammaComposite"/> composites at the end of the frame instead, over
    /// everything, and says so once; a composited panel the overlay pass did not draw in a frame is composited at its end too.
    /// </para>
    /// </summary>
    internal static class DesignUiOverlayOrder
    {
        static readonly System.Collections.Generic.List<DesignUiGammaComposite> s_Sources = new System.Collections.Generic.List<DesignUiGammaComposite>();

        // ---- UI Toolkit's side (UnityEngine.UIElementsModule, internal) --------------------------------------------------
        const BindingFlags Static = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        const BindingFlags Instance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        static readonly Type s_Utility = typeof(PanelSettings).Assembly.GetType("UnityEngine.UIElements.UIElementsRuntimeUtility");
        static readonly Type s_BasePanel = typeof(PanelSettings).Assembly.GetType("UnityEngine.UIElements.BaseRuntimePanel");
        static readonly Type s_RuntimePanel = typeof(PanelSettings).Assembly.GetType("UnityEngine.UIElements.RuntimePanel");
        static readonly FieldInfo s_Cursor = s_Utility?.GetField("currentOverlayIndex", Static);
        static readonly FieldInfo s_Target = s_BasePanel?.GetField("targetTexture", Instance);
        static readonly Func<IList> s_Sorted = Bind<Func<IList>>(s_Utility?.GetMethod("GetSortedScreenOverlayPlayerPanels", Static, null, Type.EmptyTypes, null));
        static readonly Action<int, float> s_RenderBefore = Bind<Action<int, float>>(s_Utility?.GetMethod("RenderOverlaysBeforePriority", Static, null, new[] { typeof(int), typeof(float) }, null));
        static readonly Action<object, bool> s_RenderPanel = Static1(s_BasePanel, s_BasePanel == null ? null : s_Utility?.GetMethod("RenderPanel", Static, null, new[] { s_BasePanel, typeof(bool) }, null));
        static readonly Func<object, float> s_Priority = Getter<float>(s_BasePanel, "sortingPriority");
        static readonly Func<object, int> s_Display = Getter<int>(s_BasePanel, "targetDisplay");
        static readonly Func<object, PanelSettings> s_Settings = Getter<PanelSettings>(s_RuntimePanel, "panelSettings");
        static readonly Func<object, bool> s_Transient = Getter<bool>(typeof(PanelSettings), "isTransient");

        // ---- uGUI's side (UnityEngine.UIModule, internal) ----------------------------------------------------------------
        static readonly Hook<Action<int>> s_BeginHook = new Hook<Action<int>>("externBeginRenderOverlays");
        static readonly Hook<Action<int, int>> s_BeforeHook = new Hook<Action<int, int>>("externRenderOverlaysBefore");
        static readonly Hook<Action<int>> s_EndHook = new Hook<Action<int>>("externEndRenderOverlays");

        static readonly Action<int> s_OurBegin = Begin, s_OurEnd = End;
        static readonly Action<int, int> s_OurBefore = Before;
        static Action<int> s_Begin, s_End;
        static Action<int, int> s_Before;
        static bool s_UtilityReady;

        /// <summary>
        /// Where UI Toolkit's walk stands in the sorted list (its <c>currentOverlayIndex</c>, followed here): 0 after Begin,
        /// -1 outside an overlay pass.
        /// </summary>
        static int s_Walk = -1;

        /// <summary>One of Canvas's static hook properties, read and written through typed delegates.</summary>
        sealed class Hook<T> where T : Delegate
        {
            public readonly Func<T> Get;
            public readonly Action<T> Set;

            public Hook(string name)
            {
                var p = typeof(Canvas).GetProperty(name, Static);
                if (p == null || p.PropertyType != typeof(T)) return;
                Get = Bind<Func<T>>(p.GetGetMethod(true));
                Set = Bind<Action<T>>(p.GetSetMethod(true));
            }

            public bool Ok => Get != null && Set != null;
        }

        static D Bind<D>(MethodInfo m) where D : Delegate
        {
            if (m == null) return null;
            try { return (D)Delegate.CreateDelegate(typeof(D), m, false); } catch (ArgumentException) { return null; }
        }

        /// <summary>A typed getter of an internal type's property, taking the instance as object (no boxing of the instance or the value).</summary>
        static Func<object, R> Getter<R>(Type owner, string property)
        {
            var p = owner?.GetProperty(property, Instance);
            if (p == null || p.PropertyType != typeof(R) || p.GetGetMethod(true) == null) return null;
            try
            {
                var make = typeof(DesignUiOverlayOrder).GetMethod(nameof(MakeGetter), Static).MakeGenericMethod(owner, typeof(R));
                return (Func<object, R>)make.Invoke(null, new object[] { p.GetGetMethod(true) });
            }
            catch (Exception) { return null; }
        }

        static Func<object, R> MakeGetter<T, R>(MethodInfo getter) where T : class
        {
            var f = (Func<T, R>)Delegate.CreateDelegate(typeof(Func<T, R>), getter);
            return o => o is T t ? f(t) : default;
        }

        static Action<object, bool> Static1(Type arg, MethodInfo m)
        {
            if (arg == null || m == null) return null;
            try
            {
                var make = typeof(DesignUiOverlayOrder).GetMethod(nameof(MakeStatic1), Static).MakeGenericMethod(arg);
                return (Action<object, bool>)make.Invoke(null, new object[] { m });
            }
            catch (Exception) { return null; }
        }

        static Action<object, bool> MakeStatic1<T>(MethodInfo m) where T : class
        {
            var f = (Action<T, bool>)Delegate.CreateDelegate(typeof(Action<T, bool>), m);
            return (o, b) => { if (o is T t) f(t, b); };
        }

        /// <summary>Never called: keeps the generic instances the typed delegates use in an IL2CPP player (its shared code).</summary>
        static void AotHints()
        {
            MakeGetter<object, float>(null);
            MakeGetter<object, int>(null);
            MakeGetter<object, bool>(null);
            MakeGetter<object, PanelSettings>(null);
            MakeStatic1<object>(null);
        }

        /// <summary>Whether this Unity version has every member the ordered drawing needs.</summary>
        internal static bool Supported =>
            s_Sorted != null && s_Cursor != null && s_Cursor.FieldType == typeof(int) && s_RenderBefore != null && s_RenderPanel != null &&
            s_Priority != null && s_Display != null && s_Target != null && s_Settings != null && s_Transient != null &&
            s_BeginHook.Ok && s_BeforeHook.Ok && s_EndHook.Ok;

        /// <summary>Whether all three hooks are ours (the outermost wrappers).</summary>
        internal static bool Installed =>
            Supported && s_BeginHook.Get() == s_OurBegin && s_BeforeHook.Get() == s_OurBefore && s_EndHook.Get() == s_OurEnd;

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
        /// Called every frame by the composites: allocates nothing.
        /// </summary>
        internal static bool Install()
        {
            if (!Supported) return false;
            if (!s_UtilityReady)
            {
                // UI Toolkit sets its hooks in its utility's static constructor: run it first, or it would replace ours later
                System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(s_Utility.TypeHandle);
                s_UtilityReady = true;
            }
            Wrap(s_BeginHook, s_OurBegin, ref s_Begin);
            Wrap(s_BeforeHook, s_OurBefore, ref s_Before);
            Wrap(s_EndHook, s_OurEnd, ref s_End);
            return s_Begin != null && s_Before != null && s_End != null;
        }

        static void Wrap<T>(Hook<T> hook, T ours, ref T inner) where T : Delegate
        {
            var current = hook.Get();
            if (current == null || current == ours) return;
            if (inner != null && current.Method.DeclaringType?.Assembly != s_Utility.Assembly) return;
            inner = current;
            hook.Set(ours);
        }

        static void Uninstall()
        {
            if (!Supported) return;
            Unwrap(s_BeginHook, s_OurBegin, ref s_Begin);
            Unwrap(s_BeforeHook, s_OurBefore, ref s_Before);
            Unwrap(s_EndHook, s_OurEnd, ref s_End);
        }

        /// <summary>Gives a hook back when ours is still the outermost; inside another wrapper ours stays and passes through.</summary>
        static void Unwrap<T>(Hook<T> hook, T ours, ref T inner) where T : Delegate
        {
            if (inner == null || hook.Get() != ours) return;
            hook.Set(inner);
            inner = null;
        }

        static void Begin(int display)
        {
            s_Begin?.Invoke(display);
            s_Walk = 0; // UI Toolkit's Begin starts its walk at the first panel
        }

        static void Before(int display, int sortOrder)
        {
            if (s_Sources.Count > 0) Walk(display, sortOrder);
            s_Before?.Invoke(display, sortOrder);
            if (s_Walk >= 0) Advance(sortOrder);
        }

        static void End(int display)
        {
            if (s_Sources.Count > 0) Walk(display, float.MaxValue);
            s_End?.Invoke(display);
            s_Walk = -1;
        }

        /// <summary>Follows UI Toolkit's walk up to <paramref name="max"/>: it passes every panel whose sort order is below it.</summary>
        static void Advance(float max)
        {
            var list = s_Sorted();
            while (s_Walk < list.Count && s_Priority(list[s_Walk]) < max) s_Walk++;
        }

        /// <summary>
        /// UI Toolkit's walk up to (not including) <paramref name="max"/>, with the composited panels drawn where it passes
        /// them: the panels before a composited one are drawn by UI Toolkit (its own walk up to the composited panel's sort
        /// order, then those of the same sort order made before it), the composited one by its composite (UI Toolkit's walk
        /// passes over it later: it renders into a texture).
        /// </summary>
        static void Walk(int display, float max)
        {
            if (s_Walk < 0) return; // not inside an overlay pass
            var list = s_Sorted();
            while (s_Walk < list.Count)
            {
                var panel = list[s_Walk];
                if (!(s_Priority(panel) < max)) return;
                var source = Composited(panel, display);
                if (source != null)
                {
                    source.DrawInPass(s_Settings(panel));
                    s_Walk++;
                    continue;
                }
                int next = NextComposited(list, s_Walk, display, max);
                if (next < 0) return; // the rest is UI Toolkit's own: the hook it wraps draws it
                float priority = s_Priority(list[next]);
                s_RenderBefore(display, priority);
                Advance(priority);
                if (s_Walk < next)
                {
                    // panels of the composited panel's sort order made before it: drawn first, one by one, as UI Toolkit
                    // would, and its walk moved past them (rare: the only place the walk's position is written)
                    for (; s_Walk < next; s_Walk++) RenderOne(list[s_Walk], display);
                    s_Cursor.SetValue(null, next);
                }
            }
        }

        static int NextComposited(IList list, int from, int display, float max)
        {
            for (int i = from; i < list.Count; i++)
            {
                if (!(s_Priority(list[i]) < max)) return -1;
                if (Composited(list[i], display) != null) return i;
            }
            return -1;
        }

        /// <summary>UI Toolkit's own step for one panel: a transient panel is skipped, an on-screen panel of the display drawn.</summary>
        static void RenderOne(object panel, int display)
        {
            var settings = s_Settings(panel);
            if (settings != null && s_Transient(settings)) return;
            if (s_Display(panel) != display || s_Target.GetValue(panel) as RenderTexture != null) return;
            s_RenderPanel(panel, true);
        }

        /// <summary>The composite that renders <paramref name="panel"/> into a texture, when the panel is on <paramref name="display"/>.</summary>
        static DesignUiGammaComposite Composited(object panel, int display)
        {
            var settings = s_Settings(panel);
            if (settings == null || s_Display(panel) != display) return null;
            foreach (var c in s_Sources)
                if (c != null && c.TargetOf(settings) != null) return c;
            return null;
        }
    }
}
