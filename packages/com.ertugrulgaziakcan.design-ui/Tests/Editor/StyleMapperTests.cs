using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;

namespace DesignUi.Editor.Tests
{
    public class StyleMapperTests
    {
        static Dictionary<string, string> D(params (string k, string v)[] css)
        {
            var d = new Dictionary<string, string>();
            foreach (var (k, v) in css) d[k] = v;
            return d;
        }

        static IReadOnlyList<UssDeclaration> Map(params (string k, string v)[] css) => StyleMapper.Map(D(css));
        static string Get(IReadOnlyList<UssDeclaration> l, string prop) => l.Where(x => x.Property == prop).Select(x => x.Value).SingleOrDefault();

        [Test]
        public void Translate_OneValue_MovesAlongXOnly()
        {
            // CSS: one value is x (y 0); USS repeats a single value for y, so the y is always written
            Assert.AreEqual("24px 0px", Get(Map(("translate", "24px")), "translate"));
            Assert.AreEqual("-10% 0px", Get(Map(("translate", "-10%")), "translate"));
            Assert.AreEqual("0px 6px", Get(Map(("translate", "0px 6px")), "translate"));
            Assert.AreEqual("none", Get(Map(("translate", "none")), "translate"));
        }

        [Test]
        public void OverflowWrap_NormalIsLeftOut_AndBreakingInsideAWordIsRejected()
        {
            // a word broken inside its letters breaks at another letter in UI Toolkit (fidelity suite, 1920 and 1280)
            Assert.IsEmpty(Map(("overflow-wrap", "normal")));
            Assert.AreEqual("U-CSS-023", Assert.Throws<UnsupportedStyleException>(() => Map(("overflow-wrap", "break-word"))).RuleId);
            Assert.AreEqual("U-CSS-023", Assert.Throws<UnsupportedStyleException>(() => Map(("overflow-wrap", "anywhere"))).RuleId);
        }

        // ---- font ------------------------------------------------------------------------------------------

        [Test]
        public void Filter_EnabledFunctions_AreWrittenWithExplicitArguments_OthersAreUCss015()
        {
            // the shipped css-support.json enables what the fidelity suite measured (docs/findings/filters.md)
            Assert.AreEqual("invert(1) invert(0.5)", Get(Map(("filter", "invert(1) invert(0.5)")), "filter"));
            Assert.AreEqual("none", Get(Map(("filter", "none")), "filter"));
            var e = Assert.Throws<UnsupportedStyleException>(() => Map(("filter", "blur(4px)")));
            Assert.AreEqual("U-CSS-015", e.RuleId);
            StringAssert.Contains("Use only invert()", e.Message);
            Assert.AreEqual("U-CSS-015", Assert.Throws<UnsupportedStyleException>(() => Map(("filter", "brightness(1.2)"))).RuleId);
            Assert.AreEqual("U-CSS-015", Assert.Throws<UnsupportedStyleException>(() => Map(("filter", "url(#f)"))).RuleId);
            Assert.AreEqual("U-CSS-015", Assert.Throws<UnsupportedStyleException>(() => Map(("filter", "invert(1) drop-shadow(0 0 2px #000)"))).RuleId);

            // every UI Toolkit function's argument form, with all of them enabled
            var all = new CssPropertySpec { Name = "filter", ValueRule = "U-CSS-015", ValueFix = "fix",
                Functions = new[] { "blur", "contrast", "grayscale", "hue-rotate", "invert", "opacity", "sepia" } };
            Assert.AreEqual("blur(4px) blur(0px) blur(0px)", StyleMapper.FilterValue("blur(4px) blur(0) blur()", all));
            Assert.AreEqual("hue-rotate(120deg) hue-rotate(180deg) hue-rotate(90deg) hue-rotate(-45deg) hue-rotate(0deg)",
                StyleMapper.FilterValue("hue-rotate(120deg) hue-rotate(0.5turn) hue-rotate(100grad) hue-rotate(-45deg) hue-rotate(0)", all));
            Assert.AreEqual("hue-rotate(180deg)", StyleMapper.FilterValue("hue-rotate(3.141592653589793rad)", all));
            Assert.AreEqual("grayscale(1) contrast(1.6) sepia(80%) opacity(0.5) invert(1)", StyleMapper.FilterValue("grayscale() contrast(1.6) sepia(80%) opacity(0.5) invert(1)", all));
            foreach (var bad in new[] { "blur(4em)", "blur(-1px)", "hue-rotate(30)", "grayscale(-1)", "grayscale(1px)", "invert", "tint(red)" })
                Assert.AreEqual("U-CSS-015", Assert.Throws<UnsupportedStyleException>(() => StyleMapper.FilterValue(bad, all), bad).RuleId, bad);
        }

