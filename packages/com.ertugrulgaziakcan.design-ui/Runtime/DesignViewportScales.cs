using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// The panel scales of the profile's exact viewports (kit.config.json <c>viewports</c>; with the 2560×1440 reference 1.5,
    /// 1, 0.75 and 0.5), as the compiler writes them on a screen root (the UXML attribute <c>exact-scales</c> of
    /// <see cref="DesignScreen"/>), and the scale a screen lays out at. UI Toolkit puts font sizes, paddings, margins and
    /// border widths on whole device pixels before layout and ceils text sizes, so a design only lays out as designed where
    /// its lengths are whole device pixels: at an exact viewport's scale. At any other panel scale (a scaled viewport such as
    /// 1600×900 at 0.625, or any resolution the profile does not declare) the screen's panel lays out at the nearest exact
    /// scale (<see cref="LayoutScale"/>) and the screen root draws scaled by actual / exact, its top-left corner fixed, so
    /// every edge and every line of text falls where the design puts it at the actual scale
    /// (docs/findings/viewport-classes.md).
    /// </summary>
    public static class DesignViewportScales
    {
        /// <summary>A panel scale within this of a declared one is that scale (float layout of a double the compiler wrote).</summary>
        public const double Tolerance = 1e-4;

        /// <summary>The UXML attribute value: the scales, round-trip formatted, joined by <c>;</c>.</summary>
        public static string Encode(IEnumerable<double> scales)
        {
            var parts = new List<string>();
            foreach (var s in scales ?? new double[0])
                if (s > 0 && !double.IsInfinity(s)) parts.Add(s.ToString("R", CultureInfo.InvariantCulture));
            return string.Join(";", parts);
        }

        /// <summary>Reads an attribute value of <see cref="Encode"/>; a malformed entry is left out.</summary>
        public static double[] Parse(string value)
        {
            var list = new List<double>();
            foreach (var p in (value ?? "").Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
                if (double.TryParse(p, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && d > 0 && !double.IsInfinity(d)) list.Add(d);
            return list.ToArray();
        }

        /// <summary>The declared scale a panel renders at (the closest within <see cref="Tolerance"/>), or null.</summary>
        public static double? Matching(IReadOnlyList<double> scales, double panelScale)
        {
            double? best = null;
            foreach (var s in scales ?? new double[0])
                if (Math.Abs(s - panelScale) <= Tolerance && (best == null || Math.Abs(s - panelScale) < Math.Abs(best.Value - panelScale))) best = s;
            return best;
        }

        /// <summary>Which exact scale a screen lays out at when its panel's scale is none of them.</summary>
        public enum BaseRule
        {
            /// <summary>The exact scale nearest in log scale (the ratio closest to 1).</summary>
            Nearest,
            /// <summary>The next exact scale up (the largest when none is larger).</summary>
            Up,
            /// <summary>The next exact scale down (the smallest when none is smaller).</summary>
            Down,
        }

        /// <summary>The rule <see cref="LayoutScale"/> uses (measured on the fidelity suite: docs/findings/viewport-classes.md).</summary>
        public static BaseRule Rule { get; set; } = BaseRule.Nearest;

        /// <summary>
        /// The scale a screen lays out at when its panel would render at <paramref name="scale"/>: that scale when it is one of
        /// <paramref name="exactScales"/> (within <see cref="Tolerance"/>) or there are none, else the exact scale
        /// <see cref="Rule"/> picks.
        /// </summary>
        public static double LayoutScale(IReadOnlyList<double> exactScales, double scale)
        {
            if (exactScales == null || exactScales.Count == 0 || !(scale > 0) || double.IsInfinity(scale)) return scale;
            var match = Matching(exactScales, scale);
            if (match.HasValue) return match.Value;
            double best = double.NaN, below = double.NaN, above = double.NaN;
            foreach (var s in exactScales)
            {
                if (!(s > 0)) continue;
                if (double.IsNaN(best) || Math.Abs(Math.Log(s / scale)) < Math.Abs(Math.Log(best / scale))) best = s;
                if (s < scale && (double.IsNaN(below) || s > below)) below = s;
                if (s > scale && (double.IsNaN(above) || s < above)) above = s;
            }
            if (double.IsNaN(best)) return scale;
            switch (Rule)
            {
                case BaseRule.Up: return !double.IsNaN(above) ? above : below;
                case BaseRule.Down: return !double.IsNaN(below) ? below : above;
                default: return best;
            }
        }

        /// <summary>
        /// The panel scale (device pixels per panel pixel) <paramref name="settings"/> resolve for a target of
        /// <paramref name="device"/> pixels without their <see cref="PanelSettings.scale"/> factor: UI Toolkit's
        /// <c>PanelSettings.ResolveScale</c> (6000.3) for its three scale modes, inverted.
        /// </summary>
        public static double UnitScale(PanelSettings settings, Vector2 device, float dpi)
        {
            if (settings == null) return 1;
            switch (settings.scaleMode)
            {
                case PanelScaleMode.ConstantPhysicalSize:
                {
                    var d = dpi != 0 ? dpi : settings.fallbackDpi;
                    return d != 0 && settings.referenceDpi != 0 ? d / (double)settings.referenceDpi : 1;
                }
                case PanelScaleMode.ScaleWithScreenSize:
                {
                    var reference = settings.referenceResolution;
                    if (reference.x * reference.y == 0) return 1;
                    // float math, as UI Toolkit resolves it
                    float x = device.x / reference.x, y = device.y / reference.y;
                    float denominator;
                    switch (settings.screenMatchMode)
                    {
                        case PanelScreenMatchMode.Expand: denominator = Mathf.Min(x, y); break;
                        case PanelScreenMatchMode.Shrink: denominator = Mathf.Max(x, y); break;
                        default: denominator = Mathf.Lerp(x, y, Mathf.Clamp01(settings.match)); break;
                    }
                    return denominator != 0 ? denominator : 1;
                }
                default:
                    return 1;
            }
        }
    }

    /// <summary>
    /// The PanelSettings whose panels hold design screens laid out at an exact scale: while a <see cref="DesignScreen"/> with
    /// exact scales is on a runtime panel whose own scale is none of them, the panel's <see cref="PanelSettings.scale"/> factor
    /// is set so the panel resolves the exact scale (<see cref="DesignViewportScales.LayoutScale"/>), and given back when the
    /// last such screen leaves the panel. A factor the game writes meanwhile becomes the settings' own (it is kept and the
    /// exact scale is applied on top). Every screen on the panel scales its root by its actual / exact scale.
    /// <para>In the Editor a held factor never reaches a file: a save of a held PanelSettings asset (an asset save, the
    /// Editor's File > Save, a save after an Inspector edit) writes the settings' own factor and the factor is held again
    /// after it (DesignUi.Editor's save guard, <see cref="GiveBackForSave"/>), an Undo or Redo that brings back a factor
    /// this held puts the right one back (<see cref="AfterUndoRedo"/>), and leaving Play, a script reload and quitting give
    /// every factor back.</para>
    /// </summary>
    internal static class DesignRootScalePanels
    {
        sealed class Entry
        {
            public PanelSettings Settings;
            /// <summary>The settings' own scale factor (the game's), given back when the last screen leaves.</summary>
            public float Own;
            /// <summary>The factor last written here (NaN: none).</summary>
            public float Written = float.NaN;
            /// <summary>Every factor written here (an Undo snapshot or a copy can bring an older one back).</summary>
            public readonly List<float> History = new List<float>();
            public IReadOnlyList<double> ExactScales;
            public readonly List<DesignScreen> Screens = new List<DesignScreen>();
            /// <summary>The factor was given back for a save and is held again after it.</summary>
            public bool Suspended;
            public bool Warned;

            public bool Wrote(float factor) => factor == Written || History.Contains(factor);
        }

        static readonly List<Entry> s_Entries = new List<Entry>();
#if UNITY_EDITOR
        /// <summary>Settings this held and gave back in the Editor session: an Undo snapshot taken while held can bring a factor back.</summary>
        static readonly List<Entry> s_Released = new List<Entry>();
#endif

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics() => RestoreAll();
#if UNITY_EDITOR
        // with domain reload off the entries would outlive Play, and an asset's factor must never stay changed in the Editor
        [UnityEditor.InitializeOnLoadMethod]
        static void RestoreAfterPlay()
        {
            UnityEditor.EditorApplication.playModeStateChanged += s => { if (s == UnityEditor.PlayModeStateChange.ExitingPlayMode) RestoreAll(); };
            UnityEditor.AssemblyReloadEvents.beforeAssemblyReload += RestoreAll;
            UnityEditor.EditorApplication.quitting += RestoreAll;
            UnityEditor.Undo.undoRedoPerformed += AfterUndoRedo;
        }
#endif

        /// <summary>The number of PanelSettings whose factor is held (tests).</summary>
        internal static int Count => s_Entries.Count;

        /// <summary>The factor <paramref name="settings"/> had before a screen held it, or null when none holds it (tests).</summary>
        internal static float? OwnScale(PanelSettings settings)
        {
            var e = Find(s_Entries, settings);
            return e != null ? e.Own : (float?)null;
        }

        /// <summary>Whether a screen holds a factor on <paramref name="settings"/> now.</summary>
        internal static bool Holds(PanelSettings settings)
        {
            var e = Find(s_Entries, settings);
            return e != null && !float.IsNaN(e.Written);
        }

        static Entry Find(List<Entry> list, PanelSettings settings)
        {
            for (int i = 0; i < list.Count; i++) if (ReferenceEquals(list[i].Settings, settings)) return list[i];
            return null;
        }

        /// <summary>
        /// Registers <paramref name="screen"/> on <paramref name="settings"/> (its panel's) and writes the factor that makes the
        /// panel resolve the exact scale. <paramref name="actual"/>: the scale the panel resolves without the held factor (the
        /// design's scale on that screen); <paramref name="rootScale"/>: actual / the scale the panel lays out at now. False
        /// (nothing written, root scale 1) when the panel has no size in pixels yet (a world-space panel never has one); a
        /// factor held already stays held then (<see cref="Holds"/>).
        /// </summary>
        internal static bool Evaluate(DesignScreen screen, IPanel panel, PanelSettings settings, IReadOnlyList<double> exactScales,
                                      out double actual, out float rootScale)
        {
            actual = double.NaN;
            rootScale = 1f;
            if (settings == null || panel == null) return false;
            // the screen may have moved to another panel without leaving (it leaves on detach; this keeps one entry per screen)
            for (int i = s_Entries.Count - 1; i >= 0; i--)
                if (i < s_Entries.Count && !ReferenceEquals(s_Entries[i].Settings, settings) && s_Entries[i].Screens.Contains(screen)) Leave(screen, s_Entries[i]);
            var e = Find(s_Entries, settings);
            if (e == null)
            {
                e = new Entry { Settings = settings, Own = settings.scale, ExactScales = exactScales };
#if UNITY_EDITOR
                // held before in this session: an Undo may have brought one of its factors back since
                var before = Find(s_Released, settings);
                if (before != null)
                {
                    s_Released.Remove(before);
                    e.History.AddRange(before.History);
                    if (before.Wrote(settings.scale)) e.Own = before.Own;
                }
#endif
                s_Entries.Add(e);
            }
            if (!e.Screens.Contains(screen)) e.Screens.Add(screen);
            if (!e.Warned && !SameScales(e.ExactScales, exactScales))
            {
                e.Warned = true;
                Debug.LogWarning("Design UI: screens with different exact viewports share the PanelSettings '" + settings.name + "'; they lay out at the scales of the first (" +
                                 DesignViewportScales.Encode(e.ExactScales) + "), not '" + DesignViewportScales.Encode(exactScales) + "'. Compile them with one profile, or give them their own PanelSettings.", settings);
            }
            // a factor this never wrote (the game's, or none written yet) is the settings' own from now on; one this wrote
            // earlier (an Undo snapshot taken while it was held) is not
            if (!e.Wrote(settings.scale))
            {
                e.Own = settings.scale;
                e.Written = float.NaN;
            }
            // the panel's target in device pixels: UI Toolkit sizes its root to target × resolved scale and sets the panel scale to
            // its inverse in the same step (PanelSettings.ApplyPanelSettings), so the product is the target whatever factor applied
            var tree = panel.visualTree;
            float ppp = panel.scaledPixelsPerPoint;
            var w = tree.style.width;
            var h = tree.style.height;
            if (w.keyword != StyleKeyword.Undefined || h.keyword != StyleKeyword.Undefined || !(ppp > 0)) return false;
            var device = new Vector2(w.value.value * ppp, h.value.value * ppp);
            if (!(device.x > 0) || !(device.y > 0)) return false;
            actual = DesignViewportScales.UnitScale(settings, device, Screen.dpi) * e.Own;
            if (!(actual > 0) || double.IsInfinity(actual)) return false;
            var exact = DesignViewportScales.LayoutScale(e.ExactScales ?? exactScales, actual);
            float factor = Math.Abs(exact / actual - 1) <= DesignViewportScales.Tolerance ? e.Own : (float)(e.Own * exact / actual);
            if (factor != e.Own && !e.History.Contains(factor)) e.History.Add(factor);
            if (settings.scale != factor)
            {
                settings.scale = factor;
                e.Written = factor;
                e.Suspended = false;
                // the panel applies its settings when it updates: every frame in Play mode and in players, in Edit mode only
                // when something on it changed after its last update (this runs during one: its style or geometry callbacks)
                RequestUpdate(tree);
            }
            else if (factor != e.Own) e.Written = factor;
            // the panel applies a new factor on its next update; until then the root scales from the scale it lays out at now
            double r = actual / ppp;
            rootScale = Math.Abs(r - 1) <= DesignViewportScales.Tolerance ? 1f : (float)r;
            return true;
        }

        static bool SameScales(IReadOnlyList<double> a, IReadOnlyList<double> b)
        {
            if (a == null || b == null) return a == b;
            if (a.Count != b.Count) return false;
            for (int i = 0; i < a.Count; i++) if (DesignViewportScales.Matching(b, a[i]) == null) return false;
            return true;
        }

        /// <summary>
        /// Makes the panel of <paramref name="tree"/> update again after the current update: nothing to do in Play mode and in
        /// players (panels update every frame); in Edit mode a runtime panel updates only when something changed after its
        /// last update, so it is marked dirty from the Editor's next update.
        /// </summary>
        internal static void RequestUpdate(VisualElement tree)
        {
#if UNITY_EDITOR
            if (Application.isPlaying || tree == null) return;
            UnityEditor.EditorApplication.CallbackFunction once = null;
            once = () =>
            {
                UnityEditor.EditorApplication.update -= once;
                if (tree.panel == null) return;
                tree.MarkDirtyRepaint();
                UnityEditor.EditorApplication.QueuePlayerLoopUpdate();
            };
            UnityEditor.EditorApplication.update += once;
#endif
        }

        /// <summary>The screen left its panel: the last screen gives the settings their own factor back.</summary>
        internal static void Leave(DesignScreen screen)
        {
            for (int i = s_Entries.Count - 1; i >= 0; i--)
                if (i < s_Entries.Count && s_Entries[i].Screens.Contains(screen)) Leave(screen, s_Entries[i]);
        }

        static void Leave(DesignScreen screen, Entry e)
        {
            e.Screens.Remove(screen);
            if (e.Screens.Count > 0) return;
            Restore(e);
            s_Entries.Remove(e);
        }

        static void Restore(Entry e)
        {
            if (e.Settings == null) return;
            if (e.Wrote(e.Settings.scale)) e.Settings.scale = e.Own;
#if UNITY_EDITOR
            if (e.History.Count > 0 && Find(s_Released, e.Settings) == null)
            {
                e.Written = float.NaN;
                e.Suspended = false;
                e.Screens.Clear();
                s_Released.Add(e);
            }
#endif
        }

        /// <summary>
        /// A region made <paramref name="copy"/> of <paramref name="source"/> (its own sort order) while a screen held the
        /// source's factor: the copy starts with the source's own factor (its screens hold it themselves).
        /// </summary>
        internal static void CopyMade(PanelSettings source, PanelSettings copy)
        {
            var e = Find(s_Entries, source);
            if (e == null || copy == null || float.IsNaN(e.Written) || !e.Wrote(copy.scale)) return;
            copy.scale = e.Own;
        }

        /// <summary>Gives every held PanelSettings its own factor back and forgets them.</summary>
        internal static void RestoreAll()
        {
            for (int i = 0; i < s_Entries.Count; i++) Restore(s_Entries[i]);
            s_Entries.Clear();
#if UNITY_EDITOR
            for (int i = s_Released.Count - 1; i >= 0; i--)
            {
                var r = s_Released[i];
                if (r.Settings == null) s_Released.RemoveAt(i);
                else if (r.Wrote(r.Settings.scale)) r.Settings.scale = r.Own;
            }
#endif
        }

#if UNITY_EDITOR
        /// <summary>
        /// Before a save (DesignUi.Editor's save guard): every PanelSettings <paramref name="saved"/> names that holds a factor
        /// this wrote (held now, or held earlier and brought back by an Undo) gets its own factor for the write. The ones still
        /// held get theirs again from the Editor's next update (<see cref="ReapplyAfterSave"/>). Returns how many were given back.
        /// </summary>
        internal static int GiveBackForSave(Func<PanelSettings, bool> saved)
        {
            int n = 0;
            bool again = false;
            foreach (var e in s_Entries)
            {
                if (e.Settings == null || !saved(e.Settings)) continue;
                if (e.Wrote(e.Settings.scale) && e.Settings.scale != e.Own)
                {
                    e.Settings.scale = e.Own;
                    e.Suspended = true;
                    again = true;
                    n++;
                }
            }
            for (int i = s_Released.Count - 1; i >= 0; i--)
            {
                var r = s_Released[i];
                if (r.Settings == null) { s_Released.RemoveAt(i); continue; }
                if (!saved(r.Settings) || !r.Wrote(r.Settings.scale)) continue;
                r.Settings.scale = r.Own;
                n++;
            }
            if (again)
            {
                UnityEditor.EditorApplication.CallbackFunction once = null;
                once = () =>
                {
                    UnityEditor.EditorApplication.update -= once;
                    ReapplyAfterSave();
                };
                UnityEditor.EditorApplication.update += once;
            }
            return n;
        }

        /// <summary>After a save: the PanelSettings given back for it hold their factor again, unless something changed it since.</summary>
        internal static void ReapplyAfterSave()
        {
            foreach (var e in s_Entries)
            {
                if (!e.Suspended) continue;
                e.Suspended = false;
                if (e.Settings == null || float.IsNaN(e.Written) || e.Settings.scale != e.Own) continue;
                e.Settings.scale = e.Written;
                foreach (var s in e.Screens)
                    if (s.panel != null) { RequestUpdate(s.panel.visualTree); break; }
            }
        }

        /// <summary>
        /// After an Undo or Redo: a PanelSettings whose snapshot was taken while a factor was held gets the right factor back
        /// (held: the one held now; given back: its own), not the snapshot's.
        /// </summary>
        internal static void AfterUndoRedo()
        {
            foreach (var e in s_Entries)
            {
                if (e.Settings == null || float.IsNaN(e.Written) || e.Settings.scale == e.Written || !e.Wrote(e.Settings.scale)) continue;
                e.Settings.scale = e.Written;
                foreach (var s in e.Screens)
                    if (s.panel != null) { RequestUpdate(s.panel.visualTree); break; }
            }
            for (int i = s_Released.Count - 1; i >= 0; i--)
            {
                var r = s_Released[i];
                if (r.Settings == null) { s_Released.RemoveAt(i); continue; }
                if (r.Wrote(r.Settings.scale)) r.Settings.scale = r.Own;
            }
        }

        /// <summary>Forgets the settings given back earlier (tests).</summary>
        internal static void ForgetReleased() => s_Released.Clear();
#endif
    }
}
