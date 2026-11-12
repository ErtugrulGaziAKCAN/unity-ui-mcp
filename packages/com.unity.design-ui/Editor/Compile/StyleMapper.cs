using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
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

        public UnsupportedStyleException(string property, string value)
            : base("CSS declaration is outside the supported UI Toolkit set: " + property + ": " + value)
        {
            Property = property;
            Value = value;
        }
    }

    /// <summary>CSS to USS mapping (spec 5.3). One layer of specified values in, USS declarations out.</summary>
    public static class StyleMapper
    {
        static readonly HashSet<string> Direct = new HashSet<string>
        {
            "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "flex",
            "justify-content", "align-content",
            "top", "right", "bottom", "left",
            "width", "height", "max-width", "max-height",
            "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
            "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
            "border-width", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
            "border-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
            "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
            "opacity", "color", "background-color", "font-size",
            "rotate", "scale", "translate", "transform-origin", "aspect-ratio",
            "text-shadow", "letter-spacing", "word-spacing", "white-space", "text-overflow",
            "transition", "transition-property", "transition-duration", "transition-delay",
        };

        static readonly HashSet<string> Easing = new HashSet<string> { "linear", "ease", "ease-in", "ease-out", "ease-in-out" };
        static readonly Regex ViewportUnit = new Regex(@"\d\s*(vw|vh|vmin|vmax)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        static readonly Regex Slug = new Regex(@"[^a-z0-9]+", RegexOptions.Compiled);

        public static IReadOnlyList<UssDeclaration> Map(IReadOnlyDictionary<string, string> css)
        {
            var result = new List<UssDeclaration>();
            if (css == null) return result;

            css.TryGetValue("align-items", out var alignItems);
            css.TryGetValue("font-weight", out var weight);
            css.TryGetValue("font-style", out var style);

            foreach (var key in css.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                var value = (css[key] ?? "").Trim();
                if (value.IndexOf("calc(", StringComparison.OrdinalIgnoreCase) >= 0 || ViewportUnit.IsMatch(value))
                    throw new UnsupportedStyleException(key, value);

                switch (key)
                {
                    case "line-height":
                    case "box-shadow":
                        break; // dropped after lint / baked into an asset

                    case "background-image":
                        if (value == "none" || value.StartsWith("linear-gradient(", StringComparison.Ordinal) ||
                            value.StartsWith("radial-gradient(", StringComparison.Ordinal))
                            break; // gradients are baked to SVG
                        throw new UnsupportedStyleException(key, value);

                    case "border-style":
                        if (value != "solid" && value != "none") throw new UnsupportedStyleException(key, value);
                        break;

                    case "box-sizing":
                        if (value != "border-box") throw new UnsupportedStyleException(key, value);
                        break;

                    case "display":
                        if (value != "flex" && value != "none") throw new UnsupportedStyleException(key, value);
                        result.Add(new UssDeclaration(key, value));
                        break;

                    case "position":
                        if (value != "relative" && value != "absolute") throw new UnsupportedStyleException(key, value);
                        result.Add(new UssDeclaration(key, value));
                        break;

                    case "overflow":
                        if (value != "visible" && value != "hidden") throw new UnsupportedStyleException(key, value);
                        result.Add(new UssDeclaration(key, value));
                        break;

                    case "align-items":
                    case "align-self":
                        if (value == "baseline" || value.StartsWith("first baseline", StringComparison.Ordinal) ||
                            value.StartsWith("last baseline", StringComparison.Ordinal))
                            throw new UnsupportedStyleException(key, value);
                        result.Add(new UssDeclaration(key, value));
                        break;

                    case "min-width":
                    case "min-height":
                        if (value == "auto") throw new UnsupportedStyleException(key, value);
                        result.Add(new UssDeclaration(key, value));
                        break;

                    case "border-radius":
                        if (value.Contains("/") || value.Contains("%")) throw new UnsupportedStyleException(key, value);
                        result.Add(new UssDeclaration(key, value));
                        break;

                    case "transition-timing-function":
                        foreach (var part in value.Split(','))
                            if (!Easing.Contains(part.Trim())) throw new UnsupportedStyleException(key, value);
                        result.Add(new UssDeclaration(key, value));
                        break;

                    case "font-family":
                        result.Add(new UssDeclaration("-unity-font-definition", "var(--font-" + FamilySlug(key, value) + ")"));
                        break;

                    case "font-weight":
                    case "font-style":
                        // Both feed one -unity-font-style declaration, emitted once.
                        if (key == "font-weight" || !css.ContainsKey("font-weight"))
                            result.Add(new UssDeclaration("-unity-font-style", FontStyle(weight, style)));
                        else
                            FontStyle(weight, style); // validate only
                        break;

                    case "text-align":
                        result.Add(new UssDeclaration("-unity-text-align", TextAlign(value, alignItems)));
                        break;

                    default:
                        if (!Direct.Contains(key)) throw new UnsupportedStyleException(key, value);
                        result.Add(new UssDeclaration(key, value));
                        break;
                }
            }
            return result;
        }

        static string FontStyle(string weight, string style)
        {
            var w = (weight ?? "").Trim();
            var s = (style ?? "").Trim();
            bool bold;
            if (w == "" || w == "400" || w == "normal") bold = false;
            else if (w == "700" || w == "bold") bold = true;
            else throw new UnsupportedStyleException("font-weight", w);

            bool italic;
            if (s == "" || s == "normal") italic = false;
            else if (s == "italic") italic = true;
            else throw new UnsupportedStyleException("font-style", s);

            return bold && italic ? "bold-and-italic" : bold ? "bold" : italic ? "italic" : "normal";
        }

        static string FamilySlug(string key, string value)
        {
            var first = value.Split(',')[0].Trim().Trim('"', '\'').ToLowerInvariant();
            var slug = Slug.Replace(first, "-").Trim('-');
            if (slug.Length == 0) throw new UnsupportedStyleException(key, value);
            return slug;
        }

        static string TextAlign(string value, string alignItems)
        {
            string h;
            switch (value)
            {
                case "left": case "start": h = "left"; break;
                case "center": h = "center"; break;
                case "right": case "end": h = "right"; break;
                default: throw new UnsupportedStyleException("text-align", value);
            }
            string v;
            switch ((alignItems ?? "").Trim())
            {
                case "center": v = "middle"; break;
                case "flex-end": case "end": case "self-end": v = "lower"; break;
                default: v = "upper"; break; // flex-start, stretch, normal, unset
            }
            return v + "-" + h;
        }

        /// <summary>
        /// USS that undoes what a runtime theme adds to the generated controls (margins, padding, borders,
        /// backgrounds), so a screen looks the same in the theme-less verification panel and in game.
        /// </summary>
        public static string ThemeResetUss { get; } = BuildThemeReset();

        static string BuildThemeReset()
        {
            var controls = new[] { "Label", "Button", "Toggle", "TextField", "DropdownField", "ScrollView", "ListView" };
            var sides = new[] { "top", "right", "bottom", "left" };
            var corners = new[] { "top-left", "top-right", "bottom-right", "bottom-left" };
            var sb = new StringBuilder();
            foreach (var c in controls)
            {
                sb.Append(c).Append(" {\n");
                foreach (var s in sides) sb.Append("    margin-").Append(s).Append(": 0;\n");
                foreach (var s in sides) sb.Append("    padding-").Append(s).Append(": 0;\n");
                foreach (var s in sides) sb.Append("    border-").Append(s).Append("-width: 0;\n");
                foreach (var s in sides) sb.Append("    border-").Append(s).Append("-color: rgba(0, 0, 0, 0);\n");
                foreach (var s in corners) sb.Append("    border-").Append(s).Append("-radius: 0;\n");
                sb.Append("    background-color: rgba(0, 0, 0, 0);\n");
                sb.Append("    background-image: none;\n");
                sb.Append("}\n");
            }
            return sb.ToString();
        }
    }
}
