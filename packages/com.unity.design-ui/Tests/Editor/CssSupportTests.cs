using System.Linq;
using NUnit.Framework;

namespace DesignUi.Editor.Tests
{
    public class CssSupportTests
    {
        [Test]
        public void Units_AreOnlyPxAndPercent()
        {
            CollectionAssert.AreEquivalent(new[] { "px", "%" }, CssSupport.Default.Units);
        }

        [Test]
        public void ErrorEntries_HaveRuleAndFix()
        {
            var errors = CssSupport.Default.Properties.Where(p => p.Handling == CssHandling.Error).ToList();
            Assert.IsNotEmpty(errors);
            foreach (var p in errors)
            {
                Assert.IsNotEmpty(p.Rule, p.Name);
                Assert.IsNotEmpty(p.Fix, p.Name);
            }
        }

        [Test]
        public void DirectEntries_DeclareAnAcceptedValueForm()
        {
            foreach (var p in CssSupport.Default.Properties.Where(p => p.Handling == CssHandling.Direct))
                Assert.IsTrue(p.Keywords.Length + p.Types.Length > 0, p.Name);
        }

        [Test]
        public void Judge_GivesTheMappersVerdict_WithTheRuleTheLintNames()
        {
            Assert.AreEqual(CssVerdictKind.Written, CssSupport.Judge("width", "10px").Kind);
            Assert.AreEqual(CssVerdictKind.Dropped, CssSupport.Judge("cursor", "pointer").Kind);
            Assert.AreEqual(CssVerdictKind.Lowered, CssSupport.Judge("gap", "4px").Kind, "gap becomes child margins");
            Assert.AreEqual(CssVerdictKind.Lowered, CssSupport.Judge("display", "block").Kind, "a block box becomes a flex column");
            Assert.AreEqual(CssVerdictKind.Rejected, CssSupport.Judge("gap", "1em").Kind, "a lowered property keeps its value grammar");
            var outline = CssSupport.Judge("outline", "1px solid red");
            Assert.AreEqual(CssVerdictKind.Rejected, outline.Kind);
            Assert.AreEqual("U-CSS-023", outline.Rule);
            Assert.AreEqual("U-CSS-023", CssSupport.Judge("grid-template-columns", "1fr").Rule, "not listed");
            Assert.AreEqual("U-CSS-023", CssSupport.Judge("width", "10em").Rule, "a unit the mapper does not take");
            Assert.AreEqual("U-CSS-005", CssSupport.Judge("width", "calc(15px)").Rule, "calc() has its own rule");
            Assert.AreEqual("U-CSS-006", CssSupport.Judge("height", "10vh").Rule, "viewport units have their own rule");
            Assert.AreEqual("U-CSS-024", CssSupport.Judge("width", "min(10px, 5%)").Rule);
        }

        [Test]
        public void UnstyledText_WithASizeThatIsNoKitSize_IsRejectedLikeTheLintDoes()
        {
            var kit = new System.Collections.Generic.Dictionary<string, double> { { "label", 16 }, { "body", 24 } };
            IrScreen Ir(string size) => TestIr.Screen(TestIr.Root(TestIr.Text("t", "Metin", ("color", "#ffffff"), ("font-size", size))));
            Assert.DoesNotThrow(() => ScreenBuilder.Build(Ir("24px"), TestIr.RelativeAsset, null, kit));
            var e = Assert.Throws<UnsupportedStyleException>(() => ScreenBuilder.Build(Ir("15px"), TestIr.RelativeAsset, null, kit));
            Assert.AreEqual("U-CSS-016", e.RuleId);
            Assert.DoesNotThrow(() => ScreenBuilder.Build(Ir("15px"), TestIr.RelativeAsset, null, null), "without a kit table there is nothing to check against");
        }

        [Test]
        public void ARejectedValue_NamesItsDedicatedRuleAndFix()
        {
            foreach (var p in CssSupport.Default.Properties.Where(p => p.RejectedValues.Count > 0 && p.Handling == CssHandling.Direct))
                foreach (var kv in p.RejectedValues)
                {
                    var e = Assert.Throws<UnsupportedStyleException>(() => CssSupport.Default.ValidateValue(p, kv.Key), p.Name + ": " + kv.Key);
                    Assert.AreEqual(kv.Value.Rule, e.RuleId, p.Name + ": " + kv.Key);
                    Assert.AreEqual(kv.Value.Fix, e.Fix, p.Name + ": " + kv.Key);
                }
        }

        [Test]
        public void KnownProperties_HaveTheExpectedHandling()
        {
            CssPropertySpec Get(string n) { Assert.IsTrue(CssSupport.Default.TryGet(n, out var s), n); return s; }
            Assert.AreEqual(CssHandling.Direct, Get("width").Handling);
            Assert.AreEqual(CssHandling.Lowered, Get("gap").Handling);
            Assert.AreEqual(CssHandling.Dropped, Get("cursor").Handling);
            Assert.AreEqual(CssHandling.Error, Get("outline").Handling);
            Assert.IsFalse(CssSupport.Default.TryGet("grid-template-columns", out _));
        }
    }
}
