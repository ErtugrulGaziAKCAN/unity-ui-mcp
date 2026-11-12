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
            var b = new Dictionary<string, string>();
            foreach (var (k, v) in style) b[k] = v;
            n.Style["base"] = b;
            return n;
        }

        static IrNode WithChildren(IrNode parent, params IrNode[] kids) { parent.Children = kids; return parent; }

        [Test]
        public void Gap_Row_BecomesMarginLeftOnChildrenTwoAndThree()
        {
            var root = WithChildren(Node("p", ("display", "flex"), ("flex-direction", "row"), ("gap", "12px")),
                Node("a"), Node("b"), Node("c"));
            var r = Lowering.Apply(root);
            Assert.IsFalse(r.Style["base"].ContainsKey("gap"));
            Assert.IsFalse(r.Children[0].Style["base"].ContainsKey("margin-left"));
            Assert.AreEqual("12px", r.Children[1].Style["base"]["margin-left"]);
            Assert.AreEqual("12px", r.Children[2].Style["base"]["margin-left"]);
            Assert.AreEqual("display: flex", "display: " + r.Style["base"]["display"]);
        }

        [Test]
        public void Gap_Column_BecomesMarginTop()
        {
            var root = WithChildren(Node("p", ("flex-direction", "column"), ("gap", "8px")), Node("a"), Node("b"));
            var r = Lowering.Apply(root);
            Assert.AreEqual("8px", r.Children[1].Style["base"]["margin-top"]);
            Assert.IsFalse(r.Children[0].Style["base"].ContainsKey("margin-top"));
        }

        [Test]
        public void Gap_TwoValueShorthand_UsesColumnGapForRow()
        {
            var root = WithChildren(Node("p", ("flex-direction", "row"), ("gap", "4px 20px")), Node("a"), Node("b"));
            var r = Lowering.Apply(root);
            Assert.AreEqual("20px", r.Children[1].Style["base"]["margin-left"]);
        }

        [Test]
        public void Gap_RowGapAndColumnGapLonghands_AreRemoved()
        {
            var root = WithChildren(Node("p", ("flex-direction", "column"), ("row-gap", "6px"), ("column-gap", "9px")), Node("a"), Node("b"));
            var r = Lowering.Apply(root);
            Assert.AreEqual("6px", r.Children[1].Style["base"]["margin-top"]);
            Assert.IsFalse(r.Style["base"].ContainsKey("row-gap"));
            Assert.IsFalse(r.Style["base"].ContainsKey("column-gap"));
        }

        [Test]
        public void Gap_AddsToExistingMarginAndSkipsAbsoluteChildren()
        {
            var b = Node("b", ("margin-left", "4px"));
            var abs = Node("abs", ("position", "absolute"));
            var root = WithChildren(Node("p", ("flex-direction", "row"), ("gap", "10px")), Node("a"), abs, b);
            var r = Lowering.Apply(root);
            Assert.IsFalse(r.Children[1].Style["base"].ContainsKey("margin-left"));
            Assert.AreEqual("14px", r.Children[2].Style["base"]["margin-left"]);
        }

        [Test]
        public void Gap_OnWrappingContainer_Throws()
        {
            var root = WithChildren(Node("p", ("flex-direction", "row"), ("flex-wrap", "wrap"), ("gap", "4px")), Node("a"), Node("b"));
            Assert.Throws<IrFormatException>(() => Lowering.Apply(root));
        }

        [Test]
        public void Gap_InBreakpointLayer_LowersIntoSameLayerOfChildren()
        {
            var root = WithChildren(Node("p", ("flex-direction", "row")), Node("a"), Node("b"));
            root.Style["bp:narrow"] = new Dictionary<string, string> { { "gap", "2px" }, { "flex-direction", "column" } };
            var r = Lowering.Apply(root);
            Assert.AreEqual("2px", r.Children[1].Style["bp:narrow"]["margin-top"]);
        }

        [Test]
        public void ZIndex_AbsoluteSiblings_AreReorderedAscending()
        {
            var a = Node("a", ("position", "absolute"), ("z-index", "2"));
            var b = Node("b", ("position", "absolute"), ("z-index", "1"));
            var flow = Node("f");
            var root = WithChildren(Node("p"), a, flow, b);
            var r = Lowering.Apply(root);
            CollectionAssert.AreEqual(new[] { "b", "f", "a" }, r.Children.Select(c => c.Id).ToArray());
            Assert.IsFalse(r.Children[0].Style["base"].ContainsKey("z-index"));
            Assert.IsFalse(r.Children[2].Style["base"].ContainsKey("z-index"));
        }

        [Test]
        public void ZIndex_Equal_KeepsDocumentOrder()
        {
            var root = WithChildren(Node("p"),
                Node("a", ("position", "absolute"), ("z-index", "1")),
                Node("b", ("position", "absolute"), ("z-index", "1")));
            var r = Lowering.Apply(root);
            CollectionAssert.AreEqual(new[] { "a", "b" }, r.Children.Select(c => c.Id).ToArray());
        }

        [Test]
        public void ZIndex_OnInFlowElement_Throws()
        {
            var root = WithChildren(Node("p"), Node("a", ("z-index", "3")));
            Assert.Throws<IrFormatException>(() => Lowering.Apply(root));
        }

        [Test]
        public void Shadow_InsertsAbsoluteSiblingBeforeElement()
        {
            var card = Node("card", ("position", "absolute"), ("left", "100px"), ("top", "50px"), ("width", "600px"), ("height", "300px"));
            card.Shadow = new IrShadow { Kind = "shadow9", File = "s.png", Sha256 = "x", Width = 96, Height = 96, Slice = new[] { 40, 40, 40, 40 },
                Offset = new BoxRect { X = -20, Y = -12, W = 40, H = 40 } };
            var root = WithChildren(Node("p"), Node("before"), card);
            var r = Lowering.Apply(root);
            CollectionAssert.AreEqual(new[] { "before", "card__shadow", "card" }, r.Children.Select(c => c.Id).ToArray());
            var s = r.Children[1];
            Assert.AreEqual("image", s.Kind);
            Assert.AreEqual("shadow9", s.Asset.Kind);
            Assert.AreEqual("absolute", s.Style["base"]["position"]);
            Assert.AreEqual("80px", s.Style["base"]["left"]);
            Assert.AreEqual("38px", s.Style["base"]["top"]);
            Assert.AreEqual("640px", s.Style["base"]["width"]);
            Assert.AreEqual("340px", s.Style["base"]["height"]);
            Assert.IsNull(r.Children[2].Shadow);
        }

        [Test]
        public void Shadow_OnInFlowElement_UsesOffsetAsLeftTopAndElementSize()
        {
            var card = Node("card", ("width", "600px"), ("height", "300px"));
            card.Shadow = new IrShadow { Kind = "shadow9", File = "s.png", Offset = new BoxRect { X = 0, Y = 8, W = 0, H = 0 } };
            var r = Lowering.Apply(WithChildren(Node("p"), card));
            var s = r.Children[0];
            Assert.AreEqual("card__shadow", s.Id);
            Assert.AreEqual("0px", s.Style["base"]["left"]);
            Assert.AreEqual("8px", s.Style["base"]["top"]);
            Assert.AreEqual("600px", s.Style["base"]["width"]);
        }

        [Test]
        public void Apply_DoesNotMutateInput()
        {
            var root = WithChildren(Node("p", ("flex-direction", "row"), ("gap", "12px")), Node("a"), Node("b"));
            Lowering.Apply(root);
            Assert.AreEqual("12px", root.Style["base"]["gap"]);
            Assert.IsFalse(root.Children[1].Style["base"].ContainsKey("margin-left"));
        }

        [Test]
        public void Clickable_SetForActionButtonToggleAndActiveLayer()
        {
            var action = Node("a"); action.Action = "go";
            var btn = Node("b"); btn.Kind = "button";
            var tog = Node("t"); tog.Kind = "toggle";
            var act = Node("c"); act.Style["active"] = new Dictionary<string, string> { { "opacity", "0.5" } };
            var plain = Node("d");
            var r = Lowering.Apply(WithChildren(Node("p"), action, btn, tog, act, plain));
            CollectionAssert.AreEqual(new[] { true, true, true, true, false }, r.Children.Select(c => c.Clickable).ToArray());
        }

        [Test]
        public void Apply_Sample_LowersWithoutError()
        {
            var screen = IrReader.Read(IrReaderTests.SamplePath());
            var r = Lowering.Apply(screen.Root);
            Assert.IsTrue(r.Children.Any(c => c.Id == "card__shadow"));
            Assert.IsTrue(r.Children.Single(c => c.Id == "play").Clickable);
        }
    }
}
