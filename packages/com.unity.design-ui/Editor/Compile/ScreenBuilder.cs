using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine.UIElements;

namespace DesignUi.Editor
{
    /// <summary>
    /// Turns an IR screen into a <see cref="CompiledScreen"/> (spec 8): lowers it, maps every style layer to USS, gives
    /// each element one content-hash class (<c>s-</c> + the first 8 hex of the SHA-256 of its canonical declaration
    /// list, so elements with identical styles share a class and an unchanged element keeps its class), and writes the
    /// selectors of the selector policy:
    /// <list type="bullet">
    /// <item><c>.s-x</c> base; <c>.s-x:hover</c> (and active, focus, checked, disabled);</item>
    /// <item><c>.state-n .s-x</c> / <c>.bp-n .s-x</c> for descendants of the screen root, which carries the state and
    /// breakpoint classes; <c>.s-x.state-n</c> / <c>.s-x.bp-n</c> for the root itself;</item>
    /// <item><c>.s-x.c</c> for a class layer <c>class:c</c>: <c>is-*</c> view states, <c>__first</c> (the view toggles
    /// it on the first item of an inline repeat) and the <c>dui-*</c> classes a PseudoStateMirror sets on a shadow host;</item>
    /// <item>any of these followed by <see cref="ScrollContentChain"/> for the content layout of a scroll area, which
    /// CSS applies to the scrolled content and UI Toolkit to the ScrollView's content container.</item>
    /// </list>
    /// Rules are ordered by the first element that uses their class (document order), and within a class: base,
    /// breakpoints, states, classes, then hover, focus, checked, active, disabled (each followed by its content rule).
    /// </summary>
    public static class ScreenBuilder
    {
        /// <summary>Class the view toggles on the first item of an inline repeat (USS has no :first-child), see Lowering.FirstItemLayer.</summary>
        public const string FirstItemClass = "__first";

        /// <summary>Marks a shadow host: the view attaches a PseudoStateMirror to its element, targeting the host.</summary>
        public const string MirrorHostClass = "dui-mirror-host";

        public const string StateClassPrefix = "state-";
        public const string BreakpointClassPrefix = "bp-";

        /// <summary>
        /// Child-combinator chain from a ScrollView to its content container (Unity 6000.3 hierarchy: ScrollView,
        /// content-and-vertical-scroll container, content viewport, content container). Child combinators keep nested
        /// ScrollViews out of the match.
        /// </summary>
        public static readonly string ScrollContentChain =
            " > ." + ScrollView.contentAndVerticalScrollUssClassName + " > ." + ScrollView.viewportUssClassName + " > ." + ScrollView.contentUssClassName;

        const string Base = "base";
        const string HostSuffix = "__shadowhost";
        const string BreakpointLayer = "bp:";
        const string StateLayer = "state:";
        const string ClassLayer = "class:";
        const string ContentSuffix = ">content";

        static readonly string[] PseudoOrder = { "hover", "focus", "checked", "active", "disabled" };
        static readonly Regex ClassIdent = new Regex(@"^-?[A-Za-z_][A-Za-z0-9_-]*$", RegexOptions.Compiled);
        static readonly Regex NameIdent = new Regex(@"^[A-Za-z0-9_-]+$", RegexOptions.Compiled);
        static readonly Regex PxValue = new Regex(@"^(-?\d+(?:\.\d+)?)px$|^0$", RegexOptions.Compiled);

        /// <summary>Layout of the scrolled content: in CSS it applies inside the scroll container, in UI Toolkit to the content container.</summary>
        static readonly HashSet<string> ScrollContentProperties = new HashSet<string>
        {
            "flex-direction", "flex-wrap", "justify-content", "align-items", "align-content",
            "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
        };

        static readonly string[] OverflowKeys = { "overflow", "overflow-x", "overflow-y" };

        public static CompiledScreen Build(IrScreen ir, Func<IrAsset, string> assetPath, Func<string, string> fontDefinition) =>
            Build(ir, assetPath, fontDefinition, null);

        /// <param name="assetPath">Path of an IR asset for <c>url()</c>: a project path (<c>Assets/…</c>, written as
        /// <c>project://database/…</c>) or a path relative to the USS file.</param>
        /// <param name="fontDefinition">USS value for <c>-unity-font-definition</c> of a CSS font family, or null to keep the
        /// <c>var(--font-&lt;family&gt;)</c> placeholder.</param>
        /// <param name="textStyleSizes">Kit text styles (name to font size in px). Every text node that names a style
        /// (<c>text.style</c>) gets that exact size, in every layer; such a node without a table is an error.</param>
        public static CompiledScreen Build(IrScreen ir, Func<IrAsset, string> assetPath, Func<string, string> fontDefinition,
            IReadOnlyDictionary<string, double> textStyleSizes)
        {
            if (ir == null) throw new ArgumentNullException(nameof(ir));
            if (assetPath == null) throw new ArgumentNullException(nameof(assetPath));
            if (ir.Root == null) throw new IrFormatException("IR has no root node");
            var className = Pascal(ir.Screen, "screen id");
            var lowered = Lowering.Apply(ir.Root);
            var builder = new Builder(assetPath, fontDefinition, textStyleSizes);
            var root = builder.Draft(lowered, true, false);
            builder.RemoveWrappers(root);
            return builder.Finish(root, ir, className);
        }

