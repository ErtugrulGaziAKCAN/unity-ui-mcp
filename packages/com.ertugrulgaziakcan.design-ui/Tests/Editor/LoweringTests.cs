using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;

namespace DesignUi.Editor.Tests
{
    public class LoweringTests
    {
        static IrNode Node(string id, params (string k, string v)[] style)
        {
            var n = new IrNode { Id = id, Kind = "container" };
            n.Style["base"] = Layer(style);
            return n;
        }

        static Dictionary<string, string> Layer(params (string k, string v)[] style)
        {
            var d = new Dictionary<string, string>();
            foreach (var (k, v) in style) d[k] = v;
            return d;
        }

        static IrNode WithChildren(IrNode parent, params IrNode[] kids) { parent.Children = kids; return parent; }

        static IrNode Flex(string id, string direction, params (string k, string v)[] extra)
        {
            var style = new List<(string, string)> { ("display", "flex"), ("flex-direction", direction) };
            style.AddRange(extra);
            return Node(id, style.ToArray());
        }

        static Dictionary<string, string> B(IrNode n) => n.Style["base"];
        static string[] Ids(IrNode n) => n.Children.Select(c => c.Id).ToArray();

        static IrShadow Shadow(float x, float y, float w, float h) =>
            new IrShadow { Kind = "shadow9", File = "s.png", Sha256 = "x", Width = 96, Height = 96, Slice = new float[] { 40, 40, 40, 40 }, Offset = new BoxRect { X = x, Y = y, W = w, H = h } };

        // ---- gap -------------------------------------------------------------------------------------------