        [Test]
        public void FontWeightAndItalic_BecomeBoldAndItalic()
        {
            CollectionAssert.Contains(Map(("font-weight", "700"), ("font-style", "italic")), new UssDeclaration("-unity-font-style", "bold-and-italic"));
        }

        [Test]
        public void FontStyle_SingleProperties()
        {
            Assert.AreEqual("bold", Get(Map(("font-weight", "700")), "-unity-font-style"));
            Assert.AreEqual("bold", Get(Map(("font-weight", "bold")), "-unity-font-style"));
            Assert.AreEqual("italic", Get(Map(("font-style", "italic")), "-unity-font-style"));
            Assert.AreEqual("normal", Get(Map(("font-weight", "400")), "-unity-font-style"));
        }

        [Test]
        public void FontStyle_HoverWeight_KeepsBaseItalic()
        {
            var r = StyleMapper.Map(D(("font-weight", "700")), D(("font-style", "italic")), true, false);
            Assert.AreEqual("bold-and-italic", Get(r, "-unity-font-style"));
        }

        [Test]
        public void FontStyle_LayerOverridesBase()
        {
            var r = StyleMapper.Map(D(("font-weight", "400")), D(("font-weight", "700"), ("font-style", "italic")), true, false);
            Assert.AreEqual("italic", Get(r, "-unity-font-style"));
        }

        [TestCase("font-weight", "600")]
        [TestCase("font-weight", "500")]
        [TestCase("font-style", "oblique")]
        public void FontWeightOrStyle_WithoutRealFace_Throws(string prop, string value)
        {
            Assert.Throws<UnsupportedStyleException>(() => Map((prop, value)));
        }

        [Test]
        public void FontFamily_BecomesPlaceholderToken()
        {
            Assert.AreEqual("var(--font-inter)", Get(Map(("font-family", "\"Inter\", sans-serif")), "-unity-font-definition"));
            Assert.AreEqual("var(--font-noto-sans-jp)", Get(Map(("font-family", "'Noto Sans JP'")), "-unity-font-definition"));
        }

        // ---- text alignment --------------------------------------------------------------------------------

        static string Align(bool text, params (string k, string v)[] css) => Get(StyleMapper.Map(D(css), D(css), text, true), "-unity-text-align");

        [Test]
        public void TextAlign_FlexRow_VerticalFromAlignItems()
        {
            var h = new[] { "left", "center", "right" };
            var v = new[] { ("flex-start", "upper"), ("center", "middle"), ("flex-end", "lower") };
            foreach (var ta in h)
                foreach (var (ai, vs) in v)
                    Assert.AreEqual(vs + "-" + ta, Align(true, ("display", "flex"), ("flex-direction", "row"), ("text-align", ta), ("align-items", ai)), ta + "/" + ai);
        }

        [Test]
        public void TextAlign_FlexColumn_VerticalFromJustifyContent()
        {
            Assert.AreEqual("middle-center", Align(true, ("display", "flex"), ("flex-direction", "column"), ("text-align", "center"), ("justify-content", "center")));
            Assert.AreEqual("upper-center", Align(true, ("display", "flex"), ("flex-direction", "column"), ("text-align", "center"), ("align-items", "center")));
            Assert.AreEqual("lower-left", Align(true, ("display", "flex"), ("flex-direction", "column"), ("text-align", "left"), ("justify-content", "flex-end")));
        }

