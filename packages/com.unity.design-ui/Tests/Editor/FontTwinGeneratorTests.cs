using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TextCore.LowLevel;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace DesignUi.Editor.Tests
{
    public class FontTwinGeneratorTests
    {
        const string Twins = FontFixture.TwinFolder;

        [TearDown]
        public void Cleanup() => FontFixture.Delete();

        [Test]
        public void Twin_IsADynamicTextCoreFontAssetWithTheTmpSettingsAndFamily()
        {
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Regular", pointSize: 72, padding: 7, atlas: 1024);
            var twin = FontTwinGenerator.GetOrCreateTwin(tmp, Twins);

            Assert.AreEqual(Twins + "/Twin Regular UITK.asset", AssetDatabase.GetAssetPath(twin));
            Assert.AreEqual(UnityEngine.TextCore.Text.AtlasPopulationMode.Dynamic, twin.atlasPopulationMode);
            Assert.AreEqual(tmp.faceInfo.familyName, twin.faceInfo.familyName);
            Assert.IsNotEmpty(twin.faceInfo.familyName);
            Assert.AreEqual(72f, twin.faceInfo.pointSize);
            Assert.AreEqual(tmp.faceInfo.lineHeight, twin.faceInfo.lineHeight, 1e-4f, "face metrics equal TMP's");
            Assert.AreEqual(7, twin.atlasPadding);
            Assert.AreEqual(GlyphRenderMode.SDFAA, twin.atlasRenderMode);
            Assert.AreEqual(1024, twin.atlasWidth);
            Assert.AreEqual(1024, twin.atlasHeight);
            Assert.IsTrue(twin.isMultiAtlasTexturesEnabled);
            Assert.AreSame(AssetDatabase.LoadAssetAtPath<Font>(FontFixture.RegularTtf), twin.sourceFontFile);

            // the atlas texture and material are stored in the twin asset, so a reload keeps them
            var stored = AssetDatabase.LoadAllAssetsAtPath(AssetDatabase.GetAssetPath(twin));
            Assert.IsTrue(stored.OfType<Texture2D>().Any(), "atlas texture sub-asset");
            Assert.IsTrue(stored.OfType<Material>().Any(), "material sub-asset");
        }

        [Test]
        public void Twin_MirrorsTheTmpFallbacksInOrder()
        {
            var b = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin Fallback B");
            var a = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin Fallback A");
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Primary");
            FontFixture.SetFallbacks(tmp, b, null, a);

            var twin = FontTwinGenerator.GetOrCreateTwin(tmp, Twins);
            CollectionAssert.AreEqual(new[] { "Twin Fallback B UITK", "Twin Fallback A UITK" }, twin.fallbackFontAssetTable.Select(f => f.name).ToArray());
            Assert.AreSame(FontTwinGenerator.GetOrCreateTwin(b, Twins), twin.fallbackFontAssetTable[0]);
            Assert.AreSame(FontTwinGenerator.GetOrCreateTwin(a, Twins), twin.fallbackFontAssetTable[1]);
            Assert.AreEqual(UnityEngine.TextCore.Text.AtlasPopulationMode.Dynamic, twin.fallbackFontAssetTable[0].atlasPopulationMode);
        }

        [Test]
        public void Twin_MirrorsTheWeightTable()
        {
            var bold = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin Weight Bold");
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Weight Regular");
            FontFixture.SetWeight(tmp, 700, bold);

            var twin = FontTwinGenerator.GetOrCreateTwin(tmp, Twins);
            Assert.AreSame(FontTwinGenerator.GetOrCreateTwin(bold, Twins), twin.fontWeightTable[7].regularTypeface);
            Assert.IsNull(twin.fontWeightTable[4].regularTypeface);
            Assert.IsNull(twin.fontWeightTable[7].italicTypeface);
        }

        [Test]
        public void Twin_SecondCall_ReturnsTheSameAssetAndWritesNothing()
        {
            var bold = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin Idem Bold");
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Idem");
            FontFixture.SetWeight(tmp, 700, bold);
            FontFixture.SetFallbacks(tmp, bold);
            var first = FontTwinGenerator.GetOrCreateTwin(tmp, Twins);
            var path = AssetDatabase.GetAssetPath(first);
            var bytes = File.ReadAllBytes(path);
            var time = File.GetLastWriteTimeUtc(path);
            var guid = AssetDatabase.AssetPathToGUID(path);

            var second = FontTwinGenerator.GetOrCreateTwin(tmp, Twins);
            Assert.AreSame(first, second);
            Assert.AreEqual(guid, AssetDatabase.AssetPathToGUID(path));
            Assert.AreEqual(bytes, File.ReadAllBytes(path));
            Assert.AreEqual(time, File.GetLastWriteTimeUtc(path));
            Assert.IsFalse(EditorUtility.IsDirty(second));
        }

        [Test]
        public void Twin_FollowsAChangedFallbackListInPlace()
        {
            var extra = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin Later Fallback");
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Changing");
            var twin = FontTwinGenerator.GetOrCreateTwin(tmp, Twins);
            var guid = AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(twin));
            Assert.IsEmpty(twin.fallbackFontAssetTable ?? new System.Collections.Generic.List<FontAsset>());

            FontFixture.SetFallbacks(tmp, extra);
            var again = FontTwinGenerator.GetOrCreateTwin(tmp, Twins);
            Assert.AreSame(twin, again, "the same twin asset is updated");
            Assert.AreEqual(guid, AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(again)));
            CollectionAssert.AreEqual(new[] { "Twin Later Fallback UITK" }, again.fallbackFontAssetTable.Select(f => f.name).ToArray());
            Assert.IsFalse(EditorUtility.IsDirty(again), "saved with an asset-specific save");
        }

        [Test]
        public void Twin_ChangedTmpAtlasSettings_RegenerateTheTwin()
        {
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Settings", padding: 7);
            FontTwinGenerator.GetOrCreateTwin(tmp, Twins);
            using (var so = new SerializedObject(tmp))
            {
                so.FindProperty("m_AtlasPadding").intValue = 9;
                so.ApplyModifiedPropertiesWithoutUndo();
            }
            FontFixture.Save(tmp);
            var twin = FontTwinGenerator.GetOrCreateTwin(tmp, Twins);
            Assert.AreEqual(9, twin.atlasPadding);
            Assert.AreEqual(Twins + "/Twin Settings UITK.asset", AssetDatabase.GetAssetPath(twin));
        }

        [Test]
        public void Twin_FallbackCycle_Terminates()
        {
            var a = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Cycle A");
            var b = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin Cycle B");
            FontFixture.SetFallbacks(a, b);
            FontFixture.SetFallbacks(b, a);
            var twin = FontTwinGenerator.GetOrCreateTwin(a, Twins);
            var twinB = twin.fallbackFontAssetTable.Single();
            Assert.AreSame(twin, twinB.fallbackFontAssetTable.Single());
        }

        [Test]
        public void Twin_FolderOutsideAssets_Throws()
        {
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Outside");
            Assert.Throws<FontSetupException>(() => FontTwinGenerator.GetOrCreateTwin(tmp, "Packages/com.unity.design-ui/Fonts"));
            Assert.Throws<FontSetupException>(() => FontTwinGenerator.GetOrCreateTwin(tmp, "/tmp/twins"));
        }

        [Test]
        public void Twin_OfATmpAssetWithoutSourceFont_Throws()
        {
            var tmp = FontFixture.CreateWithoutSource("Twin No Source");
            Assert.Throws<FontSetupException>(() => FontTwinGenerator.GetOrCreateTwin(tmp, Twins));
            Assert.IsFalse(File.Exists(Twins + "/Twin No Source UITK.asset"));
        }
    }
}