        [Test]
        public void Gap_Row_BecomesMarginLeftOnChildrenTwoAndThree()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "12px")), Node("a"), Node("b"), Node("c")));
            Assert.IsFalse(B(r).ContainsKey("gap"));
            Assert.IsFalse(B(r.Children[0]).ContainsKey("margin-left"));
            Assert.AreEqual("12px", B(r.Children[1])["margin-left"]);
            Assert.AreEqual("12px", B(r.Children[2])["margin-left"]);
            Assert.AreEqual("flex", B(r)["display"]);
        }

        [Test]
        public void Gap_Column_BecomesMarginTop()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "column", ("gap", "8px")), Node("a"), Node("b")));
            Assert.AreEqual("8px", B(r.Children[1])["margin-top"]);
            Assert.IsFalse(B(r.Children[0]).ContainsKey("margin-top"));
        }

        [Test]
        public void Gap_ReverseDirections_UseTheTrailingSideMargin()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "row-reverse", ("gap", "5px")), Node("a"), Node("b")));
            Assert.AreEqual("5px", B(r.Children[1])["margin-right"]);
            var c = Lowering.Apply(WithChildren(Flex("p", "column-reverse", ("gap", "5px")), Node("a"), Node("b")));
            Assert.AreEqual("5px", B(c.Children[1])["margin-bottom"]);
        }

        [Test]
        public void Gap_TwoValueShorthand_UsesColumnGapForRow_RowGapForColumn()
        {
            var row = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "4px 20px")), Node("a"), Node("b")));
            Assert.AreEqual("20px", B(row.Children[1])["margin-left"]);
            var col = Lowering.Apply(WithChildren(Flex("p", "column", ("gap", "4px 20px")), Node("a"), Node("b")));
            Assert.AreEqual("4px", B(col.Children[1])["margin-top"]);
        }

        [Test]
        public void Gap_Longhands_AreRemovedAndUsed()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "column", ("row-gap", "6px"), ("column-gap", "9px")), Node("a"), Node("b")));
            Assert.AreEqual("6px", B(r.Children[1])["margin-top"]);
            Assert.IsFalse(B(r).ContainsKey("row-gap"));
            Assert.IsFalse(B(r).ContainsKey("column-gap"));
        }

        [Test]
        public void Gap_AddsToExistingMargin_SkipsAbsoluteChildren_AndAbsoluteFirstChildDoesNotCount()
        {
            var abs = Node("abs", ("position", "absolute"));
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "10px")), abs, Node("a"), Node("b", ("margin-left", "4px"))));
            Assert.IsFalse(B(r.Children.Single(c => c.Id == "abs")).ContainsKey("margin-left"));
            Assert.IsFalse(B(r.Children.Single(c => c.Id == "a")).ContainsKey("margin-left"));
            Assert.AreEqual("14px", B(r.Children.Single(c => c.Id == "b"))["margin-left"]);
        }

        [Test]
        public void Gap_DisplayNoneFirstChild_FirstVisibleChildGetsNoGap()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "10px")), Node("hidden", ("display", "none")), Node("a"), Node("b")));
            Assert.IsFalse(B(r.Children[1]).ContainsKey("margin-left"));
            Assert.AreEqual("10px", B(r.Children[2])["margin-left"]);
        }

        [Test]
        public void Gap_ChildHiddenInALayer_NextVisibleChildLosesGapInThatLayer()
        {
            var a = Node("a");
            a.Style["state:loading"] = Layer(("display", "none"));
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "10px")), a, Node("b"), Node("c")));
            Assert.AreEqual("10px", B(r.Children[1])["margin-left"]);
            Assert.AreEqual("0px", r.Children[1].Style["state:loading"]["margin-left"]);
            Assert.IsFalse(r.Children[2].Style.ContainsKey("state:loading"));
        }

        [Test]
        public void Gap_OnWrappingContainer_Throws()
        {
            Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(Flex("p", "row", ("flex-wrap", "wrap"), ("gap", "4px")), Node("a"), Node("b"))));
        }

        [Test]
        public void Gap_OnNonFlexContainer_IsDropped()
        {
            var r = Lowering.Apply(WithChildren(Node("p", ("gap", "12px")), Node("a"), Node("b")));
            Assert.IsFalse(B(r).ContainsKey("gap"));
            Assert.IsFalse(B(r.Children[1]).ContainsKey("margin-top"));
            Assert.IsFalse(B(r.Children[1]).ContainsKey("margin-left"));
        }

        [Test]
        public void Gap_ParentBreakpointGap_LowersIntoSameLayerOfChildren()
        {
            var p = Flex("p", "row");
            p.Style["bp:narrow"] = Layer(("gap", "2px"));
            var r = Lowering.Apply(WithChildren(p, Node("a"), Node("b")));
            Assert.IsFalse(B(r.Children[1]).ContainsKey("margin-left"));
            Assert.AreEqual("2px", r.Children[1].Style["bp:narrow"]["margin-left"]);
        }

        [Test]
        public void Gap_ParentBreakpointGap_AddsToChildBaseMargin()
        {
            var p = Flex("p", "row");
            p.Style["bp:narrow"] = Layer(("gap", "8px"));
            var r = Lowering.Apply(WithChildren(p, Node("a"), Node("b", ("margin-left", "4px"))));
            Assert.AreEqual("12px", r.Children[1].Style["bp:narrow"]["margin-left"]);
            Assert.AreEqual("4px", B(r.Children[1])["margin-left"]);
        }

        [Test]
        public void Gap_BreakpointChangesDirection_ResetsOldAxisAndSetsNew()
        {
            var p = Flex("p", "row", ("gap", "12px"));
            p.Style["bp:narrow"] = Layer(("flex-direction", "column"));
            var r = Lowering.Apply(WithChildren(p, Node("a"), Node("b")));
            Assert.AreEqual("12px", B(r.Children[1])["margin-left"]);
            Assert.AreEqual("0px", r.Children[1].Style["bp:narrow"]["margin-left"]);
            Assert.AreEqual("12px", r.Children[1].Style["bp:narrow"]["margin-top"]);
        }

        [Test]
        public void Gap_ChildBreakpointMargin_SumsWithBaseGap()
        {
            var b = Node("b");
            b.Style["bp:narrow"] = Layer(("margin-left", "4px"));
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "12px")), Node("a"), b));
            Assert.AreEqual("12px", B(r.Children[1])["margin-left"]);
            Assert.AreEqual("16px", r.Children[1].Style["bp:narrow"]["margin-left"]);
        }

        [Test]
        public void Gap_ChildHoverMargin_SumsWithGap()
        {
            var b = Node("b");
            b.Style["hover"] = Layer(("margin-left", "2px"));
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "10px")), Node("a"), b));
            Assert.AreEqual("12px", r.Children[1].Style["hover"]["margin-left"]);
        }

        [Test]
        public void Gap_ParentPseudoStateChange_BecomesAnAncestorLayerOfTheChildren()
        {
            var p = Flex("p", "row", ("gap", "4px"));
            p.Style["hover"] = Layer(("gap", "10px"));
            p.Style["class:is-open"] = Layer(("flex-direction", "column"));
            var r = Lowering.Apply(WithChildren(p, Node("a"), Node("b")));
            var b = r.Children[1];
            Assert.AreEqual("4px", B(b)["margin-left"]);
            Assert.AreEqual("10px", b.Style["anc(p):hover"]["margin-left"], "the container's hover, seen from the child");
            Assert.AreEqual("0px", b.Style["anc(p):class:is-open"]["margin-left"]);
            Assert.AreEqual("4px", b.Style["anc(p):class:is-open"]["margin-top"]);
            Assert.AreEqual("10px", b.Style["anc(p):class:is-open+anc(p):hover"]["margin-top"], "union of both container layers");
            Assert.IsFalse(r.Children[0].Style.Keys.Any(k => k != "base"), "the first child never gets the gap");
        }

        [Test]
        public void Gap_ParentPseudoStateWrap_Throws()
        {
            var p = Flex("p", "row", ("gap", "4px"));
            p.Style["hover"] = Layer(("flex-wrap", "wrap"));
            Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(p, Node("a"), Node("b"))));
        }

        [Test]
        public void Gap_ChildMarginAuto_IsKept()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "10px")), Node("a"), Node("b", ("margin-left", "auto"))));
            Assert.AreEqual("auto", B(r.Children[1])["margin-left"]);
        }

        [Test]
        public void Gap_NonPxChildMargin_Throws()
        {
            Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "10px")), Node("a"), Node("b", ("margin-left", "5%")))));
        }

        [Test]
        public void Gap_MarginShorthandOnChild_Throws()
        {
            Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "10px")), Node("a"), Node("b", ("margin", "0")))));
        }

        [Test]
        public void Gap_RepeatContainer_GapOnTemplateItemWithFirstItemReset()
        {
            var rows = Flex("rows", "column", ("gap", "8px"));
            rows.Repeat = new IrRepeat { Name = "row", Mode = "list" };
            var r = Lowering.Apply(WithChildren(rows, Node("row", ("height", "64px"))));
            Assert.AreEqual("8px", B(r.Children[0])["margin-top"]);
            Assert.AreEqual("0px", r.Children[0].Style[Lowering.FirstItemLayer]["margin-top"]);
            Assert.IsFalse(B(r).ContainsKey("gap"));
        }

        [Test]
        public void Gap_RepeatContainer_BreakpointGapChange_Throws()
        {
            var rows = Flex("rows", "column", ("gap", "8px"));
            rows.Style["bp:narrow"] = Layer(("gap", "2px"));
            rows.Repeat = new IrRepeat { Name = "row", Mode = "list" };
            Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(WithChildren(rows, Node("row"))));
        }

        [Test]
        public void Apply_DoesNotMutateInput()
        {
            var root = WithChildren(Flex("p", "row", ("gap", "12px")), Node("a"), Node("b", ("box-sizing", "border-box")));
            Lowering.Apply(root);
            Assert.AreEqual("12px", B(root)["gap"]);
            Assert.IsFalse(B(root.Children[1]).ContainsKey("margin-left"));
            Assert.AreEqual("border-box", B(root.Children[1])["box-sizing"]);
        }

        // ---- CSS defaults ----------------------------------------------------------------------------------

        [Test]
        public void CssDefaults_FlexWithoutDirection_IsRow()
        {
            var r = Lowering.Apply(WithChildren(Node("p", ("display", "flex")), Node("a")));
            Assert.AreEqual("row", B(r)["flex-direction"]);
        }

        [Test]
        public void CssDefaults_ExplicitFlexDirection_IsKept()
        {
            var r = Lowering.Apply(WithChildren(Node("p", ("display", "flex"), ("flex-direction", "column")), Node("a")));
            Assert.AreEqual("column", B(r)["flex-direction"]);
        }

        [TestCase(true)]
        [TestCase(false)]
        public void CssDefaults_BlockContainer_IsColumn_ChildrenDoNotShrink(bool explicitBlock)
        {
            var p = explicitBlock ? Node("p", ("display", "block")) : Node("p");
            var r = Lowering.Apply(WithChildren(p, Node("a", ("flex-grow", "1"), ("flex-shrink", "2"), ("align-self", "center")), Node("b")));
            Assert.AreEqual("column", B(r)["flex-direction"]);
            Assert.IsFalse(B(r).ContainsKey("display"));
            Assert.AreEqual("0", B(r.Children[0])["flex-shrink"]);
            Assert.IsFalse(B(r.Children[0]).ContainsKey("flex-grow"));
            Assert.IsFalse(B(r.Children[0]).ContainsKey("align-self"));
            Assert.AreEqual("0", B(r.Children[1])["flex-shrink"]);
        }

        [Test]
        public void CssDefaults_BlockContainer_DropsFlexContainerProperties()
        {
            var r = Lowering.Apply(WithChildren(Node("p", ("justify-content", "center"), ("align-items", "center"), ("flex-wrap", "wrap")), Node("a")));
            foreach (var k in new[] { "justify-content", "align-items", "flex-wrap" }) Assert.IsFalse(B(r).ContainsKey(k), k);
        }

        [Test]
        public void CssDefaults_FlexChildren_KeepTheirShrink()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "row"), Node("a", ("flex-shrink", "2"))));
            Assert.AreEqual("2", B(r.Children[0])["flex-shrink"]);
        }

        [Test]
        public void CssDefaults_AbsoluteChildOfBlock_GetsNoShrink()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("a", ("position", "absolute"))));
            Assert.IsFalse(B(r.Children[0]).ContainsKey("flex-shrink"));
        }

        [Test]
        public void CssDefaults_StaticPosition_BecomesRelative_InsetsDropped()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("a", ("position", "static"), ("top", "5px"), ("left", "5px"))));
            Assert.AreEqual("relative", B(r.Children[0])["position"]);
            Assert.IsFalse(B(r.Children[0]).ContainsKey("top"));
            Assert.IsFalse(B(r.Children[0]).ContainsKey("left"));
        }

        [Test]
        public void CssDefaults_AbsentPosition_InsetsDropped()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("a", ("right", "5px"), ("bottom", "5px"))));
            Assert.IsFalse(B(r.Children[0]).ContainsKey("right"));
            Assert.IsFalse(B(r.Children[0]).ContainsKey("bottom"));
        }

        [Test]
        public void CssDefaults_RelativeAndAbsolute_KeepInsets()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("rel", ("position", "relative"), ("top", "5px")), Node("abs", ("position", "absolute"), ("top", "7px"))));
            Assert.AreEqual("5px", B(r.Children.Single(c => c.Id == "rel"))["top"]);
            Assert.AreEqual("7px", B(r.Children.Single(c => c.Id == "abs"))["top"]);
        }

        [Test]
        public void CssDefaults_ExplicitInitialValues_AreAcceptedAndMappable()
        {
            var node = Node("a", ("display", "block"), ("position", "static"), ("box-sizing", "border-box"), ("width", "10px"));
            var r = Lowering.Apply(WithChildren(Node("p"), node)).Children[0];
            Assert.DoesNotThrow(() => StyleMapper.Map(r.Style["base"], r.Style["base"], false, true));
        }

        [Test]
        public void CssDefaults_ContentBoxWithPaddingOnSizedElement_Throws()
        {
            var e = Assert.Throws<UnsupportedStyleException>(() =>
                Lowering.Apply(WithChildren(Node("p"), Node("a", ("box-sizing", "content-box"), ("width", "100px"), ("padding-left", "8px")))));
            Assert.AreEqual("box-sizing", e.Property);
        }

        [Test]
        public void CssDefaults_ContentBoxWithBorderOnSizedElement_Throws()
        {
            Assert.Throws<UnsupportedStyleException>(() =>
                Lowering.Apply(WithChildren(Node("p"), Node("a", ("box-sizing", "content-box"), ("height", "100px"), ("border-top-width", "2px")))));
        }

        [Test]
        public void CssDefaults_ContentBoxWithoutPaddingOrBorder_IsRemoved()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("a", ("box-sizing", "content-box"), ("width", "100px"))));
            Assert.IsFalse(B(r.Children[0]).ContainsKey("box-sizing"));
        }

        [Test]
        public void CssDefaults_WrappingFlex_AlignContentStretch()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("flex-wrap", "wrap")), Node("a")));
            Assert.AreEqual("stretch", B(r)["align-content"]);
        }

        [Test]
        public void CssDefaults_AlignContentNormal_BecomesStretch()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("flex-wrap", "wrap"), ("align-content", "normal")), Node("a")));
            Assert.AreEqual("stretch", B(r)["align-content"]);
        }

        [Test]
        public void CssDefaults_PointerEventsNone_SetsPickingIgnore()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("a", ("pointer-events", "none")), Node("b", ("pointer-events", "auto")), Node("c")));
            Assert.IsTrue(r.Children[0].PickingIgnore);
            Assert.IsFalse(B(r.Children[0]).ContainsKey("pointer-events"));
            Assert.IsFalse(r.Children[1].PickingIgnore);
            Assert.IsFalse(B(r.Children[1]).ContainsKey("pointer-events"));
            Assert.IsFalse(r.Children[2].PickingIgnore);
        }

        [Test]
        public void CssDefaults_NonBaseLayerRestrictions_Throw()
        {
            foreach (var (k, v) in new[] { ("z-index", "2"), ("box-shadow", "0 1px 2px red"), ("pointer-events", "none"), ("position", "absolute") })
            {
                var a = Node("a");
                a.Style["hover"] = Layer((k, v));
                Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(WithChildren(Node("p"), a)), k);
            }
        }

        [Test]
        public void CssDefaults_NonBaseDisplayNone_IsAllowed()
        {
            var a = Node("a");
            a.Style["state:loading"] = Layer(("display", "none"));
            Assert.DoesNotThrow(() => Lowering.Apply(WithChildren(Node("p"), a)));
        }

        [Test]
        public void Shadow_OnRoot_Throws()
        {
            var root = Node("root");
            root.Shadow = Shadow(0, 8, 0, 0);
            Assert.Throws<IrFormatException>(() => Lowering.Apply(root));
        }

        // ---- paint order -----------------------------------------------------------------------------------

        [Test]
        public void PaintOrder_NegativeZFirst_ThenInFlow_ThenAbsoluteByZ()
        {
            var r = Lowering.Apply(WithChildren(Node("p"),
                Node("hi", ("position", "absolute"), ("z-index", "2")),
                Node("flow1"),
                Node("neg", ("position", "absolute"), ("z-index", "-1")),
                Node("lo", ("position", "absolute"), ("z-index", "1")),
                Node("flow2"),
                Node("auto", ("position", "absolute"))));
            CollectionAssert.AreEqual(new[] { "neg", "flow1", "flow2", "auto", "lo", "hi" }, Ids(r));
            Assert.IsFalse(B(r.Children.Single(c => c.Id == "hi")).ContainsKey("z-index"));
        }

        [Test]
        public void PaintOrder_AbsoluteDecorationBeforeContent_PaintsAboveContent()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("decoration", ("position", "absolute")), Node("content")));
            CollectionAssert.AreEqual(new[] { "content", "decoration" }, Ids(r));
        }

        [Test]
        public void PaintOrder_EqualZ_KeepsDocumentOrder()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("a", ("position", "absolute"), ("z-index", "1")), Node("b", ("position", "absolute"), ("z-index", "1"))));
            CollectionAssert.AreEqual(new[] { "a", "b" }, Ids(r));
        }

        [Test]
        public void PaintOrder_ZIndexOnInFlowElement_Throws()
        {
            Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(Node("p"), Node("a", ("z-index", "3")))));
        }

        [Test]
        public void PaintOrder_ZIndexAuto_IsAcceptedEverywhere()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("a", ("z-index", "auto")), Node("b", ("position", "relative"), ("z-index", "auto")), Node("c", ("position", "absolute"), ("z-index", "auto"))));
            CollectionAssert.AreEqual(new[] { "a", "b", "c" }, Ids(r));
            foreach (var c in r.Children) Assert.IsFalse(B(c).ContainsKey("z-index"));
        }

        [Test]
        public void PaintOrder_RelativeContentWithPositiveZ_AfterStatics_IsAccepted()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("bg"), Node("content", ("position", "relative"), ("z-index", "1"))));
            CollectionAssert.AreEqual(new[] { "bg", "content" }, Ids(r));
            Assert.IsFalse(B(r.Children[1]).ContainsKey("z-index"));
        }

        [Test]
        public void PaintOrder_RelativePositiveZBeforeAStatic_NeedsReordering_Throws()
        {
            Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(Node("p"), Node("content", ("position", "relative"), ("z-index", "1")), Node("bg"))));
        }

        [Test]
        public void PaintOrder_RelativeNegativeZFirst_IsAccepted_AfterAStatic_Throws()
        {
            var ok = Lowering.Apply(WithChildren(Node("p"), Node("under", ("position", "relative"), ("z-index", "-1")), Node("flow")));
            CollectionAssert.AreEqual(new[] { "under", "flow" }, Ids(ok));
            Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(Node("p"), Node("flow"), Node("under", ("position", "relative"), ("z-index", "-1")))));
        }

        [Test]
        public void PaintOrder_AbsoluteZAmongRelativeZ_FollowsCssOrder()
        {
            var r = Lowering.Apply(WithChildren(Node("p"),
                Node("abs1", ("position", "absolute"), ("z-index", "1")),
                Node("flow"),
                Node("rel2", ("position", "relative"), ("z-index", "2")),
                Node("abs3", ("position", "absolute"), ("z-index", "3"))));
            CollectionAssert.AreEqual(new[] { "flow", "abs1", "rel2", "abs3" }, Ids(r));
        }

        [Test]
        public void PaintOrder_AbsoluteNegativeAfterLeadingNegativeRelative()
        {
            var r = Lowering.Apply(WithChildren(Node("p"),
                Node("absNeg", ("position", "absolute"), ("z-index", "-1")),
                Node("relNeg", ("position", "relative"), ("z-index", "-2")),
                Node("flow")));
            CollectionAssert.AreEqual(new[] { "relNeg", "absNeg", "flow" }, Ids(r));
        }

        [Test]
        public void PaintOrder_InFlowOrderUnchanged()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("a"), Node("x", ("position", "absolute")), Node("b"), Node("c")));
            CollectionAssert.AreEqual(new[] { "a", "b", "c", "x" }, Ids(r));
        }

        // ---- shadow host -----------------------------------------------------------------------------------

        static IrNode Hosted(IrNode el, IrNode parent = null)
        {
            var r = Lowering.Apply(WithChildren(parent ?? Node("p"), el));
            return r;
        }

        [Test]
        public void Shadow_HostTakesTheSlot_ContainingShadowThenElement()
        {
            var card = Node("card", ("width", "600px"), ("height", "300px"));
            card.Shadow = Shadow(-20, -12, 40, 40);
            var r = Lowering.Apply(WithChildren(Node("p"), Node("before"), card, Node("after")));
            CollectionAssert.AreEqual(new[] { "before", "card__shadowhost", "after" }, Ids(r));
            var host = r.Children[1];
            CollectionAssert.AreEqual(new[] { "card__shadow", "card" }, Ids(host));
            Assert.AreEqual("column", B(host)["flex-direction"]);
            Assert.IsNull(host.Children[1].Shadow);
        }

        [Test]
        public void Shadow_IsAbsoluteWithInsets_FollowingTheElementSize()
        {
            var card = Node("card", ("width", "600px"), ("height", "300px"));
            card.Shadow = Shadow(-20, -12, 40, 40);
            var s = Hosted(card).Children[0].Children[0];
            Assert.AreEqual("image", s.Kind);
            Assert.AreEqual("shadow9", s.Asset.Kind);
            Assert.AreEqual("absolute", B(s)["position"]);
            Assert.AreEqual("-20px", B(s)["left"]);
            Assert.AreEqual("-12px", B(s)["top"]);
            Assert.AreEqual("-20px", B(s)["right"]);
            Assert.AreEqual("-28px", B(s)["bottom"]);
            Assert.IsFalse(B(s).ContainsKey("width"));
            Assert.IsTrue(s.PickingIgnore);
        }

        [Test]
        public void Shadow_BelowOffset_ZeroWidthDelta()
        {
            var card = Node("card");
            card.Shadow = Shadow(0, 8, 0, 0);
            var s = Hosted(card).Children[0].Children[0];
            Assert.AreEqual("0px", B(s)["left"]);
            Assert.AreEqual("8px", B(s)["top"]);
            Assert.AreEqual("0px", B(s)["right"]);
            Assert.AreEqual("-8px", B(s)["bottom"]);
        }

        [Test]
        public void Shadow_PlacementPropertiesMoveToHost_AppearanceStays()
        {
            var card = Node("card", ("position", "absolute"), ("right", "10px"), ("bottom", "20px"), ("width", "50%"), ("height", "auto"),
                ("margin-top", "6px"), ("flex-grow", "2"), ("align-self", "center"), ("opacity", "0.5"), ("translate", "-50% -50%"),
                ("rotate", "3deg"), ("scale", "1.1"), ("aspect-ratio", "2"), ("min-width", "10px"),
                ("padding-left", "8px"), ("background-color", "#102030"), ("border-top-left-radius", "24px"), ("overflow", "hidden"), ("color", "#fff"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            var el = host.Children[1];
            foreach (var k in new[] { "position", "right", "bottom", "width", "height", "margin-top", "flex-grow", "align-self", "opacity", "translate", "rotate", "scale", "aspect-ratio", "min-width" })
            {
                Assert.IsTrue(B(host).ContainsKey(k), "host " + k);
                if (k != "flex-grow") Assert.IsFalse(B(el).ContainsKey(k), "element " + k);
            }
            Assert.AreEqual("2", B(host)["flex-grow"]);
            Assert.AreEqual("1", B(el)["flex-grow"]);
            foreach (var k in new[] { "padding-left", "background-color", "border-top-left-radius", "overflow", "color" })
                Assert.IsTrue(B(el).ContainsKey(k), "element " + k);
        }

        [Test]
        public void Shadow_AllDisplayValuesMoveToTheHost_FlexElementKeepsOnlyItsBaseFlex()
        {
            var card = Node("card", ("display", "flex"));
            card.Style["state:loading"] = Layer(("display", "none"), ("opacity", "0.4"), ("background-color", "#000000"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            var el = host.Children[1];
            Assert.AreEqual("flex", B(el)["display"]);
            Assert.AreEqual("flex", B(host)["display"]);
            Assert.AreEqual("none", host.Style["state:loading"]["display"]);
            Assert.AreEqual("0.4", host.Style["state:loading"]["opacity"]);
            Assert.AreEqual("#000000", el.Style["state:loading"]["background-color"]);
            Assert.IsFalse(el.Style["state:loading"].ContainsKey("opacity"));
        }

        [Test]
        public void Shadow_DialogHiddenInBaseShownInAState_IsVisibleThere_AndTheSiblingGetsTheGap()
        {
            var dialog = WithChildren(Node("dialog", ("display", "none"), ("width", "400px")), Node("title"));
            dialog.Style["state:error"] = Layer(("display", "flex"));
            dialog.Shadow = Shadow(0, 8, 0, 0);
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "10px")), dialog, Node("b")));
            var host = r.Children[0];
            Assert.AreEqual("dialog__shadowhost", host.Id);
            Assert.AreEqual("none", B(host)["display"]);
            Assert.AreEqual("flex", host.Style["state:error"]["display"]);
            var el = host.Children[1];
            Assert.AreEqual("flex", B(el)["display"], "the host hides it; the element keeps its flex rules");
            Assert.IsFalse(el.Style.ContainsKey("state:error") && el.Style["state:error"].ContainsKey("display"));
            Assert.IsFalse(B(r.Children[1]).ContainsKey("margin-left"));
            Assert.AreEqual("10px", r.Children[1].Style["state:error"]["margin-left"]);
        }

        [Test]
        public void Shadow_BlockStateRoot_ShownInAState_HostShowsWithFlex()
        {
            var empty = WithChildren(Node("empty", ("display", "none")), Node("a"));
            empty.Style["state:empty"] = Layer(("display", "block"));
            empty.Shadow = Shadow(0, 8, 0, 0);
            var host = Lowering.Apply(WithChildren(Node("p"), empty)).Children[0];
            Assert.AreEqual("flex", host.Style["state:empty"]["display"]);
            Assert.AreEqual("column", B(host.Children[1])["flex-direction"]);
        }

        [Test]
        public void Shadow_PseudoStateLayers_BecomeHostClassLayers_ElementKeepsItsOwn()
        {
            var card = Node("card");
            card.Action = "open";
            card.Style["hover"] = Layer(("translate", "0 -4px"), ("background-color", "#222222"));
            card.Style["active"] = Layer(("scale", "0.98"), ("background-color", "#111111"));
            card.Style["focus"] = Layer(("opacity", "0.9"));
            card.Style["checked"] = Layer(("rotate", "2deg"));
            card.Style["disabled"] = Layer(("opacity", "0.4"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            var el = host.Children[1];
            Assert.AreEqual("0 -4px", host.Style["class:dui-hover"]["translate"]);
            Assert.AreEqual("0.98", host.Style["class:dui-active"]["scale"]);
            Assert.AreEqual("0.9", host.Style["class:dui-focus"]["opacity"]);
            Assert.AreEqual("2deg", host.Style["class:dui-checked"]["rotate"]);
            Assert.AreEqual("0.4", host.Style["class:dui-disabled"]["opacity"]);
            foreach (var k in new[] { "hover", "active", "focus", "checked", "disabled" }) Assert.IsFalse(host.Style.ContainsKey(k), k);
            Assert.AreEqual("#222222", el.Style["hover"]["background-color"]);
            Assert.AreEqual("#111111", el.Style["active"]["background-color"]);
            Assert.IsFalse(el.Style["hover"].ContainsKey("translate"));
            Assert.IsFalse(el.Style.ContainsKey("focus"));
            Assert.IsTrue(host.MirrorPseudoState);
            Assert.IsFalse(host.Clickable);
            Assert.IsTrue(el.Clickable);
        }

        [Test]
        public void Shadow_PseudoStateWithoutMovedProperties_NeedsNoMirror()
        {
            var card = Node("card");
            card.Style["hover"] = Layer(("background-color", "#222222"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            Assert.IsFalse(host.MirrorPseudoState);
            Assert.AreEqual("#222222", host.Children[1].Style["hover"]["background-color"]);
        }

        [Test]
        public void Shadow_BreakpointAndStateLayers_MoveWithTheirOwnNames()
        {
            var card = Node("card");
            card.Style["bp:narrow"] = Layer(("margin-top", "4px"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            Assert.AreEqual("4px", host.Style["bp:narrow"]["margin-top"]);
            Assert.IsFalse(host.MirrorPseudoState);
        }

        [Test]
        public void Shadow_ElementWithOnlyAMovedActiveLayer_KeepsItsClickable_HostNeverIs()
        {
            var card = Node("card");
            card.Style["active"] = Layer(("scale", "0.98"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            Assert.IsFalse(host.Clickable);
            Assert.IsTrue(host.Children[1].Clickable, "same as without a shadow");
            Assert.IsFalse(host.Children[1].Style.ContainsKey("active"));
            Assert.AreEqual("0.98", host.Style["class:dui-active"]["scale"]);
            Assert.IsTrue(host.MirrorPseudoState);
        }

        [Test]
        public void Transitions_LeaveTheStyleLayers_AndAreRecordedForThePlayer()
        {
            var a = Node("a", ("transition", "opacity 0.2s ease"), ("transition-property", "opacity"), ("transition-duration", "0.2s"));
            a.Style["hover"] = Layer(("transition-delay", "0.1s"), ("opacity", "0.5"));
            var r = Lowering.Apply(WithChildren(Node("p"), a)).Children[0];
            Assert.IsFalse(B(r).ContainsKey("transition"));
            Assert.IsFalse(B(r).ContainsKey("transition-property"));
            Assert.IsFalse(r.Style["hover"].ContainsKey("transition-delay"));
            Assert.AreEqual("opacity 0.2s ease", r.Transitions["base"]["transition"]);
            Assert.AreEqual("0.1s", r.Transitions["hover"]["transition-delay"]);
            Assert.DoesNotThrow(() => StyleMapper.Map(B(r), B(r), false, true));
        }

        [Test]
        public void Shadow_TransitionOfMovedProperties_MovesToHostRecord()
        {
            var card = Node("card", ("transition-property", "opacity, background-color"), ("transition-duration", "0.2s, 0.3s"), ("transition-timing-function", "ease, linear"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            var el = host.Children[1];
            Assert.AreEqual("opacity", host.Transitions["base"]["transition-property"]);
            Assert.AreEqual("0.2s", host.Transitions["base"]["transition-duration"]);
            Assert.AreEqual("ease", host.Transitions["base"]["transition-timing-function"]);
            Assert.AreEqual("background-color", el.Transitions["base"]["transition-property"]);
            Assert.AreEqual("0.3s", el.Transitions["base"]["transition-duration"]);
            Assert.AreEqual("linear", el.Transitions["base"]["transition-timing-function"]);
        }

        [Test]
        public void Shadow_TransitionShorthand_MovedEntriesGoToHost_EasingFirstEntriesParse()
        {
            var card = Node("card", ("transition", "ease-in 0.2s opacity, linear 0.3s background-color"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            Assert.AreEqual("ease-in 0.2s opacity", host.Transitions["base"]["transition"]);
            Assert.AreEqual("linear 0.3s background-color", host.Children[1].Transitions["base"]["transition"]);
        }

        [Test]
        public void Shadow_TransitionEntryWithAllowDiscreteFirst_MovesWithItsProperty()
        {
            var card = Node("card", ("transition", "allow-discrete opacity 0.2s, normal background-color 0.3s"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            Assert.AreEqual("allow-discrete opacity 0.2s", host.Transitions["base"]["transition"]);
            Assert.AreEqual("normal background-color 0.3s", host.Children[1].Transitions["base"]["transition"]);
        }

        [Test]
        public void Shadow_TransitionOfOnlyMovedProperties_LeavesNoTransitionOnElement()
        {
            var card = Node("card", ("transition-property", "opacity"), ("transition-duration", "0.2s"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var el = Hosted(card).Children[0].Children[1];
            Assert.IsFalse(el.Transitions.ContainsKey("base"));
        }

        [Test]
        public void Shadow_GapMarginAndZOrder_LandOnTheHost()
        {
            var card = Node("card", ("position", "absolute"), ("z-index", "2"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var flow = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "10px")), Node("a"), Node("b")));
            Assert.AreEqual("10px", B(flow.Children[1])["margin-left"]);

            var el = Node("card2");
            el.Shadow = Shadow(0, 8, 0, 0);
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "10px")), Node("a"), el));
            Assert.AreEqual("card2__shadowhost", r.Children[1].Id);
            Assert.AreEqual("10px", B(r.Children[1])["margin-left"]);
            Assert.IsFalse(B(r.Children[1].Children[1]).ContainsKey("margin-left"));

            var z = Lowering.Apply(WithChildren(Node("p"), card, Node("flow")));
            CollectionAssert.AreEqual(new[] { "flow", "card__shadowhost" }, Ids(z));
            Assert.IsFalse(B(z.Children[1]).ContainsKey("z-index"));
        }

        [Test]
        public void Shadow_OnInFlowElementWithZIndex_Throws()
        {
            var el = Node("card", ("z-index", "1"));
            el.Shadow = Shadow(0, 8, 0, 0);
            Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(Node("p"), el)));
        }

        [Test]
        public void Shadow_NestedShadowedElementInsideHost_IsLowered()
        {
            var inner = Node("inner");
            inner.Shadow = Shadow(0, 4, 0, 0);
            var outer = WithChildren(Node("outer"), inner);
            outer.Shadow = Shadow(0, 8, 0, 0);
            var r = Lowering.Apply(WithChildren(Node("p"), outer));
            Assert.AreEqual("inner__shadowhost", r.Children[0].Children[1].Children[0].Id);
        }

        // ---- visible display -------------------------------------------------------------------------------

        [Test]
        public void Display_BaseHiddenStateShown_Flex_Compiles_AndWritesFlexInTheStateLayer()
        {
            var spinner = WithChildren(Node("spinner", ("display", "none")), Node("dot"), Node("dot2"));
            spinner.Style["state:loading"] = Layer(("display", "flex"), ("gap", "6px"));
            var r = Lowering.Apply(WithChildren(Node("screen"), spinner)).Children[0];
            Assert.AreEqual("none", B(r)["display"]);
            Assert.AreEqual("flex", r.Style["state:loading"]["display"]);
            Assert.AreEqual("row", B(r)["flex-direction"]);
            Assert.AreEqual("6px", r.Children[1].Style["state:loading"]["margin-left"]);
        }

        [Test]
        public void Display_BaseHiddenStateShownBlock_BecomesColumnWithFlexInTheLayer()
        {
            var empty = WithChildren(Node("empty", ("display", "none")), Node("a"), Node("b"));
            empty.Style["state:empty"] = Layer(("display", "block"));
            var r = Lowering.Apply(WithChildren(Node("screen"), empty)).Children[0];
            Assert.AreEqual("none", B(r)["display"]);
            Assert.AreEqual("flex", r.Style["state:empty"]["display"]);
            Assert.AreEqual("column", B(r)["flex-direction"]);
            Assert.AreEqual("0", B(r.Children[0])["flex-shrink"]);
        }

        [Test]
        public void Display_MissingBase_FlexLayer_ThrowsLikeExplicitBlock()
        {
            var absent = WithChildren(Node("a"), Node("x"));
            absent.Style["bp:narrow"] = Layer(("display", "flex"));
            Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(WithChildren(Node("screen"), absent)));
            var explicitBlock = WithChildren(Node("a", ("display", "block")), Node("x"));
            explicitBlock.Style["bp:narrow"] = Layer(("display", "flex"));
            Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(WithChildren(Node("screen"), explicitBlock)));
        }

        [Test]
        public void Display_MissingBase_NoneLayer_IsStillBlock()
        {
            var a = WithChildren(Node("a"), Node("x"));
            a.Style["state:loading"] = Layer(("display", "none"));
            var r = Lowering.Apply(WithChildren(Node("screen"), a)).Children[0];
            Assert.AreEqual("column", B(r)["flex-direction"]);
        }

        [Test]
        public void Display_LayersSwitchingBetweenFlexAndBlock_Throw()
        {
            var a = Node("a", ("display", "flex"));
            a.Style["state:x"] = Layer(("display", "block"));
            Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(WithChildren(Node("screen"), a)));
        }

        [Test]
        public void Display_RedundantBlockInALayer_IsRemoved()
        {
            var a = Node("a");
            a.Style["bp:narrow"] = Layer(("display", "block"));
            var r = Lowering.Apply(WithChildren(Node("screen"), a)).Children[0];
            Assert.IsFalse(r.Style["bp:narrow"].ContainsKey("display"));
        }

        [Test]
        public void Display_InlineFlexAndInlineBlock_AreBlockified()
        {
            var inlineFlex = WithChildren(Node("f", ("display", "inline-flex")), Node("x"), Node("y"));
            var inlineBlock = WithChildren(Node("b", ("display", "inline-block")), Node("x"));
            var r = Lowering.Apply(WithChildren(Flex("p", "row"), inlineFlex, inlineBlock));
            Assert.AreEqual("flex", B(r.Children[0])["display"]);
            Assert.AreEqual("row", B(r.Children[0])["flex-direction"]);
            Assert.IsFalse(B(r.Children[1]).ContainsKey("display"));
            Assert.AreEqual("column", B(r.Children[1])["flex-direction"]);
            Assert.DoesNotThrow(() => StyleMapper.Map(B(r.Children[0]), B(r.Children[0]), false, true));
        }

        [TestCase("inline-flex")]
        [TestCase("inline-block")]
        [TestCase("inline")]
        public void Display_InlineLevelChildOfBlockContainer_Throws_NamingTheElement(string display)
        {
            var e = Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(WithChildren(Node("card"), Node("tag", ("display", display)))));
            StringAssert.Contains("tag", e.Message);
        }

        [Test]
        public void Display_InlineChildOfFlexContainer_IsBlock()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "row"), Node("i", ("display", "inline"))));
            Assert.IsFalse(B(r.Children[0]).ContainsKey("display"));
        }

        [Test]
        public void Gap_ChildHiddenInBaseAndShownInALayer_GapMovesToTheNextChildInThatLayer()
        {
            var a = Node("a", ("display", "none"));
            a.Style["state:loading"] = Layer(("display", "flex"));
            var r = Lowering.Apply(WithChildren(Flex("p", "row", ("gap", "10px")), a, Node("b")));
            Assert.IsFalse(B(r.Children[1]).ContainsKey("margin-left"));
            Assert.AreEqual("10px", r.Children[1].Style["state:loading"]["margin-left"]);
        }

        // ---- positioned siblings and containing block -------------------------------------------------------

        [Test]
        public void PaintOrder_AbsoluteBackgroundBeforeRelativeContent_StaysBelowIt()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("bg", ("position", "absolute")), Node("content", ("position", "relative"))));
            CollectionAssert.AreEqual(new[] { "bg", "content" }, Ids(r));
        }

        [Test]
        public void PaintOrder_AbsoluteAfterRelative_StaysAfter()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("content", ("position", "relative")), Node("overlay", ("position", "absolute"))));
            CollectionAssert.AreEqual(new[] { "content", "overlay" }, Ids(r));
        }

        [Test]
        public void PaintOrder_AbsoluteBetweenRelativeAndStatic_CannotBeReproduced_Throws_NamingThem()
        {
            // CSS: tail (in flow), bg, content (positioned, tree order); the layout order content, tail leaves bg no slot
            var e = Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(Node("p"),
                Node("bg", ("position", "absolute")), Node("content", ("position", "relative")), Node("tail"))));
            foreach (var id in new[] { "bg", "content", "tail" }) StringAssert.Contains("'" + id + "'", e.Message);
        }

        [Test]
        public void PaintOrder_StaticSiblingsBecomeRelativeAfterOrdering()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("a", ("position", "static"))));
            Assert.AreEqual("relative", B(r.Children[0])["position"]);
        }

        [Test]
        public void Absolute_InUnpositionedParent_Throws_NamingBoth()
        {
            var card = WithChildren(Node("card"), Node("badge", ("position", "absolute")));
            var e = Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(WithChildren(Node("screen"), card)));
            StringAssert.Contains("badge", e.Message);
            StringAssert.Contains("position: relative", e.Message);
        }

        [TestCase("relative")]
        [TestCase("absolute")]
        public void Absolute_InPositionedParent_IsAccepted(string position)
        {
            var card = WithChildren(Node("card", ("position", position)), Node("badge", ("position", "absolute")));
            Assert.DoesNotThrow(() => Lowering.Apply(WithChildren(Node("screen"), card)));
        }

        [Test]
        public void Absolute_ChildOfRoot_IsExempt()
        {
            Assert.DoesNotThrow(() => Lowering.Apply(WithChildren(Node("screen"), Node("badge", ("position", "absolute")))));
        }

        // ---- pointer-events ---------------------------------------------------------------------------------

        [Test]
        public void PointerEventsNone_IsInheritedUntilAuto_AndReachesTheShadowHost()
        {
            var inner = Node("inner", ("pointer-events", "auto"));
            var icon = WithChildren(Node("icon"), inner);
            var card = Node("card", ("pointer-events", "none"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var overlay = WithChildren(Node("overlay", ("pointer-events", "none")), Node("label"), icon, card);
            var r = Lowering.Apply(WithChildren(Node("p"), overlay)).Children[0];
            Assert.IsTrue(r.PickingIgnore);
            Assert.IsTrue(r.Children[0].PickingIgnore);
            Assert.IsTrue(r.Children[1].PickingIgnore);
            Assert.IsFalse(r.Children[1].Children[0].PickingIgnore);
            var host = r.Children[2];
            Assert.AreEqual("card__shadowhost", host.Id);
            Assert.IsTrue(host.PickingIgnore);
            Assert.IsTrue(host.Children[0].PickingIgnore);
        }

        // ---- shadowed flex text alignment ------------------------------------------------------------------

        static IrNode Text(string id, params (string k, string v)[] style)
        {
            var n = Node(id, style);
            n.Kind = "text";
            return n;
        }

        /// <summary>The -unity-text-align that applies to the lowered element in a layer: the layer's own, else base's.</summary>
        static string EffectiveTextAlign(IrNode el, string layer)
        {
            string Of(string name) => el.Style.TryGetValue(name, out var l)
                ? StyleMapper.Map(l, B(el), true, name == "base").Where(d => d.Property == "-unity-text-align").Select(d => d.Value).FirstOrDefault()
                : null;
            return (layer == "base" ? null : Of(layer)) ?? Of("base");
        }

        static IrNode LowerText(IrNode text, bool shadowed)
        {
            if (shadowed) text.Shadow = Shadow(0, 4, 0, 0);
            var r = Lowering.Apply(WithChildren(Flex("row", "row"), text)).Children[0];
            if (!shadowed) return r;
            Assert.AreEqual(text.Id + "__shadowhost", r.Id);
            return r.Children[1];
        }

        [TestCase(false)]
        [TestCase(true)]
        public void TextAlign_AvatarWithCentredInitials_IsMiddleCenter_WithAndWithoutShadow(bool shadowed)
        {
            var avatar = Text("avatar", ("display", "flex"), ("align-items", "center"), ("justify-content", "center"), ("width", "40px"), ("height", "40px"));
            Assert.AreEqual("middle-center", EffectiveTextAlign(LowerText(avatar, shadowed), "base"));
        }

        [TestCase(false)]
        [TestCase(true)]
        public void TextAlign_PillWithTextAlignCenter_IsMiddleCenter_WithAndWithoutShadow(bool shadowed)
        {
            var pill = Text("pill", ("display", "flex"), ("align-items", "center"), ("text-align", "center"), ("height", "28px"));
            Assert.AreEqual("middle-center", EffectiveTextAlign(LowerText(pill, shadowed), "base"));
        }

        [Test]
        public void TextAlign_ShadowedAndPlainFlexText_MapIdentically()
        {
            IrNode Make(string id) => Text(id, ("display", "flex"), ("align-items", "flex-end"), ("justify-content", "space-between"), ("text-align", "right"));
            var plain = LowerText(Make("a"), false);
            var shadowed = LowerText(Make("b"), true);
            Assert.AreEqual(EffectiveTextAlign(plain, "base"), EffectiveTextAlign(shadowed, "base"));
            Assert.IsNotNull(EffectiveTextAlign(plain, "base"));
        }

        [TestCase(false)]
        [TestCase(true)]
        public void TextAlign_ShadowedTextStateRoot_IsMiddleCenterInTheStateThatShowsIt(bool shadowed)
        {
            var toast = Text("toast", ("display", "none"), ("align-items", "center"), ("justify-content", "center"));
            toast.Style["state:saved"] = Layer(("display", "flex"));
            var el = LowerText(toast, shadowed);
            Assert.AreEqual("middle-center", EffectiveTextAlign(el, "state:saved"));
        }

        [Test]
        public void Shadow_BlockText_KeepsNoDisplay_AndPlainTextAlign()
        {
            var label = Text("label", ("text-align", "center"));
            var el = LowerText(label, true);
            Assert.IsFalse(B(el).ContainsKey("display"));
            Assert.AreEqual("upper-center", EffectiveTextAlign(el, "base"));
        }

        // ---- absolutely positioned inline-level children are blockified ------------------------------------

        [TestCase("inline-flex", "flex")]
        [TestCase("inline-block", null)]
        [TestCase("inline", null)]
        public void Display_AbsoluteInlineLevelChildOfBlockContainer_IsBlockified(string display, string expected)
        {
            var badge = WithChildren(Node("badge", ("position", "absolute"), ("display", display), ("top", "0"), ("right", "0")), Node("count"), Node("icon"));
            var card = WithChildren(Node("card", ("position", "relative")), Node("title"), badge);
            var r = Lowering.Apply(WithChildren(Node("screen"), card)).Children[0];
            var b = r.Children.Single(c => c.Id == "badge");
            if (expected == null) Assert.IsFalse(B(b).ContainsKey("display"));
            else Assert.AreEqual(expected, B(b)["display"]);
            Assert.AreEqual(expected == "flex" ? "row" : "column", B(b)["flex-direction"]);
            Assert.AreEqual("0", B(b)["top"]);
            Assert.IsFalse(B(b).ContainsKey("flex-shrink"), "an absolute child is not a block child");
            Assert.DoesNotThrow(() => StyleMapper.Map(B(b), B(b), false, true));
        }

        [Test]
        public void Display_AbsoluteInlineBlockDot_WithoutChildren_IsLowered()
        {
            var dot = Node("dot", ("position", "absolute"), ("display", "inline-block"), ("width", "8px"), ("height", "8px"));
            var r = Lowering.Apply(WithChildren(Node("screen"), WithChildren(Node("card", ("position", "relative")), Node("title"), dot))).Children[0];
            Assert.IsFalse(B(r.Children.Single(c => c.Id == "dot")).ContainsKey("display"));
        }

        // ---- CSS stacking order among siblings -------------------------------------------------------------

        [Test]
        public void PaintOrder_AbsoluteAfterRelativeWithPositiveZ_PaintsBelowIt()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("content", ("position", "relative"), ("z-index", "1")), Node("glow", ("position", "absolute"))));
            CollectionAssert.AreEqual(new[] { "glow", "content" }, Ids(r));
        }

        [Test]
        public void PaintOrder_ZeroAbsoluteAfterRelativeWithPositiveZ_GoesBetweenStaticAndRelative()
        {
            var r = Lowering.Apply(WithChildren(Node("p"), Node("s"), Node("content", ("position", "relative"), ("z-index", "1")), Node("glow", ("position", "absolute"), ("z-index", "0"))));
            CollectionAssert.AreEqual(new[] { "s", "glow", "content" }, Ids(r));
        }

        [Test]
        public void PaintOrder_ShadowedRelativeContentWithPositiveZ_StaysAboveALaterAbsolute()
        {
            var content = Node("content", ("position", "relative"), ("z-index", "1"));
            content.Shadow = Shadow(0, 8, 0, 0);
            var r = Lowering.Apply(WithChildren(Node("p"), content, Node("glow", ("position", "absolute"))));
            CollectionAssert.AreEqual(new[] { "glow", "content__shadowhost" }, Ids(r));
        }

        [Test]
        public void PaintOrder_FullStackingOrder_AbsolutesInterleaveWithInFlowLevels()
        {
            var r = Lowering.Apply(WithChildren(Node("p"),
                Node("a1", ("position", "absolute"), ("z-index", "2")),
                Node("s1"),
                Node("a2", ("position", "absolute"), ("z-index", "-1")),
                Node("r1", ("position", "relative")),
                Node("a3", ("position", "absolute")),
                Node("r2", ("position", "relative"), ("z-index", "1")),
                Node("a4", ("position", "absolute"), ("z-index", "1")),
                Node("a5", ("position", "absolute"), ("z-index", "-3"))));
            // CSS: z<0 by z (a5, a2); in-flow non-positioned (s1); z auto/0 in tree order (r1, a3); z>0 by z then tree order (r2, a4, a1)
            CollectionAssert.AreEqual(new[] { "a5", "a2", "s1", "r1", "a3", "r2", "a4", "a1" }, Ids(r));
        }

        [Test]
        public void PaintOrder_RelativeAutoBeforeStatic_IsLeftInLayoutOrder()
        {
            // CSS paints s below r; only visible where they overlap, which lint checks from the captured boxes
            var r = Lowering.Apply(WithChildren(Node("p"), Node("r", ("position", "relative")), Node("s")));
            CollectionAssert.AreEqual(new[] { "r", "s" }, Ids(r));
        }

        [Test]
        public void PaintOrder_InFlowPositiveZBeforeStatic_Throws_NamingBoth()
        {
            var e = Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(Node("p"), Node("content", ("position", "relative"), ("z-index", "1")), Node("bg"))));
            StringAssert.Contains("'content'", e.Message);
            StringAssert.Contains("'bg'", e.Message);
        }

        [Test]
        public void PaintOrder_StaticFlexItemWithZIndex_StacksLikeRelative()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "row"),
                Node("item", ("z-index", "1")),
                Node("deco", ("position", "absolute"))));
            CollectionAssert.AreEqual(new[] { "deco", "item" }, Ids(r));
            Assert.IsFalse(B(r.Children[1]).ContainsKey("z-index"));
        }

        [Test]
        public void PaintOrder_StaticFlexItemsWithZIndexInLayoutOrder_AreAccepted()
        {
            var r = Lowering.Apply(WithChildren(Flex("p", "row"), Node("a"), Node("b", ("z-index", "1")), Node("c", ("z-index", "2"))));
            CollectionAssert.AreEqual(new[] { "a", "b", "c" }, Ids(r));
        }

        [Test]
        public void PaintOrder_StaticFlexItemZIndexNeedingAnotherLayoutOrder_Throws_NamingBoth()
        {
            var e = Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(Flex("p", "row"), Node("front", ("z-index", "2")), Node("back", ("z-index", "1")))));
            StringAssert.Contains("'front'", e.Message);
            StringAssert.Contains("'back'", e.Message);
        }

        [Test]
        public void PaintOrder_StaticFlexItemWithZeroZIndex_PaintsWithPositionedSiblings()
        {
            // z-index 0 makes a flex item stack at the positioned level: the earlier absolute stays below it
            var r = Lowering.Apply(WithChildren(Flex("p", "row"), Node("a"), Node("bg", ("position", "absolute")), Node("item", ("z-index", "0"))));
            CollectionAssert.AreEqual(new[] { "a", "bg", "item" }, Ids(r));
        }

        [Test]
        public void PaintOrder_StaticBlockChildWithZIndex_Throws_NamingIt()
        {
            var e = Assert.Throws<IrFormatException>(() => Lowering.Apply(WithChildren(Node("p"), Node("a"), Node("lifted", ("z-index", "2")))));
            StringAssert.Contains("'lifted'", e.Message);
        }

        // ---- clickable, sample -----------------------------------------------------------------------------

        [Test]
        public void Clickable_SetForActionButtonToggleAndActiveLayer()
        {
            var action = Node("a"); action.Action = "go";
            var btn = Node("b"); btn.Kind = "button";
            var tog = Node("t"); tog.Kind = "toggle";
            var act = Node("c"); act.Style["active"] = Layer(("opacity", "0.5"));
            var plain = Node("d");
            var r = Lowering.Apply(WithChildren(Node("p"), action, btn, tog, act, plain));
            CollectionAssert.AreEqual(new[] { true, true, true, true, false }, r.Children.Select(c => c.Clickable).ToArray());
        }

        [Test]
        public void Rejections_NameTheLintRuleThatRejectsTheSameDesign()
        {
            string RuleOf(System.Func<IrNode> design) => Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(design())).RuleId;

            Assert.AreEqual("U-CSS-035", RuleOf(() => WithChildren(Node("p"), WithChildren(Node("q", ("position", "static")), Node("a", ("position", "absolute"))))));
            Assert.AreEqual("U-CSS-035", RuleOf(() =>
            {
                var a = Node("a", ("position", "relative"));
                a.Style["hover"] = Layer(("position", "absolute"));
                return WithChildren(Node("p"), a);
            }));
            Assert.AreEqual("U-CSS-004", RuleOf(() =>
            {
                var a = Node("a", ("position", "relative"));
                a.Style["hover"] = Layer(("z-index", "2"));
                return WithChildren(Node("p"), a);
            }));
            Assert.AreEqual("U-CSS-036", RuleOf(() => WithChildren(Node("p"), Node("a", ("box-sizing", "content-box"), ("width", "10px"), ("padding-left", "2px")))));
            Assert.AreEqual("U-CSS-034", RuleOf(() =>
            {
                var a = Node("a", ("height", "4px"));
                a.Style["base"]["display"] = "none";
                a.Style["state:x"] = Layer(("display", "block"));
                a.Style["hover"] = Layer(("display", "block")); // shows itself by its own pseudo-state
                return WithChildren(Flex("p", "column", ("gap", "4px")), a, Node("b", ("height", "4px")));
            }));
        }

        [Test]
        public void Apply_Sample_LowersAndMapsEveryLayer()
        {
            var screen = IrReader.Read(IrReaderTests.SamplePath());
            var r = Lowering.Apply(screen.Root);
            Assert.IsTrue(r.Children.Any(c => c.Id == "card__shadowhost"));
            Assert.IsTrue(r.Children.Single(c => c.Id == "play").Clickable);
            Visit(r);
        }

        /// <summary>Maps every layer over its basis; a scroll area's or list's overflow is consumed by the compiler, not mapped.</summary>
        static void Visit(IrNode n)
        {
            foreach (var layer in n.Style)
            {
                var css = layer.Value;
                if (n.Kind == "scroll" || n.Kind == "list")
                    css = css.Where(kv => !kv.Key.StartsWith("overflow", System.StringComparison.Ordinal)).ToDictionary(kv => kv.Key, kv => kv.Value);
                var basis = layer.Key == "base" ? css : Lowering.Basis(n, layer.Key);
                Assert.DoesNotThrow(() => StyleMapper.Map(css, basis, n.Kind == "text", layer.Key == "base"), n.Id + "/" + layer.Key);
            }
            foreach (var c in n.Children) Visit(c);
        }
    }
}