        [Test]
        public void TextAlign_FlexColumnReverse_FlipsVertical()
        {
            Assert.AreEqual("lower-left", Align(true, ("display", "flex"), ("flex-direction", "column-reverse"), ("text-align", "left"), ("justify-content", "flex-start")));
        }

        [Test]
        public void TextAlign_NonFlex_OnlyHorizontal_AlignItemsIgnored()
        {
            Assert.AreEqual("upper-center", Align(true, ("text-align", "center"), ("align-items", "center")));
            Assert.AreEqual("upper-right", Align(true, ("text-align", "right")));
            Assert.IsNull(Align(true, ("align-items", "center")));
        }

        [Test]
        public void TextAlign_FlexWithoutTextAlign_IsLeft()
        {
            Assert.AreEqual("middle-left", Align(true, ("display", "flex"), ("flex-direction", "row"), ("align-items", "center")));
        }

        [Test]
        public void TextAlign_LayerChangesHorizontal_KeepsBaseVertical()
        {
            var baseCss = D(("display", "flex"), ("flex-direction", "row"), ("align-items", "center"), ("text-align", "center"));
            var r = StyleMapper.Map(D(("text-align", "left")), baseCss, true, false);
            Assert.AreEqual("middle-left", Get(r, "-unity-text-align"));
        }

        [Test]
        public void TextAlign_LayerChangesAlignItemsOnly_StillEmits()
        {
            var baseCss = D(("display", "flex"), ("flex-direction", "row"), ("text-align", "center"));
            var r = StyleMapper.Map(D(("align-items", "flex-end")), baseCss, true, false);
            Assert.AreEqual("lower-center", Get(r, "-unity-text-align"));
        }

        [Test]
        public void TextAlign_NotEmittedOnContainers_AlignItemsStillPassesThrough()
        {
            var r = Map2(false, ("display", "flex"), ("text-align", "center"), ("align-items", "center"));
            Assert.IsNull(Get(r, "-unity-text-align"));
            Assert.AreEqual("center", Get(r, "align-items"));
        }

        static IReadOnlyList<UssDeclaration> Map2(bool text, params (string k, string v)[] css) => StyleMapper.Map(D(css), D(css), text, true);

        [TestCase("justify")]
        [TestCase("match-parent")]
        public void TextAlign_UnsupportedValue_Throws(string v)
        {
            Assert.Throws<UnsupportedStyleException>(() => Map(("text-align", v)));
        }

        // ---- direct, dropped, composed ---------------------------------------------------------------------

        [Test]
        public void LineHeight_IsDropped() => Assert.IsEmpty(Map(("line-height", "28px")));

        [Test]
        public void Rgba_IsKept_AndDirectPropertiesPassThrough()
        {
            var r = Map(("background-color", "rgba(10, 20, 30, 0.5)"), ("width", "50%"), ("margin-left", "12px"),
                ("flex-direction", "row"), ("rotate", "45deg"), ("opacity", "0.4"), ("border-top-left-radius", "24px"),
                ("margin-right", "auto"), ("aspect-ratio", "16 / 9"), ("transform-origin", "left top"));
            Assert.AreEqual("rgba(10, 20, 30, 0.5)", Get(r, "background-color"));
            Assert.AreEqual("50%", Get(r, "width"));
            Assert.AreEqual("12px", Get(r, "margin-left"));
            Assert.AreEqual("auto", Get(r, "margin-right"));
            Assert.AreEqual("row", Get(r, "flex-direction"));
            Assert.AreEqual("45deg", Get(r, "rotate"));
            Assert.AreEqual("24px", Get(r, "border-top-left-radius"));
            Assert.AreEqual("1.777778", Get(r, "aspect-ratio"));
        }

