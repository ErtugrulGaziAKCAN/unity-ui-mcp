using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using Newtonsoft.Json;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using static DesignUi.Editor.Tests.TestIr;

namespace DesignUi.Editor.Tests
{
    public class ScreenCompilerTests
    {
        const string AssetsRoot = "Assets/DesignUiCompilerTests";

        /// <summary>Where the Editor writes Unity's default runtime theme when a PanelSettings without a theme is created.</summary>
        const string DefaultThemeFolder = "Assets/UI Toolkit";

        readonly List<string> _temp = new List<string>();
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) UnityEngine.Object.DestroyImmediate(_go);
            if (_settings != null) UnityEngine.Object.DestroyImmediate(_settings);
            if (_rt != null) UnityEngine.Object.DestroyImmediate(_rt);
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(AssetsRoot)) AssetDatabase.DeleteAsset(AssetsRoot);
        }

        /// <summary>A copy of the shipped design PanelSettings rendering into a RenderTexture, 1 design px = 1 panel px.</summary>
        UIDocument Panel(int size)
        {
            _rt = new RenderTexture(size, size, 24);
            _settings = UnityEngine.Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _go = new GameObject("ScreenCompilerTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            return doc;
        }

        string TempDir()
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-compiler-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            return dir;
        }

        /// <summary>An export folder: screen.ir.json, the shadow PNG, and optionally text-styles.json.</summary>
        string Export(IrScreen ir, bool textStyles = false)
        {
            var dir = TempDir();
            Directory.CreateDirectory(Path.Combine(dir, "assets"));
            var tex = new Texture2D(8, 8, TextureFormat.RGBA32, false);
            var pixels = Enumerable.Repeat(new Color32(0, 0, 0, 128), 64).ToArray();
            tex.SetPixels32(pixels);
            var png = tex.EncodeToPNG();
            File.WriteAllBytes(Path.Combine(dir, ShadowFile), png);
            UnityEngine.Object.DestroyImmediate(tex);
            SetHash(ir, ShadowFile, png);
            WriteIr(dir, ir);
            if (textStyles)
                File.WriteAllText(Path.Combine(dir, KitTextStyles.FileName), "{ \"label\": { \"fontSize\": 16.515625, \"lineHeight\": 20, \"weight\": 400 } }");
            return dir;
        }

        static void WriteIr(string exportDir, IrScreen ir) =>
            File.WriteAllText(Path.Combine(exportDir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));

        /// <summary>A profile whose reference locale renders with the Inter fixture font (the Showcase names a font family).</summary>
        static DesignUiProfile Profile(string outputFolder)
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            p.outputFolder = outputFolder;
            FontFixture.Use(p);
            return p;
        }

        [OneTimeTearDown]
        public void DeleteFonts() => FontFixture.Delete();

        /// <summary>The Showcase with its kit text style table next to the IR, as an export folder.</summary>
        string ShowcaseExport(IrScreen ir = null) => Export(ir ?? Showcase(), textStyles: true);

        static Dictionary<string, byte[]> Snapshot(string dir) =>
            Directory.GetFiles(dir, "*", SearchOption.AllDirectories).Where(f => !f.EndsWith(".meta", StringComparison.Ordinal))
                .ToDictionary(f => f.Replace('\\', '/'), File.ReadAllBytes);

        static Dictionary<string, DateTime> Times(string dir) =>
            Directory.GetFiles(dir, "*", SearchOption.AllDirectories).ToDictionary(f => f.Replace('\\', '/'), File.GetLastWriteTimeUtc);

        // ---- incremental output (spec 14) ------------------------------------------------------------------

        [Test]
        public void Compile_Twice_SecondWritesNothingAndFilesAreByteIdentical()
        {
            var export = ShowcaseExport();
            var profile = Profile(AssetsRoot);
            var first = ScreenCompiler.Compile(export, profile, false, NoView());
            Assert.IsTrue(first.Ok, string.Join("\n", first.Errors));
            var outDir = AssetsRoot + "/TestShowcase";
            CollectionAssert.IsSubsetOf(new[] { outDir + "/TestShowcase.uxml", outDir + "/TestShowcase.uss", AssetsRoot + "/DesignTokens.uss" }, first.Written.ToArray());
            var vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(outDir + "/TestShowcase.uxml");
            var sheet = AssetDatabase.LoadAssetAtPath<StyleSheet>(outDir + "/TestShowcase.uss");
            var tokens = AssetDatabase.LoadAssetAtPath<StyleSheet>(AssetsRoot + "/DesignTokens.uss");
            Assert.IsNotNull(vta, "UXML imported");
            Assert.IsNotNull(sheet, "USS imported");
            Assert.IsNotNull(tokens, "tokens USS imported");
            Assert.IsFalse(vta.importedWithErrors || vta.importedWithWarnings, "UXML imports cleanly");
            Assert.IsFalse(sheet.importedWithErrors || sheet.importedWithWarnings, "USS imports cleanly");
            Assert.IsFalse(tokens.importedWithErrors || tokens.importedWithWarnings, "tokens USS imports cleanly");

            var bytes = Snapshot(AssetsRoot);
            var times = Times(AssetsRoot);
            var second = ScreenCompiler.Compile(export, profile, false, NoView());
            Assert.IsTrue(second.Ok, string.Join("\n", second.Errors));
            CollectionAssert.IsEmpty(second.Written);
            var after = Snapshot(AssetsRoot);
            CollectionAssert.AreEquivalent(bytes.Keys, after.Keys);
            foreach (var kv in bytes) CollectionAssert.AreEqual(kv.Value, after[kv.Key], kv.Key);
            foreach (var kv in Times(AssetsRoot)) Assert.AreEqual(times[kv.Key], kv.Value, "untouched: " + kv.Key);
        }

        [Test]
        public void Compile_ColourOnlyChange_RewritesStylesButNotTheViewCode()
        {
            var ir = Showcase();
            var export = ShowcaseExport(ir);
            var output = TempDir();
            var profile = Profile(output);
            var hooks = new CompileHooks { ViewCode = s => "// view of " + s.ClassName + ": " + string.Join(",", s.AllElements().Select(e => e.Name)) + "\n" };
            Assert.IsTrue(ScreenCompiler.Compile(export, profile, false, hooks).Ok);
            var dir = output + "/TestShowcase";
            var view = dir + "/TestShowcaseView.g.cs";
            Assert.IsTrue(File.Exists(view));
            var viewTime = File.GetLastWriteTimeUtc(view);

            ir.Root.Children[0].Style["base"]["background-color"] = "#abcdef"; // panel
            WriteIr(export, ir);
            var result = ScreenCompiler.Compile(export, profile, false, hooks);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            CollectionAssert.AreEquivalent(new[] { dir + "/TestShowcase.uss", dir + "/TestShowcase.uxml" }, result.Written.ToArray(),
                "the class name in one UXML line and its rule change; the view code does not");
            Assert.AreEqual(viewTime, File.GetLastWriteTimeUtc(view));
            var manifest = GeneratedManifest.Load(dir + "/" + ScreenCompiler.ManifestFileName);
            Assert.AreEqual(GeneratedManifest.Sha256Hex(File.ReadAllBytes(dir + "/TestShowcase.uss")), manifest.files["TestShowcase.uss"]);
            Assert.AreEqual(GeneratedManifest.Sha256Hex(File.ReadAllBytes(view)), manifest.files["TestShowcaseView.g.cs"]);
        }

        static IrScreen ScrollingList(string gap = null)
        {
            var list = Node("rows", "list", ("display", "flex"), ("flex-direction", "column"), ("overflow-y", "auto"), ("height", "100px"));
            if (gap != null) list.Style["base"]["gap"] = gap;
            list.Add(Node("row", "container", ("height", "10px"), ("background-color", "#123456")));
            list.Repeat = new IrRepeat { Name = "row", Mode = "list", Count = 3 };
            return TestIr.Screen(Root(list));
        }

        [Test]
        public void Compile_StaleOutput_IsDeletedInsideTheBatch()
        {
            var ir = ScrollingList();
            var export = Export(ir);
            var profile = Profile(AssetsRoot);
            Assert.IsTrue(ScreenCompiler.Compile(export, profile, false, NoView()).Ok);
            var template = AssetsRoot + "/TestScreen/RowItem.uxml";
            Assert.IsNotNull(AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(template));
            ir.Root.Children = new IrNode[0];
            WriteIr(export, ir);
            var result = ScreenCompiler.Compile(export, profile, false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            Assert.IsFalse(File.Exists(template));
            Assert.IsFalse(File.Exists(template + ".meta"));
            Assert.IsNull(AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(template));
            var manifest = GeneratedManifest.Load(AssetsRoot + "/TestScreen/" + ScreenCompiler.ManifestFileName);
            Assert.IsFalse(manifest.files.ContainsKey("RowItem.uxml"));
        }

        [Test]
        public void Compile_WithoutTheViewStep_KeepsAnExistingView()
        {
            var export = ShowcaseExport();
            var output = TempDir();
            var profile = Profile(output);
            var hooks = new CompileHooks { ViewCode = c => "// view\n" };
            Assert.IsTrue(ScreenCompiler.Compile(export, profile, false, hooks).Ok);
            var view = output + "/TestShowcase/TestShowcaseView.g.cs";
            var result = ScreenCompiler.Compile(export, profile, false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            Assert.IsTrue(File.Exists(view), "a compile that does not write the view never deletes it");
            Assert.AreEqual("// view\n", File.ReadAllText(view));
            Assert.IsTrue(GeneratedManifest.Load(output + "/TestShowcase/" + ScreenCompiler.ManifestFileName).files.ContainsKey("TestShowcaseView.g.cs"));
            Assert.IsTrue(ScreenCompiler.Compile(export, profile, false, hooks).Ok);
        }

        [Test]
        public void Compile_WritesTheGeneratedViewByDefault()
        {
            var export = ShowcaseExport();
            var output = TempDir(); // outside the project: Unity does not compile the view here
            var profile = Profile(output);
            profile.generatedNamespace = "Game.Ui";
            var result = ScreenCompiler.Compile(export, profile);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var view = output + "/TestShowcase/TestShowcaseView.g.cs";
            CollectionAssert.Contains(result.Written.ToArray(), view);
            var code = File.ReadAllText(view);
            StringAssert.Contains("namespace Game.Ui\n", code);
            StringAssert.Contains("public sealed partial class TestShowcaseView\n", code);
            StringAssert.Contains("public Button Go { get; }", code);
            var manifest = GeneratedManifest.Load(output + "/TestShowcase/" + ScreenCompiler.ManifestFileName);
            Assert.AreEqual(GeneratedManifest.Sha256Hex(File.ReadAllBytes(view)), manifest.files["TestShowcaseView.g.cs"]);
            Assert.IsTrue(ScreenCompiler.Compile(export, profile).Ok);
            Assert.IsTrue(ScreenCompiler.Compile(export, profile).Written.Count == 0, "an unchanged screen writes no view either");
        }

        [Test]
        public void Compile_ViewUnderAnAssemblyWithoutDesignUiRuntime_FailsNamingTheAsmdef()
        {
            var game = TempDir();
            File.WriteAllText(game + "/Game.UI.asmdef", "{ \"name\": \"Game.UI\", \"references\": [\"Unity.TextMeshPro\"] }");
            var output = game + "/Screens";
            var result = ScreenCompiler.Compile(ShowcaseExport(), Profile(output));
            Assert.IsFalse(result.Ok);
            var error = string.Join("\n", result.Errors);
            StringAssert.Contains("Game.UI.asmdef", error);
            StringAssert.Contains("DesignUi.Runtime", error);
            Assert.IsFalse(Directory.Exists(output), "nothing is written");

            foreach (var reference in new[] { "DesignUi.Runtime", "GUID:" + AssetDatabase.AssetPathToGUID("Packages/com.unity.design-ui/Runtime/DesignUi.Runtime.asmdef") })
            {
                File.WriteAllText(game + "/Game.UI.asmdef", "{ \"name\": \"Game.UI\", \"references\": [\"" + reference + "\"] }");
                var ok = ScreenCompiler.Compile(ShowcaseExport(), Profile(output));
                Assert.IsTrue(ok.Ok, reference + ": " + string.Join("\n", ok.Errors));
            }
        }

        [Test]
        public void Compile_ViewUnderAnAssemblyWithoutEngineReferences_Fails()
        {
            var game = TempDir();
            File.WriteAllText(game + "/Pure.asmdef", "{ \"name\": \"Pure\", \"references\": [\"DesignUi.Runtime\"], \"noEngineReferences\": true }");
            var result = ScreenCompiler.Compile(ShowcaseExport(), Profile(game + "/Screens"));
            Assert.IsFalse(result.Ok);
            StringAssert.Contains("noEngineReferences", string.Join("\n", result.Errors));
        }

        [Test]
        public void Compile_ViewStepThatWritesNoView_NeedsNoAssemblyCheck()
        {
            var game = TempDir();
            File.WriteAllText(game + "/Game.UI.asmdef", "{ \"name\": \"Game.UI\" }");
            Assert.IsTrue(ScreenCompiler.Compile(ShowcaseExport(), Profile(game + "/Screens"), false, NoView()).Ok);
        }

        [Test]
        public void Compile_ElementIdsThatClashInTheView_FailBeforeWriting()
        {
            var output = TempDir();
            var ir = TestIr.Screen(Root(Node("card-title", "container", ("height", "4px")), Node("card.title", "container", ("height", "4px"))));
            var result = ScreenCompiler.Compile(Export(ir), Profile(output));
            Assert.IsFalse(result.Ok);
            StringAssert.Contains("card.title", string.Join("\n", result.Errors));
            Assert.IsFalse(Directory.Exists(output + "/TestScreen"), "nothing is written");
        }

        [Test]
        public void Compile_ListRepeat_TemplateAndListViewInstantiate()
        {
            var result = ScreenCompiler.Compile(Export(ScrollingList("4px")), Profile(AssetsRoot), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var screen = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(AssetsRoot + "/TestScreen/TestScreen.uxml");
            var item = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(AssetsRoot + "/TestScreen/RowItem.uxml");
            Assert.IsNotNull(screen);
            Assert.IsNotNull(item);
            Assert.IsFalse(item.importedWithErrors || item.importedWithWarnings);
            var tree = screen.Instantiate();
            var list = tree.Q<ListView>("rows");
            Assert.IsNotNull(list);
            Assert.AreEqual(14f, list.fixedItemHeight, "10px item + 4px gap");
            var row = item.Instantiate().Q("row");
            Assert.IsNotNull(row);
            StringAssert.StartsWith("s-", row.GetClasses().First());
            var uss = File.ReadAllText(AssetsRoot + "/TestScreen/TestScreen.uss");
            StringAssert.DoesNotContain(".__first", uss, "list items get the gap from their slot");
        }

        // ---- manual-edit guard -----------------------------------------------------------------------------

        [Test]
        public void Compile_CrlfCheckout_IsNeitherAnEditNorAWrite()
        {
            var export = ShowcaseExport();
            var output = TempDir();
            var profile = Profile(output);
            Assert.IsTrue(ScreenCompiler.Compile(export, profile).Ok);
            var dir = output + "/TestShowcase";
            foreach (var file in new[] { dir + "/TestShowcase.uss", dir + "/TestShowcase.uxml", output + "/" + ScreenCompiler.TokensFileName })
                File.WriteAllText(file, File.ReadAllText(file).Replace("\n", "\r\n"));
            var result = ScreenCompiler.Compile(export, profile);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            CollectionAssert.IsEmpty(result.ManualEdits);
            CollectionAssert.IsEmpty(result.Written);
        }

        [Test]
        public void Compile_FileAlreadyHoldingTheNewOutput_IsClean()
        {
            // an interrupted compile wrote the new .uss but not the manifest
            var ir = Showcase();
            var export = ShowcaseExport(ir);
            var output = TempDir();
            var profile = Profile(output);
            Assert.IsTrue(ScreenCompiler.Compile(export, profile).Ok);
            ir.Root.Children[0].Style["base"]["background-color"] = "#abcdef";
            WriteIr(export, ir);
            var elsewhere = TempDir();
            Assert.IsTrue(ScreenCompiler.Compile(export, Profile(elsewhere)).Ok);
            File.Copy(elsewhere + "/TestShowcase/TestShowcase.uss", output + "/TestShowcase/TestShowcase.uss", true);

            var result = ScreenCompiler.Compile(export, profile);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            CollectionAssert.AreEqual(new[] { output + "/TestShowcase/TestShowcase.uxml" }, result.Written.ToArray());
        }

        [Test]
        public void Compile_WritesGitAttributesKeepingGeneratedTextLf()
        {
            var output = TempDir();
            Assert.IsTrue(ScreenCompiler.Compile(ShowcaseExport(), Profile(output)).Ok);
            foreach (var file in new[] { output + "/.gitattributes", output + "/TestShowcase/.gitattributes" })
            {
                Assert.IsTrue(File.Exists(file), file);
                var text = File.ReadAllText(file);
                StringAssert.Contains("eol=lf", text);
                StringAssert.Contains("*.png binary", text);
            }
        }

        [Test]
        public void Compile_HandEditedUss_IsRefusedUntilDiscarded()
        {
            var export = ShowcaseExport();
            var output = TempDir();
            var profile = Profile(output);
            Assert.IsTrue(ScreenCompiler.Compile(export, profile).Ok);
            var uss = output + "/TestShowcase/TestShowcase.uss";
            var generated = File.ReadAllText(uss);
            File.WriteAllText(uss, generated + "\n.mine { color: red; }\n");

            var refused = ScreenCompiler.Compile(export, profile);
            Assert.IsFalse(refused.Ok);
            CollectionAssert.AreEqual(new[] { uss }, refused.ManualEdits.ToArray());
            CollectionAssert.IsEmpty(refused.Written);
            StringAssert.Contains(".mine", File.ReadAllText(uss), "nothing is overwritten");
            StringAssert.Contains("TestShowcase.uss", string.Join("\n", refused.Errors));

            var discarded = ScreenCompiler.Compile(export, profile, discardManualEdits: true);
            Assert.IsTrue(discarded.Ok, string.Join("\n", discarded.Errors));
            CollectionAssert.AreEqual(new[] { uss }, discarded.Written.ToArray());
            Assert.AreEqual(generated, File.ReadAllText(uss));
            Assert.IsTrue(ScreenCompiler.Compile(export, profile).Ok);
        }

        [Test]
        public void Compile_ForeignFileInTheWay_IsAManualEdit()
        {
            var export = ShowcaseExport();
            var output = TempDir();
            Directory.CreateDirectory(output + "/TestShowcase");
            File.WriteAllText(output + "/TestShowcase/TestShowcase.uxml", "<ui:UXML />\n");
            var result = ScreenCompiler.Compile(export, Profile(output));
            Assert.IsFalse(result.Ok);
            CollectionAssert.AreEqual(new[] { output + "/TestShowcase/TestShowcase.uxml" }, result.ManualEdits.ToArray());
        }

        [Test]
        public void Compile_HandEditedTokens_AreAManualEdit()
        {
            var ir = Showcase();
            ir.Tokens["color.accent"] = "#2fd1c5";
            var export = ShowcaseExport(ir);
            var output = TempDir();
            var profile = Profile(output);
            Assert.IsTrue(ScreenCompiler.Compile(export, profile).Ok);
            var tokens = output + "/" + ScreenCompiler.TokensFileName;
            File.AppendAllText(tokens, "/* mine */\n");
            var result = ScreenCompiler.Compile(export, profile);
            Assert.IsFalse(result.Ok);
            CollectionAssert.AreEqual(new[] { tokens }, result.ManualEdits.ToArray());
        }

        // ---- manifest, tokens, text styles, errors ---------------------------------------------------------

        [Test]
        public void Compile_Manifest_RecordsHashesAndRuntimeWiring()
        {
            var ir = Showcase();
            var export = ShowcaseExport(ir);
            var output = TempDir();
            Assert.IsTrue(ScreenCompiler.Compile(export, Profile(output)).Ok);
            var dir = output + "/TestShowcase";
            var text = File.ReadAllText(dir + "/" + ScreenCompiler.ManifestFileName);
            StringAssert.DoesNotContain("\r", text);
            var m = GeneratedManifest.Load(dir + "/" + ScreenCompiler.ManifestFileName);
            Assert.AreEqual(ir.Source.Sha256, m.sourceSha256);
            Assert.AreEqual(GeneratedManifest.Sha256Hex(File.ReadAllBytes(export + "/" + ScreenCompiler.IrFileName)), m.irSha256);
            Assert.IsFalse(string.IsNullOrEmpty(m.generatorVersion));
            Assert.AreEqual("test.showcase", m.screen);
            Assert.AreEqual("root", m.root);
            Assert.AreEqual("TestShowcaseView.g.cs", m.view, "the view class");
            CollectionAssert.AreEquivalent(new[] { "TestShowcase.uxml", "TestShowcase.uss", "TestShowcaseView.g.cs", ".gitattributes" }, m.files.Keys);
            foreach (var kv in m.files) Assert.AreEqual(GeneratedManifest.Sha256Hex(File.ReadAllBytes(dir + "/" + kv.Key)), kv.Value, kv.Key);
            CollectionAssert.AreEqual(new[] { "tile" }, m.clickable);
            Assert.AreEqual(1, m.mirrors.Length);
            Assert.AreEqual("card", m.mirrors[0].element);
            Assert.AreEqual("card__shadowhost", m.mirrors[0].host);
            Assert.AreEqual(1, m.repeats.Length);
            Assert.AreEqual("item", m.repeats[0].name);
            Assert.AreEqual("inline", m.repeats[0].mode);
            Assert.AreEqual("items", m.repeats[0].container);
            CollectionAssert.AreEqual(new[] { "item-a", "item-b" }, m.repeats[0].items);
            CollectionAssert.IsEmpty(m.removedElements);
            Assert.IsEmpty(m.FindManualEdits(dir));
        }

        [Test]
        public void Compile_Tokens_SharedFileKeepsOtherScreensTokens()
        {
            var output = TempDir();
            var profile = Profile(output);
            var a = Showcase("test.alpha");
            a.Tokens["color.accent"] = "#2fd1c5";
            var b = TestIr.Screen(Root(), "test.beta");
            b.Tokens["space.4"] = "16px";
            Assert.IsTrue(ScreenCompiler.Compile(ShowcaseExport(a), profile).Ok);
            Assert.IsTrue(ScreenCompiler.Compile(Export(b), profile).Ok);
            var tokens = File.ReadAllText(output + "/" + ScreenCompiler.TokensFileName);
            StringAssert.Contains("--color-accent: #2fd1c5;", tokens);
            StringAssert.Contains("--space-4: 16px;", tokens);
            a.Tokens["color.accent"] = "#000000";
            var exportA = ShowcaseExport(a);
            var again = ScreenCompiler.Compile(exportA, profile);
            Assert.IsTrue(again.Ok, string.Join("\n", again.Errors));
            tokens = File.ReadAllText(output + "/" + ScreenCompiler.TokensFileName);
            StringAssert.Contains("--color-accent: #000000;", tokens);
            StringAssert.Contains("--space-4: 16px;", tokens);
        }

        [Test]
        public void Compile_TextStyles_FromTheExportFolder_UnderTurkishCulture()
        {
            var culture = Thread.CurrentThread.CurrentCulture;
            try
            {
                Thread.CurrentThread.CurrentCulture = new CultureInfo("tr-TR");
                var export = Export(Showcase(), textStyles: true);
                var output = TempDir();
                var result = ScreenCompiler.Compile(export, Profile(output));
                Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
                var uss = File.ReadAllText(output + "/TestShowcase/TestShowcase.uss");
                StringAssert.Contains("font-size: 16.515625px;", uss);
                StringAssert.DoesNotContain(",", uss);
            }
            finally { Thread.CurrentThread.CurrentCulture = culture; }
        }

        [Test]
        public void Compile_TextStyles_FromTheProfileKit()
        {
            var export = Export(Showcase());
            var kit = TempDir();
            File.WriteAllText(Path.Combine(kit, KitTextStyles.FileName), "{ \"label\": { \"fontSize\": 23.125, \"lineHeight\": 28, \"weight\": 400 } }");
            var output = TempDir();
            var profile = Profile(output);
            profile.kitDir = kit;
            Assert.IsTrue(ScreenCompiler.Compile(export, profile).Ok);
            StringAssert.Contains("font-size: 23.125px;", File.ReadAllText(output + "/TestShowcase/TestShowcase.uss"));
        }

        [Test]
        public void Compile_TextStylesWithoutATable_IsAnError()
        {
            var export = Export(Showcase());
            var output = TempDir();
            var profile = Profile(output);
            profile.kitDir = TempDir();
            var result = ScreenCompiler.Compile(export, profile);
            Assert.IsFalse(result.Ok);
            var error = string.Join("\n", result.Errors);
            StringAssert.Contains(Path.Combine(export, KitTextStyles.FileName), error, "names the paths it searched");
            StringAssert.Contains(Path.Combine(profile.kitDir, KitTextStyles.FileName), error);
            Assert.IsFalse(Directory.Exists(output + "/TestShowcase"));
        }

        [Test]
        public void Compile_ScreensSharingAFolderName_IsAnError()
        {
            var output = TempDir();
            var profile = Profile(output);
            Assert.IsTrue(ScreenCompiler.Compile(Export(TestIr.Screen(Root(), "club.overview")), profile).Ok);
            var result = ScreenCompiler.Compile(Export(TestIr.Screen(Root(), "club-overview")), profile);
            Assert.IsFalse(result.Ok);
            StringAssert.Contains("club.overview", string.Join("\n", result.Errors));
        }

        [Test]
        public void Compile_OutputNamesDifferingOnlyInCase_AreAnError()
        {
            // the list template of repeat "rows" in screen "rows.item" would be RowsItem.uxml, the screen's own file
            var ir = ScrollingList();
            ir.Screen = "rows.item";
            ir.Root.Children[0].Repeat.Name = "rows";
            var result = ScreenCompiler.Compile(Export(ir), Profile(TempDir()));
            Assert.IsFalse(result.Ok);
            StringAssert.Contains("RowsItem.uxml", string.Join("\n", result.Errors));
        }

        [Test]
        public void Compile_ReportsOrphanScreenFoldersWithoutDeletingThem()
        {
            var output = TempDir();
            var design = TempDir();
            Directory.CreateDirectory(Path.Combine(design, "test.alpha"));
            var profile = Profile(output);
            profile.designRoot = design;
            Assert.IsTrue(ScreenCompiler.Compile(Export(TestIr.Screen(Root(), "test.beta")), profile).Ok);
            var result = ScreenCompiler.Compile(Export(TestIr.Screen(Root(), "test.alpha")), profile);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            CollectionAssert.AreEqual(new[] { output + "/TestBeta" }, result.Orphans.ToArray());
            Assert.IsTrue(Directory.Exists(output + "/TestBeta"));
        }

        [Test]
        public void Compile_InvalidInput_ReportsErrorsAndWritesNothing()
        {
            var output = TempDir();
            var missing = ScreenCompiler.Compile(TempDir(), Profile(output));
            Assert.IsFalse(missing.Ok);
            StringAssert.Contains(ScreenCompiler.IrFileName, string.Join("\n", missing.Errors));

            var bad = TestIr.Screen(Root(Node("x", "container", ("display", "grid"))));
            var result = ScreenCompiler.Compile(Export(bad), Profile(output));
            Assert.IsFalse(result.Ok);
            StringAssert.Contains("display", string.Join("\n", result.Errors));
            CollectionAssert.IsEmpty(result.Written);
            Assert.IsFalse(Directory.Exists(output + "/TestScreen"));
        }

        // ---- profile and the shipped panel settings (spec 5.3, 12) --------------------------------------------

        [UnityTest]
        public IEnumerator ShippedPanelSettings_RenderWithTheRuntimeThemeAndWriteNoDefaultTheme()
        {
            var settings = DesignUiProfile.LoadDefaultPanelSettings();
            Assert.IsNotNull(settings, DesignUiProfile.PanelSettingsPath);
            Assert.AreSame(AssetDatabase.LoadAssetAtPath<ThemeStyleSheet>(DesignUiProfile.RuntimeThemePath), settings.themeStyleSheet);
            Assert.AreEqual(PanelScaleMode.ScaleWithScreenSize, settings.scaleMode);
            Assert.AreEqual(new Vector2Int(2560, 1440), settings.referenceResolution);
            Assert.AreEqual(0.5f, settings.match);
            Assert.IsNull(settings.targetTexture);

            var hadDefaultTheme = AssetDatabase.IsValidFolder(DefaultThemeFolder);
            var doc = Panel(64);
            for (int i = 0; i < 3; i++) yield return null;
            Assert.IsNotNull(doc.rootVisualElement.panel);
            if (!hadDefaultTheme) Assert.IsFalse(AssetDatabase.IsValidFolder(DefaultThemeFolder), "no UnityDefaultRuntimeTheme.tss is written");
        }

        [Test]
        public void Profile_DefaultsAndRuntimeTheme()
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            try
            {
                Assert.AreEqual("Assets/UI/Generated", p.outputFolder);
                Assert.AreEqual("Assets/UI/Generated/Fonts", p.fontTwinFolder);
                Assert.AreEqual("DesignUi.Generated", p.generatedNamespace);
                Assert.AreEqual(new Vector2Int(2560, 1440), p.referenceResolution);
                Assert.AreEqual(0.5f, p.screenMatch);
                Assert.AreEqual("tr", p.referenceLocale);
                Assert.AreEqual(TextureImporterCompression.Uncompressed, p.textureCompression);
                var theme = AssetDatabase.LoadAssetAtPath<ThemeStyleSheet>(DesignUiProfile.RuntimeThemePath);
                Assert.IsNotNull(theme, "the package's runtime theme imports as a ThemeStyleSheet");
                Assert.AreSame(theme, p.RuntimeTheme, "design screens use the package's minimal theme by default");
                Assert.AreSame(DesignUiProfile.LoadDefaultPanelSettings(), p.DesignPanelSettings);
                Assert.IsNotNull(typeof(DesignUiProfile).GetCustomAttributes(typeof(CreateAssetMenuAttribute), false).SingleOrDefault());
            }
            finally { UnityEngine.Object.DestroyImmediate(p); }
        }

        // ---- the compiled screen on a real panel -----------------------------------------------------------

        [UnityTest]
        public IEnumerator Compiled_Screen_ResolvesItsRulesOnAPanel()
        {
            var export = ShowcaseExport();
            var profile = Profile(AssetsRoot);
            // an asset step that places the shadow under a folder name with # and %: the url() must escape them
            var odd = AssetsRoot + "/odd #1 50%";
            var hooks = new CompileHooks
            {
                AssetPath = a =>
                {
                    Directory.CreateDirectory(odd);
                    var path = odd + "/" + Path.GetFileName(a.File);
                    File.Copy(Path.Combine(export, a.File), path, true);
                    AssetDatabase.ImportAsset(AssetsRoot);
                    AssetDatabase.ImportAsset(odd);
                    AssetDatabase.ImportAsset(path);
                    return path;
                },
                ViewCode = _ => null,
            };
            var result = ScreenCompiler.Compile(export, profile, false, hooks);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(AssetsRoot + "/TestShowcase/TestShowcase.uxml");
            var sheet = AssetDatabase.LoadAssetAtPath<StyleSheet>(AssetsRoot + "/TestShowcase/TestShowcase.uss");
            Assert.IsNotNull(vta);
            StringAssert.Contains("%23", File.ReadAllText(AssetsRoot + "/TestShowcase/TestShowcase.uss"));
            Assert.IsFalse(sheet.importedWithErrors || sheet.importedWithWarnings, "the escaped project url resolves at import");

            var doc = Panel(256);
            for (int i = 0; i < 2; i++) yield return null;
            var tree = vta.Instantiate();
            doc.rootVisualElement.Add(tree);
            for (int i = 0; i < 10; i++) yield return null;

            var root = tree.Q("root");
            var panel = tree.Q("panel");
            var host = tree.Q("card__shadowhost");
            var shadow = tree.Q("card__shadow");
            var label = tree.Q<Label>("go-label");
            Assert.IsNotNull(root);
            Assert.IsInstanceOf<Button>(tree.Q("go"));
            Assert.AreEqual("Giriş", label.text);
            Assert.AreEqual(16.515625f, label.resolvedStyle.fontSize, 1e-4f);
            Assert.AreSame(AssetDatabase.LoadAssetAtPath<UnityEngine.TextCore.Text.FontAsset>(FontFixture.TwinFolder + "/Inter Fixture UITK.asset"),
                label.resolvedStyle.unityFontDefinition.fontAsset, "the label's var(--font-inter) resolves through DesignFonts.uss to the reference locale's twin");
            AssertColor("#111111", panel.resolvedStyle.backgroundColor);
            Assert.AreEqual(0f, tree.Q("item-a").resolvedStyle.marginTop, "__first restores the first item's margin");
            Assert.AreEqual(8f, tree.Q("item-b").resolvedStyle.marginTop);
            Assert.AreEqual(PickingMode.Ignore, shadow.pickingMode);
            Assert.IsNotNull(shadow.resolvedStyle.backgroundImage.texture, "the shadow PNG resolves through the escaped project url");
            Assert.AreEqual(2, shadow.resolvedStyle.unitySliceLeft);
            Assert.AreEqual(100f, host.resolvedStyle.width);

            root.AddToClassList("state-loading");
            host.AddToClassList("dui-hover");
            for (int i = 0; i < 5; i++) yield return null;
            Assert.AreEqual(0.5f, root.resolvedStyle.opacity, 1e-4f);
            AssertColor("#222222", panel.resolvedStyle.backgroundColor);
            Assert.AreEqual(0.8f, host.resolvedStyle.opacity, 1e-4f);
        }

        [UnityTest]
        public IEnumerator Compiled_ScrollAreaAndList_ResolveOnAPanel()
        {
            var area = Node("area", "scroll", ("width", "120px"), ("height", "60px"), ("overflow-y", "auto"), ("display", "flex"),
                    ("flex-direction", "row"), ("padding-left", "6px"))
                .Add(Node("a", "container", ("width", "10px"), ("height", "80px")), Node("b", "container", ("width", "10px"), ("height", "80px")));
            var list = Node("rows", "list", ("display", "flex"), ("flex-direction", "column"), ("gap", "4px")).Add(Node("row", "container", ("height", "10px")));
            list.Repeat = new IrRepeat { Name = "row", Mode = "list", Count = 5 };
            var inbox = Node("inbox__0", "scroll", ("width", "120px"), ("height", "60px"), ("overflow-y", "auto")).Add(list);
            var result = ScreenCompiler.Compile(Export(TestIr.Screen(Root(area, inbox))), Profile(AssetsRoot), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(AssetsRoot + "/TestScreen/TestScreen.uxml");
            Assert.IsFalse(vta.importedWithErrors || vta.importedWithWarnings);

            var doc = Panel(256);
            for (int i = 0; i < 2; i++) yield return null;
            var tree = vta.Instantiate();
            doc.rootVisualElement.Add(tree);
            for (int i = 0; i < 10; i++) yield return null;

            var scroll = tree.Q<ScrollView>("area");
            Assert.AreEqual(ScrollViewMode.Vertical, scroll.mode);
            Assert.AreEqual(ScrollerVisibility.Auto, scroll.verticalScrollerVisibility);
            Assert.AreEqual(ScrollerVisibility.Hidden, scroll.horizontalScrollerVisibility);
            // the selector chain follows the real 6000.3 hierarchy
            var content = scroll.contentContainer;
            Assert.AreSame(scroll, content.parent.parent.parent);
            Assert.AreEqual(FlexDirection.Row, content.resolvedStyle.flexDirection, "content layout reaches the content container");
            Assert.AreEqual(6f, content.resolvedStyle.paddingLeft);
            Assert.AreEqual(120f, scroll.resolvedStyle.width);

            var listView = tree.Q<ListView>("inbox__0");
            Assert.IsNotNull(listView, "the list and its scroll area are one ListView");
            Assert.IsNull(tree.Q("rows"));
            Assert.AreEqual(14f, listView.fixedItemHeight);
            Assert.AreEqual(60f, listView.resolvedStyle.height);
            Assert.AreEqual(1, listView.Query<ScrollView>().ToList().Count, "only the ListView's own ScrollView");
            Assert.IsNull(listView.GetFirstAncestorOfType<ScrollView>(), "not nested in another ScrollView");
        }

        [UnityTest]
        public IEnumerator Compiled_CompoundLayersAndNewIrFields_ImportCleanlyAndResolveOnAPanel()
        {
            const string image = "assets/image.png"; // a plain image; the shadow PNG is imported as a 9-slice sprite
            var title = Text("title", "Başlık", ("color", "#ffffff"))
                .With("anc(card):class:is-selected", ("color", "#111111"))
                .With("state:loading+anc(card):class:is-selected", ("color", "#222222"));
            var card = Node("card", "container", ("height", "20px"), ("background-color", "#333333"))
                .With("state:loading+class:is-selected", ("background-color", "#444444"))
                .Add(title);
            var hov = Node("hov", "container", ("height", "4px")).With("state:loading+hover", ("opacity", "0.3"));
            var icon = Node("icon", "vector", ("width", "8px"), ("height", "8px"), ("color", "#ff0000")).With("state:loading", ("color", "#00ff00"));
            icon.Asset = new IrAsset { Kind = "image", File = image, Sha256 = new string('d', 64), Width = 8, Height = 8, Tint = true };
            var banner = Node("banner", "container", ("width", "40px"), ("height", "20px"), ("background-image", "url(\"" + image + "\")"),
                ("background-repeat", "no-repeat"), ("background-position-x", "right 2px"));
            banner.Background = new IrAsset { Kind = "image", File = image, Sha256 = new string('d', 64), Width = 8, Height = 6 };
            var go = Node("go", "button", ("height", "10px")).With("disabled", ("opacity", "0.4"));
            go.Initial = new IrInitial { Disabled = true };
            go.AttrTexts["title"] = new IrText { Key = "t.go", Tr = "Başla", En = "Start" };
            var check = Node("check", "toggle", ("height", "10px"));
            check.Initial = new IrInitial { Checked = true };
            var search = Node("search", "input", ("height", "20px"));
            search.AttrTexts["placeholder"] = new IrText { Key = "t.find", Tr = "Ara", En = "Search" };
            var league = Node("league", "dropdown", ("height", "20px"));
            league.Text = new IrText { Key = "t.league", Tr = "Süper Lig", En = "Super League" };
            var tile = Node("tile", "container", ("height", "8px")).With("focus", ("opacity", "0.6"));
            var crest = Node("crest", "image", ("width", "8px"), ("height", "8px"));
            crest.Asset = new IrAsset { Kind = "image", File = image, Sha256 = new string('d', 64), Width = 8, Height = 8 };
            crest.AttrTexts["alt"] = new IrText { Key = "t.crest", Tr = "Kulüp arması", En = "Club crest" };
            var lifted = Node("lifted", "container", ("width", "8px"), ("height", "8px")).With("class:is-selected", ("translate", "0 -2px"));
            lifted.Shadow = new IrShadow { Kind = "shadow9", File = ShadowFile, Sha256 = new string('d', 64), Width = 8, Height = 8, Slice = new float[] { 2, 2, 2, 2 }, Offset = new BoxRect() };
            var ir = TestIr.Screen(Root(card, hov, icon, banner, go, check, search, league, tile, crest, lifted));
            var export = Export(ir);
            var bytes = File.ReadAllBytes(Path.Combine(export, ShadowFile));
            File.WriteAllBytes(Path.Combine(export, image), bytes);
            SetHash(ir, image, bytes);
            WriteIr(export, ir);
            var result = ScreenCompiler.Compile(export, Profile(AssetsRoot), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(AssetsRoot + "/TestScreen/TestScreen.uxml");
            var sheet = AssetDatabase.LoadAssetAtPath<StyleSheet>(AssetsRoot + "/TestScreen/TestScreen.uss");
            Assert.IsFalse(vta.importedWithErrors || vta.importedWithWarnings, "the UXML attributes are known to UI Toolkit");
            Assert.IsFalse(sheet.importedWithErrors || sheet.importedWithWarnings, "the compound selectors and new properties parse:\n" + File.ReadAllText(AssetsRoot + "/TestScreen/TestScreen.uss"));

            var doc = Panel(256);
            for (int i = 0; i < 2; i++) yield return null;
            var tree = vta.Instantiate();
            doc.rootVisualElement.Add(tree);
            for (int i = 0; i < 10; i++) yield return null;

            var root = tree.Q("root");
            var cardEl = tree.Q("card");
            var titleEl = tree.Q<Label>("title");
            var iconEl = tree.Q("icon");
            var bannerEl = tree.Q("banner");
            var goEl = tree.Q<Button>("go");
            var hovEl = tree.Q("hov");

            AssertColor("#ffffff", titleEl.resolvedStyle.color);
            AssertColor("#ff0000", iconEl.resolvedStyle.unityBackgroundImageTintColor);
            Assert.IsNotNull(iconEl.resolvedStyle.backgroundImage.texture);
            var size = bannerEl.resolvedStyle.backgroundSize;
            Assert.AreEqual(BackgroundSizeType.Length, size.sizeType);
            Assert.AreEqual(8f, size.x.value);
            Assert.AreEqual(6f, size.y.value, "auto is the asset's natural size");
            Assert.AreEqual(Repeat.NoRepeat, bannerEl.resolvedStyle.backgroundRepeat.x);
            Assert.AreEqual(BackgroundPositionKeyword.Right, bannerEl.resolvedStyle.backgroundPositionX.keyword);
            Assert.AreEqual(2f, bannerEl.resolvedStyle.backgroundPositionX.offset.value);
            var y = bannerEl.resolvedStyle.backgroundPositionY;
            Assert.IsTrue(y.keyword != BackgroundPositionKeyword.Center && y.keyword != BackgroundPositionKeyword.Bottom, "CSS starts at the top, not centred: " + y.keyword);
            Assert.AreEqual(0f, y.offset.value);

            Assert.IsFalse(goEl.enabledSelf, "initial disabled");
            Assert.AreEqual(0.4f, goEl.resolvedStyle.opacity, 1e-4f, ":disabled applies");
            Assert.AreEqual("Başla", goEl.tooltip);
            Assert.IsTrue(tree.Q<Toggle>("check").value, "initial checked");
            var field = tree.Q<TextField>("search");
            Assert.AreEqual("Ara", field.textEdition.placeholder);
            Assert.IsFalse(field.textEdition.hidePlaceholderOnFocus, "CSS keeps a placeholder while the empty field has focus");
            Assert.AreEqual("Süper Lig", tree.Q<DropdownField>("league").value, "a select's selected option");
            var tileEl = tree.Q("tile");
            Assert.IsTrue(tileEl.focusable, "a :focus style needs a focusable element");
            Assert.IsFalse(cardEl.focusable);

            // the manifest the compile wrote: undrawn attribute texts and a host that mirrors its element's class
            var manifest = GeneratedManifest.Load(AssetsRoot + "/TestScreen/" + ScreenCompiler.ManifestFileName);
            Assert.AreEqual("Kulüp arması", manifest.accessibility["crest"]["alt"].tr);
            Assert.AreEqual("t.crest", manifest.accessibility["crest"]["alt"].key);
            Assert.AreEqual("Club crest", manifest.accessibility["crest"]["alt"].en);
            var mirror = manifest.mirrors.Single(m => m.host == "lifted__shadowhost");
            Assert.AreEqual("lifted", mirror.element);
            CollectionAssert.AreEqual(new[] { "is-selected" }, mirror.classes);
            Assert.IsFalse(tree.Q("lifted__shadowhost").ClassListContains(ScreenBuilder.MirrorHostClass), "classes only, no pseudo-state mirror");

            cardEl.AddToClassList("is-selected");
            for (int i = 0; i < 3; i++) yield return null;
            AssertColor("#111111", titleEl.resolvedStyle.color);
            AssertColor("#333333", cardEl.resolvedStyle.backgroundColor);

            root.AddToClassList("state-loading");
            var pseudo = typeof(VisualElement).GetProperty("pseudoStates", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
            Assert.IsNotNull(pseudo, "VisualElement.pseudoStates");
            pseudo.SetValue(hovEl, Enum.Parse(pseudo.PropertyType, "Hover"));
            for (int i = 0; i < 3; i++) yield return null;
            AssertColor("#222222", titleEl.resolvedStyle.color);
            AssertColor("#444444", cardEl.resolvedStyle.backgroundColor);
            AssertColor("#00ff00", iconEl.resolvedStyle.unityBackgroundImageTintColor);
            Assert.AreEqual(0.3f, hovEl.resolvedStyle.opacity, 1e-4f, ".state-loading .s-x:hover");
        }

        /// <summary>
        /// The effect layers end to end: a card whose shadow lifts on hover and disappears while loading, a button whose
        /// inset shadow (an overlay of its padding box) goes away while pressed, and a root gradient that changes with a
        /// state. The compiled style sheet imports cleanly and every layer resolves on a real panel.
        /// </summary>
        [UnityTest]
        public IEnumerator Compiled_EffectLayers_ResolveOnAPanel()
        {
            IrShadow Shadow(float slice, float x, float y, float w, float h) => new IrShadow
            {
                Kind = "shadow9", File = ShadowFile, Sha256 = new string('d', 64), Width = 8, Height = 8,
                Slice = new[] { slice, slice, slice, slice }, Offset = new BoxRect { X = x, Y = y, W = w, H = h },
            };
            var card = Node("card", "container", ("width", "40px"), ("height", "20px"), ("flex-shrink", "0"), ("background-color", "#333333"));
            card.Shadow = Shadow(2, 0, 4, 0, 0);
            card.ShadowLayers["hover"] = Shadow(3, -4, -2, 8, 8);
            card.ShadowLayers["state:loading"] = null;
            var play = Node("play", "button", ("width", "40px"), ("height", "20px"), ("flex-shrink", "0"), ("border-left-width", "2px"),
                ("border-left-color", "#ffffff"), ("background-color", "#123456"));
            play.InsetShadow = Shadow(2, 2, 0, -2, 0);
            play.InsetShadowLayers["active"] = null;
            var root = Root(card, play);
            root.Style["base"]["padding-left"] = "20px";
            root.Style["base"]["padding-top"] = "20px";
            const string gradA = "assets/grad-a.svg", gradB = "assets/grad-b.svg";
            root.Background = new IrAsset { Kind = "svg", File = gradA, Sha256 = new string('a', 64), Width = 256, Height = 256, StopGap = 1 };
            root.BackgroundLayers["state:loading"] = new IrAsset { Kind = "svg", File = gradB, Sha256 = new string('b', 64), Width = 256, Height = 256, StopGap = 1 };
            var ir = TestIr.Screen(root);
            var export = Export(ir);
            foreach (var (file, colour) in new[] { (gradA, "#ff0000"), (gradB, "#0000ff") })
            {
                var svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"256\" height=\"256\" viewBox=\"0 0 256 256\"><rect x=\"0\" y=\"0\" width=\"256\" height=\"256\" fill=\"" + colour + "\"/></svg>";
                File.WriteAllText(Path.Combine(export, file), svg);
                SetHash(ir, file, File.ReadAllBytes(Path.Combine(export, file)));
            }
            WriteIr(export, ir);
            var result = ScreenCompiler.Compile(export, Profile(AssetsRoot), false, NoView());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var ussPath = AssetsRoot + "/TestScreen/TestScreen.uss";
            var vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(AssetsRoot + "/TestScreen/TestScreen.uxml");
            var sheet = AssetDatabase.LoadAssetAtPath<StyleSheet>(ussPath);
            Assert.IsFalse(sheet.importedWithErrors || sheet.importedWithWarnings, "the effect rules parse:\n" + File.ReadAllText(ussPath));

            var doc = Panel(256);
            for (int i = 0; i < 2; i++) yield return null;
            var tree = vta.Instantiate();
            tree.style.position = Position.Absolute;
            tree.style.left = 0; tree.style.top = 0; tree.style.right = 0; tree.style.bottom = 0;
            doc.rootVisualElement.Add(tree);
            for (int i = 0; i < 10; i++) yield return null;

            var rootEl = tree.Q("root");
            var host = tree.Q("card__shadowhost");
            var shadow = tree.Q("card__shadow");
            var cardEl = tree.Q("card");
            var playEl = tree.Q<Button>("play");
            var inset = tree.Q("play__inset");
            var a = AssetDatabase.LoadAssetAtPath<VectorImage>(AssetsRoot + "/_assets/" + Path.GetFileName(gradA));
            var b = AssetDatabase.LoadAssetAtPath<VectorImage>(AssetsRoot + "/_assets/" + Path.GetFileName(gradB));
            Assert.IsNotNull(a);
            Assert.IsNotNull(b);
            bool NoImage(VisualElement e)
            {
                var bg = e.resolvedStyle.backgroundImage;
                return bg.texture == null && bg.sprite == null && bg.vectorImage == null && bg.renderTexture == null;
            }

            // base: the shadow covers the drawn rect (0, 4, 40, 20) of the card's border box, sliced 2
            Assert.AreSame(host, cardEl.parent);
            Assert.AreEqual(new Rect(0, 4, 40, 20), shadow.layout);
            Assert.IsNotNull(shadow.resolvedStyle.backgroundImage.texture);
            Assert.AreEqual(2, shadow.resolvedStyle.unitySliceLeft);
            Assert.AreSame(a, rootEl.resolvedStyle.backgroundImage.vectorImage);
            // the inset overlay is the play button's padding box: inside its 2 px left border
            Assert.AreSame(playEl, inset.parent);
            Assert.AreSame(inset, playEl.hierarchy[0]);
            Assert.AreEqual(new Rect(2, 0, 38, 20), inset.layout);
            Assert.IsNotNull(inset.resolvedStyle.backgroundImage.texture);
            Assert.AreEqual(PickingMode.Ignore, inset.pickingMode);
            Assert.AreEqual(PickingMode.Ignore, shadow.pickingMode);

            // hover (the mirror class on the host): the lifted shadow's drawn rect and slices
            host.AddToClassList("dui-hover");
            for (int i = 0; i < 3; i++) yield return null;
            Assert.AreEqual(new Rect(-4, -2, 48, 28), shadow.layout);
            Assert.AreEqual(3, shadow.resolvedStyle.unitySliceLeft);
            host.RemoveFromClassList("dui-hover");

            // loading: no shadow, the other gradient
            rootEl.AddToClassList("state-loading");
            for (int i = 0; i < 3; i++) yield return null;
            Assert.IsTrue(NoImage(shadow), "no shadow while loading");
            Assert.AreSame(b, rootEl.resolvedStyle.backgroundImage.vectorImage);
            rootEl.RemoveFromClassList("state-loading");

            // pressed: no inset shadow
            var pseudo = typeof(VisualElement).GetProperty("pseudoStates", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
            Assert.IsNotNull(pseudo, "VisualElement.pseudoStates");
            pseudo.SetValue(playEl, Enum.Parse(pseudo.PropertyType, "Active"));
            for (int i = 0; i < 3; i++) yield return null;
            Assert.IsTrue(NoImage(inset), "no inset shadow while pressed");
            pseudo.SetValue(playEl, Enum.ToObject(pseudo.PropertyType, 0));
            for (int i = 0; i < 3; i++) yield return null;
            Assert.IsFalse(NoImage(inset));
            Assert.IsFalse(NoImage(shadow));
            Assert.AreSame(a, rootEl.resolvedStyle.backgroundImage.vectorImage);
        }

        static void AssertColor(string hex, Color actual)
        {
            Assert.IsTrue(ColorUtility.TryParseHtmlString(hex, out var c));
            Assert.AreEqual(c.r, actual.r, 1f / 512, hex + " r");
            Assert.AreEqual(c.g, actual.g, 1f / 512, hex + " g");
            Assert.AreEqual(c.b, actual.b, 1f / 512, hex + " b");
            Assert.AreEqual(c.a, actual.a, 1f / 512, hex + " a");
        }
    }
}
