using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;

namespace DesignUi.Editor.Tests
{
    public class StyleMapperTests
    {
        static IReadOnlyList<UssDeclaration> Map(params (string k, string v)[] css)
        {
            var d = new Dictionary<string, string>();
            foreach (var (k, v) in css) d[k] = v;
            return StyleMapper.Map(d);
        }

        static string Get(IReadOnlyList<UssDeclaration> l, string prop) => l.Where(x => x.Property == prop).Select(x => x.Value).SingleOrDefault();

        [Test]
        public void FontWeightAndItalic_BecomeBoldAndItalic()
        {
            var r = Map(("font-weight", "700"), ("font-style", "italic"));
            CollectionAssert.Contains(r, new UssDeclaration("-unity-font-style", "bold-and-italic"));
        }

        [Test]
        public void FontWeight_Alone_IsBold_AndItalicAlone_IsItalic()
        {
            Assert.AreEqual("bold", Get(Map(("font-weight", "700")), "-unity-font-style"));
            Assert.AreEqual("bold", Get(Map(("font-weight", "bold")), "-unity-font-style"));
            Assert.AreEqual("italic", Get(Map(("font-style", "italic")), "-unity-font-style"));
            Assert.AreEqual("normal", Get(Map(("font-weight", "400")), "-unity-font-style"));
        }

        [Test]
        public void FontWeight_WithoutRealFace_Throws()
        {
            Assert.Throws<UnsupportedStyleException>(() => Map(("font-weight", "600")));
        }

        [Test]
        public void FontFamily_BecomesPlaceholderToken()
        {
            Assert.AreEqual("var(--font-inter)", Get(Map(("font-family", "\"Inter\", sans-serif")), "-unity-font-definition"));
            Assert.AreEqual("var(--font-noto-sans-jp)", Get(Map(("font-family", "'Noto Sans JP'")), "-unity-font-definition"));
        }

        [Test]
        public void TextAlign_WithAlignItemsCenter_IsMiddleCenter()
        {
            var r = Map(("text-align", "center"), ("align-items", "center"));
            Assert.AreEqual("middle-center", Get(r, "-unity-text-align"));
        }

        [Test]
        public void TextAlign_AllNine()
        {
            var h = new[] { ("left", "left"), ("center", "center"), ("right", "right") };
            var v = new[] { ("flex-start", "upper"), ("center", "middle"), ("flex-end", "lower") };
            foreach (var (ta, hs) in h)
                foreach (var (ai, vs) in v)
                    Assert.AreEqual(vs + "-" + hs, Get(Map(("text-align", ta), ("align-items", ai)), "-unity-text-align"), ta + "/" + ai);
        }

        [Test]
        public void TextAlign_WithoutVerticalContext_IsUpper()
        {
            Assert.AreEqual("upper-right", Get(Map(("text-align", "right")), "-unity-text-align"));
        }

        [Test]
        public void AlignItems_IsAlsoEmittedForLayout()
        {
            Assert.AreEqual("center", Get(Map(("text-align", "center"), ("align-items", "center")), "align-items"));
        }

        [Test]
        public void LineHeight_IsDropped()
        {
            Assert.IsEmpty(Map(("line-height", "28px")));
        }

        [Test]
        public void Rgba_IsKept_AndDirectPropertiesPassThrough()
        {
            var r = Map(("background-color", "rgba(10, 20, 30, 0.5)"), ("width", "50%"), ("margin-left", "12px"),
                ("flex-direction", "row"), ("rotate", "45deg"), ("opacity", "0.4"), ("border-top-left-radius", "24px"));
            Assert.AreEqual("rgba(10, 20, 30, 0.5)", Get(r, "background-color"));
            Assert.AreEqual("50%", Get(r, "width"));
            Assert.AreEqual("12px", Get(r, "margin-left"));
            Assert.AreEqual("row", Get(r, "flex-direction"));
            Assert.AreEqual("45deg", Get(r, "rotate"));
            Assert.AreEqual("24px", Get(r, "border-top-left-radius"));
        }

        [Test]
        public void BakedProperties_AreNotEmitted()
        {
            Assert.IsEmpty(Map(("box-shadow", "0 8px 24px rgba(0,0,0,.4)"), ("background-image", "linear-gradient(red, blue)"), ("border-style", "solid")));
        }

        [Test]
        public void Output_IsDeterministicallyOrdered()
        {
            var a = Map(("width", "1px"), ("height", "2px"));
            var b = Map(("height", "2px"), ("width", "1px"));
            CollectionAssert.AreEqual(a, b);
        }

        [TestCase("display", "grid")]
        [TestCase("display", "inline")]
        [TestCase("align-items", "baseline")]
        [TestCase("align-self", "baseline")]
        [TestCase("min-width", "auto")]
        [TestCase("width", "calc(100% - 4px)")]
        [TestCase("width", "50vw")]
        [TestCase("height", "10vh")]
        [TestCase("backdrop-filter", "blur(4px)")]
        [TestCase("filter", "blur(2px)")]
        [TestCase("transition-timing-function", "cubic-bezier(0.1, 0.2, 0.3, 0.4)")]
        [TestCase("border-style", "dashed")]
        [TestCase("border-radius", "10px / 20px")]
        [TestCase("font-style", "oblique")]
        [TestCase("text-align", "justify")]
        [TestCase("overflow", "scroll")]
        [TestCase("transform", "rotate(3deg)")]
        [TestCase("gap", "4px")]
        [TestCase("z-index", "3")]
        [TestCase("cursor", "pointer")]
        [TestCase("background-image", "url(a.png)")]
        public void Unsupported_Throws(string prop, string value)
        {
            var e = Assert.Throws<UnsupportedStyleException>(() => Map((prop, value)));
            Assert.AreEqual(prop, e.Property);
            Assert.AreEqual(value, e.Value);
        }

        [Test]
        public void Easing_AllowedKeywordsPass()
        {
            foreach (var k in new[] { "linear", "ease", "ease-in", "ease-out", "ease-in-out" })
                Assert.AreEqual(k, Get(Map(("transition-timing-function", k)), "transition-timing-function"));
        }

        [Test]
        public void ThemeResets_CoverGeneratedControls()
        {
            var css = StyleMapper.ThemeResetUss;
            foreach (var c in new[] { "Label", "Button", "Toggle", "TextField", "DropdownField", "ScrollView", "ListView" })
                StringAssert.Contains(c, css);
            StringAssert.Contains("margin-left: 0", css);
            StringAssert.Contains("border-left-width: 0", css);
            StringAssert.Contains("background-color: rgba(0, 0, 0, 0)", css);
        }
    }
}
