using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace DesignUi.Editor
{
    /// <summary>
    /// IR-level lowerings for what USS cannot express or CSS and USS define differently (spec 5.3). Works on a deep
    /// copy with canonical layer keys; the input is never mutated. Per node, in order:
    /// <list type="number">
    /// <item>Composed properties (font style, white space, overflow, border style and width, a text's alignment) get the
    /// layer unions USS needs: one USS property is computed from several CSS properties, so two layers that hold together
    /// and set different parts of it need a rule of their own.</item>
    /// <item>CssDefaults: make CSS initial values explicit (flex rows, block layout, static positioning, box sizing).</item>
    /// <item>Children are processed, then baked outer shadows get a host wrapper (<see cref="BuildHost"/>).</item>
    /// <item>gap becomes child margins, per layer and per union of the layers that change it.</item>
    /// <item>Siblings are ordered like CSS paints them.</item>
    /// <item>A baked inset shadow becomes the element's first child, an absolute overlay of its padding box
    /// (<see cref="InsetOverlay"/>); per-layer gradients become per-layer images of the element (<see cref="IrNode.AssetLayers"/>).</item>
    /// </list>
    /// A layer's values are resolved like USS resolves its rules (<see cref="Resolve"/>): every layer whose dimensions
    /// are all in the layer's key applies, the most specific (then the latest) wins. The IR records a union for every
    /// property two layers that hold together both set, so this is also the CSS cascade.
    /// </summary>
    public static class Lowering
    {
        const string Base = "base";

        /// <summary>Most layer unions one computation may add before the design is rejected as too combinatorial.</summary>
        const int UnionLimit = 512;

        /// <summary>
        /// Synthetic layer on the template items of a repeat container with a gap: its margin undoes the lowered gap
        /// on the first item. The compiler emits it as a rule for the class <c>__first</c>, which the view toggles on the
        /// first repeated item (USS has no :first-child).
        /// </summary>
        public const string FirstItemLayer = "class:__first";

        static readonly Regex Px = new Regex(@"^(-?\d+(?:\.\d+)?)px$", RegexOptions.Compiled);
        static readonly string[] GapKeys = { "gap", "row-gap", "column-gap" };
        static readonly string[] Insets = { "top", "right", "bottom", "left" };
        static readonly string[] FlexItemKeys = { "flex", "flex-grow", "flex-shrink", "flex-basis", "align-self" };
        static readonly string[] BlockIgnoredKeys = { "flex-direction", "justify-content", "align-items", "flex-wrap", "align-content" };
        static readonly string[] MarginKeys = { "margin-top", "margin-right", "margin-bottom", "margin-left" };

        /// <summary>Properties that move from a shadowed element to its host.</summary>
        static readonly HashSet<string> Moved = new HashSet<string>
        {
            "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
            "flex", "flex-grow", "flex-shrink", "flex-basis", "align-self",
            "position", "top", "right", "bottom", "left",
            "width", "height", "min-width", "min-height", "max-width", "max-height", "aspect-ratio",
            "opacity", "visibility", "rotate", "scale", "translate", "transform-origin", "z-index", "display",
        };

        public static IrNode Apply(IrNode root) => Apply(root, null);

        /// <param name="breakpoints">The screen's breakpoints: two breakpoint layers whose ranges do not overlap never hold
        /// together, so they need no union. Null treats every pair as overlapping.</param>
        public static IrNode Apply(IrNode root, IReadOnlyList<IrBreakpoint> breakpoints)
        {
            if (root == null) throw new ArgumentNullException(nameof(root));
            var bps = new Dictionary<string, IrBreakpoint>(StringComparer.Ordinal);
            foreach (var b in breakpoints ?? new IrBreakpoint[0]) if (b?.Name != null) bps[b.Name] = b;
            var copy = Clone(root);
            if (HasOuterShadow(copy)) throw new IrFormatException("the root node '" + copy.Id + "' has a shadow; a shadow needs a parent to host it");
            Process(copy, false, false, true, false, true, bps);
            if (Get(copy, Base, "position") == "static") BaseLayer(copy)["position"] = "relative";
            MarkNamedAncestors(copy);
            return copy;
        }

        static void Process(IrNode node, bool parentBlock, bool parentFlex, bool parentPositioned, bool ignorePointer, bool isRoot,
            IReadOnlyDictionary<string, IrBreakpoint> bps)
        {
            CompleteUnions(node, bps);
            BackgroundLayerImages(node);
            var visible = VisibleDisplay(node, parentFlex);
            bool flex = visible == "flex";
            bool blockSelf = node.Children.Length > 0 && !flex;
            var position = Get(node, Base, "position");
            bool positioned = isRoot || position == "relative" || position == "absolute";

            if (position == "absolute" && !parentPositioned)
                throw new UnsupportedStyleException("position", "absolute", "U-CSS-035",
                    "Element '" + node.Id + "' is absolute but its parent is not positioned; set position: relative on the parent (UI Toolkit anchors absolute elements to the parent, CSS to the nearest positioned ancestor).");

            CssDefaults(node, parentBlock, parentFlex, flex, blockSelf);

            // pointer-events is inherited in CSS; picking mode is not
            var pe = Get(node, Base, "pointer-events");
            if (pe == "none") ignorePointer = true;
            else if (pe == "auto") ignorePointer = false;
            else if (pe != null) throw new UnsupportedStyleException("pointer-events", pe);
            if (pe != null) BaseLayer(node).Remove("pointer-events");
            node.PickingIgnore = ignorePointer || node.External; // an external element never takes the pointer (Unpaint)

            foreach (var child in node.Children) Process(child, blockSelf, flex, positioned, ignorePointer, false, bps);
            WrapShadows(node);
            LowerGap(node, bps);
            PaintOrder(node, flex);
            InsetOverlay(node);
            RefreshClickable(node);
            node.Focusable = IsFocusable(node);
        }

        // ---- cascade -------------------------------------------------------------------------------------

        /// <summary>
        /// The value of a property on a node while exactly the dimensions of <paramref name="key"/> hold, as USS resolves
        /// the compiled rules: among the node's layers whose dimensions are all in the key (without the key itself when
        /// <paramref name="includeSelf"/> is false) that set the property, the most specific wins, then the latest rule
        /// (<see cref="LayerKey.CascadeCompare"/>). Null when none sets it.
        /// </summary>
        internal static string Resolve(IrNode n, LayerKey key, string prop, bool includeSelf)
        {
            string best = null;
            LayerKey bestKey = null;
            foreach (var pair in n.Style)
            {
                if (!pair.Value.TryGetValue(prop, out var v)) continue;
                var k = LayerKey.Parse(pair.Key);
                if (!k.IsSubsetOf(key) || (!includeSelf && k.Equals(key))) continue;
                if (bestKey == null || LayerKey.CascadeCompare(k, bestKey) > 0)
                {
                    best = v.Trim();
                    bestKey = k;
                }
            }
            return best;
        }

        /// <summary>
        /// What a layer is applied over: every property the node's other layers inside the key set, resolved with
        /// <see cref="Resolve"/> (base is the basis of every layer). The mapper composes font style, white space, text
        /// alignment and border widths from the layer overlaid on it.
        /// </summary>
        internal static Dictionary<string, string> Basis(IrNode n, string key)
        {
            var k = LayerKey.Parse(key);
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var prop in n.Style.Where(p => LayerKey.Parse(p.Key).IsSubsetOf(k) && p.Key != k.Text).SelectMany(p => p.Value.Keys).Distinct())
            {
                var v = Resolve(n, k, prop, false);
                if (v != null) result[prop] = v;
            }
            return result;
        }

        /// <summary>Layer keys of a node, base first, then in the order their rules are written (<see cref="LayerKey.RuleOrder"/>).</summary>
        static List<string> OrderedKeys(IrNode n) =>
            n.Style.Keys.Select(LayerKey.Parse).OrderBy(k => k, LayerKey.RuleOrder).Select(k => k.Text).ToList();

        static readonly string[][] ComposedGroups = BuildComposedGroups();

        static string[][] BuildComposedGroups()
        {
            var groups = new List<string[]>
            {
                new[] { "font-weight", "font-style" },
                new[] { "white-space", "white-space-collapse", "text-wrap-mode" },
                new[] { "overflow", "overflow-x", "overflow-y" },
            };
            foreach (var side in Insets) groups.Add(new[] { "border-style", "border-" + side + "-style", "border-width", "border-" + side + "-width" });
            return groups.ToArray();
        }

        /// <summary>The CSS properties a text element's <c>-unity-text-align</c> is composed from.</summary>
        static readonly string[] TextAlignGroup = { "text-align", "display", "flex-direction", "align-items", "justify-content" };

        internal static bool IsTextNode(IrNode n) => n.Kind == "text" || n.Text != null;

        /// <summary>
        /// One USS property composed from several CSS properties (font style, white space, overflow, a border side's used
        /// width, a text's alignment) is written whole by every layer that sets any part of it. When two layers that hold
        /// together set different parts, USS would keep only one layer's composition, so their union gets the merged
        /// parts (resolved over its own layers) and with them the composition of both.
        /// </summary>
        static void CompleteUnions(IrNode node, IReadOnlyDictionary<string, IrBreakpoint> bps)
        {
            var groups = IsTextNode(node) ? ComposedGroups.Concat(new[] { TextAlignGroup }) : ComposedGroups;
            foreach (var group in groups)
            {
                // a layer that only hides a text does not change how it is aligned
                bool Sets(Dictionary<string, string> layer) =>
                    group.Any(prop => layer.TryGetValue(prop, out var v) && !(group == TextAlignGroup && prop == "display" && v.Trim() == "none"));
                var setters = node.Style.Where(p => p.Key != Base && Sets(p.Value)).Select(p => LayerKey.Parse(p.Key)).ToList();
                if (setters.Count < 2) continue;
                var unions = LayerKey.UnionClosure(setters, bps, UnionLimit, () => "The layers of '" + node.Id + "' that set " + string.Join(", ", group));
                foreach (var u in unions)
                {
                    node.Style.TryGetValue(u.Text, out var layer);
                    // longhands first: a shorthand is left out next to one of its longhands (the other parts come from the basis)
                    foreach (var prop in group.OrderBy(x => GroupShorthands.ContainsKey(x) ? 1 : 0))
                    {
                        if (layer != null && (layer.ContainsKey(prop) || Conflicts(layer, prop))) continue;
                        if (!setters.Any(x => x.IsSubsetOf(u) && node.Style[x.Text].ContainsKey(prop))) continue;
                        var v = Resolve(node, u, prop, false);
                        if (v == null) continue;
                        if (layer == null) node.Style[u.Text] = layer = new Dictionary<string, string>();
                        layer[prop] = v;
                    }
                }
            }
        }

        /// <summary>The shorthands among the composed groups and their longhands.</summary>
        static readonly Dictionary<string, string[]> GroupShorthands = new Dictionary<string, string[]>
        {
            { "border-style", Insets.Select(x => "border-" + x + "-style").ToArray() },
            { "border-width", Insets.Select(x => "border-" + x + "-width").ToArray() },
            { "white-space", new[] { "white-space-collapse", "text-wrap-mode" } },
            { "overflow", new[] { "overflow-x", "overflow-y" } },
        };

        /// <summary>Whether a layer already holds the shorthand of <paramref name="prop"/>, or one of its longhands.</summary>
        static bool Conflicts(Dictionary<string, string> layer, string prop) =>
            (GroupShorthands.TryGetValue(prop, out var longhands) && longhands.Any(layer.ContainsKey)) ||
            GroupShorthands.Any(kv => kv.Value.Contains(prop) && layer.ContainsKey(kv.Key));

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
            baseLayer.TryGetValue("position", out var basePosition);

            foreach (var pair in node.Style)
            {
                if (pair.Key == Base) continue;
                var layer = pair.Value;
                if (layer.TryGetValue("box-shadow", out var bs))
                    throw new UnsupportedStyleException("box-shadow", bs, null, "box-shadow in style layer '" + pair.Key + "'; the exporter bakes shadows per layer into shadowLayers and insetShadowLayers (re-export the design).");
                if (layer.TryGetValue("z-index", out var z))
                    throw new UnsupportedStyleException("z-index", z, "U-CSS-004", "z-index is only allowed in the base layer (layer '" + pair.Key + "').");
                if (layer.TryGetValue("pointer-events", out var pe))
                    throw new UnsupportedStyleException("pointer-events", pe, null, "pointer-events is only allowed in the base layer.");
                if (layer.TryGetValue("position", out var pos) && Position(pos) != Position(basePosition))
                    throw new UnsupportedStyleException("position", pos, "U-CSS-035", "position cannot change between layers ('" + pair.Key + "').");
            }

            // box-sizing: the kit sets border-box globally; an explicit content-box only matters on a sized element with padding or border
            foreach (var pair in node.Style)
            {
                if (!pair.Value.TryGetValue("box-sizing", out var bsz)) continue;
                if (bsz == "content-box" && HasBoxExtras(node) && (baseLayer.ContainsKey("width") || baseLayer.ContainsKey("height")))
                    throw new UnsupportedStyleException("box-sizing", bsz, "U-CSS-036", "content-box with padding or border on a sized element is not supported; the kit sets border-box.");
                pair.Value.Remove("box-sizing");
            }

            // display: USS has flex and none only. block is flex with a column (below); a layer that shows a node its basis
            // (base and the layers inside its key, already rewritten) hides writes flex, any other visible display is redundant
            foreach (var key in OrderedKeys(node))
            {
                var layer = node.Style[key];
                if (!layer.TryGetValue("display", out var raw)) continue;
                var d = NormalizeDisplay(raw.Trim(), parentFlex, node);
                if (d == "none" || (d != "flex" && d != "block")) continue;
                if (key == Base) { if (d == "block") layer.Remove("display"); else layer["display"] = "flex"; }
                else if (Resolve(node, LayerKey.Parse(key), "display", false) == "none") layer["display"] = "flex";
                else layer.Remove("display");
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

        static bool HasOuterShadow(IrNode n) => n.Shadow != null || (n.ShadowLayers != null && n.ShadowLayers.Count > 0);

        static void WrapShadows(IrNode node)
        {
            for (int i = 0; i < node.Children.Length; i++)
            {
                var el = node.Children[i];
                if (!HasOuterShadow(el)) continue;
                node.Children[i] = BuildHost(el);
            }
        }

        /// <summary>
        /// <c>&lt;id&gt;__shadowhost</c> takes the element's slot and the properties that place it (margins, flex item
        /// properties, position and insets, size, transforms, opacity, display, z-index and their transitions, in every
        /// layer); it contains the absolute <c>&lt;id&gt;__shadow</c> image, anchored by insets so it covers the drawn rect
        /// of the shadow's offset and follows the element's size, and the element itself, grown to fill the host. A shadow
        /// that changes per layer (<see cref="IrNode.ShadowLayers"/>, e.g. a hover lift) gives the image a rule per layer
        /// with that layer's insets and 9-slice (none where the layer has no shadow); the element's own pseudo-states and
        /// classes reach it through the host's mirror classes (<c>anc(&lt;id&gt;__shadowhost):class:dui-hover</c>). The host
        /// owns visibility; an element that is visibly flex keeps <c>display: flex</c> in its base (the USS default, so it
        /// hides nothing) because its text alignment is composed from the flex rules. The element keeps the Clickable it
        /// had before the move (a pressed shadow layer alone makes it pressable); a runtime mirror copies its pseudo-states
        /// onto the host.
        /// </summary>
        static IrNode BuildHost(IrNode el)
        {
            var s = el.Shadow;
            var layers = el.ShadowLayers ?? new Dictionary<string, IrShadow>();
            if (s != null && s.Offset == null) throw new IrFormatException("shadow of node '" + el.Id + "' has no offset");
            foreach (var kv in layers)
                if (kv.Value != null && kv.Value.Offset == null) throw new IrFormatException("shadow of layer '" + kv.Key + "' of node '" + el.Id + "' has no offset");
            // after CssDefaults a visible flex display is written as flex in base or in the layer that shows the node
            bool visiblyFlex = el.Style.Values.Any(l => l.TryGetValue("display", out var d) && d.Trim() == "flex");
            bool clickable = IsClickable(el);
            bool focusable = IsFocusable(el);
            el.Shadow = null;
            el.ShadowLayers = new Dictionary<string, IrShadow>();

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
            MoveAnims(el, host);
            // the host never has the element's pseudo-states; a runtime mirror copies them onto it as dui-* classes
            var hostKeys = host.Style.Keys.Concat(host.Transitions.Keys).Concat(host.Anims.Select(a => a.Trigger).Where(t => t != LayerKey.ShowTrigger))
                .Concat(layers.Keys.Select(HostLayerName))
                .Select(LayerKey.Parse).ToList();
            host.MirrorPseudoState = hostKeys.Any(k => k.OfKind(LayerDimKind.Class).Any(d => d.Name.StartsWith(MirrorClassPrefix, StringComparison.Ordinal)));
            // the element's own view-toggled classes that moved layers depend on: the view toggles them on the host too,
            // which starts with the ones the element starts with
            host.MirrorClasses = hostKeys.SelectMany(k => k.OfKind(LayerDimKind.Class)).Select(d => d.Name)
                .Where(c => !c.StartsWith(MirrorClassPrefix, StringComparison.Ordinal)).Distinct().OrderBy(c => c, StringComparer.Ordinal).ToArray();
            host.Classes = (el.Classes ?? new string[0]).Where(c => Array.IndexOf(host.MirrorClasses, c) >= 0).ToArray();
            BaseLayer(el)["flex-grow"] = "1";
            if (visiblyFlex) BaseLayer(el)["display"] = "flex";
            // an active layer emptied by the move still made the element pressable: it keeps its Clickable (and with it
            // the pointer capture that ends the press), the host never gets one
            el.Clickable = clickable;
            el.Focusable = focusable;

            var shadow = new IrNode
            {
                Id = el.Id + "__shadow",
                Kind = "image",
                PickingIgnore = true,
                Asset = Plain(s),
                Style = new Dictionary<string, Dictionary<string, string>> { { Base, DrawnRect(s?.Offset) } },
            };
            shadow.Style[Base]["position"] = "absolute";
            foreach (var kv in layers)
            {
                // the element's layer as the image sees it: a child of the host, whose mirror classes carry the element's state
                var key = LayerKey.Parse(HostLayerName(kv.Key)).Map(d => d.ToDescendant(host.Id)).Text;
                if (kv.Value != null) shadow.Style[key] = DrawnRect(kv.Value.Offset);
                shadow.AssetLayers[key] = Plain(kv.Value);
            }
            host.Children = new[] { shadow, el };
            return host;
        }

        /// <summary>
        /// The insets that place an absolute image on the drawn rect (x + ox, y + oy, w + ow, h + oh) of a box (x, y, w, h)
        /// it is the child of; a missing offset covers the box.
        /// </summary>
        static Dictionary<string, string> DrawnRect(BoxRect o)
        {
            float x = o?.X ?? 0, y = o?.Y ?? 0, w = o?.W ?? 0, h = o?.H ?? 0;
            return new Dictionary<string, string>
            {
                { "left", Fmt(x) + "px" },
                { "top", Fmt(y) + "px" },
                { "right", Fmt(-(x + w)) + "px" },
                { "bottom", Fmt(-(y + h)) + "px" },
            };
        }

        /// <summary>An image asset without the shadow's offset (the compiler places it by insets), or null.</summary>
        static IrAsset Plain(IrAsset a) => a == null ? null : new IrAsset
        {
            Kind = a.Kind, File = a.File, Sha256 = a.Sha256, Width = a.Width, Height = a.Height, Slice = (float[])a.Slice?.Clone(), Tint = a.Tint, StopGap = a.StopGap,
        };

        // ---- inset shadow ----------------------------------------------------------------------------------

        /// <summary>
        /// An inset shadow is drawn above the element's background and border and below its content (CSS paints the
        /// border after it; the two differ only on the anti-aliased inner edge of a curved border). It becomes the element's
        /// first child, <c>&lt;id&gt;__inset</c>: absolute with zero insets, which is the padding box (UI Toolkit places an
        /// absolute child inside the parent's border, as CSS does), not pickable, its 9-slice stretched over it. Its rule per
        /// layer of <see cref="IrNode.InsetShadowLayers"/> names the element's own pseudo-states and classes as
        /// <c>anc(&lt;id&gt;):…</c>. Content the element draws itself (its own text, a form control's parts, scrolled content)
        /// would cover or scroll it, so those elements are rejected; a content image moves to a child above it.
        /// </summary>
        static void InsetOverlay(IrNode node)
        {
            if (node.InsetShadow == null && (node.InsetShadowLayers == null || node.InsetShadowLayers.Count == 0)) return;
            string value = "inset " + (node.InsetShadow?.File ?? node.InsetShadowLayers.Values.FirstOrDefault(v => v != null)?.File ?? "none");
            if (node.Text != null)
                throw new UnsupportedStyleException("box-shadow", value, null,
                    "Element '" + node.Id + "' has an inset box-shadow and its own text; UI Toolkit draws an element's text below its children, so the " +
                    "inset shadow would cover it. Put the text in a child element of the shadowed box.");
            switch (node.Kind)
            {
                case "input":
                case "toggle":
                case "dropdown":
                    throw new UnsupportedStyleException("box-shadow", value, null,
                        "Form control '" + node.Id + "' (" + node.Kind + ") has an inset box-shadow; its UI Toolkit control draws its own parts above an overlay. " +
                        "Put the inset shadow on a wrapper element behind the control.");
                case "scroll":
                case "list":
                    throw new UnsupportedStyleException("box-shadow", value, null,
                        "Scroll area '" + node.Id + "' has an inset box-shadow; an overlay inside it would scroll with the content. Put the inset shadow on a wrapper " +
                        "element around the scroll area.");
            }
            var overlay = new IrNode
            {
                Id = node.Id + "__inset",
                Kind = "image",
                PickingIgnore = true,
                Asset = Plain(node.InsetShadow),
                Style = new Dictionary<string, Dictionary<string, string>>
                {
                    { Base, new Dictionary<string, string> { { "position", "absolute" }, { "left", "0px" }, { "top", "0px" }, { "right", "0px" }, { "bottom", "0px" } } },
                },
            };
            foreach (var kv in node.InsetShadowLayers ?? new Dictionary<string, IrShadow>())
                overlay.AssetLayers[LayerKey.Parse(kv.Key).Map(d => d.ToDescendant(node.Id)).Text] = Plain(kv.Value);
            node.InsetShadow = null;
            node.InsetShadowLayers = new Dictionary<string, IrShadow>();
            node.Children = new[] { overlay }.Concat(node.Children).ToArray();
        }

        // ---- background images per layer ------------------------------------------------------------------

        static readonly Regex UrlValue = new Regex(@"^url\(\s*(?:""([^""]*)""|'([^']*)'|([^)""']*?))\s*\)$", RegexOptions.Compiled);

        /// <summary>The file of a single <c>url()</c> value, <c>none</c>, or null for anything else (a gradient, a list).</summary>
        static string ImageFile(string value)
        {
            if (value == null) return null;
            value = value.Trim();
            if (value == "none") return "none";
            var m = UrlValue.Match(value);
            return !m.Success ? null : m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value.Trim();
        }

        /// <summary>
        /// The background image per layer (<see cref="IrNode.BackgroundLayers"/>). Gradients appear only in the effect
        /// maps: each layer's gradient (or none) becomes that layer's image (<see cref="IrNode.AssetLayers"/>), stretched
        /// over the element like the base gradient. url() images stay in the style layers, where the compiler reads them with
        /// their CSS background geometry; the map only mirrors them, which is checked. A layer whose map entry differs from
        /// the url() image of the style layers combines a url() image with a gradient, which UI Toolkit cannot draw on one
        /// element (one background image, one geometry).
        /// </summary>
        static void BackgroundLayerImages(IrNode node)
        {
            if (node.BackgroundLayers == null || node.BackgroundLayers.Count == 0) return;
            bool urlImages = node.Style.Values.Any(l => l.ContainsKey("background-image"));
            foreach (var kv in node.BackgroundLayers.OrderBy(kv => kv.Key, StringComparer.Ordinal))
            {
                if (urlImages)
                {
                    var styled = ImageFile(Resolve(node, LayerKey.Parse(kv.Key), "background-image", true)) ?? (kv.Key == Base ? null : ImageFile(Get(node, Base, "background-image")));
                    if (styled == (kv.Value?.File ?? "none")) continue;
                    throw new UnsupportedStyleException("background-image", kv.Value?.File ?? "none", null,
                        "Element '" + node.Id + "' combines a url() background image with a gradient (layer '" + kv.Key + "'); UI Toolkit draws one background " +
                        "image per element with one geometry. Put the gradient or the image on a child element.");
                }
                node.AssetLayers[kv.Key] = kv.Value?.Copy();
            }
            node.BackgroundLayers = new Dictionary<string, IrAsset>();
        }

        /// <summary>Prefix of the layers whose rules apply to the host while the element is in a pseudo-state.</summary>
        public const string ClassPrefix = "class:dui-";

        /// <summary>Prefix of the classes a PseudoStateMirror sets on a host (<c>dui-hover</c> and so on).</summary>
        const string MirrorClassPrefix = "dui-";

        /// <summary>
        /// The host's key for a layer of its element: the element's own pseudo-states become the mirror classes
        /// (<c>state:x+hover</c> becomes <c>state:x+class:dui-hover</c>); breakpoints, states, classes and ancestor
        /// conditions are unchanged (the host is inside the same ancestors).
        /// </summary>
        static string HostLayerName(string layer)
        {
            if (layer == Base) return Base;
            return LayerKey.Parse(layer).Map(d => d.Kind == LayerDimKind.Pseudo ? LayerDim.Class(MirrorClassPrefix + d.Name) : d).Text;
        }

        /// <summary>
        /// Animations of moved properties move to the host with the host's trigger (an animation of moved and other
        /// properties is split; <c>all</c> stays on both), so the host and its shadow animate together.
        /// </summary>
        static void MoveAnims(IrNode el, IrNode host)
        {
            var keep = new List<IrAnim>();
            foreach (var a in el.Anims)
            {
                var moved = a.Properties.Where(p => p == "all" || Moved.Contains(p)).ToArray();
                var kept = a.Properties.Where(p => p == "all" || !Moved.Contains(p)).ToArray();
                if (moved.Length > 0) host.Anims.Add(Restrict(a, moved, a.Trigger == LayerKey.ShowTrigger ? a.Trigger : HostLayerName(a.Trigger)));
                if (kept.Length > 0) keep.Add(moved.Length == 0 ? a : Restrict(a, kept, a.Trigger));
            }
            el.Anims = keep;
        }

        static IrAnim Restrict(IrAnim a, string[] properties, string trigger)
        {
            var copy = a.Clone();
            copy.Properties = properties;
            copy.Trigger = trigger;
            if (Array.IndexOf(properties, "all") < 0)
                foreach (var k in copy.Keyframes)
                    k.Values = k.Values.Where(kv => Array.IndexOf(properties, kv.Key) >= 0).ToDictionary(kv => kv.Key, kv => kv.Value);
            return copy;
        }

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

        static readonly string[] GapLayoutKeys = { "gap", "row-gap", "column-gap", "flex-direction", "flex-wrap" };

        /// <summary>
        /// gap becomes margins on the in-flow children (USS has no gap). A child's margin in a layer is its own margin
        /// there plus the container's gap there, unless it is the first visible child (in a repeat: unless it carries the
        /// first-item class). The layers that matter for a child are the container's layers that change its gap or
        /// direction (seen from the child: the container's own pseudo-states and classes become <c>anc(container)</c>
        /// conditions), the child's layers that set a margin and the earlier siblings' layers that hide or show them;
        /// every union of those that can hold is computed too, and a margin is written wherever the compiled rules would
        /// otherwise give another value.
        /// </summary>
        static void LowerGap(IrNode node, IReadOnlyDictionary<string, IrBreakpoint> bps)
        {
            if (!node.Style.Values.Any(l => GapKeys.Any(l.ContainsKey))) return;

            var inflow = node.Children.Where(c => !IsAbsolute(c)).ToList();
            foreach (var c in inflow)
                foreach (var pair in c.Style)
                    if (pair.Value.ContainsKey("margin"))
                        throw new IrFormatException("child '" + c.Id + "' has a margin shorthand next to a lowered gap in '" + node.Id + "'");

            LayerKey ToChild(LayerKey k) => k.Map(d => d.ToDescendant(node.Id));
            LayerKey ToParent(LayerKey k) => k.Map(d => d.ToAncestor(node.Id));
            var containerKeys = node.Style.Where(p => p.Key != Base && GapLayoutKeys.Any(p.Value.ContainsKey)).Select(p => ToChild(LayerKey.Parse(p.Key))).Distinct().ToList();

            // the container's direction and main-axis gap while a (child-side) key holds
            var effCache = new Dictionary<LayerKey, (string dir, float gap)>();
            (string dir, float gap) Eff(LayerKey childKey)
            {
                var k = ToParent(childKey);
                if (effCache.TryGetValue(k, out var e)) return e;
                var dir = Resolve(node, k, "flex-direction", true) ?? "row";
                var wrap = Resolve(node, k, "flex-wrap", true) ?? "nowrap";
                bool row = dir == "row" || dir == "row-reverse";
                var gap = AxisGap(node, k, row ? "column-gap" : "row-gap", row ? 1 : 0);
                if (gap > 0 && wrap != "nowrap")
                    throw new IrFormatException("gap on a wrapping flex container cannot be lowered (node '" + node.Id + "', layer '" + k.Text + "')");
                return effCache[k] = (dir, gap);
            }

            var baseEff = Eff(LayerKey.Base);
            bool repeat = node.Repeat != null;
            if (repeat)
                foreach (var k in containerKeys)
                    if (Eff(k) != baseEff)
                        throw new UnsupportedStyleException("gap", Resolve(node, ToParent(k), "gap", true) ?? "", null,
                            "A repeat container's gap and direction cannot change between layers ('" + ToParent(k).Text + "').");
            var firstItem = LayerKey.Parse(FirstItemLayer).Dims[0];

            // the children as the IR describes them, before any gap margin is written
            var own = inflow.ToDictionary(c => c, c => new IrNode { Id = c.Id, Style = c.Style.ToDictionary(kv => kv.Key, kv => new Dictionary<string, string>(kv.Value)) });
            bool Hidden(IrNode n, LayerKey k) => Resolve(n, k, "display", true) == "none";
            // a child's own pseudo-states and classes say nothing about its siblings
            LayerKey ToSibling(LayerKey k) => k.Map(d => d.Kind == LayerDimKind.Pseudo || d.Kind == LayerDimKind.Class ? null : d);

            for (int i = 0; i < inflow.Count; i++)
            {
                var c = inflow[i];
                var relevant = new List<LayerKey>(containerKeys);
                relevant.AddRange(own[c].Style.Where(p => p.Key != Base && MarginKeys.Any(p.Value.ContainsKey)).Select(p => LayerKey.Parse(p.Key)));
                if (repeat)
                {
                    if (baseEff.gap > 0) relevant.Add(LayerKey.Of(new[] { firstItem }));
                }
                // an earlier sibling that is never hidden keeps the child from ever being first: siblings' layers do not matter
                else if (!inflow.Take(i).Any(sib => !Hidden(own[sib], LayerKey.Base) && !own[sib].Style.Values.Any(l => l.TryGetValue("display", out var dv) && dv.Trim() == "none")))
                    for (int j = 0; j < i; j++)
                        foreach (var p in own[inflow[j]].Style.Where(p => p.Key != Base && p.Value.ContainsKey("display")))
                        {
                            var k = LayerKey.Parse(p.Key);
                            if (k.Has(LayerDimKind.Pseudo) || k.Has(LayerDimKind.Class))
                                throw new UnsupportedStyleException("display", p.Value["display"], "U-CSS-034",
                                    "'" + inflow[j].Id + "' shows or hides itself by its own pseudo-state or class (layer '" + p.Key + "') before '" + c.Id +
                                    "' in the gap container '" + node.Id + "'; USS cannot select a sibling's state, so the gap after it cannot follow. Use a screen state, or a state or class of an ancestor.");
                            relevant.Add(k);
                        }

                var keys = new List<LayerKey> { LayerKey.Base };
                keys.AddRange(relevant.Where(k => !k.IsBase));
                keys.AddRange(LayerKey.UnionClosure(relevant, bps, UnionLimit, () => "The gap of '" + node.Id + "' and the layers of '" + c.Id + "'"));
                keys = keys.Distinct().OrderBy(k => k, LayerKey.RuleOrder).ToList();
                var props = keys.Select(k => MarginProp(Eff(k).dir)).Distinct().ToList();

                bool IsFirst(LayerKey k) => repeat ? k.Contains(firstItem) : inflow.Take(i).All(s => Hidden(own[s], ToSibling(k)));

                foreach (var k in keys)
                {
                    var (dir, gap) = Eff(k);
                    foreach (var p in props)
                    {
                        var mine = Resolve(own[c], k, p, true);
                        string expected = mine == "auto"
                            ? "auto"
                            : Fmt((mine == null ? 0 : ParsePx(mine, p, c.Id)) + (p == MarginProp(dir) && !IsFirst(k) ? gap : 0)) + "px";
                        if (k.IsBase)
                        {
                            if (!SameLength(expected, mine ?? "0px")) BaseLayer(c)[p] = expected;
                            continue;
                        }
                        bool hasOwn = own[c].Style.TryGetValue(k.Text, out var ownLayer) && ownLayer.ContainsKey(p);
                        if (hasOwn || !SameLength(expected, Resolve(c, k, p, false) ?? "0px"))
                        {
                            if (!c.Style.TryGetValue(k.Text, out var layer)) c.Style[k.Text] = layer = new Dictionary<string, string>();
                            layer[p] = expected;
                        }
                    }
                }
            }

            foreach (var layer in node.Style.Values) foreach (var k in GapKeys) layer.Remove(k);
        }

        /// <summary>One axis of the gap while a (container-side) key holds: the longhand, else the shorthand's part, of the winning layer.</summary>
        static float AxisGap(IrNode node, LayerKey key, string longhand, int index)
        {
            Dictionary<string, string> best = null;
            LayerKey bestKey = null;
            foreach (var pair in node.Style)
            {
                if (!pair.Value.ContainsKey(longhand) && !pair.Value.ContainsKey("gap")) continue;
                var k = LayerKey.Parse(pair.Key);
                if (!k.IsSubsetOf(key)) continue;
                if (bestKey == null || LayerKey.CascadeCompare(k, bestKey) > 0) { best = pair.Value; bestKey = k; }
            }
            if (best == null) return 0;
            if (best.TryGetValue(longhand, out var v)) return GapPx(v, node.Id);
            var parts = best["gap"].Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 1 || parts.Length > 2) throw new IrFormatException("unsupported gap value '" + best["gap"] + "' on node '" + node.Id + "'");
            return GapPx(parts[Math.Min(index, parts.Length - 1)], node.Id);
        }

        static bool SameLength(string a, string b)
        {
            a = a.Trim();
            b = b.Trim();
            if (a == b) return true;
            if (a == "auto" || b == "auto") return false;
            return TryPx(a, out var x) && TryPx(b, out var y) && x == y;
        }

        static bool TryPx(string v, out float px)
        {
            px = 0;
            if (v == "0") return true;
            var m = Px.Match(v);
            return m.Success && float.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out px);
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

        static bool IsActive(LayerDim d) => d.Kind == LayerDimKind.Pseudo && d.Name == "active";

        /// <summary>A node's style layer keys, the keys of its effect maps and its animation triggers.</summary>
        static IEnumerable<string> KeysAndTriggers(IrNode n) =>
            n.Style.Keys.Concat(n.EffectKeys).Concat(n.Anims.Select(a => a.Trigger).Where(t => t != LayerKey.ShowTrigger));

        /// <summary>
        /// A button, toggle or action, or an element with a layer of its own <c>:active</c> (a style layer, or a layer that
        /// exists only in an effect map, such as <c>:active { box-shadow: none }</c>).
        /// </summary>
        static bool IsClickable(IrNode n) =>
            n.Action != null || n.Kind == "button" || n.Kind == "toggle" || n.Style.Keys.Concat(n.EffectKeys).Any(k => LayerKey.Parse(k).Dims.Any(IsActive));

        /// <summary>A layer or animation of the element's own <c>:focus</c>: UI Toolkit focuses only focusable elements.</summary>
        static bool IsFocusable(IrNode n) =>
            KeysAndTriggers(n).Any(k => LayerKey.Parse(k).Dims.Any(d => d.Kind == LayerDimKind.Pseudo && d.Name == "focus"));

        static void RefreshClickable(IrNode n) => n.Clickable = IsClickable(n);

        /// <summary>
        /// An element that a descendant's layer or animation names as pressed (<c>anc(id):active</c>) needs a Clickable too,
        /// because UI Toolkit sets :active only on elements with one; one named as focused (<c>anc(id):focus</c>) must be
        /// focusable.
        /// </summary>
        static void MarkNamedAncestors(IrNode root)
        {
            var byId = new Dictionary<string, IrNode>(StringComparer.Ordinal);
            void Index(IrNode n)
            {
                if (n.Id != null && !byId.ContainsKey(n.Id)) byId[n.Id] = n;
                foreach (var c in n.Children) Index(c);
            }
            void Mark(IrNode n)
            {
                foreach (var dim in KeysAndTriggers(n).SelectMany(k => LayerKey.Parse(k).OfKind(LayerDimKind.Ancestor)))
                {
                    if (dim.AncestorClass || !byId.TryGetValue(dim.AncestorId, out var target)) continue;
                    if (dim.Name == "active") target.Clickable = true;
                    if (dim.Name == "focus") target.Focusable = true;
                }
                foreach (var c in n.Children) Mark(c);
            }
            Index(root);
            Mark(root);
        }

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

        /// <summary>
        /// A deep copy whose layer keys are canonical (<see cref="LayerKey"/>); two keys naming the same layer are an error.
        /// An external element comes out unpainted (<see cref="Unpaint"/>).
        /// </summary>
        static IrNode Clone(IrNode n)
        {
            var copy = CloneNode(n);
            if (copy.External) Unpaint(copy);
            return copy;
        }

        const string Transparent = "rgba(0, 0, 0, 0)";
        static readonly string[] Sides = { "top", "right", "bottom", "left" };

        /// <summary>
        /// An external element (<c>data-u-external</c>: what the host draws there, such as a game's shell around the screen)
        /// keeps its box in the compiled screen: size, position, margins, padding and border widths stay, so the layout
        /// around it is the design's. It paints nothing: no background or image, no border colour, no shadow, no text, no
        /// children, and it ignores the pointer, so the host's own UI below the screen shows through and keeps its input.
        /// </summary>
        internal static void Unpaint(IrNode n)
        {
            foreach (var layer in n.Style.Values)
            {
                if (layer == null) continue;
                foreach (var key in layer.Keys.ToList())
                    if (Paints(key)) layer.Remove(key);
                foreach (var side in Sides)
                    if (layer.ContainsKey("border-" + side + "-width")) layer["border-" + side + "-color"] = Transparent;
            }
            foreach (var key in n.Style.Keys.Where(k => k != Base && n.Style[k] != null && n.Style[k].Count == 0).ToList()) n.Style.Remove(key);
            n.Text = null;
            n.AttrTexts?.Clear();
            n.Asset = null;
            n.Background = null;
            n.BackgroundLayers?.Clear();
            n.AssetLayers?.Clear();
            n.Shadow = null;
            n.ShadowLayers?.Clear();
            n.InsetShadow = null;
            n.InsetShadowLayers?.Clear();
            n.Anims?.Clear();
            n.Children = new IrNode[0];
            n.Clickable = false;
            n.Focusable = false;
            n.PickingIgnore = true;
        }

        /// <summary>Properties that only paint (an external element keeps every other one).</summary>
        static bool Paints(string prop) =>
            prop.StartsWith("background", StringComparison.Ordinal) || prop.StartsWith("-unity-background", StringComparison.Ordinal) ||
            prop.StartsWith("outline", StringComparison.Ordinal) || prop.StartsWith("-unity-text", StringComparison.Ordinal) ||
            (prop.StartsWith("border-", StringComparison.Ordinal) && prop.EndsWith("-color", StringComparison.Ordinal)) ||
            prop == "color" || prop == "box-shadow" || prop == "text-shadow" || prop == "opacity" || prop == "filter" || prop == "cursor";

        static IrNode CloneNode(IrNode n)
        {
            return new IrNode
            {
                Id = n.Id,
                Kind = n.Kind,
                External = n.External,
                Classes = (string[])n.Classes?.Clone() ?? new string[0],
                Style = CanonicalLayers(n.Style, n.Id),
                Text = CloneText(n.Text),
                Asset = CloneAsset(n.Asset),
                Background = CloneAsset(n.Background),
                BackgroundLayers = CanonicalMap(n.BackgroundLayers, n.Id, a => a?.Copy()),
                Shadow = n.Shadow?.CopyShadow(),
                ShadowLayers = CanonicalMap(n.ShadowLayers, n.Id, s => s?.CopyShadow()),
                InsetShadow = n.InsetShadow?.CopyShadow(),
                InsetShadowLayers = CanonicalMap(n.InsetShadowLayers, n.Id, s => s?.CopyShadow()),
                AssetLayers = CanonicalMap(n.AssetLayers, n.Id, a => a?.Copy()),
                AttrTexts = (n.AttrTexts ?? new Dictionary<string, IrText>()).ToDictionary(kv => kv.Key, kv => CloneText(kv.Value)),
                Initial = n.Initial == null ? null : new IrInitial { Disabled = n.Initial.Disabled, Checked = n.Initial.Checked },
                Field = n.Field == null ? null : new IrField { Password = n.Field.Password, Multiline = n.Field.Multiline, PlaceholderColor = n.Field.PlaceholderColor },
                Bind = n.Bind,
                Action = n.Action,
                Repeat = n.Repeat == null ? null : new IrRepeat { Name = n.Repeat.Name, Mode = n.Repeat.Mode, Count = n.Repeat.Count },
                Anims = (n.Anims ?? new List<IrAnim>()).Select(a => a.Clone()).ToList(),
                Children = (n.Children ?? new IrNode[0]).Select(Clone).ToArray(),
                Clickable = n.Clickable,
                Focusable = n.Focusable,
                PickingIgnore = n.PickingIgnore,
                MirrorPseudoState = n.MirrorPseudoState,
                MirrorClasses = (string[])n.MirrorClasses?.Clone() ?? new string[0],
                Transitions = CanonicalLayers(n.Transitions, n.Id),
            };
        }

        static Dictionary<string, Dictionary<string, string>> CanonicalLayers(Dictionary<string, Dictionary<string, string>> layers, string id)
        {
            var result = new Dictionary<string, Dictionary<string, string>>();
            var source = new Dictionary<string, string>();
            foreach (var kv in layers ?? new Dictionary<string, Dictionary<string, string>>())
            {
                var key = LayerKey.Parse(kv.Key).Text;
                if (result.ContainsKey(key))
                    throw new IrFormatException("node '" + id + "' has the layers '" + source[key] + "' and '" + kv.Key + "', which are the same layer '" + key + "'");
                result[key] = new Dictionary<string, string>(kv.Value ?? new Dictionary<string, string>());
                source[key] = kv.Key;
            }
            return result;
        }

        /// <summary>An effect map with canonical keys; two keys naming the same layer are an error.</summary>
        static Dictionary<string, T> CanonicalMap<T>(Dictionary<string, T> map, string id, Func<T, T> copy) where T : class
        {
            var result = new Dictionary<string, T>();
            var source = new Dictionary<string, string>();
            foreach (var kv in map ?? new Dictionary<string, T>())
            {
                var key = LayerKey.Parse(kv.Key).Text;
                if (result.ContainsKey(key))
                    throw new IrFormatException("node '" + id + "' has the effect layers '" + source[key] + "' and '" + kv.Key + "', which are the same layer '" + key + "'");
                result[key] = copy(kv.Value);
                source[key] = kv.Key;
            }
            return result;
        }

        static IrText CloneText(IrText t) => t == null ? null : new IrText
        {
            Key = t.Key, Tr = t.Tr, En = t.En, Args = (string[])t.Args?.Clone() ?? new string[0], Rich = t.Rich, Style = t.Style,
        };

        static IrAsset CloneAsset(IrAsset a) => a?.Copy();
    }
}
