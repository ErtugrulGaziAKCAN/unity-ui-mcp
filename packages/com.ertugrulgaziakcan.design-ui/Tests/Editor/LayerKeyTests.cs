using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;

namespace DesignUi.Editor.Tests
{
    public class LayerKeyTests
    {
        static LayerKey K(string text) => LayerKey.Parse(text);

        [Test]
        public void Parse_ReadsEveryDimensionKind()
        {
            var k = K("bp:max-width-1919+state:loading+class:is-open+anc(row):class:is-selected+anc(card):hover+hover");
            CollectionAssert.AreEqual(
                new[] { LayerDimKind.Breakpoint, LayerDimKind.State, LayerDimKind.Class, LayerDimKind.Ancestor, LayerDimKind.Ancestor, LayerDimKind.Pseudo },
                k.Dims.Select(d => d.Kind).ToArray());
            Assert.AreEqual("max-width-1919", k.Dims[0].Name);
            Assert.AreEqual("card", k.Dims[3].AncestorId, "ancestors in ordinal order of their text");
            Assert.AreEqual("hover", k.Dims[3].Name);
            Assert.IsFalse(k.Dims[3].AncestorClass);
            Assert.AreEqual("row", k.Dims[4].AncestorId);
            Assert.AreEqual("is-selected", k.Dims[4].Name);
            Assert.IsTrue(k.Dims[4].AncestorClass);
            CollectionAssert.AreEqual(new[] { "card", "row" }, k.AncestorIds.ToArray());
            Assert.IsTrue(K("base").IsBase);
        }

        [Test]
        public void Parse_Canonicalises_IsCanonicalReportsTheOrder()
        {
            Assert.AreEqual("state:loading+hover", K("hover+state:loading").Text);
            Assert.AreEqual("bp:a+bp:b", K("bp:b+bp:a").Text);
            Assert.AreEqual("active+hover", K("hover+active").Text);
            Assert.IsTrue(LayerKey.IsCanonical("bp:narrow+anc(row):class:is-selected", out _));
            Assert.IsFalse(LayerKey.IsCanonical("hover+state:x", out var canonical));
            Assert.AreEqual("state:x+hover", canonical);
        }

        [TestCase("")]
        [TestCase("visited")]
        [TestCase("pseudo:hover")]
        [TestCase("bp:")]
        [TestCase("state:a(b)")]
        [TestCase("anc(card)hover")]
        [TestCase("anc():hover")]
        [TestCase("anc(card):visited")]
        [TestCase("anc(card):class:")]
        [TestCase("hover+")]
        [TestCase("hover+hover")]
        public void Parse_MalformedKeys_Throw(string text)
        {
            Assert.Throws<IrFormatException>(() => LayerKey.Parse(text));
        }

        [Test]
        public void SubsetUnionAndTranslation()
        {
            Assert.IsTrue(K("hover").IsSubsetOf(K("state:x+hover")));
            Assert.IsTrue(LayerKey.Base.IsSubsetOf(K("hover")));
            Assert.IsFalse(K("state:x+hover").IsSubsetOf(K("hover")));
            Assert.AreEqual("state:x+active+hover", K("active+hover").Union(K("state:x+hover")).Text);

            var parent = K("bp:n+class:is-open+anc(list):hover+active");
            Assert.AreEqual("bp:n+anc(list):hover+anc(p):active+anc(p):class:is-open", parent.Map(d => d.ToDescendant("p")).Text);
            var child = K("anc(p):class:is-open+anc(q):hover+focus");
            Assert.AreEqual("class:is-open+anc(q):hover", child.Map(d => d.ToAncestor("p")).Text, "the child's own focus says nothing about the parent");
        }

