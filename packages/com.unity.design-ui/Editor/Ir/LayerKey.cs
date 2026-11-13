using System;
using System.Collections.Generic;
using System.Linq;

namespace DesignUi.Editor
{
    /// <summary>Kinds of layer key dimensions, in canonical order.</summary>
    public enum LayerDimKind { Breakpoint = 0, State = 1, Class = 2, Ancestor = 3, Pseudo = 4 }

    /// <summary>
    /// One dimension of a layer key: <c>bp:&lt;name&gt;</c>, <c>state:&lt;name&gt;</c>, <c>class:&lt;class&gt;</c>,
    /// <c>anc(&lt;ancestor id&gt;):&lt;pseudo | class:&lt;class&gt;&gt;</c> or an own pseudo-state
    /// (<c>hover</c>, <c>active</c>, <c>focus</c>, <c>disabled</c>, <c>checked</c>).
    /// </summary>
    public sealed class LayerDim : IEquatable<LayerDim>
    {
        public readonly LayerDimKind Kind;
        /// <summary>Canonical text, e.g. <c>bp:narrow</c> or <c>anc(card):hover</c>.</summary>
        public readonly string Text;
        /// <summary>The breakpoint, state or class name, or the pseudo-state; for an ancestor dimension its condition's name.</summary>
        public readonly string Name;
        /// <summary>Ancestor dimensions: the ancestor's IR id; null otherwise.</summary>
        public readonly string AncestorId;
        /// <summary>Ancestor dimensions: true for <c>anc(id):class:x</c>, false for <c>anc(id):&lt;pseudo&gt;</c>.</summary>
        public readonly bool AncestorClass;

        LayerDim(LayerDimKind kind, string text, string name, string ancestorId, bool ancestorClass)
        {
            Kind = kind;
            Text = text;
            Name = name;
            AncestorId = ancestorId;
            AncestorClass = ancestorClass;
        }

        public static LayerDim Breakpoint(string name) => new LayerDim(LayerDimKind.Breakpoint, "bp:" + name, name, null, false);
        public static LayerDim State(string name) => new LayerDim(LayerDimKind.State, "state:" + name, name, null, false);
        public static LayerDim Class(string name) => new LayerDim(LayerDimKind.Class, "class:" + name, name, null, false);
        public static LayerDim Pseudo(string name) => new LayerDim(LayerDimKind.Pseudo, name, name, null, false);

        public static LayerDim Ancestor(string id, string name, bool isClass) =>
            new LayerDim(LayerDimKind.Ancestor, "anc(" + id + "):" + (isClass ? "class:" : "") + name, name, id, isClass);

        /// <summary>
        /// This dimension as seen from a descendant of the element that owns it: its own pseudo-states and classes become
        /// conditions on that element (<c>anc(&lt;ownerId&gt;):…</c>); breakpoints, states and ancestor conditions stay.
        /// </summary>
        public LayerDim ToDescendant(string ownerId)
        {
            switch (Kind)
            {
                case LayerDimKind.Pseudo: return Ancestor(ownerId, Name, false);
                case LayerDimKind.Class: return Ancestor(ownerId, Name, true);
                default: return this;
            }
        }

        /// <summary>
        /// This dimension, written by a descendant, as it applies to the ancestor <paramref name="ownerId"/>:
        /// <c>anc(ownerId):x</c> becomes the ancestor's own <c>x</c>; the descendant's own pseudo-states and classes do not
        /// apply to it (null); the rest is unchanged.
        /// </summary>
        public LayerDim ToAncestor(string ownerId)
        {
            switch (Kind)
            {
                case LayerDimKind.Pseudo:
                case LayerDimKind.Class:
                    return null;
                case LayerDimKind.Ancestor:
                    if (AncestorId != ownerId) return this;
                    return AncestorClass ? Class(Name) : Pseudo(Name);
                default: return this;
            }
        }

        public bool Equals(LayerDim other) => other != null && Text == other.Text;
        public override bool Equals(object obj) => obj is LayerDim d && Equals(d);
        public override int GetHashCode() => Text.GetHashCode();
        public override string ToString() => Text;
    }