        [Test]
        public void BakedAndIgnoredProperties_AreNotEmitted()
        {
            Assert.IsEmpty(Map(("box-shadow", "0 8px 24px rgba(0,0,0,.4)"), ("background-image", "linear-gradient(red, blue)"), ("border-style", "solid"),
                ("box-sizing", "border-box"), ("border-top-style", "solid")));
        }

        [TestCase("cursor", "pointer")]
        [TestCase("user-select", "none")]
        [TestCase("-webkit-font-smoothing", "antialiased")]
        [TestCase("-webkit-tap-highlight-color", "rgba(0, 0, 0, 0)")]
        public void DroppedProperties_AreAcceptedAndOmitted(string prop, string value) => Assert.IsEmpty(Map((prop, value)));

        [Test]
        public void MinSizeAuto_IsAcceptedAndDropped()
        {
            Assert.IsEmpty(Map(("min-width", "auto"), ("min-height", "auto")));
            Assert.AreEqual("10px", Get(Map(("min-width", "10px")), "min-width"));
        }

        [Test]
        public void OverflowClip_BecomesHidden() => Assert.AreEqual("hidden", Get(Map(("overflow", "clip")), "overflow"));

        [Test]
        public void OverflowXY_EqualBecomesOverflow_UnequalThrows()
        {
            Assert.AreEqual("hidden", Get(Map(("overflow-x", "hidden"), ("overflow-y", "hidden")), "overflow"));
            Assert.Throws<UnsupportedStyleException>(() => Map(("overflow-x", "hidden"), ("overflow-y", "visible")));
        }

        [Test]
        public void WhiteSpaceLonghands_ComposeWhiteSpace()
        {
            Assert.AreEqual("nowrap", Get(Map(("white-space-collapse", "collapse"), ("text-wrap-mode", "nowrap")), "white-space"));
            Assert.AreEqual("pre", Get(Map(("white-space-collapse", "preserve"), ("text-wrap-mode", "nowrap")), "white-space"));
            Assert.AreEqual("pre-wrap", Get(Map(("white-space-collapse", "preserve"), ("text-wrap-mode", "wrap")), "white-space"));
            Assert.AreEqual("normal", Get(Map(("white-space-collapse", "collapse"), ("text-wrap-mode", "wrap")), "white-space"));
            Assert.AreEqual("nowrap", Get(Map(("white-space", "nowrap")), "white-space"));
        }

        [TestCase("transition", "opacity 0.2s ease-out 0s")]
        [TestCase("transition-property", "opacity, translate")]
        [TestCase("transition-duration", "0.2s")]
        [TestCase("transition-delay", "0s")]
        [TestCase("transition-timing-function", "ease-in-out")]
        public void Transitions_AreLowered_NeverEmittedAsUss(string prop, string value)
        {
            var e = Assert.Throws<UnsupportedStyleException>(() => Map((prop, value)));
            StringAssert.Contains("lowered", e.Message);
        }

        [Test]
        public void TransitionBehaviorNormal_IsDropped() => Assert.IsEmpty(Map(("transition-behavior", "normal")));

        [Test]
        public void Output_ShorthandsFirstThenOrdinalByProperty()
        {
            var r = Map(("width", "1px"), ("padding-left", "2px"), ("height", "2px"), ("margin-top", "4px"), ("border-radius", "2px"), ("flex", "1"));
            CollectionAssert.AreEqual(new[] { "border-radius", "flex", "height", "margin-top", "padding-left", "width" }, r.Select(d => d.Property).ToArray());
        }

        [Test]
        public void ShorthandWithItsLonghandInOneLayer_Throws()
        {
            Assert.Throws<UnsupportedStyleException>(() => Map(("margin", "0"), ("margin-left", "10px")));
            Assert.Throws<UnsupportedStyleException>(() => Map(("overflow", "hidden"), ("overflow-x", "hidden")));
        }

        // ---- letter-spacing ----------------------------------------------------------------------------------

        static IReadOnlyList<UssDeclaration> Layer(Dictionary<string, string> layer, Dictionary<string, string> basis, bool isText = true) =>
            StyleMapper.Map(layer, basis, isText, false);

