using System;
using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using static DesignUi.Editor.Tests.TestIr;

namespace DesignUi.Editor.Tests
{
    /// <summary>Values and fields the IR carries: initial control states, attribute texts, tintable vectors, CSS background images.</summary>
    public class IrValuesTests
    {
        static CompiledScreen Build(IrScreen ir) => ScreenBuilder.Build(ir, RelativeAsset, null, new Dictionary<string, double> { { "label", 16.515625 } });

        static string Cls(CompiledScreen s, string name) => s.Find(name).Classes.Single(c => c.StartsWith("s-", StringComparison.Ordinal));

        static UssRule Rule(CompiledScreen s, string selector)
        {
            var rules = s.Rules.Where(r => r.Selector == selector).ToList();
            Assert.AreEqual(1, rules.Count, "one rule '" + selector + "' in:\n" + UssWriter.Write(s));
            return rules[0];
        }

        static string Decl(UssRule r, string property) => r.Declarations.Where(d => d.Property == property).Select(d => d.Value).SingleOrDefault();

        static IrText T(string tr) => new IrText { Key = "k." + tr, Tr = tr, En = tr };

        static KeyValuePair<string, string> A(string k, string v) => new KeyValuePair<string, string>(k, v);

        // ---- initial states and attribute texts ----------------------------------------------------------

        [Test]
        public void Initial_DisabledAndChecked_BecomeUxmlAttributes()
        {
            var button = Node("b", "button", ("height", "10px")).With("disabled", ("opacity", "0.4"));
            button.Initial = new IrInitial { Disabled = true };
            var toggle = Node("t", "toggle", ("height", "10px"));
            toggle.Initial = new IrInitial { Checked = true };
            var both = Node("u", "toggle", ("height", "10px"));
            both.Initial = new IrInitial { Disabled = true, Checked = true };
            var plain = Node("p", "button", ("height", "10px"));
            plain.Initial = new IrInitial();
            var s = Build(Screen(Root(button, toggle, both, plain)));
            CollectionAssert.AreEqual(new[] { A("enabled", "false") }, s.Find("b").Attributes);
            CollectionAssert.AreEqual(new[] { A("value", "true") }, s.Find("t").Attributes);
            CollectionAssert.AreEqual(new[] { A("enabled", "false"), A("value", "true") }, s.Find("u").Attributes);
            CollectionAssert.IsEmpty(s.Find("p").Attributes, "the defaults write nothing");
            StringAssert.Contains("<ui:Button name=\"b\" class=\"" + Cls(s, "b") + "\" enabled=\"false\" />", UxmlWriter.Write(s, "T.uss"));

            var checkedButton = Node("c", "button");
            checkedButton.Initial = new IrInitial { Checked = true };
            Assert.Throws<IrFormatException>(() => Build(Screen(Root(checkedButton))));
        }

        [Test]
        public void AttrTexts_PlaceholderAndTitle_BecomeTextFieldPlaceholderAndTooltip()
        {
            var input = Node("search", "input", ("height", "30px"));
            input.AttrTexts["placeholder"] = T("Ara");
            input.AttrTexts["title"] = T("Oyuncu ara");
            var icon = Node("help", "container", ("height", "10px"));
            icon.AttrTexts["title"] = T("Yardım");
            var s = Build(Screen(Root(input, icon)));
            CollectionAssert.AreEqual(new[] { A(ScreenBuilder.PlaceholderAttribute, "Ara"), A("tooltip", "Oyuncu ara") }, s.Find("search").Attributes);
            Assert.AreEqual("placeholder-text", ScreenBuilder.PlaceholderAttribute);
            CollectionAssert.AreEqual(new[] { A("tooltip", "Yardım") }, s.Find("help").Attributes);
            Assert.IsNotNull(s.Find("help"), "an attribute keeps a wrapper");
        }

        [TestCase("alt")]
        [TestCase("aria-label")]
        public void AttrTexts_WithoutAUiToolkitCounterpart_AreErrors(string name)
        {
            var img = Node("crest", "image", ("height", "10px"));
            img.AttrTexts[name] = T("Arma");
            StringAssert.Contains(name, Assert.Throws<IrFormatException>(() => Build(Screen(Root(img)))).Message);
        }

        [Test]
        public void AttrTexts_PlaceholderOutsideAnInput_AndTextOnInputs_AreErrors()
        {
            var box = Node("box", "container");
            box.AttrTexts["placeholder"] = T("x");
            Assert.Throws<IrFormatException>(() => Build(Screen(Root(box))));
            var input = Node("search", "input");
            input.Text = T("Ali");
            Assert.Throws<IrFormatException>(() => Build(Screen(Root(input))), "a field's value text keeps the error path");
        }

        // ---- tintable vectors ------------------------------------------------------------------------------

