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
    /// 1600×900 at 0.625, or any resolution the profile does not declare) the screen's panel lays out at an exact scale (the
    /// next one up, <see cref="LayoutScale"/>) and the screen root draws scaled by actual / exact, its top-left corner fixed,
    /// so every edge and every line of text falls where the design puts it at the actual scale
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

        /// <summary>
        /// The rule <see cref="LayoutScale"/> uses: the next exact scale up, so the root scale is at most 1 (below the largest
        /// exact scale). Layout puts every edge on the device grid of the scale it lays out at, up to half a pixel there,
        /// which the root scale multiplies: drawn at most 1, a box's edges stay within half a device pixel and its width
        /// within one; laid out at 0.5 and drawn at 1366×768 (1.067) they did not (docs/findings/viewport-classes.md).
        /// </summary>
        public static BaseRule Rule { get; set; } = BaseRule.Up;

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
    /// last such screen leaves the panel. A factor the game writes meanwhile (anything but the factor last written here)
    /// becomes the settings' own: it is kept and the exact scale is applied on top. Every screen on the panel scales its root
    /// by its actual / exact scale.
    /// <para>In the Editor outside Play mode a factor is held only on a PanelSettings no save writes (<see cref="CanHold"/>:
    /// <c>HideFlags.DontSaveInEditor</c>, as a capture's copy or a region's sort-order copy): an asset, or settings a scene
    /// could save, keep their own factor, and their screens lay out at the actual scale unscaled. So no asset save, build,
    /// preset or copy, scene and no Undo snapshot taken in Edit mode can carry a held factor. In Play mode a held asset is
    /// written in memory: a save during Play writes its own factor (DesignUi.Editor's save guard,
    /// <see cref="GiveBackForSave"/>), an Undo or Redo of a snapshot taken while held puts the snapshot's own factor back
    /// (<see cref="AfterUndoRedo"/>, also after a script reload; only on the settings the Undo touched, and only for a factor
    /// this wrote since the settings' own last changed: a value the game or the user set, also one equal to an earlier held
    /// factor, is never reset), and leaving Play, a script reload, a player build and quitting give every factor back.</para>
    /// </summary>
    internal static class DesignRootScalePanels
    {
        sealed class Entry
        {
            public PanelSettings Settings;
            /// <summary>The settings' own scale factor (the game's), given back when the last screen leaves.</summary>
            public float Own;
            /// <summary>The factor last written here (NaN: none): the only value that counts as this class's own write.</summary>
            public float Written = float.NaN;
            /// <summary>
            /// The factors written here since the settings' own last changed, each with the own factor it was written over and the
            /// Undo group current when it was first written, and the one held when it changed (Editor: an Undo of that change, or
            /// of a snapshot taken while held, brings one back; a snapshot recorded in an earlier group cannot hold it).
            /// </summary>
            public readonly List<(float factor, float own, int group)> History = new List<(float, float, int)>();
            /// <summary>The scale this class last wrote or saw on the settings (Editor): an Undo that leaves it as it is did not touch them.</summary>
            public float Observed = float.NaN;
            public IReadOnlyList<double> ExactScales;
            public readonly List<DesignScreen> Screens = new List<DesignScreen>();
            /// <summary>The factor was given back for a save and is held again after it.</summary>
            public bool Suspended;
            public bool Warned;

            /// <summary>
            /// The own factor <paramref name="factor"/> was written over, when an Undo or Redo of <paramref name="group"/> can have
            /// brought it back: a snapshot recorded in a group before the factor was first written holds a value the game or the
            /// user set, whatever it equals.
            /// </summary>
            public bool OwnBefore(float factor, int group, out float own)
            {
                for (int i = History.Count - 1; i >= 0; i--)
                    if (History[i].factor == factor && History[i].group <= group)
                    {
                        own = History[i].own;
                        return true;
                    }
                own = float.NaN;
                return false;
            }
        }

        static readonly List<Entry> s_Entries = new List<Entry>();
#if UNITY_EDITOR
        /// <summary>Settings this held and gave back in the Editor session: an Undo snapshot taken while held can bring a factor back.</summary>
        static readonly List<Entry> s_Released = new List<Entry>();
#endif

        /// <summary>Whether the Editor plays (tests replace it).</summary>
        internal static Func<bool> Playing = () => Application.isPlaying;

        /// <summary>
        /// Whether a factor may be held on <paramref name="settings"/>: always in players and in Play mode; in the Editor outside
        /// Play mode only on settings no save writes (<c>HideFlags.DontSaveInEditor</c>), never on an asset or on settings a
        /// scene could save.
        /// </summary>
        internal static bool CanHold(PanelSettings settings)
        {
#if UNITY_EDITOR
            if (settings != null && !Playing() && (settings.hideFlags & HideFlags.DontSaveInEditor) == 0) return false;
#endif
            return settings != null;
        }

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
            UnityEditor.Undo.undoRedoEvent += (in UnityEditor.UndoRedoInfo info) => AfterUndoRedo(info.undoGroup);
            UnityEditor.Undo.postprocessModifications += ObserveModifications;
            UnityEditor.EditorApplication.update += Observe;
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
        /// design's scale on that screen); <paramref name="rootScale"/>: actual / the scale the panel lays out at now. On settings
        /// the factor may not be held on (<see cref="CanHold"/>) nothing is written and the root is not scaled. False (nothing
        /// written, root scale 1) when the panel has no size in pixels yet (a world-space panel never has one); a factor held
        /// already stays held then (<see cref="Holds"/>).
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
            // the panel's target in device pixels: UI Toolkit sizes its root to target × resolved scale and sets the panel scale to
            // its inverse in the same step (PanelSettings.ApplyPanelSettings), so the product is the target whatever factor applied
            var tree = panel.visualTree;
            float ppp = panel.scaledPixelsPerPoint;
            var w = tree.style.width;
            var h = tree.style.height;
            bool sized = w.keyword == StyleKeyword.Undefined && h.keyword == StyleKeyword.Undefined && ppp > 0;
            var device = sized ? new Vector2(w.value.value * ppp, h.value.value * ppp) : Vector2.zero;
            if (!CanHold(settings))
            {
                // a save could write these settings: the screen lays out at the actual scale itself, nothing is held
                Leave(screen);
                if (!(device.x > 0) || !(device.y > 0)) return false;
                actual = DesignViewportScales.UnitScale(settings, device, Screen.dpi) * settings.scale;
                return actual > 0 && !double.IsInfinity(actual);
            }
            var e = Find(s_Entries, settings);
            if (e == null)
            {
                e = new Entry { Settings = settings, Own = settings.scale, ExactScales = exactScales };
#if UNITY_EDITOR
                var before = Find(s_Released, settings);
                if (before != null)
                {
                    s_Released.Remove(before);
                    e.History.AddRange(before.History);
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
            // any factor but the one last written here is the settings' own from now on: the game's UI scale, whatever value
            if (float.IsNaN(e.Written) || settings.scale != e.Written)
            {
#if UNITY_EDITOR
                // only a real change of the own trims the factors written before it: a new hold keeps what an earlier hold of
                // these settings wrote (an Undo snapshot taken then can still bring it back)
                if (settings.scale != e.Own || !float.IsNaN(e.Written)) KeepLastWritten(e);
#endif
                e.Own = settings.scale;
                e.Written = float.NaN;
            }
            if (!(device.x > 0) || !(device.y > 0)) return false;
            actual = DesignViewportScales.UnitScale(settings, device, Screen.dpi) * e.Own;
            if (!(actual > 0) || double.IsInfinity(actual)) return false;
            var exact = DesignViewportScales.LayoutScale(e.ExactScales ?? exactScales, actual);
            float factor = Math.Abs(exact / actual - 1) <= DesignViewportScales.Tolerance ? e.Own : (float)(e.Own * exact / actual);
            if (settings.scale != factor)
            {
                settings.scale = factor;
                e.Written = factor;
                e.Suspended = false;
#if UNITY_EDITOR
                if (!e.OwnBefore(factor, int.MaxValue, out var known) || known != e.Own) e.History.Add((factor, e.Own, UnityEditor.Undo.GetCurrentGroup()));
#endif
                // the panel applies its settings when it updates: every frame in Play mode and in players, in Edit mode only
                // when something on it changed after its last update (this runs during one: its style or geometry callbacks)
                RequestUpdate(tree);
            }
            else if (factor != e.Own) e.Written = factor;
#if UNITY_EDITOR
            e.Observed = settings.scale;
#endif
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
            if (!float.IsNaN(e.Written) && e.Settings.scale == e.Written || e.Suspended && e.Settings.scale == e.Own) e.Settings.scale = e.Own;
#if UNITY_EDITOR
            e.Observed = e.Settings.scale;
            if (e.History.Count > 0)
            {
                e.Written = float.NaN;
                e.Suspended = false;
                e.Screens.Clear();
                if (Find(s_Released, e.Settings) == null) s_Released.Add(e);
                Remember(e);
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
            if (e == null || copy == null || float.IsNaN(e.Written) || copy.scale != e.Written) return;
            copy.scale = e.Own;
        }

        /// <summary>Gives every held PanelSettings its own factor back and forgets them.</summary>
        internal static void RestoreAll()
        {
            for (int i = 0; i < s_Entries.Count; i++) Restore(s_Entries[i]);
            s_Entries.Clear();
        }

#if UNITY_EDITOR
        const string RememberedKey = "DesignUi.RootScale.Written";

        [Serializable]
        sealed class Remembered
        {
            public List<Record> records = new List<Record>();
        }

        [Serializable]
        sealed class Record
        {
            public string id;
            public float observed;
            public List<float> factors = new List<float>();
            public List<float> owns = new List<float>();
            public List<int> groups = new List<int>();
        }

        /// <summary>
        /// A held entry keeps, of the factors it wrote, only the one held when its own changed (an Undo of that change brings
        /// it back): an earlier factor that equals a later own (the game's or the user's) must never be taken for this class's.
        /// </summary>
        static void KeepLastWritten(Entry e)
        {
            float written = e.Written;
            if (float.IsNaN(written)) { e.History.Clear(); return; }
            for (int i = e.History.Count - 1; i >= 0; i--)
                if (e.History[i].factor == written)
                {
                    var pair = e.History[i];
                    e.History.Clear();
                    e.History.Add(pair);
                    return;
                }
            e.History.Clear();
        }

        /// <summary>
        /// Keeps a given-back asset's written factors and the scale it was left with for the Editor session (SessionState): an
        /// Undo after a script reload, which empties the statics but keeps the Undo stack, can still put the snapshot's own
        /// factor back.
        /// </summary>
        static void Remember(Entry e)
        {
            if (e.Settings == null || !UnityEditor.EditorUtility.IsPersistent(e.Settings)) return;
            var id = UnityEditor.GlobalObjectId.GetGlobalObjectIdSlow(e.Settings).ToString();
            var r = Load();
            r.records.RemoveAll(x => x.id == id);
            var record = new Record { id = id, observed = e.Observed };
            foreach (var (factor, own, group) in e.History)
            {
                record.factors.Add(factor);
                record.owns.Add(own);
                record.groups.Add(group);
            }
            r.records.Add(record);
            UnityEditor.SessionState.SetString(RememberedKey, JsonUtility.ToJson(r));
        }

        /// <summary>Forgets a given-back settings: its scale is the game's or the user's now.</summary>
        static void Forget(Entry r)
        {
            s_Released.Remove(r);
            if (r.Settings == null || !UnityEditor.EditorUtility.IsPersistent(r.Settings)) return;
            var id = UnityEditor.GlobalObjectId.GetGlobalObjectIdSlow(r.Settings).ToString();
            var all = Load();
            if (all.records.RemoveAll(x => x.id == id) > 0) UnityEditor.SessionState.SetString(RememberedKey, JsonUtility.ToJson(all));
        }

        static Remembered Load()
        {
            try { return JsonUtility.FromJson<Remembered>(UnityEditor.SessionState.GetString(RememberedKey, "")) ?? new Remembered(); }
            catch (ArgumentException) { return new Remembered(); }
        }

        static bool s_Rehydrated;

        /// <summary>After a script reload: the given-back assets the session remembers are tracked again, with the scale they were left with.</summary>
        static void Rehydrate()
        {
            if (s_Rehydrated) return;
            s_Rehydrated = true;
            foreach (var record in Load().records)
            {
                if (!UnityEditor.GlobalObjectId.TryParse(record.id, out var gid)) continue;
                var settings = UnityEditor.GlobalObjectId.GlobalObjectIdentifierToObjectSlow(gid) as PanelSettings;
                if (settings == null || Find(s_Entries, settings) != null || Find(s_Released, settings) != null) continue;
                var e = new Entry { Settings = settings, Own = record.observed, Observed = record.observed };
                for (int i = 0; i < record.factors.Count && i < record.owns.Count; i++)
                    e.History.Add((record.factors[i], record.owns[i], i < record.groups.Count ? record.groups[i] : int.MinValue));
                s_Released.Add(e);
            }
        }

        /// <summary>
        /// Every Editor update: a scale this class did not write and no Undo brought back (the game's code, the Inspector) is the
        /// settings' own. A held entry keeps only the pair of the factor held when it changed; a given-back settings is
        /// forgotten. So an Undo or a save later never takes such a value for one of this class's factors.
        /// </summary>
        internal static void Observe()
        {
            Rehydrate();
            foreach (var e in s_Entries) ObserveEntry(e, false);
            for (int i = s_Released.Count - 1; i >= 0; i--) ObserveEntry(s_Released[i], true);
        }

        static void ObserveEntry(Entry e, bool released)
        {
            if (e.Settings == null)
            {
                if (released) s_Released.Remove(e);
                return;
            }
            float scale = e.Settings.scale;
            if (float.IsNaN(e.Observed) || scale == e.Observed) return;
            if (released) { Forget(e); return; }
            // a held entry: its screens take the new value as the own on their next evaluation
            KeepLastWritten(e);
            e.Observed = scale;
        }

        /// <summary>A scale set through the Inspector or a SerializedObject (recorded for Undo) is observed at once.</summary>
        static UnityEditor.UndoPropertyModification[] ObserveModifications(UnityEditor.UndoPropertyModification[] modifications)
        {
            foreach (var m in modifications)
            {
                if (!(m.currentValue?.target is PanelSettings settings) || m.currentValue.propertyPath != "m_Scale") continue;
                if (!float.TryParse(m.currentValue.value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var value)) continue;
                var e = Find(s_Entries, settings);
                var released = e == null;
                if (released) e = Find(s_Released, settings);
                if (e == null || value == e.Observed) continue;
                if (released) Forget(e);
                else { KeepLastWritten(e); e.Observed = value; }
            }
            return modifications;
        }

        /// <summary>
        /// Before a save (DesignUi.Editor's save guard): every PanelSettings <paramref name="saved"/> names that holds the factor
        /// this wrote last gets its own factor for the write (an Undo that brings a given-back settings to a factor it held is
        /// mapped to that snapshot's own at once, <see cref="AfterUndoRedo"/>). The ones still held get theirs again from the
        /// Editor's next update (<see cref="ReapplyAfterSave"/>). Returns how many were given back.
        /// </summary>
        internal static int GiveBackForSave(Func<PanelSettings, bool> saved)
        {
            int n = 0;
            bool again = false;
            foreach (var e in s_Entries)
            {
                if (e.Settings == null || !saved(e.Settings)) continue;
                if (!float.IsNaN(e.Written) && e.Settings.scale == e.Written && e.Settings.scale != e.Own)
                {
                    e.Settings.scale = e.Own;
                    e.Observed = e.Own;
                    e.Suspended = true;
                    again = true;
                    n++;
                }
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
                e.Observed = e.Written;
                foreach (var s in e.Screens)
                    if (s.panel != null) { RequestUpdate(s.panel.visualTree); break; }
            }
        }

        /// <summary>
        /// After an Undo or Redo of <paramref name="group"/>, only on the PanelSettings it touched (whose scale is no longer the
        /// one this class last wrote or saw): one brought back to a factor this wrote (since its own last changed, or the one
        /// held then) in that group or before it gets the own factor that factor was written over (the snapshot's own): held,
        /// the screens hold the factor of that own again; given back, it keeps that own. Any other value an Undo brings back is
        /// the settings' own, also one equal to a held factor from a snapshot recorded before that factor was written (the
        /// user's own earlier value). Also after a script reload, for assets (SessionState).
        /// </summary>
        internal static void AfterUndoRedo(int group)
        {
            Rehydrate();
            foreach (var e in s_Entries)
            {
                if (e.Settings == null) continue;
                float scale = e.Settings.scale;
                if (scale == e.Observed) continue; // not touched
                e.Observed = scale;
                if (scale == e.Written || !e.OwnBefore(scale, group, out var own)) continue;
                e.Own = own;
                e.Written = float.NaN;
                e.Settings.scale = own;
                e.Observed = own;
                foreach (var s in e.Screens)
                    if (s.panel != null) { RequestUpdate(s.panel.visualTree); break; }
            }
            for (int i = s_Released.Count - 1; i >= 0; i--)
            {
                var r = s_Released[i];
                if (r.Settings == null) { s_Released.RemoveAt(i); continue; }
                float scale = r.Settings.scale;
                if (scale == r.Observed) continue; // not touched
                r.Observed = r.OwnBefore(scale, group, out var own) ? own : scale;
                r.Settings.scale = r.Observed;
                Remember(r);
            }
        }

        /// <summary>Before a build: every held PanelSettings gets its own factor back (a build writes loaded objects as they are in memory). Returns how many.</summary>
        internal static int BeforeBuild()
        {
            int n = 0;
            foreach (var e in s_Entries) if (e.Settings != null && !float.IsNaN(e.Written) && e.Settings.scale == e.Written) n++;
            RestoreAll();
            return n;
        }

        /// <summary>Forgets what a script reload empties: the settings given back earlier, not the session's record (tests).</summary>
        internal static void ForgetStatics()
        {
            s_Released.Clear();
            s_Rehydrated = false;
        }

        /// <summary>Forgets the settings given back earlier, also the session's remembered ones (tests).</summary>
        internal static void ForgetReleased()
        {
            s_Released.Clear();
            UnityEditor.SessionState.EraseString(RememberedKey);
            s_Rehydrated = true;
        }
#endif
    }
}
