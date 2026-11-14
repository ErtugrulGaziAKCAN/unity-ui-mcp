using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using TMPro;
using UnityEditor;
using UnityEngine;
using static DesignUi.Editor.Tests.TestIr;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The profile's project font resolver (<see cref="DesignUiProfile.fontResolver"/>, a <see cref="DesignUiFontResolver"/>
    /// asset): kit sync, the compile and the status window ask it which TMP font renders each locale; a locale it gives no font
    /// for falls back to the profile's locale fonts over TMP Settings. A missing or throwing resolver is a clear error.
    /// </summary>
    public class ProjectFontResolverTests
    {
        const string Folder = FontFixture.Folder + "/Resolver";
        const string ProfilePath = Folder + "/Resolver Profile.asset";
        const string ResolverPath = Folder + "/Game Fonts.asset";
        const string Out = Folder + "/Generated";

        readonly List<string> _temp = new List<string>();
        TMP_FontAsset _mapped, _answered, _arabic;

        [SetUp]
        public void Setup()
        {
            _mapped = FontFixture.CreateTmp(FontFixture.RegularTtf, "Resolver Mapped", family: "Kit Mapped Sans");
            _answered = FontFixture.CreateTmp(FontFixture.RegularTtf, "Resolver Answer", family: "Kit Resolver Sans");
            _arabic = FontFixture.CreateTmp(FontFixture.RegularTtf, "Resolver Arabic", family: "Kit Arabic Sans");
            if (!AssetDatabase.IsValidFolder(Folder)) AssetDatabase.CreateFolder(FontFixture.Folder, "Resolver");
        }

        [TearDown]
        public void Cleanup()
        {
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            FontFixture.Delete();
        }

        /// <summary>A profile asset whose own mapping is tr → "Kit Mapped Sans", ar → "Kit Arabic Sans".</summary>
        DesignUiProfile Profile()
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            p.referenceLocale = "tr";
            p.locales = new[] { "tr", "ar" };
            p.localeFonts = new[] { new LocaleFont { locale = "tr", font = _mapped }, new LocaleFont { locale = "ar", font = _arabic } };
            p.fontTwinFolder = FontFixture.TwinFolder;
            p.outputFolder = Out;
            AssetDatabase.CreateAsset(p, ProfilePath);
            return p;
        }

        /// <summary>A resolver asset that gives tr "Kit Resolver Sans" (and no font for ar), set on the profile.</summary>
        FixtureFontResolver Resolver(DesignUiProfile profile, string throwMessage = null)
        {
            var r = ScriptableObject.CreateInstance<FixtureFontResolver>();
            r.fonts = new[] { new LocaleFont { locale = "tr", font = _answered } };
            r.throwMessage = throwMessage;
            AssetDatabase.CreateAsset(r, ResolverPath);
            profile.fontResolver = r;
            FontFixture.Save(profile);
            return r;
        }

        string Kit()
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-kit-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            File.WriteAllText(dir + "/kit.config.json", "{\"fontsCss\":\"fonts/fonts.css\",\"textStyles\":\"text-styles.json\",\"locales\":[\"tr\"]}\n");
            File.WriteAllText(dir + "/text-styles.json", "{ \"label\": { \"fontSize\": 16, \"lineHeight\": 20, \"weight\": 400 } }");
            return dir;
        }

        string Export(string family)
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-resolver-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            var ir = TestIr.Screen(Root(Text("greeting", "Merhaba", ("color", "#ffffff"), ("font-family", "\"" + family + "\", sans-serif"))), "resolver.screen");
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));
            return dir;
        }

        [Test]
        public void KitSync_UsesTheProfilesResolver_AndItsMappingForLocalesTheResolverGivesNoFont()
        {
            var profile = Profile();
            Resolver(profile);
            var kit = Kit();
            var r = DesignUiOps.KitSync(ProfilePath, kit);
            Assert.AreEqual(0, r.Code, r.Log);
            var json = JObject.Parse(File.ReadAllText(kit + "/fonts/fonts.json"));
            Assert.IsTrue(JToken.DeepEquals(JObject.Parse("{ \"ar\": [\"Kit Arabic Sans\"], \"tr\": [\"Kit Resolver Sans\"] }"), json), json.ToString());
            var css = File.ReadAllText(kit + "/fonts/fonts.css");
            StringAssert.Contains("\"Kit Resolver Sans\"", css);
            StringAssert.DoesNotContain("Kit Mapped Sans", css, "the profile's own mapping is only the fallback");
            StringAssert.Contains("warning: the font resolver 'Game Fonts' gives no font for ar", r.Log);
            Assert.IsNotNull(AssetDatabase.LoadAssetAtPath<UnityEngine.TextCore.Text.FontAsset>(FontFixture.TwinFolder + "/Resolver Answer UITK.asset"));
        }

        [Test]
        public void Compile_UsesTheProfilesResolver()
        {
            var profile = Profile();
            Resolver(profile);
            var ok = ScreenCompiler.Compile(Export("Kit Resolver Sans"), profile, false, NoView());
            Assert.IsTrue(ok.Ok, string.Join("\n", ok.Errors));
            var fonts = File.ReadAllText(Out + "/" + FontMap.FileName);
            StringAssert.Contains(FontFixture.TwinFolder + "/Resolver Answer UITK.asset", fonts);
            StringAssert.DoesNotContain("Resolver Mapped", fonts);

            // the family of the profile's own tr mapping is no font of the locales while the resolver answers tr
            var mapped = ScreenCompiler.Compile(Export("Kit Mapped Sans"), profile, false, NoView());
            Assert.IsFalse(mapped.Ok);
            StringAssert.Contains("kit-mapped-sans", string.Join("\n", mapped.Errors));
        }

        [Test]
        public void WithoutAResolver_TheProfilesMappingIsUsed()
        {
            var profile = Profile();
            var kit = Kit();
            var r = DesignUiOps.KitSync(ProfilePath, kit);
            Assert.AreEqual(0, r.Code, r.Log);
            StringAssert.Contains("\"Kit Mapped Sans\"", File.ReadAllText(kit + "/fonts/fonts.css"));
            StringAssert.DoesNotContain("font resolver", r.Log);
            StringAssert.StartsWith("built-in", TextStatus.Check(profile, kit).Resolver);
        }

        [Test]
        public void AMissingResolver_IsAClearError_ForKitSyncCompileAndStatus()
        {
            var profile = Profile();
            Resolver(profile);
            Assert.IsTrue(AssetDatabase.DeleteAsset(ResolverPath));
            var kit = Kit();

            var sync = DesignUiOps.KitSync(ProfilePath, kit);
            Assert.AreEqual(1, sync.Code, sync.Log);
            StringAssert.Contains("fontResolver", sync.Log);
            StringAssert.Contains("missing", sync.Log);
            Assert.IsFalse(File.Exists(kit + "/fonts/fonts.css"), "nothing is written");

            var compile = ScreenCompiler.Compile(Export("Kit Resolver Sans"), profile, false, NoView());
            Assert.IsFalse(compile.Ok);
            StringAssert.Contains("fontResolver", string.Join("\n", compile.Errors));

            var status = TextStatus.Check(profile, kit);
            StringAssert.Contains("fontResolver", status.Kit);
            StringAssert.Contains("missing", status.Resolver);
        }

        [Test]
        public void AThrowingResolver_IsAClearError_ForKitSyncCompileAndStatus()
        {
            var profile = Profile();
            Resolver(profile, "the game's font table is not loaded");
            var kit = Kit();

            var sync = DesignUiOps.KitSync(ProfilePath, kit);
            Assert.AreEqual(1, sync.Code, sync.Log);
            StringAssert.Contains("the font resolver 'Game Fonts' (" + typeof(FixtureFontResolver).FullName + ") failed for locale 'tr'", sync.Log);
            StringAssert.Contains("InvalidOperationException: the game's font table is not loaded", sync.Log);
            Assert.IsFalse(File.Exists(kit + "/fonts/fonts.css"), "nothing is written");

            var compile = ScreenCompiler.Compile(Export("Kit Resolver Sans"), profile, false, NoView());
            Assert.IsFalse(compile.Ok);
            StringAssert.Contains("the game's font table is not loaded", string.Join("\n", compile.Errors));

            StringAssert.Contains("the game's font table is not loaded", TextStatus.Check(profile, kit).Kit);
        }

        /// <summary>An in-memory TMP Settings object with a default font asset and global fallbacks.</summary>
        static TMP_Settings Settings(TMP_FontAsset defaultFont, params TMP_FontAsset[] globals)
        {
            var s = ScriptableObject.CreateInstance<TMP_Settings>();
            using (var so = new SerializedObject(s))
            {
                so.FindProperty("m_defaultFontAsset").objectReferenceValue = defaultFont;
                var list = so.FindProperty("m_fallbackFontAssets");
                list.arraySize = globals.Length;
                for (int i = 0; i < globals.Length; i++) list.GetArrayElementAtIndex(i).objectReferenceValue = globals[i];
                so.ApplyModifiedPropertiesWithoutUndo();
            }
            return s;
        }

        [Test]
        public void SwitchingToAResolver_KeepsTmpSettingsGlobalFallbacks_UnlessItOptsOut()
        {
            var global = FontFixture.CreateTmp(FontFixture.BoldTtf, "Resolver Global", family: "Kit Global Sans");
            var tmpDefault = FontFixture.CreateTmp(FontFixture.BoldTtf, "Resolver Tmp Default", family: "Kit Default Sans");
            var settings = Settings(tmpDefault, global);
            try
            {
                var profile = Profile();
                var builtIn = new ProfileLocaleFontResolver(profile, new TmpSettingsFontResolver(() => settings));
                // the resolver answers every locale with the fonts the profile maps
                var asset = Resolver(profile);
                asset.fonts = new[] { new LocaleFont { locale = "tr", font = _mapped }, new LocaleFont { locale = "ar", font = _arabic } };
                var project = new ProjectFontResolver(asset, builtIn, new TmpSettingsFontResolver(() => settings));

                var before = FontMap.Plan(profile, builtIn);
                var after = FontMap.Plan(profile, project);
                foreach (var locale in new[] { "tr", "ar" })
                {
                    CollectionAssert.AreEqual(before.Chains[locale], after.Chains[locale], locale + ": the same fonts, in the same order");
                    CollectionAssert.AreEqual(before.LocaleFamilies[locale], after.LocaleFamilies[locale], locale);
                    CollectionAssert.Contains(after.Chains[locale], global, locale + ": TMP Settings' global fallback");
                }
                CollectionAssert.AreEqual(before.Globals, after.Globals);

                asset.includeGlobals = false;
                var without = FontMap.Plan(profile, new ProjectFontResolver(asset, builtIn, new TmpSettingsFontResolver(() => settings)));
                CollectionAssert.AreEqual(new[] { _mapped }, without.Chains["tr"], "a resolver that opts out keeps only its own fonts");
            }
            finally { UnityEngine.Object.DestroyImmediate(settings); }
        }

        [Test]
        public void AResolverReferenceSavedToAnAssetThatIsGone_IsAClearError_AfterTheProfileLoadsFromDisk()
        {
            var profile = Profile();
            Resolver(profile);
            var guid = AssetDatabase.AssetPathToGUID(ResolverPath);
            var yaml = File.ReadAllText(ProfilePath);
            StringAssert.Contains(guid, yaml, "the profile is saved as text");
            File.WriteAllText(ProfilePath, yaml.Replace(guid, "0123456789abcdef0123456789abcdef"));
            AssetDatabase.ImportAsset(ProfilePath, ImportAssetOptions.ForceUpdate);
            var loaded = AssetDatabase.LoadAssetAtPath<DesignUiProfile>(ProfilePath);
            Assert.IsTrue(loaded.fontResolver == null, "the reference does not load");
            var sync = DesignUiOps.KitSync(ProfilePath, Kit());
            Assert.AreEqual(1, sync.Code, sync.Log);
            StringAssert.Contains("fontResolver is missing", sync.Log);
            StringAssert.Contains("missing", TextStatus.Check(loaded, Kit()).Resolver);
        }

        [Test]
        public void TheCompileAndTheStatusNameTheLocalesTheResolverGaveNoFontFor()
        {
            var profile = Profile();
            Resolver(profile);
            var result = ScreenCompiler.Compile(Export("Kit Resolver Sans"), profile, false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            StringAssert.Contains("the font resolver 'Game Fonts' gives no font for ar", string.Join("\n", result.Notes));
            StringAssert.Contains("gives no font for ar", TextStatus.Check(profile, Kit()).Resolver);
        }

        [Test]
        public void TheStatusShowsWhichResolverIsActive()
        {
            var profile = Profile();
            var kit = Kit();
            StringAssert.StartsWith("built-in: the profile's locale fonts over TMP Settings", TextStatus.Check(profile, kit).Resolver);
            Resolver(profile);
            var s = TextStatus.Check(profile, kit).Resolver;
            StringAssert.StartsWith("'Game Fonts' (" + typeof(FixtureFontResolver).FullName + ", " + ResolverPath + ")", s);
            StringAssert.Contains("fall back to the profile's locale fonts", s);
        }
    }
}