        [Test]
        public void TintableVector_IsTintedWithItsColorInEveryLayer()
        {
            var icon = Node("icon", "vector", ("width", "24px"), ("height", "24px"), ("color", "#ffffff"))
                .With("anc(btn):hover", ("color", "#2fd1c5"))
                .With("state:off", ("color", "rgba(255, 255, 255, 0.4)"));
            icon.Asset = new IrAsset { Kind = "svg", File = "assets/icon.svg", Sha256 = new string('f', 64), Width = 24, Height = 24, Tint = true };
            var btn = Node("btn", "button", ("height", "40px")).Add(icon);
            var s = Build(Screen(Root(btn)));
            var c = Cls(s, "icon");
            var baseRule = Rule(s, "." + c);
            Assert.AreEqual("#ffffff", Decl(baseRule, ScreenBuilder.TintProperty));
            Assert.AreEqual("url(\"assets/icon.svg\")", Decl(baseRule, "background-image"));
            Assert.AreEqual("#2fd1c5", Decl(Rule(s, "." + Cls(s, "btn") + ":hover ." + c), ScreenBuilder.TintProperty));
            Assert.AreEqual("rgba(255, 255, 255, 0.4)", Decl(Rule(s, ".state-off ." + c), ScreenBuilder.TintProperty));
            Assert.AreEqual("-unity-background-image-tint-color", ScreenBuilder.TintProperty);
        }

        [Test]
        public void UntintedAsset_GetsNoTint_TintWithoutABaseColor_IsAnError()
        {
            var logo = Node("logo", "vector", ("width", "24px"), ("height", "24px"), ("color", "#ffffff"));
            logo.Asset = new IrAsset { Kind = "svg", File = "assets/logo.svg", Sha256 = new string('f', 64), Width = 24, Height = 24 };
            var s = Build(Screen(Root(logo)));
            Assert.IsNull(Decl(Rule(s, "." + Cls(s, "logo")), ScreenBuilder.TintProperty));

            var icon = Node("icon", "vector", ("width", "24px")).With("hover", ("color", "#ffffff"));
            icon.Asset = new IrAsset { Kind = "svg", File = "assets/icon.svg", Sha256 = new string('f', 64), Width = 24, Height = 24, Tint = true };
            StringAssert.Contains("color", Assert.Throws<IrFormatException>(() => Build(Screen(Root(icon)))).Message);
        }

        // ---- CSS background images -------------------------------------------------------------------------

        static IrNode Banner(params (string k, string v)[] style)
        {
            var all = new List<(string, string)> { ("width", "200px"), ("height", "100px"), ("background-image", "url(\"assets/logo.png\")") };
            all.AddRange(style);
            var n = Node("banner", "container", all.ToArray());
            n.Background = new IrAsset { Kind = "image", File = "assets/logo.png", Sha256 = new string('e', 64), Width = 64, Height = 32 };
            return n;
        }

        [Test]
        public void BackgroundImage_WritesCssInitialGeometry_AutoIsTheNaturalSize()
        {
            var s = Build(Screen(Root(Banner())));
            var r = Rule(s, "." + Cls(s, "banner"));
            Assert.AreEqual("url(\"assets/logo.png\")", Decl(r, "background-image"));
            Assert.AreEqual("64px 32px", Decl(r, "background-size"));
            Assert.AreEqual("repeat", Decl(r, "background-repeat"));
            Assert.AreEqual("0%", Decl(r, "background-position-x"));
            Assert.AreEqual("0%", Decl(r, "background-position-y"));
        }

        [Test]
        public void BackgroundImage_GeometryFromTheLayers()
        {
            var n = Banner(("background-size", "cover"), ("background-repeat", "no-repeat"), ("background-position-x", "center"), ("background-position-y", "bottom 10px"))
                .With("hover", ("background-size", "auto"), ("background-position-x", "right 4px"))
                .With("state:x", ("background-repeat", "repeat-x"), ("background-size", "50% auto"));
            var s = Build(Screen(Root(n)));
            var c = Cls(s, "banner");
            var r = Rule(s, "." + c);
            Assert.AreEqual("cover", Decl(r, "background-size"));
            Assert.AreEqual("no-repeat", Decl(r, "background-repeat"));
            Assert.AreEqual("center", Decl(r, "background-position-x"));
            Assert.AreEqual("bottom 10px", Decl(r, "background-position-y"));
            Assert.AreEqual("64px 32px", Decl(Rule(s, "." + c + ":hover"), "background-size"), "auto is the natural size");
            Assert.AreEqual("right 4px", Decl(Rule(s, "." + c + ":hover"), "background-position-x"));
            Assert.AreEqual("50% auto", Decl(Rule(s, ".state-x ." + c), "background-size"));
            Assert.AreEqual("repeat-x", Decl(Rule(s, ".state-x ." + c), "background-repeat"));
        }

