using System;
using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using static DesignUi.Editor.Tests.TestIr;

namespace DesignUi.Editor.Tests
{
    /// <summary>Compound layer keys (spec 7) through the lowering and the selectors (spec 8).</summary>
    public class CompoundLayerTests
    {
        static readonly Dictionary<string, double> Kit = new Dictionary<string, double> { { "label", 16.515625 } };

        static CompiledScreen Build(IrScreen ir) => ScreenBuilder.Build(ir, RelativeAsset, null, Kit);

        static string Cls(CompiledScreen s, string name) => s.Find(name).Classes.Single(c => c.StartsWith("s-", StringComparison.Ordinal));

        static UssRule Rule(CompiledScreen s, string selector)
        {
            var rules = s.Rules.Where(r => r.Selector == selector).ToList();
            Assert.AreEqual(1, rules.Count, "one rule '" + selector + "' in:\n" + UssWriter.Write(s));
            return rules[0];
        }

        static string Decl(UssRule r, string property) => r.Declarations.Single(d => d.Property == property).Value;

        // ---- lowering: the cascade per compound key ---------------------------------------------------------

        [Test]
        public void Lowering_CanonicalisesKeys_AndRejectsTwoSpellingsOfOneLayer()
        {
            var n = Node("a", "container", ("height", "1px")).With("hover+state:x", ("opacity", "0.5"));
            Assert.AreEqual("0.5", Lowering.Apply(Root(n)).Children[0].Style["state:x+hover"]["opacity"]);
            n.With("state:x+hover", ("opacity", "0.4"));
            StringAssert.Contains("same layer", Assert.Throws<IrFormatException>(() => Lowering.Apply(Root(n))).Message);
        }

        [Test]
        public void Display_ResolvedAgainstEachKeysOwnLayers()
        {
            // hidden in a state, shown again on hover in that state: the union shows it with flex, the plain hover block is redundant
            var n = Node("a", "container", ("height", "1px"))
                .With("state:x", ("display", "none"))
                .With("hover", ("display", "block"))
                .With("state:x+hover", ("display", "block"));
            var a = Lowering.Apply(Root(n)).Children[0];
            Assert.AreEqual("none", a.Style["state:x"]["display"]);
            Assert.IsFalse(a.Style.TryGetValue("hover", out var hover) && hover.ContainsKey("display"));
            Assert.AreEqual("flex", a.Style["state:x+hover"]["display"]);
        }

        [Test]
        public void TextPairs_TwoLayersSettingDifferentParts_GetTheirUnion()
        {
            var t = Text("t", "T", ("font-weight", "700"))
                .With("state:x", ("font-weight", "400"))
                .With("hover", ("font-style", "italic"));
            var lowered = Lowering.Apply(Root(t)).Children[0];
            var union = lowered.Style["state:x+hover"];
            Assert.AreEqual("400", union["font-weight"]);
            Assert.AreEqual("italic", union["font-style"]);

            var s = Build(Screen(Root(Text("t", "T", ("font-weight", "700")).With("state:x", ("font-weight", "400")).With("hover", ("font-style", "italic")))));
            var cls = Cls(s, "t");
            Assert.AreEqual("bold", Decl(Rule(s, "." + cls), "-unity-font-style"));
            Assert.AreEqual("normal", Decl(Rule(s, ".state-x ." + cls), "-unity-font-style"));
            Assert.AreEqual("bold-and-italic", Decl(Rule(s, "." + cls + ":hover"), "-unity-font-style"), "hover over base");
            Assert.AreEqual("italic", Decl(Rule(s, ".state-x ." + cls + ":hover"), "-unity-font-style"), "both parts, more specific than either layer");
        }

        [Test]
        public void TextPairs_NoUnionForLayersThatNeverHoldTogether()
        {
            var t = Text("t", "T").With("bp:narrow", ("font-weight", "700")).With("bp:wide", ("font-style", "italic"))
                .With("state:a", ("font-weight", "700")).With("state:b", ("font-style", "italic"));
            var ir = Screen(Root(t));
            ir.Breakpoints = new[] { new IrBreakpoint { Name = "narrow", MaxWidth = 1600 }, new IrBreakpoint { Name = "wide", MinWidth = 1601 } };
            var keys = Lowering.Apply(ir.Root, ir.Breakpoints).Children[0].Style.Keys.ToList();
            CollectionAssert.DoesNotContain(keys, "bp:narrow+bp:wide");
            CollectionAssert.DoesNotContain(keys, "state:a+state:b");
            CollectionAssert.Contains(keys, "bp:narrow+state:b");
        }

