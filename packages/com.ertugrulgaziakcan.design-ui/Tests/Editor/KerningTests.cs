using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// Kerning on the first layout (docs/findings/text-ink.md, kerning). A dynamic font asset adds the kerning pairs of a
    /// glyph it adds while laying text out only after that layout, and UI Toolkit keeps the unkerned layout. So the twins
    /// get every character of the screen's strings with their pairs at import, and a text assigned at runtime gets its
    /// characters through <see cref="DesignText"/> before it is assigned.
    /// </summary>
    public class KerningTests
    {
        const string Out = "Assets/DesignUiKerningTests";
        /// <summary>Strongly kerned pairs in Inter: AV, VA, AT, TA, To, Wa, Ya.</summary>
        const string Kerned = "AVATAR Toyota Wave";
        const float Size = 32f;

        readonly List<string> _temp = new List<string>();
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            if (_rt != null) Object.DestroyImmediate(_rt);
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
            FontFixture.Delete(); // fresh twins for every test: their atlas starts empty
        }

        VisualElement Panel()
        {
            _rt = new RenderTexture(1024, 128, 24);
            _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _go = new GameObject("KerningTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            return doc.rootVisualElement;
        }

        static Label Make(VisualElement root, FontAsset font, string text, float top)
        {
            var l = new Label(text);
            l.style.position = Position.Absolute;
            l.style.left = 0;
            l.style.top = top;
            l.style.fontSize = Size;
            l.style.unityFontDefinition = FontDefinition.FromSDFFont(font);
            root.Add(l);
            return l;
        }

        /// <summary>The width of <paramref name="text"/> without kerning: the glyphs' advances (they must be in the font).</summary>
        static float Unkerned(FontAsset font, string text, float size) =>
            text.Sum(c => font.characterLookupTable[c].glyph.metrics.horizontalAdvance) * size / font.faceInfo.pointSize;

        static int PairRecords(FontAsset font)
        {
            using (var so = new SerializedObject(font))
                return so.FindProperty("m_FontFeatureTable.m_GlyphPairAdjustmentRecords").arraySize;
        }

        [UnityTest]
        public IEnumerator Compile_AddsTheScreensStringsToTheTwins_SoTheirFirstLayoutIsKerned()
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-kerning-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            var title = TestIr.Text("title", Kerned, ("color", "#ffffff"), ("font-family", "Inter"), ("font-size", "32px"));
            title.Text.En = "Yard Fe";
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(TestIr.Screen(TestIr.Root(title), "kerning.screen"), Formatting.Indented));
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            profile.outputFolder = Out;
            FontFixture.Use(profile);
            var result = ScreenCompiler.Compile(dir, profile, false, TestIr.NoView());
            Object.DestroyImmediate(profile);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));

            var twin = AssetDatabase.LoadAssetAtPath<FontAsset>(FontFixture.TwinFolder + "/Inter Fixture UITK.asset");
            foreach (var c in (Kerned + "Yard Fe").Where(c => c != ' ').Distinct())
                Assert.IsTrue(twin.characterLookupTable.ContainsKey(c), "the screen's strings (every locale) are in the twin: '" + c + "'");
            Assert.Greater(PairRecords(twin), 0, "with their kerning pairs");
            var bold = AssetDatabase.LoadAssetAtPath<FontAsset>(FontFixture.TwinFolder + "/Inter Fixture Bold UITK.asset");
            Assert.IsTrue(bold.characterLookupTable.ContainsKey('V'), "and in its weight faces");

            var root = Panel();
            for (int i = 0; i < 2; i++) yield return null;
            var first = Make(root, twin, Kerned, 0);
            for (int i = 0; i < 5; i++) yield return null;
            var firstWidth = first.layout.width; // before anything else lays the panel out again
            var again = Make(root, twin, Kerned, 48);
            for (int i = 0; i < 5; i++) yield return null;
            Assert.Less(firstWidth, Unkerned(twin, Kerned, Size) - 4, "the first layout is kerned");
            Assert.AreEqual(again.layout.width, firstWidth, 0.01f, "and equals a later layout of the same text");
        }

        [UnityTest]
        public IEnumerator SetText_AddsTheTextsCharactersBeforeItIsAssigned_SoItsFirstLayoutIsKerned()
        {
            var twin = FontTwinGenerator.GetOrCreateTwin(FontFixture.Regular, FontFixture.TwinFolder);
            var root = Panel();
            var bound = Make(root, twin, "x", 0);
            for (int i = 0; i < 3; i++) yield return null;

            DesignText.SetText(bound, Kerned);
            Assert.AreEqual(Kerned, bound.text);
            for (int i = 0; i < 5; i++) yield return null;
            var boundWidth = bound.layout.width; // before anything else lays the panel out again
            var again = Make(root, twin, Kerned, 48);
            for (int i = 0; i < 5; i++) yield return null;
            Assert.Less(boundWidth, Unkerned(twin, Kerned, Size) - 4, "the first layout of the bound text is kerned");
            Assert.AreEqual(again.layout.width, boundWidth, 0.01f);

            // an element whose font is not resolved yet (not in a panel) still gets its text
            var loose = new Label();
            DesignText.SetText(loose, "Wave");
            Assert.AreEqual("Wave", loose.text);
        }

        [UnityTest]
        public IEnumerator SetText_RightAfterTheScreenIsAttached_PreparesTheLocalesTwins_SoTheFirstLayoutIsKerned()
        {
            // the design text shares no glyph with the bound value: only the bind can have added its pairs
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-kerning-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            var title = TestIr.Text("title", "x", ("color", "#ffffff"), ("font-family", "Inter"), ("font-size", "32px"), ("align-self", "flex-start"));
            var other = TestIr.Text("other", "x", ("color", "#ffffff"), ("font-family", "Inter"), ("font-size", "32px"), ("align-self", "flex-start"));
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(TestIr.Screen(TestIr.Root(title, other), "kerning.bind"), Formatting.Indented));
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            profile.outputFolder = Out;
            FontFixture.Use(profile);
            var result = ScreenCompiler.Compile(dir, profile, false, TestIr.NoView());
            Object.DestroyImmediate(profile);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var set = AssetDatabase.LoadAssetAtPath<DesignFontSet>(Out + "/" + DesignFontSet.FileName);
            Assert.IsNotNull(set, "the compiler writes the locales' twins next to DesignFonts.uss");
            var twin = set.FontsFor("tr")[0];

            var root = Panel();
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/KerningBind/KerningBind.uxml").Instantiate();
            root.Add(tree);
            var label = tree.Q<Label>("title");
            Assert.IsNull(label.resolvedStyle.unityFontDefinition.fontAsset, "no style pass yet: the font is not resolved");
            DesignText.SetText(label, Kerned, set); // the same frame the screen is attached
            var second = tree.Q<Label>("other");
            DesignText.Fonts = set;
            try { DesignText.SetText(second, "Yavuz Tepe"); }
            finally { DesignText.Fonts = null; }
            for (int i = 0; i < 5; i++) yield return null;
            var width = label.layout.width;
            var secondWidth = second.layout.width;

            Assert.AreSame(twin, label.resolvedStyle.unityFontDefinition.fontAsset, "the label renders with the set's twin");
            Assert.Less(width, Unkerned(twin, Kerned, Size) - 4, "the first layout of the early-bound text is kerned");
            var again = Make(root, twin, Kerned, 400);
            var secondAgain = Make(root, twin, "Yavuz Tepe", 460);
            for (int i = 0; i < 5; i++) yield return null;
            Assert.AreEqual(again.layout.width, width, 0.01f);
            Assert.AreEqual(secondAgain.layout.width, secondWidth, 0.01f, "the default set (DesignText.Fonts) prepares it the same way");
        }

        [Test]
        public void Prepare_AddsTheCharactersAndTheirPairs_ToTheFontAndItsWeightFaces_AndReportsWhatNoFontHas()
        {
            var twin = FontTwinGenerator.GetOrCreateTwin(FontFixture.Regular, FontFixture.TwinFolder);
            var bold = AssetDatabase.LoadAssetAtPath<FontAsset>(FontFixture.TwinFolder + "/Inter Fixture Bold UITK.asset");
            Assert.AreEqual(0, PairRecords(twin));
            var missing = DesignText.Prepare(twin, "AV To 中");
            Assert.IsTrue(twin.characterLookupTable.ContainsKey('A') && twin.characterLookupTable.ContainsKey('o'));
            Assert.IsTrue(bold.characterLookupTable.ContainsKey('A'), "the weight table's bold face");
            Assert.Greater(PairRecords(twin), 0);
            Assert.AreEqual("中", missing, "a character no font of the chain has");
            Assert.AreEqual("", DesignText.Prepare(twin, null));
            Assert.AreEqual("", DesignText.Prepare(null, "AV"));
        }

        [Test]
        public void Twins_KeepTheirAtlasAndPairsInPlayerBuilds()
        {
            var twin = FontTwinGenerator.GetOrCreateTwin(FontFixture.Regular, FontFixture.TwinFolder);
            using (var so = new SerializedObject(twin))
                Assert.IsFalse(so.FindProperty("m_ClearDynamicDataOnBuild").boolValue, "the characters added at import must reach the build");
        }
    }
}
