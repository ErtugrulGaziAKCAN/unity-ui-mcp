using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>The CSS properties the animation player animates (<see cref="DesignAnimProperties"/>).</summary>
    public enum DesignAnimProperty : byte
    {
        Color, BackgroundColor, BorderTopColor, BorderRightColor, BorderBottomColor, BorderLeftColor, TintColor,
        Opacity, Translate, Rotate, Scale,
        BorderTopLeftRadius, BorderTopRightRadius, BorderBottomRightRadius, BorderBottomLeftRadius,
        // layout properties (W-CSS-001): every write is followed by a layout pass
        Width, Height, MinWidth, MinHeight, MaxWidth, MaxHeight,
        MarginTop, MarginRight, MarginBottom, MarginLeft,
        PaddingTop, PaddingRight, PaddingBottom, PaddingLeft,
        Top, Right, Bottom, Left,
        BorderTopWidth, BorderRightWidth, BorderBottomWidth, BorderLeftWidth,
        FlexBasis, FlexGrow, FlexShrink,
    }

    /// <summary>
    /// One animated value. Colours: <see cref="X"/>..<see cref="W"/> = r, g, b, a (sRGB, as USS colours); numbers (opacity,
    /// flex factors, rotate in degrees, border widths in px): <see cref="X"/>; translate and scale: x and y; lengths:
    /// <see cref="X"/> with <see cref="UnitX"/>. <see cref="Keyword"/>: a value that does not interpolate (<c>auto</c>,
    /// <c>none</c> on a length), which CSS swaps at the middle of a keyframe segment.
    /// </summary>
    public struct DesignAnimValue
    {
        public float X, Y, Z, W;
        public LengthUnit UnitX, UnitY;
        public bool Keyword;

        public override string ToString() => string.Format(CultureInfo.InvariantCulture, "({0}, {1}, {2}, {3}{4})", X, Y, Z, W, Keyword ? " keyword" : "");
    }

    /// <summary>
    /// What the animation player knows about each property: its CSS name, how a CSS value parses, how two values
    /// interpolate (CSS: colours premultiplied in sRGB, transforms and lengths per component, a non-interpolable pair
    /// swaps at the middle), how the player writes it (an inline style, removed to hand the property back to the USS
    /// rule) and how the element's own value is read (<see cref="VisualElement.resolvedStyle"/>). Writing allocates nothing.
    /// </summary>
    public static class DesignAnimProperties
    {
        enum Kind : byte { Color, Number, Translate, Rotate, Scale, Length, Pixels }

        static readonly string[] s_Names =
        {
            "color", "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "-unity-background-image-tint-color",
            "opacity", "translate", "rotate", "scale",
            "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
            "width", "height", "min-width", "min-height", "max-width", "max-height",
            "margin-top", "margin-right", "margin-bottom", "margin-left",
            "padding-top", "padding-right", "padding-bottom", "padding-left",
            "top", "right", "bottom", "left",
            "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
            "flex-basis", "flex-grow", "flex-shrink",
        };

        static readonly Kind[] s_Kinds =
        {
            Kind.Color, Kind.Color, Kind.Color, Kind.Color, Kind.Color, Kind.Color, Kind.Color,
            Kind.Number, Kind.Translate, Kind.Rotate, Kind.Scale,
            Kind.Length, Kind.Length, Kind.Length, Kind.Length,
            Kind.Length, Kind.Length, Kind.Length, Kind.Length, Kind.Length, Kind.Length,
            Kind.Length, Kind.Length, Kind.Length, Kind.Length,
            Kind.Length, Kind.Length, Kind.Length, Kind.Length,
            Kind.Length, Kind.Length, Kind.Length, Kind.Length,
            Kind.Pixels, Kind.Pixels, Kind.Pixels, Kind.Pixels,
            Kind.Length, Kind.Number, Kind.Number,
        };

        static readonly Dictionary<string, DesignAnimProperty> s_ByName = BuildIndex();

        static Dictionary<string, DesignAnimProperty> BuildIndex()
        {
            var d = new Dictionary<string, DesignAnimProperty>(StringComparer.Ordinal);
            for (int i = 0; i < s_Names.Length; i++) d[s_Names[i]] = (DesignAnimProperty)i;
            return d;
        }

        /// <summary>Number of properties (the size of a per-property array).</summary>
        public const int Count = (int)DesignAnimProperty.FlexShrink + 1;

        /// <summary>Every property's CSS name, in <see cref="DesignAnimProperty"/> order.</summary>
        public static IReadOnlyList<string> Names => s_Names;

        public static string Name(DesignAnimProperty p) => s_Names[(int)p];

        public static bool TryGet(string cssName, out DesignAnimProperty p) => s_ByName.TryGetValue(cssName ?? "", out p);

        /// <summary>Layout properties: animating them runs a layout pass per frame (lint warning W-CSS-001).</summary>
        public static bool IsLayout(DesignAnimProperty p) => p >= DesignAnimProperty.Width;

        // ---- parsing -------------------------------------------------------------------------------------------------

        /// <summary>A CSS value of the property as the design IR writes it; false when it is not one the player can animate.</summary>
        public static bool TryParse(DesignAnimProperty p, string css, out DesignAnimValue value)
        {
            value = default;
            if (css == null) return false;
            var v = css.Trim();
            switch (s_Kinds[(int)p])
            {
                case Kind.Color:
                    if (!TryColor(v, out var c)) return false;
                    value = new DesignAnimValue { X = c.r, Y = c.g, Z = c.b, W = c.a };
                    return true;
                case Kind.Number:
                    if (!TryNumber(v, out var n)) return false;
                    value.X = n;
                    return true;
                case Kind.Pixels:
                    if (!TryLength(v, out var px, out var pu) || pu != LengthUnit.Pixel) return false;
                    value.X = px;
                    return true;
                case Kind.Rotate:
                    if (v == "none") return true;
                    return TryAngle(v, out value.X);
                case Kind.Scale:
                {
                    if (v == "none") { value.X = 1; value.Y = 1; return true; }
                    var parts = v.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 1 || parts.Length > 3 || !TryNumber(parts[0], out value.X)) return false;
                    if (parts.Length == 1) { value.Y = value.X; return true; }
                    return TryNumber(parts[1], out value.Y);
                }
                case Kind.Translate:
                {
                    if (v == "none") return true;
                    var parts = v.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 1 || parts.Length > 3 || !TryLength(parts[0], out value.X, out value.UnitX)) return false;
                    if (parts.Length == 1) return true;
                    return TryLength(parts[1], out value.Y, out value.UnitY);
                }
                default:
                    if (v == "auto" || v == "none") { value.Keyword = true; return true; }
                    return TryLength(v, out value.X, out value.UnitX);
            }
        }

        static bool TryNumber(string s, out float n) =>
            float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out n) && !float.IsNaN(n) && !float.IsInfinity(n);

        static bool TryLength(string s, out float n, out LengthUnit unit)
        {
            unit = LengthUnit.Pixel;
            if (s.EndsWith("px", StringComparison.Ordinal)) return TryNumber(s.Substring(0, s.Length - 2), out n);
            if (s.EndsWith("%", StringComparison.Ordinal)) { unit = LengthUnit.Percent; return TryNumber(s.Substring(0, s.Length - 1), out n); }
            return TryNumber(s, out n) && n == 0; // a unitless length is only 0
        }

        static bool TryAngle(string s, out float degrees)
        {
            degrees = 0;
            double factor;
            string num;
            if (s.EndsWith("deg", StringComparison.Ordinal)) { factor = 1; num = s.Substring(0, s.Length - 3); }
            else if (s.EndsWith("grad", StringComparison.Ordinal)) { factor = 0.9; num = s.Substring(0, s.Length - 4); }
            else if (s.EndsWith("rad", StringComparison.Ordinal)) { factor = 180 / Math.PI; num = s.Substring(0, s.Length - 3); }
            else if (s.EndsWith("turn", StringComparison.Ordinal)) { factor = 360; num = s.Substring(0, s.Length - 4); }
            else { factor = 1; num = s; if (!TryNumber(num, out var z) || z != 0) return false; }
            if (!TryNumber(num, out var n)) return false;
            degrees = (float)(n * factor);
            return true;
        }

        static readonly Dictionary<string, Color32> s_Named = new Dictionary<string, Color32>(StringComparer.Ordinal)
        {
            { "white", new Color32(255, 255, 255, 255) }, { "black", new Color32(0, 0, 0, 255) }, { "red", new Color32(255, 0, 0, 255) },
            { "green", new Color32(0, 128, 0, 255) }, { "blue", new Color32(0, 0, 255, 255) }, { "yellow", new Color32(255, 255, 0, 255) },
            { "cyan", new Color32(0, 255, 255, 255) }, { "aqua", new Color32(0, 255, 255, 255) }, { "magenta", new Color32(255, 0, 255, 255) },
            { "fuchsia", new Color32(255, 0, 255, 255) }, { "gray", new Color32(128, 128, 128, 255) }, { "grey", new Color32(128, 128, 128, 255) },
            { "orange", new Color32(255, 165, 0, 255) }, { "purple", new Color32(128, 0, 128, 255) }, { "pink", new Color32(255, 192, 203, 255) },
            { "brown", new Color32(165, 42, 42, 255) }, { "silver", new Color32(192, 192, 192, 255) }, { "gold", new Color32(255, 215, 0, 255) },
            { "navy", new Color32(0, 0, 128, 255) }, { "teal", new Color32(0, 128, 128, 255) }, { "lime", new Color32(0, 255, 0, 255) },
            { "maroon", new Color32(128, 0, 0, 255) }, { "olive", new Color32(128, 128, 0, 255) },
        };

        /// <summary>#rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), transparent and the kit's named colours, as sRGB values.</summary>
        public static bool TryColor(string s, out Color color)
        {
            color = default;
            s = s.Trim().ToLowerInvariant();
            if (s == "transparent") return true;
            if (s_Named.TryGetValue(s, out var named)) { color = named; return true; }
            if (s.StartsWith("#", StringComparison.Ordinal))
            {
                var h = s.Substring(1);
                if (h.Length == 3 || h.Length == 4)
                {
                    var e = new char[h.Length * 2];
                    for (int i = 0; i < h.Length; i++) { e[2 * i] = h[i]; e[2 * i + 1] = h[i]; }
                    h = new string(e);
                }
                if (h.Length != 6 && h.Length != 8) return false;
                if (!uint.TryParse(h, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var bits)) return false;
                if (h.Length == 6) bits = (bits << 8) | 0xff;
                color = new Color(((bits >> 24) & 0xff) / 255f, ((bits >> 16) & 0xff) / 255f, ((bits >> 8) & 0xff) / 255f, (bits & 0xff) / 255f);
                return true;
            }
            int open = s.IndexOf('(');
            if (open < 0 || !s.EndsWith(")", StringComparison.Ordinal)) return false;
            var fn = s.Substring(0, open);
            if (fn != "rgb" && fn != "rgba") return false;
            var body = s.Substring(open + 1, s.Length - open - 2).Replace("/", " ").Replace(",", " ");
            var parts = body.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 3 && parts.Length != 4) return false;
            var ch = new float[4];
            for (int i = 0; i < parts.Length; i++)
            {
                var t = parts[i];
                bool pct = t.EndsWith("%", StringComparison.Ordinal);
                if (!TryNumber(pct ? t.Substring(0, t.Length - 1) : t, out var x)) return false;
                ch[i] = i < 3 ? (pct ? x / 100f : x / 255f) : (pct ? x / 100f : x);
            }
            if (parts.Length == 3) ch[3] = 1;
            color = new Color(Mathf.Clamp01(ch[0]), Mathf.Clamp01(ch[1]), Mathf.Clamp01(ch[2]), Mathf.Clamp01(ch[3]));
            return true;
        }

        // ---- interpolation -------------------------------------------------------------------------------------------

        /// <summary>Whether two values of the property interpolate (else CSS swaps them at the middle, a transition jumps).</summary>
        public static bool Interpolable(DesignAnimProperty p, in DesignAnimValue a, in DesignAnimValue b)
        {
            switch (s_Kinds[(int)p])
            {
                case Kind.Length: return !a.Keyword && !b.Keyword && (a.UnitX == b.UnitX || a.X == 0 || b.X == 0);
                case Kind.Translate:
                    return (a.UnitX == b.UnitX || a.X == 0 || b.X == 0) && (a.UnitY == b.UnitY || a.Y == 0 || b.Y == 0);
                default: return true;
            }
        }

        /// <summary>The value at <paramref name="t"/> between <paramref name="a"/> (0) and <paramref name="b"/> (1); t may overshoot.</summary>
        public static DesignAnimValue Interpolate(DesignAnimProperty p, in DesignAnimValue a, in DesignAnimValue b, double t)
        {
            if (!Interpolable(p, a, b)) return t < 0.5 ? a : b;
            float f = (float)t;
            var r = new DesignAnimValue();
            switch (s_Kinds[(int)p])
            {
                case Kind.Color:
                {
                    // CSS Color 4: legacy colours interpolate in sRGB with premultiplied alpha
                    float alpha = Mathf.Clamp01(a.W + (b.W - a.W) * f);
                    if (alpha <= 0) return r;
                    r.X = Mathf.Clamp01((a.X * a.W + (b.X * b.W - a.X * a.W) * f) / alpha);
                    r.Y = Mathf.Clamp01((a.Y * a.W + (b.Y * b.W - a.Y * a.W) * f) / alpha);
                    r.Z = Mathf.Clamp01((a.Z * a.W + (b.Z * b.W - a.Z * a.W) * f) / alpha);
                    r.W = alpha;
                    return r;
                }
                case Kind.Translate:
                    r.X = a.X + (b.X - a.X) * f;
                    r.Y = a.Y + (b.Y - a.Y) * f;
                    r.UnitX = a.X == 0 ? b.UnitX : a.UnitX;
                    r.UnitY = a.Y == 0 ? b.UnitY : a.UnitY;
                    return r;
                case Kind.Scale:
                    r.X = a.X + (b.X - a.X) * f;
                    r.Y = a.Y + (b.Y - a.Y) * f;
                    return r;
                case Kind.Length:
                    r.X = a.X + (b.X - a.X) * f;
                    r.UnitX = a.X == 0 ? b.UnitX : a.UnitX;
                    return r;
                default:
                    r.X = a.X + (b.X - a.X) * f;
                    return r;
            }
        }

        public static bool Same(DesignAnimProperty p, in DesignAnimValue a, in DesignAnimValue b) =>
            a.X == b.X && a.Y == b.Y && a.Z == b.Z && a.W == b.W && a.UnitX == b.UnitX && a.UnitY == b.UnitY && a.Keyword == b.Keyword;

        // ---- writing and reading -------------------------------------------------------------------------------------

        static Length L(in DesignAnimValue v) => new Length(v.X, v.UnitX);

        /// <summary>Writes the value as the element's inline style (allocation-free).</summary>
        public static void Write(VisualElement e, DesignAnimProperty p, in DesignAnimValue v)
        {
            var s = e.style;
            switch (p)
            {
                case DesignAnimProperty.Color: s.color = Col(v); break;
                case DesignAnimProperty.BackgroundColor: s.backgroundColor = Col(v); break;
                case DesignAnimProperty.BorderTopColor: s.borderTopColor = Col(v); break;
                case DesignAnimProperty.BorderRightColor: s.borderRightColor = Col(v); break;
                case DesignAnimProperty.BorderBottomColor: s.borderBottomColor = Col(v); break;
                case DesignAnimProperty.BorderLeftColor: s.borderLeftColor = Col(v); break;
                case DesignAnimProperty.TintColor: s.unityBackgroundImageTintColor = Col(v); break;
                case DesignAnimProperty.Opacity: s.opacity = Mathf.Clamp01(v.X); break;
                case DesignAnimProperty.Translate: s.translate = new StyleTranslate(new Translate(new Length(v.X, v.UnitX), new Length(v.Y, v.UnitY))); break;
                case DesignAnimProperty.Rotate: s.rotate = new StyleRotate(new Rotate(new Angle(v.X, AngleUnit.Degree))); break;
                case DesignAnimProperty.Scale: s.scale = new StyleScale(new Scale(new Vector2(v.X, v.Y))); break;
                case DesignAnimProperty.BorderTopLeftRadius: s.borderTopLeftRadius = Len(v); break;
                case DesignAnimProperty.BorderTopRightRadius: s.borderTopRightRadius = Len(v); break;
                case DesignAnimProperty.BorderBottomRightRadius: s.borderBottomRightRadius = Len(v); break;
                case DesignAnimProperty.BorderBottomLeftRadius: s.borderBottomLeftRadius = Len(v); break;
                case DesignAnimProperty.Width: s.width = Len(v); break;
                case DesignAnimProperty.Height: s.height = Len(v); break;
                case DesignAnimProperty.MinWidth: s.minWidth = Len(v); break;
                case DesignAnimProperty.MinHeight: s.minHeight = Len(v); break;
                case DesignAnimProperty.MaxWidth: s.maxWidth = Len(v); break;
                case DesignAnimProperty.MaxHeight: s.maxHeight = Len(v); break;
                case DesignAnimProperty.MarginTop: s.marginTop = Len(v); break;
                case DesignAnimProperty.MarginRight: s.marginRight = Len(v); break;
                case DesignAnimProperty.MarginBottom: s.marginBottom = Len(v); break;
                case DesignAnimProperty.MarginLeft: s.marginLeft = Len(v); break;
                case DesignAnimProperty.PaddingTop: s.paddingTop = Len(v); break;
                case DesignAnimProperty.PaddingRight: s.paddingRight = Len(v); break;
                case DesignAnimProperty.PaddingBottom: s.paddingBottom = Len(v); break;
                case DesignAnimProperty.PaddingLeft: s.paddingLeft = Len(v); break;
                case DesignAnimProperty.Top: s.top = Len(v); break;
                case DesignAnimProperty.Right: s.right = Len(v); break;
                case DesignAnimProperty.Bottom: s.bottom = Len(v); break;
                case DesignAnimProperty.Left: s.left = Len(v); break;
                case DesignAnimProperty.BorderTopWidth: s.borderTopWidth = v.X; break;
                case DesignAnimProperty.BorderRightWidth: s.borderRightWidth = v.X; break;
                case DesignAnimProperty.BorderBottomWidth: s.borderBottomWidth = v.X; break;
                case DesignAnimProperty.BorderLeftWidth: s.borderLeftWidth = v.X; break;
                case DesignAnimProperty.FlexBasis: s.flexBasis = Len(v); break;
                case DesignAnimProperty.FlexGrow: s.flexGrow = v.X; break;
                case DesignAnimProperty.FlexShrink: s.flexShrink = v.X; break;
            }
        }

        static StyleColor Col(in DesignAnimValue v) => new StyleColor(new Color(v.X, v.Y, v.Z, v.W));

        static StyleLength Len(in DesignAnimValue v) =>
            v.Keyword ? new StyleLength(StyleKeyword.Auto) : new StyleLength(new Length(v.X, v.UnitX));

        /// <summary>Removes the player's inline style: the USS rule's value applies again (at once, without a style pass).</summary>
        public static void Clear(VisualElement e, DesignAnimProperty p)
        {
            var s = e.style;
            switch (p)
            {
                case DesignAnimProperty.Color: s.color = StyleKeyword.Null; break;
                case DesignAnimProperty.BackgroundColor: s.backgroundColor = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderTopColor: s.borderTopColor = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderRightColor: s.borderRightColor = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderBottomColor: s.borderBottomColor = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderLeftColor: s.borderLeftColor = StyleKeyword.Null; break;
                case DesignAnimProperty.TintColor: s.unityBackgroundImageTintColor = StyleKeyword.Null; break;
                case DesignAnimProperty.Opacity: s.opacity = StyleKeyword.Null; break;
                case DesignAnimProperty.Translate: s.translate = StyleKeyword.Null; break;
                case DesignAnimProperty.Rotate: s.rotate = StyleKeyword.Null; break;
                case DesignAnimProperty.Scale: s.scale = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderTopLeftRadius: s.borderTopLeftRadius = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderTopRightRadius: s.borderTopRightRadius = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderBottomRightRadius: s.borderBottomRightRadius = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderBottomLeftRadius: s.borderBottomLeftRadius = StyleKeyword.Null; break;
                case DesignAnimProperty.Width: s.width = StyleKeyword.Null; break;
                case DesignAnimProperty.Height: s.height = StyleKeyword.Null; break;
                case DesignAnimProperty.MinWidth: s.minWidth = StyleKeyword.Null; break;
                case DesignAnimProperty.MinHeight: s.minHeight = StyleKeyword.Null; break;
                case DesignAnimProperty.MaxWidth: s.maxWidth = StyleKeyword.Null; break;
                case DesignAnimProperty.MaxHeight: s.maxHeight = StyleKeyword.Null; break;
                case DesignAnimProperty.MarginTop: s.marginTop = StyleKeyword.Null; break;
                case DesignAnimProperty.MarginRight: s.marginRight = StyleKeyword.Null; break;
                case DesignAnimProperty.MarginBottom: s.marginBottom = StyleKeyword.Null; break;
                case DesignAnimProperty.MarginLeft: s.marginLeft = StyleKeyword.Null; break;
                case DesignAnimProperty.PaddingTop: s.paddingTop = StyleKeyword.Null; break;
                case DesignAnimProperty.PaddingRight: s.paddingRight = StyleKeyword.Null; break;
                case DesignAnimProperty.PaddingBottom: s.paddingBottom = StyleKeyword.Null; break;
                case DesignAnimProperty.PaddingLeft: s.paddingLeft = StyleKeyword.Null; break;
                case DesignAnimProperty.Top: s.top = StyleKeyword.Null; break;
                case DesignAnimProperty.Right: s.right = StyleKeyword.Null; break;
                case DesignAnimProperty.Bottom: s.bottom = StyleKeyword.Null; break;
                case DesignAnimProperty.Left: s.left = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderTopWidth: s.borderTopWidth = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderRightWidth: s.borderRightWidth = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderBottomWidth: s.borderBottomWidth = StyleKeyword.Null; break;
                case DesignAnimProperty.BorderLeftWidth: s.borderLeftWidth = StyleKeyword.Null; break;
                case DesignAnimProperty.FlexBasis: s.flexBasis = StyleKeyword.Null; break;
                case DesignAnimProperty.FlexGrow: s.flexGrow = StyleKeyword.Null; break;
                case DesignAnimProperty.FlexShrink: s.flexShrink = StyleKeyword.Null; break;
            }
        }

        /// <summary>The element's current value of the property (its resolved style), in px for lengths.</summary>
        public static DesignAnimValue Read(VisualElement e, DesignAnimProperty p)
        {
            var s = e.resolvedStyle;
            var v = new DesignAnimValue();
            switch (p)
            {
                case DesignAnimProperty.Color: return Of(s.color);
                case DesignAnimProperty.BackgroundColor: return Of(s.backgroundColor);
                case DesignAnimProperty.BorderTopColor: return Of(s.borderTopColor);
                case DesignAnimProperty.BorderRightColor: return Of(s.borderRightColor);
                case DesignAnimProperty.BorderBottomColor: return Of(s.borderBottomColor);
                case DesignAnimProperty.BorderLeftColor: return Of(s.borderLeftColor);
                case DesignAnimProperty.TintColor: return Of(s.unityBackgroundImageTintColor);
                case DesignAnimProperty.Opacity: v.X = s.opacity; return v;
                case DesignAnimProperty.Translate: v.X = s.translate.x; v.Y = s.translate.y; return v;
                case DesignAnimProperty.Rotate: v.X = s.rotate.angle.ToDegrees(); return v;
                case DesignAnimProperty.Scale: v.X = s.scale.value.x; v.Y = s.scale.value.y; return v;
                case DesignAnimProperty.BorderTopLeftRadius: v.X = s.borderTopLeftRadius; return v;
                case DesignAnimProperty.BorderTopRightRadius: v.X = s.borderTopRightRadius; return v;
                case DesignAnimProperty.BorderBottomRightRadius: v.X = s.borderBottomRightRadius; return v;
                case DesignAnimProperty.BorderBottomLeftRadius: v.X = s.borderBottomLeftRadius; return v;
                case DesignAnimProperty.Width: v.X = s.width; return v;
                case DesignAnimProperty.Height: v.X = s.height; return v;
                case DesignAnimProperty.MinWidth: return Of(s.minWidth);
                case DesignAnimProperty.MinHeight: return Of(s.minHeight);
                case DesignAnimProperty.MaxWidth: return Of(s.maxWidth);
                case DesignAnimProperty.MaxHeight: return Of(s.maxHeight);
                case DesignAnimProperty.MarginTop: v.X = s.marginTop; return v;
                case DesignAnimProperty.MarginRight: v.X = s.marginRight; return v;
                case DesignAnimProperty.MarginBottom: v.X = s.marginBottom; return v;
                case DesignAnimProperty.MarginLeft: v.X = s.marginLeft; return v;
                case DesignAnimProperty.PaddingTop: v.X = s.paddingTop; return v;
                case DesignAnimProperty.PaddingRight: v.X = s.paddingRight; return v;
                case DesignAnimProperty.PaddingBottom: v.X = s.paddingBottom; return v;
                case DesignAnimProperty.PaddingLeft: v.X = s.paddingLeft; return v;
                case DesignAnimProperty.Top: v.X = s.top; return v;
                case DesignAnimProperty.Right: v.X = s.right; return v;
                case DesignAnimProperty.Bottom: v.X = s.bottom; return v;
                case DesignAnimProperty.Left: v.X = s.left; return v;
                case DesignAnimProperty.BorderTopWidth: v.X = s.borderTopWidth; return v;
                case DesignAnimProperty.BorderRightWidth: v.X = s.borderRightWidth; return v;
                case DesignAnimProperty.BorderBottomWidth: v.X = s.borderBottomWidth; return v;
                case DesignAnimProperty.BorderLeftWidth: v.X = s.borderLeftWidth; return v;
                case DesignAnimProperty.FlexBasis: return Of(s.flexBasis);
                case DesignAnimProperty.FlexGrow: v.X = s.flexGrow; return v;
                case DesignAnimProperty.FlexShrink: v.X = s.flexShrink; return v;
            }
            return v;
        }

        static DesignAnimValue Of(Color c) => new DesignAnimValue { X = c.r, Y = c.g, Z = c.b, W = c.a };

        static DesignAnimValue Of(StyleFloat f) => f.keyword != StyleKeyword.Undefined ? new DesignAnimValue { Keyword = true } : new DesignAnimValue { X = f.value };
    }
}