        [Test]
        public void TextAlign_FlexPartsFromTwoLayers_AreComposedInTheirUnion()
        {
            var t = Text("t", "T", ("display", "flex"), ("height", "40px"))
                .With("hover", ("justify-content", "center"))
                .With("state:x", ("align-items", "center"));
            var s = Build(Screen(Root(t)));
            var cls = Cls(s, "t");
            Assert.AreEqual("upper-center", Decl(Rule(s, "." + cls + ":hover"), "-unity-text-align"));
            Assert.AreEqual("middle-left", Decl(Rule(s, ".state-x ." + cls), "-unity-text-align"));
            Assert.AreEqual("middle-center", Decl(Rule(s, ".state-x ." + cls + ":hover"), "-unity-text-align"));
        }

        [Test]
        public void BorderStyle_NoneInOneLayer_WidthInAnother_UnionKeepsTheBorderHidden()
        {
            var n = Node("a", "container", ("height", "1px"), ("border-top-style", "solid"), ("border-top-width", "1px"))
                .With("state:x", ("border-top-style", "none"))
                .With("hover", ("border-top-width", "3px"));
            var s = Build(Screen(Root(n)));
            var cls = Cls(s, "a");
            Assert.AreEqual("3px", Decl(Rule(s, "." + cls + ":hover"), "border-top-width"));
            Assert.AreEqual("0", Decl(Rule(s, ".state-x ." + cls + ":hover"), "border-top-width"));
        }

        [Test]
        public void ComposedUnion_NeverPairsAShorthandWithItsLonghand()
        {
            var n = Node("a", "container", ("height", "1px"), ("border-width", "1px"), ("border-style", "solid"))
                .With("state:x", ("border-width", "2px"))
                .With("hover", ("border-top-style", "none"));
            var s = Build(Screen(Root(n)));
            var union = Rule(s, ".state-x ." + Cls(s, "a") + ":hover");
            Assert.AreEqual("2px", Decl(union, "border-width"));
            Assert.AreEqual("0", Decl(union, "border-top-width"), "the hidden side wins over the shorthand");
            CollectionAssert.AreEquivalent(new[] { "border-top-style", "border-width" }, Lowering.Apply(Root(n)).Children[0].Style["state:x+hover"].Keys.ToArray());
        }

        [Test]
        public void Gap_ChildLayerAndContainerState_TheirUnionAddsBoth()
        {
            var b = Node("b", "container", ("height", "1px")).With("hover", ("margin-left", "2px"));
            var p = Node("p", "container", ("display", "flex"), ("flex-direction", "row"), ("gap", "4px"))
                .With("state:x", ("gap", "10px"))
                .Add(Node("a", "container", ("height", "1px")), b);
            var lb = Lowering.Apply(Root(p)).Children[0].Children[1];
            Assert.AreEqual("4px", lb.Style["base"]["margin-left"]);
            Assert.AreEqual("6px", lb.Style["hover"]["margin-left"]);
            Assert.AreEqual("10px", lb.Style["state:x"]["margin-left"]);
            Assert.AreEqual("12px", lb.Style["state:x+hover"]["margin-left"], "own hover margin plus the state's gap");
        }

        [Test]
        public void Gap_SiblingHiddenInAStateAndChildHoverMargin_UnionHasNoGap()
        {
            var a = Node("a", "container", ("height", "1px")).With("state:x", ("display", "none"));
            var b = Node("b", "container", ("height", "1px")).With("hover", ("margin-left", "2px"));
            var p = Node("p", "container", ("display", "flex"), ("flex-direction", "row"), ("gap", "10px")).Add(a, b);
            var lb = Lowering.Apply(Root(p)).Children[0].Children[1];
            Assert.AreEqual("10px", lb.Style["base"]["margin-left"]);
            Assert.AreEqual("0px", lb.Style["state:x"]["margin-left"], "first visible");
            Assert.AreEqual("12px", lb.Style["hover"]["margin-left"]);
            Assert.AreEqual("2px", lb.Style["state:x+hover"]["margin-left"], "first visible, own hover margin only");
        }

