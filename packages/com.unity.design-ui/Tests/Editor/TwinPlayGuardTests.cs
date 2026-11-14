using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using NUnit.Framework;
using UnityEditor;
using UnityEditorInternal;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// <see cref="TwinPlayGuard"/>: what Play mode adds to a twin (glyphs, atlas pixels, atlas pages, a page grown to the atlas
    /// size), however it is added, never reaches its file, while the characters an import pre-adds in Edit mode do. Play is
    /// simulated with the guard's own start and stop.
    /// </summary>
    public class TwinPlayGuardTests
    {
        const string Runtime = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ÄÖÜäöüßçğış";

        readonly List<Object> _objects = new List<Object>();
        IDisposable _advanced;

        [TearDown]
        public void Cleanup()
        {
            if (TwinPlayGuard.Active) TwinPlayGuard.End();
            foreach (var o in _objects) if (o != null) Object.DestroyImmediate(o);
            _objects.Clear();
            _advanced?.Dispose();
            _advanced = null;
            // TextCore applies changed atlas pages from a queue at the next text update: flush it before the fonts are deleted
            typeof(FontAsset).GetMethod("UpdateFontAssetsInUpdateQueue", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public)?.Invoke(null, null);
            FontFixture.Delete();
        }

        static FontAsset SavedTwin(string name, int atlas, out string path, string preAdd = "Takvim")
        {
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, name, atlas: atlas);
            var twin = FontTwinGenerator.GetOrCreateTwin(tmp, FontFixture.TwinFolder);
            if (preAdd != null) DesignText.Prepare(twin, preAdd); // an import's pre-add
            FontTwinGenerator.StoreSubAssets(twin);
            EditorUtility.SetDirty(twin);
            AssetDatabase.SaveAssetIfDirty(twin);
            path = AssetDatabase.GetAssetPath(twin);
            return twin;
        }

        static int CharactersInFile(string path)
        {
            var loaded = InternalEditorUtility.LoadSerializedFileAndForget(path);
            try { return loaded.OfType<FontAsset>().Single().characterTable.Count; }
            finally { foreach (var o in loaded) if (o != null) Object.DestroyImmediate(o); }
        }

        static void SaveEverythingOf(FontAsset twin)
        {
            AssetDatabase.SaveAssetIfDirty(twin);
            foreach (var page in twin.atlasTextures) if (page != null) AssetDatabase.SaveAssetIfDirty(page);
        }

        static void AssertClean(FontAsset twin)
        {
            Assert.IsFalse(EditorUtility.IsDirty(twin), "the twin is not dirty");
            foreach (var page in twin.atlasTextures) Assert.IsFalse(EditorUtility.IsDirty(page), "no page is dirty");
        }

        [Test]
        public void GlyphsAddedInPlay_AreDiscardedWhenPlayStops_AndASaveDuringPlayLeavesTheTwinOut()
        {
            var twin = SavedTwin("Guard Glyphs", 1024, out var path);
            var file = File.ReadAllBytes(path);
            int characters = twin.characterTable.Count, glyphs = twin.glyphTable.Count;

            TwinPlayGuard.Begin(); // Play starts
            twin.TryAddCharacters(Runtime, out _, true);
            Assert.Greater(twin.characterTable.Count, characters, "runtime text added glyphs");
            SaveEverythingOf(twin);
            CollectionAssert.AreEqual(file, File.ReadAllBytes(path), "a save during Play leaves the twin's file alone");

            CollectionAssert.AreEqual(new[] { path }, TwinPlayGuard.End()); // Play stops
            Assert.AreEqual(characters, twin.characterTable.Count);
            Assert.AreEqual(glyphs, twin.glyphTable.Count);
            Assert.IsFalse(twin.HasCharacter('Z'));
            Assert.IsTrue(twin.HasCharacter('T'), "the import's characters stay");
            AssertClean(twin);
            SaveEverythingOf(twin);
            CollectionAssert.AreEqual(file, File.ReadAllBytes(path), "nothing of Play is saved later");

            // the next import's pre-add, in Edit mode, is saved as before (and only it)
            DesignText.Prepare(twin, "Zebra");
            EditorUtility.SetDirty(twin);
            AssetDatabase.SaveAssetIfDirty(twin);
            Assert.AreEqual(characters + 4, CharactersInFile(path), "Z, e, b and r are new");
        }

        /// <summary>The advanced generator adds glyphs with FontAsset.TryAddGlyphs, which reports nothing: the guard still holds.</summary>
        [Test]
        public void GlyphsAddedWithTryAddGlyphs_AreDiscarded()
        {
            var twin = SavedTwin("Guard TryAddGlyphs", 1024, out var path);
            var file = File.ReadAllBytes(path);
            int glyphs = twin.glyphTable.Count;
            var tryAddGlyphs = typeof(FontAsset).GetMethod("TryAddGlyphs", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public, null, new[] { typeof(List<uint>) }, null);
            Assert.IsNotNull(tryAddGlyphs, "FontAsset.TryAddGlyphs(List<uint>) (Unity 6000.3)");
            var font = AssetDatabase.LoadAssetAtPath<Font>(FontFixture.RegularTtf);
            UnityEngine.TextCore.LowLevel.FontEngine.LoadFontFace(font, 72);
            var indices = "WXYZ".Select(c => UnityEngine.TextCore.LowLevel.FontEngine.TryGetGlyphIndex(c, out var g) ? g : 0u).Where(g => g != 0).ToList();
            Assert.AreEqual(4, indices.Count);

            TwinPlayGuard.Begin();
            tryAddGlyphs.Invoke(twin, new object[] { indices });
            Assert.AreEqual(glyphs + 4, twin.glyphTable.Count, "the glyphs were added");
            SaveEverythingOf(twin);
            CollectionAssert.AreEqual(file, File.ReadAllBytes(path), "a save during Play leaves the twin's file alone");
            CollectionAssert.AreEqual(new[] { path }, TwinPlayGuard.End());
            Assert.AreEqual(glyphs, twin.glyphTable.Count);
            AssertClean(twin);
            SaveEverythingOf(twin);
            CollectionAssert.AreEqual(file, File.ReadAllBytes(path));
        }

        /// <summary>Text drawn with the advanced generator (Enable Advanced Text on) adds its glyphs in Play: they are discarded too.</summary>
        [UnityTest]
        public IEnumerator GlyphsTheAdvancedGeneratorAdds_AreDiscarded()
        {
            if (!ProjectAdvancedText.Available) Assert.Ignore("this Unity version has no Enable Advanced Text project setting");
            var twin = SavedTwin("Guard Advanced", 1024, out var path);
            var file = File.ReadAllBytes(path);
            int glyphs = twin.glyphTable.Count;
            _advanced = new ProjectAdvancedText(true);
            var rt = new RenderTexture(800, 200, 24);
            var settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            settings.targetTexture = rt;
            var go = new GameObject("TwinPlayGuardTests");
            _objects.AddRange(new Object[] { go, settings, rt });
            var doc = go.AddComponent<UIDocument>();
            doc.panelSettings = settings;
            yield return null;

            TwinPlayGuard.Begin();
            var label = new Label("Quiz 2026");
            label.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
            label.style.unityTextGenerator = TextGeneratorType.Advanced;
            label.style.fontSize = 40;
            doc.rootVisualElement.Add(label);
            for (int i = 0; i < 10; i++) { label.MarkDirtyRepaint(); yield return null; }
            Assert.Greater(twin.glyphTable.Count, glyphs, "the advanced generator added the label's glyphs");
            SaveEverythingOf(twin);
            CollectionAssert.AreEqual(file, File.ReadAllBytes(path), "a save during Play leaves the twin's file alone");
            label.RemoveFromHierarchy();
            yield return null;
            CollectionAssert.AreEqual(new[] { path }, TwinPlayGuard.End());
            Assert.AreEqual(glyphs, twin.glyphTable.Count);
            AssertClean(twin);
        }

        [Test]
        public void AnAtlasPageAddedInPlay_LeavesTheTwin_AndThePixelsComeBack()
        {
            var twin = SavedTwin("Guard Pages", 256, out var path);
            var file = File.ReadAllBytes(path);
            var pixels = twin.atlasTextures[0].GetPixels32();
            Assert.AreEqual(1, twin.atlasTextures.Length);

            TwinPlayGuard.Begin();
            twin.TryAddCharacters(Runtime, out _, true);
            Assert.Greater(twin.atlasTextures.Length, 1, "a 256 px atlas needs more pages for the runtime text");
            Assert.Greater(AssetDatabase.LoadAllAssetsAtPath(path).OfType<Texture2D>().Count(), 1, "TextCore stored the new page in the twin");

            TwinPlayGuard.End();
            Assert.AreEqual(1, twin.atlasTextures.Length);
            Assert.AreEqual(1, AssetDatabase.LoadAllAssetsAtPath(path).OfType<Texture2D>().Count());
            CollectionAssert.AreEqual(pixels, twin.atlasTextures[0].GetPixels32(), "the first page's pixels are the file's again");
            AssertClean(twin);
            SaveEverythingOf(twin);
            CollectionAssert.AreEqual(file, File.ReadAllBytes(path));
        }

        /// <summary>
        /// A twin saved with nothing pre-added keeps TextCore's 1×1 first page; the first glyph in Play grows it to the atlas
        /// size. Restoring gives the page its file size and pixels back, and nothing is left to save.
        /// </summary>
        [Test]
        public void APageGrownInPlay_GetsItsFileSizeBack()
        {
            var twin = SavedTwin("Guard Empty", 512, out var path, preAdd: null);
            var file = File.ReadAllBytes(path);
            var page = twin.atlasTextures[0];
            var size = new Vector2Int(page.width, page.height);
            Assert.AreEqual(0, twin.characterTable.Count);

            TwinPlayGuard.Begin();
            twin.TryAddCharacters("Takvim", out _, true);
            Assert.AreEqual(new Vector2Int(512, 512), new Vector2Int(twin.atlasTextures[0].width, twin.atlasTextures[0].height), "the first glyph grew the page");

            CollectionAssert.AreEqual(new[] { path }, TwinPlayGuard.End());
            Assert.AreEqual(0, twin.characterTable.Count);
            Assert.AreEqual(size, new Vector2Int(twin.atlasTextures[0].width, twin.atlasTextures[0].height), "the page has its file size again");
            AssertClean(twin);
            SaveEverythingOf(twin);
            CollectionAssert.AreEqual(file, File.ReadAllBytes(path));
        }

        /// <summary>A twin whose file cannot be read back is reported as an error naming it, never as restored.</summary>
        [Test]
        public void ARestoreThatFails_IsAnErrorNamingTheTwin()
        {
            var twin = SavedTwin("Guard Lost", 1024, out var path);
            TwinPlayGuard.Begin();
            twin.TryAddCharacters("XYZ", out _, true);
            File.Delete(path); // its file is gone (moved away outside Unity)
            LogAssert.Expect(LogType.Error, new Regex(Regex.Escape(path)));
            CollectionAssert.DoesNotContain(TwinPlayGuard.End(), path);
        }

        [Test]
        public void OnlyTwinFilesAreGuarded()
        {
            Assert.IsTrue(TwinPlayGuard.IsTwin("Assets/UI/Fonts/Inter UI UITK.asset"));
            Assert.IsTrue(TwinPlayGuard.IsTwin("Assets/UI/Fonts/Inter UI UITK r13333s12.asset"));
            Assert.IsTrue(TwinPlayGuard.IsTwin("Assets/UI/Fonts/Inter UI UITK r125s16p5.asset"));
            Assert.IsFalse(TwinPlayGuard.IsTwin("Assets/UI/Fonts/Inter UI SDF.asset"));
            Assert.IsFalse(TwinPlayGuard.IsTwin("Packages/x/Inter UI UITK.asset"));
        }

        /// <summary>An import, a compile or a kit sync in Play would add glyphs the guard then takes back: they refuse to run.</summary>
        [Test]
        public void ImportAndKitSync_RefuseToRunInPlay()
        {
            var was = DesignUiOps.InPlayMode;
            DesignUiOps.InPlayMode = () => true;
            try
            {
                foreach (var r in new[] { DesignUiOps.Import("Assets/Any.asset", "/tmp/none", false), DesignUiOps.KitSync("Assets/Any.asset", "/tmp/none") })
                {
                    Assert.AreNotEqual(0, r.Code);
                    StringAssert.StartsWith("Exit Play mode first", r.Errors.Single());
                }
            }
            finally { DesignUiOps.InPlayMode = was; }
        }
    }
}