        /// <summary>Whether any node of the tree names a kit text style.</summary>
        public static bool UsesTextStyles(IrNode node) =>
            node != null && (node.Text?.Style != null || (node.Children ?? new IrNode[0]).Any(UsesTextStyles));

        /// <summary>
        /// PascalCase of an ASCII id: <c>club.overview</c> to <c>ClubOverview</c>, <c>message-list</c> to <c>MessageList</c>.
        /// Invariant culture; anything outside ASCII letters, digits and <c>. - _</c> separators throws.
        /// </summary>
        internal static string Pascal(string id, string what = "id")
        {
            if (string.IsNullOrEmpty(id)) throw new IrFormatException("missing " + what);
            var sb = new StringBuilder();
            foreach (var part in id.Split('.', '-', '_'))
            {
                if (part.Length == 0) continue;
                foreach (var c in part)
                    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')))
                        throw new IrFormatException(what + " '" + id + "' has characters outside ASCII letters, digits and . - _");
                sb.Append(char.ToUpperInvariant(part[0])).Append(part, 1, part.Length - 1);
            }
            if (sb.Length == 0 || char.IsDigit(sb[0])) throw new IrFormatException(what + " '" + id + "' does not give a valid name");
            return sb.ToString();
        }

        /// <summary>Invariant, round-trip formatting for numbers written into USS (a Turkish culture never adds a comma).</summary>
        internal static string Number(double value) => value.ToString("R", CultureInfo.InvariantCulture);

        /// <summary>
        /// A path as written inside <c>url("…")</c>: <c>%</c>, <c>#</c> and <c>?</c> are percent-encoded, because the USS
        /// importer reads <c>#</c> as a sub-asset name and <c>?</c> as the start of fileID/guid parameters.
        /// </summary>
        internal static string UrlPath(string path)
        {
            if (path.IndexOf('"') >= 0 || path.IndexOf('\\') >= 0 || path.Any(char.IsControl))
                throw new IrFormatException("asset path '" + path + "' cannot be written in a USS url()");
            return path.Replace("%", "%25").Replace("#", "%23").Replace("?", "%3F");
        }

        static string Hash8(string canonical)
        {
            using (var sha = SHA256.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(canonical));
                var sb = new StringBuilder(8);
                for (int i = 0; i < 4; i++) sb.Append(bytes[i].ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        static string Get(IrNode n, string layer, string prop)
        {
            if (layer != Base && n.Style.TryGetValue(layer, out var l) && l.TryGetValue(prop, out var v)) return v.Trim();
            return n.Style.TryGetValue(Base, out var b) && b.TryGetValue(prop, out var bv) ? bv.Trim() : null;
        }

        static double Px(string value, string what)
        {
            var m = PxValue.Match((value ?? "").Trim());
            if (!m.Success) throw new IrFormatException(what + " '" + value + "' is not a px length");
            return m.Groups[1].Success ? double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) : 0;
        }

        static bool Scrolls(string overflow) => overflow == "auto" || overflow == "scroll";

        static bool HasScrollingOverflow(IrNode n)
        {
            foreach (var layer in n.Style.Values)
                foreach (var key in OverflowKeys)
                    if (layer.TryGetValue(key, out var v) && v.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).Any(Scrolls))
                        return true;
            return false;
        }

        /// <summary>
        /// Removes overflow from every layer of a scroll or list node and returns the base values per axis (clip reads as
        /// hidden). A scroll area cannot change its overflow with a state, breakpoint or pseudo-state.
        /// </summary>
        static (string x, string y) ConsumeOverflow(IrNode node)
        {
            (string, string) Read(Dictionary<string, string> layer, (string, string) basis)
            {
                var (x, y) = basis;
                if (layer.TryGetValue("overflow", out var both))
                {
                    var parts = both.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 1 || parts.Length > 2) throw new UnsupportedStyleException("overflow", both);
                    x = parts[0];
                    y = parts.Length == 2 ? parts[1] : parts[0];
                }
                if (layer.TryGetValue("overflow-x", out var ox)) x = ox.Trim();
                if (layer.TryGetValue("overflow-y", out var oy)) y = oy.Trim();
                string Norm(string v, string key)
                {
                    v = v == "clip" ? "hidden" : v;
                    if (v != "visible" && v != "hidden" && v != "auto" && v != "scroll") throw new UnsupportedStyleException(key, v);
                    return v;
                }
                return (Norm(x, "overflow-x"), Norm(y, "overflow-y"));
            }

            if (!node.Style.TryGetValue(Base, out var baseLayer)) node.Style[Base] = baseLayer = new Dictionary<string, string>();
            var result = Read(baseLayer, ("visible", "visible"));
            foreach (var pair in node.Style)
            {
                if (pair.Key == Base || !OverflowKeys.Any(pair.Value.ContainsKey)) continue;
                if (Read(pair.Value, result) != result)
                    throw new UnsupportedStyleException("overflow", string.Join(" ", OverflowKeys.Where(pair.Value.ContainsKey).Select(k => pair.Value[k])), null,
                        "The overflow of scroll area '" + node.Id + "' cannot change in layer '" + pair.Key + "'.");
            }
            foreach (var layer in node.Style.Values) foreach (var key in OverflowKeys) layer.Remove(key);
            return result;
        }

