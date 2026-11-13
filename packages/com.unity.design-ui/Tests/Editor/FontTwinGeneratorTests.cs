using System.Collections;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.TextCore.LowLevel;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace DesignUi.Editor.Tests
{
    public class FontTwinGeneratorTests
    {
        const string Twins = FontFixture.TwinFolder;

        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            if (_rt != null) Object.DestroyImmediate(_rt);
            FontFixture.Delete();
        }

        /// <summary>A panel on a copy of the shipped design PanelSettings, rendering into a RenderTexture.</summary>
        VisualElement Panel()
        {
            _rt = new RenderTexture(256, 64, 24);
            _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _go = new GameObject("FontTwinGeneratorTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            return doc.rootVisualElement;
        }

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
        public void Twin_ChangedTmpAtlasSettings_RebuildTheTwinInPlace_KeepingItsGuidAndReferences()
        {
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Settings", padding: 7);
            var user = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin Settings User");
            FontFixture.SetFallbacks(user, tmp);
            var userTwin = FontTwinGenerator.GetOrCreateTwin(user, Twins);
            const string path = Twins + "/Twin Settings UITK.asset";
            var twin = AssetDatabase.LoadAssetAtPath<FontAsset>(path);
            var guid = AssetDatabase.AssetPathToGUID(path);
            Assert.AreSame(twin, userTwin.fallbackFontAssetTable.Single());

            using (var so = new SerializedObject(tmp))
            {
                so.FindProperty("m_AtlasPadding").intValue = 9;
                so.ApplyModifiedPropertiesWithoutUndo();
            }
            FontFixture.Save(tmp);
            var rebuilt = FontTwinGenerator.GetOrCreateTwin(tmp, Twins);

            Assert.AreSame(twin, rebuilt, "the same asset object is rebuilt");
            Assert.AreEqual(guid, AssetDatabase.AssetPathToGUID(path), "the GUID stays");
            Assert.AreEqual(9, rebuilt.atlasPadding);
            Assert.AreSame(rebuilt, userTwin.fallbackFontAssetTable.Single(), "references to the twin survive");
            var stored = AssetDatabase.LoadAllAssetsAtPath(path);
            Assert.AreEqual(1, stored.OfType<Texture2D>().Count(), "the old atlas texture is gone, the new one stored");
            Assert.AreEqual(1, stored.OfType<Material>().Count());
            // the same native object (a deserialized reference can be another managed wrapper of it)
            Assert.AreEqual(stored.OfType<Texture2D>().Single().GetInstanceID(), rebuilt.atlasTextures[0].GetInstanceID(), "the stored atlas is the twin's");
            Assert.AreEqual(rebuilt.atlasTextures[0].GetInstanceID(), rebuilt.material.mainTexture.GetInstanceID(), "the material samples the new atlas");
            Assert.IsFalse(EditorUtility.IsDirty(rebuilt), "saved");
            if (EditorSettings.serializationMode == SerializationMode.ForceText)
                StringAssert.Contains("guid: " + guid, File.ReadAllText(Twins + "/Twin Settings User UITK.asset"), "the other twin's file still names the GUID");

            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
            var reloaded = AssetDatabase.LoadAssetAtPath<FontAsset>(path);
            Assert.AreEqual(9, reloaded.atlasPadding, "the rebuilt state is on disk");
            Assert.IsNotNull(reloaded.atlasTextures[0]);
            Assert.IsNotNull(reloaded.material);
        }

        [Test]
        public void Twin_GlobalFallbacksFollowTheOwnFallbacks_WithoutDuplicatesOrItself()
        {
            var own = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin Own");
            var global = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Global");
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Ordered");
            FontFixture.SetFallbacks(tmp, own, tmp);
            var twin = FontTwinGenerator.GetOrCreateTwin(tmp, Twins, new[] { global, own, null });
            CollectionAssert.AreEqual(new[] { "Twin Own UITK", "Twin Global UITK" }, twin.fallbackFontAssetTable.Select(f => f.name).ToArray(),
                "TMP's search order: the asset's own fallbacks, then the global ones");
        }

        [Test]
        public void Twin_TwoGlobalFallbacks_ListNeitherEachOtherNorThemselvesThroughTheirOwnChains()
        {
            var g1Own = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin G1 Own");
            var g1 = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin G1");
            var g2 = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin G2");
            FontFixture.SetFallbacks(g1, g1Own);
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Main");
            var twin = FontTwinGenerator.GetOrCreateTwin(tmp, Twins, new[] { g1, g2 });

            FontAsset Twin(string name) => AssetDatabase.LoadAssetAtPath<FontAsset>(Twins + "/" + name + " UITK.asset");
            string[] Fallbacks(FontAsset f) => (f.fallbackFontAssetTable ?? new System.Collections.Generic.List<FontAsset>()).Select(x => x.name).ToArray();
            CollectionAssert.AreEqual(new[] { "Twin G1 UITK", "Twin G2 UITK" }, Fallbacks(twin), "a font that is no global fallback searches the globals after its own chain");
            CollectionAssert.AreEqual(new[] { "Twin G1 Own UITK" }, Fallbacks(Twin("Twin G1")), "a global fallback lists only its own fallbacks");
            CollectionAssert.IsEmpty(Fallbacks(Twin("Twin G2")));
            CollectionAssert.IsEmpty(Fallbacks(Twin("Twin G1 Own")), "a font in a global's own chain gets no globals either");

            // no twin reaches itself through its fallback lists
            foreach (var start in new[] { twin, Twin("Twin G1"), Twin("Twin G2"), Twin("Twin G1 Own") })
            {
                var seen = new System.Collections.Generic.HashSet<FontAsset>();
                var stack = new System.Collections.Generic.Stack<FontAsset>(start.fallbackFontAssetTable ?? new System.Collections.Generic.List<FontAsset>());
                while (stack.Count > 0)
                {
                    var f = stack.Pop();
                    Assert.AreNotSame(start, f, start.name + " reaches itself");
                    if (seen.Add(f)) foreach (var next in f.fallbackFontAssetTable ?? new System.Collections.Generic.List<FontAsset>()) stack.Push(next);
                }
            }
        }

        [UnityTest]
        public IEnumerator Twin_GlyphMissingFromThePrimary_RendersFromTheGlobalFallbackTwin()
        {
            // fonts that render multi-material text stay until the end of the session (see FontFixture.KeptFolder)
            var mono = FontFixture.Kept(FontFixture.MonoTtf(FontFixture.KeptFolder), "Kept Mono"); // RobotoMono has no U+203D
            var inter = FontFixture.Kept(FontFixture.RegularTtf, "Kept Global Inter");
            var twin = FontTwinGenerator.GetOrCreateTwin(mono, FontFixture.KeptTwinFolder, new[] { inter });
            var global = AssetDatabase.LoadAssetAtPath<FontAsset>(FontFixture.KeptTwinFolder + "/Kept Global Inter UITK.asset");
            CollectionAssert.AreEqual(new[] { global }, twin.fallbackFontAssetTable);

            var root = Panel();
            yield return null;
            var label = new Label("A\u203D");
            label.style.unityFontDefinition = new StyleFontDefinition(FontDefinition.FromSDFFont(twin));
            root.Add(label);
            for (int i = 0; i < 5; i++) yield return null;

            Assert.Greater(label.layout.width, 0f);
            Assert.AreEqual(twin.GetInstanceID(), twin.characterLookupTable['A'].textAsset.GetInstanceID(), "A renders from the primary twin");
            Assert.IsTrue(global.characterLookupTable.ContainsKey(0x203D), "\u203D is in the global fallback twin's atlas");
            // the primary caches characters it found through its fallbacks; the cached \u203D belongs to the global twin
            if (twin.characterLookupTable.TryGetValue(0x203D, out var cached))
                Assert.AreEqual(global.GetInstanceID(), cached.textAsset.GetInstanceID(), "\u203D renders from the global fallback twin");
            Assert.IsTrue(twin.HasCharacter('\u203D', true, false), "found through the fallback list");

        }

        [Test]
        public void Twin_OfABitmapTmpAsset_UsesSdfaa_AndSaysSo()
        {
            var raster = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Raster", renderMode: GlyphRenderMode.RASTER_HINTED);
            LogAssert.Expect(LogType.Warning, new Regex("Twin Raster.*RASTER_HINTED.*SDFAA"));
            var twin = FontTwinGenerator.GetOrCreateTwin(raster, Twins);
            Assert.AreEqual(GlyphRenderMode.SDFAA, twin.atlasRenderMode);
            var path = AssetDatabase.GetAssetPath(twin);
            var bytes = File.ReadAllBytes(path);
            Assert.AreSame(twin, FontTwinGenerator.GetOrCreateTwin(raster, Twins));
            Assert.AreEqual(bytes, File.ReadAllBytes(path), "the substituted mode is up to date: no rebuild");

            var smooth = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Smooth", renderMode: GlyphRenderMode.SMOOTH);
            Assert.AreEqual(GlyphRenderMode.SDFAA, FontTwinGenerator.TwinRenderMode(smooth));
            var color = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Color", renderMode: GlyphRenderMode.COLOR);
            Assert.AreEqual(GlyphRenderMode.COLOR, FontTwinGenerator.TwinRenderMode(color), "colour fonts keep their mode");
            var sdf = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Sdf16", renderMode: GlyphRenderMode.SDF16);
            Assert.AreEqual(GlyphRenderMode.SDF16, FontTwinGenerator.TwinRenderMode(sdf));
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