        [Test]
        public void BackgroundImage_LayerSwitchesImageOrRemovesIt()
        {
            var n = Banner(("background-size", "contain"))
                .With("hover", ("background-image", "url(\"assets/logo-hover.png\")"))
                .With("state:x", ("background-image", "none"))
                .With("state:y", ("background-image", "url(\"assets/logo.png\")"), ("opacity", "0.5"));
            var s = Build(Screen(Root(n)));
            var c = Cls(s, "banner");
            Assert.AreEqual("url(\"assets/logo-hover.png\")", Decl(Rule(s, "." + c + ":hover"), "background-image"));
            Assert.AreEqual("none", Decl(Rule(s, ".state-x ." + c), "background-image"));
            Assert.IsNull(Decl(Rule(s, ".state-y ." + c), "background-image"), "the base image again: nothing to write");

            var unsized = Banner().With("hover", ("background-image", "url(\"assets/logo-hover.png\")"));
            StringAssert.Contains("background-size", Assert.Throws<UnsupportedStyleException>(() => Build(Screen(Root(unsized)))).Message);
        }

        [Test]
        public void BackgroundImage_ImgAndBakedGradient_KeepFillingTheElement()
        {
            var img = Node("pic", "image", ("width", "40px"), ("height", "40px"));
            img.Asset = new IrAsset { Kind = "image", File = "assets/pic.png", Sha256 = new string('e', 64), Width = 80, Height = 80 };
            var grad = Node("panel", "container", ("width", "40px"), ("height", "40px"), ("background-image", "linear-gradient(#000000, #ffffff)"));
            grad.Background = new IrAsset { Kind = "svg", File = "assets/grad.svg", Sha256 = new string('c', 64), Width = 40, Height = 40 };
            var s = Build(Screen(Root(img, grad)));
            foreach (var name in new[] { "pic", "panel" })
            {
                var r = Rule(s, "." + Cls(s, name));
                Assert.IsNotNull(Decl(r, "background-image"), name);
                Assert.IsNull(Decl(r, "background-size"), name + ": USS stretches the image, like an img or a gradient");
            }
        }

        [Test]
        public void BackgroundImage_OneImagePerElement_AndTheAssetMustMatch()
        {
            var two = Banner();
            two.Style["base"]["background-image"] = "linear-gradient(#000000, #ffffff), url(\"assets/logo.png\")";
            Assert.Throws<UnsupportedStyleException>(() => Build(Screen(Root(two))));
            var other = Banner();
            other.Style["base"]["background-image"] = "url(\"assets/other.png\")";
            Assert.Throws<IrFormatException>(() => Build(Screen(Root(other))));
            Assert.Throws<UnsupportedStyleException>(() => StyleMapper.Map(new Dictionary<string, string> { { "background-image", "url(\"a.png\")" } }),
                "the mapper never writes a url the compiler did not consume");
        }

        // ---- other values the IR now carries -------------------------------------------------------------

        [Test]
        public void Values_InitialAndNormalKeywords()
        {
            var t = Text("t", "T", ("font-style", "italic"), ("letter-spacing", "2px"), ("word-spacing", "normal"), ("aspect-ratio", "auto 16 / 9"))
                .With("hover", ("font-style", "normal"), ("letter-spacing", "normal"));
            var clip = Node("clip", "container", ("overflow-x", "clip"), ("overflow-y", "clip"), ("height", "4px"));
            var s = Build(Screen(Root(t, clip)));
            var c = Cls(s, "t");
            var r = Rule(s, "." + c);
            Assert.AreEqual("italic", Decl(r, "-unity-font-style"));
            Assert.AreEqual("0px", Decl(r, "word-spacing"));
            Assert.AreEqual("1.777778", Decl(r, "aspect-ratio"));
            var hover = Rule(s, "." + c + ":hover");
            Assert.AreEqual("normal", Decl(hover, "-unity-font-style"));
            Assert.AreEqual("0px", Decl(hover, "letter-spacing"));
            Assert.AreEqual("hidden", Decl(Rule(s, "." + Cls(s, "clip")), "overflow"));
        }

        [Test]
        public void Overflow_OneAxisInALayer_TheOtherFromItsBasis()
        {
            var n = Node("n", "container", ("overflow-x", "hidden"), ("overflow-y", "hidden"), ("height", "4px")).With("hover", ("overflow-x", "clip"));
            var s = Build(Screen(Root(n)));
            Assert.AreEqual("hidden", Decl(Rule(s, "." + Cls(s, "n") + ":hover"), "overflow"));
        }

        [Test]
        public void Manifest_MirrorEntriesCarryTheHostsClasses()
        {
            var card = Node("card", "container", ("width", "10px"), ("height", "10px")).With("class:is-selected", ("translate", "0 -4px"));
            card.Shadow = new IrShadow { Kind = "shadow9", File = ShadowFile, Sha256 = "x", Width = 8, Height = 8, Slice = new float[] { 2, 2, 2, 2 }, Offset = new BoxRect() };
            var json = new GeneratedManifest
            {
                mirrors = new[] { new MirrorEntry { element = "card", host = "card__shadowhost", classes = new[] { "is-selected" } }, new MirrorEntry { element = "a", host = "b" } },
            }.ToJson();
            StringAssert.Contains("\"classes\": [", json);
            Assert.AreEqual(1, json.Split(new[] { "\"classes\"" }, StringSplitOptions.None).Length - 1, "no classes field when there are none");
            CollectionAssert.AreEqual(new[] { "is-selected" }, Build(Screen(Root(card))).Find("card__shadowhost").MirrorClasses);
        }
    }
}