        [Test]
        public void Satisfiable_OneStateAtATime_OverlappingBreakpoints()
        {
            var bps = new Dictionary<string, IrBreakpoint>
            {
                { "narrow", new IrBreakpoint { Name = "narrow", MaxWidth = 1600 } },
                { "wide", new IrBreakpoint { Name = "wide", MinWidth = 1601 } },
                { "tall", new IrBreakpoint { Name = "tall", MaxAspect = 1.5f } },
            };
            Assert.IsFalse(K("state:a+state:b").Satisfiable(bps));
            Assert.IsFalse(K("bp:narrow+bp:wide").Satisfiable(bps));
            Assert.IsTrue(K("bp:narrow+bp:tall").Satisfiable(bps));
            Assert.IsTrue(K("bp:narrow+bp:unknown").Satisfiable(bps), "a breakpoint the screen does not list is assumed to overlap");
            Assert.IsTrue(K("state:a+hover+anc(x):active").Satisfiable(bps));
        }

        [Test]
        public void Specificity_CountsTheSelectorsSimpleParts()
        {
            Assert.AreEqual(1, LayerKey.Base.Specificity, ".s-x");
            Assert.AreEqual(2, K("hover").Specificity, ".s-x:hover");
            Assert.AreEqual(3, K("state:x+hover").Specificity, ".state-x .s-x:hover");
            Assert.AreEqual(3, K("anc(card):hover").Specificity, ".s-card:hover .s-x");
            Assert.AreEqual(4, K("anc(card):active+anc(card):hover").Specificity, ".s-card:active:hover .s-x");
            Assert.AreEqual(5, K("anc(a):hover+anc(b):hover").Specificity, ".s-a:hover .s-b:hover .s-x");
        }

        [Test]
        public void RuleOrder_BaseThenSinglesByKindThenPairs()
        {
            var keys = new[] { "state:x+hover", "active", "hover", "class:is-a", "anc(c):hover", "state:x", "bp:n", "base", "focus", "bp:n+state:x" }
                .Select(K).OrderBy(k => k, LayerKey.RuleOrder).Select(k => k.Text).ToArray();
            CollectionAssert.AreEqual(new[] { "base", "bp:n", "state:x", "class:is-a", "anc(c):hover", "hover", "focus", "active", "bp:n+state:x", "state:x+hover" }, keys);
            Assert.Greater(LayerKey.CascadeCompare(K("active"), K("hover")), 0, "active is written after hover");
            Assert.Greater(LayerKey.CascadeCompare(K("state:x+hover"), K("active")), 0, "more dimensions win");
        }

        [Test]
        public void UnionClosure_AddsEveryHoldingUnion_AndStopsAtTheLimit()
        {
            var bps = new Dictionary<string, IrBreakpoint>
            {
                { "narrow", new IrBreakpoint { Name = "narrow", MaxWidth = 1600 } },
                { "wide", new IrBreakpoint { Name = "wide", MinWidth = 1601 } },
            };
            var unions = LayerKey.UnionClosure(new[] { K("state:a"), K("state:b"), K("hover"), K("bp:narrow"), K("bp:wide") }, bps, 100, () => "test")
                .Select(k => k.Text).ToList();
            CollectionAssert.AreEquivalent(new[]
            {
                "state:a+hover", "state:b+hover", "bp:narrow+state:a", "bp:narrow+state:b", "bp:wide+state:a", "bp:wide+state:b",
                "bp:narrow+hover", "bp:wide+hover", "bp:narrow+state:a+hover", "bp:narrow+state:b+hover", "bp:wide+state:a+hover", "bp:wide+state:b+hover",
            }, unions);
            Assert.IsEmpty(LayerKey.UnionClosure(new[] { K("hover"), K("state:a+hover") }, bps, 100, () => "test"), "comparable keys need no union");

            var many = Enumerable.Range(0, 10).Select(i => K("anc(a" + i + "):hover"));
            var e = Assert.Throws<UnsupportedStyleException>(() => LayerKey.UnionClosure(many, bps, 50, () => "The layers of 'x'"));
            StringAssert.Contains("The layers of 'x'", e.Message);
        }
    }
}