        [Test]
        public void Gap_AfterAnAlwaysVisibleSibling_OtherSiblingsLayersAddNoUnions()
        {
            // tab panels below a header: each panel shows for its own tab class on the root; the header keeps every panel from being first
            var kids = new List<IrNode> { Node("header", "container", ("height", "10px")) };
            for (int i = 0; i < 12; i++)
                kids.Add(Node("panel-" + i, "container", ("height", "10px"), ("display", "none")).With("anc(root):class:is-tab-" + i, ("display", "flex")));
            var tabs = Node("tabs", "container", ("display", "flex"), ("flex-direction", "column"), ("gap", "8px")).Add(kids.ToArray());
            var lowered = Lowering.Apply(Root(tabs)).Children[0];
            foreach (var panel in lowered.Children.Skip(1))
            {
                Assert.AreEqual("8px", panel.Style["base"]["margin-top"], panel.Id);
                Assert.AreEqual(2, panel.Style.Count, panel.Id + ": base and the layer that shows it, no unions");
            }
        }

        [Test]
        public void TextAlign_ALayerThatOnlyHidesTheText_NeedsNoUnion()
        {
            var t = Text("t", "T", ("display", "flex")).With("state:x", ("display", "none")).With("hover", ("justify-content", "center"));
            CollectionAssert.DoesNotContain(Lowering.Apply(Root(t)).Children[0].Style.Keys.ToList(), "state:x+hover");
        }

        [Test]
        public void Gap_SiblingHiddenByItsOwnClass_CannotBeFollowed()
        {
            var a = Node("a", "container", ("height", "1px")).With("class:is-hidden", ("display", "none"));
            var p = Node("p", "container", ("display", "flex"), ("flex-direction", "row"), ("gap", "10px")).Add(a, Node("b", "container", ("height", "1px")));
            var e = Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(Root(p)));
            StringAssert.Contains("'a'", e.Message);
        }

        [Test]
        public void Gap_RepeatItemHoverMargin_FirstItemUnionDropsTheGap()
        {
            var item = Node("item", "container", ("height", "10px")).With("hover", ("margin-top", "2px"));
            var items = Node("items", "container", ("display", "flex"), ("flex-direction", "column"), ("gap", "8px")).Add(item);
            items.Repeat = new IrRepeat { Name = "item", Mode = "inline", Count = 2 };
            var li = Lowering.Apply(Root(items)).Children[0].Children[0];
            Assert.AreEqual("8px", li.Style["base"]["margin-top"]);
            Assert.AreEqual("10px", li.Style["hover"]["margin-top"]);
            Assert.AreEqual("0px", li.Style[Lowering.FirstItemLayer]["margin-top"]);
            Assert.AreEqual("2px", li.Style["class:__first+hover"]["margin-top"]);

            var s = Build(Screen(Root(items)));
            var cls = Cls(s, "item");
            Assert.AreEqual("2px", Decl(Rule(s, "." + cls + ".__first:hover"), "margin-top"));
        }

