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

        [TestCase("gap", "4px")]
        [TestCase("flex-direction", "column")]
        [TestCase("flex-wrap", "wrap")]
        public void Gap_ParentPseudoStateChange_Throws(string prop, string value)
        {
            var p = Flex("p", "row", ("gap", "4px"));
            p.Style["hover"] = Layer((prop, value));
            Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(WithChildren(p, Node("a"), Node("b"))));
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
            Assert.DoesNotThrow(() => StyleMapper.Map(r.Style["base"], r.Style["base"], false));
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
            foreach (var (k, v) in new[] { ("z-index", "2"), ("box-shadow", "0 1px 2px red"), ("pointer-events", "none"), ("position", "absolute"), ("display", "flex") })
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
        public void Shadow_ElementDisplayFlex_StaysOnElement_DisplayNoneMovesToHost()
        {
            var card = Node("card", ("display", "flex"));
            card.Style["state:loading"] = Layer(("display", "none"), ("opacity", "0.4"), ("background-color", "#000000"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            var el = host.Children[1];
            Assert.AreEqual("flex", B(el)["display"]);
            Assert.IsFalse(B(host).ContainsKey("display"));
            Assert.AreEqual("none", host.Style["state:loading"]["display"]);
            Assert.AreEqual("0.4", host.Style["state:loading"]["opacity"]);
            Assert.AreEqual("#000000", el.Style["state:loading"]["background-color"]);
            Assert.IsFalse(el.Style["state:loading"].ContainsKey("opacity"));
        }

        [Test]
        public void Shadow_ElementLayerWithOnlyMovedProperties_IsRemovedFromElement()
        {
            var card = Node("card");
            card.Style["hover"] = Layer(("translate", "0 -4px"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            Assert.AreEqual("0 -4px", host.Style["hover"]["translate"]);
            Assert.IsFalse(host.Children[1].Style.ContainsKey("hover"));
            Assert.IsFalse(host.Clickable);
        }

        [Test]
        public void Shadow_ActiveLayerWithMovedProperties_GivesTheHostAClickable()
        {
            var card = Node("card");
            card.Style["active"] = Layer(("scale", "0.98"), ("background-color", "#111111"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            Assert.IsTrue(host.Clickable);
            Assert.AreEqual("0.98", host.Style["active"]["scale"]);
            Assert.AreEqual("#111111", host.Children[1].Style["active"]["background-color"]);
            Assert.IsTrue(host.Children[1].Clickable);
        }

        [Test]
        public void Shadow_ElementClickableWithOnlyMovedActiveLayer_IsNoLongerClickableItself()
        {
            var card = Node("card");
            card.Style["active"] = Layer(("scale", "0.98"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            Assert.IsTrue(host.Clickable);
            Assert.IsFalse(host.Children[1].Clickable);
        }

        [Test]
        public void Shadow_TransitionOfMovedProperties_MovesToHost()
        {
            var card = Node("card", ("transition-property", "opacity, background-color"), ("transition-duration", "0.2s, 0.3s"), ("transition-timing-function", "ease, linear"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            var el = host.Children[1];
            Assert.AreEqual("opacity", B(host)["transition-property"]);
            Assert.AreEqual("0.2s", B(host)["transition-duration"]);
            Assert.AreEqual("ease", B(host)["transition-timing-function"]);
            Assert.AreEqual("background-color", B(el)["transition-property"]);
            Assert.AreEqual("0.3s", B(el)["transition-duration"]);
            Assert.AreEqual("linear", B(el)["transition-timing-function"]);
        }

        [Test]
        public void Shadow_TransitionShorthand_MovedEntriesGoToHost()
        {
            var card = Node("card", ("transition", "opacity 0.2s ease, background-color 0.3s linear"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var host = Hosted(card).Children[0];
            Assert.AreEqual("opacity 0.2s ease", B(host)["transition"]);
            Assert.AreEqual("background-color 0.3s linear", B(host.Children[1])["transition"]);
        }

        [Test]
        public void Shadow_TransitionOfOnlyMovedProperties_LeavesNoTransitionOnElement()
        {
            var card = Node("card", ("transition-property", "opacity"), ("transition-duration", "0.2s"));
            card.Shadow = Shadow(0, 8, 0, 0);
            var el = Hosted(card).Children[0].Children[1];
            Assert.IsFalse(B(el).ContainsKey("transition-property"));
            Assert.IsFalse(B(el).ContainsKey("transition-duration"));
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
        public void Apply_Sample_LowersAndMapsEveryLayer()
        {
            var screen = IrReader.Read(IrReaderTests.SamplePath());
            var r = Lowering.Apply(screen.Root);
            Assert.IsTrue(r.Children.Any(c => c.Id == "card__shadowhost"));
            Assert.IsTrue(r.Children.Single(c => c.Id == "play").Clickable);
            Visit(r);
        }

        static void Visit(IrNode n)
        {
            foreach (var layer in n.Style)
                if (layer.Key != Lowering.FirstItemLayer)
                    Assert.DoesNotThrow(() => StyleMapper.Map(layer.Value, n.Style["base"], n.Kind == "text"), n.Id + "/" + layer.Key);
            foreach (var c in n.Children) Visit(c);
        }
    }
}