        sealed class LayerRules
        {
            public string Key;
            public bool Content;
            public List<UssDeclaration> Declarations;
        }

        sealed class Draft
        {
            public IrNode Node;
            public string Name;
            public string Tag;
            public bool IsRoot;
            public bool FirstItem;
            public IrRepeat Repeat;
            public readonly List<LayerRules> Layers = new List<LayerRules>();
            public readonly List<string> IrClasses = new List<string>();
            public readonly List<KeyValuePair<string, string>> Attributes = new List<KeyValuePair<string, string>>();
            public readonly List<Draft> Children = new List<Draft>();
            /// <summary>Items of a list-mode repeat (a ListView holds no UXML children), or null.</summary>
            public List<Draft> TemplateItems;
        }

        sealed class Builder
        {
            readonly Func<IrAsset, string> _assetPath;
            readonly Func<string, string> _fontDefinition;
            readonly IReadOnlyDictionary<string, double> _textStyles;
            readonly List<string> _removed = new List<string>();
            readonly List<UssRule> _rules = new List<UssRule>();
            readonly Dictionary<string, string> _canonical = new Dictionary<string, string>(StringComparer.Ordinal);
            readonly List<CompiledRepeat> _repeats = new List<CompiledRepeat>();

            public Builder(Func<IrAsset, string> assetPath, Func<string, string> fontDefinition, IReadOnlyDictionary<string, double> textStyles)
            {
                _assetPath = assetPath;
                _fontDefinition = fontDefinition;
                _textStyles = textStyles;
            }

            // ---- drafts: tags and mapped layers -------------------------------------------------------------

            public Draft Draft(IrNode node, bool isRoot, bool inScroll)
            {
                if (string.IsNullOrEmpty(node.Id)) throw new IrFormatException("a node has no id");
                if (node.Kind == "list") return ListDraft(node, node, isRoot, inScroll, false);
                if (node.Kind == "scroll" && node.Children.Length == 1 && node.Children[0].Kind == "list" && !HasScrollingOverflow(node.Children[0]))
                    return ListDraft(node, node.Children[0], isRoot, inScroll, true);

                var d = Start(node, isRoot);
                if (node.Kind == "scroll")
                {
                    var (x, y) = ConsumeOverflow(node);
                    if (!Scrolls(x) && !Scrolls(y)) throw new IrFormatException("scroll node '" + node.Id + "' has no overflow auto or scroll");
                    d.Attributes.Add(new KeyValuePair<string, string>("mode", Scrolls(x) && Scrolls(y) ? "VerticalAndHorizontal" : Scrolls(y) ? "Vertical" : "Horizontal"));
                    d.Attributes.Add(new KeyValuePair<string, string>("horizontal-scroller-visibility", Visibility(x)));
                    d.Attributes.Add(new KeyValuePair<string, string>("vertical-scroller-visibility", Visibility(y)));
                    // CSS clips a scroll container's content at its padding box; the scrolled content box is at least the scrollport
                    MapLayers(d, node, false, ScrollContentProperties,
                        new[] { new UssDeclaration("overflow", "hidden") },
                        new[] { new UssDeclaration("min-height", "100%"), new UssDeclaration("min-width", "100%") });
                    inScroll = true;
                }
                else MapLayers(d, node, node.Kind == "text" || node.Text != null, null, null, null);

                foreach (var child in node.Children) d.Children.Add(Draft(child, false, inScroll));
                if (node.Repeat != null)
                {
                    d.Repeat = node.Repeat;
                    // the static tree shows the template item: it gets the class the view toggles on the first item at runtime
                    var first = d.Children.FirstOrDefault(c => Get(c.Node, Base, "position") != "absolute");
                    if (first != null) first.FirstItem = true;
                }
                if (node.Background != null && node.Asset != null) d.Children.Insert(0, ContentChild(node));
                return d;
            }

            static string Visibility(string overflow) => overflow == "auto" ? "Auto" : overflow == "scroll" ? "AlwaysVisible" : "Hidden";

            Draft Start(IrNode node, bool isRoot)
            {
                var d = new Draft { Node = node, Name = node.Id, Tag = TagFor(node), IsRoot = isRoot };
                foreach (var c in node.Classes ?? new string[0])
                {
                    if (!c.StartsWith("is-", StringComparison.Ordinal)) continue; // design classes have no rules here; is-* are view-toggled states
                    if (!ClassIdent.IsMatch(c)) throw new IrFormatException("class '" + c + "' on node '" + node.Id + "' is not a valid USS class name");
                    d.IrClasses.Add(c);
                }
                if (node.Text != null && d.Tag != "ui:Label" && d.Tag != "ui:Button" && d.Tag != "ui:Toggle")
                    throw new IrFormatException("node '" + node.Id + "' of kind '" + node.Kind + "' has text; only text, button and toggle nodes carry text");
                return d;
            }

