using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

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
    /// <item><c>.s-x.c</c> for a class layer <c>class:c</c>: <c>__first</c> (the view toggles it on the first repeated
    /// item) and the <c>dui-*</c> classes a PseudoStateMirror sets on a shadow host.</item>
    /// </list>
    /// Rules are ordered by the first element that uses their class (document order), and within a class: base,
    /// breakpoints, states, classes, then hover, focus, checked, active, disabled.
    /// </summary>
    public static class ScreenBuilder
    {
        /// <summary>Class the view toggles on the first item of a repeat (USS has no :first-child), see Lowering.FirstItemLayer.</summary>
        public const string FirstItemClass = "__first";

        /// <summary>Marks a shadow host whose element the view gives a PseudoStateMirror targeting the host (R33).</summary>
        public const string MirrorHostClass = "dui-mirror-host";

        public const string StateClassPrefix = "state-";
        public const string BreakpointClassPrefix = "bp-";

        const string Base = "base";
        const string HostSuffix = "__shadowhost";
        const string BreakpointLayer = "bp:";
        const string StateLayer = "state:";
        const string ClassLayer = "class:";

        static readonly string[] PseudoOrder = { "hover", "focus", "checked", "active", "disabled" };
        static readonly Regex ClassIdent = new Regex(@"^[A-Za-z_-][A-Za-z0-9_-]*$", RegexOptions.Compiled);
        static readonly Regex NameIdent = new Regex(@"^[A-Za-z0-9_-]+$", RegexOptions.Compiled);

        public static CompiledScreen Build(IrScreen ir, Func<IrAsset, string> assetPath, Func<string, string> fontDefinition) =>
            Build(ir, assetPath, fontDefinition, null);

        /// <param name="assetPath">Path of an IR asset for <c>url()</c>: a project path (<c>Assets/…</c>, written as
        /// <c>project://database/…</c>) or a path relative to the USS file.</param>
        /// <param name="fontDefinition">USS value for <c>-unity-font-definition</c> of a CSS font family, or null to keep the
        /// <c>var(--font-&lt;family&gt;)</c> placeholder.</param>
        /// <param name="textStyleSizes">Kit text styles (name to font size in px); a text node naming a style gets that
        /// exact size. Null keeps the IR's font-size.</param>
        public static CompiledScreen Build(IrScreen ir, Func<IrAsset, string> assetPath, Func<string, string> fontDefinition,
            IReadOnlyDictionary<string, double> textStyleSizes)
        {
            if (ir == null) throw new ArgumentNullException(nameof(ir));
            if (assetPath == null) throw new ArgumentNullException(nameof(assetPath));
            if (ir.Root == null) throw new IrFormatException("IR has no root node");
            var className = Pascal(ir.Screen, "screen id");
            var lowered = Lowering.Apply(ir.Root);
            var builder = new Builder(assetPath, fontDefinition, textStyleSizes);
            var root = builder.Draft(lowered, true);
            builder.RemoveWrappers(root);
            return builder.Finish(root, ir, className);
        }

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

        sealed class Draft
        {
            public IrNode Node;
            public string Tag;
            public bool IsRoot;
            public bool FirstItem;
            public readonly List<KeyValuePair<string, List<UssDeclaration>>> Layers = new List<KeyValuePair<string, List<UssDeclaration>>>();
            public readonly List<string> IrClasses = new List<string>();
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

            public Draft Draft(IrNode node, bool isRoot)
            {
                if (string.IsNullOrEmpty(node.Id)) throw new IrFormatException("a node has no id");
                var d = new Draft { Node = node, Tag = TagFor(node), IsRoot = isRoot };
                foreach (var c in node.Classes ?? new string[0])
                {
                    if (!c.StartsWith("is-", StringComparison.Ordinal)) continue; // design classes have no rules here; is-* are view-toggled states
                    if (!ClassIdent.IsMatch(c)) throw new IrFormatException("class '" + c + "' on node '" + node.Id + "' is not a valid USS class name");
                    d.IrClasses.Add(c);
                }

                if (node.Text != null && d.Tag != "ui:Label" && d.Tag != "ui:Button" && d.Tag != "ui:Toggle")
                    throw new IrFormatException("node '" + node.Id + "' of kind '" + node.Kind + "' has text; only text, button and toggle nodes carry text");

                if (!node.Style.TryGetValue(Base, out var baseCss)) node.Style[Base] = baseCss = new Dictionary<string, string>();
                if (node.Text?.Style != null && _textStyles != null)
                {
                    if (!_textStyles.TryGetValue(node.Text.Style, out var size))
                        throw new IrFormatException("text style '" + node.Text.Style + "' of node '" + node.Id + "' is not in " + KitTextStyles.FileName);
                    baseCss["font-size"] = Number(size) + "px";
                }

                bool isText = node.Kind == "text" || node.Text != null;
                Draft content = null;
                foreach (var key in OrderedLayers(node.Style.Keys))
                {
                    ValidateLayer(key, node.Id);
                    var css = node.Style[key];
                    var decls = StyleMapper.Map(css, baseCss, isText, key == Base).ToList();
                    ResolveFont(decls, css);
                    if (key == Base)
                    {
                        // a content image paints above a baked gradient: the gradient stays the background, the image moves to a child
                        if (node.Background != null) decls.AddRange(AssetDeclarations(node.Background, node.Id));
                        else if (node.Asset != null) decls.AddRange(AssetDeclarations(node.Asset, node.Id));
                        if (node.Background != null && node.Asset != null) content = ContentChild(node);
                        decls = Sorted(decls, node.Id);
                    }
                    if (decls.Count > 0) d.Layers.Add(new KeyValuePair<string, List<UssDeclaration>>(key, decls));
                }

                if (node.Kind == "list")
                {
                    if (node.Children.Length > 0 && node.Repeat == null)
                        throw new IrFormatException("list node '" + node.Id + "' has children but no repeat");
                    if (node.Repeat != null) d.TemplateItems = node.Children.Select(c => Draft(c, false)).ToList();
                }
                else
                {
                    foreach (var child in node.Children) d.Children.Add(Draft(child, false));
                    if (node.Repeat != null)
                    {
                        // the static tree shows the sample items: the first one gets the class the view toggles at runtime
                        var first = d.Children.FirstOrDefault(c => Get(c.Node, Base, "position") != "absolute");
                        if (first != null) first.FirstItem = true;
                    }
                }
                if (content != null) d.Children.Insert(0, content);
                return d;
            }

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
                if (path.IndexOf('"') >= 0 || path.IndexOf('\\') >= 0) throw new IrFormatException("asset path '" + path + "' cannot be written in a USS url()");
                var url = path.StartsWith("Assets/", StringComparison.Ordinal) || path.StartsWith("Packages/", StringComparison.Ordinal)
                    ? "project://database/" + path
                    : path;
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
                return Draft(child, false);
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
                    _removed.Add(w.Node.Id);
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
                if (p.Kind != "container" || p.Repeat != null) return false;
                foreach (var layer in p.Style.Keys.Concat(new[] { Base }))
                    if ((Get(p, layer, "flex-direction") ?? "column") != "column") return false;

                if (w.Kind != "container" || w.External || w.Id.IndexOf("__", StringComparison.Ordinal) < 0 || w.Text != null ||
                    w.Asset != null || w.Background != null || w.Bind != null || w.Action != null || w.Repeat != null ||
                    w.Clickable || w.MirrorPseudoState || wrapper.IrClasses.Count > 0 || wrapper.FirstItem ||
                    (w.Anims != null && w.Anims.Count > 0) || w.Transitions.Count > 0 ||
                    wrapper.TemplateItems != null || wrapper.Children.Count != 1)
                    return false;
                bool wrapperShrinks = true;
                foreach (var layer in wrapper.Layers)
                {
                    if (layer.Key != Base) return false;
                    foreach (var decl in layer.Value)
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
                var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var r in _repeats)
                    if (r.TemplateFile != null && !files.Add(r.TemplateFile))
                        throw new IrFormatException("two list repeats would write '" + r.TemplateFile + "'; give them different repeat names");
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
                var e = new CompiledElement { Tag = d.Tag, Name = node.Id, PickingIgnore = node.PickingIgnore, Source = node };
                if (d.Layers.Count > 0) e.Classes.Add(ClassFor(d));
                e.Classes.AddRange(d.IrClasses);
                if (d.FirstItem) e.Classes.Add(FirstItemClass);
                if (node.MirrorPseudoState)
                {
                    e.Classes.Add(MirrorHostClass);
                    e.MirrorHost = true;
                    e.MirrorElement = d.Children.Select(c => c.Node.Id).FirstOrDefault(id => id + HostSuffix == node.Id)
                                      ?? throw new IrFormatException("shadow host '" + node.Id + "' has no element to mirror");
                }
                e.Clickable = node.Clickable && d.Tag != "ui:Button" && d.Tag != "ui:Toggle";
                if (node.Text != null)
                {
                    e.Text = node.Text.Tr ?? "";
                    if (!node.Text.Rich && e.Text.IndexOf('<') >= 0) e.EnableRichText = false;
                }

                // a list repeat registers before its items so repeats are listed in document order
                CompiledRepeat repeat = null;
                if (node.Repeat != null)
                {
                    repeat = new CompiledRepeat
                    {
                        Name = node.Repeat.Name,
                        Mode = d.TemplateItems != null ? "list" : "inline",
                        Container = node.Id,
                        TemplateFile = d.TemplateItems != null ? Pascal(node.Repeat.Name, "repeat name") + "Item.uxml" : null,
                    };
                    _repeats.Add(repeat);
                }
                foreach (var child in d.Children) e.Children.Add(Emit(child));
                if (repeat != null)
                {
                    if (d.TemplateItems != null) foreach (var item in d.TemplateItems) repeat.Items.Add(Emit(item));
                    else repeat.Items.AddRange(e.Children.Where(c => c.Source != null && c.Name != node.Id + "__image"));
                }
                return e;
            }

            string ClassFor(Draft d)
            {
                var sb = new StringBuilder();
                if (d.IsRoot) sb.Append("root\n"); // the root's state and breakpoint selectors differ, so it never shares a class
                foreach (var layer in d.Layers)
                {
                    sb.Append('[').Append(layer.Key).Append("]\n");
                    foreach (var decl in layer.Value) sb.Append(decl.Property).Append(": ").Append(decl.Value).Append(";\n");
                }
                var canonical = sb.ToString();
                var cls = "s-" + Hash8(canonical);
                if (_canonical.TryGetValue(cls, out var existing))
                {
                    if (existing != canonical) throw new IrFormatException("style class " + cls + " is the hash of two different declaration lists (element '" + d.Node.Id + "')");
                    return cls;
                }
                _canonical[cls] = canonical;
                foreach (var layer in d.Layers) _rules.Add(new UssRule(Selector(layer.Key, cls, d.IsRoot), layer.Value));
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
