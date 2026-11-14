using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using NUnit.Framework;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using static DesignUi.Editor.Tests.TestIr;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// Fonts per locale in compiled screens: element rules keep <c>var(--font-&lt;family&gt;)</c>, the shared
    /// <c>DesignFonts.uss</c> defines the variables per <c>.locale-&lt;code&gt;</c>, the screen imports it and its root
    /// carries the reference locale's class.
    /// </summary>
    public class FontMapTests
    {
        const string Out = "Assets/DesignUiFontMapTests";

        readonly List<string> _temp = new List<string>();
        readonly List<UnityEngine.Object> _objects = new List<UnityEngine.Object>();
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;
        TMP_FontAsset _alt;

        [SetUp]
        public void Setup()
        {
            FontFixture.RequireInter();
            _alt = FontFixture.CreateTmp(FontFixture.BoldTtf, "Fonts Alt", family: FontFixture.SharedFamily);
        }

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) UnityEngine.Object.DestroyImmediate(_go);
            if (_settings != null) UnityEngine.Object.DestroyImmediate(_settings);
            if (_rt != null) UnityEngine.Object.DestroyImmediate(_rt);
            foreach (var o in _objects) if (o != null) UnityEngine.Object.DestroyImmediate(o);
            _objects.Clear();
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
            FontFixture.Delete();
        }

        static string Family => FontFixture.Regular.faceInfo.familyName;

        static string Slug(string family) => Regex.Replace(family.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');

        static string TwinPath(string tmpName, bool full = false) => FontFixture.TwinFolder + "/" + tmpName + (full ? "" : " UITK") + ".asset";

        DesignUiProfile Profile(bool fonts = true)
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            _objects.Add(p);
            p.outputFolder = Out;
            p.referenceLocale = "tr";
            p.locales = new[] { "tr", "ar" };
            p.fontTwinFolder = FontFixture.TwinFolder;
            if (fonts) p.localeFonts = new[] { new LocaleFont { locale = "tr", font = FontFixture.Regular }, new LocaleFont { locale = "ar", font = _alt } };
            return p;
        }

        string Export(IrScreen ir)
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-fonts-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));
            // the line boxes come from the table: label 16/20 and caption 12/16
            File.WriteAllText(Path.Combine(dir, KitTextStyles.FileName),
                "{ \"label\": { \"fontSize\": 16, \"lineHeight\": 20, \"weight\": 400 }, \"caption\": { \"fontSize\": 12, \"lineHeight\": 16, \"weight\": 400 } }");
            return dir;
        }

        static IrScreen FontScreen(string family) =>
            TestIr.Screen(Root(Text("greeting", "Merhaba", ("color", "#ffffff"), ("font-family", "\"" + family + "\", sans-serif"))), "fonts.screen");

        /// <summary>A label in the kit style "label" (16 px in a 20 px line box) whose family is inherited from the root.</summary>
        static IrScreen StyledScreen(string family)
        {
            var label = Text("styled", "Merhaba", ("color", "#ffffff"));
            label.Text.Style = "label";
            var root = Root(label);
            root.Style["base"]["font-family"] = "\"" + family + "\"";
            return TestIr.Screen(root, "fonts.styled");
        }

        [Test]
        public void Compile_WritesDesignFontsPerLocale_TheScreenImportsIt_AndItsRootCarriesTheReferenceLocale()
        {
            var result = ScreenCompiler.Compile(Export(FontScreen(Family)), Profile(), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            CollectionAssert.Contains(result.Written.ToArray(), Out + "/" + FontMap.FileName);
            var set = AssetDatabase.LoadAssetAtPath<DesignUi.DesignFontSet>(Out + "/" + DesignUi.DesignFontSet.FileName);
            Assert.IsNotNull(set, "the locales' twins for DesignText at runtime");
            Assert.AreEqual("tr", set.referenceLocale);
            CollectionAssert.AreEqual(new[] { "tr", "ar" }, set.locales.Select(l => l.locale).ToArray());
            CollectionAssert.AreEqual(new[] { "Inter Fixture UITK", "Inter Fixture UITK r125s16", "Inter Fixture UITK r13333s12" }, set.FontsFor("tr").Select(f => f.name).ToArray());
            CollectionAssert.AreEqual(new[] { "Fonts Alt UITK", "Fonts Alt UITK r125s16", "Fonts Alt UITK r13333s12" }, set.FontsFor("ar").Select(f => f.name).ToArray());

            var slug = Slug(Family);
            var fonts = File.ReadAllText(Out + "/" + FontMap.FileName);
            string Vars(string twin) =>
                "    --font-" + slug + ": url(\"project://database/" + TwinPath(twin) + "\");\n" +
                "    --font-" + slug + "-r125s16: url(\"project://database/" + TwinPath(twin + " UITK r125s16", true) + "\");\n" +
                "    --font-" + slug + "-r13333s12: url(\"project://database/" + TwinPath(twin + " UITK r13333s12", true) + "\");\n";
            Assert.AreEqual(
                "/* auto-generated by com.ertugrulgaziakcan.design-ui */\n" +
                "\n.locale-tr {\n" + Vars("Inter Fixture") + "}\n" +
                "\n.locale-ar {\n" + Vars("Fonts Alt") + "}\n",
                fonts, "per locale, the family's twin and its line-box variants");

            var uss = File.ReadAllText(Out + "/FontsScreen/FontsScreen.uss");
            StringAssert.StartsWith("/* auto-generated by com.ertugrulgaziakcan.design-ui */\n@import url(\"../" + FontMap.FileName + "\");\n", uss);
            StringAssert.Contains("-unity-font-definition: var(--font-" + slug + ");", uss, "element rules keep the variable");
            var uxml = File.ReadAllText(Out + "/FontsScreen/FontsScreen.uxml");
            StringAssert.IsMatch("<dui:DesignScreen name=\"root\" class=\"[^\"]* locale-tr\" fonts=\"../" + DesignFontSet.FileName + "\"", uxml,
                "the root carries the reference locale and references the font set");
            var screen = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/FontsScreen/FontsScreen.uxml");
            Assert.IsFalse(screen.importedWithErrors || screen.importedWithWarnings, "the font set reference resolves at import");
            Assert.AreSame(AssetDatabase.LoadAssetAtPath<DesignFontSet>(Out + "/" + DesignFontSet.FileName), (screen.Instantiate().Q("root") as DesignScreen)?.Fonts);
            AssetDatabase.ImportAsset(Out + "/FontsScreen/FontsScreen.uxml", ImportAssetOptions.ForceUpdate | ImportAssetOptions.ForceSynchronousImport);
            screen = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/FontsScreen/FontsScreen.uxml");
            Assert.IsNotNull((screen.Instantiate().Q("root") as DesignScreen)?.Fonts, "a reimport resolves the reference again");

            foreach (var name in new[] { "Inter Fixture", "Fonts Alt", "Inter Fixture Bold" })
                foreach (var suffix in new[] { "", " r125s16", " r13333s12" })
                    Assert.IsNotNull(AssetDatabase.LoadAssetAtPath<FontAsset>(TwinPath(name + " UITK" + suffix, true)), "twin of " + name + suffix);
            var sheet = AssetDatabase.LoadAssetAtPath<StyleSheet>(Out + "/" + FontMap.FileName);
            Assert.IsNotNull(sheet);
            Assert.IsFalse(sheet.importedWithErrors || sheet.importedWithWarnings, "the twin urls resolve at import");

            var again = ScreenCompiler.Compile(Export(FontScreen(Family)), Profile(), false, NoView());
            Assert.IsTrue(again.Ok, string.Join("\n", again.Errors));
            CollectionAssert.IsEmpty(again.Written, "an unchanged font setup writes nothing");
        }

        [UnityTest]
        public IEnumerator CompiledScreen_ResolvesTheFontVariable_AndTheRootLocaleClassSwitchesIt()
        {
            var result = ScreenCompiler.Compile(Export(FontScreen(Family)), Profile(), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/FontsScreen/FontsScreen.uxml");
            var sheet = AssetDatabase.LoadAssetAtPath<StyleSheet>(Out + "/FontsScreen/FontsScreen.uss");
            Assert.IsFalse(sheet.importedWithErrors || sheet.importedWithWarnings, "the @import of DesignFonts.uss resolves");
            var tr = AssetDatabase.LoadAssetAtPath<FontAsset>(TwinPath("Inter Fixture"));
            var ar = AssetDatabase.LoadAssetAtPath<FontAsset>(TwinPath("Fonts Alt"));
            Assert.AreNotSame(tr, ar);

            _rt = new RenderTexture(256, 256, 24);
            _settings = UnityEngine.Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _go = new GameObject("FontMapTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            for (int i = 0; i < 2; i++) yield return null;
            var tree = vta.Instantiate();
            doc.rootVisualElement.Add(tree);
            for (int i = 0; i < 5; i++) yield return null;

            var root = tree.Q("root");
            var label = tree.Q<Label>("greeting");
            Assert.IsTrue(root.ClassListContains("locale-tr"));
            Assert.AreSame(tr, label.resolvedStyle.unityFontDefinition.fontAsset, "var(--font-…) resolves to the reference locale's twin");
            Assert.Greater(label.layout.width, 0f, "the twin renders text");

            root.RemoveFromClassList("locale-tr");
            root.AddToClassList("locale-ar");
            for (int i = 0; i < 3; i++) yield return null;
            Assert.AreSame(ar, label.resolvedStyle.unityFontDefinition.fontAsset, "swapping the root's locale class switches the font");
        }

        [UnityTest]
        public IEnumerator CompiledLabelInAKitStyle_UsesTheLineBoxVariant_AndIsExactlyTheCssLineBoxTall()
        {
            var export = Export(StyledScreen(Family));
            File.WriteAllText(Path.Combine(export, KitTextStyles.FileName), "{ \"label\": { \"fontSize\": 16, \"lineHeight\": 20, \"weight\": 400 } }");
            var result = ScreenCompiler.Compile(export, Profile(), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var uss = File.ReadAllText(Out + "/FontsStyled/FontsStyled.uss");
            StringAssert.Contains("-unity-font-definition: var(--font-" + Slug(Family) + "-r125s16);", uss, "the inherited family's 16/20 variant");

            _rt = new RenderTexture(256, 64, 24);
            _settings = UnityEngine.Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _go = new GameObject("FontMapTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            for (int i = 0; i < 2; i++) yield return null;
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/FontsStyled/FontsStyled.uxml").Instantiate();
            doc.rootVisualElement.Add(tree);
            for (int i = 0; i < 5; i++) yield return null;
            var label = tree.Q<Label>("styled");
            Assert.AreSame(AssetDatabase.LoadAssetAtPath<FontAsset>(TwinPath("Inter Fixture UITK r125s16", true)), label.resolvedStyle.unityFontDefinition.fontAsset);
            Assert.AreEqual(20f, label.layout.height, 1e-4f, "one line is the 20 px CSS line box");
        }

        [Test]
        public void Compile_FontFamilyWithoutAFontForALocale_FailsNamingTheLocale()
        {
            var profile = Profile();
            profile.locales = new[] { "tr", "ja" };
            var hooks = new CompileHooks { Fonts = new ProfileLocaleFontResolver(profile, null), ViewCode = _ => null };
            var result = ScreenCompiler.Compile(Export(FontScreen(Family)), profile, false, hooks);
            Assert.IsFalse(result.Ok);
            var errors = string.Join("\n", result.Errors);
            StringAssert.Contains("'ja'", errors);
            StringAssert.Contains(Slug(Family), errors);
            Assert.IsFalse(AssetDatabase.IsValidFolder(Out), "nothing is written");
        }

        [Test]
        public void Compile_FontFamilyThatIsNoLocaleFont_Fails()
        {
            var result = ScreenCompiler.Compile(Export(FontScreen("Comic Sans")), Profile(), false, NoView());
            Assert.IsFalse(result.Ok);
            var errors = string.Join("\n", result.Errors);
            StringAssert.Contains("comic-sans", errors);
            StringAssert.Contains(Family, errors, "names the project's font families");
        }

        [Test]
        public void Compile_ScreenWithoutFonts_NeedsNoFontSetup()
        {
            var ir = TestIr.Screen(Root(Node("box", "container", ("width", "10px"), ("height", "10px"))), "fonts.none");
            var result = ScreenCompiler.Compile(Export(ir), Profile(fonts: false), false, new CompileHooks { Fonts = new ProfileLocaleFontResolver(Profile(fonts: false), null), ViewCode = _ => null });
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            Assert.AreEqual("/* auto-generated by com.ertugrulgaziakcan.design-ui */\n", File.ReadAllText(Out + "/" + FontMap.FileName));
            StringAssert.Contains("locale-tr", File.ReadAllText(Out + "/FontsNone/FontsNone.uxml"));
        }

        [Test]
        public void Compile_LocaleCodeThatIsNoClassName_Fails()
        {
            var profile = Profile();
            profile.locales = new[] { "tr", "zh Hans" };
            var result = ScreenCompiler.Compile(Export(FontScreen(Family)), profile, false, NoView());
            Assert.IsFalse(result.Ok);
            StringAssert.Contains("'zh Hans'", string.Join("\n", result.Errors));
        }

        [Test]
        public void FontDefinitionFor_IsTheUrlOfTheLocalesTwin()
        {
            var profile = Profile();
            var resolver = FontMap.DefaultResolver(profile);
            Assert.AreEqual("url(\"project://database/" + TwinPath("Fonts Alt") + "\")", FontMap.FontDefinitionFor(Family, "ar", profile, resolver));
            Assert.AreEqual("url(\"project://database/" + TwinPath("Inter Fixture") + "\")", FontMap.FontDefinitionFor(Family, "tr", profile, resolver));
            Assert.Throws<FontSetupException>(() => FontMap.FontDefinitionFor("Comic Sans", "tr", profile, resolver));
            Assert.Throws<FontSetupException>(() => FontMap.FontDefinitionFor(Family, "ja", profile, new ProfileLocaleFontResolver(profile, null)));
        }
    }
}