            /// <summary>
            /// Maps every layer of <paramref name="node"/> into <paramref name="d"/>. With <paramref name="content"/>, those
            /// properties go to a content rule (<c>&lt;layer&gt;&gt;content</c>) instead of the element's own rule; the
            /// extra declarations are added to the base layer's element and content rules.
            /// </summary>
            void MapLayers(Draft d, IrNode node, bool isText, HashSet<string> content, UssDeclaration[] extraOuter, UssDeclaration[] extraContent)
            {
                if (!node.Style.TryGetValue(Base, out var baseCss)) node.Style[Base] = baseCss = new Dictionary<string, string>();
                ApplyTextStyle(node);
                foreach (var key in OrderedLayers(node.Style.Keys))
                {
                    ValidateLayer(key, node.Id);
                    var css = node.Style[key];
                    var decls = StyleMapper.Map(css, baseCss, isText, key == Base).ToList();
                    ResolveFont(decls, css);
                    var inner = content == null ? new List<UssDeclaration>() : decls.Where(x => content.Contains(x.Property)).ToList();
                    var outer = content == null ? decls : decls.Where(x => !content.Contains(x.Property)).ToList();
                    if (key == Base)
                    {
                        // a content image paints above a baked gradient: the gradient stays the background, the image moves to a child
                        if (node.Background != null) outer.AddRange(AssetDeclarations(node.Background, node.Id));
                        else if (node.Asset != null) outer.AddRange(AssetDeclarations(node.Asset, node.Id));
                        if (extraOuter != null) outer.AddRange(extraOuter);
                        if (extraContent != null) inner.AddRange(extraContent);
                    }
                    outer = Sorted(outer, node.Id);
                    inner = Sorted(inner, node.Id);
                    if (outer.Count > 0) d.Layers.Add(new LayerRules { Key = key, Declarations = outer });
                    if (inner.Count > 0) d.Layers.Add(new LayerRules { Key = key, Content = true, Declarations = inner });
                }
            }

            /// <summary>
            /// A text node that names a kit text style gets the style's exact size in its base layer; any other layer that
            /// sets a font size must set a kit size (matched numerically, as Chromium serialises lengths to 6 significant
            /// digits), which is then written exactly.
            /// </summary>
            void ApplyTextStyle(IrNode node)
            {
                var style = node.Text?.Style;
                if (style == null) return;
                if (_textStyles == null)
                    throw new IrFormatException("text style '" + style + "' of node '" + node.Id + "' needs the kit's " + KitTextStyles.FileName + ", which was not found");
                if (!_textStyles.TryGetValue(style, out var size))
                    throw new IrFormatException("text style '" + style + "' of node '" + node.Id + "' is not in " + KitTextStyles.FileName);
                node.Style[Base]["font-size"] = Number(size) + "px";
                foreach (var pair in node.Style)
                {
                    if (pair.Key == Base || !pair.Value.TryGetValue("font-size", out var raw)) continue;
                    var v = Px(raw, "font-size of node '" + node.Id + "'");
                    bool Near(double s) => Math.Abs(v - s) <= s * 1e-5;
                    double? kit = Near(size) ? size : _textStyles.Values.Where(Near).Cast<double?>().FirstOrDefault();
                    if (kit == null)
                        throw new UnsupportedStyleException("font-size", raw, "U-CSS-016",
                            "Layer '" + pair.Key + "' of text node '" + node.Id + "' sets a font size that is not a kit text style size; use a text style from " + KitTextStyles.FileName + ".");
                    pair.Value["font-size"] = Number(kit.Value) + "px";
                }
            }

            // ---- lists ---------------------------------------------------------------------------------------

