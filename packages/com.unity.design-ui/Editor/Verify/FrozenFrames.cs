using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi.Editor
{
    /// <summary>
    /// The frame a static golden shows for a keyframe animation in effect. The exporter freezes every animation at the end
    /// of one iteration with fill both (design-export load.ts, STATIC_CSS), so the last keyframe of that iteration holds:
    /// offset 1, or offset 0 for the directions reverse and alternate-reverse; a property that frame does not set keeps the
    /// element's own value. The golden records which animations were in effect (matrix.json <c>frozen</c>); the capture
    /// writes their frame as inline styles, as the animation player will once it plays them.
    /// </summary>
    internal static class FrozenFrames
    {
        /// <summary>The values the frozen frame sets: the keyframe at the end of one iteration.</summary>
        internal static IReadOnlyDictionary<string, string> EndValues(IrAnim anim)
        {
            if (anim == null) throw new ArgumentNullException(nameof(anim));
            var backwards = anim.Direction == "reverse" || anim.Direction == "alternate-reverse";
            var end = backwards ? 0f : 1f;
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            // several keyframes at one offset: CSS applies them in order, a later one wins per property
            foreach (var k in (anim.Keyframes ?? new List<IrKeyframe>()).Where(k => Mathf.Abs(k.Offset - end) < 1e-6f))
                foreach (var kv in k.Values) values[kv.Key] = kv.Value;
            return values;
        }

        /// <summary>
        /// Writes the frozen frame of every (element id, animation name) the golden had in effect; the element must have a
        /// keyframe animation of that name. Throws <see cref="NotCapturableException"/> for what it cannot write.
        /// </summary>
        internal static void ApplyAll(VisualElement docRoot, IrScreen ir, IEnumerable<FrozenAnimation> frozen)
        {
            var nodes = new Dictionary<string, IrNode>(StringComparer.Ordinal);
            void Walk(IrNode n) { nodes[n.Id] = n; foreach (var c in n.Children ?? new IrNode[0]) Walk(c); }
            Walk(ir.Root);
            foreach (var f in frozen)
            {
                if (!nodes.TryGetValue(f.ElementId, out var node))
                    throw new NotCapturableException("the golden froze animation '" + f.Name + "' on '" + f.ElementId + "', which is not an IR element");
                var anim = (node.Anims ?? new List<IrAnim>()).LastOrDefault(a => a.Kind == IrAnim.KeyframesKind && a.Name == f.Name)
                           ?? throw new NotCapturableException("the golden froze animation '" + f.Name + "' on '" + f.ElementId + "', which the IR does not record");
                var el = BoxesWriter.Find(docRoot, f.ElementId)
                         ?? throw new NotCapturableException("the golden froze animation '" + f.Name + "' on '" + f.ElementId + "', which the compiled screen has no element for");
                Apply(el, EndValues(anim), node.Asset != null && node.Asset.Tint);
            }
        }

        /// <summary>Writes keyframe values (transform, opacity and colour properties, as the IR writes them) as inline styles.</summary>
        internal static void Apply(VisualElement el, IReadOnlyDictionary<string, string> values, bool tintedImage = false)
        {
            foreach (var kv in values.OrderBy(kv => kv.Key, StringComparer.Ordinal))
            {
                var v = kv.Value.Trim();
                switch (kv.Key)
                {
                    case "translate":
                        el.style.translate = Translation(v);
                        break;
                    case "rotate":
                        el.style.rotate = v == "none" ? new StyleRotate(StyleKeyword.None) : new StyleRotate(new Rotate(Angle(v)));
                        break;
                    case "scale":
                        el.style.scale = ScaleOf(v);
                        break;
                    case "opacity":
                        el.style.opacity = Number(v, kv.Key);
                        break;
                    case "color":
                        el.style.color = ColorOf(v);
                        if (tintedImage) el.style.unityBackgroundImageTintColor = ColorOf(v); // an icon's colour is its tint
                        break;
                    case "background-color":
                        el.style.backgroundColor = ColorOf(v);
                        break;
                    case "border-top-color": el.style.borderTopColor = ColorOf(v); break;
                    case "border-right-color": el.style.borderRightColor = ColorOf(v); break;
                    case "border-bottom-color": el.style.borderBottomColor = ColorOf(v); break;
                    case "border-left-color": el.style.borderLeftColor = ColorOf(v); break;
                    default:
                        throw new NotCapturableException("a frozen keyframe sets '" + kv.Key + "', which the capture cannot write");
                }
            }
        }

        static readonly Regex LengthValue = new Regex(@"^(-?\d*\.?\d+(?:e-?\d+)?)(px|%)?$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
        static readonly Regex AngleValue = new Regex(@"^(-?\d*\.?\d+(?:e-?\d+)?)(deg|rad|grad|turn)?$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

        static string[] Parts(string v) => v.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);

        static float Number(string v, string what)
        {
            if (!float.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var f))
                throw new NotCapturableException("a frozen keyframe's " + what + " '" + v + "' is not a number");
            return f;
        }

        static Length LengthOf(string v)
        {
            var m = LengthValue.Match(v);
            if (!m.Success || (m.Groups[2].Value.Length == 0 && Number(m.Groups[1].Value, "length") != 0))
                throw new NotCapturableException("a frozen keyframe's length '" + v + "' is not px or %");
            var n = Number(m.Groups[1].Value, "length");
            return m.Groups[2].Value == "%" ? new Length(n, LengthUnit.Percent) : new Length(n, LengthUnit.Pixel);
        }

        /// <summary>CSS translate: one value moves along x only.</summary>
        static StyleTranslate Translation(string v)
        {
            if (v == "none") return new StyleTranslate(StyleKeyword.None);
            var p = Parts(v);
            if (p.Length < 1 || p.Length > 2) throw new NotCapturableException("a frozen keyframe's translate '" + v + "' is not one or two lengths");
            return new StyleTranslate(new Translate(LengthOf(p[0]), p.Length > 1 ? LengthOf(p[1]) : new Length(0, LengthUnit.Pixel)));
        }

        static UnityEngine.UIElements.Angle Angle(string v)
        {
            var m = AngleValue.Match(v);
            if (!m.Success) throw new NotCapturableException("a frozen keyframe's rotate '" + v + "' is not an angle");
            var n = Number(m.Groups[1].Value, "rotate");
            switch (m.Groups[2].Value.ToLowerInvariant())
            {
                case "rad": return UnityEngine.UIElements.Angle.Radians(n);
                case "grad": return UnityEngine.UIElements.Angle.Gradians(n);
                case "turn": return UnityEngine.UIElements.Angle.Turns(n);
                case "deg": return UnityEngine.UIElements.Angle.Degrees(n);
                default:
                    if (n != 0) throw new NotCapturableException("a frozen keyframe's rotate '" + v + "' has no unit");
                    return UnityEngine.UIElements.Angle.Degrees(0);
            }
        }

        /// <summary>CSS scale: one value scales both axes.</summary>
        static StyleScale ScaleOf(string v)
        {
            if (v == "none") return new StyleScale(StyleKeyword.None);
            var p = Parts(v);
            if (p.Length < 1 || p.Length > 2) throw new NotCapturableException("a frozen keyframe's scale '" + v + "' is not one or two numbers");
            var x = Number(p[0], "scale");
            var y = p.Length > 1 ? Number(p[1], "scale") : x;
            return new StyleScale(new Scale(new Vector2(x, y)));
        }

        static readonly Regex Rgba = new Regex(@"^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

        internal static Color ColorOf(string v)
        {
            if (v == "transparent") return new Color(0, 0, 0, 0);
            if (v.StartsWith("#", StringComparison.Ordinal) && ColorUtility.TryParseHtmlString(v, out var hex)) return hex;
            var m = Rgba.Match(v);
            if (m.Success)
            {
                float C(int g) => Number(m.Groups[g].Value, "colour") / 255f;
                var a = 1f;
                if (m.Groups[4].Success)
                {
                    var t = m.Groups[4].Value;
                    a = t.EndsWith("%", StringComparison.Ordinal) ? Number(t.TrimEnd('%'), "colour") / 100f : Number(t, "colour");
                }
                return new Color(C(1), C(2), C(3), a);
            }
            throw new NotCapturableException("a frozen keyframe's colour '" + v + "' is not #hex, rgb() or rgba()");
        }
    }

    /// <summary>A keyframe animation the golden had in effect in a static capture (matrix.json <c>frozen</c>).</summary>
    public sealed class FrozenAnimation
    {
        public string ElementId;
        public string Name;
        public override string ToString() => Name + " on " + ElementId;
    }
}