    /// <summary>
    /// A style layer key (spec 7): <c>base</c>, or dimensions joined with <c>+</c> in canonical order breakpoints, states,
    /// classes, ancestor conditions, own pseudo-states, ordinal within a kind; e.g. <c>state:loading+hover</c>,
    /// <c>anc(card):hover</c>, <c>bp:narrow+anc(row):class:is-selected</c>. A layer holds while all its dimensions hold
    /// and records what wins in the CSS cascade when exactly those dimensions hold; layers that hold together and set one
    /// property also appear as their union. Animation triggers use the same keys, <c>show</c> for base.
    /// </summary>
    public sealed class LayerKey : IEquatable<LayerKey>
    {
        public const string BaseText = "base";
        public const string ShowTrigger = "show";

        /// <summary>The pseudo-states a key can name, in the order rules for them are written (hover before active, as in CSS).</summary>
        public static readonly IReadOnlyList<string> PseudoStates = new[] { "hover", "focus", "checked", "active", "disabled" };

        public static readonly LayerKey Base = new LayerKey(new LayerDim[0]);

        /// <summary>The dimensions in canonical order.</summary>
        public readonly IReadOnlyList<LayerDim> Dims;
        /// <summary>The canonical key text.</summary>
        public readonly string Text;

        LayerKey(IReadOnlyList<LayerDim> dims)
        {
            Dims = dims;
            Text = dims.Count == 0 ? BaseText : string.Join("+", dims.Select(d => d.Text));
        }

        public bool IsBase => Dims.Count == 0;

        public IEnumerable<LayerDim> OfKind(LayerDimKind kind) => Dims.Where(d => d.Kind == kind);
        public bool Has(LayerDimKind kind) => Dims.Any(d => d.Kind == kind);
        public bool Contains(LayerDim dim) => Dims.Contains(dim);

        /// <summary>The ids of the ancestors the key names, in key order without repeats.</summary>
        public IEnumerable<string> AncestorIds => OfKind(LayerDimKind.Ancestor).Select(d => d.AncestorId).Distinct();

        /// <summary>The canonical key of a set of dimensions (repeats are merged).</summary>
        public static LayerKey Of(IEnumerable<LayerDim> dims)
        {
            var list = dims.Where(d => d != null).Distinct().ToList();
            list.Sort((a, b) => a.Kind != b.Kind ? a.Kind.CompareTo(b.Kind) : string.CompareOrdinal(a.Text, b.Text));
            return list.Count == 0 ? Base : new LayerKey(list);
        }

        static readonly Dictionary<string, LayerKey> Cache = new Dictionary<string, LayerKey>(StringComparer.Ordinal);

        /// <summary>Parses a key and returns its canonical form; malformed keys throw <see cref="IrFormatException"/>.</summary>
        public static LayerKey Parse(string text)
        {
            if (text == null) throw new IrFormatException("missing style layer key");
            lock (Cache)
                if (Cache.TryGetValue(text, out var cached)) return cached;
            LayerKey key;
            if (text == BaseText) key = Base;
            else
            {
                var dims = new List<LayerDim>();
                foreach (var part in text.Split('+'))
                {
                    var dim = ParseDim(part);
                    if (dim == null) throw new IrFormatException("malformed style layer key '" + text + "' (dimension '" + part + "')");
                    if (dims.Contains(dim)) throw new IrFormatException("style layer key '" + text + "' names '" + part + "' twice");
                    dims.Add(dim);
                }
                key = Of(dims);
            }
            lock (Cache) Cache[text] = key;
            return key;
        }

        /// <summary>Whether <paramref name="text"/> is a well-formed key already in canonical order.</summary>
        public static bool IsCanonical(string text, out string canonical)
        {
            canonical = Parse(text).Text;
            return canonical == text;
        }

