using System;
using System.Collections.Generic;
using System.Globalization;

namespace DesignUi
{
    /// <summary>
    /// The panel scales of the profile's scaled viewports (kit.config.json <c>{ "size": [w, h], "class": "scaled" }</c>), as the
    /// compiler writes them on a screen root (the UXML attribute <c>viewport-scales</c> of <see cref="DesignScreen"/>). Unity sets
    /// text at whole device pixels: at such a scale a 12 px font is 6.4 device px and renders at 6. The compiler's
    /// <c>DesignFonts.uss</c> points each line-box font variable at a twin made for that scale under the root class
    /// <c>vs-&lt;key&gt;</c> (its face scaled by exact / rounded size), so text keeps the design's size and line height there; the
    /// screen root carries the class of the scale its panel renders at.
    /// </summary>
    public static class DesignViewportScales
    {
        public const string ClassPrefix = "vs-";

        /// <summary>A panel scale within this of a declared one is that scale (float layout of a double the compiler wrote).</summary>
        public const double Tolerance = 1e-4;

        /// <summary>The key of a scale: six decimals, the point as <c>p</c> (<c>0.625</c> → <c>0p625</c>, 1366×768's → <c>0p533464</c>).</summary>
        public static string Key(double scale) =>
            Math.Round(scale, 6).ToString("0.######", CultureInfo.InvariantCulture).Replace('.', 'p');

        /// <summary>The root class of a scale: <c>vs-&lt;key&gt;</c>.</summary>
        public static string ClassOf(double scale) => ClassPrefix + Key(scale);

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
                if (double.TryParse(p, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && d > 0) list.Add(d);
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
    }
}
