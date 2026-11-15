using System;
using System.Globalization;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi
{
    public partial class DesignScreen
    {
        /// <summary>
        /// The custom properties the compiler writes next to each of the screen root's own <c>translate</c>, <c>rotate</c>,
        /// <c>scale</c> and <c>transform-origin</c> declarations (the same value, as a string), so the root knows the design's
        /// transform in every state and breakpoint while its inline transform composes it with the root scale.
        /// </summary>
        public const string TranslateProperty = "--dui-root-translate", RotateProperty = "--dui-root-rotate",
                            ScaleProperty = "--dui-root-scale", OriginProperty = "--dui-root-origin";

        static readonly CustomStyleProperty<string> s_Translate = new CustomStyleProperty<string>(TranslateProperty);
        static readonly CustomStyleProperty<string> s_Rotate = new CustomStyleProperty<string>(RotateProperty);
        static readonly CustomStyleProperty<string> s_Scale = new CustomStyleProperty<string>(ScaleProperty);
        static readonly CustomStyleProperty<string> s_Origin = new CustomStyleProperty<string>(OriginProperty);

        /// <summary>The design's own transform of the root: its rules' (custom properties) or, while it plays, the animation player's.</summary>
        struct DesignTransform
        {
            public Length TranslateX, TranslateY, OriginX, OriginY;
            public float Rotate, ScaleX, ScaleY;

            public static DesignTransform Identity => new DesignTransform
            {
                TranslateX = new Length(0), TranslateY = new Length(0), OriginX = new Length(50, LengthUnit.Percent), OriginY = new Length(50, LengthUnit.Percent),
                ScaleX = 1, ScaleY = 1,
            };
        }

        DesignTransform m_RuleTransform = DesignTransform.Identity;
        bool m_AnimatesTranslate, m_AnimatesRotate, m_AnimatesScale;
        DesignAnimValue m_AnimTranslate, m_AnimRotate, m_AnimScale;

        /// <summary>Whether the root's inline transform is composed (a root scale applies): its design values are its own then.</summary>
        internal bool ComposesTransform => RootScale != 1f;

        /// <summary>Reads the design's transform from the root's rules (on every style resolution of the root).</summary>
        void ReadRuleTransform()
        {
            var t = DesignTransform.Identity;
            var cs = customStyle;
            if (cs.TryGetValue(s_Translate, out var translate) && TryLengths(translate, out var tx, out var ty, false)) { t.TranslateX = tx; t.TranslateY = ty; }
            if (cs.TryGetValue(s_Rotate, out var rotate) && TryAngle(rotate, out var degrees)) t.Rotate = degrees;
            if (cs.TryGetValue(s_Scale, out var scale) && TryScale(scale, out var sx, out var sy)) { t.ScaleX = sx; t.ScaleY = sy; }
            if (cs.TryGetValue(s_Origin, out var origin) && TryLengths(origin, out var ox, out var oy, true)) { t.OriginX = ox; t.OriginY = oy; }
            m_RuleTransform = t;
        }

        /// <summary>The animation player writes a transform of the root (<see cref="DesignAnimProperties.Write"/>).</summary>
        internal void SetAnimatedTransform(DesignAnimProperty p, in DesignAnimValue v)
        {
            switch (p)
            {
                case DesignAnimProperty.Translate: m_AnimatesTranslate = true; m_AnimTranslate = v; break;
                case DesignAnimProperty.Rotate: m_AnimatesRotate = true; m_AnimRotate = v; break;
                case DesignAnimProperty.Scale: m_AnimatesScale = true; m_AnimScale = v; break;
                default: return;
            }
            ComposeTransform();
        }

        /// <summary>The animation player hands a transform of the root back to its rules (<see cref="DesignAnimProperties.Clear"/>).</summary>
        internal void ClearAnimatedTransform(DesignAnimProperty p)
        {
            switch (p)
            {
                case DesignAnimProperty.Translate: m_AnimatesTranslate = false; break;
                case DesignAnimProperty.Rotate: m_AnimatesRotate = false; break;
                case DesignAnimProperty.Scale: m_AnimatesScale = false; break;
                default: return;
            }
            ComposeTransform();
        }

        /// <summary>The root's own value of a transform property, without the root scale (<see cref="DesignAnimProperties.Read"/>).</summary>
        internal DesignAnimValue ReadDesignTransform(DesignAnimProperty p)
        {
            var v = new DesignAnimValue();
            switch (p)
            {
                case DesignAnimProperty.Translate:
                    if (m_AnimatesTranslate) return m_AnimTranslate;
                    v.X = Px(m_RuleTransform.TranslateX, layout.width);
                    v.Y = Px(m_RuleTransform.TranslateY, layout.height);
                    return v;
                case DesignAnimProperty.Rotate:
                    if (m_AnimatesRotate) return m_AnimRotate;
                    v.X = m_RuleTransform.Rotate;
                    return v;
                case DesignAnimProperty.Scale:
                    if (m_AnimatesScale) return m_AnimScale;
                    v.X = m_RuleTransform.ScaleX;
                    v.Y = m_RuleTransform.ScaleY;
                    return v;
            }
            return v;
        }

        static float Px(Length l, float size)
        {
            if (l.unit == LengthUnit.Percent) return float.IsNaN(size) ? 0 : l.value * size / 100f;
            return l.value;
        }

        /// <summary>
        /// Writes the root's inline transform. Unscaled: only what the animation player plays (its rules apply the rest).
        /// Under a root scale <c>r</c>: the design's transform (translate <c>t</c>, rotate <c>R</c>, scale <c>S</c> about the
        /// origin <c>c</c>) followed by the root scale about the root's top-left corner, as one transform about the corner:
        /// scale <c>r·S</c>, rotate <c>R</c>, translate <c>r·(t + c − R·S·c)</c>, origin 0 0. So the design's transforms and
        /// animations of the root move it in design pixels at the actual scale, and the root scale comes back when they end.
        /// </summary>
        void ComposeTransform()
        {
            var s = style;
            float r = RootScale;
            if (r == 1f)
            {
                if (m_AnimatesTranslate) DesignAnimProperties.WriteInline(this, DesignAnimProperty.Translate, m_AnimTranslate);
                else if (s.translate.keyword != StyleKeyword.Null) s.translate = StyleKeyword.Null;
                if (m_AnimatesRotate) DesignAnimProperties.WriteInline(this, DesignAnimProperty.Rotate, m_AnimRotate);
                else if (s.rotate.keyword != StyleKeyword.Null) s.rotate = StyleKeyword.Null;
                if (m_AnimatesScale) DesignAnimProperties.WriteInline(this, DesignAnimProperty.Scale, m_AnimScale);
                else if (s.scale.keyword != StyleKeyword.Null) s.scale = StyleKeyword.Null;
                if (s.transformOrigin.keyword != StyleKeyword.Null) s.transformOrigin = StyleKeyword.Null;
                return;
            }
            float w = layout.width, h = layout.height;
            if (float.IsNaN(w)) w = 0;
            if (float.IsNaN(h)) h = 0;
            var rule = m_RuleTransform;
            float tx = m_AnimatesTranslate ? Px(new Length(m_AnimTranslate.X, m_AnimTranslate.UnitX), w) : Px(rule.TranslateX, w);
            float ty = m_AnimatesTranslate ? Px(new Length(m_AnimTranslate.Y, m_AnimTranslate.UnitY), h) : Px(rule.TranslateY, h);
            float degrees = m_AnimatesRotate ? m_AnimRotate.X : rule.Rotate;
            float sx = m_AnimatesScale ? m_AnimScale.X : rule.ScaleX, sy = m_AnimatesScale ? m_AnimScale.Y : rule.ScaleY;
            float cx = Px(rule.OriginX, w), cy = Px(rule.OriginY, h);
            float rad = degrees * Mathf.Deg2Rad, cos = Mathf.Cos(rad), sin = Mathf.Sin(rad);
            // R·S·c (UI Toolkit rotates clockwise for a positive angle, y down)
            float scx = sx * cx, scy = sy * cy;
            float rcx = scx * cos - scy * sin, rcy = scx * sin + scy * cos;
            var translate = new Translate(new Length(r * (tx + cx - rcx)), new Length(r * (ty + cy - rcy)));
            var scale = new Scale(new Vector3(r * sx, r * sy, 1));
            var rotate = new Rotate(new Angle(degrees, AngleUnit.Degree));
            var origin = new TransformOrigin(new Length(0), new Length(0), 0);
            if (s.translate.keyword != StyleKeyword.Undefined || s.translate.value != translate) s.translate = translate;
            if (s.scale.keyword != StyleKeyword.Undefined || s.scale.value != scale) s.scale = scale;
            if (s.rotate.keyword != StyleKeyword.Undefined || s.rotate.value != rotate) s.rotate = rotate;
            if (s.transformOrigin.keyword != StyleKeyword.Undefined || s.transformOrigin.value != origin) s.transformOrigin = origin;
        }

        // ---- the compiler's values (USS) --------------------------------------------------------------------------------

        static bool TryLength(string token, bool origin, bool vertical, out Length length)
        {
            length = default;
            switch (token)
            {
                case "left" when origin && !vertical: case "top" when origin && vertical: length = new Length(0, LengthUnit.Percent); return true;
                case "center" when origin: length = new Length(50, LengthUnit.Percent); return true;
                case "right" when origin && !vertical: case "bottom" when origin && vertical: length = new Length(100, LengthUnit.Percent); return true;
            }
            if (token.EndsWith("%", StringComparison.Ordinal) && float.TryParse(token.Substring(0, token.Length - 1), NumberStyles.Float, CultureInfo.InvariantCulture, out var pc))
            {
                length = new Length(pc, LengthUnit.Percent);
                return true;
            }
            var number = token.EndsWith("px", StringComparison.Ordinal) ? token.Substring(0, token.Length - 2) : token;
            if (!float.TryParse(number, NumberStyles.Float, CultureInfo.InvariantCulture, out var px)) return false;
            length = new Length(px);
            return true;
        }

        /// <summary>A translate (<c>x y</c>) or transform-origin (<c>x y</c>, keywords in either order) value.</summary>
        static bool TryLengths(string value, out Length x, out Length y, bool origin)
        {
            x = y = origin ? new Length(50, LengthUnit.Percent) : new Length(0);
            var parts = (value ?? "").Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0 || parts[0] == "none") return parts.Length > 0;
            if (origin && parts.Length >= 2 && (parts[0] == "top" || parts[0] == "bottom" || parts[1] == "left" || parts[1] == "right"))
                (parts[0], parts[1]) = (parts[1], parts[0]);
            if (origin && parts.Length == 1 && (parts[0] == "top" || parts[0] == "bottom"))
                return TryLength(parts[0], true, true, out y);
            if (!TryLength(parts[0], origin, false, out x)) return false;
            if (parts.Length > 1 && !TryLength(parts[1], origin, true, out y)) return false;
            return true;
        }

        static bool TryAngle(string value, out float degrees)
        {
            degrees = 0;
            var v = (value ?? "").Trim();
            if (v == "none" || v.Length == 0) return v.Length > 0;
            (string suffix, float factor)[] units = { ("deg", 1f), ("grad", 0.9f), ("rad", Mathf.Rad2Deg), ("turn", 360f) };
            foreach (var (suffix, factor) in units)
                if (v.EndsWith(suffix, StringComparison.Ordinal) && float.TryParse(v.Substring(0, v.Length - suffix.Length), NumberStyles.Float, CultureInfo.InvariantCulture, out var n))
                {
                    degrees = n * factor;
                    return true;
                }
            if (!float.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var plain)) return false;
            degrees = plain;
            return true;
        }

        static bool TryScale(string value, out float x, out float y)
        {
            x = y = 1;
            var parts = (value ?? "").Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0 || parts[0] == "none") return parts.Length > 0;
            float Of(string p) => p.EndsWith("%", StringComparison.Ordinal) ? float.Parse(p.Substring(0, p.Length - 1), CultureInfo.InvariantCulture) / 100f : float.Parse(p, CultureInfo.InvariantCulture);
            try
            {
                x = Of(parts[0]);
                y = parts.Length > 1 ? Of(parts[1]) : x;
                return true;
            }
            catch (FormatException) { x = y = 1; return false; }
        }
    }
}
