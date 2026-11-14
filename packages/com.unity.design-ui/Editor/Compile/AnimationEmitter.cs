using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using DesignUi;

namespace DesignUi.Editor
{
    /// <summary>
    /// Writes a lowered node's transitions and keyframe animations (<see cref="IrNode.Anims"/>) as the USS custom properties
    /// the runtime <see cref="DesignUiAnimationPlayer"/> reads (<see cref="DesignAnimationData"/>), next to the values they
    /// belong to, so UI Toolkit's cascade gives the player the data of the rule that wins:
    /// <list type="bullet">
    /// <item>A transitioned property P: in base and in every layer that sets P, <c>--dui-t-P: "&lt;value&gt;|&lt;transition&gt;"</c>
    /// with the transition in effect when that layer wins: a layer's own <c>enter</c> transition of P, and in base the
    /// base transition (the <c>leave</c> transitions, as CSS uses the after-change style). Base declares <c>--dui-t</c>,
    /// the list of P.</item>
    /// <item>Keyframe animations: base (<c>show</c>) and every layer that triggers animations get <c>--dui-a</c>, the
    /// animation list in effect while that layer wins (empty in a layer with <c>animation: none</c>, an IR keyframes entry
    /// without a name); base declares every keyframe set as <c>--dui-k-&lt;n&gt;</c>.</item>
    /// </list>
    /// Delays are written as recorded, negative ones too (the animation starts inside its timeline). An animated node gets
    /// the marker class <see cref="DesignAnimationData.MarkerClass"/>. A tinted icon's colour animates its tint too.
    /// Keyframe shorthands (<c>border-color</c>, <c>border-radius</c>) are written as longhands; <c>currentcolor</c> is the
    /// node's colour. Keyframes of a property the player cannot animate (a layout property among them) are U-CSS-013; a
    /// transitioned property the player cannot animate changes at once (lint U-CSS-042 rejects it); <see cref="Notes"/>
    /// says so.
    /// </summary>
    public sealed class AnimationEmitter
    {
        const string Base = "base";

        readonly Dictionary<string, List<UssDeclaration>> m_ByLayer = new Dictionary<string, List<UssDeclaration>>(StringComparer.Ordinal);

        /// <summary>Layer keys (canonical) that carry animation declarations, base first.</summary>
        public IReadOnlyCollection<string> Layers => m_ByLayer.Keys;

        /// <summary>Remarks for the compile log (transitioned properties the player does not animate).</summary>
        public readonly List<string> Notes = new List<string>();

        /// <summary>The declarations to add to layer <paramref name="key"/> (canonical), possibly none.</summary>
        public IReadOnlyList<UssDeclaration> For(string key) =>
            m_ByLayer.TryGetValue(key, out var list) ? (IReadOnlyList<UssDeclaration>)list : Array.Empty<UssDeclaration>();

        List<UssDeclaration> Layer(string key)
        {
            if (!m_ByLayer.TryGetValue(key, out var list)) m_ByLayer[key] = list = new List<UssDeclaration>();
            return list;
        }

        /// <summary>The animation declarations of <paramref name="node"/>, or null when it has no animation the player plays.</summary>
        public static AnimationEmitter Of(IrNode node)
        {
            var anims = node.Anims ?? new List<IrAnim>();
            if (anims.Count == 0) return null;
            var e = new AnimationEmitter();
            bool tinted = (node.Asset != null && node.Asset.Tint) || (node.Background != null && node.Background.Tint);
            var transitions = anims.Where(a => a.Kind == IrAnim.Transition).ToList();
            var keyframes = anims.Where(a => a.Kind == IrAnim.KeyframesKind).ToList();
            e.Transitions(node, transitions, tinted);
            e.Keyframes(node, keyframes, tinted);
            return e.m_ByLayer.Count == 0 ? null : e;
        }

        static string Canonical(string trigger) => trigger == LayerKey.ShowTrigger ? Base : LayerKey.Parse(trigger).Text;

        static string Ms(float v) => ScreenBuilder.Number(Math.Max(0f, v));

        /// <summary>A delay in ms as recorded: CSS starts an animation or transition with a negative delay that far into it.</summary>
        static string Delay(float v) => ScreenBuilder.Number(v);

        static string Timing(IrAnim a, string node)
        {
            var t = (a.Timing ?? "ease").Trim();
            if (!DesignTimingFunction.TryParse(t, out _))
                throw new UnsupportedStyleException(a.Kind == IrAnim.Transition ? "transition-timing-function" : "animation-timing-function", t, "U-CSS-008",
                    "Use linear, ease, ease-in, ease-out, ease-in-out, cubic-bezier() or steps() (node '" + node + "').");
            return t;
        }

        // ---- transitions -----------------------------------------------------------------------------------------------

