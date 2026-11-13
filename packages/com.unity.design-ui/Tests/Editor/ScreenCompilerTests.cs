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

        /// <summary>The Editor writes Unity's default runtime theme here when a PanelSettings is created; removed again if this test made it.</summary>
        const string DefaultThemeFolder = "Assets/UI Toolkit";

        readonly List<string> _temp = new List<string>();
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;
        bool _hadDefaultThemeFolder;

        [SetUp]
        public void Remember()
        {
            _hadDefaultThemeFolder = AssetDatabase.IsValidFolder(DefaultThemeFolder);
        }

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) UnityEngine.Object.DestroyImmediate(_go);
            if (_settings != null) UnityEngine.Object.DestroyImmediate(_settings);
            if (_rt != null) UnityEngine.Object.DestroyImmediate(_rt);
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(AssetsRoot)) AssetDatabase.DeleteAsset(AssetsRoot);
            if (!_hadDefaultThemeFolder && AssetDatabase.IsValidFolder(DefaultThemeFolder)) AssetDatabase.DeleteAsset(DefaultThemeFolder);
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
            WriteIr(dir, ir);
            Directory.CreateDirectory(Path.Combine(dir, "assets"));
            var tex = new Texture2D(8, 8, TextureFormat.RGBA32, false);
            var pixels = Enumerable.Repeat(new Color32(0, 0, 0, 128), 64).ToArray();
            tex.SetPixels32(pixels);
            File.WriteAllBytes(Path.Combine(dir, ShadowFile), tex.EncodeToPNG());
            UnityEngine.Object.DestroyImmediate(tex);
            if (textStyles)
                File.WriteAllText(Path.Combine(dir, KitTextStyles.FileName), "{ \"label\": { \"fontSize\": 16.515625, \"lineHeight\": 20, \"weight\": 400 } }");
            return dir;
        }

        static void WriteIr(string exportDir, IrScreen ir) =>
            File.WriteAllText(Path.Combine(exportDir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));

        static DesignUiProfile Profile(string outputFolder)
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            p.outputFolder = outputFolder;
            return p;
        }

        static Dictionary<string, byte[]> Snapshot(string dir) =>
            Directory.GetFiles(dir, "*", SearchOption.AllDirectories).Where(f => !f.EndsWith(".meta", StringComparison.Ordinal))
                .ToDictionary(f => f.Replace('\\', '/'), File.ReadAllBytes);

        static Dictionary<string, DateTime> Times(string dir) =>
            Directory.GetFiles(dir, "*", SearchOption.AllDirectories).ToDictionary(f => f.Replace('\\', '/'), File.GetLastWriteTimeUtc);

        // ---- incremental output (R22) ----------------------------------------------------------------------

        [Test]
        public void Compile_Twice_SecondWritesNothingAndFilesAreByteIdentical()
        {
            var export = Export(Showcase());
            var profile = Profile(AssetsRoot);
            var first = ScreenCompiler.Compile(export, profile);
            Assert.IsTrue(first.Ok, string.Join("\n", first.Errors));
            var outDir = AssetsRoot + "/TestShowcase";
            CollectionAssert.IsSubsetOf(new[] { outDir + "/TestShowcase.uxml", outDir + "/TestShowcase.uss", outDir + "/assets/shadow.png", AssetsRoot + "/DesignTokens.uss" }, first.Written.ToArray());
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
            var second = ScreenCompiler.Compile(export, profile);
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
            var export = Export(ir);
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

        [Test]
        public void Compile_StaleOutput_IsDeleted()
        {
            var ir = TestIr.Screen(Root(Node("rows", "list").Add(Node("row", "container", ("height", "10px")))));
            ir.Root.Children[0].Repeat = new IrRepeat { Name = "row", Mode = "list" };
            var export = Export(ir);
            var output = TempDir();
            var profile = Profile(output);
            Assert.IsTrue(ScreenCompiler.Compile(export, profile).Ok);
            var template = output + "/TestScreen/RowItem.uxml";
            Assert.IsTrue(File.Exists(template));
            ir.Root.Children = new IrNode[0];
            WriteIr(export, ir);
            var result = ScreenCompiler.Compile(export, profile);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            Assert.IsFalse(File.Exists(template));
            var manifest = GeneratedManifest.Load(output + "/TestScreen/" + ScreenCompiler.ManifestFileName);
            Assert.IsFalse(manifest.files.ContainsKey("RowItem.uxml"));
        }

        [Test]
        public void Compile_ListRepeat_TemplateAndListViewInstantiate()
        {
            var ir = TestIr.Screen(Root(
                Node("rows", "list", ("display", "flex"), ("flex-direction", "column"), ("gap", "4px"))
                    .Add(Node("row", "container", ("height", "10px"), ("background-color", "#123456")))));
            ir.Root.Children[0].Repeat = new IrRepeat { Name = "row", Mode = "list" };
            var result = ScreenCompiler.Compile(Export(ir), Profile(AssetsRoot));
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var screen = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(AssetsRoot + "/TestScreen/TestScreen.uxml");
            var item = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(AssetsRoot + "/TestScreen/RowItem.uxml");
            Assert.IsNotNull(screen);
            Assert.IsNotNull(item);
            Assert.IsFalse(item.importedWithErrors || item.importedWithWarnings);
            var tree = screen.Instantiate();
            Assert.IsInstanceOf<ListView>(tree.Q("rows"));
            var row = item.Instantiate().Q("row");
            Assert.IsNotNull(row);
            StringAssert.StartsWith("s-", row.GetClasses().First());
            var uss = File.ReadAllText(AssetsRoot + "/TestScreen/TestScreen.uss");
            StringAssert.Contains("." + row.GetClasses().First() + ".__first {", uss, "the view toggles __first on item 0");
        }

        // ---- manual-edit guard -----------------------------------------------------------------------------

        [Test]
        public void Compile_HandEditedUss_IsRefusedUntilDiscarded()
        {
            var export = Export(Showcase());
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
            var export = Export(Showcase());
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
            var export = Export(ir);
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
            var export = Export(ir);
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
            Assert.AreEqual("TestShowcaseView.g.cs", m.view, "reserved for the view class");
            CollectionAssert.AreEquivalent(new[] { "TestShowcase.uxml", "TestShowcase.uss", "assets/shadow.png" }, m.files.Keys);
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
            Assert.IsTrue(ScreenCompiler.Compile(Export(a), profile).Ok);
            Assert.IsTrue(ScreenCompiler.Compile(Export(b), profile).Ok);
            var tokens = File.ReadAllText(output + "/" + ScreenCompiler.TokensFileName);
            StringAssert.Contains("--color-accent: #2fd1c5;", tokens);
            StringAssert.Contains("--space-4: 16px;", tokens);
            a.Tokens["color.accent"] = "#000000";
            var exportA = Export(a);
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

        // ---- profile (R31) ---------------------------------------------------------------------------------

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
                Assert.IsNotNull(typeof(DesignUiProfile).GetCustomAttributes(typeof(CreateAssetMenuAttribute), false).SingleOrDefault());
            }
            finally { UnityEngine.Object.DestroyImmediate(p); }
        }

        // ---- the compiled screen on a real panel -----------------------------------------------------------

        [UnityTest]
        public IEnumerator Compiled_Screen_ResolvesItsRulesOnAPanel()
        {
            var export = Export(Showcase(), textStyles: true);
            var profile = Profile(AssetsRoot);
            var result = ScreenCompiler.Compile(export, profile);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(AssetsRoot + "/TestShowcase/TestShowcase.uxml");
            Assert.IsNotNull(vta);

            _rt = new RenderTexture(256, 256, 24);
            _settings = ScriptableObject.CreateInstance<PanelSettings>();
            _settings.targetTexture = _rt;
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize; // 1 design px = 1 panel px, no snapping to a scaled pixel grid
            _settings.scale = 1f;
            _settings.themeStyleSheet = profile.RuntimeTheme;
            _go = new GameObject("ScreenCompilerTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
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
            AssertColor("#111111", panel.resolvedStyle.backgroundColor);
            Assert.AreEqual(0f, tree.Q("item-a").resolvedStyle.marginTop, "__first restores the first item's margin");
            Assert.AreEqual(8f, tree.Q("item-b").resolvedStyle.marginTop);
            Assert.AreEqual(PickingMode.Ignore, shadow.pickingMode);
            Assert.IsNotNull(shadow.resolvedStyle.backgroundImage.texture, "the shadow PNG resolves through the relative url");
            Assert.AreEqual(2, shadow.resolvedStyle.unitySliceLeft);
            Assert.AreEqual(100f, host.resolvedStyle.width);

            root.AddToClassList("state-loading");
            host.AddToClassList("dui-hover");
            for (int i = 0; i < 5; i++) yield return null;
            Assert.AreEqual(0.5f, root.resolvedStyle.opacity, 1e-4f);
            AssertColor("#222222", panel.resolvedStyle.backgroundColor);
            Assert.AreEqual(0.8f, host.resolvedStyle.opacity, 1e-4f);
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