        [Test]
        public void Shadow_CompoundPseudoLayersBecomeMirrorClassDimensions_AncestorDimensionsStay()
        {
            var card = Node("card", "container", ("width", "10px"), ("height", "10px"))
                .With("state:x+hover", ("translate", "0 -4px"), ("background-color", "#222222"))
                .With("anc(list):class:is-open", ("opacity", "0.5"))
                .With("anc(list):hover+active", ("scale", "0.9"));
            card.Shadow = new IrShadow { Kind = "shadow9", File = ShadowFile, Sha256 = "x", Width = 8, Height = 8, Slice = new float[] { 2, 2, 2, 2 }, Offset = new BoxRect() };
            var list = Node("list", "container", ("position", "relative")).Add(card);
            var host = Lowering.Apply(Root(list)).Children[0].Children[0];
            var el = host.Children[1];
            Assert.AreEqual("0 -4px", host.Style["state:x+class:dui-hover"]["translate"]);
            Assert.AreEqual("#222222", el.Style["state:x+hover"]["background-color"]);
            Assert.AreEqual("0.5", host.Style["anc(list):class:is-open"]["opacity"]);
            Assert.AreEqual("0.9", host.Style["class:dui-active+anc(list):hover"]["scale"]);
            Assert.IsTrue(host.MirrorPseudoState);
            CollectionAssert.IsEmpty(host.MirrorClasses);

            var s = Build(Screen(Root(list)));
            var hostCls = Cls(s, "card__shadowhost");
            Assert.AreEqual("0 -4px", Decl(Rule(s, ".state-x ." + hostCls + ".dui-hover"), "translate"));
            Assert.AreEqual("0.9", Decl(Rule(s, "." + Cls(s, "list") + ":hover ." + hostCls + ".dui-active"), "scale"));
            Assert.AreEqual("0.5", Decl(Rule(s, "." + Cls(s, "list") + ".is-open ." + hostCls), "opacity"));
        }

        [Test]
        public void Shadow_MovedLayerOfTheElementsOwnClass_TheHostMirrorsThatClass()
        {
            var card = Node("card", "container", ("width", "10px"), ("height", "10px"))
                .With("class:is-selected", ("translate", "0 -4px"), ("background-color", "#222222"));
            card.Classes = new[] { "card", "is-selected" };
            card.Shadow = new IrShadow { Kind = "shadow9", File = ShadowFile, Sha256 = "x", Width = 8, Height = 8, Slice = new float[] { 2, 2, 2, 2 }, Offset = new BoxRect() };
            var s = Build(Screen(Root(card)));
            var host = s.Find("card__shadowhost");
            CollectionAssert.AreEqual(new[] { "is-selected" }, host.MirrorClasses);
            Assert.AreEqual("card", host.MirrorElement);
            Assert.IsFalse(host.MirrorHost, "no pseudo-state to mirror");
            CollectionAssert.Contains(host.Classes, "is-selected", "the host starts with the element's class");
            CollectionAssert.Contains(s.Find("card").Classes, "is-selected");
            Assert.AreEqual("0 -4px", Decl(Rule(s, "." + Cls(s, "card__shadowhost") + ".is-selected"), "translate"));
            Assert.AreEqual("#222222", Decl(Rule(s, "." + Cls(s, "card") + ".is-selected"), "background-color"));
        }

        [Test]
        public void Shadow_AnimationsOfMovedPropertiesMoveToTheHost()
        {
            IrAnim Anim(string kind, string trigger, params string[] props) => new IrAnim
            {
                Kind = kind, Trigger = trigger, Phase = "enter", Name = kind == IrAnim.KeyframesKind ? "pulse" : null, Properties = props,
                Duration = 200, Timing = "ease", Iterations = 1, Direction = "normal", FillMode = "none", PlayState = "running", Restart = true,
                Keyframes = kind == IrAnim.KeyframesKind
                    ? new List<IrKeyframe> { new IrKeyframe { Offset = 0, Values = new Dictionary<string, string> { { "opacity", "1" }, { "color", "#ffffff" } } } }
                    : new List<IrKeyframe>(),
            };
            var card = Node("card", "container", ("width", "10px"), ("height", "10px")).With("state:x+hover", ("opacity", "0.5"), ("background-color", "#222222"));
            card.Anims = new List<IrAnim>
            {
                Anim(IrAnim.Transition, "state:x+hover", "opacity", "background-color"),
                Anim(IrAnim.KeyframesKind, "show", "opacity", "color"),
                Anim(IrAnim.Transition, "hover", "all"),
            };
            card.Shadow = new IrShadow { Kind = "shadow9", File = ShadowFile, Sha256 = "x", Width = 8, Height = 8, Slice = new float[] { 2, 2, 2, 2 }, Offset = new BoxRect() };
            var host = Lowering.Apply(Root(card)).Children[0];
            var el = host.Children[1];
            Assert.AreEqual(3, host.Anims.Count);
            Assert.AreEqual("state:x+class:dui-hover", host.Anims[0].Trigger);
            CollectionAssert.AreEqual(new[] { "opacity" }, host.Anims[0].Properties);
            Assert.AreEqual("show", host.Anims[1].Trigger);
            CollectionAssert.AreEqual(new[] { "opacity" }, host.Anims[1].Keyframes[0].Values.Keys.ToArray());
            Assert.AreEqual("class:dui-hover", host.Anims[2].Trigger);
            Assert.AreEqual(3, el.Anims.Count);
            CollectionAssert.AreEqual(new[] { "background-color" }, el.Anims[0].Properties);
            Assert.AreEqual("state:x+hover", el.Anims[0].Trigger);
            CollectionAssert.AreEqual(new[] { "color" }, el.Anims[1].Keyframes[0].Values.Keys.ToArray());
            CollectionAssert.AreEqual(new[] { "all" }, el.Anims[2].Properties);
            Assert.AreEqual(2, card.Anims[1].Keyframes[0].Values.Count, "the input is not changed");
        }

