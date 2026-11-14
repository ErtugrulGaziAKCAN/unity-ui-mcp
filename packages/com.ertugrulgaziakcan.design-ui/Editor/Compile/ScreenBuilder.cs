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
    /// list, so elements with identical styles share a class and an unchanged element keeps its class), and writes one
    /// selector per layer key (<see cref="LayerKey"/>), its dimensions in compounds from the outside in:
    /// <list type="bullet">
    /// <item>breakpoints and states: classes on the screen root (<c>.bp-n</c>, <c>.state-n</c>, both in one compound
    /// when both are named), which is a descendant compound before the element, or part of the root's own compound;</item>
    /// <item>ancestor conditions <c>anc(id):…</c>: the ancestor's class with its pseudo-classes or view-toggled classes
    /// (<c>.s-card:hover .s-title</c>, <c>.s-row.is-selected .s-name</c>), outermost ancestor first; an ancestor named this
    /// way always has a class of its own;</item>
    /// <item>the element: its class, its <c>class:</c> dimensions (<c>is-*</c> view states, <c>__first</c> on the first
    /// item of an inline repeat, the <c>dui-*</c> classes a PseudoStateMirror sets on a shadow host), then its own
    /// pseudo-classes;</item>
    /// <item>followed by <see cref="ScrollContentChain"/> for the content layout of a scroll area, which CSS applies to
    /// the scrolled content and UI Toolkit to the ScrollView's content container.</item>
    /// </list>
    /// For example <c>.s-x</c>, <c>.s-x:hover</c>, <c>.state-loading .s-x:hover</c>, <c>.bp-narrow.state-loading .s-x</c>,
    /// <c>.s-root.state-loading</c>, <c>.s-x.is-selected:hover</c>. A key with more dimensions always has the higher
    /// specificity, so a union layer wins over the layers it combines, as the IR requires.
    /// Rules are ordered by the first element that uses their class (document order), and within a class by
    /// <see cref="LayerKey.RuleOrder"/>: base, then single dimensions (breakpoints, states, classes, ancestors, then hover,
    /// focus, checked, active, disabled), then pairs and so on (each followed by its content rule).
    /// </summary>
    public static class ScreenBuilder
    {
        /// <summary>Class the view toggles on the first item of an inline repeat (USS has no :first-child), see Lowering.FirstItemLayer.</summary>
        public const string FirstItemClass = "__first";

        /// <summary>Marks a shadow host: the view attaches a PseudoStateMirror to its element, targeting the host.</summary>
        public const string MirrorHostClass = "dui-mirror-host";

        /// <summary>The UXML tag of a compiled screen root (a container): <see cref="DesignUi.DesignScreen"/>, which carries the font set reference.</summary>
        public const string ScreenTag = "dui:DesignScreen";

        /// <summary>The UXML namespace prefix of the package's runtime elements (<c>xmlns:dui="DesignUi"</c>).</summary>
        public const string RuntimeNamespace = "DesignUi";

        /// <summary>Root class of a text-size step: <c>text-size-&lt;key&gt;</c> (the locale controller sets it on screen roots).</summary>
        public const string TextSizeClassPrefix = DesignUi.LocaleFontController.TextSizeClassPrefix;

        /// <summary>Root class of a right-to-left locale (the locale controller sets it on screen roots).</summary>
        public const string RtlClass = DesignUi.LocaleFontController.RtlClass;

        public const string StateClassPrefix = "state-";
        public const string BreakpointClassPrefix = DesignUi.DesignBreakpoints.ClassPrefix;

        /// <summary>The IR's breakpoints as the runtime reads them (<see cref="DesignUi.DesignBreakpoints"/>).</summary>
        internal static IEnumerable<DesignUi.DesignBreakpoints.Breakpoint> BreakpointsOf(IrScreen ir) =>
            (ir?.Breakpoints ?? new IrBreakpoint[0]).Where(b => b?.Name != null)
            .Select(b => new DesignUi.DesignBreakpoints.Breakpoint(b.Name, b.MinWidth, b.MaxWidth, b.MinAspect, b.MaxAspect));

        /// <summary>The TextField placeholder's UXML attribute (TextInputBaseField in UnityEngine.UIElementsModule 6000.3).</summary>
        public const string PlaceholderAttribute = "placeholder-text";

        /// <summary>The character a password field shows for each character of its value, as Chromium draws it (U+2022 BULLET).</summary>
        public const char PasswordMask = '\u2022';

        /// <summary>USS property that tints a background image (a tintable SVG is written white and tinted with the node's color).</summary>
        public const string TintProperty = "-unity-background-image-tint-color";

        /// <summary>
        /// Child-combinator chain from a ScrollView to its content container (Unity 6000.3 hierarchy: ScrollView,
        /// content-and-vertical-scroll container, content viewport, content container). Child combinators keep nested
        /// ScrollViews out of the match.
        /// </summary>
        public static readonly string ScrollContentChain =
            " > ." + ScrollView.contentAndVerticalScrollUssClassName + " > ." + ScrollView.viewportUssClassName + " > ." + ScrollView.contentUssClassName;

        const string Base = "base";
        const string HostSuffix = "__shadowhost";
        /// <summary>Suffix of the inset-shadow overlay Lowering makes the first child of an element.</summary>
        const string InsetSuffix = "__inset";
        /// <summary>Suffix of the child that takes an element's content image when the element paints something under it.</summary>
        const string ImageSuffix = "__image";
        const string ContentSuffix = ">content";

        static readonly Regex ClassIdent = new Regex(@"^-?[A-Za-z_][A-Za-z0-9_-]*$", RegexOptions.Compiled);
        static readonly Regex TextSizeKey = new Regex(@"^[a-z0-9_-]+$", RegexOptions.Compiled);
        /// <summary>A font variable with a line-box key: <c>inter-r125s16</c>, <c>inter-r13333s16p5</c> (group 1: the key).</summary>
        static readonly Regex LineBoxVariable = new Regex(@"-(r\d+s\d+(?:p\d+)?)$", RegexOptions.Compiled);
        static readonly Regex NameIdent = new Regex(@"^[A-Za-z0-9_-]+$", RegexOptions.Compiled);
        static readonly Regex PxValue = new Regex(@"^(-?\d+(?:\.\d+)?)px$|^0$", RegexOptions.Compiled);
        static readonly Regex ZeroLength = new Regex(@"^-?(?:0+(?:\.0*)?|\.0+)(?:px|%)?$", RegexOptions.Compiled);

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
            IReadOnlyDictionary<string, double> textStyleSizes) => Build(ir, assetPath, fontDefinition, textStyleSizes, null);

        /// <param name="textStyleLineBoxes">Kit text style name to its line-box variant key (<see cref="KitTextStyles.LoadLineBoxes"/>):
        /// a text node in such a style names its family's variant variable, <c>var(--font-&lt;family&gt;-&lt;key&gt;)</c>, whose
        /// twin lays a line out at the style's CSS line height.</param>
        public static CompiledScreen Build(IrScreen ir, Func<IrAsset, string> assetPath, Func<string, string> fontDefinition,
            IReadOnlyDictionary<string, double> textStyleSizes, IReadOnlyDictionary<string, string> textStyleLineBoxes) =>
            Build(ir, new ScreenBuildOptions { TextStyleSizes = textStyleSizes, TextStyleLineBoxes = textStyleLineBoxes }, assetPath, fontDefinition);

        /// <param name="options">Kit text styles, text-size steps, the right-to-left alignment rule and the font set reference.</param>
        public static CompiledScreen Build(IrScreen ir, ScreenBuildOptions options, Func<IrAsset, string> assetPath, Func<string, string> fontDefinition)
        {
            if (ir == null) throw new ArgumentNullException(nameof(ir));
            if (assetPath == null) throw new ArgumentNullException(nameof(assetPath));
            if (ir.Root == null) throw new IrFormatException("IR has no root node");
            options = options ?? new ScreenBuildOptions();
            var className = Pascal(ir.Screen, "screen id");
            var lowered = Lowering.Apply(ir.Root, ir.Breakpoints);
            var builder = new Builder(assetPath, fontDefinition, options, AncestorTargets(lowered), InheritedFamilies(lowered));
            var root = builder.Draft(lowered, true, false);
            builder.RemoveWrappers(root);
            return builder.Finish(root, ir, className);
        }

        /// <summary>A node's layer keys (style and effect layers) and the keys its animations are triggered by.</summary>
        static IEnumerable<string> KeysOf(IrNode n) =>
            n.Style.Keys.Concat(n.EffectKeys).Concat((n.Anims ?? new List<IrAnim>()).Select(a => a.Trigger).Where(t => t != null && t != LayerKey.ShowTrigger));

        /// <summary>Whether Lowering gave the node an inset-shadow overlay (its first child).</summary>
        static bool HasInsetOverlay(IrNode n) => n.Children.Length > 0 && n.Children[0].Id == n.Id + InsetSuffix;

        static readonly Regex BaseUrl = new Regex(@"^url\(\s*(?:""([^""]*)""|'([^']*)'|([^)""']*?))\s*\)$", RegexOptions.Compiled);

        /// <summary>
        /// The node's asset is the url() image of its base <c>background-image</c> (an element painted only by a url()
        /// background), which CSS paints as a background, below an inset shadow and the content.
        /// </summary>
        static bool AssetIsBaseBackground(IrNode n)
        {
            var v = Get(n, Base, "background-image");
            var m = v == null ? null : BaseUrl.Match(v);
            if (m == null || !m.Success || n.Asset == null) return false;
            var file = m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value.Trim();
            return file == n.Asset.File;
        }

        /// <summary>
        /// A content image (an img or inline svg) paints above whatever the element paints under it: a gradient (in base or in
        /// a layer) and an inset shadow. Then the image moves to a child, <c>&lt;id&gt;__image</c>, and the element's own
        /// background image is the gradient. A baked 9-slice (the compiler's shadow and inset images) is never content.
        /// </summary>
        static bool ContentInChild(IrNode n) =>
            n.Asset != null && n.Asset.Kind != "shadow9" && !AssetIsBaseBackground(n) &&
            (n.Background != null || n.AssetLayers.Count > 0 || HasInsetOverlay(n));

        /// <summary>The ids of the elements a layer key or an animation trigger names as an ancestor (<c>anc(id):…</c>) anywhere in the tree.</summary>
        static HashSet<string> AncestorTargets(IrNode root)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            void Visit(IrNode n)
            {
                foreach (var key in KeysOf(n)) foreach (var id in LayerKey.Parse(key).AncestorIds) result.Add(id);
                foreach (var c in n.Children) Visit(c);
            }
            Visit(root);
            return result;
        }

        /// <summary>Each node's font family: its own base <c>font-family</c>, else its parent's (CSS inherits it).</summary>
        static Dictionary<IrNode, string> InheritedFamilies(IrNode root)
        {
            var result = new Dictionary<IrNode, string>();
            void Visit(IrNode n, string inherited)
            {
                var own = Get(n, Base, "font-family");
                var family = string.IsNullOrEmpty(own) ? inherited : own;
                result[n] = family;
                foreach (var c in n.Children ?? new IrNode[0]) Visit(c, family);
            }
            Visit(root, null);
            return result;
        }

        /// <summary>Whether any node of the tree names a kit text style.</summary>
        public static bool UsesTextStyles(IrNode node) =>
            node != null && (node.Text?.Style != null || (node.Children ?? new IrNode[0]).Any(UsesTextStyles));

        /// <summary>
        /// PascalCase of an ASCII id: <c>club.overview</c> to <c>ClubOverview</c>, <c>message-list</c> to <c>MessageList</c>.
        /// Invariant culture; anything outside ASCII letters, digits and <c>. - _</c> separators throws.
        /// </summary>
        internal static string Pascal(string id, string what = "id") => Naming.Pascal(id, what);

        /// <summary>Invariant, round-trip formatting for numbers written into USS (a Turkish culture never adds a comma).</summary>
        internal static string Number(double value) => value.ToString("R", CultureInfo.InvariantCulture);

        internal static string Number(float value) => value.ToString("R", CultureInfo.InvariantCulture);

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
            /// <summary>A selector suffix to a part of a control (e.g. a text field's input), or null for the element itself.</summary>
            public string Part;
            public List<UssDeclaration> Declarations;
        }

        sealed class Draft
        {
            public IrNode Node;
            public string Name;
            public string Tag;
            public bool IsRoot;
            public bool FirstItem;
            /// <summary>The node has animation data (<see cref="AnimationEmitter"/>): it gets the player's marker class.</summary>
            public bool Animated;
            public IrRepeat Repeat;
            public readonly List<LayerRules> Layers = new List<LayerRules>();
            public readonly List<string> IrClasses = new List<string>();
            public readonly List<KeyValuePair<string, string>> Attributes = new List<KeyValuePair<string, string>>();
            /// <summary>Attribute texts UI Toolkit does not draw (alt, aria-label), recorded in the manifest.</summary>
            public readonly SortedDictionary<string, IrText> AccessibilityLabels = new SortedDictionary<string, IrText>(StringComparer.Ordinal);
            public readonly List<Draft> Children = new List<Draft>();
            /// <summary>Items of a list-mode repeat (a ListView holds no UXML children), or null.</summary>
            public List<Draft> TemplateItems;
        }

        sealed class Builder
        {
            readonly Func<IrAsset, string> _assetPath;
            readonly Func<string, string> _fontDefinition;
            readonly IReadOnlyDictionary<string, double> _textStyles;
            readonly IReadOnlyDictionary<string, string> _lineBoxes;
            readonly Dictionary<IrNode, string> _families;
            readonly ScreenBuildOptions _options;
            readonly List<DesignUi.DesignTextSize> _steps;
            readonly Dictionary<string, FontTwinGenerator.LineBox> _boxesByKey = new Dictionary<string, FontTwinGenerator.LineBox>(StringComparer.Ordinal);
            readonly List<string> _notes = new List<string>();
            readonly HashSet<string> _noted = new HashSet<string>(StringComparer.Ordinal);
            readonly List<string> _removed = new List<string>();
            readonly List<UssRule> _rules = new List<UssRule>();
            readonly Dictionary<string, string> _canonical = new Dictionary<string, string>(StringComparer.Ordinal);
            readonly List<CompiledRepeat> _repeats = new List<CompiledRepeat>();
            readonly HashSet<string> _ancestorTargets;

            public Builder(Func<IrAsset, string> assetPath, Func<string, string> fontDefinition, ScreenBuildOptions options,
                HashSet<string> ancestorTargets, Dictionary<IrNode, string> families)
            {
                _assetPath = assetPath;
                _fontDefinition = fontDefinition;
                _options = options;
                _textStyles = options.TextStyleSizes;
                _ancestorTargets = ancestorTargets;
                _lineBoxes = options.TextStyleLineBoxes;
                _families = families;
                _steps = TextSizeSteps(options.TextSizes);
                foreach (var b in options.LineBoxes ?? new FontTwinGenerator.LineBox[0]) _boxesByKey[b.Key] = b;
            }

            /// <summary>The profile's text-size steps, checked: valid class keys, positive scales, no duplicates; scale 1 needs no rules.</summary>
            static List<DesignUi.DesignTextSize> TextSizeSteps(IReadOnlyList<DesignUi.DesignTextSize> steps)
            {
                var result = new List<DesignUi.DesignTextSize>();
                var keys = new HashSet<string>(StringComparer.Ordinal);
                foreach (var step in steps ?? new DesignUi.DesignTextSize[0])
                {
                    if (step == null) continue;
                    if (string.IsNullOrEmpty(step.key) || !TextSizeKey.IsMatch(step.key))
                        throw new IrFormatException("text size '" + step.key + "' of the profile cannot be a USS class (lower-case ASCII letters, digits, '-' and '_')");
                    if (!(step.scale > 0) || float.IsInfinity(step.scale))
                        throw new IrFormatException("text size '" + step.key + "' of the profile has scale " + step.scale.ToString(CultureInfo.InvariantCulture) + "; a scale is a positive number");
                    if (!keys.Add(step.key)) throw new IrFormatException("the profile lists text size '" + step.key + "' twice");
                    if (step.scale != 1f) result.Add(step);
                }
                return result;
            }

            // ---- drafts: tags and mapped layers -------------------------------------------------------------

            public Draft Draft(IrNode node, bool isRoot, bool inScroll)
            {
                if (string.IsNullOrEmpty(node.Id)) throw new IrFormatException("a node has no id");
                if (node.Kind == "list") return ListDraft(node, node, isRoot, inScroll, false);
                if (node.Kind == "scroll" && node.Children.Length == 1 && node.Children[0].Kind == "list" && !HasScrollingOverflow(node.Children[0]))
                    return ListDraft(node, node.Children[0], isRoot, inScroll, true);

                LowerObjectFit(node);
                // decided before the layers are mapped: mapping takes the url() images out of the style layers
                bool contentChild = ContentInChild(node);
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
                if (d.Tag == "ui:TextField") TextFieldParts(d, node);

                foreach (var child in node.Children) d.Children.Add(Draft(child, false, inScroll));
                if (node.Repeat != null)
                {
                    d.Repeat = node.Repeat;
                    // the static tree shows the template item: it gets the class the view toggles on the first item at runtime
                    var first = d.Children.FirstOrDefault(c => Get(c.Node, Base, "position") != "absolute");
                    if (first != null) first.FirstItem = true;
                }
                // the content image paints after the inset shadow overlay and before the element's other children
                if (contentChild) d.Children.Insert(HasInsetOverlay(node) ? 1 : 0, ContentChild(node));
                return d;
            }

            /// <summary>object-fit of a content image to the USS scale mode (centred, like <c>object-position: center</c>).</summary>
            static readonly Dictionary<string, string> FitModes = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                { "fill", "stretch-to-fill" }, { "contain", "scale-to-fit" }, { "cover", "scale-and-crop" },
            };

            /// <summary>
            /// <c>object-fit</c> is lowered: it leaves the style layers, and on an element with a content image (an img or
            /// inline svg) each layer's value becomes that layer's <c>-unity-background-scale-mode</c> (<see cref="IrNode.ScaleModes"/>)
            /// on the element that paints the image (the element, or its content child). CSS applies it to replaced content
            /// only, so elsewhere it is dropped.
            /// </summary>
            static void LowerObjectFit(IrNode node)
            {
                var content = node.Asset != null && node.Asset.Kind != "shadow9" && !AssetIsBaseBackground(node);
                foreach (var pair in node.Style.Where(p => p.Value.ContainsKey("object-fit")).ToList())
                {
                    var v = pair.Value["object-fit"].Trim();
                    pair.Value.Remove("object-fit");
                    if (!content) continue;
                    if (!FitModes.TryGetValue(v, out var mode))
                        throw new UnsupportedStyleException("object-fit", v, null, "Use object-fit fill, contain or cover (centred).");
                    node.ScaleModes[pair.Key] = mode;
                }
            }

            /// <summary>
            /// A text field's parts as Chromium lays out an input: the input element (the field's visual input) fills the
            /// field and holds its text line centred vertically on one line (an input) or at the top (a text area); the
            /// text's horizontal place follows text-align. The placeholder takes the <c>::placeholder</c> colour. Without a
            /// theme UI Toolkit gives the parts none of this (TextInputBaseField, UnityEngine.UIElementsModule 6000.3).
            /// </summary>
            static void TextFieldParts(Draft d, IrNode node)
            {
                var multiline = node.Field != null && node.Field.Multiline;
                var vertical = multiline ? "upper-" : "middle-";
                string Horizontal(string textAlign)
                {
                    switch ((textAlign ?? "start").Trim())
                    {
                        case "center": return "center";
                        case "right": case "end": return "right";
                        default: return "left";
                    }
                }
                var baseLayer = d.Layers.FirstOrDefault(l => l.Key == Base && !l.Content && l.Part == null);
                if (baseLayer == null) d.Layers.Insert(0, baseLayer = new LayerRules { Key = Base, Declarations = new List<UssDeclaration>() });
                foreach (var layer in d.Layers.Where(l => !l.Content && l.Part == null))
                {
                    var align = layer.Key == Base || (node.Style.TryGetValue(layer.Key, out var css) && css.ContainsKey("text-align"))
                        ? vertical + Horizontal(Get(node, layer.Key, "text-align") ?? Get(node, Base, "text-align"))
                        : null;
                    layer.Declarations.RemoveAll(x => x.Property == "-unity-text-align");
                    if (align != null) layer.Declarations.Add(new UssDeclaration("-unity-text-align", align));
                }
                d.Layers.Add(new LayerRules
                {
                    Key = Base, Part = " > ." + TextField.inputUssClassName,
                    Declarations = new List<UssDeclaration> { new UssDeclaration("flex-grow", "1"), new UssDeclaration("justify-content", multiline ? "flex-start" : "center") },
                });
                if (node.Field?.PlaceholderColor != null)
                    d.Layers.Add(new LayerRules
                    {
                        Key = Base, Part = " > ." + TextField.placeholderUssClassName,
                        Declarations = new List<UssDeclaration> { new UssDeclaration("color", node.Field.PlaceholderColor) },
                    });
            }

            static string Visibility(string overflow) => overflow == "auto" ? "Auto" : overflow == "scroll" ? "AlwaysVisible" : "Hidden";

            Draft Start(IrNode node, bool isRoot)
            {
                var d = new Draft { Node = node, Name = node.Id, Tag = TagFor(node), IsRoot = isRoot };
                if (isRoot && d.Tag == "ui:VisualElement") d.Tag = ScreenTag; // the screen root carries the font set reference
                foreach (var c in node.Classes ?? new string[0])
                {
                    if (!c.StartsWith("is-", StringComparison.Ordinal)) continue; // design classes have no rules here; is-* are view-toggled states
                    if (!ClassIdent.IsMatch(c)) throw new IrFormatException("class '" + c + "' on node '" + node.Id + "' is not a valid USS class name");
                    d.IrClasses.Add(c);
                }
                // a select's text is its selected option, the DropdownField's value. DropdownField (6000.3) takes its value from
                // UXML only as a choice: one choice at index 0; the view fills the real choices at runtime.
                if (node.Text != null && d.Tag == "ui:DropdownField")
                {
                    var option = node.Text.Tr ?? "";
                    if (option.IndexOf(',') >= 0)
                        throw new IrFormatException("the selected option '" + option + "' of dropdown '" + node.Id + "' contains a comma, which a UXML choices list cannot hold; reword the option");
                    if (option.Length > 0)
                    {
                        d.Attributes.Add(new KeyValuePair<string, string>("choices", option));
                        d.Attributes.Add(new KeyValuePair<string, string>("index", "0"));
                    }
                }
                else if (node.Text != null && d.Tag == "ui:TextField")
                    d.Attributes.Add(new KeyValuePair<string, string>("value", node.Text.Tr ?? "")); // an input's text is its value
                else if (node.Text != null && d.Tag != "ui:Label" && d.Tag != "ui:Button" && d.Tag != "ui:Toggle")
                    throw new IrFormatException("node '" + node.Id + "' of kind '" + node.Kind + "' has text; only text, button, toggle, input and dropdown nodes carry text");
                if (node.Field != null)
                {
                    // UXML: TextInputBaseField password and mask-character, TextField multiline (UnityEngine.UIElementsModule 6000.3)
                    if (d.Tag != "ui:TextField") throw new IrFormatException("node '" + node.Id + "' of kind '" + node.Kind + "' has a text field form; only input nodes have one");
                    if (node.Field.Password)
                    {
                        d.Attributes.Add(new KeyValuePair<string, string>("password", "true"));
                        d.Attributes.Add(new KeyValuePair<string, string>("mask-character", PasswordMask.ToString()));
                    }
                    if (node.Field.Multiline) d.Attributes.Add(new KeyValuePair<string, string>("multiline", "true"));
                }
                foreach (var kv in (node.AttrTexts ?? new Dictionary<string, IrText>()).OrderBy(kv => kv.Key, StringComparer.Ordinal))
                {
                    switch (kv.Key)
                    {
                        case "placeholder":
                            if (d.Tag != "ui:TextField")
                                throw new IrFormatException("node '" + node.Id + "' of kind '" + node.Kind + "' has a placeholder; only input nodes show one");
                            d.Attributes.Add(new KeyValuePair<string, string>(PlaceholderAttribute, kv.Value?.Tr ?? ""));
                            break;
                        case "title":
                            d.Attributes.Add(new KeyValuePair<string, string>("tooltip", kv.Value?.Tr ?? ""));
                            break;
                        default:
                            // alt and aria-label: UI Toolkit draws no alternative text or accessible label; the manifest keeps them per element
                            d.AccessibilityLabels[kv.Key] = kv.Value;
                            break;
                    }
                }
                if (node.Focusable) d.Attributes.Add(new KeyValuePair<string, string>("focusable", "true"));
                if (node.Initial != null)
                {
                    // UXML: VisualElement enabled, BaseField<bool> value (UnityEngine.UIElementsModule 6000.3)
                    if (node.Initial.Disabled) d.Attributes.Add(new KeyValuePair<string, string>("enabled", "false"));
                    if (node.Initial.Checked)
                    {
                        if (d.Tag != "ui:Toggle") throw new IrFormatException("node '" + node.Id + "' of kind '" + node.Kind + "' starts checked; only toggle nodes can");
                        d.Attributes.Add(new KeyValuePair<string, string>("value", "true"));
                    }
                }
                return d;
            }

            /// <summary>
            /// Maps every layer of <paramref name="node"/> into <paramref name="d"/>, each over its basis (base and the
            /// node's other layers inside its key, <see cref="Lowering.Basis"/>). With <paramref name="content"/>, those
            /// properties go to a content rule (<c>&lt;layer&gt;&gt;content</c>) instead of the element's own rule; the extra
            /// declarations are added to the base layer's element and content rules. The element's background image comes
            /// from its asset (<see cref="BackgroundImages"/>), or from its gradient when a content image moved to a child
            /// (<see cref="ContentInChild"/>); a layer of <see cref="IrNode.AssetLayers"/> (a gradient per layer, the
            /// compiler's shadow and inset images per layer) replaces it while that layer holds, and a layer that exists only
            /// there still gets its rule. A tintable asset is tinted with the layer's color.
            /// </summary>
            void MapLayers(Draft d, IrNode node, bool isText, HashSet<string> content, UssDeclaration[] extraOuter, UssDeclaration[] extraContent)
            {
                if (!node.Style.TryGetValue(Base, out var baseCss)) node.Style[Base] = baseCss = new Dictionary<string, string>();
                ApplyTextStyle(node);
                bool contentChild = ContentInChild(node);
                var painted = node.Background ?? (contentChild ? null : node.Asset);
                if (contentChild && node.Asset.Tint)
                    throw new UnsupportedStyleException("background-image", node.Background?.File ?? "none", null,
                        "Tintable vector '" + node.Id + "' also has a background image or an inset shadow; put the icon in a child element of the background.");
                bool tint = painted != null && painted.Tint;
                if (tint && !baseCss.ContainsKey("color"))
                    throw new IrFormatException("tintable vector '" + node.Id + "' has no color in its base layer");
                var images = BackgroundImages(node, painted);
                var empty = new Dictionary<string, string>();
                // transitions and keyframe animations: custom properties for the animation player, next to the values they belong to
                var anim = AnimationEmitter.Of(node);
                if (anim != null)
                {
                    d.Animated = true;
                    foreach (var note in anim.Notes) if (_noted.Add(note)) _notes.Add(note);
                }
                var animLayers = anim?.Layers ?? (IEnumerable<string>)new string[0];
                foreach (var key in OrderedLayers(node.Style.Keys.Concat(node.AssetLayers.Keys).Concat(node.ScaleModes.Keys).Concat(animLayers).Distinct()))
                {
                    ValidateLayer(key, node.Id);
                    if (!node.Style.TryGetValue(key, out var css)) css = empty;
                    var basis = key == Base ? css : Lowering.Basis(node, key);
                    var decls = StyleMapper.Map(css, basis, isText, key == Base).ToList();
                    ResolveFont(decls, css);
                    LineBoxFont(decls, node, key);
                    if (images.Declarations.TryGetValue(key, out var image)) decls.AddRange(image);
                    if (node.AssetLayers.TryGetValue(key, out var layerImage))
                    {
                        if (images.Declarations.ContainsKey(key))
                            throw new IrFormatException("layer '" + key + "' of node '" + node.Id + "' sets a url() background image and another image");
                        if (layerImage == null) decls.Add(new UssDeclaration("background-image", NoImage));
                        else decls.AddRange(AssetDeclarations(layerImage, node.Id));
                    }
                    if (!contentChild && node.ScaleModes.TryGetValue(key, out var scaleMode)) decls.Add(new UssDeclaration("-unity-background-scale-mode", scaleMode));
                    if (tint)
                        foreach (var color in decls.Where(x => x.Property == "color").ToList())
                            decls.Add(new UssDeclaration(TintProperty, color.Value));
                    if (images.CssBackground) BackgroundGeometry(decls, painted, node, key, images);
                    if (anim != null) decls.AddRange(anim.For(key));
                    var inner = content == null ? new List<UssDeclaration>() : decls.Where(x => content.Contains(x.Property)).ToList();
                    var outer = content == null ? decls : decls.Where(x => !content.Contains(x.Property)).ToList();
                    if (key == Base)
                    {
                        // a content image paints above a baked gradient: the gradient stays the background, the image moves to a child
                        if (painted != null) outer.AddRange(AssetDeclarations(painted, node.Id));
                        if (extraOuter != null) outer.AddRange(extraOuter);
                        if (extraContent != null) inner.AddRange(extraContent);
                    }
                    outer = Sorted(outer, node.Id);
                    inner = Sorted(inner, node.Id);
                    if (outer.Count > 0) d.Layers.Add(new LayerRules { Key = key, Declarations = outer });
                    if (inner.Count > 0) d.Layers.Add(new LayerRules { Key = key, Content = true, Declarations = inner });
                }
            }

            static readonly Regex UrlItem = new Regex(@"^url\(\s*(?:""([^""]*)""|'([^']*)'|([^)""']*?))\s*\)$", RegexOptions.Compiled);

            const string NoImage = "none";

            /// <summary>What <see cref="BackgroundImages"/> found: per-layer declarations and the image in effect under each key.</summary>
            sealed class BackgroundPlan
            {
                /// <summary>The base image is a CSS url() background (sized, repeated and positioned like one).</summary>
                public bool CssBackground;
                public readonly Dictionary<string, List<UssDeclaration>> Declarations = new Dictionary<string, List<UssDeclaration>>(StringComparer.Ordinal);
                /// <summary>Each layer's image as the IR gives it: an asset file, <c>none</c>, or null for a gradient.</summary>
                public readonly IrNode Images = new IrNode { Style = new Dictionary<string, Dictionary<string, string>>() };
                public string BaseFile;

                /// <summary>The image file in effect while a key holds (the USS cascade of the layers' images), or <c>none</c>.</summary>
                public string ImageAt(string key) => Lowering.Resolve(Images, LayerKey.Parse(key), "background-image", true);
            }

            /// <summary>
            /// Takes <c>url()</c> images out of the layers' <c>background-image</c> (the IR rewrites them to its asset files).
            /// The base image is the element's asset, whose declarations <see cref="MapLayers"/> writes. A layer may switch to
            /// another image file or to <c>none</c>; a layer naming the base image again writes the base asset, unless the
            /// layers inside its key already resolve to it. These become that layer's declarations. One image per element:
            /// a url beside a gradient or a second url is an error, and so is a layer image over a base without a url image.
            /// Gradients stay for the mapper (baked from the base layer only). <c>img</c> elements, icons and baked gradients
            /// fill the element; only a CSS url() background gets CSS background geometry.
            /// </summary>
            BackgroundPlan BackgroundImages(IrNode node, IrAsset painted)
            {
                var plan = new BackgroundPlan();
                string Url(string item)
                {
                    var m = UrlItem.Match(item.Trim());
                    return m.Success ? (m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value.Trim()) : null;
                }
                // every layer's image before anything is taken out, so a layer can be compared with the layers inside its key
                foreach (var pair in node.Style)
                {
                    if (!pair.Value.TryGetValue("background-image", out var raw)) continue;
                    var value = raw.Trim();
                    var items = CssSupport.SplitTop(value, ',').Select(x => x.Trim()).ToList();
                    var urls = items.Select(Url).Where(u => u != null).ToList();
                    if (urls.Count > 0 && items.Count > 1)
                        throw new UnsupportedStyleException("background-image", raw, null,
                            "Element '" + node.Id + "' has several background images (layer '" + pair.Key + "'); UI Toolkit draws one. Put the others in child elements.");
                    var image = urls.Count == 1 ? urls[0] : value == NoImage ? NoImage : null;
                    if (image != null) plan.Images.Style[pair.Key] = new Dictionary<string, string> { { "background-image", image } };
                }
                if (plan.Images.Style.TryGetValue(Base, out var baseImage) && baseImage["background-image"] != NoImage)
                {
                    var file = baseImage["background-image"];
                    if (painted == null || painted.File != file)
                        throw new IrFormatException("the base background image '" + file + "' of node '" + node.Id + "' is not its asset ('" + (painted?.File ?? "none") + "')");
                    plan.CssBackground = true;
                    plan.BaseFile = file;
                }
                foreach (var key in node.Style.Keys.ToList())
                {
                    var layer = node.Style[key];
                    if (!plan.Images.Style.TryGetValue(key, out var own)) continue; // a gradient: the mapper rejects it outside the base layer
                    layer.Remove("background-image");
                    if (key == Base) continue;
                    var image = own["background-image"];
                    if (image == NoImage)
                    {
                        plan.Declarations[key] = new List<UssDeclaration> { new UssDeclaration("background-image", NoImage) };
                        continue;
                    }
                    if (!plan.CssBackground)
                        throw new UnsupportedStyleException("background-image", "url(\"" + image + "\")", null,
                            "Layer '" + key + "' of '" + node.Id + "' sets a url() background image the base layer does not have; only the base layer's url() image " +
                            "is drawn with its natural size and CSS background geometry. Give the base layer a url() image too.");
                    if (image == plan.BaseFile)
                    {
                        // the base image again: nothing to write when the layers inside the key already show it
                        if (Lowering.Resolve(plan.Images, LayerKey.Parse(key), "background-image", false) != plan.BaseFile)
                            plan.Declarations[key] = AssetDeclarations(painted, node.Id).ToList();
                        continue;
                    }
                    var asset = new IrAsset
                    {
                        Kind = image.EndsWith(".svg", StringComparison.OrdinalIgnoreCase) ? "svg" : "image",
                        File = image,
                        Sha256 = System.IO.Path.GetFileNameWithoutExtension(image),
                    };
                    plan.Declarations[key] = AssetDeclarations(asset, node.Id).ToList();
                }
                return plan;
            }

            /// <summary>
            /// CSS background geometry for a CSS background image. USS starts from a stretched, unrepeated, centred image,
            /// CSS from the image's natural size, repeated from the top left, so the base layer writes CSS's initial values
            /// where the IR leaves them out, and <c>auto</c> sizes become the base asset's natural size in px. Under a key
            /// where another image is in effect the size must be explicit: the IR knows only the base asset's natural size.
            /// </summary>
            static void BackgroundGeometry(List<UssDeclaration> decls, IrAsset painted, IrNode node, string key, BackgroundPlan plan)
            {
                var image = plan.ImageAt(key);
                bool otherImage = image != null && image != NoImage && image != plan.BaseFile;
                if (otherImage)
                {
                    var size = Lowering.Resolve(node, LayerKey.Parse(key), "background-size", true);
                    if (size == null || size.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).All(x => x == "auto"))
                        throw new UnsupportedStyleException("background-size", size ?? "auto", null,
                            "Layer '" + key + "' of '" + node.Id + "' shows another background image ('" + image + "') whose natural size is not known; give it an explicit background-size.");
                }
                if (key == Base)
                {
                    void Default(string prop, string value)
                    {
                        if (!decls.Any(x => x.Property == prop)) decls.Add(new UssDeclaration(prop, value));
                    }
                    Default("background-size", "auto");
                    Default("background-repeat", "repeat");
                    Default("background-position-x", "0%");
                    Default("background-position-y", "0%");
                }
                for (int i = 0; i < decls.Count; i++)
                {
                    if (decls[i].Property != "background-size") continue;
                    var parts = decls[i].Value.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (!parts.All(x => x == "auto")) continue;
                    if (painted.Width <= 0 || painted.Height <= 0)
                        throw new IrFormatException("the background image of '" + node.Id + "' has no natural size");
                    decls[i] = new UssDeclaration("background-size", Number(painted.Width) + "px " + Number(painted.Height) + "px");
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
                if (style == null)
                {
                    // text in no kit style: the exporter matched none, so a size of its own must still be a kit size (U-CSS-016)
                    if (node.Text == null || _textStyles == null) return;
                    foreach (var pair in node.Style)
                    {
                        if (!pair.Value.TryGetValue("font-size", out var raw)) continue;
                        var px = Px(raw, "font-size of node '" + node.Id + "'");
                        if (!_textStyles.Values.Any(s => Math.Abs(px - s) <= s * 1e-5))
                            throw new UnsupportedStyleException("font-size", raw, "U-CSS-016",
                                "Text node '" + node.Id + "' (layer '" + pair.Key + "') has a font size that is not a kit text style size; use a text style from " + KitTextStyles.FileName + ".");
                    }
                    return;
                }
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

                // items of one px height sit in fixed-height slots; any other item is measured by the ListView (dynamic
                // height), and keeps its gap margins with the first-item class, which the view keeps on the first item
                bool fixedHeight = FixedHeight(list);
                double? slot = null;
                if (fixedHeight) slot = SlotHeight(list, UndoListGap(list));

                var d = Start(box, isRoot);
                d.Tag = "ui:ListView";
                d.Repeat = list.Repeat;
                MapLayers(d, box, false, ScrollContentProperties, new[] { new UssDeclaration("overflow", "hidden") }, null);
                foreach (var layer in d.Layers.Where(l => l.Content))
                    foreach (var decl in layer.Declarations)
                        if (!(decl.Property == "flex-direction" && decl.Value == "column") && !(decl.Property.StartsWith("padding", StringComparison.Ordinal) && IsZeroLength(decl.Value)))
                            throw new UnsupportedStyleException(decl.Property, decl.Value, null,
                                "The content layout of list repeat '" + name + "' cannot be reproduced by a ListView, which stacks fixed-height items from the top of its box; move it to the items.");
                d.Layers.RemoveAll(l => l.Content);
                if (slot.HasValue) d.Attributes.Add(new KeyValuePair<string, string>("fixed-item-height", Number(slot.Value)));
                else if (!fixedHeight) d.Attributes.Add(new KeyValuePair<string, string>("virtualization-method", "DynamicHeight"));
                // selection is the view's SetSelected class layer; navigation stays the host's (ListView's own selection off)
                d.Attributes.Add(new KeyValuePair<string, string>("selection-type", "None"));
                d.TemplateItems = list.Children.Select(c => Draft(c, false, true)).ToList();
                if (!fixedHeight)
                {
                    var first = d.TemplateItems.FirstOrDefault(c => Get(c.Node, Base, "position") != "absolute");
                    if (first != null) first.FirstItem = true;
                }
                if (merged) _removed.Add(list.Id);
                return d;
            }

            /// <summary>A length of 0 (<c>0</c>, <c>0px</c>, <c>0%</c>): a padding or margin that lays nothing out.</summary>
            static bool IsZeroLength(string v) => ZeroLength.IsMatch((v ?? "").Trim());

            /// <summary>The repeat container inside a scroll area merges into the ListView, so it must not draw or place anything itself.</summary>
            static void CheckBoxlessList(IrNode scroll, IrNode list)
            {
                if (list.Text != null || list.Asset != null || list.Background != null || list.AssetLayers.Count > 0 || list.Bind != null || list.Action != null ||
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
                            (kv.Key == "flex-wrap" && v == "nowrap") ||
                            ((kv.Key.StartsWith("padding", StringComparison.Ordinal) || kv.Key.StartsWith("margin", StringComparison.Ordinal)) && IsZeroLength(v)));
                        if (!ok)
                            throw new UnsupportedStyleException(kv.Key, kv.Value, null,
                                "List repeat container '" + list.Id + "' inside scroll area '" + scroll.Id + "' has a box of its own (layer '" + pair.Key + "'); it merges into one ListView with the scroll area's box. Move the style to the scroll area or the items.");
                    }
            }

            /// <summary>
            /// Removes the gap margins Lowering gave the items of a list repeat and returns the gap in px: every layer with
            /// the first-item class goes, every other margin on the gap's side loses the gap.
            /// </summary>
            static double UndoListGap(IrNode list)
            {
                double gap = 0;
                bool first = true;
                var firstItem = LayerKey.Parse(Lowering.FirstItemLayer).Dims[0];
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
                    foreach (var key in item.Style.Keys.Where(k => LayerKey.Parse(k).Contains(firstItem)).ToList()) item.Style.Remove(key);
                    foreach (var layer in item.Style.Values)
                        if (layer.TryGetValue(prop, out var v) && v.Trim() != "auto")
                            layer[prop] = Number(Px(v, prop + " of '" + item.Id + "'") - g) + "px";
                    if (item.Style[Base].TryGetValue(prop, out var b) && Px(b, prop) == 0) item.Style[Base].Remove(prop);
                    gap = g;
                    first = false;
                }
                return gap;
            }

            /// <summary>
            /// Whether a list repeat's items fit fixed-height slots: each has a px height and px (or no) vertical margins in its
            /// base layer, and no other layer changes them or its display (the gap's first-item layer aside).
            /// </summary>
            static bool FixedHeight(IrNode list)
            {
                var firstItem = LayerKey.Parse(Lowering.FirstItemLayer).Dims[0];
                foreach (var item in list.Children)
                {
                    var height = Get(item, Base, "height");
                    if (height == null || !PxValue.IsMatch(height)) return false;
                    foreach (var prop in new[] { "margin-top", "margin-bottom" })
                    {
                        var v = Get(item, Base, prop);
                        if (v != null && !PxValue.IsMatch(v)) return false;
                    }
                    foreach (var pair in item.Style)
                    {
                        if (pair.Key == Base || LayerKey.Parse(pair.Key).Contains(firstItem)) continue;
                        foreach (var key in new[] { "height", "min-height", "max-height", "margin-top", "margin-bottom", "display" })
                            if (pair.Value.ContainsKey(key)) return false;
                    }
                }
                return true;
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

            static IEnumerable<string> OrderedLayers(IEnumerable<string> keys) =>
                keys.Select(LayerKey.Parse).OrderBy(k => k, LayerKey.RuleOrder).Select(k => k.Text).ToList();

            /// <summary>Every name a key writes into a selector must be a USS class name (breakpoint and state names: letters, digits, - and _).</summary>
            static void ValidateLayer(string key, string id)
            {
                LayerKey parsed;
                try { parsed = LayerKey.Parse(key); }
                catch (IrFormatException e) { throw new IrFormatException("node '" + id + "' has unsupported style layer '" + key + "': " + e.Message); }
                foreach (var dim in parsed.Dims)
                {
                    bool ok;
                    switch (dim.Kind)
                    {
                        case LayerDimKind.Breakpoint:
                        case LayerDimKind.State:
                            ok = NameIdent.IsMatch(dim.Name);
                            break;
                        case LayerDimKind.Class:
                            ok = ClassIdent.IsMatch(dim.Name);
                            break;
                        case LayerDimKind.Ancestor:
                            ok = !string.IsNullOrEmpty(dim.AncestorId) && (!dim.AncestorClass || ClassIdent.IsMatch(dim.Name));
                            break;
                        default:
                            ok = true;
                            break;
                    }
                    if (!ok) throw new IrFormatException("node '" + id + "' has unsupported style layer '" + key + "' ('" + dim.Text + "' is not a valid USS class name)");
                }
            }

            /// <summary>
            /// A text node in a kit text style with a line-box variant names its family's variant variable
            /// (<c>var(--font-&lt;family&gt;-&lt;key&gt;)</c>) in every layer; its base layer names it even when the family is
            /// inherited, because the variable of the inherited font would be the plain twin.
            /// </summary>
            void LineBoxFont(List<UssDeclaration> decls, IrNode node, string layer)
            {
                var style = node.Text?.Style;
                if (style == null || _lineBoxes == null || !_lineBoxes.TryGetValue(style, out var box) || box == null) return;
                const string prefix = "var(--font-";
                bool found = false;
                for (int i = 0; i < decls.Count; i++)
                {
                    var d = decls[i];
                    if (d.Property != "-unity-font-definition") continue;
                    found = true;
                    if (d.Value.StartsWith(prefix, StringComparison.Ordinal) && d.Value.EndsWith(")", StringComparison.Ordinal))
                        decls[i] = new UssDeclaration(d.Property, d.Value.Substring(0, d.Value.Length - 1) + "-" + box + ")");
                }
                if (!found && layer == Base && _families != null && _families.TryGetValue(node, out var family) && !string.IsNullOrEmpty(family))
                    decls.Add(new UssDeclaration("-unity-font-definition", prefix + StyleMapper.FamilySlug(family) + "-" + box + ")"));
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

            /// <summary>The content image of an element that also paints a gradient or an inset shadow: a child filling the content box.</summary>
            Draft ContentChild(IrNode node)
            {
                var child = new IrNode { Id = node.Id + ImageSuffix, Kind = "image", Asset = node.Asset, PickingIgnore = true };
                child.Style[Base] = new Dictionary<string, string> { { "flex-grow", "1" }, { "align-self", "stretch" } };
                // the element's object-fit scales the image where it is painted; the element's own states reach the child as anc(id)
                foreach (var kv in node.ScaleModes)
                {
                    var key = LayerKey.Parse(kv.Key).Map(x => x.ToDescendant(node.Id));
                    foreach (var id in key.AncestorIds) _ancestorTargets.Add(id);
                    child.ScaleModes[key.Text] = kv.Value;
                }
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
                    if (_ancestorTargets.Contains(w.Name) || !IsRemovableWrapper(d, w)) continue;
                    d.Children[i] = w.Children[0];
                    _removed.Add(w.Name);
                }
            }

            /// <summary>
            /// A wrapper is removed only where that provably keeps every box: a structurally named plain container (no
            /// content, binding, action, repeat, class, animation or interaction) whose only USS is the default column
            /// and possibly <c>flex-shrink: 0</c>, holding one in-flow child, inside a container that is a column in every
            /// layer (so wrapper and child are stretched across alike). The child must not depend on the wrapper: no
            /// percentages, no flex item properties, no auto vertical margins, never hidden (by a layer or per repeat item),
            /// the same flex-shrink as the wrapper and, when it can shrink, no vertical margins.
            /// </summary>
            static bool IsRemovableWrapper(Draft parent, Draft wrapper)
            {
                var p = parent.Node;
                var w = wrapper.Node;
                if (p.Kind != "container" || p.Repeat != null || (parent.Tag != "ui:VisualElement" && parent.Tag != ScreenTag)) return false;
                foreach (var layer in p.Style.Keys.Concat(new[] { Base }))
                    if ((Get(p, layer, "flex-direction") ?? "column") != "column") return false;

                if (w.Kind != "container" || wrapper.Tag != "ui:VisualElement" || w.External || w.Id.IndexOf("__", StringComparison.Ordinal) < 0 || w.Text != null ||
                    w.Asset != null || w.Background != null || w.AssetLayers.Count > 0 || w.Bind != null || w.Action != null || w.Repeat != null ||
                    w.Clickable || w.MirrorPseudoState || wrapper.IrClasses.Count > 0 || wrapper.FirstItem ||
                    (w.Anims != null && w.Anims.Count > 0) || w.Transitions.Count > 0 ||
                    wrapper.TemplateItems != null || wrapper.Children.Count != 1 || wrapper.Attributes.Count > 0 || wrapper.AccessibilityLabels.Count > 0)
                    return false;
                bool wrapperShrinks = true;
                foreach (var layer in wrapper.Layers)
                {
                    if (layer.Key != Base || layer.Content || layer.Part != null) return false;
                    foreach (var decl in layer.Declarations)
                    {
                        if (decl.Property == "flex-direction" && decl.Value == "column") continue;
                        if (decl.Property == "flex-shrink" && decl.Value == "0") { wrapperShrinks = false; continue; }
                        return false;
                    }
                }

                var c = wrapper.Children[0].Node;
                if (Get(c, Base, "position") == "absolute" || c.ItemVisibility) return false; // a child an item hides keeps the wrapper's box
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
                var compiledRoot = Emit(root, new List<Ancestor>());
                // an animated screen root attaches the animation player by itself (DesignScreen animated="true")
                if (compiledRoot.Tag == ScreenTag && compiledRoot.DescendantsAndSelf().Concat(_repeats.SelectMany(r => r.Items.SelectMany(i => i.DescendantsAndSelf())))
                        .Any(e => e.Classes.Contains(DesignUi.DesignAnimationData.MarkerClass)))
                    compiledRoot.Attributes.Add(new KeyValuePair<string, string>("animated", "true"));
                // the design's @media breakpoints: the screen root applies their bp-* classes from the panel's size at runtime
                if (compiledRoot.Tag == ScreenTag && ir.Breakpoints != null && ir.Breakpoints.Length > 0)
                    compiledRoot.Attributes.Add(new KeyValuePair<string, string>("breakpoints", DesignUi.DesignBreakpoints.Encode(BreakpointsOf(ir))));
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
                    Notes = _notes.ToList(),
                };
            }

            /// <summary>An emitted ancestor of the element being emitted: its name (IR id), style class and whether it is the screen root.</summary>
            sealed class Ancestor
            {
                public string Id;
                public string Class;
                public bool IsRoot;
            }

            CompiledElement Emit(Draft d, List<Ancestor> ancestors)
            {
                var node = d.Node;
                var e = new CompiledElement { Tag = d.Tag, Name = d.Name, PickingIgnore = node.PickingIgnore, Source = node };
                string cls = null;
                if (d.Layers.Count > 0 || _ancestorTargets.Contains(d.Name) || (d.IsRoot && FlipsRtl)) e.Classes.Add(cls = ClassFor(d, ancestors));
                e.Classes.AddRange(d.IrClasses);
                if (d.FirstItem) e.Classes.Add(FirstItemClass);
                if (d.Animated) e.Classes.Add(DesignUi.DesignAnimationData.MarkerClass);
                if (node.MirrorPseudoState || (node.MirrorClasses != null && node.MirrorClasses.Length > 0))
                {
                    if (node.MirrorPseudoState)
                    {
                        e.Classes.Add(MirrorHostClass);
                        e.MirrorHost = true;
                    }
                    e.MirrorClasses.AddRange(node.MirrorClasses ?? new string[0]);
                    e.MirrorElement = d.Children.Select(c => c.Name).FirstOrDefault(id => id + HostSuffix == node.Id)
                                      ?? throw new IrFormatException("shadow host '" + node.Id + "' has no element to mirror");
                }
                e.Clickable = node.Clickable && d.Tag != "ui:Button" && d.Tag != "ui:Toggle";
                // markup hiding in the design's repeat items is sample data: the view's setter shows and hides the element that
                // owns its visibility, the shadow host that took its slot when it has one
                if (node.ItemVisibility)
                    e.VisibilityOwner = ancestors.Count > 0 && ancestors[ancestors.Count - 1].Id == d.Name + HostSuffix ? ancestors[ancestors.Count - 1].Id : d.Name;
                foreach (var kv in d.AccessibilityLabels) e.AccessibilityLabels[kv.Key] = kv.Value;
                // an animation trigger may name an ancestor too; it must be one in the compiled tree
                foreach (var trigger in (node.Anims ?? new List<IrAnim>()).Select(a => a.Trigger).Where(t => t != null && t != LayerKey.ShowTrigger))
                    foreach (var id in LayerKey.Parse(trigger).AncestorIds)
                        if (ancestors.FindIndex(a => a.Id == id) < 0)
                            throw new IrFormatException("an animation of '" + d.Name + "' is triggered by '" + trigger + "', which names '" + id + "', not its ancestor in the compiled tree");
                if (d.IsRoot && d.Tag == ScreenTag && _options.FontSet != null) e.Attributes.Add(new KeyValuePair<string, string>("fonts", _options.FontSet));
                e.Attributes.AddRange(d.Attributes);
                if (node.Text != null && d.Tag != "ui:DropdownField") // a dropdown's text is its value attribute
                {
                    e.Text = node.Text.Tr ?? "";
                    // plain text stays plain: a '<' in it, a bound value or a filled-in argument (runtime values) is never read as a tag
                    if (!node.Text.Rich && (e.Text.IndexOf('<') >= 0 || node.Bind != null || node.Text.Args.Length > 0)) e.EnableRichText = false;
                }
                else if (node.Bind != null && (d.Tag == "ui:Label" || d.Tag == "ui:Button")) e.EnableRichText = false;

                // a repeat registers before its items so repeats are listed in document order
                CompiledRepeat repeat = null;
                if (d.Repeat != null)
                {
                    repeat = new CompiledRepeat
                    {
                        Name = d.Repeat.Name,
                        Mode = d.TemplateItems != null ? "list" : "inline",
                        Container = d.Name,
                        // both modes: list slots and the inline pool's further items are cloned from it
                        TemplateFile = Pascal(d.Repeat.Name, "repeat name") + "Item.uxml",
                    };
                    _repeats.Add(repeat);
                }
                // descendants (list items included: the ListView instantiates them inside itself) see this element as an ancestor
                ancestors.Add(new Ancestor { Id = d.Name, Class = cls, IsRoot = d.IsRoot });
                foreach (var child in d.Children) e.Children.Add(Emit(child, ancestors));
                if (d.TemplateItems != null) foreach (var item in d.TemplateItems) repeat.Items.Add(Emit(item, ancestors));
                ancestors.RemoveAt(ancestors.Count - 1);
                if (repeat != null && d.TemplateItems == null)
                    repeat.Items.AddRange(e.Children.Where(c => c.Name != node.Id + ImageSuffix && c.Name != node.Id + InsetSuffix));
                return e;
            }

            string ClassFor(Draft d, List<Ancestor> ancestors)
            {
                var sb = new StringBuilder();
                if (d.IsRoot) sb.Append("root\n"); // the root's state and breakpoint selectors differ, so it never shares a class
                // an element a descendant's layer names keeps a class of its own, so the descendant's selector names only it
                if (_ancestorTargets.Contains(d.Name)) sb.Append("ancestor ").Append(d.Name).Append('\n');
                foreach (var layer in d.Layers)
                {
                    sb.Append('[').Append(layer.Key).Append(layer.Content ? ContentSuffix : "").Append(layer.Part ?? "").Append("]\n");
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
                    _rules.Add(new UssRule(Selector(LayerKey.Parse(layer.Key), cls, d, ancestors) + (layer.Content ? ScrollContentChain : "") + (layer.Part ?? ""), layer.Declarations));
                TextSizeRules(d, cls, ancestors);
                RtlRules(d, cls, ancestors);
                return cls;
            }

            // ---- text-size steps and right to left: rules under a root class ------------------------------------

            bool FlipsRtl => _options.RtlAlignment.HasValue && _options.RtlAlignment.Value != DesignUi.RtlTextAlignment.Keep;

            /// <summary>
            /// For every text-size step, a twin of each of the element's own rules that sets a font size, under the step's
            /// root class (<c>.text-size-large.state-loading .s-x:hover</c>): the size times the step's scale and a kit line box's
            /// scaled twin variable. The extra root class makes each twin win over its rule and keeps the twins in the rules'
            /// order, so the state and class layers that change a size keep working under a step. Sizes and line boxes that
            /// are not whole device pixels at a declared viewport are noted (Unity rounds them; stacked lines drift).
            /// </summary>
            void TextSizeRules(Draft d, string cls, List<Ancestor> ancestors)
            {
                if (_steps.Count == 0) return;
                foreach (var step in _steps)
                    foreach (var layer in d.Layers.Where(l => !l.Content && l.Part == null))
                    {
                        // a layer that sets a size or a line-box font (a font switch) needs its twin, or the base twin outranks it
                        var size = layer.Declarations.FirstOrDefault(x => x.Property == "font-size");
                        bool lineBoxFont = layer.Declarations.Any(x => x.Property == "-unity-font-definition" && LineBoxKeyOf(x.Value) != null);
                        if (size.Property == null && !lineBoxFont) continue;
                        double k = StepScale(step), px = size.Property == null ? double.NaN : Px(size.Value, "font-size of '" + d.Name + "' (layer '" + layer.Key + "'), which the text-size steps scale,");
                        var scaled = new List<UssDeclaration>();
                        if (size.Property != null) scaled.Add(new UssDeclaration("font-size", Number(px * k) + "px"));
                        FontTwinGenerator.LineBox box = null;
                        foreach (var decl in layer.Declarations.Where(x => x.Property == "-unity-font-definition"))
                        {
                            var key = LineBoxKeyOf(decl.Value);
                            if (key == null) continue;
                            if (!_boxesByKey.TryGetValue(key, out box))
                                throw new IrFormatException("'" + d.Name + "' uses the line box '" + key + "', which the kit's text styles do not list; the text-size steps cannot scale it");
                            var scaledBox = FontTwinGenerator.LineBox.For(box.FontSize * k, box.LineHeight * k);
                            scaled.Add(new UssDeclaration(decl.Property, decl.Value.Substring(0, decl.Value.Length - key.Length - 1) + scaledBox.Key + ")"));
                        }
                        if (size.Property != null) NoteInexact(step, px, box);
                        _rules.Add(new UssRule(Selector(LayerKey.Parse(layer.Key), cls, d, ancestors, "." + TextSizeClassPrefix + step.key), Sorted(scaled, d.Name)));
                    }
            }

            /// <summary>The line-box key of a <c>var(--font-&lt;family&gt;-&lt;key&gt;)</c> value, or null.</summary>
            static string LineBoxKeyOf(string value)
            {
                const string prefix = "var(--font-";
                if (!value.StartsWith(prefix, StringComparison.Ordinal) || !value.EndsWith(")", StringComparison.Ordinal)) return null;
                var m = LineBoxVariable.Match(value.Substring(prefix.Length, value.Length - prefix.Length - 1));
                return m.Success ? m.Groups[1].Value : null;
            }

            void NoteInexact(DesignUi.DesignTextSize step, double px, FontTwinGenerator.LineBox box)
            {
                foreach (var (viewport, scale) in _options.Viewports ?? new (UnityEngine.Vector2Int, double)[0])
                {
                    double k = StepScale(step), size = px * k * scale, line = box != null ? box.LineHeight * k * scale : 0;
                    bool sizeWhole = WholePx(size), lineWhole = box == null || WholePx(line);
                    if (sizeWhole && lineWhole) continue;
                    var what = box != null ? Number(px) + "/" + Number(box.LineHeight) + " px text (font size/line box)" : Number(px) + " px text";
                    var note = "text size '" + step.key + "' (x" + Number(k) + ") is not exact for " + what + ": " +
                               (box != null ? Number(px * k) + "/" + Number(box.LineHeight * k) : Number(px * k)) + " px is " +
                               (box != null ? Number(Math.Round(size, 4)) + "/" + Number(Math.Round(line, 4)) : Number(Math.Round(size, 4))) + " device px at " +
                               viewport.x + "x" + viewport.y + " (scale " + Number(Math.Round(scale, 6)) + "). Unity sets text at whole device pixels, so it renders rounded " +
                               "and stacked lines drift; choose a scale that keeps the kit's sizes and line boxes whole at every declared viewport.";
                    if (_noted.Add(note)) _notes.Add(note);
                    break;
                }
            }

            static bool WholePx(double v) => Math.Abs(v - Math.Round(v)) < 1e-6;

            /// <summary>A step's scale as the decimal the profile shows (a float 1.1 is 1.1, not 1.100000023841858).</summary>
            internal static double StepScale(DesignUi.DesignTextSize step) => (double)(decimal)step.scale;

            /// <summary>
            /// Right to left: under the root class <c>rtl</c>, a twin of each of the element's own rules that sets a text
            /// alignment, with the profile's rule applied (start to end: left becomes right; mirror: left and right swap), the
            /// same twin order and precedence as the text-size rules; and on the screen root the theme's start alignment, which
            /// text without an alignment of its own inherits. The layout is not mirrored.
            /// </summary>
            void RtlRules(Draft d, string cls, List<Ancestor> ancestors)
            {
                if (!FlipsRtl) return;
                if (d.IsRoot && !d.Layers.Any(l => l.Key == Base && !l.Content && l.Part == null && l.Declarations.Any(x => x.Property == "-unity-text-align")))
                    _rules.Add(new UssRule(Selector(LayerKey.Parse(Base), cls, d, ancestors, "." + RtlClass),
                        new List<UssDeclaration> { new UssDeclaration("-unity-text-align", FlipAlign("upper-left")) }));
                foreach (var layer in d.Layers.Where(l => !l.Content && l.Part == null))
                    foreach (var decl in layer.Declarations.Where(x => x.Property == "-unity-text-align"))
                        _rules.Add(new UssRule(Selector(LayerKey.Parse(layer.Key), cls, d, ancestors, "." + RtlClass),
                            new List<UssDeclaration> { new UssDeclaration(decl.Property, FlipAlign(decl.Value)) }));
            }

            string FlipAlign(string value)
            {
                var mirror = _options.RtlAlignment == DesignUi.RtlTextAlignment.Mirror;
                if (value.EndsWith("-left", StringComparison.Ordinal)) return value.Substring(0, value.Length - 4) + "right";
                if (mirror && value.EndsWith("-right", StringComparison.Ordinal)) return value.Substring(0, value.Length - 5) + "left";
                return value;
            }

            /// <summary>The selector of one layer (see the class summary for the forms).</summary>
            /// <param name="rootClass">A further class on the screen root (<c>.text-size-large</c>, <c>.rtl</c>), first in its compound, or null.</param>
            static string Selector(LayerKey key, string cls, Draft d, List<Ancestor> ancestors, string rootClass = null)
            {
                var rootPart = (rootClass ?? "") + string.Concat(key.OfKind(LayerDimKind.Breakpoint).Select(x => "." + BreakpointClassPrefix + x.Name)
                    .Concat(key.OfKind(LayerDimKind.State).Select(x => "." + StateClassPrefix + x.Name)));
                var compounds = new List<string>();
                bool rootPlaced = d.IsRoot;
                foreach (var group in key.OfKind(LayerDimKind.Ancestor).GroupBy(x => x.AncestorId)
                             .Select(g => (dims: g.ToList(), at: ancestors.FindIndex(a => a.Id == g.Key))).OrderBy(g => g.at))
                {
                    if (group.at < 0)
                        throw new IrFormatException("layer '" + key.Text + "' of '" + d.Name + "' names '" + group.dims[0].AncestorId + "', which is not its ancestor in the compiled tree");
                    var target = ancestors[group.at];
                    var sb = new StringBuilder(".").Append(target.Class);
                    if (target.IsRoot) { sb.Append(rootPart); rootPlaced = true; }
                    foreach (var x in group.dims.Where(x => x.AncestorClass)) sb.Append('.').Append(x.Name);
                    foreach (var x in group.dims.Where(x => !x.AncestorClass)) sb.Append(':').Append(x.Name);
                    compounds.Add(sb.ToString());
                }
                if (!rootPlaced && rootPart.Length > 0) compounds.Insert(0, rootPart);
                var self = new StringBuilder(".").Append(cls);
                if (d.IsRoot) self.Append(rootPart);
                foreach (var x in key.OfKind(LayerDimKind.Class)) self.Append('.').Append(x.Name);
                foreach (var x in key.OfKind(LayerDimKind.Pseudo)) self.Append(':').Append(x.Name);
                compounds.Add(self.ToString());
                return string.Join(" ", compounds);
            }
        }
    }
}
