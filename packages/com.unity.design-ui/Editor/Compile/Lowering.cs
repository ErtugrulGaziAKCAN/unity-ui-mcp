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
            "opacity", "visibility", "rotate", "scale", "translate", "transform-origin", "z-index", "display",
        };

        public static IrNode Apply(IrNode root)
        {
            if (root == null) throw new ArgumentNullException(nameof(root));
            var copy = Clone(root);
            if (copy.Shadow != null) throw new IrFormatException("the root node '" + copy.Id + "' has a shadow; a shadow needs a parent to host it");
            Process(copy, false, false, true, false, true);
            if (Get(copy, Base, "position") == "static") BaseLayer(copy)["position"] = "relative";
            return copy;
        }

        static void Process(IrNode node, bool parentBlock, bool parentFlex, bool parentPositioned, bool ignorePointer, bool isRoot)
        {
            var visible = VisibleDisplay(node, parentFlex);
            bool flex = visible == "flex";
            bool blockSelf = node.Children.Length > 0 && !flex;
            var position = Get(node, Base, "position");
            bool positioned = isRoot || position == "relative" || position == "absolute";

            if (position == "absolute" && !parentPositioned)
                throw new UnsupportedStyleException("position", "absolute", null,
                    "Element '" + node.Id + "' is absolute but its parent is not positioned; set position: relative on the parent (UI Toolkit anchors absolute elements to the parent, CSS to the nearest positioned ancestor).");

            CssDefaults(node, parentBlock, parentFlex, flex, blockSelf);

            // pointer-events is inherited in CSS; picking mode is not
            var pe = Get(node, Base, "pointer-events");
            if (pe == "none") ignorePointer = true;
            else if (pe == "auto") ignorePointer = false;
            else if (pe != null) throw new UnsupportedStyleException("pointer-events", pe);
            if (pe != null) BaseLayer(node).Remove("pointer-events");
            node.PickingIgnore = ignorePointer;

            foreach (var child in node.Children) Process(child, blockSelf, flex, positioned, ignorePointer, false);
            WrapShadows(node);
            LowerGap(node);
            PaintOrder(node, flex);
            RefreshClickable(node);
        }

        /// <summary>
        /// The one visible display of a node: the single non-none value across all layers (inline-flex, inline-block
        /// and inline are blockified to flex, block and block where CSS blockifies them), block when none is set.
        /// Layers may hide a node (none) or show it, but must not switch between flex and block.
        /// </summary>
        static string VisibleDisplay(IrNode node, bool parentFlex)
        {
            // an absent base display is a visible block, exactly like an explicit block
            string result = node.Style.TryGetValue(Base, out var baseLayer) && baseLayer.ContainsKey("display") ? null : "block";
            foreach (var layer in node.Style.Values)
            {
                if (!layer.TryGetValue("display", out var raw)) continue;
                var d = NormalizeDisplay(raw.Trim(), parentFlex, node);
                if (d == "none") continue;
                if (result == null) result = d;
                else if (result != d) throw new UnsupportedStyleException("display", raw, null, "display switches between '" + result + "' and '" + d + "' across layers of '" + node.Id + "'; only none may differ.");
            }
            return result ?? "block";
        }

        /// <summary>
        /// CSS blockifies inline-level boxes that are flex items or absolutely positioned (CSS Display 3, section 2.7):
        /// inline-flex becomes flex, inline-block and inline become block. An in-flow inline-level child of a block
        /// container flows inline, which UI Toolkit cannot do.
        /// </summary>
        static string NormalizeDisplay(string d, bool parentFlex, IrNode node)
        {
            switch (d)
            {
                case "inline-flex":
                case "inline-block":
                case "inline":
                    if (!parentFlex && !IsAbsolute(node))
                        throw new UnsupportedStyleException("display", d, null,
                            "Element '" + node.Id + "' is inline-level in a block container; UI Toolkit has no inline flow. Make the parent a flex row.");
                    return d == "inline-flex" ? "flex" : "block";
                default: return d;
            }
        }

        // ---- CSS defaults ----------------------------------------------------------------------------------

        static void CssDefaults(IrNode node, bool parentBlock, bool parentFlex, bool flex, bool blockSelf)
        {
            var baseLayer = BaseLayer(node);
            bool baseHidden = baseLayer.TryGetValue("display", out var baseDisplay) && baseDisplay.Trim() == "none";
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
            }

            // box-sizing: the kit sets border-box globally; an explicit content-box only matters on a sized element with padding or border
            foreach (var pair in node.Style)
            {
                if (!pair.Value.TryGetValue("box-sizing", out var bsz)) continue;
                if (bsz == "content-box" && HasBoxExtras(node) && (baseLayer.ContainsKey("width") || baseLayer.ContainsKey("height")))
                    throw new UnsupportedStyleException("box-sizing", bsz, null, "content-box with padding or border on a sized element is not supported; the kit sets border-box.");
                pair.Value.Remove("box-sizing");
            }

            // display: USS has flex and none only. block is flex with a column (below); a layer that shows a node the base
            // hides writes flex, any other visible display is redundant
            foreach (var pair in node.Style)
            {
                if (!pair.Value.TryGetValue("display", out var raw)) continue;
                var d = NormalizeDisplay(raw.Trim(), parentFlex, node);
                if (d == "none" || (d != "flex" && d != "block")) continue;
                if (pair.Key == Base) { if (d == "block") pair.Value.Remove("display"); else pair.Value["display"] = "flex"; }
                else if (baseHidden) pair.Value["display"] = "flex";
                else pair.Value.Remove("display");
            }

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
            if (basePosition == null || basePosition == "static")
                foreach (var layer in node.Style.Values) foreach (var k in Insets) layer.Remove(k);

            // wrapping rows: CSS align-content normal behaves like stretch, USS defaults to flex-start
            if (flex && node.Style.Values.Any(l => l.TryGetValue("flex-wrap", out var w) && w != "nowrap") && !baseLayer.ContainsKey("align-content"))
                baseLayer["align-content"] = "stretch";
            foreach (var layer in node.Style.Values)
                if (layer.TryGetValue("align-content", out var ac) && ac == "normal") layer["align-content"] = "stretch";

            // block children are not flex items: no flex properties, and they never shrink
            if (parentBlock && Get(node, Base, "position") != "absolute")
            {
                foreach (var layer in node.Style.Values) foreach (var k in FlexItemKeys) layer.Remove(k);
                baseLayer["flex-shrink"] = "0";
            }

            ExtractTransitions(node);
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
        /// properties, position and insets, size, transforms, opacity, display, z-index and their transitions, in every
        /// layer); it contains the absolute <c>&lt;id&gt;__shadow</c> image, anchored by insets so it follows the
        /// element's size, and the element itself, grown to fill the host. The host owns visibility; an element that is
        /// visibly flex keeps <c>display: flex</c> in its base (the USS default, so it hides nothing) because its text
        /// alignment is composed from the flex rules. The element keeps the Clickable it had before the move (R33).
        /// </summary>
        static IrNode BuildHost(IrNode el)
        {
            var s = el.Shadow;
            if (s.Offset == null) throw new IrFormatException("shadow of node '" + el.Id + "' has no offset");
            el.Shadow = null;
            // after CssDefaults a visible flex display is written as flex in base or in the layer that shows the node
            bool visiblyFlex = el.Style.Values.Any(l => l.TryGetValue("display", out var d) && d.Trim() == "flex");
            bool clickable = IsClickable(el);

            var host = new IrNode { Id = el.Id + "__shadowhost", Kind = "container" };
            BaseLayer(host)["flex-direction"] = "column";

            host.PickingIgnore = el.PickingIgnore;
            foreach (var name in el.Style.Keys.ToList())
            {
                var layer = el.Style[name];
                var hostName = HostLayerName(name);
                Dictionary<string, string> hostLayer = null;
                Dictionary<string, string> HostLayer()
                {
                    if (hostLayer == null && !host.Style.TryGetValue(hostName, out hostLayer)) host.Style[hostName] = hostLayer = new Dictionary<string, string>();
                    return hostLayer;
                }
                foreach (var key in layer.Keys.ToList())
                {
                    if (Moved.Contains(key))
                    {
                        HostLayer()[key] = layer[key];
                        layer.Remove(key);
                    }
                }
                if (layer.Count == 0 && name != Base) el.Style.Remove(name);
            }
            foreach (var name in el.Transitions.Keys.ToList())
            {
                var layer = el.Transitions[name];
                MoveTransitions(layer, () =>
                {
                    var hn = HostLayerName(name);
                    if (!host.Transitions.TryGetValue(hn, out var l)) host.Transitions[hn] = l = new Dictionary<string, string>();
                    return l;
                });
                if (layer.Count == 0) el.Transitions.Remove(name);
            }
            // the host never has the element's pseudo-states; a runtime mirror copies them onto it as dui-* classes
            host.MirrorPseudoState = host.Style.Keys.Concat(host.Transitions.Keys).Any(k => k.StartsWith(ClassPrefix, StringComparison.Ordinal));
            BaseLayer(el)["flex-grow"] = "1";
            if (visiblyFlex) BaseLayer(el)["display"] = "flex";
            // an active layer emptied by the move still made the element pressable: it keeps its Clickable (and with it
            // the pointer capture that ends the press), the host never gets one
            el.Clickable = clickable;

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

        /// <summary>Prefix of the layers whose rules apply to the host while the element is in a pseudo-state.</summary>
        public const string ClassPrefix = "class:dui-";

        static string HostLayerName(string layer) => Pseudo.Contains(layer) ? ClassPrefix + layer : layer;

        static readonly string[] TransitionKeys = { "transition", "transition-property", "transition-duration", "transition-delay", "transition-timing-function" };

        /// <summary>
        /// Transitions are played by the animation player, not by USS: they leave the style layers and are recorded in
        /// <see cref="IrNode.Transitions"/> so nothing animates twice.
        /// </summary>
        static void ExtractTransitions(IrNode node)
        {
            foreach (var pair in node.Style)
                foreach (var key in TransitionKeys)
                {
                    if (!pair.Value.TryGetValue(key, out var v)) continue;
                    if (!node.Transitions.TryGetValue(pair.Key, out var t)) node.Transitions[pair.Key] = t = new Dictionary<string, string>();
                    t[key] = v;
                    pair.Value.Remove(key);
                }
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

        static readonly HashSet<string> EasingWords = new HashSet<string> { "linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end" };

        static string FirstIdent(string entry) => entry.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault(t => !char.IsDigit(t[0]) && t[0] != '.' && t[0] != '-' && !t.Contains("(") && !EasingWords.Contains(t) && t != "allow-discrete" && t != "normal") ?? "";

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
        /// UI Toolkit paints siblings in hierarchy order; CSS paints them by stacking level (CSS 2.1 appendix E): positioned
        /// z &lt; 0 (by z, then tree order), in-flow non-positioned siblings (tree order), positioned z = 0 / auto (tree
        /// order), positioned z &gt; 0 (by z, then tree order). A flex item with a z-index other than auto stacks as if it
        /// were relative (CSS Flexbox 4.3), also when it is static. In-flow order is layout, so it never changes: only
        /// absolute siblings move, each into the one gap between in-flow siblings that gives it its CSS level against
        /// every sibling. This throws, naming the elements, when the in-flow order contradicts a non-zero z-index, when an
        /// absolute sibling has no such gap, or when a static element that is not a flex item has a non-zero z-index (CSS
        /// ignores it). In-flow siblings that differ only by relative positioning (a relative sibling with z-index auto
        /// or 0 before a static one) paint in the other order in CSS, which is visible only where they overlap; that is
        /// left to lint, because rejecting it would reject most designs.
        /// Afterwards <c>position: static</c> children become relative (USS has no static).
        /// </summary>
        static void PaintOrder(IrNode node, bool flexContainer)
        {
            var dom = node.Children.ToList();
            var key = new Dictionary<IrNode, (int level, int z, int dom)>();
            var explicitZ = new HashSet<IrNode>();
            for (int i = 0; i < dom.Count; i++)
            {
                var child = dom[i];
                int z = 0;
                bool hasZ = false;
                if (BaseLayer(child).TryGetValue("z-index", out var raw))
                {
                    raw = raw.Trim();
                    if (raw != "auto")
                    {
                        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out z))
                            throw new IrFormatException("unsupported z-index '" + raw + "' on node '" + child.Id + "'");
                        hasZ = true;
                    }
                    BaseLayer(child).Remove("z-index");
                }
                var position = Get(child, Base, "position");
                bool absolute = position == "absolute";
                bool flexItem = flexContainer && !absolute;
                bool stacks = absolute || position == "relative" || (flexItem && hasZ);
                if (!stacks && z != 0)
                    throw new IrFormatException("z-index " + z + " on '" + child.Id + "' has no effect in CSS: it is static and not a flex item; remove it or set position: relative");
                if (stacks && z != 0) explicitZ.Add(child);
                int level = !stacks ? 1 : z < 0 ? 0 : z == 0 ? 2 : 3;
                key[child] = (level, stacks ? z : 0, i);
            }
            int Cmp(IrNode a, IrNode b) => key[a].CompareTo(key[b]);

            var inflow = dom.Where(c => !IsAbsolute(c)).ToList();
            var abs = dom.Where(IsAbsolute).OrderBy(c => key[c]).ToList();

            // in-flow siblings keep their layout order; a non-zero z-index that needs another order cannot be reproduced
            for (int i = 0; i < inflow.Count; i++)
                for (int j = i + 1; j < inflow.Count; j++)
                    if (Cmp(inflow[j], inflow[i]) < 0 && (explicitZ.Contains(inflow[i]) || explicitZ.Contains(inflow[j])))
                        throw new IrFormatException("'" + inflow[j].Id + "' paints below '" + inflow[i].Id + "' in CSS (z-index) but follows it in the layout order; UI Toolkit paints siblings in layout order. Reorder them in the design or change the z-index.");

            // each absolute sibling goes into gap g (before inflow[g]): after every in-flow sibling it paints above and
            // before every one it paints below; among themselves absolute siblings keep their CSS order
            var gap = new Dictionary<IrNode, int>();
            IrNode previous = null;
            foreach (var a in abs)
            {
                int lo = 0, hi = inflow.Count;
                for (int k = 0; k < inflow.Count; k++)
                {
                    if (Cmp(inflow[k], a) < 0) lo = Math.Max(lo, k + 1);
                    else hi = Math.Min(hi, k);
                }
                if (lo > hi)
                    throw new IrFormatException("absolute '" + a.Id + "' paints above '" + inflow[lo - 1].Id + "' and below '" + inflow[hi].Id + "' in CSS, but '" + inflow[hi].Id + "' comes first in the layout order; UI Toolkit's sibling order cannot reproduce that.");
                int g = previous == null ? lo : Math.Max(lo, gap[previous]);
                if (g > hi)
                    throw new IrFormatException("absolute '" + a.Id + "' paints above '" + previous.Id + "' and below '" + inflow[hi].Id + "' in CSS, but '" + previous.Id + "' has to follow '" + inflow[g - 1].Id + "'; UI Toolkit's sibling order cannot reproduce that.");
                gap[a] = g;
                previous = a;
            }

            var result = new List<IrNode>(dom.Count);
            for (int g = 0; g <= inflow.Count; g++)
            {
                result.AddRange(abs.Where(a => gap[a] == g));
                if (g < inflow.Count) result.Add(inflow[g]);
            }

            node.Children = result.ToArray();
            foreach (var child in node.Children)
                if (Get(child, Base, "position") == "static") BaseLayer(child)["position"] = "relative";
        }

        // ---- helpers ---------------------------------------------------------------------------------------

        static bool IsClickable(IrNode n) => n.Action != null || n.Kind == "button" || n.Kind == "toggle" || n.Style.ContainsKey("active");

        static void RefreshClickable(IrNode n) => n.Clickable = IsClickable(n);

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
                MirrorPseudoState = n.MirrorPseudoState,
                Transitions = n.Transitions?.ToDictionary(kv => kv.Key, kv => new Dictionary<string, string>(kv.Value)) ?? new Dictionary<string, Dictionary<string, string>>(),
            };
        }

        static IrAsset CloneAsset(IrAsset a) => a == null ? null : new IrAsset
        {
            Kind = a.Kind, File = a.File, Sha256 = a.Sha256, Width = a.Width, Height = a.Height, Slice = (float[])a.Slice?.Clone(),
        };
    }
}