        /// <summary>
        /// UI Toolkit applies USS letter-spacing in hundredths of an em of the element's font size (measured: LetterSpacingTests),
        /// CSS in px: 1.6px on 16px text is 10 in USS. The standard generator leaves out the spacing after the last character,
        /// which Chromium adds: a text element gets it as extra right padding, so its box, line breaks and alignment match.
        /// </summary>
        [Test]
        public void LetterSpacing_IsHundredthsOfAnEm_AndTheLastCharactersSpacingIsRightPadding()
        {
            var text = Map(("letter-spacing", "1.6px"), ("font-size", "16px"));
            Assert.AreEqual("10px", Get(text, "letter-spacing"));
            Assert.AreEqual("1.6px", Get(text, "padding-right"));
            var tight = Map(("letter-spacing", "-0.48px"), ("font-size", "24px"), ("padding-right", "8px"));
            Assert.AreEqual("-2px", Get(tight, "letter-spacing"));
            Assert.AreEqual("7.52px", Get(tight, "padding-right"));
            var none = Map(("letter-spacing", "normal"), ("font-size", "24px"), ("padding-right", "8px"));
            Assert.AreEqual("0px", Get(none, "letter-spacing"));
            Assert.AreEqual("8px", Get(none, "padding-right"));
        }

        /// <summary>
        /// Negative spacing needs at least as much right padding (UI Toolkit lays negative padding out as 0, measured: a
        /// negative margin keeps neither the box nor the line): the compiler rejects it as lint U-CSS-044 does.
        /// </summary>
        [Test]
        public void NegativeLetterSpacing_WithoutEnoughRightPadding_IsRejected()
        {
            var e = Assert.Throws<UnsupportedStyleException>(() => Map(("letter-spacing", "-1.28px"), ("font-size", "64px")));
            Assert.AreEqual("U-CSS-044", e.RuleId);
            Assert.Throws<UnsupportedStyleException>(() => Map(("letter-spacing", "-1.28px"), ("font-size", "64px"), ("padding-right", "1px")));
            Assert.AreEqual("0.72px", Get(Map(("letter-spacing", "-1.28px"), ("font-size", "64px"), ("padding-right", "2px")), "padding-right"));
        }

        [Test]
        public void LetterSpacing_FollowsALayersFontSize_AndPaddingAndUndoesTheCompensation()
        {
            var basis = D(("letter-spacing", "2px"), ("font-size", "16px"), ("padding-right", "4px"));
            Assert.AreEqual("6.25px", Get(Layer(D(("font-size", "32px")), basis), "letter-spacing"), "a layer that changes the font size keeps 2 px");
            Assert.IsNull(Get(Layer(D(("font-size", "32px")), basis), "padding-right"));
            Assert.AreEqual("12px", Get(Layer(D(("padding-right", "10px")), basis), "padding-right"), "the layer's padding plus the spacing");
            var off = Layer(D(("letter-spacing", "normal")), basis);
            Assert.AreEqual("0px", Get(off, "letter-spacing"));
            Assert.AreEqual("4px", Get(off, "padding-right"), "no spacing, no compensation");
        }

        [Test]
        public void LetterSpacing_OnAContainer_HasNoPadding_AndWithoutAFontSizeIsLeftToItsTexts()
        {
            var container = StyleMapper.Map(D(("letter-spacing", "1px"), ("font-size", "20px")), D(("letter-spacing", "1px"), ("font-size", "20px")), false, true);
            Assert.AreEqual("5px", Get(container, "letter-spacing"));
            Assert.IsNull(Get(container, "padding-right"));
            var bare = StyleMapper.Map(D(("letter-spacing", "1px")), D(("letter-spacing", "1px")), false, true);
            Assert.IsNull(Get(bare, "letter-spacing"), "its text elements carry the spacing with their own font size");
        }

