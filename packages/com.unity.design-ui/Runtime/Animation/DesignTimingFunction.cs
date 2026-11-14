using System;
using System.Globalization;

namespace DesignUi
{
    /// <summary>
    /// A CSS easing function (CSS Easing Level 1), evaluated as Chromium does: <c>linear</c>; the keywords <c>ease</c>,
    /// <c>ease-in</c>, <c>ease-out</c> and <c>ease-in-out</c> as their <c>cubic-bezier()</c> definitions; any
    /// <c>cubic-bezier(x1, y1, x2, y2)</c> (x1 and x2 in [0, 1], y unbounded), solved for x to double precision;
    /// <c>steps(n[, jump-start | jump-end | jump-none | jump-both | start | end])</c>, <c>step-start</c> and
    /// <c>step-end</c>, with the before flag. <c>linear()</c> with points is not supported. A value type: evaluating
    /// allocates nothing.
    /// </summary>
    public readonly struct DesignTimingFunction : IEquatable<DesignTimingFunction>
    {
        enum Kind : byte { Linear, Bezier, Steps }

        /// <summary>Where a <c>steps()</c> function jumps.</summary>
        public enum StepPosition : byte { JumpStart, JumpEnd, JumpNone, JumpBoth }

        readonly Kind m_Kind;
        readonly double m_X1, m_Y1, m_X2, m_Y2;
        readonly int m_Steps;
        readonly StepPosition m_Position;

        DesignTimingFunction(Kind kind, double x1, double y1, double x2, double y2, int steps, StepPosition position)
        {
            m_Kind = kind;
            m_X1 = x1; m_Y1 = y1; m_X2 = x2; m_Y2 = y2;
            m_Steps = steps;
            m_Position = position;
        }

        public static readonly DesignTimingFunction Linear = new DesignTimingFunction(Kind.Linear, 0, 0, 1, 1, 0, StepPosition.JumpEnd);
        /// <summary><c>ease</c> = cubic-bezier(0.25, 0.1, 0.25, 1), the CSS initial value.</summary>
        public static readonly DesignTimingFunction Ease = CubicBezier(0.25, 0.1, 0.25, 1);
        public static readonly DesignTimingFunction EaseIn = CubicBezier(0.42, 0, 1, 1);
        public static readonly DesignTimingFunction EaseOut = CubicBezier(0, 0, 0.58, 1);
        public static readonly DesignTimingFunction EaseInOut = CubicBezier(0.42, 0, 0.58, 1);

        /// <summary>A cubic Bézier from (0, 0) through (x1, y1) and (x2, y2) to (1, 1); x1 and x2 must be in [0, 1].</summary>
        public static DesignTimingFunction CubicBezier(double x1, double y1, double x2, double y2)
        {
            if (!(x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1)) throw new ArgumentOutOfRangeException(nameof(x1), "cubic-bezier() x values must be in [0, 1]");
            if (double.IsNaN(y1) || double.IsInfinity(y1) || double.IsNaN(y2) || double.IsInfinity(y2)) throw new ArgumentOutOfRangeException(nameof(y1));
            return new DesignTimingFunction(Kind.Bezier, x1, y1, x2, y2, 0, StepPosition.JumpEnd);
        }

        /// <summary><c>steps(count, position)</c>; jump-none needs at least 2 steps, the others at least 1.</summary>
        public static DesignTimingFunction Steps(int count, StepPosition position)
        {
            if (count < 1 || (position == StepPosition.JumpNone && count < 2)) throw new ArgumentOutOfRangeException(nameof(count));
            return new DesignTimingFunction(Kind.Steps, 0, 0, 1, 1, count, position);
        }

        public bool IsLinear => m_Kind == Kind.Linear;
        public bool IsSteps => m_Kind == Kind.Steps;

        /// <summary>
        /// The output progress for input progress <paramref name="x"/> (normally 0 to 1). <paramref name="before"/> is CSS's
        /// before flag (the effect is in its before phase going forwards, or in its after phase going backwards); it only
        /// changes a step function at a step edge.
        /// </summary>
        public double Evaluate(double x, bool before = false)
        {
            switch (m_Kind)
            {
                case Kind.Bezier: return Bezier(x);
                case Kind.Steps: return Step(x, before);
                default: return x;
            }
        }

        double Step(double x, bool before)
        {
            // CSS Easing Level 1, 2.3 "step easing functions"
            double steps = m_Steps;
            double current = Math.Floor(x * steps);
            if (m_Position == StepPosition.JumpStart || m_Position == StepPosition.JumpBoth) current += 1;
            if (before && Math.Floor(x * steps) == x * steps) current -= 1;
            if (x >= 0 && current < 0) current = 0;
            double jumps = m_Position == StepPosition.JumpBoth ? steps + 1 : m_Position == StepPosition.JumpNone ? steps - 1 : steps;
            if (x <= 1 && current > jumps) current = jumps;
            return current / jumps;
        }

        // ---- cubic Bézier (as Chromium's gfx::CubicBezier: Newton's method, then bisection) --------------------------

        double Bezier(double x)
        {
            if (x <= 0)
            {
                // outside [0, 1] the curve continues along its end tangent (CSS Easing 2.2)
                if (x == 0) return 0;
                double start = m_X1 > 0 ? m_Y1 / m_X1 : m_Y1 == 0 && m_X2 > 0 ? m_Y2 / m_X2 : 0;
                return start * x;
            }
            if (x >= 1)
            {
                if (x == 1) return 1;
                double end = m_X2 < 1 ? (m_Y2 - 1) / (m_X2 - 1) : m_Y2 == 1 && m_X1 < 1 ? (m_Y1 - 1) / (m_X1 - 1) : 0;
                return 1 + end * (x - 1);
            }
            return SampleY(SolveT(x));
        }

        // B(t) = 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3, as polynomial coefficients
        double SampleX(double t)
        {
            double cx = 3 * m_X1, bx = 3 * (m_X2 - m_X1) - cx, ax = 1 - cx - bx;
            return ((ax * t + bx) * t + cx) * t;
        }

        double SampleY(double t)
        {
            double cy = 3 * m_Y1, by = 3 * (m_Y2 - m_Y1) - cy, ay = 1 - cy - by;
            return ((ay * t + by) * t + cy) * t;
        }

        double SampleDX(double t)
        {
            double cx = 3 * m_X1, bx = 3 * (m_X2 - m_X1) - cx, ax = 1 - cx - bx;
            return (3 * ax * t + 2 * bx) * t + cx;
        }

        const double Epsilon = 1e-12;

        double SolveT(double x)
        {
            double t = x;
            for (int i = 0; i < 8; i++)
            {
                double err = SampleX(t) - x;
                if (Math.Abs(err) < Epsilon) return t;
                double d = SampleDX(t);
                if (Math.Abs(d) < 1e-9) break;
                t -= err / d;
            }
            double lo = 0, hi = 1;
            t = x;
            for (int i = 0; i < 64; i++)
            {
                double v = SampleX(t);
                if (Math.Abs(v - x) < Epsilon) return t;
                if (x > v) lo = t; else hi = t;
                t = (lo + hi) * 0.5;
            }
            return t;
        }

        // ---- parsing ---------------------------------------------------------------------------------------------------

        /// <summary>Parses a CSS easing function as Chromium serialises it (or as authored); false for anything else.</summary>
        public static bool TryParse(string text, out DesignTimingFunction value)
        {
            value = Linear;
            if (text == null) return false;
            var s = text.Trim().ToLowerInvariant();
            switch (s)
            {
                case "linear": value = Linear; return true;
                case "ease": value = Ease; return true;
                case "ease-in": value = EaseIn; return true;
                case "ease-out": value = EaseOut; return true;
                case "ease-in-out": value = EaseInOut; return true;
                case "step-start": value = Steps(1, StepPosition.JumpStart); return true;
                case "step-end": value = Steps(1, StepPosition.JumpEnd); return true;
            }
            if (!s.EndsWith(")", StringComparison.Ordinal)) return false;
            int open = s.IndexOf('(');
            if (open <= 0) return false;
            var fn = s.Substring(0, open).Trim();
            var args = s.Substring(open + 1, s.Length - open - 2).Split(',');
            for (int i = 0; i < args.Length; i++) args[i] = args[i].Trim();
            if (fn == "cubic-bezier")
            {
                if (args.Length != 4) return false;
                var n = new double[4];
                for (int i = 0; i < 4; i++)
                    if (!double.TryParse(args[i], NumberStyles.Float, CultureInfo.InvariantCulture, out n[i]) || double.IsNaN(n[i]) || double.IsInfinity(n[i])) return false;
                if (n[0] < 0 || n[0] > 1 || n[2] < 0 || n[2] > 1) return false;
                value = CubicBezier(n[0], n[1], n[2], n[3]);
                return true;
            }
            if (fn == "steps")
            {
                if (args.Length < 1 || args.Length > 2) return false;
                if (!int.TryParse(args[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var count)) return false;
                var position = StepPosition.JumpEnd;
                if (args.Length == 2)
                {
                    switch (args[1])
                    {
                        case "jump-start": case "start": position = StepPosition.JumpStart; break;
                        case "jump-end": case "end": position = StepPosition.JumpEnd; break;
                        case "jump-none": position = StepPosition.JumpNone; break;
                        case "jump-both": position = StepPosition.JumpBoth; break;
                        default: return false;
                    }
                }
                if (count < 1 || (position == StepPosition.JumpNone && count < 2)) return false;
                value = Steps(count, position);
                return true;
            }
            return false;
        }

        /// <summary><see cref="TryParse"/> or a FormatException naming the text.</summary>
        public static DesignTimingFunction Parse(string text)
        {
            if (!TryParse(text, out var v)) throw new FormatException("'" + text + "' is not a supported CSS easing function (linear, ease, ease-in, ease-out, ease-in-out, cubic-bezier(), steps(), step-start, step-end)");
            return v;
        }

        public bool Equals(DesignTimingFunction other) =>
            m_Kind == other.m_Kind && m_X1 == other.m_X1 && m_Y1 == other.m_Y1 && m_X2 == other.m_X2 && m_Y2 == other.m_Y2 &&
            m_Steps == other.m_Steps && m_Position == other.m_Position;

        public override bool Equals(object obj) => obj is DesignTimingFunction o && Equals(o);
        public override int GetHashCode() => ((int)m_Kind * 397) ^ m_X1.GetHashCode() ^ (m_Y1.GetHashCode() * 3) ^ (m_X2.GetHashCode() * 7) ^ (m_Y2.GetHashCode() * 11) ^ (m_Steps * 13);

        public override string ToString()
        {
            switch (m_Kind)
            {
                case Kind.Bezier: return string.Format(CultureInfo.InvariantCulture, "cubic-bezier({0}, {1}, {2}, {3})", m_X1, m_Y1, m_X2, m_Y2);
                case Kind.Steps: return "steps(" + m_Steps.ToString(CultureInfo.InvariantCulture) + ", " + (m_Position == StepPosition.JumpStart ? "jump-start" : m_Position == StepPosition.JumpNone ? "jump-none" : m_Position == StepPosition.JumpBoth ? "jump-both" : "jump-end") + ")";
                default: return "linear";
            }
        }
    }
}