            /// <summary>
            /// A list-mode repeat compiles to one ListView, which scrolls by itself (spec 10). Its box is the repeat
            /// container's own box when the container is the scroll area, or the scroll area's box when the container is
            /// the scroll area's only child (the container then must not have a box of its own and is listed as removed).
            /// The ListView places items in fixed-height slots: slot = item margins + height + the container's gap, which
            /// puts item k exactly where CSS gap puts it, so the lowered gap margins and the first-item class are undone.
            /// </summary>
            Draft ListDraft(IrNode box, IrNode list, bool isRoot, bool inScroll, bool merged)
            {
                var name = list.Repeat?.Name ?? "?";
                const string fix = " Make the repeat container the scroll area (overflow-y: auto) or the only child of one, or use data-u-repeat-mode inline.";
                if (list.Repeat == null) throw new IrFormatException("list node '" + list.Id + "' has no repeat");
                if (inScroll)
                    throw new IrFormatException("list repeat '" + name + "' in '" + list.Id + "' is inside another scroll area; a ListView scrolls by itself and cannot be nested in one." + fix);
                var (x, y) = ConsumeOverflow(box);
                if (!Scrolls(y))
                    throw new IrFormatException("list repeat '" + name + "' in '" + list.Id + "' is not a scroll area; a ListView needs a bounded, vertically scrolling box." + fix);
                if (Scrolls(x)) throw new UnsupportedStyleException("overflow-x", x, null, "List repeat '" + name + "' scrolls horizontally; a ListView scrolls vertically only. Use data-u-repeat-mode inline.");
                if (y == "scroll") throw new UnsupportedStyleException("overflow-y", y, null, "A ListView shows its scroller when needed; use overflow-y: auto on list repeat '" + name + "'.");
                foreach (var layer in list.Style.Keys.Concat(new[] { Base }).Distinct())
                {
                    var direction = Get(list, layer, "flex-direction") ?? "column";
                    if (direction != "column")
                        throw new UnsupportedStyleException("flex-direction", direction, null, "List repeat '" + name + "' lays items out in a " + direction + "; a ListView stacks them in one column. Use data-u-repeat-mode inline.");
                    var wrap = Get(list, layer, "flex-wrap");
                    if (wrap != null && wrap != "nowrap") throw new UnsupportedStyleException("flex-wrap", wrap, null, "A ListView does not wrap items; use data-u-repeat-mode inline.");
                }
                if (merged) CheckBoxlessList(box, list);

                var gap = UndoListGap(list);
                var slot = SlotHeight(list, gap);

                var d = Start(box, isRoot);
                d.Tag = "ui:ListView";
                d.Repeat = list.Repeat;
                MapLayers(d, box, false, ScrollContentProperties, new[] { new UssDeclaration("overflow", "hidden") }, null);
                foreach (var layer in d.Layers.Where(l => l.Content))
                    foreach (var decl in layer.Declarations)
                        if (!(decl.Property == "flex-direction" && decl.Value == "column"))
                            throw new UnsupportedStyleException(decl.Property, decl.Value, null,
                                "The content layout of list repeat '" + name + "' cannot be reproduced by a ListView, which stacks fixed-height items from the top of its box; move it to the items.");
                d.Layers.RemoveAll(l => l.Content);
                if (slot.HasValue) d.Attributes.Add(new KeyValuePair<string, string>("fixed-item-height", Number(slot.Value)));
                d.TemplateItems = list.Children.Select(c => Draft(c, false, true)).ToList();
                if (merged) _removed.Add(list.Id);
                return d;
            }

            /// <summary>The repeat container inside a scroll area merges into the ListView, so it must not draw or place anything itself.</summary>
            static void CheckBoxlessList(IrNode scroll, IrNode list)
            {
                if (list.Text != null || list.Asset != null || list.Background != null || list.Bind != null || list.Action != null ||
                    (list.Anims != null && list.Anims.Count > 0) || list.Transitions.Count > 0)
                    throw new IrFormatException("list repeat container '" + list.Id + "' inside scroll area '" + scroll.Id + "' draws or binds something; it merges into the ListView, so move that to the scroll area or the items");
                foreach (var pair in list.Style)
                    foreach (var kv in pair.Value)
                    {
                        var v = kv.Value.Trim();
                        bool ok = pair.Key == Base && (
                            (kv.Key == "display" && v == "flex") || (kv.Key == "flex-direction" && v == "column") || kv.Key == "flex-shrink" ||
                            (kv.Key == "position" && v == "relative") || (kv.Key == "align-items" && (v == "stretch" || v == "normal")) ||
                            (kv.Key == "justify-content" && (v == "flex-start" || v == "normal" || v == "start")) ||
                            (kv.Key == "flex-wrap" && v == "nowrap"));
                        if (!ok)
                            throw new UnsupportedStyleException(kv.Key, kv.Value, null,
                                "List repeat container '" + list.Id + "' inside scroll area '" + scroll.Id + "' has a box of its own (layer '" + pair.Key + "'); it merges into one ListView with the scroll area's box. Move the style to the scroll area or the items.");
                    }
            }

            /// <summary>Removes the gap margins Lowering gave the items of a list repeat and returns the gap in px.</summary>
            static double UndoListGap(IrNode list)
            {
                double gap = 0;
                bool first = true;
                foreach (var item in list.Children)
                {
                    if (!item.Style.TryGetValue(Lowering.FirstItemLayer, out var own))
                    {
                        if (!first && gap != 0) throw new IrFormatException("items of list repeat '" + list.Id + "' do not share one gap");
                        first = false;
                        continue;
                    }
                    if (own.Count != 1) throw new IrFormatException("unexpected first-item layer on '" + item.Id + "'");
                    var prop = own.Keys.Single();
                    var g = Px(Get(item, Base, prop), prop + " of '" + item.Id + "'") - Px(own[prop], prop + " of '" + item.Id + "'");
                    if (!first && Math.Abs(g - gap) > 1e-9) throw new IrFormatException("items of list repeat '" + list.Id + "' do not share one gap");
                    item.Style.Remove(Lowering.FirstItemLayer);
                    foreach (var layer in item.Style.Values)
                        if (layer.TryGetValue(prop, out var v) && v.Trim() != "auto")
                            layer[prop] = Number(Px(v, prop + " of '" + item.Id + "'") - g) + "px";
                    if (item.Style[Base].TryGetValue(prop, out var b) && Px(b, prop) == 0) item.Style[Base].Remove(prop);
                    gap = g;
                    first = false;
                }
                return gap;
            }