        /// <summary>
        /// USS word-spacing is hundredths of an em of the element's font size too (TextCore adds it times the em scale, as
        /// letter-spacing): 8px on 16px text is 50 in USS, recomputed for a layer's font size; no padding (CSS adds no spacing
        /// after a line's last word).
        /// </summary>
        [Test]
        public void WordSpacing_IsHundredthsOfAnEm_FollowingTheFontSize()
        {
            var text = Map(("word-spacing", "8px"), ("font-size", "16px"));
            Assert.AreEqual("50px", Get(text, "word-spacing"));
            Assert.IsNull(Get(text, "padding-right"));
            Assert.AreEqual("-16.6667px", Get(Map(("word-spacing", "-4px"), ("font-size", "24px")), "word-spacing"));
            Assert.AreEqual("0px", Get(Map(("word-spacing", "normal"), ("font-size", "24px")), "word-spacing"));
            var basis = D(("word-spacing", "8px"), ("font-size", "16px"));
            Assert.AreEqual("25px", Get(Layer(D(("font-size", "32px")), basis), "word-spacing"), "a layer that changes the font size keeps 8 px");
            Assert.AreEqual("0px", Get(Layer(D(("word-spacing", "normal")), basis), "word-spacing"));
            Assert.IsNull(Get(Layer(D(("color", "#ffffff")), basis), "word-spacing"), "the base's value still holds");
            Assert.IsNull(Get(Map(("font-size", "16px")), "word-spacing"), "none written where nothing sets it");
            var bare = StyleMapper.Map(D(("word-spacing", "4px")), D(("word-spacing", "4px")), false, true);
            Assert.IsNull(Get(bare, "word-spacing"), "a container without a font size leaves it to its texts");
        }

        // ---- values ----------------------------------------------------------------------------------------

        [TestCase("display", "grid")]
        [TestCase("display", "inline")]
        [TestCase("display", "block")]
        [TestCase("position", "static")]
        [TestCase("align-items", "baseline")]
        [TestCase("align-self", "baseline")]
        [TestCase("align-items", "end")]
        [TestCase("align-content", "normal")]
        [TestCase("justify-content", "start")]
        [TestCase("white-space", "pre-line")]
        [TestCase("white-space-collapse", "preserve-breaks")]
        [TestCase("flex-basis", "content")]
        [TestCase("letter-spacing", "0.02em")]
        [TestCase("font-size", "1.2em")]
        [TestCase("width", "min(100px, 50%)")]
        [TestCase("width", "max(100px, 50%)")]
        [TestCase("width", "clamp(1px, 2px, 3px)")]
        [TestCase("width", "calc(100% - 4px)")]
        [TestCase("width", "50vw")]
        [TestCase("height", "100dvh")]
        [TestCase("height", "10vh")]
        [TestCase("width", "10rem")]
        [TestCase("color", "hsl(120, 50%, 50%)")]
        [TestCase("color", "rgb(0 0 0 / 50%)")]
        [TestCase("color", "var(--accent)")]
        [TestCase("text-shadow", "1px 1px 2px red, 2px 2px 4px blue")]
        [TestCase("scale", "110%")]
        [TestCase("transition", "opacity 0.2s cubic-bezier(0.1, 0.2, 0.3, 0.4)")]
        [TestCase("transition-timing-function", "cubic-bezier(0.1, 0.2, 0.3, 0.4)")]
        [TestCase("transition-timing-function", "steps(4)")]
        [TestCase("border-style", "dashed")]
        [TestCase("border-top-style", "dotted")]
        [TestCase("border-radius", "10px / 20px")]
        [TestCase("border-radius", "50%")]
        [TestCase("border-top-left-radius", "10%")]
        [TestCase("border-top-left-radius", "10px 20px")]
        [TestCase("overflow", "scroll")]
        [TestCase("box-sizing", "content-box")]
        [TestCase("background-image", "url(a.png)")]
        [TestCase("text-overflow", "fade")]
        [TestCase("opacity", "50%")]
        [TestCase("padding-left", "auto")]
        public void InvalidValue_Throws(string prop, string value)
        {
            var e = Assert.Throws<UnsupportedStyleException>(() => Map((prop, value)));
            Assert.AreEqual(prop, e.Property);
            Assert.AreEqual(value, e.Value);
        }