        static LayerDim ParseDim(string part)
        {
            if (string.IsNullOrEmpty(part)) return null;
            if (part.StartsWith("bp:", StringComparison.Ordinal)) return Name(part, 3) is string b ? LayerDim.Breakpoint(b) : null;
            if (part.StartsWith("state:", StringComparison.Ordinal)) return Name(part, 6) is string s ? LayerDim.State(s) : null;
            if (part.StartsWith("class:", StringComparison.Ordinal)) return Name(part, 6) is string c ? LayerDim.Class(c) : null;
            if (part.StartsWith("anc(", StringComparison.Ordinal))
            {
                int close = part.IndexOf(')');
                if (close <= 4 || close + 1 >= part.Length || part[close + 1] != ':') return null;
                var id = part.Substring(4, close - 4);
                if (id.IndexOf('(') >= 0) return null;
                var rest = part.Substring(close + 2);
                if (rest.StartsWith("class:", StringComparison.Ordinal))
                    return Name(rest, 6) is string ac ? LayerDim.Ancestor(id, ac, true) : null;
                return IsPseudo(rest) ? LayerDim.Ancestor(id, rest, false) : null;
            }
            return IsPseudo(part) ? LayerDim.Pseudo(part) : null;
        }

        static string Name(string part, int start)
        {
            var name = part.Substring(start);
            return name.Length == 0 || name.IndexOf('(') >= 0 || name.IndexOf(')') >= 0 ? null : name;
        }

        public static bool IsPseudo(string name) => name == "hover" || name == "active" || name == "focus" || name == "disabled" || name == "checked";

        public bool IsSubsetOf(LayerKey other) => Dims.All(other.Dims.Contains);

        public LayerKey Union(LayerKey other) => Of(Dims.Concat(other.Dims));

        /// <summary>The key with each dimension mapped (null drops it), canonicalised.</summary>
        public LayerKey Map(Func<LayerDim, LayerDim> map) => Of(Dims.Select(map));

        /// <summary>
        /// Whether all dimensions can hold at once: at most one screen state, and breakpoints whose width and aspect
        /// ranges overlap (a breakpoint missing from <paramref name="breakpoints"/> is assumed to overlap).
        /// </summary>
        public bool Satisfiable(IReadOnlyDictionary<string, IrBreakpoint> breakpoints)
        {
            if (OfKind(LayerDimKind.State).Count() > 1) return false;
            if (breakpoints == null) return true;
            var bps = OfKind(LayerDimKind.Breakpoint).Select(d => breakpoints.TryGetValue(d.Name, out var b) ? b : null).Where(b => b != null).ToList();
            for (int i = 0; i < bps.Count; i++)
                for (int j = i + 1; j < bps.Count; j++)
                    if (!Overlap(bps[i], bps[j])) return false;
            return true;
        }

        /// <summary>Two breakpoints can hold at the same time (their width and aspect ranges overlap).</summary>
        public static bool Overlap(IrBreakpoint a, IrBreakpoint b) =>
            Math.Max(a.MinWidth ?? 0, b.MinWidth ?? 0) <= Math.Min(a.MaxWidth ?? float.PositiveInfinity, b.MaxWidth ?? float.PositiveInfinity) &&
            Math.Max(a.MinAspect ?? 0, b.MinAspect ?? 0) <= Math.Min(a.MaxAspect ?? float.PositiveInfinity, b.MaxAspect ?? float.PositiveInfinity);

        /// <summary>
        /// The specificity of the key's USS selector, counted in simple selectors: the element's class, one per dimension,
        /// and one per named ancestor's class. A key whose dimensions include another's always counts more.
        /// </summary>
        public int Specificity => 1 + Dims.Count + AncestorIds.Count();

        /// <summary>
        /// The order rules are written in within a class: base, then by dimension count, then dimension kinds (breakpoints,
        /// states, classes, ancestors, pseudo-states hover, focus, checked, active, disabled), then ordinal.
        /// </summary>
        public static readonly IComparer<LayerKey> RuleOrder = Comparer<LayerKey>.Create((a, b) =>
        {
            if (a.Dims.Count != b.Dims.Count) return a.Dims.Count.CompareTo(b.Dims.Count);
            for (int i = 0; i < a.Dims.Count; i++)
            {
                int c = Rank(a.Dims[i]).CompareTo(Rank(b.Dims[i]));
                if (c != 0) return c;
            }
            return string.CompareOrdinal(a.Text, b.Text);
        });