            /// <summary>Fixed slot height of a list repeat's items: margin-top + height + margin-bottom + gap, the same for every item.</summary>
            static double? SlotHeight(IrNode list, double gap)
            {
                double? slot = null;
                foreach (var item in list.Children)
                {
                    string Need(string prop, bool required)
                    {
                        var v = Get(item, Base, prop);
                        if (v == null && !required) return "0px";
                        if (v == null || !PxValue.IsMatch(v))
                            throw new IrFormatException("list item '" + item.Id + "' needs a px " + prop + " (it is '" + (v ?? "unset") +
                                                        "'): a ListView places items in fixed-height slots. Set it, or use data-u-repeat-mode inline.");
                        return v;
                    }
                    if (item.Style[Base].ContainsKey("margin")) throw new IrFormatException("list item '" + item.Id + "' uses the margin shorthand; the exporter writes longhands");
                    foreach (var pair in item.Style)
                        foreach (var key in new[] { "height", "min-height", "max-height", "margin-top", "margin-bottom", "display" })
                            if (pair.Key != Base && pair.Value.ContainsKey(key))
                                throw new UnsupportedStyleException(key, pair.Value[key], null,
                                    "List item '" + item.Id + "' changes its height in layer '" + pair.Key + "'; ListView items share one fixed height.");
                    var h = Px(Need("margin-top", false), "margin-top") + Px(Need("height", true), "height") + Px(Need("margin-bottom", false), "margin-bottom") + gap;
                    if (slot.HasValue && Math.Abs(slot.Value - h) > 1e-9) throw new IrFormatException("items of list repeat '" + list.Id + "' have different heights");
                    slot = h;
                }
                return slot;
            }

            // ---- shared helpers ------------------------------------------------------------------------------

            static string TagFor(IrNode node)
            {
                switch (node.Kind)
                {
                    case "container": return "ui:VisualElement";
                    case "text": return "ui:Label";
                    case "image": return "ui:VisualElement";
                    case "vector": return "ui:VisualElement";
                    case "button": return "ui:Button";
                    case "toggle": return "ui:Toggle";
                    case "input": return "ui:TextField";
                    case "dropdown": return "ui:DropdownField";
                    case "scroll": return "ui:ScrollView";
                    case "list": return "ui:ListView";
                    default: throw new IrFormatException("node '" + node.Id + "' has unknown kind '" + node.Kind + "'");
                }
            }

            static IEnumerable<string> OrderedLayers(IEnumerable<string> keys)
            {
                var list = keys.ToList();
                int Rank(string k)
                {
                    if (k == Base) return 0;
                    if (k.StartsWith(BreakpointLayer, StringComparison.Ordinal)) return 1;
                    if (k.StartsWith(StateLayer, StringComparison.Ordinal)) return 2;
                    if (k.StartsWith(ClassLayer, StringComparison.Ordinal)) return 3;
                    var p = Array.IndexOf(PseudoOrder, k);
                    return p >= 0 ? 4 + p : 100;
                }
                return list.OrderBy(Rank).ThenBy(k => k, StringComparer.Ordinal);
            }

            static void ValidateLayer(string key, string id)
            {
                if (key == Base || Array.IndexOf(PseudoOrder, key) >= 0) return;
                string name = null;
                Regex rule = NameIdent;
                if (key.StartsWith(BreakpointLayer, StringComparison.Ordinal)) name = key.Substring(BreakpointLayer.Length);
                else if (key.StartsWith(StateLayer, StringComparison.Ordinal)) name = key.Substring(StateLayer.Length);
                else if (key.StartsWith(ClassLayer, StringComparison.Ordinal)) { name = key.Substring(ClassLayer.Length); rule = ClassIdent; }
                if (name == null || !rule.IsMatch(name))
                    throw new IrFormatException("node '" + id + "' has unsupported style layer '" + key + "'");
            }

            void ResolveFont(List<UssDeclaration> decls, Dictionary<string, string> css)
            {
                if (_fontDefinition == null || !css.TryGetValue("font-family", out var families)) return;
                int i = decls.FindIndex(x => x.Property == "-unity-font-definition");
                if (i < 0) return;
                var family = CssSupport.SplitTop(families, ',')[0].Trim().Trim('"', '\'');
                var definition = _fontDefinition(family);
                if (definition != null) decls[i] = new UssDeclaration("-unity-font-definition", definition);
            }

            IEnumerable<UssDeclaration> AssetDeclarations(IrAsset asset, string id)
            {
                var path = _assetPath(asset);
                if (string.IsNullOrEmpty(path)) throw new IrFormatException("no path for asset '" + asset.File + "' of node '" + id + "'");
                var url = path.StartsWith("Assets/", StringComparison.Ordinal) || path.StartsWith("Packages/", StringComparison.Ordinal)
                    ? "project://database/" + UrlPath(path)
                    : UrlPath(path);
                yield return new UssDeclaration("background-image", "url(\"" + url + "\")");
                if (asset.Slice == null) yield break;
                if (asset.Slice.Length != 4) throw new IrFormatException("9-slice of node '" + id + "' needs four insets");
                // insets in CSS box order: top, right, bottom, left
                var sides = new[] { "top", "right", "bottom", "left" };
                for (int i = 0; i < 4; i++)
                {
                    var v = asset.Slice[i];
                    if (v < 0 || v != Math.Floor(v)) throw new IrFormatException("9-slice inset " + v.ToString(CultureInfo.InvariantCulture) + " of node '" + id + "' is not a whole pixel count");
                    yield return new UssDeclaration("-unity-slice-" + sides[i], ((int)v).ToString(CultureInfo.InvariantCulture));
                }
            }