        [Test]
        public void UnknownValueFunction_CarriesRule024_AndCalcItsOwnRule()
        {
            var e = Assert.Throws<UnsupportedStyleException>(() => Map(("width", "min(1px, 2px)")));
            Assert.AreEqual("U-CSS-024", e.RuleId);
            Assert.AreEqual("U-CSS-005", Assert.Throws<UnsupportedStyleException>(() => Map(("width", "calc(1px + 2px)"))).RuleId);
        }

        [TestCase("transform", "rotate(3deg)")]
        [TestCase("outline", "1px solid red")]
        [TestCase("text-transform", "uppercase")]
        [TestCase("filter", "blur(2px)")]
        [TestCase("backdrop-filter", "blur(4px)")]
        public void ErrorProperties_ThrowWithRuleAndFix(string prop, string value)
        {
            var e = Assert.Throws<UnsupportedStyleException>(() => Map((prop, value)));
            Assert.AreEqual(prop, e.Property);
            Assert.IsNotEmpty(e.RuleId);
            Assert.IsNotEmpty(e.Fix);
        }

        [TestCase("gap", "4px")]
        [TestCase("row-gap", "4px")]
        [TestCase("z-index", "3")]
        [TestCase("pointer-events", "none")]
        public void LoweredProperties_StillPresent_Throw(string prop, string value)
        {
            Assert.Throws<UnsupportedStyleException>(() => Map((prop, value)));
        }

        [Test]
        public void UnknownProperty_ThrowsWithRule023()
        {
            var e = Assert.Throws<UnsupportedStyleException>(() => Map(("grid-template-columns", "1fr 1fr")));
            Assert.AreEqual("U-CSS-023", e.RuleId);
        }

        [Test]
        public void AspectRatio_SlashBecomesInvariantNumber_AutoAndNumberStay()
        {
            Assert.AreEqual("2", Get(Map(("aspect-ratio", "2 / 1")), "aspect-ratio"));
            Assert.AreEqual("1.5", Get(Map(("aspect-ratio", "1.5")), "aspect-ratio"));
            Assert.AreEqual("auto", Get(Map(("aspect-ratio", "auto")), "aspect-ratio"));
            Assert.AreEqual("2", Get(Map(("aspect-ratio", "auto 64 / 32")), "aspect-ratio"), "auto with a ratio is the ratio");
            Assert.AreEqual("1.777778", Get(Map(("aspect-ratio", "16/9 auto")), "aspect-ratio"));
        }

        [Test]
        public void TextShadow_NoneBecomesInitial_BecauseUssInheritsIt()
        {
            Assert.AreEqual("initial", Get(Map(("text-shadow", "none")), "text-shadow"));
            Assert.AreEqual("initial", Get(StyleMapper.Map(D(("text-shadow", "none")), D(("text-shadow", "1px 1px 2px #000000")), true, false), "text-shadow"));
            Assert.AreEqual("1px 1px 2px #000000", Get(Map(("text-shadow", "1px 1px 2px #000000")), "text-shadow"));
        }

        [Test]
        public void BorderStyleNone_EmitsZeroWidth()
        {
            var r = Map(("border-top-style", "none"), ("border-top-width", "2px"), ("border-left-width", "3px"));
            Assert.AreEqual("0", Get(r, "border-top-width"));
            Assert.AreEqual("3px", Get(r, "border-left-width"));
            var all = Map(("border-style", "none"), ("border-width", "2px"));
            foreach (var side in new[] { "top", "right", "bottom", "left" }) Assert.AreEqual("0", Get(all, "border-" + side + "-width"));
        }

        [Test]
        public void BorderStyle_MixedShorthand_ResolvesPerSide()
        {
            var r = Map(("border-style", "none solid"), ("border-width", "2px"));
            Assert.AreEqual("0", Get(r, "border-top-width"));
            Assert.IsNull(Get(r, "border-right-width"));
            Assert.AreEqual("0", Get(r, "border-bottom-width"));
            Assert.AreEqual("2px", Get(r, "border-width"));
        }

