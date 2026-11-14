using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// The compiled animation data a screen's USS carries for the animation player, as custom properties of each animated
    /// element's rules (the compiler writes them next to the values they belong to, so UI Toolkit's own cascade picks the
    /// data of the rule that wins, exactly as CSS picks the after-change style). Every animated element has the class
    /// <see cref="MarkerClass"/> and declares all of its properties in its base rule:
    /// <list type="bullet">
    /// <item><c>--dui-t: "background-color scale"</c>: the properties the element transitions.</item>
    /// <item><c>--dui-t-&lt;property&gt;: "&lt;value&gt;|&lt;duration ms&gt; &lt;delay ms&gt; &lt;timing function&gt;"</c>, in
    /// every rule that sets the property: the rule's value and the transition in effect when that rule wins (empty after
    /// the bar: none). An empty value means the element's own computed value.</item>
    /// <item><c>--dui-a: "&lt;anim&gt;;&lt;anim&gt;"</c>, in every rule that sets animation properties: the animation list, each
    /// <c>&lt;name&gt; &lt;keyframes&gt; &lt;duration ms&gt; &lt;delay ms&gt; &lt;iterations|infinite&gt; &lt;direction&gt; &lt;fill&gt;
    /// &lt;running|paused&gt; &lt;timing function&gt;</c> (empty: none). A name written <c>+name</c> in a trigger layer's list
    /// is an animation that layer starts (not one of base's): when the element's first style already has that layer (the
    /// artboard starts in it), it shows its end frame instead of playing.</item>
    /// <item><c>--dui-k-&lt;n&gt;: "&lt;offset&gt;|&lt;easing&gt;|&lt;property&gt;=&lt;value&gt;&amp;…;…"</c>: keyframe set n, one
    /// frame per <c>;</c> (an empty easing: the animation's timing function).</item>
    /// </list>
    /// Parsed strings are cached by content, so a style change parses nothing new and allocates nothing in steady state.
    /// </summary>
    public static class DesignAnimationData
    {
        /// <summary>The class of every element the player watches.</summary>
        public const string MarkerClass = "dui-anim";
        public const string TransitionListProperty = "--dui-t";
        public const string TransitionPrefix = "--dui-t-";
        public const string AnimationListProperty = "--dui-a";
        public const string KeyframesPrefix = "--dui-k-";

        /// <summary>The name used in <c>--dui-t-&lt;name&gt;</c> (USS custom property names: the tint colour is <c>tint</c>).</summary>
        public static string CustomName(DesignAnimProperty p) => p == DesignAnimProperty.TintColor ? "tint" : DesignAnimProperties.Name(p);

        static readonly CustomStyleProperty<string>[] s_TransitionKeys = BuildTransitionKeys();
        static readonly List<CustomStyleProperty<string>> s_KeyframeKeys = new List<CustomStyleProperty<string>>();
        internal static readonly CustomStyleProperty<string> TransitionListKey = new CustomStyleProperty<string>(TransitionListProperty);
        internal static readonly CustomStyleProperty<string> AnimationListKey = new CustomStyleProperty<string>(AnimationListProperty);

        static CustomStyleProperty<string>[] BuildTransitionKeys()
        {
            var keys = new CustomStyleProperty<string>[DesignAnimProperties.Count];
            for (int i = 0; i < keys.Length; i++) keys[i] = new CustomStyleProperty<string>(TransitionPrefix + CustomName((DesignAnimProperty)i));
            return keys;
        }

        internal static CustomStyleProperty<string> TransitionKey(DesignAnimProperty p) => s_TransitionKeys[(int)p];

        internal static CustomStyleProperty<string> KeyframesKey(int index)
        {
            while (s_KeyframeKeys.Count <= index) s_KeyframeKeys.Add(new CustomStyleProperty<string>(KeyframesPrefix + s_KeyframeKeys.Count.ToString(CultureInfo.InvariantCulture)));
            return s_KeyframeKeys[index];
        }

        // ---- parsed forms ----------------------------------------------------------------------------------------------

        /// <summary>One rule's <c>--dui-t-&lt;property&gt;</c>: its value and the transition in effect when it wins.</summary>
        public sealed class TransitionEntry
        {
            /// <summary>False: the element's own computed value (the rule's value was not known at compile time).</summary>
            public bool HasValue;
            public DesignAnimValue Value;
            /// <summary>False: no transition (the value changes at once).</summary>
            public bool Animates;
            public double Duration, Delay;
            public DesignTimingFunction Timing;
        }

        public enum Direction : byte { Normal, Reverse, Alternate, AlternateReverse }

        [Flags]
        public enum Fill : byte { None = 0, Forwards = 1, Backwards = 2, Both = 3 }

        /// <summary>One animation of a <c>--dui-a</c> list.</summary>
        public sealed class Animation
        {
            public string Name;
            /// <summary>Started by a trigger layer (<c>+name</c>): ended, not played, when the element's first style has that layer.</summary>
            public bool Layer;
            public int Keyframes;
            public double Duration, Delay;
            /// <summary><see cref="double.PositiveInfinity"/> for infinite.</summary>
            public double Iterations;
            public Direction Direction;
            public Fill Fill;
            public bool Paused;
            public DesignTimingFunction Timing;
        }

        /// <summary>A keyframe set: per property, its keyframes (offset, value, the easing of the segment that starts there).</summary>
        public sealed class KeyframeSet
        {
            public PropertyFrames[] Properties;
        }

        public sealed class PropertyFrames
        {
            public DesignAnimProperty Property;
            public double[] Offsets;
            public DesignAnimValue[] Values;
            /// <summary>False where the frame names no easing (the animation's timing function applies).</summary>
            public bool[] HasEasing;
            public DesignTimingFunction[] Easings;
        }

        static readonly Dictionary<string, TransitionEntry>[] s_Entries = BuildEntryCaches();
        static readonly Dictionary<string, DesignAnimProperty[]> s_Lists = new Dictionary<string, DesignAnimProperty[]>(StringComparer.Ordinal);
        static readonly Dictionary<string, Animation[]> s_Anims = new Dictionary<string, Animation[]>(StringComparer.Ordinal);
        static readonly Dictionary<string, KeyframeSet> s_Sets = new Dictionary<string, KeyframeSet>(StringComparer.Ordinal);

        static Dictionary<string, TransitionEntry>[] BuildEntryCaches()
        {
            var a = new Dictionary<string, TransitionEntry>[DesignAnimProperties.Count];
            for (int i = 0; i < a.Length; i++) a[i] = new Dictionary<string, TransitionEntry>(StringComparer.Ordinal);
            return a;
        }

        static FormatException Bad(string what, string text, string why) => new FormatException("animation data " + what + " \"" + text + "\": " + why);

        /// <summary>A <c>--dui-t</c> list: the transitioned properties (unknown names are an error).</summary>
        public static DesignAnimProperty[] ParseTransitionList(string text)
        {
            if (s_Lists.TryGetValue(text, out var hit)) return hit;
            var parts = text.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
            var list = new DesignAnimProperty[parts.Length];
            for (int i = 0; i < parts.Length; i++)
            {
                var name = parts[i] == "tint" ? "-unity-background-image-tint-color" : parts[i];
                if (!DesignAnimProperties.TryGet(name, out list[i])) throw Bad(TransitionListProperty, text, "'" + parts[i] + "' is not a property the player animates");
            }
            s_Lists[text] = list;
            return list;
        }

        /// <summary>A <c>--dui-t-&lt;property&gt;</c> entry.</summary>
        public static TransitionEntry ParseTransition(DesignAnimProperty p, string text)
        {
            var cache = s_Entries[(int)p];
            if (cache.TryGetValue(text, out var hit)) return hit;
            int bar = text.IndexOf('|');
            if (bar < 0) throw Bad(TransitionPrefix + CustomName(p), text, "no '|' between the value and the transition");
            var e = new TransitionEntry();
            var value = text.Substring(0, bar).Trim();
            if (value.Length > 0)
            {
                if (!DesignAnimProperties.TryParse(p, value, out e.Value)) throw Bad(TransitionPrefix + CustomName(p), text, "'" + value + "' is not a value of " + DesignAnimProperties.Name(p));
                e.HasValue = true;
            }
            var t = text.Substring(bar + 1).Trim();
            if (t.Length > 0)
            {
                var parts = t.Split(new[] { ' ' }, 3, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length != 3 || !Ms(parts[0], out e.Duration) || !Ms(parts[1], out e.Delay) || !DesignTimingFunction.TryParse(parts[2], out e.Timing))
                    throw Bad(TransitionPrefix + CustomName(p), text, "the transition is not '<duration ms> <delay ms> <timing function>'");
                e.Animates = e.Duration > 0 || e.Delay > 0;
            }
            cache[text] = e;
            return e;
        }

        /// <summary>A <c>--dui-a</c> list.</summary>
        public static Animation[] ParseAnimations(string text)
        {
            if (s_Anims.TryGetValue(text, out var hit)) return hit;
            var items = text.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            var list = new List<Animation>();
            foreach (var raw in items)
            {
                var item = raw.Trim();
                if (item.Length == 0) continue;
                var f = item.Split(new[] { ' ' }, 9, StringSplitOptions.RemoveEmptyEntries);
                var a = new Animation { Name = f.Length > 0 ? f[0] : "" };
                if (a.Name.StartsWith("+", StringComparison.Ordinal)) { a.Layer = true; a.Name = a.Name.Substring(1); }
                if (f.Length != 9 || !int.TryParse(f[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out a.Keyframes) || a.Keyframes < 0 ||
                    !Ms(f[2], out a.Duration) || !Ms(f[3], out a.Delay) || !Iterations(f[4], out a.Iterations) ||
                    !TryDirection(f[5], out a.Direction) || !TryFill(f[6], out a.Fill) || (f[7] != "running" && f[7] != "paused") ||
                    !DesignTimingFunction.TryParse(f[8], out a.Timing))
                    throw Bad(AnimationListProperty, text, "'" + item + "' is not '<name> <keyframes> <duration ms> <delay ms> <iterations> <direction> <fill> <play state> <timing function>'");
                a.Paused = f[7] == "paused";
                list.Add(a);
            }
            var arr = list.ToArray();
            s_Anims[text] = arr;
            return arr;
        }

        /// <summary>A <c>--dui-k-&lt;n&gt;</c> keyframe set.</summary>
        public static KeyframeSet ParseKeyframes(string text)
        {
            if (s_Sets.TryGetValue(text, out var hit)) return hit;
            var byProp = new SortedDictionary<int, List<(double offset, DesignAnimValue value, bool hasEasing, DesignTimingFunction easing)>>();
            foreach (var raw in text.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var frame = raw.Trim();
                if (frame.Length == 0) continue;
                var f = frame.Split(new[] { '|' }, 3);
                if (f.Length != 3 || !double.TryParse(f[0].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var offset) || offset < 0 || offset > 1)
                    throw Bad(KeyframesPrefix + "n", text, "'" + frame + "' is not '<offset>|<easing>|<property>=<value>&…'");
                var easingText = f[1].Trim();
                var easing = DesignTimingFunction.Linear;
                bool hasEasing = easingText.Length > 0;
                if (hasEasing && !DesignTimingFunction.TryParse(easingText, out easing)) throw Bad(KeyframesPrefix + "n", text, "'" + easingText + "' is not a timing function");
                foreach (var decl in f[2].Split(new[] { '&' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    int eq = decl.IndexOf('=');
                    var name = eq < 0 ? decl : decl.Substring(0, eq).Trim();
                    if (name == "tint") name = "-unity-background-image-tint-color";
                    if (eq < 0 || !DesignAnimProperties.TryGet(name, out var p)) throw Bad(KeyframesPrefix + "n", text, "'" + decl + "' is not '<animated property>=<value>'");
                    if (!DesignAnimProperties.TryParse(p, decl.Substring(eq + 1), out var v)) throw Bad(KeyframesPrefix + "n", text, "'" + decl + "' has no value the player can animate");
                    if (!byProp.TryGetValue((int)p, out var list)) byProp[(int)p] = list = new List<(double, DesignAnimValue, bool, DesignTimingFunction)>();
                    list.Add((offset, v, hasEasing, easing));
                }
            }
            var set = new KeyframeSet { Properties = new PropertyFrames[byProp.Count] };
            int k = 0;
            foreach (var kv in byProp)
            {
                // stable by offset: frames at one offset keep their order (the later one wins at that offset)
                var list = kv.Value;
                var order = new List<int>();
                for (int i = 0; i < list.Count; i++) order.Add(i);
                order.Sort((x, y) => list[x].offset != list[y].offset ? list[x].offset.CompareTo(list[y].offset) : x.CompareTo(y));
                var pf = new PropertyFrames
                {
                    Property = (DesignAnimProperty)kv.Key,
                    Offsets = new double[list.Count], Values = new DesignAnimValue[list.Count], HasEasing = new bool[list.Count], Easings = new DesignTimingFunction[list.Count],
                };
                for (int i = 0; i < order.Count; i++)
                {
                    var x = list[order[i]];
                    pf.Offsets[i] = x.offset; pf.Values[i] = x.value; pf.HasEasing[i] = x.hasEasing; pf.Easings[i] = x.easing;
                }
                set.Properties[k++] = pf;
            }
            s_Sets[text] = set;
            return set;
        }

        static bool Ms(string s, out double ms) =>
            double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out ms) && !double.IsNaN(ms) && !double.IsInfinity(ms) && ms >= 0;

        static bool Iterations(string s, out double n)
        {
            if (s == "infinite") { n = double.PositiveInfinity; return true; }
            return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out n) && !double.IsNaN(n) && n >= 0;
        }

        static bool TryDirection(string s, out Direction d)
        {
            switch (s)
            {
                case "normal": d = Direction.Normal; return true;
                case "reverse": d = Direction.Reverse; return true;
                case "alternate": d = Direction.Alternate; return true;
                case "alternate-reverse": d = Direction.AlternateReverse; return true;
                default: d = Direction.Normal; return false;
            }
        }

        static bool TryFill(string s, out Fill f)
        {
            switch (s)
            {
                case "none": f = Fill.None; return true;
                case "forwards": f = Fill.Forwards; return true;
                case "backwards": f = Fill.Backwards; return true;
                case "both": f = Fill.Both; return true;
                default: f = Fill.None; return false;
            }
        }

        // ---- CSS animation timing (Web Animations Level 1, 4.4–4.9) -----------------------------------------------------

        /// <summary>
        /// The directed iteration progress of an animation <paramref name="local"/> ms after it started (its delay included),
        /// and the before flag its keyframe easings use; false when the animation has no effect then (before or after its
        /// active interval without the matching fill). <paramref name="frozen"/>: the frame a static design capture shows
        /// (one iteration, no duration, fill both), which reduced motion holds.
        /// </summary>
        public static bool Progress(Animation a, double local, bool frozen, out double directed, out bool before)
        {
            directed = 0;
            before = false;
            double duration = frozen ? 0 : a.Duration;
            double delay = frozen ? 0 : a.Delay;
            double iterations = frozen ? 1 : a.Iterations;
            var fill = frozen ? Fill.Both : a.Fill;
            if (a.Paused && !frozen) local = 0;
            double active = duration <= 0 || iterations <= 0 ? 0 : duration * iterations;
            int phase; // 0 before, 1 active, 2 after
            if (local < delay) phase = 0;
            else if (!double.IsInfinity(active) && local >= delay + active) phase = 2;
            else phase = 1;
            double activeTime;
            if (phase == 0)
            {
                if ((fill & Fill.Backwards) == 0) return false;
                activeTime = 0;
            }
            else if (phase == 2)
            {
                if ((fill & Fill.Forwards) == 0) return false;
                activeTime = active;
            }
            else activeTime = local - delay;

            double overall = duration <= 0 ? (phase == 0 ? 0 : iterations) : activeTime / duration;
            double simple;
            if (double.IsInfinity(overall)) simple = 0;
            else
            {
                simple = overall - Math.Floor(overall);
                if (simple == 0 && phase != 0 && activeTime == active && iterations != 0) simple = 1;
            }
            double iteration;
            if (phase == 2 && double.IsInfinity(iterations)) iteration = double.PositiveInfinity;
            else if (simple == 1) iteration = Math.Floor(overall) - 1;
            else iteration = Math.Floor(overall);

            bool forwards;
            switch (a.Direction)
            {
                case Direction.Reverse: forwards = false; break;
                case Direction.Alternate: forwards = double.IsInfinity(iteration) || iteration % 2 == 0; break;
                case Direction.AlternateReverse: forwards = !double.IsInfinity(iteration + 1) && (iteration + 1) % 2 == 0; break;
                default: forwards = true; break;
            }
            directed = forwards ? simple : 1 - simple;
            before = (phase == 0 && forwards) || (phase == 2 && !forwards);
            return true;
        }

        /// <summary>
        /// The value of one property's keyframes at directed progress <paramref name="x"/> (Web Animations 4.11 "the effect
        /// value of a keyframe effect"): implicit 0 % and 100 % frames hold <paramref name="underlying"/>; each segment eases
        /// with its start frame's easing, else <paramref name="timing"/>.
        /// </summary>
        public static DesignAnimValue Evaluate(PropertyFrames f, double x, bool before, DesignTimingFunction timing, in DesignAnimValue underlying)
        {
            var offsets = f.Offsets;
            int n = offsets.Length;
            bool implicitStart = offsets[0] > 0, implicitEnd = offsets[n - 1] < 1;
            // the property-specific frame list with the implicit ends: index -1 is the 0 % frame, index n the 100 % frame
            int first = implicitStart ? -1 : 0, last = implicitEnd ? n : n - 1;
            if (x >= 1)
            {
                // several frames at 100 %: the last one
                return implicitEnd ? underlying : f.Values[n - 1];
            }
            // start frame: the last frame whose offset <= x and < 1; else the last frame at offset 0
            int start = first;
            for (int i = first; i <= last; i++)
            {
                double o = OffsetAt(f, i);
                if (o <= x && o < 1) start = i;
            }
            int end = Math.Min(start + 1, last);
            double so = OffsetAt(f, start), eo = OffsetAt(f, end);
            var sv = start < 0 ? underlying : start >= n ? underlying : f.Values[start];
            var ev = end < 0 ? underlying : end >= n ? underlying : f.Values[end];
            if (end == start || eo <= so) return ev;
            double local = (x - so) / (eo - so);
            var easing = start >= 0 && start < n && f.HasEasing[start] ? f.Easings[start] : timing;
            return DesignAnimProperties.Interpolate(f.Property, sv, ev, easing.Evaluate(local, before));
        }

        static double OffsetAt(PropertyFrames f, int i) => i < 0 ? 0 : i >= f.Offsets.Length ? 1 : f.Offsets[i];
    }
}