            /// <summary>The content image of an element that also has a gradient: a child filling the content box.</summary>
            Draft ContentChild(IrNode node)
            {
                var child = new IrNode { Id = node.Id + "__image", Kind = "image", Asset = node.Asset, PickingIgnore = true };
                child.Style[Base] = new Dictionary<string, string> { { "flex-grow", "1" }, { "align-self", "stretch" } };
                return Draft(child, false, false);
            }

            static List<UssDeclaration> Sorted(List<UssDeclaration> decls, string id)
            {
                var dup = decls.GroupBy(x => x.Property).FirstOrDefault(g => g.Count() > 1);
                if (dup != null) throw new IrFormatException("node '" + id + "' sets '" + dup.Key + "' twice");
                return decls.OrderBy(x => StyleMapper.IsShorthand(x.Property) ? 0 : 1).ThenBy(x => x.Property, StringComparer.Ordinal).ToList();
            }

            // ---- wrappers ------------------------------------------------------------------------------------

            public void RemoveWrappers(Draft d)
            {
                foreach (var c in d.Children) RemoveWrappers(c);
                if (d.TemplateItems != null) foreach (var t in d.TemplateItems) RemoveWrappers(t);
                for (int i = 0; i < d.Children.Count; i++)
                {
                    var w = d.Children[i];
                    if (!IsRemovableWrapper(d, w)) continue;
                    d.Children[i] = w.Children[0];
                    _removed.Add(w.Name);
                }
            }

            /// <summary>
            /// A wrapper is removed only where that provably keeps every box: a structurally named plain container (no
            /// content, binding, action, repeat, class, animation or interaction) whose only USS is the default column
            /// and possibly <c>flex-shrink: 0</c>, holding one in-flow child, inside a container that is a column in every
            /// layer (so wrapper and child are stretched across alike). The child must not depend on the wrapper: no
            /// percentages, no flex item properties, no auto vertical margins, never hidden, the same flex-shrink as the
            /// wrapper and, when it can shrink, no vertical margins.
            /// </summary>
            static bool IsRemovableWrapper(Draft parent, Draft wrapper)
            {
                var p = parent.Node;
                var w = wrapper.Node;
                if (p.Kind != "container" || p.Repeat != null || parent.Tag != "ui:VisualElement") return false;
                foreach (var layer in p.Style.Keys.Concat(new[] { Base }))
                    if ((Get(p, layer, "flex-direction") ?? "column") != "column") return false;

                if (w.Kind != "container" || wrapper.Tag != "ui:VisualElement" || w.External || w.Id.IndexOf("__", StringComparison.Ordinal) < 0 || w.Text != null ||
                    w.Asset != null || w.Background != null || w.Bind != null || w.Action != null || w.Repeat != null ||
                    w.Clickable || w.MirrorPseudoState || wrapper.IrClasses.Count > 0 || wrapper.FirstItem ||
                    (w.Anims != null && w.Anims.Count > 0) || w.Transitions.Count > 0 ||
                    wrapper.TemplateItems != null || wrapper.Children.Count != 1 || wrapper.Attributes.Count > 0)
                    return false;
                bool wrapperShrinks = true;
                foreach (var layer in wrapper.Layers)
                {
                    if (layer.Key != Base || layer.Content) return false;
                    foreach (var decl in layer.Declarations)
                    {
                        if (decl.Property == "flex-direction" && decl.Value == "column") continue;
                        if (decl.Property == "flex-shrink" && decl.Value == "0") { wrapperShrinks = false; continue; }
                        return false;
                    }
                }

                var c = wrapper.Children[0].Node;
                if (Get(c, Base, "position") == "absolute") return false;
                foreach (var layer in c.Style)
                    foreach (var kv in layer.Value)
                    {
                        var v = kv.Value.Trim();
                        if (v.IndexOf('%') >= 0) return false;
                        switch (kv.Key)
                        {
                            case "flex": case "flex-grow": case "flex-basis": case "align-self": return false;
                            case "flex-shrink": if (layer.Key != Base) return false; break;
                            case "display": if (v == "none") return false; break;
                            case "margin": return false;
                            case "margin-top": case "margin-bottom": if (v == "auto") return false; break;
                        }
                    }
                var childShrink = Get(c, Base, "flex-shrink") ?? "1";
                if (!float.TryParse(childShrink, NumberStyles.Float, CultureInfo.InvariantCulture, out var cs)) return false;
                if ((cs != 0) != wrapperShrinks || (cs != 0 && cs != 1)) return false;
                if (wrapperShrinks)
                    foreach (var layer in c.Style.Values)
                        foreach (var key in new[] { "margin-top", "margin-bottom" })
                            if (layer.TryGetValue(key, out var m) && m.Trim() != "0" && m.Trim() != "0px") return false;
                return true;
            }

