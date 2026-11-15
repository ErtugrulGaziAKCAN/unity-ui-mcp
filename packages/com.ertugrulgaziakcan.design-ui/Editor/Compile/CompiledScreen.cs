using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>One USS rule: a selector (spec 8 policy) and its declarations.</summary>
    public readonly struct UssRule
    {
        public readonly string Selector;
        public readonly IReadOnlyList<UssDeclaration> Declarations;

        public UssRule(string selector, IReadOnlyList<UssDeclaration> declarations)
        {
            Selector = selector;
            Declarations = declarations;
        }

        public override string ToString() => Selector + " { " + string.Join("; ", Declarations) + " }";
    }

    /// <summary>One UXML element of a compiled screen.</summary>
    public sealed class CompiledElement
    {
        /// <summary>UXML tag, e.g. <c>ui:VisualElement</c>.</summary>
        public string Tag;
        /// <summary>The IR id: <c>data-u-id</c> or the structural name. Every element has one.</summary>
        public string Name;
        /// <summary>The style class (<c>s-xxxxxxxx</c>) first, then IR <c>is-*</c> classes and marker classes.</summary>
        public readonly List<string> Classes = new List<string>();
        public readonly List<CompiledElement> Children = new List<CompiledElement>();
        /// <summary>Static text (the reference-locale text, spec 13), or null (also when the text is bound to a String Table entry).</summary>
        public string Text;
        /// <summary>False when plain text contains '&lt;' (rich text would read it as a tag); null keeps the default.</summary>
        public bool? EnableRichText;
        /// <summary>
        /// Attributes written to UXML in order: <c>placeholder-text</c> and <c>tooltip</c> from attribute texts, <c>enabled</c>
        /// and <c>value</c> from the initial disabled and checked states, ScrollView <c>mode</c> and scroller visibility,
        /// ListView <c>fixed-item-height</c> (or <c>virtualization-method</c>) and <c>selection-type</c> None.
        /// </summary>
        public readonly List<KeyValuePair<string, string>> Attributes = new List<KeyValuePair<string, string>>();
        /// <summary>picking-mode Ignore (baked shadows, pointer-events: none).</summary>
        public bool PickingIgnore;
        /// <summary>The element needs a Clickable from the view so that :active works (not a Button or Toggle, which have one).</summary>
        public bool Clickable;
        /// <summary>A shadow host: the view attaches a PseudoStateMirror to <see cref="MirrorElement"/> that targets this host.</summary>
        public bool MirrorHost;
        /// <summary>Name of the element whose pseudo-states or classes this host mirrors, or null.</summary>
        public string MirrorElement;
        /// <summary>
        /// A shadow host: the <c>is-*</c> classes of <see cref="MirrorElement"/> that its rules depend on. The view toggles
        /// each of them on the host whenever it toggles it on the element.
        /// </summary>
        public readonly List<string> MirrorClasses = new List<string>();
        /// <summary>
        /// Attribute texts UI Toolkit does not draw (<c>alt</c>, <c>aria-label</c>), by attribute name; the manifest records
        /// them per element so assistive features and the view can use them.
        /// </summary>
        public readonly SortedDictionary<string, IrText> AccessibilityLabels = new SortedDictionary<string, IrText>(System.StringComparer.Ordinal);
        /// <summary>
        /// String Table bindings of the element's texts (<see cref="ScreenLocalization"/>), written as UXML
        /// <c>&lt;Bindings&gt;</c>; empty when the profile does not localize (the texts are static).
        /// </summary>
        public readonly List<CompiledBinding> Bindings = new List<CompiledBinding>();
        /// <summary>The lowered IR node (bind, action, text key and args, anims, transitions), for the view writer and later tasks.</summary>
        public IrNode Source;
        /// <summary>
        /// An element the design's repeat items hide by markup in some items (<see cref="IrNode.ItemVisibility"/>): the name of
        /// the element its view setter <c>Set&lt;Id&gt;Visible</c> shows and hides, itself or the shadow host that owns its
        /// visibility; null for every other element.
        /// </summary>
        public string VisibilityOwner;

        public IEnumerable<CompiledElement> DescendantsAndSelf()
        {
            yield return this;
            foreach (var child in Children)
                foreach (var e in child.DescendantsAndSelf())
                    yield return e;
        }
    }

    /// <summary>
    /// A repeated item template (<c>data-u-repeat</c>). Mode <c>list</c>: the container is a ListView, with fixed-height
    /// slots (item height and margins plus the gap) when the items have one px height, else measured items (dynamic
    /// height); its item lives only in the item template. Mode <c>inline</c>: the item stays in the screen's UXML as the
    /// first item, and the view clones more from the template; the view keeps <see cref="ScreenBuilder.FirstItemClass"/> on
    /// the first item. The template is written to its own UXML (<see cref="TemplateFile"/>), which the screen's UXML
    /// declares. Only the template is compiled; the IR's <c>repeat.count</c> sample items are filled from the fixtures by
    /// the verifier.
    /// </summary>
    public sealed class CompiledRepeat
    {
        public string Name;
        public string Mode;
        /// <summary>Name of the repeat container.</summary>
        public string Container;
        /// <summary>Item template file next to the screen (<c>&lt;Repeat&gt;Item.uxml</c>).</summary>
        public string TemplateFile;
        public readonly List<CompiledElement> Items = new List<CompiledElement>();
    }

    /// <summary>The compiled form of one screen: element tree, deduplicated USS rules and what the view must wire.</summary>
    public sealed class CompiledScreen
    {
        /// <summary>IR screen id, e.g. <c>club.overview</c>.</summary>
        public string ScreenId;
        /// <summary>PascalCase screen name used for file and class names, e.g. <c>ClubOverview</c>.</summary>
        public string ClassName;
        public CompiledElement Root;
        public IReadOnlyList<UssRule> Rules;
        /// <summary>Wrappers removed because they had no visual or layout effect (verification skips their boxes).</summary>
        public IReadOnlyList<string> RemovedElements;
        public IReadOnlyList<CompiledRepeat> Repeats;
        public IReadOnlyList<string> States;
        public IReadOnlyList<string> Breakpoints;
        /// <summary>Remarks for the compile log, e.g. a text-size step that is not whole device pixels at a viewport.</summary>
        public IReadOnlyList<string> Notes = new string[0];

        /// <summary>Every element: the screen tree, then the list-mode item templates.</summary>
        public IEnumerable<CompiledElement> AllElements()
        {
            var seen = new HashSet<CompiledElement>();
            foreach (var e in Root.DescendantsAndSelf())
                if (seen.Add(e)) yield return e;
            foreach (var r in Repeats)
                foreach (var item in r.Items)
                    foreach (var e in item.DescendantsAndSelf())
                        if (seen.Add(e)) yield return e;
        }

        public CompiledElement Find(string name) => AllElements().FirstOrDefault(e => e.Name == name);
    }
}

