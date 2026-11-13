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