            // ---- classes, rules and the element tree ---------------------------------------------------------

            public CompiledScreen Finish(Draft root, IrScreen ir, string className)
            {
                var compiledRoot = Emit(root);
                var names = new Dictionary<string, CompiledElement>(StringComparer.Ordinal);
                foreach (var e in compiledRoot.DescendantsAndSelf().Concat(_repeats.SelectMany(r => r.Items.SelectMany(i => i.DescendantsAndSelf()))))
                {
                    if (names.TryGetValue(e.Name, out var other) && other != e) throw new IrFormatException("two elements are named '" + e.Name + "'");
                    names[e.Name] = e;
                }
                return new CompiledScreen
                {
                    ScreenId = ir.Screen,
                    ClassName = className,
                    Root = compiledRoot,
                    Rules = _rules.ToList(),
                    RemovedElements = _removed.ToList(),
                    Repeats = _repeats.ToList(),
                    States = (ir.States ?? new string[0]).ToList(),
                    Breakpoints = (ir.Breakpoints ?? new IrBreakpoint[0]).Select(b => b.Name).ToList(),
                };
            }

            CompiledElement Emit(Draft d)
            {
                var node = d.Node;
                var e = new CompiledElement { Tag = d.Tag, Name = d.Name, PickingIgnore = node.PickingIgnore, Source = node };
                if (d.Layers.Count > 0) e.Classes.Add(ClassFor(d));
                e.Classes.AddRange(d.IrClasses);
                if (d.FirstItem) e.Classes.Add(FirstItemClass);
                if (node.MirrorPseudoState)
                {
                    e.Classes.Add(MirrorHostClass);
                    e.MirrorHost = true;
                    e.MirrorElement = d.Children.Select(c => c.Name).FirstOrDefault(id => id + HostSuffix == node.Id)
                                      ?? throw new IrFormatException("shadow host '" + node.Id + "' has no element to mirror");
                }
                e.Clickable = node.Clickable && d.Tag != "ui:Button" && d.Tag != "ui:Toggle";
                e.Attributes.AddRange(d.Attributes);
                if (node.Text != null)
                {
                    e.Text = node.Text.Tr ?? "";
                    if (!node.Text.Rich && e.Text.IndexOf('<') >= 0) e.EnableRichText = false;
                }

                // a repeat registers before its items so repeats are listed in document order
                CompiledRepeat repeat = null;
                if (d.Repeat != null)
                {
                    repeat = new CompiledRepeat
                    {
                        Name = d.Repeat.Name,
                        Mode = d.TemplateItems != null ? "list" : "inline",
                        Container = d.Name,
                        TemplateFile = d.TemplateItems != null ? Pascal(d.Repeat.Name, "repeat name") + "Item.uxml" : null,
                    };
                    _repeats.Add(repeat);
                }
                foreach (var child in d.Children) e.Children.Add(Emit(child));
                if (repeat != null)
                {
                    if (d.TemplateItems != null) foreach (var item in d.TemplateItems) repeat.Items.Add(Emit(item));
                    else repeat.Items.AddRange(e.Children.Where(c => c.Name != node.Id + "__image"));
                }
                return e;
            }

            string ClassFor(Draft d)
            {
                var sb = new StringBuilder();
                if (d.IsRoot) sb.Append("root\n"); // the root's state and breakpoint selectors differ, so it never shares a class
                foreach (var layer in d.Layers)
                {
                    sb.Append('[').Append(layer.Key).Append(layer.Content ? ContentSuffix : "").Append("]\n");
                    foreach (var decl in layer.Declarations) sb.Append(decl.Property).Append(": ").Append(decl.Value).Append(";\n");
                }
                var canonical = sb.ToString();
                var cls = "s-" + Hash8(canonical);
                if (_canonical.TryGetValue(cls, out var existing))
                {
                    if (existing != canonical) throw new IrFormatException("style class " + cls + " is the hash of two different declaration lists (element '" + d.Name + "')");
                    return cls;
                }
                _canonical[cls] = canonical;
                foreach (var layer in d.Layers)
                    _rules.Add(new UssRule(Selector(layer.Key, cls, d.IsRoot) + (layer.Content ? ScrollContentChain : ""), layer.Declarations));
                return cls;
            }

            static string Selector(string layer, string cls, bool isRoot)
            {
                var self = "." + cls;
                if (layer == Base) return self;
                if (Array.IndexOf(PseudoOrder, layer) >= 0) return self + ":" + layer;
                if (layer.StartsWith(BreakpointLayer, StringComparison.Ordinal))
                    return RootClass(BreakpointClassPrefix + layer.Substring(BreakpointLayer.Length), self, isRoot);
                if (layer.StartsWith(StateLayer, StringComparison.Ordinal))
                    return RootClass(StateClassPrefix + layer.Substring(StateLayer.Length), self, isRoot);
                return self + "." + layer.Substring(ClassLayer.Length);
            }

            static string RootClass(string rootClass, string self, bool isRoot) => isRoot ? self + "." + rootClass : "." + rootClass + " " + self;
        }
    }
}
