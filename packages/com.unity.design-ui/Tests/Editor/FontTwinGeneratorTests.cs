using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using NUnit.Framework;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.TextCore;
using UnityEngine.TextCore.LowLevel;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

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
        public void LineBox_OnePerStyleSize_KeyedByItsRatioAndFontSize()
        {
            Assert.AreEqual("r125s16", FontTwinGenerator.LineBox.For(16, 20).Key);
            Assert.AreEqual("r13333s12", FontTwinGenerator.LineBox.For(12, 16).Key);
            Assert.AreEqual("r1125s32", FontTwinGenerator.LineBox.For(32, 36).Key);
            Assert.AreEqual("r15s16", FontTwinGenerator.LineBox.For(16, 24).Key);
            Assert.AreEqual("r1s1p6", FontTwinGenerator.LineBox.For(1.6, 1.6).Key, "a decimal point is written as p, so 1.6 px never reads as 16 px");
            Assert.IsNull(FontTwinGenerator.LineBox.For(0, 20));
            Assert.IsNull(FontTwinGenerator.LineBox.For(16, double.NaN));
            CollectionAssert.AreEqual(new[] { "r125s16", "r125s48", "r13333s12", "r13333s24" },
                FontTwinGenerator.LineBox.Of(new[] { (12.0, 16.0), (16.0, 20.0), (24.0, 32.0), (48.0, 60.0), (16.0, 20.0) }).Select(b => b.Key).ToArray(),
                "one per distinct size and line height, ordered by key");
        }

        /// <summary>
        /// Chromium's first baseline below the line box top in CSS px (LayoutNG, measured on 396 Inter sizes and line heights:
        /// docs/findings/text-baselines.md): the font's ascent and descent rounded at the CSS font size, the half-leading floored.
        /// </summary>
        static double ChromiumBaseline(FaceInfo f, double size, double line)
        {
            double a = Math.Floor(f.ascentLine / f.pointSize * size + 0.5), d = Math.Floor(-f.descentLine / f.pointSize * size + 0.5);
            return Math.Floor((line - (a + d)) / 2) + a;
        }

        [TestCase(12, 16, 12)]
        [TestCase(16, 20, 16)]
        [TestCase(24, 32, 24)]
        [TestCase(32, 40, 31)]
        [TestCase(36, 48, 37)]
        [TestCase(48, 60, 47)]
        [TestCase(64, 80, 63)]
        public void LineBox_Baseline_IsChromiums_ForTheKitStyles(double size, double line, double chromium)
        {
            // Chromium's baselines of the kit's text styles in Inter, from the fidelity goldens (CSS px below the line top)
            var face = FontTwinGenerator.GetOrCreateTwin(FontFixture.Regular, Twins).faceInfo;
            Assert.AreEqual(chromium, FontTwinGenerator.LineBox.For(size, line).Baseline(face), 1e-9);
            Assert.AreEqual(chromium, ChromiumBaseline(face, size, line), 1e-9, "the reference formula");
        }

        [Test]
        public void LineBoxVariant_HasTheCssLineBoxFace_AndFallsBackToTheSameSizesVariants()
        {
            var fallback = FontFixture.CreateTmp(FontFixture.BoldTtf, "Box Fallback");
            var bold = FontFixture.CreateTmp(FontFixture.BoldTtf, "Box Bold");
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Box Regular");
            FontFixture.SetFallbacks(tmp, fallback);
            FontFixture.SetWeight(tmp, 700, bold);
            var box = FontTwinGenerator.LineBox.For(16, 20);
            var variant = FontTwinGenerator.GetOrCreateTwin(tmp, Twins, box);
            var plain = AssetDatabase.LoadAssetAtPath<FontAsset>(Twins + "/Box Regular UITK.asset");

            Assert.AreEqual(Twins + "/Box Regular UITK r125s16.asset", AssetDatabase.GetAssetPath(variant));
            Assert.IsNotNull(plain, "the plain twin is made too (its face is the variant's source)");
            var f = plain.faceInfo;
            var v = variant.faceInfo;
            Assert.AreEqual(1.25f * f.pointSize, v.lineHeight, 1e-3f, "line height = r × pointSize");
            Assert.Less(v.lineHeight, 1.25f * f.pointSize, "a hair below, so UI Toolkit's ceil keeps the whole line box");
            Assert.AreEqual(ChromiumBaseline(f, 16, 20) / 16 * f.pointSize, v.ascentLine, 1e-3f, "the baseline where Chromium puts it in a 16/20 line");
            Assert.AreEqual(v.ascentLine - v.lineHeight, v.descentLine, 1e-3f, "ascent and descent lines span the line box");
            Assert.AreEqual(f.pointSize, v.pointSize);
            Assert.AreEqual(f.capLine, v.capLine, "glyph metrics stay");
            CollectionAssert.AreEqual(new[] { "Box Fallback UITK r125s16" }, variant.fallbackFontAssetTable.Select(x => x.name).ToArray(), "same-size fallbacks");
            Assert.AreEqual("Box Bold UITK r125s16", variant.fontWeightTable[7].regularTypeface.name, "same-size weight faces");

            // the face survives a forced re-import and a second pass writes nothing new
            AssetDatabase.ImportAsset(AssetDatabase.GetAssetPath(variant), ImportAssetOptions.ForceUpdate);
            var again = FontTwinGenerator.GetOrCreateTwin(tmp, Twins, box);
            Assert.AreSame(variant, again);
            Assert.AreEqual(1.25f * f.pointSize, AssetDatabase.LoadAssetAtPath<FontAsset>(Twins + "/Box Regular UITK r125s16.asset").faceInfo.lineHeight, 1e-3f);
        }

        [UnityTest]
        public IEnumerator LineBoxVariant_LabelsAreExactlyTheCssLineBoxTall_WithTheBaselineWhereChromiumPutsIt()
        {
            // 16 px text in a 20 px CSS line box: Chromium lays the baseline out at ChromiumBaseline CSS px below the line top
            var variant = FontTwinGenerator.GetOrCreateTwin(FontFixture.Regular, Twins, FontTwinGenerator.LineBox.For(16, 20));
            var plain = AssetDatabase.LoadAssetAtPath<FontAsset>(Twins + "/Inter Fixture UITK.asset").faceInfo;
            double chromium = ChromiumBaseline(plain, 16, 20);
            foreach (var scale in new[] { 1f, 0.75f, 0.5f })
            {
                _rt = new RenderTexture(256, 256, 24, RenderTextureFormat.ARGB32);
                _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
                _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
                _settings.scale = scale;
                _settings.targetTexture = _rt;
                _settings.clearColor = true;
                _settings.colorClearValue = Color.black;
                _go = new GameObject("LineBoxVariant");
                var doc = _go.AddComponent<UIDocument>();
                doc.panelSettings = _settings;
                var root = doc.rootVisualElement;
                var labels = new[] { 1, 2, 5 }.Select((lines, i) =>
                {
                    var l = new Label(string.Join("\n", Enumerable.Repeat("H", lines))) { name = "l" + lines };
                    l.style.position = Position.Absolute;
                    l.style.left = 10 + 30 * i;
                    l.style.top = 10;
                    l.style.fontSize = 16;
                    l.style.color = Color.white;
                    l.style.unityFontDefinition = FontDefinition.FromSDFFont(variant);
                    root.Add(l);
                    return l;
                }).ToList();
                for (int i = 0; i < 8; i++) yield return null;

                CollectionAssert.AreEqual(new[] { 20f, 40f, 100f }, labels.Select(l => l.layout.height).ToArray(), "line boxes at scale " + scale);
                var ir = TestIr.Screen(TestIr.Root(), "box.test");
                ir.Root.Children = labels.Select(l => { var n = TestIr.Node(l.name, "text"); n.Text = new IrText { Tr = "H" }; return n; }).ToArray();
                var measured = BoxesWriter.Measure("c", root, new Vector2Int(256, 256), scale, ir);
                foreach (var l in labels)
                {
                    var lines = (Newtonsoft.Json.Linq.JArray)measured["elements"][l.name]["lines"];
                    Assert.AreEqual(int.Parse(l.name.Substring(1)), lines.Count, l.name + " lines");
                    // the label's top lands on the device grid (Yoga); the baseline is Chromium's below it
                    Assert.AreEqual((double)measured["elements"][l.name]["y"] + chromium * scale, (double)lines[0]["baseline"], 0.01, l.name + ": first baseline at scale " + scale + " (device px)");
                    for (int k = 1; k < lines.Count; k++)
                        Assert.AreEqual(20 * scale, (double)lines[k]["baseline"] - (double)lines[k - 1]["baseline"], 2e-3, l.name + ": line pitch");
                }

                // the rendered glyph sits on that baseline: the bottom of the H's ink in the one-line label
                var tex = new Texture2D(256, 256, TextureFormat.RGBA32, false, true);
                var active = RenderTexture.active;
                RenderTexture.active = _rt;
                tex.ReadPixels(new Rect(0, 0, 256, 256), 0, 0, false);
                tex.Apply(false);
                RenderTexture.active = active;
                var first = labels[0].worldBound;
                int x0 = Mathf.FloorToInt(first.xMin * scale), x1 = Mathf.CeilToInt(first.xMax * scale);
                int inkBottom = -1;
                for (int y = Mathf.FloorToInt(first.yMin * scale); y < Mathf.CeilToInt(first.yMax * scale); y++)
                    for (int x = x0; x < x1; x++)
                        if (tex.GetPixel(x, 255 - y).r > 0.5f) inkBottom = y + 1;
                Object.DestroyImmediate(tex);
                Assert.AreEqual(10 + chromium, inkBottom / scale, 1.0 / scale + 0.01, "ink bottom of 'H' at scale " + scale);

                Object.DestroyImmediate(_go);
                Object.DestroyImmediate(_settings);
                Object.DestroyImmediate(_rt);
            }
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

        /// <summary>
        /// A fallback cycle terminates and leaves no cycle among the twins (the advanced text generator rejects them): the
        /// entry that leads back to the twin being made is left out, and the run notes it.
        /// </summary>
        [Test]
        public void Twin_FallbackCycle_Terminates_WithoutACycleAmongTheTwins()
        {
            var a = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Cycle A");
            var b = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin Cycle B");
            FontFixture.SetFallbacks(a, b);
            FontFixture.SetFallbacks(b, a);
            var run = new FontTwinGenerator.TwinRun(new TMP_FontAsset[0]);
            var twin = FontTwinGenerator.GetOrCreateTwin(a, Twins, run);
            var twinB = twin.fallbackFontAssetTable.Single();
            Assert.AreEqual("Twin Cycle B UITK", twinB.name);
            CollectionAssert.IsEmpty(twinB.fallbackFontAssetTable, "B's fallback to A would close the cycle");
            Assert.IsTrue(run.Notes.Any(n => n.Contains("'Twin Cycle B' falls back to 'Twin Cycle A'")), string.Join("\n", run.Notes));
        }

        /// <summary>The fonts reachable from <paramref name="font"/> through fallback lists and weight tables, as the advanced generator walks them.</summary>
        static bool ReachesACycle(UnityEngine.TextCore.Text.FontAsset font, List<UnityEngine.TextCore.Text.FontAsset> path = null)
        {
            path = path ?? new List<UnityEngine.TextCore.Text.FontAsset>();
            if (path.Contains(font)) return true;
            path.Add(font);
            var next = (font.fallbackFontAssetTable ?? new List<UnityEngine.TextCore.Text.FontAsset>())
                .Concat(font.fontWeightTable.SelectMany(w => new[] { w.regularTypeface, w.italicTypeface })).Where(f => f != null);
            foreach (var f in next) if (ReachesACycle(f, path)) return true;
            path.RemoveAt(path.Count - 1);
            return false;
        }

        /// <summary>
        /// TMP tables as games often set them (a regular face listing itself at 400 and its bold face at 700; the bold face
        /// listing both and falling back to the regular one; a script font falling back to the regular face): the twins have no
        /// cycle, the regular twin keeps its bold face and the script twin its Latin fallback, in plain twins and line-box
        /// variants alike. The left-out entries are those no generator uses, so the run has no note.
        /// </summary>
        [Test]
        public void Twins_OfSelfListingWeightTables_HaveNoCycle_AndKeepTheBoldFaceAndTheLatinFallback()
        {
            var regular = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Game Regular");
            var bold = FontFixture.CreateTmp(FontFixture.BoldTtf, "Twin Game Bold");
            var script = FontFixture.CreateTmp(FontFixture.RegularTtf, "Twin Game Script");
            FontFixture.SetWeight(regular, 400, regular);
            FontFixture.SetWeight(regular, 700, bold);
            FontFixture.SetWeight(bold, 400, regular);
            FontFixture.SetWeight(bold, 700, bold);
            FontFixture.SetFallbacks(bold, regular);
            FontFixture.SetFallbacks(script, regular);
            foreach (var box in new[] { null, FontTwinGenerator.LineBox.For(16, 20) })
            {
                var run = new FontTwinGenerator.TwinRun(new TMP_FontAsset[0]);
                var regularTwin = FontTwinGenerator.GetOrCreateTwin(regular, Twins, run, box);
                var scriptTwin = FontTwinGenerator.GetOrCreateTwin(script, Twins, run, box);
                var boldTwin = regularTwin.fontWeightTable[7].regularTypeface;
                Assert.IsNotNull(boldTwin, "the regular twin keeps its bold face");
                StringAssert.StartsWith("Twin Game Bold UITK", boldTwin.name);
                Assert.IsNull(regularTwin.fontWeightTable[4].regularTypeface, "a face does not list itself");
                Assert.IsNull(boldTwin.fontWeightTable[4].regularTypeface, "the regular face at 400 is never looked up");
                Assert.IsNull(boldTwin.fontWeightTable[7].regularTypeface, "a face does not list itself");
                CollectionAssert.DoesNotContain(boldTwin.fallbackFontAssetTable, regularTwin, "the bold face's fallback to its regular face would close a cycle");
                CollectionAssert.AreEqual(new[] { regularTwin }, scriptTwin.fallbackFontAssetTable, "the script twin keeps its Latin fallback");
                foreach (var t in new[] { regularTwin, boldTwin, scriptTwin }) Assert.IsFalse(ReachesACycle(t), t.name + " reaches a cycle");
                CollectionAssert.IsEmpty(run.Notes);
            }
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