        static int Rank(LayerDim d)
        {
            if (d.Kind != LayerDimKind.Pseudo) return (int)d.Kind * 10;
            for (int i = 0; i < PseudoStates.Count; i++) if (PseudoStates[i] == d.Name) return (int)d.Kind * 10 + i;
            return (int)d.Kind * 10 + 9;
        }

        /// <summary>
        /// The USS cascade between two rules of one element that both hold: higher specificity wins, then the later rule.
        /// Positive when <paramref name="a"/> wins.
        /// </summary>
        public static int CascadeCompare(LayerKey a, LayerKey b)
        {
            int c = a.Specificity.CompareTo(b.Specificity);
            return c != 0 ? c : RuleOrder.Compare(a, b);
        }

        /// <summary>
        /// Every union of two or more of <paramref name="keys"/> that can hold (see <see cref="Satisfiable"/>) and is not
        /// one of the keys, closed under union. Throws when there are more than <paramref name="limit"/>.
        /// </summary>
        public static List<LayerKey> UnionClosure(IEnumerable<LayerKey> keys, IReadOnlyDictionary<string, IrBreakpoint> breakpoints, int limit, Func<string> what)
        {
            var given = new HashSet<LayerKey>(keys.Where(k => !k.IsBase));
            var all = new HashSet<LayerKey>(given);
            var frontier = all.ToList();
            var added = new List<LayerKey>();
            while (frontier.Count > 0)
            {
                var next = new List<LayerKey>();
                var snapshot = all.ToList();
                foreach (var a in frontier)
                    foreach (var b in snapshot)
                    {
                        if (a.IsSubsetOf(b) || b.IsSubsetOf(a)) continue;
                        var u = a.Union(b);
                        if (all.Contains(u) || !u.Satisfiable(breakpoints)) continue;
                        all.Add(u);
                        next.Add(u);
                        added.Add(u);
                        if (added.Count > limit)
                            throw new UnsupportedStyleException("layers", string.Join(", ", given.Select(k => k.Text).OrderBy(t => t, StringComparer.Ordinal)), null,
                                what() + " combine into more than " + limit + " layer unions (" + Involved(given) + "). Each of these can hold " +
                                "together with the others, so every combination needs its own rule. View classes are independent of each other: " +
                                "for choices that exclude each other use one screen state per choice instead of an is-* class each, or let fewer " +
                                "layers change this element.");
                    }
                frontier = next;
            }
            added.Sort(RuleOrder);
            return added;
        }

        /// <summary>The conditions a set of keys depends on, by kind: view classes, states, breakpoints, pseudo-states.</summary>
        static string Involved(IEnumerable<LayerKey> keys)
        {
            var dims = keys.SelectMany(k => k.Dims).Distinct().ToList();
            string Of(string label, IEnumerable<string> names)
            {
                var list = names.Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList();
                return list.Count == 0 ? null : label + " " + string.Join(", ", list);
            }
            var parts = new[]
            {
                Of("view classes", dims.Where(d => d.Kind == LayerDimKind.Class || (d.Kind == LayerDimKind.Ancestor && d.AncestorClass))
                    .Select(d => d.Kind == LayerDimKind.Ancestor ? d.Name + " on '" + d.AncestorId + "'" : d.Name)),
                Of("states", dims.Where(d => d.Kind == LayerDimKind.State).Select(d => d.Name)),
                Of("breakpoints", dims.Where(d => d.Kind == LayerDimKind.Breakpoint).Select(d => d.Name)),
                Of("pseudo-states", dims.Where(d => d.Kind == LayerDimKind.Pseudo || (d.Kind == LayerDimKind.Ancestor && !d.AncestorClass))
                    .Select(d => d.Kind == LayerDimKind.Ancestor ? d.Name + " of '" + d.AncestorId + "'" : d.Name)),
            };
            return string.Join("; ", parts.Where(x => x != null));
        }

        public bool Equals(LayerKey other) => other != null && Text == other.Text;
        public override bool Equals(object obj) => obj is LayerKey k && Equals(k);
        public override int GetHashCode() => Text.GetHashCode();
        public override string ToString() => Text;
    }
}
