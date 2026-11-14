using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEditorInternal;
using UnityEngine;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// <see cref="TwinPlayGuard"/>: what Play mode adds to a twin (glyphs, atlas pixels, atlas pages) never reaches its file,
    /// while the characters an import pre-adds in Edit mode do. Play is simulated with the guard's own start and stop.
    /// </summary>
    public class TwinPlayGuardTests
    {
        const string Runtime = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ÄÖÜäöüßçğış";

        [TearDown]
        public void Cleanup()
        {
            if (TwinPlayGuard.Active) TwinPlayGuard.End();
            FontFixture.Delete();
        }

        static FontAsset SavedTwin(string name, int atlas, out string path)
        {
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, name, atlas: atlas);
            var twin = FontTwinGenerator.GetOrCreateTwin(tmp, FontFixture.TwinFolder);
            DesignText.Prepare(twin, "Takvim"); // an import's pre-add
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

        [Test]
        public void GlyphsAddedInPlay_AreDiscardedWhenPlayStops_AndASaveDuringPlayLeavesTheTwinOut()
        {
            Assume.That(TwinPlayGuard.Supported, "TextCore reports no font asset changes on this Unity version");
            var twin = SavedTwin("Guard Glyphs", 1024, out var path);
            var file = File.ReadAllBytes(path);
            int characters = twin.characterTable.Count, glyphs = twin.glyphTable.Count;

            TwinPlayGuard.Begin(); // Play starts
            Assert.IsTrue(twin.TryAddCharacters(Runtime, out _, true) || twin.characterTable.Count > characters);
            Assert.Greater(twin.characterTable.Count, characters, "runtime text added glyphs");
            CollectionAssert.Contains(TwinPlayGuard.Touched, path);
            AssetDatabase.SaveAssetIfDirty(twin);
            AssetDatabase.SaveAssetIfDirty(twin.atlasTextures[0]);
            CollectionAssert.AreEqual(file, File.ReadAllBytes(path), "a save during Play leaves the twin's file alone");

            CollectionAssert.AreEqual(new[] { path }, TwinPlayGuard.End()); // Play stops
            Assert.AreEqual(characters, twin.characterTable.Count);
            Assert.AreEqual(glyphs, twin.glyphTable.Count);
            Assert.IsFalse(twin.HasCharacter('Z'));
            Assert.IsTrue(twin.HasCharacter('T'), "the import's characters stay");
            Assert.IsFalse(EditorUtility.IsDirty(twin));
            AssetDatabase.SaveAssetIfDirty(twin);
            CollectionAssert.AreEqual(file, File.ReadAllBytes(path), "nothing of Play is saved later");

            // the next import's pre-add, in Edit mode, is saved as before (and only it)
            DesignText.Prepare(twin, "Zebra");
            EditorUtility.SetDirty(twin);
            AssetDatabase.SaveAssetIfDirty(twin);
            Assert.AreEqual(characters + 4, CharactersInFile(path), "Z, e, b and r are new");
        }

        [Test]
        public void AnAtlasPageAddedInPlay_LeavesTheTwin_AndThePixelsComeBack()
        {
            Assume.That(TwinPlayGuard.Supported, "TextCore reports no font asset changes on this Unity version");
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
            AssetDatabase.SaveAssetIfDirty(twin);
            CollectionAssert.AreEqual(file, File.ReadAllBytes(path));
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
    }
}