        [Test]
        public void AncestorPressed_GetsAClickable()
        {
            var title = Text("title", "T").With("anc(card):active", ("color", "#ff0000"));
            var card = Node("card", "container", ("height", "10px")).Add(title);
            var r = Lowering.Apply(Root(card));
            Assert.IsTrue(r.Children[0].Clickable, "UI Toolkit sets :active only on elements with a Clickable");
            Assert.IsFalse(r.Children[0].Children[0].Clickable);
            Assert.IsTrue(Build(Screen(Root(card))).Find("card").Clickable);
        }

        // ---- selectors -------------------------------------------------------------------------------------

        [Test]
        public void Selectors_CompoundForms()
        {
            var a = Node("a", "container", ("height", "1px"))
                .With("state:loading+hover", ("opacity", "0.1"))
                .With("bp:narrow+hover", ("opacity", "0.2"))
                .With("bp:narrow+state:loading", ("opacity", "0.3"))
                .With("class:is-selected+hover", ("opacity", "0.4"))
                .With("bp:narrow+state:loading+class:is-selected+active+hover", ("opacity", "0.5"));
            var root = Root(a).With("state:loading+hover", ("opacity", "0.6")).With("bp:narrow+state:loading", ("opacity", "0.7"));
            var s = Build(Screen(root));
            var c = Cls(s, "a");
            var r = Cls(s, "root");
            Assert.AreEqual("0.1", Decl(Rule(s, ".state-loading ." + c + ":hover"), "opacity"));
            Assert.AreEqual("0.2", Decl(Rule(s, ".bp-narrow ." + c + ":hover"), "opacity"));
            Assert.AreEqual("0.3", Decl(Rule(s, ".bp-narrow.state-loading ." + c), "opacity"));
            Assert.AreEqual("0.4", Decl(Rule(s, "." + c + ".is-selected:hover"), "opacity"));
            Assert.AreEqual("0.5", Decl(Rule(s, ".bp-narrow.state-loading ." + c + ".is-selected:active:hover"), "opacity"));
            Assert.AreEqual("0.6", Decl(Rule(s, "." + r + ".state-loading:hover"), "opacity"));
            Assert.AreEqual("0.7", Decl(Rule(s, "." + r + ".bp-narrow.state-loading"), "opacity"));
        }

        [Test]
        public void Selectors_AncestorConditionsUseTheAncestorsClass_OutermostFirst()
        {
            var title = Text("title", "T", ("color", "#ffffff"))
                .With("anc(card):hover", ("color", "#111111"))
                .With("anc(row):class:is-selected", ("color", "#222222"))
                .With("state:x+anc(card):hover+anc(row):class:is-selected", ("color", "#333333"))
                .With("anc(root):hover", ("color", "#444444"))
                .With("state:x+anc(root):hover", ("color", "#555555"));
            var card = Node("card", "container", ("height", "10px")).Add(title);
            var row = Node("row", "container", ("height", "20px")).Add(card);
            var s = Build(Screen(Root(row)));
            var t = Cls(s, "title");
            var cardCls = Cls(s, "card");
            var rowCls = Cls(s, "row");
            var rootCls = Cls(s, "root");
            Assert.AreEqual("#111111", Decl(Rule(s, "." + cardCls + ":hover ." + t), "color"));
            Assert.AreEqual("#222222", Decl(Rule(s, "." + rowCls + ".is-selected ." + t), "color"));
            Assert.AreEqual("#333333", Decl(Rule(s, ".state-x ." + rowCls + ".is-selected ." + cardCls + ":hover ." + t), "color"));
            Assert.AreEqual("#444444", Decl(Rule(s, "." + rootCls + ":hover ." + t), "color"));
            Assert.AreEqual("#555555", Decl(Rule(s, "." + rootCls + ".state-x:hover ." + t), "color"), "the root carries the state class itself");
        }

