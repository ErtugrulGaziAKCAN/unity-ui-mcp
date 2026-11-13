using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;
using static DesignUi.Editor.Tests.TestIr;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The exporter's baked effects in the compiler: outer and inset shadows per layer (<c>shadowLayers</c>,
    /// <c>insetShadow</c>, <c>insetShadowLayers</c>), gradients per layer (<c>backgroundLayers</c>), <c>stopGap</c>, and
    /// layers that exist only in those maps.
    /// </summary>
    public class EffectLayerTests
    {
        static readonly Dictionary<string, double> Kit = new Dictionary<string, double> { { "label", 16 }, { "title", 32 } };

        static CompiledScreen Build(IrScreen ir) => ScreenBuilder.Build(ir, RelativeAsset, null, Kit);

        static string Cls(CompiledScreen s, string name)
        {
            var e = s.Find(name);
            Assert.IsNotNull(e, "element " + name);
            return e.Classes.Single(c => c.StartsWith("s-", StringComparison.Ordinal));
        }

        static UssRule Rule(CompiledScreen s, string selector)
        {
            var rules = s.Rules.Where(r => r.Selector == selector).ToList();
            Assert.AreEqual(1, rules.Count, "one rule '" + selector + "' in:\n" + UssWriter.Write(s));
            return rules[0];
        }

        static string Decl(UssRule r, string property)
        {
            var d = r.Declarations.Where(x => x.Property == property).ToList();
            Assert.AreEqual(1, d.Count, property + " in " + r.Selector);
            return d[0].Value;
        }

        static bool Has(UssRule r, string property) => r.Declarations.Any(x => x.Property == property);

        static IrShadow Sh(string name, float x, float y, float w, float h, float slice = 40) => new IrShadow
        {
            Kind = "shadow9", File = "assets/" + name + ".png", Sha256 = new string('d', 64), Width = 96, Height = 96,
            Slice = new[] { slice, slice, slice, slice }, Offset = new BoxRect { X = x, Y = y, W = w, H = h },
        };

        static IrAsset Svg(string name, float stopGap = 0.25f) =>
            new IrAsset { Kind = "svg", File = "assets/" + name + ".svg", Sha256 = new string('c', 64), Width = 100, Height = 50, StopGap = stopGap };

        static IrAsset Png(string name) => new IrAsset { Kind = "image", File = "assets/" + name + ".png", Sha256 = new string('e', 64), Width = 40, Height = 40 };

        static Dictionary<string, string> B(IrNode n) => n.Style["base"];

        // ---- reading ---------------------------------------------------------------------------------------

        [Test]
        public void Reader_ReadsTheEffectFieldsOfTheContractSample()
        {
            var root = IrReader.Read(IrReaderTests.SamplePath()).Root;
            Assert.AreEqual(0.25f, root.Background.StopGap);
            Assert.AreEqual(0.5f, root.BackgroundLayers["state:loading"].StopGap);
            var card = root.Children[1];
            Assert.AreEqual(-27f, card.Shadow.Offset.X);
            CollectionAssert.AreEqual(new[] { 59f, 62f, 59f, 62f }, card.Shadow.Slice, "CSS box order top, right, bottom, left");
            Assert.IsNull(card.Shadow.StopGap);
            Assert.AreEqual(78f, card.ShadowLayers["hover"].Offset.W);
            Assert.IsTrue(card.ShadowLayers.ContainsKey("state:loading"));
            Assert.IsNull(card.ShadowLayers["state:loading"], "null: no shadow in this layer");
            Assert.IsNull(card.InsetShadow);
            CollectionAssert.IsEmpty(card.InsetShadowLayers);
            var play = root.Children[2];
            CollectionAssert.AreEqual(new[] { 18f, 17f, 14f, 17f }, play.InsetShadow.Slice);
            Assert.IsNull(play.InsetShadowLayers["active"]);
            CollectionAssert.IsEmpty(play.BackgroundLayers);
        }

        static string WriteIr(string node)
        {
            var path = Path.Combine(Path.GetTempPath(), "design-ui-effects-" + Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(path, "{\"irVersion\":1,\"screen\":\"s\",\"root\":{\"id\":\"root\",\"kind\":\"container\"," + node + "}}");
            return path;
        }

        const string Shadow9 = "{\"kind\":\"shadow9\",\"file\":\"s.png\",\"sha256\":\"x\",\"width\":8,\"height\":8,\"slice\":[2,2,2,2],\"offset\":{\"x\":0,\"y\":0,\"w\":0,\"h\":0},\"tint\":false,\"stopGap\":null}";

        [TestCase("\"shadowLayers\":{\"hover+state:x\":null}", "canonical order")]
        [TestCase("\"insetShadowLayers\":{\"base\":null}", "names 'base'")]
        [TestCase("\"backgroundLayers\":{\"hover:x\":null}", "malformed")]
        [TestCase("\"shadowLayers\":{\"hover\":" + Shadow9 + "}", null)]
        [TestCase("\"insetShadow\":{\"kind\":\"shadow9\",\"file\":\"s.png\",\"sha256\":\"x\",\"width\":8,\"height\":8,\"slice\":[2,2,2,2],\"tint\":false}", "no offset")]
        [TestCase("\"shadowLayers\":{\"hover\":{\"kind\":\"shadow9\",\"file\":\"s.png\",\"sha256\":\"x\",\"width\":8,\"height\":8,\"slice\":[2,2,2,2],\"offset\":{\"x\":0,\"y\":0,\"w\":0,\"h\":0},\"tint\":true}}", "tinted")]
        [TestCase("\"insetShadowLayers\":{\"active\":{\"kind\":\"shadow9\",\"file\":\"s.png\",\"sha256\":\"x\",\"width\":8,\"height\":8,\"slice\":null,\"offset\":{\"x\":0,\"y\":0,\"w\":0,\"h\":0},\"tint\":false}}", "9-slice")]
        public void Reader_ValidatesTheEffectMaps(string fields, string error)
        {
            var path = WriteIr(fields);
            try
            {
                if (error == null) { Assert.DoesNotThrow(() => IrReader.Read(path)); return; }
                StringAssert.Contains(error, Assert.Throws<IrFormatException>(() => IrReader.Read(path)).Message);
            }
            finally { File.Delete(path); }
        }

        [Test]
        public void Reader_IrWithoutEffectMaps_ReadsThemAsEmpty()
        {
            var path = WriteIr("\"children\":[]");
            try
            {
                var root = IrReader.Read(path).Root;
                CollectionAssert.IsEmpty(root.ShadowLayers);
                CollectionAssert.IsEmpty(root.InsetShadowLayers);
                CollectionAssert.IsEmpty(root.BackgroundLayers);
                Assert.IsNull(root.InsetShadow);
            }
            finally { File.Delete(path); }
        }

        // ---- outer shadows per layer -------------------------------------------------------------------------

        static IrNode LiftCard()
        {
            var card = Node("card", "container", ("width", "600px"), ("height", "300px"));
            card.Classes = new[] { "is-selected" };
            card.Shadow = Sh("base", -27, -19, 54, 54, 59);
            card.ShadowLayers["hover"] = Sh("lift", -39, -27, 78, 78, 71);
            card.ShadowLayers["state:loading"] = null;
            card.ShadowLayers["class:is-selected"] = Sh("sel", 0, 8, 0, 0, 4);
            return card;
        }

        [Test]
        public void ShadowLayers_GiveTheImageAPlacementAndAnImagePerLayer_ThroughTheHostsMirrorClasses()
        {
            var root = Lowering.Apply(Root(LiftCard()));
            var host = root.Children[0];
            Assert.AreEqual("card__shadowhost", host.Id);
            var shadow = host.Children[0];
            var card = host.Children[1];
            Assert.IsNull(card.Shadow);
            CollectionAssert.IsEmpty(card.ShadowLayers, "the layers moved to the shadow image");

            // the drawn rect: (x + ox, y + oy, w + ow, h + oh) of the border box
            Assert.AreEqual("absolute", B(shadow)["position"]);
            Assert.AreEqual("-27px", B(shadow)["left"]);
            Assert.AreEqual("-19px", B(shadow)["top"]);
            Assert.AreEqual("-27px", B(shadow)["right"]);
            Assert.AreEqual("-35px", B(shadow)["bottom"]);
            Assert.AreEqual("assets/base.png", shadow.Asset.File);

            const string hover = "anc(card__shadowhost):class:dui-hover";
            Assert.AreEqual("-39px", shadow.Style[hover]["left"]);
            Assert.AreEqual("-27px", shadow.Style[hover]["top"]);
            Assert.AreEqual("-39px", shadow.Style[hover]["right"]);
            Assert.AreEqual("-51px", shadow.Style[hover]["bottom"]);
            Assert.AreEqual("assets/lift.png", shadow.AssetLayers[hover].File);
            Assert.IsInstanceOf<IrAsset>(shadow.AssetLayers[hover]);

            Assert.IsTrue(shadow.AssetLayers.ContainsKey("state:loading"));
            Assert.IsNull(shadow.AssetLayers["state:loading"], "no shadow while loading");
            Assert.IsFalse(shadow.Style.ContainsKey("state:loading"), "nothing to place");

            const string selected = "anc(card__shadowhost):class:is-selected";
            Assert.AreEqual("8px", shadow.Style[selected]["top"]);
            Assert.IsTrue(host.MirrorPseudoState, "the hover layer needs the pseudo-state mirror");
            CollectionAssert.AreEqual(new[] { "is-selected" }, host.MirrorClasses, "the view toggles the element's class on the host too");
            CollectionAssert.AreEqual(new[] { "is-selected" }, host.Classes, "the host starts with the element's class");
        }

        [Test]
        public void ShadowOnlyInALayer_StillGetsAHost_WhoseImageDrawsNothingInBase()
        {
            var card = Node("card", "container", ("width", "100px"), ("height", "50px"));
            card.ShadowLayers["hover"] = Sh("lift", -10, -6, 20, 20);
            var host = Lowering.Apply(Root(card)).Children[0];
            Assert.AreEqual("card__shadowhost", host.Id);
            var shadow = host.Children[0];
            Assert.IsNull(shadow.Asset);
            Assert.AreEqual("0px", B(shadow)["left"]);
            Assert.AreEqual("-10px", shadow.Style["anc(card__shadowhost):class:dui-hover"]["left"]);

            var s = Build(Screen(Root(Node("card", "container", ("width", "100px"), ("height", "50px")).Add())));
            Assert.IsNull(s.Find("card__shadowhost"), "no shadow, no host");
            var ir = Screen(Root(card));
            Assert.IsFalse(Rule(Build(ir), "." + Cls(Build(ir), "card__shadow")).Declarations.Any(d => d.Property == "background-image"));
        }

        [Test]
        public void ShadowLayers_OnTheRoot_Throw()
        {
            var root = Root();
            root.ShadowLayers["hover"] = Sh("lift", 0, 4, 0, 0);
            StringAssert.Contains("needs a parent", Assert.Throws<IrFormatException>(() => Lowering.Apply(root)).Message);
        }

        [Test]
        public void ShadowLayers_CompileToRulesUnderTheHostsMirrorClass()
        {
            var s = Build(Screen(Root(LiftCard())));
            var host = Cls(s, "card__shadowhost");
            var shadow = Cls(s, "card__shadow");
            var b = Rule(s, "." + shadow);
            Assert.AreEqual("url(\"assets/base.png\")", Decl(b, "background-image"));
            Assert.AreEqual("59", Decl(b, "-unity-slice-top"));
            Assert.AreEqual("-27px", Decl(b, "left"));

            var hover = Rule(s, "." + host + ".dui-hover ." + shadow);
            Assert.AreEqual("url(\"assets/lift.png\")", Decl(hover, "background-image"));
            Assert.AreEqual("71", Decl(hover, "-unity-slice-left"));
            Assert.AreEqual("-39px", Decl(hover, "left"));
            Assert.AreEqual("-51px", Decl(hover, "bottom"));

            var loading = Rule(s, ".state-loading ." + shadow);
            Assert.AreEqual("none", Decl(loading, "background-image"));
            Assert.AreEqual(1, loading.Declarations.Count);

            Assert.AreEqual("url(\"assets/sel.png\")", Decl(Rule(s, "." + host + ".is-selected ." + shadow), "background-image"));
            Assert.IsTrue(s.Find("card__shadowhost").MirrorHost);
            Assert.AreEqual("card", s.Find("card__shadowhost").MirrorElement);
        }

        [Test]
        public void APressedOrFocusedEffectLayerAlone_MakesTheElementPressableOrFocusable()
        {
            // :active { box-shadow: none } leaves no style layer, only an effect layer
            var pressed = Node("pressed", "container", ("height", "20px"));
            pressed.Shadow = Sh("base", 0, 4, 0, 0);
            pressed.ShadowLayers["active"] = null;
            var focused = Node("focused", "container", ("height", "20px"));
            focused.InsetShadowLayers["focus"] = Sh("ring", 0, 0, 0, 0, 3);
            var tinted = Node("tinted", "container", ("height", "20px"));
            tinted.BackgroundLayers["active"] = Svg("pressed");
            var s = Build(Screen(Root(pressed, focused, tinted)));
            Assert.IsTrue(s.Find("pressed").Clickable, "a Clickable sets :active");
            Assert.IsFalse(s.Find("pressed__shadowhost").Clickable);
            Assert.IsTrue(s.Find("focused").Attributes.Any(a => a.Key == "focusable" && a.Value == "true"));
            Assert.IsTrue(s.Find("tinted").Clickable);
            Assert.AreEqual("url(\"assets/pressed.svg\")", Decl(Rule(s, "." + Cls(s, "tinted") + ":active"), "background-image"));
            Assert.AreEqual("none", Decl(Rule(s, "." + Cls(s, "pressed__shadowhost") + ".dui-active ." + Cls(s, "pressed__shadow")), "background-image"));
        }

        // ---- inset shadows ---------------------------------------------------------------------------------

        static IrNode Pressable()
        {
            var play = Node("play", "button", ("display", "flex"), ("flex-direction", "row"), ("gap", "6px"), ("border-left-width", "2px"))
                .Add(Text("a", "A", ("color", "#ffffff")), Text("b", "B", ("color", "#ffffff")));
            play.InsetShadow = Sh("well", 2, 0, -2, 0, 17);
            play.InsetShadowLayers["active"] = null;
            play.InsetShadowLayers["state:loading+hover"] = Sh("deep", 2, 0, -2, 0, 9);
            return play;
        }

        [Test]
        public void InsetShadow_BecomesTheFirstChild_AnAbsoluteOverlayOfThePaddingBox()
        {
            var play = Lowering.Apply(Root(Pressable())).Children[0];
            Assert.IsNull(play.InsetShadow);
            CollectionAssert.IsEmpty(play.InsetShadowLayers);
            CollectionAssert.AreEqual(new[] { "play__inset", "a", "b" }, play.Children.Select(c => c.Id).ToArray(), "above the background, below the content");
            var inset = play.Children[0];
            Assert.AreEqual("image", inset.Kind);
            Assert.IsTrue(inset.PickingIgnore);
            Assert.AreEqual("absolute", B(inset)["position"]);
            foreach (var side in new[] { "left", "top", "right", "bottom" }) Assert.AreEqual("0px", B(inset)[side], side + ": UI Toolkit places it inside the border");
            Assert.AreEqual("assets/well.png", inset.Asset.File);
            Assert.IsTrue(inset.AssetLayers.ContainsKey("anc(play):active"));
            Assert.IsNull(inset.AssetLayers["anc(play):active"]);
            Assert.AreEqual("assets/deep.png", inset.AssetLayers["state:loading+anc(play):hover"].File);
            // the overlay is absolute: the gap still starts after the first content child
            Assert.IsFalse(B(play.Children[1]).ContainsKey("margin-left"));
            Assert.AreEqual("6px", B(play.Children[2])["margin-left"]);
        }

        [Test]
        public void InsetShadow_CompilesUnderTheElementsOwnPseudoState()
        {
            var s = Build(Screen(Root(Pressable())));
            var play = Cls(s, "play");
            var inset = Cls(s, "play__inset");
            Assert.AreSame(s.Find("play__inset"), s.Find("play").Children[0]);
            Assert.IsTrue(s.Find("play__inset").PickingIgnore);
            var b = Rule(s, "." + inset);
            Assert.AreEqual("url(\"assets/well.png\")", Decl(b, "background-image"));
            Assert.AreEqual("17", Decl(b, "-unity-slice-right"));
            Assert.AreEqual("absolute", Decl(b, "position"));
            Assert.AreEqual("none", Decl(Rule(s, "." + play + ":active ." + inset), "background-image"));
            Assert.AreEqual("url(\"assets/deep.png\")", Decl(Rule(s, ".state-loading ." + play + ":hover ." + inset), "background-image"));
        }

        [Test]
        public void InsetShadow_OnElementsThatDrawTheirOwnContent_IsRejectedWithAFix()
        {
            var label = Text("label", "Oyna", ("color", "#ffffff"));
            label.InsetShadow = Sh("well", 0, 0, 0, 0);
            StringAssert.Contains("child element", Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(Root(label))).Message);

            var field = Node("field", "input", ("height", "20px"));
            field.InsetShadowLayers["focus"] = Sh("well", 0, 0, 0, 0);
            StringAssert.Contains("wrapper", Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(Root(field))).Message);

            var area = Node("area", "scroll", ("height", "20px"), ("overflow-y", "auto"));
            area.InsetShadow = Sh("well", 0, 0, 0, 0);
            StringAssert.Contains("scroll with the content", Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(Root(area))).Message);
        }

        [Test]
        public void InsetShadow_OnAnInlineRepeat_IsNotOneOfItsItems()
        {
            // the exporter keeps one template item (the first sample) under a repeat container
            var items = Node("items", "container", ("display", "flex"), ("flex-direction", "column")).Add(Node("item", "container", ("height", "10px")));
            items.Repeat = new IrRepeat { Name = "item", Mode = "inline", Count = 3 };
            items.InsetShadow = Sh("well", 0, 0, 0, 0);
            var s = Build(Screen(Root(items)));
            var repeat = s.Repeats.Single();
            CollectionAssert.AreEqual(new[] { "item" }, repeat.Items.Select(i => i.Name).ToArray());
            Assert.IsTrue(s.Find("items").Children[1].Classes.Contains(ScreenBuilder.FirstItemClass), "the first item, not the overlay, is first");
        }

        // ---- background images per layer -------------------------------------------------------------------

        [Test]
        public void GradientLayers_BecomeLayerImages_AndUrlImagesStayInTheStyleLayers()
        {
            var grad = Node("grad", "container", ("height", "50px"));
            grad.Background = Svg("base");
            grad.BackgroundLayers["state:loading"] = Svg("loading", 0.5f);
            grad.BackgroundLayers["hover"] = null;
            var url = Node("url", "container", ("height", "50px"), ("background-image", "url(\"assets/a.png\")")).With("hover", ("background-image", "url(\"assets/b.png\")"));
            url.Background = Png("a");
            url.BackgroundLayers["hover"] = Png("b");
            var r = Lowering.Apply(Root(grad, url));
            var g = r.Children[0];
            CollectionAssert.IsEmpty(g.BackgroundLayers);
            Assert.AreEqual("assets/loading.svg", g.AssetLayers["state:loading"].File);
            Assert.AreEqual(0.5f, g.AssetLayers["state:loading"].StopGap);
            Assert.IsNull(g.AssetLayers["hover"]);
            CollectionAssert.IsEmpty(r.Children[1].AssetLayers, "the style layers already switch the url() image");

            var mixed = Node("mixed", "container", ("height", "50px"), ("background-image", "url(\"assets/a.png\")"));
            mixed.Background = Png("a");
            mixed.BackgroundLayers["hover"] = Svg("lift");
            StringAssert.Contains("child element", Assert.Throws<UnsupportedStyleException>(() => Lowering.Apply(Root(mixed))).Message);
        }

        [Test]
        public void GradientLayers_ReplaceTheBackgroundImageWhileTheirLayerHolds_EvenWithoutAStyleLayer()
        {
            var root = Root();
            root.Background = Svg("base");
            root.BackgroundLayers["state:loading"] = Svg("loading");
            var panel = Node("panel", "container", ("height", "50px"));
            panel.Background = Svg("panel");
            panel.BackgroundLayers["hover"] = null;
            root.Add(panel);
            var s = Build(Screen(root));
            var rc = Cls(s, "root");
            Assert.AreEqual("url(\"assets/base.svg\")", Decl(Rule(s, "." + rc), "background-image"));
            Assert.AreEqual("url(\"assets/loading.svg\")", Decl(Rule(s, "." + rc + ".state-loading"), "background-image"));
            Assert.AreEqual("none", Decl(Rule(s, "." + Cls(s, "panel") + ":hover"), "background-image"));
            Assert.IsFalse(Has(Rule(s, "." + rc + ".state-loading"), "-unity-slice-left"), "a gradient is stretched, not sliced");
        }

        [Test]
        public void ImageWithAGradientOnlyInALayer_MovesItsContentToAChild()
        {
            var img = Node("pic", "image", ("width", "40px"), ("height", "40px"));
            img.Asset = Png("pic");
            img.BackgroundLayers["hover"] = Svg("glow");
            var s = Build(Screen(Root(img)));
            Assert.IsFalse(Has(Rule(s, "." + Cls(s, "pic")), "background-image"), "the content image is not the element's background");
            Assert.AreEqual("url(\"assets/glow.svg\")", Decl(Rule(s, "." + Cls(s, "pic") + ":hover"), "background-image"));
            Assert.AreEqual("url(\"assets/pic.png\")", Decl(Rule(s, "." + Cls(s, "pic__image")), "background-image"));
            Assert.AreSame(s.Find("pic__image"), s.Find("pic").Children[0]);
        }

        [Test]
        public void ImageWithAGradientBackground_KeepsBoth()
        {
            var img = Node("pic", "image", ("width", "40px"), ("height", "40px"));
            img.Asset = Png("pic");
            img.Background = Svg("grad");
            var s = Build(Screen(Root(img)));
            Assert.AreEqual("url(\"assets/grad.svg\")", Decl(Rule(s, "." + Cls(s, "pic")), "background-image"));
            Assert.AreEqual("url(\"assets/pic.png\")", Decl(Rule(s, "." + Cls(s, "pic__image")), "background-image"));
        }

        [Test]
        public void ImageWithAnInsetShadow_PaintsTheShadowThenTheContent()
        {
            var img = Node("pic", "image", ("width", "40px"), ("height", "40px"));
            img.Asset = Png("pic");
            img.Background = Svg("grad");
            img.InsetShadow = Sh("well", 0, 0, 0, 0, 6);
            var s = Build(Screen(Root(img)));
            CollectionAssert.AreEqual(new[] { "pic__inset", "pic__image" }, s.Find("pic").Children.Select(c => c.Name).ToArray());
            Assert.AreEqual("url(\"assets/grad.svg\")", Decl(Rule(s, "." + Cls(s, "pic")), "background-image"), "background, then inset shadow, then content");

            // an element painted only by a url() background keeps it: CSS paints a background below the inset shadow
            var banner = Node("banner", "container", ("width", "40px"), ("height", "20px"), ("background-image", "url(\"assets/b.png\")"));
            banner.Asset = Png("b");
            banner.InsetShadow = Sh("well", 0, 0, 0, 0, 6);
            var t = Build(Screen(Root(banner)));
            CollectionAssert.AreEqual(new[] { "banner__inset" }, t.Find("banner").Children.Select(c => c.Name).ToArray());
            Assert.AreEqual("url(\"assets/b.png\")", Decl(Rule(t, "." + Cls(t, "banner")), "background-image"));
        }

        // ---- object-fit (lowered) ----------------------------------------------------------------------------

        [Test]
        public void ObjectFit_ScalesTheContentImageWhereItIsPainted()
        {
            var img = Node("pic", "image", ("width", "40px"), ("height", "40px"), ("object-fit", "contain")).With("hover", ("object-fit", "cover"));
            img.Asset = Png("pic");
            var s = Build(Screen(Root(img)));
            Assert.AreEqual("scale-to-fit", Decl(Rule(s, "." + Cls(s, "pic")), "-unity-background-scale-mode"));
            Assert.AreEqual("scale-and-crop", Decl(Rule(s, "." + Cls(s, "pic") + ":hover"), "-unity-background-scale-mode"));
            Assert.IsFalse(UssWriter.Write(s).Contains("object-fit"));

            // under a gradient the image is the content child's background: its scale mode follows it, the element's hover included
            var framed = Node("pic", "image", ("width", "40px"), ("height", "40px"), ("object-fit", "fill")).With("hover", ("object-fit", "cover"));
            framed.Asset = Png("pic");
            framed.Background = Svg("frame");
            var t = Build(Screen(Root(framed)));
            Assert.IsFalse(Has(Rule(t, "." + Cls(t, "pic")), "-unity-background-scale-mode"));
            Assert.AreEqual("stretch-to-fill", Decl(Rule(t, "." + Cls(t, "pic__image")), "-unity-background-scale-mode"));
            Assert.AreEqual("scale-and-crop", Decl(Rule(t, "." + Cls(t, "pic") + ":hover ." + Cls(t, "pic__image")), "-unity-background-scale-mode"));

            // CSS applies object-fit to replaced content only
            var box = Build(Screen(Root(Node("box", "container", ("height", "10px"), ("object-fit", "cover")))));
            Assert.IsFalse(UssWriter.Write(box).Contains("scale-mode"));
        }

        [Test]
        public void TintableIconWithAGradientLayer_IsRejectedWithAFix()
        {
            var icon = Node("icon", "vector", ("width", "8px"), ("height", "8px"), ("color", "#ff0000"));
            icon.Asset = new IrAsset { Kind = "svg", File = "assets/i.svg", Sha256 = new string('a', 64), Width = 8, Height = 8, Tint = true };
            icon.BackgroundLayers["hover"] = Svg("glow");
            StringAssert.Contains("child element", Assert.Throws<UnsupportedStyleException>(() => Build(Screen(Root(icon)))).Message);
        }
    }
}