        [Test]
        public void BorderStyle_LayerTurnsABorderOn_RestoresTheBaseWidth()
        {
            var baseCss = D(("border-top-style", "none"), ("border-top-width", "2px"));
            var r = StyleMapper.Map(D(("border-top-style", "solid")), baseCss, false, false);
            Assert.AreEqual("2px", Get(r, "border-top-width"));
        }

        [Test]
        public void BorderStyle_LayerWidthOverHiddenBase_StaysZero()
        {
            var baseCss = D(("border-style", "none"));
            var r = StyleMapper.Map(D(("border-width", "2px")), baseCss, false, false);
            foreach (var side in new[] { "top", "right", "bottom", "left" }) Assert.AreEqual("0", Get(r, "border-" + side + "-width"));
        }

        [Test]
        public void BaseCopy_IsStillTheBaseLayer_WhenFlagged()
        {
            var copy = D(("min-width", "auto"));
            Assert.DoesNotThrow(() => StyleMapper.Map(copy, D(("min-width", "auto")), false, true));
            Assert.Throws<UnsupportedStyleException>(() => StyleMapper.Map(copy, D(("min-width", "auto")), false, false));
        }

        [Test]
        public void Visibility_Passes() => Assert.AreEqual("hidden", Get(Map(("visibility", "hidden")), "visibility"));

        [Test]
        public void LayerOnlyMinAuto_AndLayerGradient_Throw()
        {
            var baseCss = D(("min-width", "100px"));
            Assert.Throws<UnsupportedStyleException>(() => StyleMapper.Map(D(("min-width", "auto")), baseCss, false, false));
            Assert.Throws<UnsupportedStyleException>(() => StyleMapper.Map(D(("background-image", "linear-gradient(red, blue)")), baseCss, false, false));
        }

        [Test]
        public void TextAlign_FlexRow_JustifyContentPlacesHorizontally()
        {
            Assert.AreEqual("middle-center", Align(true, ("display", "flex"), ("flex-direction", "row"), ("align-items", "center"), ("justify-content", "center")));
            Assert.AreEqual("upper-right", Align(true, ("display", "flex"), ("flex-direction", "row"), ("justify-content", "flex-end")));
            Assert.AreEqual("upper-center", Align(true, ("display", "flex"), ("flex-direction", "row"), ("justify-content", "space-evenly")));
            Assert.AreEqual("upper-right", Align(true, ("display", "flex"), ("flex-direction", "row-reverse")));
            Assert.AreEqual("upper-left", Align(true, ("display", "flex"), ("flex-direction", "row-reverse"), ("justify-content", "flex-end")));
        }

        [Test]
        public void TextAlign_FlexColumn_AlignItemsPlacesHorizontally_JustifyVertically()
        {
            Assert.AreEqual("middle-center", Align(true, ("display", "flex"), ("flex-direction", "column"), ("align-items", "center"), ("justify-content", "center")));
            Assert.AreEqual("lower-right", Align(true, ("display", "flex"), ("flex-direction", "column"), ("align-items", "flex-end"), ("justify-content", "flex-end")));
            Assert.AreEqual("middle-left", Align(true, ("display", "flex"), ("flex-direction", "column"), ("justify-content", "space-around")));
            Assert.AreEqual("upper-center", Align(true, ("display", "flex"), ("flex-direction", "column"), ("align-items", "stretch"), ("text-align", "center")));
        }

        [Test]
        public void ColorForms_HexRgbaAndKeywordPass()
        {
            Assert.AreEqual("#2fd1c5", Get(Map(("color", "#2fd1c5")), "color"));
            Assert.AreEqual("rgb(1, 2, 3)", Get(Map(("color", "rgb(1, 2, 3)")), "color"));
            Assert.AreEqual("transparent", Get(Map(("background-color", "transparent")), "background-color"));
        }
    }
}
