using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace DesignUi
{
    /// <summary>
    /// The design's <c>@media</c> breakpoints (min/max width and aspect ratio of the panel's logical size), as the compiler
    /// writes them on a screen root (the UXML attribute <c>breakpoints</c> of <see cref="DesignScreen"/>) and the verifier and
    /// the runtime apply them: the root carries <c>bp-&lt;name&gt;</c> for every breakpoint that holds. The size is the panel's
    /// logical size rounded to whole pixels (as the exporter rounds it), so the game applies the same rules the goldens were
    /// captured with.
    /// </summary>
    public sealed class DesignBreakpoints
    {
        public const string ClassPrefix = "bp-";

        public readonly struct Breakpoint
        {
            public readonly string Name;
            public readonly double? MinWidth, MaxWidth, MinAspect, MaxAspect;

            public Breakpoint(string name, double? minWidth, double? maxWidth, double? minAspect, double? maxAspect)
            {
                Name = name;
                MinWidth = minWidth;
                MaxWidth = maxWidth;
                MinAspect = minAspect;
                MaxAspect = maxAspect;
            }

            /// <summary>Whether it holds for a logical size already rounded to whole pixels.</summary>
            public bool Holds(double w, double h) =>
                (MinWidth == null || w >= MinWidth) && (MaxWidth == null || w <= MaxWidth) &&
                (MinAspect == null || h > 0 && w / h >= MinAspect) && (MaxAspect == null || h > 0 && w / h <= MaxAspect);
        }

        public readonly IReadOnlyList<Breakpoint> All;

        public DesignBreakpoints(IReadOnlyList<Breakpoint> all) => All = all ?? new Breakpoint[0];

        static string Num(double? v) => v.HasValue ? v.Value.ToString("R", CultureInfo.InvariantCulture) : "";

        /// <summary>The UXML attribute value: <c>name:minWidth:maxWidth:minAspect:maxAspect</c> per breakpoint, joined by <c>;</c> (empty: no limit).</summary>
        public static string Encode(IEnumerable<Breakpoint> breakpoints)
        {
            var sb = new StringBuilder();
            foreach (var b in breakpoints ?? new Breakpoint[0])
            {
                if (sb.Length > 0) sb.Append(';');
                sb.Append(b.Name).Append(':').Append(Num(b.MinWidth)).Append(':').Append(Num(b.MaxWidth)).Append(':').Append(Num(b.MinAspect)).Append(':').Append(Num(b.MaxAspect));
            }
            return sb.ToString();
        }

        /// <summary>Reads an attribute value of <see cref="Encode"/>; a malformed entry is left out.</summary>
        public static DesignBreakpoints Parse(string value)
        {
            var list = new List<Breakpoint>();
            foreach (var entry in (value ?? "").Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var p = entry.Split(':');
                if (p.Length != 5 || p[0].Length == 0) continue;
                double? N(string s) => s.Length == 0 ? (double?)null : double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : (double?)null;
                list.Add(new Breakpoint(p[0], N(p[1]), N(p[2]), N(p[3]), N(p[4])));
            }
            return new DesignBreakpoints(list);
        }

        /// <summary>The breakpoints that hold for a logical panel size (rounded to whole pixels first), in order.</summary>
        public IEnumerable<string> Active(double width, double height)
        {
            double w = Math.Round(width, MidpointRounding.AwayFromZero), h = Math.Round(height, MidpointRounding.AwayFromZero);
            foreach (var b in All)
                if (b.Holds(w, h)) yield return b.Name;
        }
    }
}