namespace DesignUi.Editor
{
    /// <summary>What a screen compiles with besides its IR (spec 8, 13): the kit's text styles and the profile's settings.</summary>
    public sealed class ScreenBuildOptions
    {
        /// <summary>Kit text style name to font size in px (<see cref="KitTextStyles.Load"/>), or null without a table.</summary>
        public IReadOnlyDictionary<string, double> TextStyleSizes;
        /// <summary>Kit text style name to its line-box key (<see cref="KitTextStyles.LoadLineBoxes"/>), or null.</summary>
        public IReadOnlyDictionary<string, string> TextStyleLineBoxes;
        /// <summary>The kit's line boxes (<see cref="KitTextStyles.LineBoxesOf"/>), which the text-size steps scale.</summary>
        public IReadOnlyList<FontTwinGenerator.LineBox> LineBoxes;
        /// <summary>The profile's text-size steps; each gets <c>.text-size-&lt;key&gt;</c> rules.</summary>
        public IReadOnlyList<DesignUi.DesignTextSize> TextSizes;
        /// <summary>The profile's right-to-left alignment rule (<c>.rtl</c> rules), or null for none.</summary>
        public DesignUi.RtlTextAlignment? RtlAlignment;
        /// <summary>The exact viewports and their panel scales: text-size steps are checked at each (scaled viewports are exempt).</summary>
        public IReadOnlyList<(Vector2Int viewport, double scale)> Viewports;
        /// <summary>The panel scales of the profile's exact viewports: the screen root's <c>exact-scales</c> (DesignScreen).</summary>
        public IReadOnlyList<double> ExactScales;
        /// <summary>
        /// Every locale's text of a String Table key of the screen (the compiler reads the tables before it builds), or null
        /// without localization: a text gets a fixed line count only when each of them keeps it.
        /// </summary>
        public Func<string, IEnumerable<string>> Translations;
        /// <summary>The compiled font set (<c>DesignFonts.asset</c>) relative to the screen's UXML, for the screen root's reference, or null.</summary>
        public string FontSet;
    }
}
