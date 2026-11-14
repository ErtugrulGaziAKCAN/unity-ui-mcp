using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// Plays a compiled screen's transitions and keyframe animations (spec 11) on UI Toolkit, with an injectable clock.
    /// <para>
    /// Triggers come from UI Toolkit's own style resolution: every animated element (class
    /// <see cref="DesignAnimationData.MarkerClass"/>) carries its animation data as custom properties of the USS rules that
    /// set the animated values (<see cref="DesignAnimationData"/>), so whatever changes which rule wins — a state or class the
    /// generated view sets (<c>SetState</c>, <c>SetClass</c>, <c>SetSelected</c>, <c>SetEnabled</c>), a pointer or focus
    /// pseudo-state, a mirrored shadow host, a breakpoint class — reaches the player in
    /// <see cref="CustomStyleResolvedEvent"/> during that style pass, before the frame is drawn.
    /// </para>
    /// <list type="bullet">
    /// <item>Transitions (CSS Transitions §3): when the winning rule's value of a transitioned property changes, the player
    /// writes the value the element showed (its current animated value, or the previous rule's value) as an inline style
    /// at once, animates it to the new rule's value with the new rule's duration, delay (a negative one starts inside the
    /// transition) and timing function, and removes the inline style at the end, handing the property back to the USS
    /// rule. No transition on an element's first style or while it is not displayed (CSS: no before-change style).</item>
    /// <item>Keyframe animations: the winning <c>--dui-a</c> list starts when the element first gets a box (shown), and when
    /// the list changes: an animation whose name stays keeps running (with the new timing and play state: pausing holds
    /// the frame, resuming continues from it), new names start, removed ones stop and hand their properties back (a layer
    /// with <c>animation: none</c> stops them; they start over when it stops holding). An animation a trigger layer starts
    /// (a class, state or pseudo-state the element already has in its first style, e.g. a panel that starts
    /// <c>is-open</c>) shows its end frame there instead of playing, as the design's static frame does; toggling the
    /// trigger off and on plays it. Iterations, direction, fill modes, delay (negative: started inside the timeline), play
    /// state and per-keyframe easing follow Web Animations; a fill holds the value while the animation stays in the list.</item>
    /// <item>Writes: transform, opacity and colour properties as inline styles, which UI Toolkit applies without a style or
    /// layout pass; a layout property (lint warning W-CSS-001) also lays out. A later animation of the same property
    /// overrides an earlier one, keyframe animations override transitions. Nothing is allocated per frame in steady state.</item>
    /// <item><see cref="ReducedMotion"/> (a game's accessibility setting): transitions jump to their value and every keyframe
    /// animation that starts shows the frame a static design capture shows (the end of one iteration, held); turning it
    /// on also ends what runs. Animations frozen this way stay frozen until they start again.</item>
    /// </list>
    /// A compiled screen root (<see cref="DesignScreen"/> with <c>animated</c>) attaches its player by itself; a generated
    /// view or a host finds it with <see cref="For"/>. Elements cloned into the screen later (repeat items) are found when
    /// the screen is attached again, or at once through <see cref="Watch"/>, which the repeat helpers call.
    /// </summary>
    public sealed class DesignUiAnimationPlayer
    {
        static readonly ConditionalWeakTable<VisualElement, DesignUiAnimationPlayer> s_Players = new ConditionalWeakTable<VisualElement, DesignUiAnimationPlayer>();

        readonly VisualElement m_Root;
        readonly Dictionary<VisualElement, Animated> m_Elements = new Dictionary<VisualElement, Animated>();
        readonly List<Animated> m_Active = new List<Animated>();
        readonly EventCallback<CustomStyleResolvedEvent> m_OnStyle;
        readonly EventCallback<DetachFromPanelEvent> m_OnDetach;
        readonly EventCallback<AttachToPanelEvent> m_OnAttach;
        readonly IVisualElementScheduledItem m_Tick;
        IDesignAnimationClock m_Clock = DesignRealtimeClock.Instance;
        bool m_ReducedMotion;

        DesignUiAnimationPlayer(VisualElement root)
        {
            m_Root = root;
            m_OnStyle = OnStyle;
            m_OnDetach = OnDetach;
            m_OnAttach = OnAttach;
            m_Tick = root.schedule.Execute(Tick).Every(0);
            m_Tick.Pause();
            root.RegisterCallback<AttachToPanelEvent>(_ => Rescan());
            Rescan();
        }

        /// <summary>The player of the screen root <paramref name="root"/>, created (and its animated elements found) on first use.</summary>
        public static DesignUiAnimationPlayer Attach(VisualElement root)
        {
            if (root == null) throw new ArgumentNullException(nameof(root));
            if (s_Players.TryGetValue(root, out var p)) return p;
            p = new DesignUiAnimationPlayer(root);
            s_Players.Add(root, p);
            return p;
        }

        /// <summary>The player of the screen <paramref name="element"/> belongs to (it or its nearest ancestor that has one), or null.</summary>
        public static DesignUiAnimationPlayer For(VisualElement element)
        {
            for (var x = element; x != null; x = x.hierarchy.parent)
                if (s_Players.TryGetValue(x, out var p)) return p;
            return null;
        }

        /// <summary>The screen root the player animates.</summary>
        public VisualElement Root => m_Root;

        /// <summary>The time base (default: <see cref="DesignRealtimeClock"/>). Tests and the verifier use a <see cref="DesignManualClock"/>.</summary>
        public IDesignAnimationClock Clock
        {
            get => m_Clock;
            set => m_Clock = value ?? DesignRealtimeClock.Instance;
        }

        /// <summary>Jump to the end instead of playing (see the class summary); turning it on ends what runs now.</summary>
        public bool ReducedMotion
        {
            get => m_ReducedMotion;
            set
            {
                if (m_ReducedMotion == value) return;
                m_ReducedMotion = value;
                if (!value) return;
                foreach (var a in m_Elements.Values)
                {
                    for (int i = 0; i < a.Running.Length; i++) a.Running[i] = false;
                    for (int i = 0; i < a.Runs.Count; i++) a.Runs[i].Frozen = true;
                    Apply(a, Now);
                }
            }
        }

        /// <summary>Elements whose animations or transitions still change with time.</summary>
        public int ActiveCount => m_Active.Count;

        /// <summary>The watched elements.</summary>
        public int WatchedCount => m_Elements.Count;

        double Now => m_Clock.Milliseconds;

        /// <summary>Finds the root's animated elements not watched yet (the root's own attach does this).</summary>
        public void Rescan()
        {
            if (m_Root.ClassListContains(DesignAnimationData.MarkerClass)) Watch(m_Root);
            m_Root.Query(className: DesignAnimationData.MarkerClass).ForEach(Watch);
        }

        /// <summary>Watches <paramref name="element"/> and the animated elements below it (repeat items cloned into the screen).</summary>
        public void WatchTree(VisualElement element)
        {
            if (element == null) return;
            if (element.ClassListContains(DesignAnimationData.MarkerClass)) Watch(element);
            element.Query(className: DesignAnimationData.MarkerClass).ForEach(Watch);
        }

        /// <summary>Watches one animated element (no-op when it is watched already or has no animation data).</summary>
        public void Watch(VisualElement element)
        {
            if (element == null || m_Elements.ContainsKey(element)) return;
            var a = new Animated(element);
            m_Elements.Add(element, a);
            element.RegisterCallback(m_OnStyle);
            element.RegisterCallback(m_OnDetach);
            element.RegisterCallback(m_OnAttach); // inserted again after a detach (a recycled list slot): watched again
            // styled already (an item cloned while the screen is shown): its first style is now
            if (element.panel != null &&
                (element.customStyle.TryGetValue(DesignAnimationData.TransitionListKey, out _) || element.customStyle.TryGetValue(DesignAnimationData.AnimationListKey, out _)))
                Resolve(a);
        }

        /// <summary>
        /// Writes every running animation's value at the clock's time now (also done every frame while something runs).
        /// The verifier steps its clock and calls this before a capture.
        /// </summary>
        public void Tick()
        {
            double now = Now;
            for (int i = m_Active.Count - 1; i >= 0; i--)
            {
                var a = m_Active[i];
                if (!Apply(a, now))
                {
                    a.InActive = false;
                    m_Active.RemoveAt(i);
                }
            }
            if (m_Active.Count == 0) m_Tick.Pause();
        }

        /// <summary>Test and verifier access: whether the element's keyframe animation named <paramref name="name"/> is in effect, and frozen.</summary>
        public bool IsPlaying(VisualElement element, string name, out bool frozen)
        {
            frozen = false;
            if (element == null || !m_Elements.TryGetValue(element, out var a)) return false;
            foreach (var r in a.Runs)
                if (r.Spec.Name == name) { frozen = r.Frozen; return true; }
            return false;
        }

        /// <summary>The names of the keyframe animations in effect on the element (verifier notes).</summary>
        public IEnumerable<string> Playing(VisualElement element)
        {
            if (element == null || !m_Elements.TryGetValue(element, out var a)) yield break;
            foreach (var r in a.Runs) yield return r.Spec.Name;
        }

        /// <summary>Whether a transition of the property runs on the element.</summary>
        public bool IsTransitioning(VisualElement element, DesignAnimProperty property)
        {
            if (element == null || !m_Elements.TryGetValue(element, out var a)) return false;
            for (int i = 0; i < a.Props.Length; i++)
                if (a.Props[i] == property) return a.Running[i];
            return false;
        }

        // ---- per element ----------------------------------------------------------------------------------------------

        sealed class Run
        {
            public DesignAnimationData.Animation Spec;
            public DesignAnimationData.KeyframeSet Set;
            /// <summary>Clock time of local time 0 while the animation runs.</summary>
            public double Start;
            /// <summary>The local time a paused animation holds (0 when it starts paused).</summary>
            public double Held;
            public bool Frozen;
            /// <summary>The element's own value per property of the set (implicit 0 % and 100 % frames).</summary>
            public DesignAnimValue[] Underlying;

            /// <summary>The animation's local (current) time at clock time <paramref name="now"/>.</summary>
            public double Local(double now) => Spec.Paused ? Held : now - Start;
        }

        sealed class Animated
        {
            public readonly VisualElement Element;
            public bool Initialized, WasDisplayed, InActive;
            // transitions, one slot per transitioned property
            public string ListText;
            public DesignAnimProperty[] Props = new DesignAnimProperty[0];
            public DesignAnimationData.TransitionEntry[] Entries = new DesignAnimationData.TransitionEntry[0];
            public DesignAnimValue[] Target = new DesignAnimValue[0];
            public bool[] Running = new bool[0];
            public double[] Start = new double[0];
            public DesignAnimValue[] From = new DesignAnimValue[0];
            public DesignAnimValue[] Shown = new DesignAnimValue[0];
            // keyframe animations
            public string AnimText;
            public readonly List<Run> Runs = new List<Run>();
            public readonly List<Run> Scratch = new List<Run>();
            // inline styles the player holds, and those written in the current pass
            public readonly bool[] Held = new bool[DesignAnimProperties.Count];
            public readonly bool[] Written = new bool[DesignAnimProperties.Count];

            public Animated(VisualElement element) { Element = element; }

            public void SetProps(DesignAnimProperty[] props)
            {
                Props = props;
                int n = props.Length;
                Entries = new DesignAnimationData.TransitionEntry[n];
                Target = new DesignAnimValue[n];
                Running = new bool[n];
                Start = new double[n];
                From = new DesignAnimValue[n];
                Shown = new DesignAnimValue[n];
            }
        }

        void OnDetach(DetachFromPanelEvent e)
        {
            if (!(e.currentTarget is VisualElement el) || !m_Elements.TryGetValue(el, out var a)) return;
            // removed from the panel: forgotten (an element inserted again is watched again and starts over, as in CSS), its
            // inline styles given back to the USS rules; only its attach callback, which holds no reference to it, remains
            for (int p = 0; p < a.Held.Length; p++)
                if (a.Held[p]) { DesignAnimProperties.Clear(el, (DesignAnimProperty)p); a.Held[p] = false; }
            if (a.InActive) { a.InActive = false; m_Active.Remove(a); }
            el.UnregisterCallback(m_OnStyle);
            el.UnregisterCallback(m_OnDetach);
            m_Elements.Remove(el);
        }

        void OnAttach(AttachToPanelEvent e)
        {
            if (e.currentTarget is VisualElement el && !m_Elements.ContainsKey(el)) Watch(el);
        }

        static bool Displayed(VisualElement e)
        {
            if (e.panel == null) return false;
            for (var x = e; x != null; x = x.hierarchy.parent)
                if (x.resolvedStyle.display == DisplayStyle.None) return false;
            return true;
        }

        void OnStyle(CustomStyleResolvedEvent e)
        {
            if (e.currentTarget is VisualElement el && m_Elements.TryGetValue(el, out var a)) Resolve(a);
        }

        /// <summary>The element's style was resolved: start, change or stop its transitions and animations.</summary>
        void Resolve(Animated a)
        {
            var el = a.Element;
            double now = Now;
            bool displayed = Displayed(el);
            bool fresh = !a.Initialized || !a.WasDisplayed || !displayed;
            var style = el.customStyle;

            // transitions
            if (!style.TryGetValue(DesignAnimationData.TransitionListKey, out var listText)) listText = "";
            if (!ReferenceEquals(listText, a.ListText) && listText != a.ListText)
            {
                // the list itself changes only between screen revisions; start over
                for (int i = 0; i < a.Running.Length; i++) a.Running[i] = false;
                a.SetProps(DesignAnimationData.ParseTransitionList(listText));
                a.ListText = listText;
                fresh = true;
            }
            for (int i = 0; i < a.Props.Length; i++)
            {
                var p = a.Props[i];
                if (!style.TryGetValue(DesignAnimationData.TransitionKey(p), out var text) || text == null) continue;
                var entry = DesignAnimationData.ParseTransition(p, text);
                var target = entry.HasValue ? entry.Value : OwnValue(a, p);
                bool hadEntry = a.Entries[i] != null;
                a.Entries[i] = entry;
                if (fresh || !hadEntry)
                {
                    a.Target[i] = target;
                    a.Shown[i] = target;
                    a.Running[i] = false;
                    continue;
                }
                if (DesignAnimProperties.Same(p, target, a.Target[i])) continue;
                var current = a.Running[i] ? TransitionValue(a, i, now) : a.Target[i];
                a.Target[i] = target;
                if (m_ReducedMotion || !entry.Animates || !DesignAnimProperties.Interpolable(p, current, target))
                {
                    a.Running[i] = false;
                    continue;
                }
                a.Running[i] = true;
                a.Start[i] = now;
                a.From[i] = current;
            }

            // keyframe animations
            if (!style.TryGetValue(DesignAnimationData.AnimationListKey, out var animText)) animText = "";
            if (!displayed)
            {
                a.Runs.Clear();
                a.AnimText = null;
            }
            else if (!a.Initialized || !a.WasDisplayed || (!ReferenceEquals(animText, a.AnimText) && animText != a.AnimText))
            {
                bool restartAll = !a.Initialized || !a.WasDisplayed;
                var specs = DesignAnimationData.ParseAnimations(animText);
                a.Scratch.Clear();
                for (int k = 0; k < specs.Length; k++)
                {
                    var spec = specs[k];
                    Run keep = null;
                    if (!restartAll)
                        for (int r = 0; r < a.Runs.Count; r++)
                            if (a.Runs[r] != null && a.Runs[r].Spec.Name == spec.Name) { keep = a.Runs[r]; a.Runs[r] = null; break; }
                    if (keep != null)
                    {
                        // the same animation goes on with the timing now in effect; a change of play state keeps its current
                        // time (Web Animations: pausing holds it, resuming continues from it)
                        if (keep.Spec.Paused != spec.Paused)
                        {
                            if (spec.Paused) keep.Held = now - keep.Start;
                            else keep.Start = now - keep.Held;
                        }
                        keep.Spec = spec;
                        keep.Set = Keyframes(el, spec.Keyframes);
                        a.Scratch.Add(keep);
                        continue;
                    }
                    var set = Keyframes(el, spec.Keyframes);
                    // a trigger layer the element starts in (its first style) shows its animations' end, as its static design does
                    bool ended = m_ReducedMotion || (spec.Layer && !a.Initialized);
                    var run = new Run { Spec = spec, Set = set, Start = now, Held = 0, Frozen = ended, Underlying = new DesignAnimValue[set.Properties.Length] };
                    for (int q = 0; q < set.Properties.Length; q++) run.Underlying[q] = Underlying(a, set.Properties[q].Property);
                    a.Scratch.Add(run);
                }
                a.Runs.Clear();
                a.Runs.AddRange(a.Scratch);
                a.Scratch.Clear();
                a.AnimText = animText;
            }

            a.Initialized = true;
            a.WasDisplayed = displayed;
            bool active = Apply(a, now);
            if (active && !a.InActive)
            {
                a.InActive = true;
                m_Active.Add(a);
                m_Tick.Resume();
            }
        }

        static DesignAnimationData.KeyframeSet Keyframes(VisualElement el, int index)
        {
            if (!el.customStyle.TryGetValue(DesignAnimationData.KeyframesKey(index), out var text) || text == null)
                throw new InvalidOperationException("animated element '" + el.name + "' has no keyframes " + DesignAnimationData.KeyframesPrefix + index + " in its USS; recompile the screen");
            return DesignAnimationData.ParseKeyframes(text);
        }

        /// <summary>The element's own value of the property: its USS value with the player's inline style removed.</summary>
        static DesignAnimValue OwnValue(Animated a, DesignAnimProperty p)
        {
            if (a.Held[(int)p])
            {
                DesignAnimProperties.Clear(a.Element, p); // applies the rule's value at once; the next Apply writes again
                a.Held[(int)p] = false;
            }
            return DesignAnimProperties.Read(a.Element, p);
        }

        /// <summary>The value under a keyframe animation: the transitioned target, else the element's own value.</summary>
        static DesignAnimValue Underlying(Animated a, DesignAnimProperty p)
        {
            for (int i = 0; i < a.Props.Length; i++)
                if (a.Props[i] == p && a.Entries[i] != null) return a.Target[i];
            return OwnValue(a, p);
        }

        static DesignAnimValue TransitionValue(Animated a, int i, double now)
        {
            var e = a.Entries[i];
            double t = now - a.Start[i] - e.Delay;
            bool before = t < 0;
            double progress = before ? 0 : e.Duration <= 0 ? 1 : Math.Min(1, t / e.Duration);
            return DesignAnimProperties.Interpolate(a.Props[i], a.From[i], a.Target[i], e.Timing.Evaluate(progress, before));
        }

        /// <summary>Writes the element's animated values at <paramref name="now"/>; returns whether they still change with time.</summary>
        bool Apply(Animated a, double now)
        {
            var el = a.Element;
            var written = a.Written;
            Array.Clear(written, 0, written.Length);
            bool active = false;
            for (int i = 0; i < a.Props.Length; i++)
            {
                if (!a.Running[i]) continue;
                var e = a.Entries[i];
                if (now - a.Start[i] >= e.Delay + e.Duration)
                {
                    a.Running[i] = false; // ended: the USS rule's value shows again
                    a.Shown[i] = a.Target[i];
                    continue;
                }
                var v = TransitionValue(a, i, now);
                a.Shown[i] = v;
                Write(a, a.Props[i], v);
                active = true;
            }
            for (int r = 0; r < a.Runs.Count; r++)
            {
                var run = a.Runs[r];
                double local = run.Local(now);
                if (!run.Frozen && !run.Spec.Paused)
                {
                    double end = run.Spec.Delay + run.Spec.Duration * run.Spec.Iterations;
                    if (run.Spec.Duration > 0 && run.Spec.Iterations > 0 && (double.IsInfinity(end) || local < end)) active = true;
                    else if (local < run.Spec.Delay) active = true;
                }
                if (!DesignAnimationData.Progress(run.Spec, local, run.Frozen, out var x, out var before)) continue;
                var props = run.Set.Properties;
                for (int q = 0; q < props.Length; q++)
                    Write(a, props[q].Property, DesignAnimationData.Evaluate(props[q], x, before, run.Spec.Timing, run.Underlying[q]));
            }
            for (int p = 0; p < written.Length; p++)
            {
                if (written[p] || !a.Held[p]) continue;
                DesignAnimProperties.Clear(el, (DesignAnimProperty)p);
                a.Held[p] = false;
            }
            return active;
        }

        static void Write(Animated a, DesignAnimProperty p, in DesignAnimValue v)
        {
            DesignAnimProperties.Write(a.Element, p, v);
            a.Written[(int)p] = true;
            a.Held[(int)p] = true;
        }
    }
}