        [Test]
        public void AncestorTarget_HasItsOwnClassAndIsNeverRemovedAsAWrapper()
        {
            // two structurally named, style-free wrappers: the one a descendant names stays and gets a class of its own
            var title = Text("title", "T").With("anc(root__1):class:is-open", ("color", "#ff0000"));
            var inner = new IrNode { Id = "root__1", Kind = "container" }.Add(title);
            var outer = new IrNode { Id = "root__0", Kind = "container" }.Add(inner);
            var s = Build(Screen(new IrNode { Id = "root", Kind = "container" }.Add(outer)));
            CollectionAssert.Contains(s.RemovedElements.ToArray(), "root__0");
            Assert.IsNotNull(s.Find("root__1"));
            var cls = Cls(s, "root__1");
            Assert.AreEqual("#ff0000", Decl(Rule(s, "." + cls + ".is-open ." + Cls(s, "title")), "color"));

            var twin = Build(Screen(Root(Node("p", "container").Add(Text("u", "U").With("anc(p):hover", ("color", "#ff0000"))),
                Node("q", "container").Add(Text("v", "V").With("anc(q):hover", ("color", "#ff0000"))))));
            Assert.AreNotEqual(Cls(twin, "p"), Cls(twin, "q"), "each named ancestor has a class only it carries");
        }

        [Test]
        public void AncestorThatIsNotInTheCompiledTree_IsAnError()
        {
            var title = Text("title", "T").With("anc(elsewhere):hover", ("color", "#ff0000"));
            var e = Assert.Throws<IrFormatException>(() => Build(Screen(Root(Node("a", "container").Add(title), Node("elsewhere", "container")))));
            StringAssert.Contains("elsewhere", e.Message);
        }

        [Test]
        public void Rules_BaseThenSingleDimensionsThenUnions()
        {
            var a = Node("a", "container", ("height", "1px"))
                .With("state:x+hover", ("opacity", "0.1")).With("hover", ("opacity", "0.2")).With("state:x", ("opacity", "0.3"));
            var s = Build(Screen(Root(a)));
            var c = Cls(s, "a");
            CollectionAssert.AreEqual(new[] { "." + c, ".state-x ." + c, "." + c + ":hover", ".state-x ." + c + ":hover" },
                s.Rules.Select(r => r.Selector).Where(x => x.Contains(c)).ToArray());
        }

        [Test]
        public void Sample_CompoundAndAncestorLayersCompile()
        {
            var s = ScreenBuilder.Build(IrReader.Read(IrReaderTests.SamplePath()), RelativeAsset, null,
                new Dictionary<string, double> { { "label", 16.515625 }, { "title", 46.28125 } });
            var play = Cls(s, "play");
            Assert.AreEqual("#2fd1c5", Decl(Rule(s, ".state-loading ." + play + ":hover"), "background-color"));
            Assert.AreEqual("#0b1f26", Decl(Rule(s, "." + Cls(s, "row") + ".is-selected ." + Cls(s, "row-name")), "color"));
            CollectionAssert.Contains(s.Find("play").Attributes, new KeyValuePair<string, string>("tooltip", "Maçı başlat"));
            Assert.AreEqual("show", s.Find("card__shadowhost").Source.Anims.Single().Trigger, "the opacity pulse moves with the shadow host");
            Assert.IsEmpty(s.Find("card").Source.Anims);
        }
    }
}
