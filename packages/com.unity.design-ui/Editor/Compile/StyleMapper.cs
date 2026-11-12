using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace DesignUi.Editor
{
    public readonly struct UssDeclaration : IEquatable<UssDeclaration>
    {
        public readonly string Property;
        public readonly string Value;

        public UssDeclaration(string property, string value)
        {
            Property = property;
            Value = value;
        }

        public bool Equals(UssDeclaration other) => Property == other.Property && Value == other.Value;
        public override bool Equals(object obj) => obj is UssDeclaration o && Equals(o);
        public override int GetHashCode() => (Property ?? "").GetHashCode() * 397 ^ (Value ?? "").GetHashCode();
        public override string ToString() => Property + ": " + Value;
    }

    public sealed class UnsupportedStyleException : Exception
    {
        public readonly string Property;
        public readonly string Value;
        public readonly string RuleId;
        public readonly string Fix;

        public UnsupportedStyleException(string property, string value, string ruleId = null, string fix = null)
            : base("CSS declaration is outside the supported UI Toolkit set: " + property + ": " + value +
                   (ruleId != null ? " (" + ruleId + ")" : "") + (fix != null ? ". " + fix : ""))
        {
            Property = property;
            Value = value;
            RuleId = ruleId;
            Fix = fix;
        }
    }

    /// <summary>
    /// CSS to USS mapping (spec 5.3). Which properties and values are valid is decided by css-support.json; this class
    /// emits the USS and combines the properties that share one USS property (font style, text alignment, white space).
    /// </summary>
    public static class StyleMapper
    {
        static readonly Dictionary<string, string[]> Shorthands = new Dictionary<string, string[]>
        {
            { "margin", new[] { "margin-top", "margin-right", "margin-bottom", "margin-left" } },
            { "padding", new[] { "padding-top", "padding-right", "padding-bottom", "padding-left" } },
            { "border-width", new[] { "border-top-width", "border-right-width", "border-bottom-width", "border-left-width" } },
            { "border-color", new[] { "border-top-color", "border-right-color", "border-bottom-color", "border-left-color" } },
            { "border-radius", new[] { "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius" } },
            { "flex", new[] { "flex-grow", "flex-shrink", "flex-basis" } },
            { "transition", new[] { "transition-property", "transition-duration", "transition-delay", "transition-timing-function" } },
            { "overflow", new[] { "overflow-x", "overflow-y" } },
            { "white-space", new[] { "white-space-collapse", "text-wrap-mode" } },
        };

        /// <summary>Maps a base layer. The layer is its own cascade and the node is treated as a text element.</summary>
        public static IReadOnlyList<UssDeclaration> Map(IReadOnlyDictionary<string, string> css) => Map(css, css, true);

        /// <summary>
        /// Maps one layer of a node. <paramref name="baseCss"/> is the node's base layer: properties that combine into
        /// one USS property (font style, text alignment, white space) are computed from base overlaid with the layer.
        /// Text alignment is emitted for text elements only (USS inherits it, so containers must not carry it).
        /// </summary>
        public static IReadOnlyList<UssDeclaration> Map(IReadOnlyDictionary<string, string> css, IReadOnlyDictionary<string, string> baseCss, bool isText)
        {
            var result = new List<UssDeclaration>();
            if (css == null) return result;
            var support = CssSupport.Default;

            string Merged(string prop) => css.TryGetValue(prop, out var v) ? v.Trim() : baseCss != null && baseCss.TryGetValue(prop, out var b) ? b.Trim() : null;
            bool Has(string prop) => css.ContainsKey(prop);

            foreach (var kv in Shorthands)
                if (Has(kv.Key) && kv.Value.Any(Has))
                    throw new UnsupportedStyleException(kv.Key, css[kv.Key], null, "A shorthand and one of its longhands are in the same layer; the exporter writes longhands only.");

            bool isLayer = !ReferenceEquals(css, baseCss) && baseCss != null;

            foreach (var key in css.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                var value = (css[key] ?? "").Trim();
                if (!support.TryGet(key, out var spec))
                    throw new UnsupportedStyleException(key, value, CssSupport.UnknownPropertyRule, "Property '" + key + "' is not in css-support.json.");
                switch (spec.Handling)
                {
                    case CssHandling.Error:
                        throw new UnsupportedStyleException(key, value, spec.Rule, spec.Fix);
                    case CssHandling.Lowered:
                        throw new UnsupportedStyleException(key, value, null, "'" + key + "' must be lowered before mapping (" + (spec.Fix ?? "Lowering.Apply") + ").");
                    case CssHandling.Dropped:
                        if (spec.Keywords.Length > 0 || spec.Functions.Length > 0) support.ValidateValue(spec, value);
                        if (isLayer && key == "background-image")
                            throw new UnsupportedStyleException(key, value, null, "A gradient is baked from the base layer only; a state or breakpoint layer cannot change it.");
                        continue;
                }

                if (Array.IndexOf(spec.DropValues, value) >= 0)
                {
                    if (isLayer)
                        throw new UnsupportedStyleException(key, value, null, "'" + key + ": " + value + "' in a state or breakpoint layer cannot undo a base value.");
                    continue;
                }
                support.ValidateValue(spec, value);
                if (spec.MapValues.TryGetValue(value, out var mapped)) value = mapped;

                switch (key)
                {
                    case "font-weight": case "font-style":
                    case "text-align": case "white-space": case "white-space-collapse": case "text-wrap-mode":
                    case "overflow": case "overflow-x": case "overflow-y": case "font-family":
                        break; // composed below
                    case "aspect-ratio":
                        result.Add(new UssDeclaration(key, AspectRatio(value)));
                        break;
                    case "text-shadow":
                        if (value == "none")
                        {
                            // USS has no none; a layer that removes a base shadow resets it
                            if (isLayer && baseCss.TryGetValue("text-shadow", out var bts) && bts.Trim() != "none")
                                result.Add(new UssDeclaration(key, "initial"));
                        }
                        else result.Add(new UssDeclaration(key, value));
                        break;
                    default:
                        result.Add(new UssDeclaration(key, value));
                        break;
                }
            }

            // overflow: the shorthand, or equal overflow-x / overflow-y longhands
            if (Has("overflow")) result.Add(new UssDeclaration("overflow", Normalize(support, "overflow", css["overflow"])));
            else if (Has("overflow-x") || Has("overflow-y"))
            {
                var x = Normalize(support, "overflow-x", Has("overflow-x") ? css["overflow-x"] : "visible");
                var y = Normalize(support, "overflow-y", Has("overflow-y") ? css["overflow-y"] : "visible");
                if (x != y) throw new UnsupportedStyleException("overflow-x/overflow-y", x + " / " + y, null, "Use the same overflow on both axes.");
                result.Add(new UssDeclaration("overflow", x));
            }

            // border-style none makes the used width 0 in CSS; USS borders have no style
            var sides = new[] { "top", "right", "bottom", "left" };
            var noneSides = new List<string>();
            if (css.TryGetValue("border-style", out var borderStyle))
            {
                var comps = borderStyle.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (comps.All(c => c == "none")) noneSides.AddRange(sides);
                else if (comps.Any(c => c == "none"))
                    throw new UnsupportedStyleException("border-style", borderStyle, null, "Mixed none and solid border sides in the shorthand; write the longhands.");
            }
            foreach (var side in sides)
                if (css.TryGetValue("border-" + side + "-style", out var sideStyle) && sideStyle.Trim() == "none" && !noneSides.Contains(side)) noneSides.Add(side);
            if (noneSides.Count == 4) result.RemoveAll(d => d.Property == "border-width");
            foreach (var side in noneSides)
            {
                result.RemoveAll(d => d.Property == "border-" + side + "-width");
                result.Add(new UssDeclaration("border-" + side + "-width", "0"));
            }

            if (Has("font-family"))
                result.Add(new UssDeclaration("-unity-font-definition", "var(--font-" + FamilySlug(css["font-family"]) + ")"));

            if (Has("font-weight") || Has("font-style"))
                result.Add(new UssDeclaration("-unity-font-style", FontStyle(Merged("font-weight"), Merged("font-style"))));

            if (Has("white-space") || Has("white-space-collapse") || Has("text-wrap-mode"))
                result.Add(new UssDeclaration("white-space", WhiteSpace(Merged("white-space"), Merged("white-space-collapse"), Merged("text-wrap-mode"), Has("white-space"))));

            if (isText && (Has("text-align") || Has("align-items") || Has("justify-content") || Has("flex-direction") || Has("display")))
            {
                var ta = TextAlign(Merged("text-align"), Merged("display"), Merged("flex-direction"), Merged("align-items"), Merged("justify-content"));
                if (ta != null) result.Add(new UssDeclaration("-unity-text-align", ta));
            }

            // shorthands first, then longhands, each ordinal: a later longhand always overrides its shorthand
            return result
                .OrderBy(d => Shorthands.ContainsKey(d.Property) ? 0 : 1)
                .ThenBy(d => d.Property, StringComparer.Ordinal)
                .ToList();
        }

        static string Normalize(CssSupport support, string key, string value)
        {
            support.TryGet(key, out var spec);
            value = value.Trim();
            support.ValidateValue(spec, value);
            return spec.MapValues.TryGetValue(value, out var m) ? m : value;
        }

        static string FontStyle(string weight, string style)
        {
            var w = weight ?? "normal";
            var s = style ?? "normal";
            bool bold = w == "700" || w == "bold";
            bool italic = s == "italic";
            return bold && italic ? "bold-and-italic" : bold ? "bold" : italic ? "italic" : "normal";
        }

        static string WhiteSpace(string shorthand, string collapse, string wrapMode, bool shorthandInLayer)
        {
            if (shorthandInLayer) return shorthand;
            var c = collapse ?? "collapse";
            var w = wrapMode ?? "wrap";
            if (c == "collapse") return w == "wrap" ? "normal" : "nowrap";
            return w == "nowrap" ? "pre" : "pre-wrap";
        }

        static readonly Regex Slug = new Regex(@"[^a-z0-9]+", RegexOptions.Compiled);

        static string FamilySlug(string value)
        {
            var first = CssSupport.SplitTop(value, ',')[0].Trim().Trim('"', '\'').ToLowerInvariant();
            var slug = Slug.Replace(first, "-").Trim('-');
            if (slug.Length == 0) throw new UnsupportedStyleException("font-family", value);
            return slug;
        }

        static string AspectRatio(string value)
        {
            var parts = value.Split('/');
            if (parts.Length == 1) return value.Trim();
            double a = double.Parse(parts[0].Trim(), CultureInfo.InvariantCulture);
            double b = double.Parse(parts[1].Trim(), CultureInfo.InvariantCulture);
            if (b == 0) throw new UnsupportedStyleException("aspect-ratio", value);
            return (a / b).ToString("0.######", CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// A plain text element aligns with text-align (vertical: top). A flex text element is one anonymous flex item:
        /// along the main axis justify-content places it, along the cross axis align-items does. Horizontal part: from
        /// justify-content in a row and align-items in a column when they move the item off the start edge, otherwise
        /// text-align; vertical part from the other axis. Reverse directions flip the main axis.
        /// </summary>
        static string TextAlign(string textAlign, string display, string direction, string alignItems, string justify)
        {
            string fallback;
            switch (textAlign)
            {
                case null: case "left": case "start": fallback = "left"; break;
                case "center": fallback = "center"; break;
                case "right": case "end": fallback = "right"; break;
                default: throw new UnsupportedStyleException("text-align", textAlign);
            }
            if (display != "flex")
                return textAlign == null ? null : "upper-" + fallback;

            bool column = direction == "column" || direction == "column-reverse";
            bool reverse = direction == "row-reverse" || direction == "column-reverse";

            // main axis position of the item: 0 start, 1 center, 2 end (start = flex-start of the container direction)
            int Main(string j)
            {
                switch (j)
                {
                    case "center": case "space-around": case "space-evenly": return 1;
                    case "flex-end": return 2;
                    default: return 0;
                }
            }
            int Cross(string a)
            {
                switch (a)
                {
                    case "center": return 1;
                    case "flex-end": return 2;
                    default: return 0; // flex-start, stretch
                }
            }

            int main = Main(justify), cross = Cross(alignItems);
            if (reverse) main = main == 0 ? 2 : main == 2 ? 0 : main;

            int h, v; // 0 start, 1 center, 2 end along the screen axes
            if (column) { v = main; h = cross; }
            else { h = main; v = cross; }

            string hs;
            bool horizontalDerived = column ? (alignItems == "center" || alignItems == "flex-end") : (h != 0 || reverse);
            if (horizontalDerived) hs = h == 0 ? "left" : h == 1 ? "center" : "right";
            else hs = fallback;
            return (v == 0 ? "upper" : v == 1 ? "middle" : "lower") + "-" + hs;
        }
    }
}
