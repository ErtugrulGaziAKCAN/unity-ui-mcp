using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace DesignUi.Editor
{
    /// <summary>
    /// IR-level lowerings for what USS cannot express or CSS and USS define differently (spec 5.3). Works on a deep
    /// copy; the input is never mutated. Per node, in order:
    /// <list type="number">
    /// <item>CssDefaults: make CSS initial values explicit (flex rows, block layout, static positioning, box sizing).</item>
    /// <item>Children are processed, then baked shadows get a host wrapper.</item>
    /// <item>gap becomes child margins, per layer.</item>
    /// <item>Siblings are ordered like CSS paints them.</item>
    /// </list>
    /// Layers other than base are resolved against base only; a breakpoint and a state active together are not combined.
    /// </summary>
    public static class Lowering
    {
        const string Base = "base";

        /// <summary>
        /// Synthetic layer on the template items of a repeat container with a gap: its margin undoes the lowered gap
        /// on the first item. Task 13 emits it as a rule for the class <c>__first</c>, which the view toggles on the
        /// first repeated item (USS has no :first-child).
        /// </summary>
        public const string FirstItemLayer = "class:__first";

        static readonly Regex Px = new Regex(@"^(-?\d+(?:\.\d+)?)px$", RegexOptions.Compiled);
        static readonly string[] GapKeys = { "gap", "row-gap", "column-gap" };
        static readonly string[] Insets = { "top", "right", "bottom", "left" };
        static readonly string[] FlexItemKeys = { "flex", "flex-grow", "flex-shrink", "flex-basis", "align-self" };
        static readonly string[] BlockIgnoredKeys = { "flex-direction", "justify-content", "align-items", "flex-wrap", "align-content" };
        static readonly string[] MarginKeys = { "margin-top", "margin-right", "margin-bottom", "margin-left" };
        static readonly HashSet<string> Pseudo = new HashSet<string> { "hover", "active", "focus", "disabled", "checked" };

        /// <summary>Properties that move from a shadowed element to its host.</summary>
        static readonly HashSet<string> Moved = new HashSet<string>
        {
            "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
            "flex", "flex-grow", "flex-shrink", "flex-basis", "align-self",
            "position", "top", "right", "bottom", "left",
            "width", "height", "min-width", "min-height", "max-width", "max-height", "aspect-ratio",
            "opacity", "visibility", "rotate", "scale", "translate", "transform-origin", "z-index",
        };

        public static IrNode Apply(IrNode root)
        {
            if (root == null) throw new ArgumentNullException(nameof(root));
            var copy = Clone(root);
            if (copy.Shadow != null) throw new IrFormatException("the root node '" + copy.Id + "' has a shadow; a shadow needs a parent to host it");
            Process(copy, false);
            return copy;
        }

        static void Process(IrNode node, bool parentBlock)
        {
            bool flex = Get(node, Base, "display") == "flex";
            bool blockSelf = node.Children.Length > 0 && !flex;
            CssDefaults(node, parentBlock, flex, blockSelf);
            foreach (var child in node.Children) Process(child, blockSelf);
            WrapShadows(node);
            LowerGap(node);
            PaintOrder(node);
            RefreshClickable(node);
        }

        // ---- CSS defaults ----------------------------------------------------------------------------------

        static void CssDefaults(IrNode node, bool parentBlock, bool flex, bool blockSelf)
        {
            var baseLayer = BaseLayer(node);
            baseLayer.TryGetValue("display", out var baseDisplay);
            baseLayer.TryGetValue("position", out var basePosition);

            foreach (var pair in node.Style)
            {
                if (pair.Key == Base) continue;
                var layer = pair.Value;
                if (layer.TryGetValue("box-shadow", out var bs))
                    throw new UnsupportedStyleException("box-shadow", bs, null, "box-shadow is baked from the base layer only (layer '" + pair.Key + "').");
                if (layer.TryGetValue("z-index", out var z))
                    throw new UnsupportedStyleException("z-index", z, null, "z-index is only allowed in the base layer (layer '" + pair.Key + "').");
                if (layer.TryGetValue("pointer-events", out var pe))
                    throw new UnsupportedStyleException("pointer-events", pe, null, "pointer-events is only allowed in the base layer.");
                if (layer.TryGetValue("position", out var pos) && Position(pos) != Position(basePosition))
                    throw new UnsupportedStyleException("position", pos, null, "position cannot change between layers ('" + pair.Key + "').");
                if (layer.TryGetValue("display", out var disp) && DisplayGroup(disp) != "none" && DisplayGroup(disp) != DisplayGroup(baseDisplay))
                    throw new UnsupportedStyleException("display", disp, null, "display can only switch to none between layers ('" + pair.Key + "').");
            }

            // box-sizing: the kit sets border-box globally; an explicit content-box only matters on a sized element with padding or border
            foreach (var pair in node.Style)
            {
                if (!pair.Value.TryGetValue("box-sizing", out var bsz)) continue;
                if (bsz == "content-box" && HasBoxExtras(node) && (baseLayer.ContainsKey("width") || baseLayer.ContainsKey("height")))
                    throw new UnsupportedStyleException("box-sizing", bsz, null, "content-box with padding or border on a sized element is not supported; the kit sets border-box.");
                pair.Value.Remove("box-sizing");
            }

            // display: block is the container default
            if (baseDisplay == "block") baseLayer.Remove("display");

            // flex container without a direction is a row; a block container is a column
            if (flex && !baseLayer.ContainsKey("flex-direction")) baseLayer["flex-direction"] = "row";
            if (blockSelf)
            {
                foreach (var layer in node.Style.Values) foreach (var k in BlockIgnoredKeys) layer.Remove(k);
                baseLayer["flex-direction"] = "column";
            }

            // gap only exists on flex containers
            if (!flex) foreach (var layer in node.Style.Values) foreach (var k in GapKeys) layer.Remove(k);

            // static (and absent) position ignores insets; USS would apply them
            if (basePosition == "static") baseLayer["position"] = "relative";
            if (basePosition == null || basePosition == "static")
                foreach (var layer in node.Style.Values) foreach (var k in Insets) layer.Remove(k);

            // wrapping rows: CSS align-content normal behaves like stretch, USS defaults to flex-start
            if (flex && baseLayer.TryGetValue("flex-wrap", out var wrap) && wrap != "nowrap" && !baseLayer.ContainsKey("align-content"))
                baseLayer["align-content"] = "stretch";
            foreach (var layer in node.Style.Values)
                if (layer.TryGetValue("align-content", out var ac) && ac == "normal") layer["align-content"] = "stretch";

            // block children are not flex items: no flex properties, and they never shrink
            if (parentBlock && Get(node, Base, "position") != "absolute")
            {
                foreach (var layer in node.Style.Values) foreach (var k in FlexItemKeys) layer.Remove(k);
                baseLayer["flex-shrink"] = "0";
            }

            if (baseLayer.TryGetValue("pointer-events", out var pev))
            {
                if (pev == "none") node.PickingIgnore = true;
                else if (pev != "auto") throw new UnsupportedStyleException("pointer-events", pev);
                baseLayer.Remove("pointer-events");
            }
        }

        static bool HasBoxExtras(IrNode node)
        {
            foreach (var layer in node.Style.Values)
                foreach (var kv in layer)
                    if ((kv.Key.StartsWith("padding", StringComparison.Ordinal) || (kv.Key.StartsWith("border-", StringComparison.Ordinal) && kv.Key.EndsWith("-width", StringComparison.Ordinal)) || kv.Key == "border-width")
                        && kv.Value.Trim() != "0" && kv.Value.Trim() != "0px")
                        return true;
            return false;
        }

        static string DisplayGroup(string d) => d == null || d == "block" ? "block" : d;
        static string Position(string p) => p == null || p == "static" ? "static" : p;

        // ---- shadow host -----------------------------------------------------------------------------------

        static void WrapShadows(IrNode node)
        {
            for (int i = 0; i < node.Children.Length; i++)
            {
                var el = node.Children[i];
                if (el.Shadow == null) continue;
                node.Children[i] = BuildHost(el);
            }
        }

        /// <summary>
        /// <c>&lt;id&gt;__shadowhost</c> takes the element's slot and the properties that place it (margins, flex item
        /// properties, position and insets, size, transforms, opacity, hiding, z-index and their transitions, in every
        /// layer); it contains the absolute <c>&lt;id&gt;__shadow</c> image, anchored by insets so it follows the
        /// element's size, and the element itself, grown to fill the host.
        /// </summary>
        static IrNode BuildHost(IrNode el)
        {
            var s = el.Shadow;
            if (s.Offset == null) throw new IrFormatException("shadow of node '" + el.Id + "' has no offset");
            el.Shadow = null;

            var host = new IrNode { Id = el.Id + "__shadowhost", Kind = "container" };
            BaseLayer(host)["flex-direction"] = "column";

            foreach (var name in el.Style.Keys.ToList())
            {
                var layer = el.Style[name];
                Dictionary<string, string> hostLayer = null;
                Dictionary<string, string> HostLayer()
                {
                    if (hostLayer == null && !host.Style.TryGetValue(name, out hostLayer)) host.Style[name] = hostLayer = new Dictionary<string, string>();
                    return hostLayer;
                }
                foreach (var key in layer.Keys.ToList())
                {
                    if (Moved.Contains(key) || (key == "display" && layer[key].Trim() == "none"))
                    {
                        HostLayer()[key] = layer[key];
                        layer.Remove(key);
                    }
                }
                MoveTransitions(layer, HostLayer);
                if (layer.Count == 0 && name != Base) el.Style.Remove(name);
            }
            BaseLayer(el)["flex-grow"] = "1";
            if (host.Style.ContainsKey("active")) host.Clickable = true;
            RefreshClickable(el);

            float x = s.Offset.X, y = s.Offset.Y, w = s.Offset.W, h = s.Offset.H;
            var shadow = new IrNode
            {
                Id = el.Id + "__shadow",
                Kind = "image",
                PickingIgnore = true,
                Asset = new IrAsset { Kind = s.Kind, File = s.File, Sha256 = s.Sha256, Width = s.Width, Height = s.Height, Slice = (float[])s.Slice?.Clone() },
                Style = new Dictionary<string, Dictionary<string, string>>
                {
                    { Base, new Dictionary<string, string>
                        {
                            { "position", "absolute" },
                            { "left", Fmt(x) + "px" },
                            { "top", Fmt(y) + "px" },
                            { "right", Fmt(-(x + w)) + "px" },
                            { "bottom", Fmt(-(y + h)) + "px" },
                        } },
                },
            };
            host.Children = new[] { shadow, el };
            return host;
        }

        /// <summary>Moves the transition entries of moved properties to the host (index-aligned longhand lists, or whole shorthand entries).</summary>
        static void MoveTransitions(Dictionary<string, string> layer, Func<Dictionary<string, string>> hostLayer)
        {
            bool IsMoved(string prop) => prop == "all" || Moved.Contains(prop) || prop == "display";

            if (layer.TryGetValue("transition", out var shorthand))
            {
                var entries = CssSupport.SplitTop(shorthand, ',').Select(e => e.Trim()).ToList();
                var moved = entries.Where(e => IsMoved(FirstIdent(e))).ToList();
                if (moved.Count > 0)
                {
                    hostLayer()["transition"] = string.Join(", ", moved);
                    var keep = entries.Where(e => FirstIdent(e) == "all" || !IsMoved(FirstIdent(e))).ToList();
                    if (keep.Count == 0) layer.Remove("transition"); else layer["transition"] = string.Join(", ", keep);
                }
            }

            if (layer.TryGetValue("transition-property", out var propList))
            {
                var props = CssSupport.SplitTop(propList, ',').Select(p => p.Trim()).ToList();
                var movedIdx = Enumerable.Range(0, props.Count).Where(i => IsMoved(props[i])).ToList();
                if (movedIdx.Count == 0) return;
                var keepIdx = Enumerable.Range(0, props.Count).Where(i => props[i] == "all" || !IsMoved(props[i])).ToList();
                foreach (var key in new[] { "transition-property", "transition-duration", "transition-delay", "transition-timing-function" })
                {
                    if (!layer.TryGetValue(key, out var list)) continue;
                    var items = CssSupport.SplitTop(list, ',').Select(p => p.Trim()).ToList();
                    string At(int i) => items[i % items.Count];
                    hostLayer()[key] = string.Join(", ", movedIdx.Select(At));
                    if (keepIdx.Count == 0) layer.Remove(key); else layer[key] = string.Join(", ", keepIdx.Select(At));
                }
            }
        }

        static string FirstIdent(string entry) => entry.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault(t => !char.IsDigit(t[0]) && t[0] != '.' && t[0] != '-') ?? "";

        // ---- gap -------------------------------------------------------------------------------------------

        static string MarginProp(string direction)
        {
            switch (direction)
            {
                case "row": return "margin-left";
                case "row-reverse": return "margin-right";
                case "column-reverse": return "margin-bottom";
                default: return "margin-top";
            }
        }

        static void LowerGap(IrNode node)
        {
            if (!node.Style.Values.Any(l => GapKeys.Any(l.ContainsKey))) return;

            foreach (var pair in node.Style)
            {
                if (!Pseudo.Contains(pair.Key)) continue;
                foreach (var k in GapKeys.Concat(new[] { "flex-direction", "flex-wrap" }))
                    if (pair.Value.TryGetValue(k, out var v))
                        throw new UnsupportedStyleException(k, v, null, "A parent's " + k + " cannot change with a pseudo-state ('" + pair.Key + "').");
            }

            var layerNames = new List<string> { Base };
            layerNames.AddRange(node.Style.Keys.Concat(node.Children.SelectMany(c => c.Style.Keys)).Where(k => k != Base).Distinct().OrderBy(k => k, StringComparer.Ordinal));

            var inflow = node.Children.Where(c => !IsAbsolute(c)).ToList();
            foreach (var c in inflow)
                foreach (var pair in c.Style)
                    if (pair.Value.ContainsKey("margin"))
                        throw new IrFormatException("child '" + c.Id + "' has a margin shorthand next to a lowered gap in '" + node.Id + "'");

            // effective direction and gap per layer: base overlaid with that layer
            var baseGap = ResolveGap(node, Base, 0, 0);
            var eff = new Dictionary<string, (string dir, float gap)>();
            foreach (var name in layerNames)
            {
                var (r, c) = name == Base ? baseGap : ResolveGap(node, name, baseGap.row, baseGap.col);
                var dir = (Get(node, name, "flex-direction") ?? "row").Trim();
                var wrap = Get(node, name, "flex-wrap") ?? "nowrap";
                bool row = dir == "row" || dir == "row-reverse";
                var gap = row ? c : r;
                if (gap > 0 && wrap != "nowrap")
                    throw new IrFormatException("gap on a wrapping flex container cannot be lowered (node '" + node.Id + "')");
                eff[name] = (dir, gap);
            }

            // snapshot of the children's own state before margins are written
            var ownMargin = new Dictionary<(IrNode, string, string), string>();
            var visible = new Dictionary<(IrNode, string), bool>();
            foreach (var c in inflow)
                foreach (var name in layerNames)
                {
                    foreach (var p in MarginKeys) ownMargin[(c, name, p)] = Get(c, name, p);
                    visible[(c, name)] = Get(c, name, "display") != "none";
                }
            string Own(IrNode c, string layer, string prop) => ownMargin[(c, layer, prop)];

            bool repeat = node.Repeat != null;
            if (repeat)
                foreach (var name in layerNames)
                    if (eff[name].gap != eff[Base].gap || eff[name].dir != eff[Base].dir)
                        throw new UnsupportedStyleException("gap", Get(node, name, "gap") ?? "", null, "A repeat container's gap and direction cannot change between layers ('" + name + "').");

            var firstAt = new Dictionary<string, IrNode>();
            foreach (var name in layerNames) firstAt[name] = inflow.FirstOrDefault(c => visible[(c, name)]);

            string Expected(IrNode c, string layer, string prop)
            {
                var own = Own(c, layer, prop);
                var (dir, gap) = eff[layer];
                float add = (repeat || c != firstAt[layer]) && prop == MarginProp(dir) ? gap : 0;
                if (own != null && own.Trim() == "auto") return "auto";
                return Fmt((own == null ? 0 : ParsePx(own, prop, c.Id)) + add) + "px";
            }

            var baseDir = eff[Base].dir;
            foreach (var name in layerNames)
            {
                var props = name == Base ? new[] { MarginProp(baseDir) } : new[] { MarginProp(baseDir), MarginProp(eff[name].dir) }.Distinct().ToArray();
                foreach (var c in inflow)
                {
                    foreach (var p in props)
                    {
                        var val = Expected(c, name, p);
                        if (name == Base)
                        {
                            if (val != (Own(c, Base, p) ?? "0px")) BaseLayer(c)[p] = val;
                            continue;
                        }
                        var hasOwn = c.Style.TryGetValue(name, out var cl) && cl.ContainsKey(p);
                        if (val != Expected(c, Base, p) || hasOwn)
                        {
                            if (cl == null) c.Style[name] = cl = new Dictionary<string, string>();
                            cl[p] = val;
                        }
                    }
                }
            }

            if (repeat && eff[Base].gap > 0)
            {
                var p = MarginProp(baseDir);
                foreach (var c in inflow)
                    c.Style[FirstItemLayer] = new Dictionary<string, string> { { p, Own(c, Base, p) ?? "0px" } };
            }

            foreach (var layer in node.Style.Values) foreach (var k in GapKeys) layer.Remove(k);
        }

        static (float row, float col) ResolveGap(IrNode node, string layerName, float baseRow, float baseCol)
        {
            float row = baseRow, col = baseCol;
            if (!node.Style.TryGetValue(layerName, out var layer)) return (row, col);
            if (layer.TryGetValue("gap", out var g))
            {
                var parts = g.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 1) row = col = GapPx(parts[0], node.Id);
                else if (parts.Length == 2) { row = GapPx(parts[0], node.Id); col = GapPx(parts[1], node.Id); }
                else throw new IrFormatException("unsupported gap value '" + g + "' on node '" + node.Id + "'");
            }
            if (layer.TryGetValue("row-gap", out var rg)) row = GapPx(rg, node.Id);
            if (layer.TryGetValue("column-gap", out var cg)) col = GapPx(cg, node.Id);
            return (row, col);
        }

        static float GapPx(string v, string id) => v.Trim() == "normal" ? 0 : ParsePx(v, "gap", id);

        // ---- paint order -----------------------------------------------------------------------------------

        /// <summary>
        /// UI Toolkit paints in hierarchy order, CSS paints negative z-index first, then in-flow siblings, then
        /// absolute siblings by z-index (auto is 0). Siblings are reordered to match; in-flow order is unchanged.
        /// </summary>
        static void PaintOrder(IrNode node)
        {
            var z = new Dictionary<IrNode, int>();
            foreach (var child in node.Children)
            {
                int value = 0;
                if (BaseLayer(child).TryGetValue("z-index", out var raw))
                {
                    if (!IsAbsolute(child))
                        throw new IrFormatException("z-index on in-flow node '" + child.Id + "' cannot be lowered");
                    if (raw.Trim() != "auto" && !int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
                        throw new IrFormatException("unsupported z-index '" + raw + "' on node '" + child.Id + "'");
                    BaseLayer(child).Remove("z-index");
                }
                z[child] = value;
            }
            var abs = node.Children.Where(IsAbsolute).ToList();
            var neg = abs.Where(c => z[c] < 0).OrderBy(c => z[c]).ToList();
            var pos = abs.Where(c => z[c] >= 0).OrderBy(c => z[c]).ToList();
            var flow = node.Children.Where(c => !IsAbsolute(c)).ToList();
            node.Children = neg.Concat(flow).Concat(pos).ToArray();
        }

        // ---- helpers ---------------------------------------------------------------------------------------

        static void RefreshClickable(IrNode n) =>
            n.Clickable = n.Action != null || n.Kind == "button" || n.Kind == "toggle" || n.Style.ContainsKey("active");

        static Dictionary<string, string> BaseLayer(IrNode n)
        {
            if (!n.Style.TryGetValue(Base, out var b)) n.Style[Base] = b = new Dictionary<string, string>();
            return b;
        }

        /// <summary>Value of a property in a layer, falling back to base.</summary>
        static string Get(IrNode n, string layer, string prop)
        {
            if (layer != Base && n.Style.TryGetValue(layer, out var l) && l.TryGetValue(prop, out var v)) return v.Trim();
            return n.Style.TryGetValue(Base, out var b) && b.TryGetValue(prop, out var bv) ? bv.Trim() : null;
        }

        static bool IsAbsolute(IrNode n) => Get(n, Base, "position") == "absolute";

        static float ParsePx(string value, string prop, string id)
        {
            value = value.Trim();
            if (value == "0") return 0;
            var m = Px.Match(value);
            if (!m.Success) throw new IrFormatException("cannot lower non-px " + prop + " '" + value + "' on node '" + id + "'");
            return float.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        }

        static string Fmt(float v)
        {
            if (v == 0) v = 0;
            var s = v.ToString("0.####", CultureInfo.InvariantCulture);
            return s == "-0" ? "0" : s;
        }

        static IrNode Clone(IrNode n)
        {
            return new IrNode
            {
                Id = n.Id,
                Kind = n.Kind,
                External = n.External,
                Classes = (string[])n.Classes?.Clone() ?? new string[0],
                Style = n.Style?.ToDictionary(kv => kv.Key, kv => new Dictionary<string, string>(kv.Value)) ?? new Dictionary<string, Dictionary<string, string>>(),
                Text = n.Text == null ? null : new IrText { Key = n.Text.Key, Tr = n.Text.Tr, En = n.Text.En, Args = (string[])n.Text.Args?.Clone(), Rich = n.Text.Rich },
                Asset = CloneAsset(n.Asset),
                Background = CloneAsset(n.Background),
                Shadow = n.Shadow == null ? null : new IrShadow
                {
                    Kind = n.Shadow.Kind, File = n.Shadow.File, Sha256 = n.Shadow.Sha256, Width = n.Shadow.Width, Height = n.Shadow.Height,
                    Slice = (float[])n.Shadow.Slice?.Clone(),
                    Offset = n.Shadow.Offset == null ? null : new BoxRect { X = n.Shadow.Offset.X, Y = n.Shadow.Offset.Y, W = n.Shadow.Offset.W, H = n.Shadow.Offset.H },
                },
                Bind = n.Bind,
                Action = n.Action,
                Repeat = n.Repeat == null ? null : new IrRepeat { Name = n.Repeat.Name, Mode = n.Repeat.Mode },
                Anims = (object[])n.Anims?.Clone() ?? new object[0],
                Children = (n.Children ?? new IrNode[0]).Select(Clone).ToArray(),
                Clickable = n.Clickable,
                PickingIgnore = n.PickingIgnore,
            };
        }

        static IrAsset CloneAsset(IrAsset a) => a == null ? null : new IrAsset
        {
            Kind = a.Kind, File = a.File, Sha256 = a.Sha256, Width = a.Width, Height = a.Height, Slice = (float[])a.Slice?.Clone(),
        };
    }
}