        void Transitions(IrNode node, List<IrAnim> transitions, bool tinted)
        {
            if (transitions.Count == 0) return;
            var props = new List<(string css, DesignAnimProperty p)>();
            foreach (var name in transitions.SelectMany(a => a.Properties ?? new string[0]).Distinct().OrderBy(x => x, StringComparer.Ordinal))
            {
                if (!DesignAnimProperties.TryGet(name, out var p))
                {
                    Notes.Add("'" + node.Id + "': " + name + " changes without a transition (the animation player animates transforms, opacity, colours and border radii; lint U-CSS-042)");
                    continue;
                }
                props.Add((name, p));
                if (tinted && p == DesignAnimProperty.Color) props.Add((name, DesignAnimProperty.TintColor));
            }
            if (props.Count == 0) return;
            var list = new StringBuilder();
            foreach (var (css, p) in props)
            {
                if (list.Length > 0) list.Append(' ');
                list.Append(DesignAnimationData.CustomName(p));
                // base: the transition that runs back to base (any leave of P) is base's own
                var back = transitions.FirstOrDefault(a => a.Phase == "leave" && a.Properties.Contains(css));
                Layer(Base).Add(Decl(p, Value(node, Base, css), back, node.Id));
                foreach (var kv in node.Style)
                {
                    if (kv.Key == Base || !kv.Value.ContainsKey(css)) continue;
                    var key = LayerKey.Parse(kv.Key).Text;
                    var enter = transitions.FirstOrDefault(a => a.Phase == "enter" && Canonical(a.Trigger) == key && a.Properties.Contains(css));
                    Layer(key).Add(Decl(p, Value(node, kv.Key, css), enter, node.Id));
                }
            }
            Layer(Base).Add(new UssDeclaration(DesignAnimationData.TransitionListProperty, Quote(list.ToString())));
        }

        static UssDeclaration Decl(DesignAnimProperty p, string value, IrAnim transition, string node)
        {
            // CSS Transitions: no transition without a positive combined duration (duration + delay)
            var t = transition == null || Math.Max(0f, transition.Duration) + transition.Delay <= 0
                ? ""
                : Ms(transition.Duration) + " " + Delay(transition.Delay) + " " + Timing(transition, node);
            return new UssDeclaration(DesignAnimationData.TransitionPrefix + DesignAnimationData.CustomName(p), Quote((value ?? "") + "|" + t));
        }

        /// <summary>A layer's value of a property for the player: the layer's own CSS value, currentcolor resolved; empty when unknown.</summary>
        static string Value(IrNode node, string layer, string css)
        {
            if (!node.Style.TryGetValue(layer, out var map) || !map.TryGetValue(css, out var v)) return "";
            return Resolved(node, layer, css, v);
        }

        static string Resolved(IrNode node, string layer, string css, string v)
        {
            v = v.Trim();
            if (string.Equals(v, "currentcolor", StringComparison.OrdinalIgnoreCase))
                v = Lowering.Resolve(node, LayerKey.Parse(layer), "color", true) ?? "";
            if (v.Length > 0 && DesignAnimProperties.TryGet(css, out var p) && !DesignAnimProperties.TryParse(p, v, out _))
                throw new UnsupportedStyleException(css, v, "U-CSS-013", "Animate only values the player can interpolate: px or % lengths, numbers, angles, #hex or rgb()/rgba() colours (node '" + node.Id + "').");
            if (v.IndexOfAny(new[] { '"', '|', ';', '&', '=', '\\' }) >= 0)
                throw new IrFormatException("node '" + node.Id + "': the animated value '" + v + "' of " + css + " cannot be written as animation data");
            return v;
        }

        static string Quote(string s) => "\"" + s + "\"";

        // ---- keyframes -------------------------------------------------------------------------------------------------

        static readonly Dictionary<string, string[]> Boxes = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            { "border-color", new[] { "border-top-color", "border-right-color", "border-bottom-color", "border-left-color" } },
            { "border-radius", new[] { "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius" } },
        };

        /// <summary>A keyframe declaration as longhands the player animates (box shorthands with one to four values).</summary>
        static IEnumerable<(string css, DesignAnimProperty p, string value)> Longhands(IrNode node, string name, string value, bool tinted)
        {
            if (Boxes.TryGetValue(name, out var sides))
            {
                var parts = CssSupport.SplitTop(value, ' ').Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
                if (parts.Count < 1 || parts.Count > 4 || value.Contains("/"))
                    throw new UnsupportedStyleException(name, value, "U-CSS-013", "Write one to four values in a keyframe's " + name + " (node '" + node.Id + "').");
                string At(int i) => parts.Count == 1 ? parts[0] : parts.Count == 2 ? parts[i % 2] : parts.Count == 3 ? parts[i == 3 ? 1 : i] : parts[i];
                for (int i = 0; i < 4; i++)
                {
                    DesignAnimProperties.TryGet(sides[i], out var sp);
                    yield return (sides[i], sp, At(i));
                }
                yield break;
            }
            if (!DesignAnimProperties.TryGet(name, out var p))
                throw new UnsupportedStyleException(name, value, "U-CSS-013",
                    "Keyframes animate only transform, translate, rotate, scale, opacity, colours and border radii; for a change of size or position animate translate or scale instead (node '" + node.Id + "').");
            yield return (name, p, value);
            if (tinted && p == DesignAnimProperty.Color) yield return (name, DesignAnimProperty.TintColor, value);
        }

