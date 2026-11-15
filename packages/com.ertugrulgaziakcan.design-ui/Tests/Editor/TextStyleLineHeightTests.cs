using System;
using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using static DesignUi.Editor.Tests.TestIr;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// Two kit styles of one size and weight with different line heights (caption 20/28 and label 20/24): a text compiles
    /// with the line-box variant of its own line height. An export of an older exporter named the first style of the size and
    /// weight (caption-bold for a 20/24 bold text), so Unity drew it with the 28 px line box; the compiler now takes the style
    /// of the node's size, weight and line height, and never one of another line height.
    /// </summary>
    public class TextStyleLineHeightTests
    {
        static readonly Dictionary<string, KitTextStyle> Table = new Dictionary<string, KitTextStyle>
        {
            { "caption", new KitTextStyle(20, 28, 400) }, { "caption-bold", new KitTextStyle(20, 28, 700) },
            { "label", new KitTextStyle(20, 24, 400) }, { "label-bold", new KitTextStyle(20, 24, 700) },
        };

        static ScreenBuildOptions Options() => new ScreenBuildOptions
        {
            TextStyleSizes = Table.ToDictionary(kv => kv.Key, kv => kv.Value.FontSize),
            TextStyleLineBoxes = Table.ToDictionary(kv => kv.Key, kv => FontTwinGenerator.LineBox.KeyOf(kv.Value.FontSize, kv.Value.LineHeight)),
            LineBoxes = FontTwinGenerator.LineBox.Of(new[] { (20.0, 28.0), (20.0, 24.0) }),
            TextStyleTable = Table,
        };

        static IrNode Styled(string id, string style, string lineHeight, string weight)
        {
            var t = Text(id, "Metin", ("font-family", "Inter"), ("font-size", "20px"), ("line-height", lineHeight), ("font-weight", weight), ("color", "#ffffff"));
            t.Text.Style = style;
            return t;
        }

        static string Font(CompiledScreen s, string name)
        {
            var cls = s.Find(name).Classes.Single(c => c.StartsWith("s-", StringComparison.Ordinal));
            return s.Rules.Where(r => r.Selector == "." + cls).SelectMany(r => r.Declarations).Where(d => d.Property == "-unity-font-definition").Select(d => d.Value).Single();
        }

        static readonly string Box24 = FontTwinGenerator.LineBox.KeyOf(20, 24), Box28 = FontTwinGenerator.LineBox.KeyOf(20, 28);

        [Test]
        public void EachText_CompilesWithTheLineBoxOfItsOwnLineHeight_AlsoWhenTheExportNamedAStyleOfAnotherLineHeight()
        {
            var s = ScreenBuilder.Build(Screen(Root(
                Styled("stale", "caption-bold", "24px", "700"), // the pilot's "+N more": CSS 20/24 bold, exported as caption-bold (20/28)
                Styled("staleRegular", "caption", "24px", "400"),
                Styled("caption", "caption", "28px", "400"),
                Styled("label", "label-bold", "24px", "700"))), Options(), RelativeAsset, null);
            Assert.AreEqual("var(--font-inter-" + Box24 + ")", Font(s, "stale"), "the 24 px line box of the text's own line height");
            Assert.AreEqual("var(--font-inter-" + Box24 + ")", Font(s, "staleRegular"));
            Assert.AreEqual("var(--font-inter-" + Box28 + ")", Font(s, "caption"));
            Assert.AreEqual("var(--font-inter-" + Box24 + ")", Font(s, "label"));
        }

        [Test]
        public void ATextWhoseLineHeightNoStyleOfItsSizeAndWeightHas_IsAnErrorThatSaysToExportAgain()
        {
            var e = Assert.Throws<IrFormatException>(() => ScreenBuilder.Build(Screen(Root(Styled("odd", "caption", "26px", "400"))), Options(), RelativeAsset, null));
            StringAssert.Contains("'odd'", e.Message);
            StringAssert.Contains("26", e.Message);
            StringAssert.Contains("export the screen again", e.Message);
        }
    }
}
