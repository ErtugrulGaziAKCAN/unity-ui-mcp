using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace DesignUi.Editor
{
    /// <summary>
    /// IR-level lowerings for what USS cannot express (spec 5.3): gap to child margins, z-index to sibling order,
    /// baked shadow to an inserted sibling. Works on a deep copy; the input is never mutated.
    /// </summary>
    public static class Lowering
    {
        const string Base = "base";
        static readonly Regex Px = new Regex(@"^(-?\d+(?:\.\d+)?)px$", RegexOptions.Compiled);

        public static IrNode Apply(IrNode root)
        {
            if (root == null) throw new ArgumentNullException(nameof(root));
            return Lower(Clone(root));
        }

        static IrNode Lower(IrNode node)
        {
            for (int i = 0; i < node.Children.Length; i++) node.Children[i] = Lower(node.Children[i]);

            LowerGap(node);
            var children = node.Children.ToList();
            ReorderByZIndex(node, children);
            InsertShadows(children);
            node.Children = children.ToArray();

            node.Clickable = node.Action != null || node.Kind == "button" || node.Kind == "toggle" || node.Style.ContainsKey("active");
            return node;
        }

        // ---- gap -------------------------------------------------------------------------------------------

        static void LowerGap(IrNode node)
        {
            foreach (var layerName in node.Style.Keys.ToList())
            {
                var layer = node.Style[layerName];
                if (!layer.ContainsKey("gap") && !layer.ContainsKey("row-gap") && !layer.ContainsKey("column-gap")) continue;

                string Resolve(string prop)
                {
                    if (layer.TryGetValue(prop, out var v)) return v;
                    return node.Style.TryGetValue(Base, out var b) && b.TryGetValue(prop, out var bv) ? bv : null;
                }

                var wrap = Resolve("flex-wrap");
                if (!string.IsNullOrEmpty(wrap) && wrap != "nowrap")
                    throw new IrFormatException("gap on a wrapping flex container cannot be lowered (node '" + node.Id + "')");

                var direction = (Resolve("flex-direction") ?? "row").Trim();
                bool row = direction == "row" || direction == "row-reverse";
                bool reverse = direction.EndsWith("-reverse", StringComparison.Ordinal);

                string rowGap = null, colGap = null;
                if (layer.TryGetValue("gap", out var shorthand))
                {
                    var parts = shorthand.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length == 1) rowGap = colGap = parts[0];
                    else if (parts.Length == 2) { rowGap = parts[0]; colGap = parts[1]; }
                    else throw new IrFormatException("unsupported gap value '" + shorthand + "' on node '" + node.Id + "'");
                }
                if (layer.TryGetValue("row-gap", out var rg)) rowGap = rg;
                if (layer.TryGetValue("column-gap", out var cg)) colGap = cg;

                layer.Remove("gap");
                layer.Remove("row-gap");
                layer.Remove("column-gap");

                var gap = (row ? colGap : rowGap)?.Trim();
                if (gap == null || gap == "normal" || gap == "0" || gap == "0px") continue;
                var gapPx = ParsePx(gap, "gap", node.Id);

                var marginProp = row ? (reverse ? "margin-right" : "margin-left") : (reverse ? "margin-bottom" : "margin-top");
                bool first = true;
                foreach (var child in node.Children)
                {
                    if (IsAbsolute(child)) continue;
                    if (first) { first = false; continue; }
                    if (!child.Style.TryGetValue(layerName, out var cl)) child.Style[layerName] = cl = new Dictionary<string, string>();
                    if (cl.ContainsKey("margin"))
                        throw new IrFormatException("child '" + child.Id + "' has a margin shorthand next to a lowered gap");
                    var total = cl.TryGetValue(marginProp, out var existing) ? ParsePx(existing, marginProp, child.Id) + gapPx : gapPx;
                    cl[marginProp] = Fmt(total) + "px";
                }
            }
        }

        // ---- z-index ---------------------------------------------------------------------------------------

        static void ReorderByZIndex(IrNode parent, List<IrNode> children)
        {
            var z = new Dictionary<IrNode, int>();
            bool any = false;
            foreach (var child in children)
            {
                int value = 0;
                foreach (var layer in child.Style.Values)
                {
                    if (!layer.TryGetValue("z-index", out var raw)) continue;
                    any = true;
                    if (!IsAbsolute(child))
                        throw new IrFormatException("z-index on in-flow node '" + child.Id + "' cannot be lowered");
                    if (raw != "auto" && !int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
                        throw new IrFormatException("unsupported z-index '" + raw + "' on node '" + child.Id + "'");
                    layer.Remove("z-index");
                    break;
                }
                // remove any remaining z-index in other layers
                foreach (var layer in child.Style.Values) layer.Remove("z-index");
                z[child] = value;
            }
            if (!any) return;

            var slots = Enumerable.Range(0, children.Count).Where(i => IsAbsolute(children[i])).ToList();
            var sorted = slots.Select((s, order) => (node: children[s], order)).OrderBy(t => z[t.node]).ThenBy(t => t.order).Select(t => t.node).ToList();
            for (int i = 0; i < slots.Count; i++) children[slots[i]] = sorted[i];
        }

        // ---- shadow ----------------------------------------------------------------------------------------

        static void InsertShadows(List<IrNode> children)
        {
            for (int i = 0; i < children.Count; i++)
            {
                var el = children[i];
                if (el.Shadow == null) continue;
                var shadow = BuildShadow(el);
                el.Shadow = null;
                children.Insert(i, shadow);
                i++;
            }
        }

        static IrNode BuildShadow(IrNode el)
        {
            var s = el.Shadow;
            if (s.Offset == null) throw new IrFormatException("shadow of node '" + el.Id + "' has no offset");
            el.Style.TryGetValue(Base, out var b);
            b = b ?? new Dictionary<string, string>();

            float left = s.Offset.X, top = s.Offset.Y;
            if (b.TryGetValue("position", out var pos) && pos == "absolute")
            {
                if (b.TryGetValue("left", out var l)) left += ParsePx(l, "left", el.Id);
                if (b.TryGetValue("top", out var t)) top += ParsePx(t, "top", el.Id);
            }

            var style = new Dictionary<string, string>
            {
                { "position", "absolute" },
                { "left", Fmt(left) + "px" },
                { "top", Fmt(top) + "px" },
                { "width", ShadowSize(el, b, "width", s.Offset.W) },
                { "height", ShadowSize(el, b, "height", s.Offset.H) },
            };

            return new IrNode
            {
                Id = el.Id + "__shadow",
                Kind = "image",
                Asset = new IrAsset { Kind = s.Kind, File = s.File, Sha256 = s.Sha256, Width = s.Width, Height = s.Height, Slice = s.Slice == null ? null : (int[])s.Slice.Clone() },
                Style = new Dictionary<string, Dictionary<string, string>> { { Base, style } },
            };
        }

        static string ShadowSize(IrNode el, Dictionary<string, string> b, string prop, float delta)
        {
            if (!b.TryGetValue(prop, out var v))
                throw new IrFormatException("node '" + el.Id + "' has a shadow but no " + prop);
            var m = Px.Match(v.Trim());
            if (m.Success) return Fmt(float.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) + delta) + "px";
            if (Math.Abs(delta) < 0.0001f) return v;
            throw new IrFormatException("node '" + el.Id + "' has a shadow wider than its non-px " + prop + " '" + v + "'");
        }

        // ---- helpers ---------------------------------------------------------------------------------------

        static bool IsAbsolute(IrNode n) =>
            n.Style.TryGetValue(Base, out var b) && b.TryGetValue("position", out var p) && p == "absolute";

        static float ParsePx(string value, string prop, string id)
        {
            value = value.Trim();
            if (value == "0") return 0;
            var m = Px.Match(value);
            if (!m.Success) throw new IrFormatException("cannot lower non-px " + prop + " '" + value + "' on node '" + id + "'");
            return float.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        }

        static string Fmt(float v) => v.ToString("0.####", CultureInfo.InvariantCulture);

        static IrNode Clone(IrNode n)
        {
            return new IrNode
            {
                Id = n.Id,
                Kind = n.Kind,
                External = n.External,
                Classes = (string[])n.Classes?.Clone(),
                Style = n.Style?.ToDictionary(kv => kv.Key, kv => new Dictionary<string, string>(kv.Value)),
                Text = n.Text == null ? null : new IrText { Key = n.Text.Key, Tr = n.Text.Tr, En = n.Text.En, Args = (string[])n.Text.Args?.Clone(), Rich = n.Text.Rich },
                Asset = CloneAsset(n.Asset),
                Background = CloneAsset(n.Background),
                Shadow = n.Shadow == null ? null : new IrShadow
                {
                    Kind = n.Shadow.Kind, File = n.Shadow.File, Sha256 = n.Shadow.Sha256, Width = n.Shadow.Width, Height = n.Shadow.Height,
                    Slice = (int[])n.Shadow.Slice?.Clone(),
                    Offset = n.Shadow.Offset == null ? null : new BoxRect { X = n.Shadow.Offset.X, Y = n.Shadow.Offset.Y, W = n.Shadow.Offset.W, H = n.Shadow.Offset.H },
                },
                Bind = n.Bind,
                Action = n.Action,
                Repeat = n.Repeat == null ? null : new IrRepeat { Name = n.Repeat.Name, Mode = n.Repeat.Mode },
                Anims = (object[])n.Anims?.Clone(),
                Children = (n.Children ?? new IrNode[0]).Select(Clone).ToArray(),
                Clickable = n.Clickable,
            };
        }

        static IrAsset CloneAsset(IrAsset a) => a == null ? null : new IrAsset
        {
            Kind = a.Kind, File = a.File, Sha256 = a.Sha256, Width = a.Width, Height = a.Height, Slice = (int[])a.Slice?.Clone(),
        };
    }
}