        void Keyframes(IrNode node, List<IrAnim> anims, bool tinted)
        {
            var sets = new List<string>();
            var byLayer = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            // nothing to play: a layer's animation: none alone stops nothing
            if (!anims.Any(a => a.Name != null)) return;
            var shown = new HashSet<string>(anims.Where(a => a.Trigger == LayerKey.ShowTrigger && a.Name != null).Select(a => a.Name), StringComparer.Ordinal);
            foreach (var a in anims)
            {
                if (a.Name == null)
                {
                    // animation: none in the trigger layer: its list is empty, so the element's animations stop while it wins
                    var stop = Canonical(a.Trigger);
                    if (stop == Base) throw new IrFormatException("node '" + node.Id + "': the base layer cannot stop its own animations (animation: none is recorded per layer)");
                    if (!byLayer.ContainsKey(stop)) byLayer[stop] = new List<string>();
                    continue;
                }
                if (a.Name.Length == 0 || a.Name.IndexOfAny(new[] { ' ', ';', '"', '\\' }) >= 0)
                    throw new IrFormatException("node '" + node.Id + "': keyframe animation name '" + a.Name + "' cannot be written as animation data");
                var frames = new StringBuilder();
                foreach (var k in (a.Keyframes ?? new List<IrKeyframe>()).OrderBy(k => k.Offset))
                {
                    if (frames.Length > 0) frames.Append(';');
                    frames.Append(ScreenBuilder.Number(k.Offset)).Append('|');
                    if (!string.IsNullOrEmpty(k.Easing))
                    {
                        if (!DesignTimingFunction.TryParse(k.Easing, out _))
                            throw new UnsupportedStyleException("animation-timing-function", k.Easing, "U-CSS-008", "Use linear, ease, ease-in, ease-out, ease-in-out, cubic-bezier() or steps() (node '" + node.Id + "').");
                        frames.Append(k.Easing.Trim());
                    }
                    frames.Append('|');
                    bool firstDecl = true;
                    foreach (var kv in (k.Values ?? new Dictionary<string, string>()).OrderBy(kv => kv.Key, StringComparer.Ordinal))
                        foreach (var (css, p, value) in Longhands(node, kv.Key, kv.Value, tinted))
                        {
                            if (!firstDecl) frames.Append('&');
                            firstDecl = false;
                            frames.Append(DesignAnimationData.CustomName(p)).Append('=').Append(Resolved(node, Base, css, value));
                        }
                }
                var text = frames.ToString();
                int index = sets.IndexOf(text);
                if (index < 0) { index = sets.Count; sets.Add(text); }
                var key = Canonical(a.Trigger);
                // an animation the layer starts (base does not run it): '+', so a first style already in the layer shows its end
                var entry = (key != Base && !shown.Contains(a.Name) ? "+" : "") + a.Name + " " + index.ToString(CultureInfo.InvariantCulture) + " " + Ms(a.Duration) + " " + Delay(a.Delay) + " " +
                            (float.IsPositiveInfinity(a.Iterations) ? "infinite" : ScreenBuilder.Number(Math.Max(0f, a.Iterations))) + " " +
                            Keyword(a.Direction, "normal", "normal", "reverse", "alternate", "alternate-reverse") + " " +
                            Keyword(a.FillMode, "none", "none", "forwards", "backwards", "both") + " " +
                            Keyword(a.PlayState, "running", "running", "paused") + " " + Timing(a, node.Id);
                if (!byLayer.TryGetValue(key, out var list)) byLayer[key] = list = new List<string>();
                list.Add(entry);
            }
            // base declares the list too (empty: none), so nothing is inherited from a parent's rules
            if (!byLayer.ContainsKey(Base)) byLayer[Base] = new List<string>();
            foreach (var kv in byLayer) Layer(kv.Key).Add(new UssDeclaration(DesignAnimationData.AnimationListProperty, Quote(string.Join(";", kv.Value))));
            for (int i = 0; i < sets.Count; i++)
                Layer(Base).Add(new UssDeclaration(DesignAnimationData.KeyframesPrefix + i.ToString(CultureInfo.InvariantCulture), Quote(sets[i])));
        }

        static string Keyword(string value, string fallback, params string[] allowed)
        {
            var v = string.IsNullOrEmpty(value) ? fallback : value;
            if (Array.IndexOf(allowed, v) < 0) throw new IrFormatException("unknown animation keyword '" + value + "'");
            return v;
        }
    }
}
