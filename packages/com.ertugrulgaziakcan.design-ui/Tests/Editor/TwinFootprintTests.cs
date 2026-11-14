using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using TMPro;
using UnityEditor;
using UnityEditorInternal;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.TextCore.LowLevel;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The font twins' disk footprint: a line-box variant's file holds no glyphs and the loaded variant renders its twin's
    /// (<see cref="FontTwinLink"/>, <see cref="TwinLinks"/>); a twin's atlas pages are sized to its glyphs and its font features
    /// are its own glyphs' (<see cref="TwinAtlas"/>); twins nothing uses leave the folder (<see cref="TwinPrune"/>).
    /// </summary>
    public class TwinFootprintTests
    {
        const string Twins = FontFixture.TwinFolder;
        const string Text = "Takvim Kulüp Başkanı 2026 12:15";

        readonly List<Object> _objects = new List<Object>();
        readonly List<string> _assets = new List<string>();
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            if (_rt != null) Object.DestroyImmediate(_rt);
            foreach (var o in _objects) if (o != null && !EditorUtility.IsPersistent(o)) Object.DestroyImmediate(o);
            _objects.Clear();
            foreach (var a in _assets) AssetDatabase.DeleteAsset(a);
            _assets.Clear();
            typeof(FontAsset).GetMethod("UpdateFontAssetsInUpdateQueue", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public)?.Invoke(null, null);
            FontFixture.Delete();
        }

        static readonly FontTwinGenerator.LineBox Box = FontTwinGenerator.LineBox.For(16, 20);

        /// <summary>A plain twin and its 16/20 variant of a new TMP asset, with <paramref name="text"/> pre-added as an import does.</summary>
        static (FontAsset plain, FontAsset variant, FontTwinGenerator.TwinRun run) Pair(string name, string text = Text, int atlas = 1024, bool kept = false)
        {
            // fonts that render text from two pages (two materials) stay until the end of the session (FontFixture.KeptFolder)
            var tmp = kept ? FontFixture.Kept(FontFixture.RegularTtf, name) : FontFixture.CreateTmp(FontFixture.RegularTtf, name, atlas: atlas);
            var folder = kept ? FontFixture.KeptTwinFolder : Twins;
            var run = new FontTwinGenerator.TwinRun(new TMP_FontAsset[0]);
            var plain = FontTwinGenerator.GetOrCreateTwin(tmp, folder, run);
            var variant = FontTwinGenerator.GetOrCreateTwin(tmp, folder, run, Box);
            int before = plain.characterTable.Count;
            if (text != null) DesignText.Prepare(plain, text);
            TwinAtlas.Maintain(run, plain.characterTable.Count != before ? new[] { plain } : null);
            return (plain, variant, run);
        }

        static T InFile<T>(string path, Func<FontAsset, T> read)
        {
            var loaded = InternalEditorUtility.LoadSerializedFileAndForget(path);
            try { return read(loaded.OfType<FontAsset>().Single()); }
            finally { foreach (var o in loaded) if (o != null) Object.DestroyImmediate(o); }
        }

        [Test]
        public void Variant_FileHoldsNoGlyphs_AndTheLoadedVariantSharesItsTwinsGlyphsAndPages()
        {
            var (plain, variant, _) = Pair("Foot Share");
            var path = AssetDatabase.GetAssetPath(variant);

            Assert.AreSame(plain, FontTwinLink.SourceOf(variant), "linked to its plain twin");
            Assert.AreSame(plain.atlasTextures[0], variant.atlasTextures[0], "one atlas: the twin's pages");
            Assert.AreSame(plain.material, variant.material);
            Assert.AreEqual(plain.glyphTable.Count, variant.glyphTable.Count);
            CollectionAssert.AreEquivalent(plain.characterTable.Select(c => c.unicode).ToArray(), variant.characterTable.Select(c => c.unicode).ToArray());
            Assert.IsTrue(variant.characterTable.All(c => c.textAsset == variant), "its characters lay lines out with its own face metrics");
            Assert.AreEqual(Box.Face(plain.faceInfo).lineHeight, variant.faceInfo.lineHeight, 1e-3f, "the variant's line box");

            Assert.AreEqual(0, InFile(path, f => f.glyphTable.Count), "no glyphs in the variant's file");
            Assert.AreEqual(0, InFile(path, f => f.characterTable.Count));
            Assert.AreEqual(1, InFile(path, f => f.atlasTextures.Length));
            Assert.LessOrEqual(InFile(path, f => f.atlasTextures[0].width), 1, "a 1×1 page of its own");
            Assert.Less(new FileInfo(path).Length, 64 * 1024, "a variant's file is a few KB");
            Assert.Greater(InFile(AssetDatabase.GetAssetPath(plain), f => f.glyphTable.Count), 10, "the twin's file holds the glyphs");
        }

        [Test]
        public void Save_LeavesALinkedVariantsFileAsItIs()
        {
            var (_, variant, _) = Pair("Foot Save");
            var path = AssetDatabase.GetAssetPath(variant);
            var bytes = File.ReadAllBytes(path);
            EditorUtility.SetDirty(variant);
            AssetDatabase.SaveAssetIfDirty(variant);
            CollectionAssert.AreEqual(bytes, File.ReadAllBytes(path), "a save leaves a linked variant out");
            Assert.IsTrue(FontTwinLink.IsLinked(variant));
        }

        [Test]
        public void Unlink_GivesTheVariantItsOwnEmptyState_AndDeletingAVariantKeepsItsTwinsPages()
        {
            var (plain, variant, run) = Pair("Foot Unlink");
            var page = plain.atlasTextures[0];
            var pixels = page.GetPixels32();

            Assert.IsTrue(TwinLinks.Unlink(variant));
            Assert.IsFalse(FontTwinLink.IsLinked(variant));
            Assert.AreNotSame(page, variant.atlasTextures[0]);
            Assert.AreEqual(0, variant.glyphTable.Count);
            Assert.AreEqual(AssetDatabase.GetAssetPath(variant), AssetDatabase.GetAssetPath(variant.atlasTextures[0]), "its own page");

            TwinLinks.Link(run);
            Assert.IsTrue(FontTwinLink.IsLinked(variant));
            Assert.IsTrue(AssetDatabase.DeleteAsset(AssetDatabase.GetAssetPath(variant)));
            Assert.IsTrue(page != null, "the twin's page survives the variant");
            CollectionAssert.AreEqual(pixels, page.GetPixels32());
            Assert.AreSame(page, plain.atlasTextures[0]);
        }

        [Test]
        public void DesignTextPrepare_OnALinkedVariant_AddsToItsTwin_AndLinksItAgain()
        {
            var (plain, variant, _) = Pair("Foot Prepare");
            Assert.IsFalse(plain.characterLookupTable.ContainsKey('Ж'));
            Assert.AreEqual("", DesignText.Prepare(variant, "Жж"));
            Assert.IsTrue(plain.characterLookupTable.ContainsKey('Ж'), "the twin got it");
            Assert.IsTrue(variant.characterLookupTable.ContainsKey('Ж'), "the variant renders it from the twin's page");
            Assert.AreSame(plain.atlasTextures[0], variant.atlasTextures[0]);
            Assert.IsTrue(FontTwinLink.IsLinked(variant));
        }

        VisualElement Panel(int w, int h)
        {
            _rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32);
            _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _settings.clearColor = true;
            _settings.colorClearValue = Color.black;
            _go = new GameObject("TwinFootprintTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            return doc.rootVisualElement;
        }

        static Label At(VisualElement root, string text, FontAsset font, float top)
        {
            var l = new Label(text);
            l.style.position = Position.Absolute;
            l.style.left = 4;
            l.style.top = top;
            l.style.fontSize = 16;
            l.style.color = Color.white;
            l.style.unityFontDefinition = FontDefinition.FromSDFFont(font);
            root.Add(l);
            return l;
        }

        Color32[] Pixels()
        {
            var tex = new Texture2D(_rt.width, _rt.height, TextureFormat.RGBA32, false, true);
            var active = RenderTexture.active;
            RenderTexture.active = _rt;
            tex.ReadPixels(new Rect(0, 0, _rt.width, _rt.height), 0, 0, false);
            tex.Apply(false);
            RenderTexture.active = active;
            var p = tex.GetPixels32();
            Object.DestroyImmediate(tex);
            return p;
        }

        static Color32[] Rows(Color32[] all, int width, int height, int top, int rows)
        {
            // rows top..top+rows of a bottom-up texture
            var result = new Color32[width * rows];
            for (int r = 0; r < rows; r++) Array.Copy(all, (height - 1 - (top + r)) * width, result, r * width, width);
            return result;
        }

        [UnityTest]
        public IEnumerator LinkedVariant_RendersTheSamePixels_AsTheVariantWithGlyphsOfItsOwn()
        {
            var (plain, variant, _) = Pair("Foot Pixels");
            var root = Panel(320, 32);

            // the variant as an older package kept it: unlinked, the glyphs added to its own page
            TwinLinks.Unlink(variant);
            Assert.IsNotNull(variant.material, "own material");
            Assert.IsTrue(variant.atlasTextures[0] == variant.material.mainTexture, "own material samples its own page");
            Assert.AreEqual("", DesignText.Prepare(variant, Text));
            DesignText.ClearPairFlags(variant);
            Assert.AreNotSame(plain.atlasTextures[0], variant.atlasTextures[0]);
            Assert.IsTrue(variant.atlasTextures[0] == variant.material.mainTexture, "after the glyphs");
            var own = At(root, Text, variant, 4);
            for (int i = 0; i < 8; i++) yield return null;
            var ownBox = own.layout;
            var ownPixels = Rows(Pixels(), 320, 32, 4, 24);
            root.Remove(own);

            // linked: the twin's glyphs and page
            Assert.IsTrue(FontTwinLink.Link(variant, plain));
            Assert.AreSame(plain.atlasTextures[0], variant.atlasTextures[0]);
            Assert.IsTrue(plain.atlasTextures[0] == variant.material.mainTexture, "the twin's material samples the shared page");
            var linked = At(root, Text, variant, 4);
            for (int i = 0; i < 8; i++) yield return null;
            Assert.AreEqual(ownBox, linked.layout, "same box");
            var linkedPixels = Rows(Pixels(), 320, 32, 4, 24);
            Assert.IsTrue(linkedPixels.Any(c => c.r > 128), "the line has ink");
            CollectionAssert.AreEqual(ownPixels, linkedPixels, "every pixel of the line is the same");
        }

        [Test]
        public void LinkedVariant_AGlyphItAddsItself_GoesToAPageOfItsOwn_AndLeavesTheSharedPageAlone()
        {
            var (plain, variant, _) = Pair("Foot Own Page");
            var page = plain.atlasTextures[0];
            var pixels = page.GetPixels32();
            int glyphs = plain.glyphTable.Count, pages = plain.atlasTextures.Length;

            // what TextCore does for text nobody prepared while it lays the text out (no panel here: a text drawn from two pages
            // leaves its second material in UI Toolkit's pooled meshes, which later tests would draw)
            Assert.IsTrue(variant.TryAddCharacters("Жизнь", out string _, true));
            Assert.Greater(variant.glyphTable.Count, glyphs, "the variant added the glyphs");
            var own = variant.atlasTextures.Where(t => t != null && t != page).ToList();
            Assert.AreEqual(1, own.Count, "on a page of its own");
            Assert.AreEqual(1, variant.glyphTable.Where(g => g.atlasIndex > 0).Select(g => g.atlasIndex).Distinct().Count());
            Assert.AreEqual(glyphs, plain.glyphTable.Count, "the twin is untouched");
            Assert.AreEqual(pages, plain.atlasTextures.Length);
            CollectionAssert.AreEqual(pixels, page.GetPixels32(), "the shared page's pixels are untouched");

            // unlinked (as before a save), the page it added leaves its file, without being destroyed or unloaded
            TwinLinks.Unlink(variant);
            Assert.IsTrue(own.All(t => t != null), "not destroyed");
            Assert.IsTrue(own.All(t => !EditorUtility.IsPersistent(t)), "not in the variant's file");
            Assert.IsTrue(own.All(t => (t.hideFlags & HideFlags.DontUnloadUnusedAsset) != 0), "kept loaded while text may draw from it");
        }

        [Test]
        public void Atlas_IsSizedToTheGlyphs_OnOnePage_NeverLargerThanTheTmpAtlas()
        {
            var (plain, _, run) = Pair("Foot Small", atlas: 4096);
            var (needed, w0, h0) = TwinAtlas.GlyphArea(plain);
            Assert.AreEqual(TwinAtlas.PageFor(needed, w0, h0, new Vector2Int(4096, 4096)), new Vector2Int(plain.atlasWidth, plain.atlasHeight), "a few glyphs: a page for them");
            Assert.AreEqual(new Vector2Int(TwinAtlas.MinPage, TwinAtlas.MinPage), new Vector2Int(plain.atlasWidth, plain.atlasHeight), "about 20 glyphs at 72 pt: the smallest page");
            Assert.AreEqual(1, TwinAtlas.PagesInUse(plain));

            // many glyphs: one page that holds them, still within the TMP asset's atlas
            var many = new string(Enumerable.Range(0x21, 0x5E).Concat(Enumerable.Range(0xC0, 0x40)).Concat(Enumerable.Range(0x410, 0x40)).Select(c => (char)c).ToArray());
            int before = plain.characterTable.Count;
            DesignText.Prepare(plain, many);
            TwinAtlas.Maintain(run, new[] { plain });
            Assert.Greater(plain.characterTable.Count, before + 150);
            Assert.AreEqual(1, TwinAtlas.PagesInUse(plain), "one page");
            var (area, _, _) = TwinAtlas.GlyphArea(plain);
            Assert.GreaterOrEqual((long)plain.atlasWidth * plain.atlasHeight, area);
            Assert.LessOrEqual((long)plain.atlasWidth * plain.atlasHeight, Math.Max(area * 4, (long)TwinAtlas.MinPage * TwinAtlas.MinPage), "and not much larger");
            Assert.AreEqual(plain.atlasWidth, plain.atlasTextures[0].width, "the page has the twin's page size");
            Assert.IsTrue(many.All(c => plain.characterLookupTable.ContainsKey(c) || char.IsWhiteSpace(c)), "every character kept through the repack");
        }

        [Test]
        public void Atlas_AnOversizedTwinFromAnOlderPackage_IsRepackedSmall_WithItsGlyphs()
        {
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Foot Old", atlas: 4096);
            // what an older package wrote: the TMP asset's 4096 px page for a few glyphs
            var path = FontTwinGenerator.TwinPath(tmp, Twins);
            var old = FontTwinGenerator.Build(tmp, TmpSourceFont.GetSourceFont(tmp), FontTwinGenerator.TwinRenderMode(tmp), new Vector2Int(4096, 4096));
            old.name = Path.GetFileNameWithoutExtension(path);
            Directory.CreateDirectory(Twins);
            AssetDatabase.ImportAsset(Twins);
            AssetDatabase.CreateAsset(old, path);
            FontTwinGenerator.StoreSubAssets(old);
            DesignText.Prepare(old, Text);
            FontTwinGenerator.StoreSubAssets(old);
            EditorUtility.SetDirty(old);
            AssetDatabase.SaveAssetIfDirty(old);
            long before = new FileInfo(path).Length;
            Assert.AreEqual(4096, old.atlasTextures[0].width);
            int characters = old.characterTable.Count;

            var run = new FontTwinGenerator.TwinRun(new TMP_FontAsset[0]);
            var twin = FontTwinGenerator.GetOrCreateTwin(tmp, Twins, run);
            Assert.AreSame(old, twin, "the same asset, kept");
            TwinAtlas.Maintain(run);
            var (needed, gw, gh) = TwinAtlas.GlyphArea(twin);
            var page = TwinAtlas.PageFor(needed, gw, gh, new Vector2Int(4096, 4096));
            Assert.AreEqual(page, new Vector2Int(twin.atlasWidth, twin.atlasHeight));
            Assert.AreEqual(page.x, twin.atlasTextures[0].width);
            Assert.AreEqual(1, TwinAtlas.PagesInUse(twin));
            Assert.AreEqual(characters, twin.characterTable.Count, "its characters, on the new page");
            long after = new FileInfo(path).Length;
            Assert.Less(after * 10, before, "the file shrank by far (a 4096 px page for a few glyphs): " + before + " → " + after + " bytes");
        }

        static Dictionary<(uint, uint), float> Pairs(FontAsset f)
        {
            var list = (List<GlyphPairAdjustmentRecord>)typeof(UnityEngine.TextCore.Text.FontFeatureTable)
                .GetField("m_GlyphPairAdjustmentRecords", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).GetValue(f.fontFeatureTable);
            return list.ToDictionary(r => (r.firstAdjustmentRecord.glyphIndex, r.secondAdjustmentRecord.glyphIndex), r => r.firstAdjustmentRecord.glyphValueRecord.xAdvance);
        }

        [Test]
        public void Features_AreTheTwinsOwnGlyphsPairs_AndAPairAddedInALaterBatchIsThere()
        {
            // in batches, pruned after each, as imports add and prune
            var (batched, _, run) = Pair("Foot Batches", "T");
            foreach (var part in new[] { "r", "AV", "oy" })
            {
                DesignText.Prepare(batched, part);
                TwinAtlas.Maintain(run, new[] { batched });
            }
            var (once, _, _) = Pair("Foot Once", "TrAVoy");

            var have = new HashSet<uint>(batched.glyphTable.Select(g => g.index));
            var pairs = Pairs(batched);
            Assert.IsTrue(pairs.Keys.All(k => have.Contains(k.Item1) && have.Contains(k.Item2)), "only pairs of the twin's own glyphs");
            Assert.Greater(pairs.Count, 0, "Inter kerns these");
            uint G(FontAsset f, char c) => f.characterLookupTable[c].glyphIndex;
            Assert.IsTrue(pairs.ContainsKey((G(batched, 'T'), G(batched, 'r'))), "T then r, added in a later batch than T");
            Assert.IsTrue(pairs.ContainsKey((G(batched, 'A'), G(batched, 'V'))));
            var expected = Pairs(once);
            var missing = expected.Keys.Where(k => !pairs.ContainsKey(k)).ToList();
            var extra = pairs.Keys.Where(k => !expected.ContainsKey(k)).ToList();
            Assert.IsTrue(missing.Count == 0 && extra.Count == 0, "the pairs of one batch, added in four with pruning between; missing " +
                string.Join(" ", missing) + ", extra " + string.Join(" ", extra));
            foreach (var kv in expected) Assert.AreEqual(kv.Value, pairs[kv.Key], 1e-4f, "pair " + kv.Key);
        }

        /// <summary>
        /// Pins what <see cref="DesignText.CompleteFeatures"/> works around (measured on 6000.3): TextCore stores a new glyph's
        /// kerning pairs with the new glyph first only, against every glyph of the font file.
        /// </summary>
        [Test]
        public void TextCore_StoresANewGlyphsPairs_WithItFirstOnly()
        {
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Foot Dir");
            var f = FontTwinGenerator.Build(tmp, TmpSourceFont.GetSourceFont(tmp), GlyphRenderMode.SDFAA, new Vector2Int(512, 512));
            _objects.Add(f);
            f.TryAddCharacters("T", out string _, true);
            uint t = f.characterLookupTable['T'].glyphIndex;
            var first = Pairs(f);
            Assert.Greater(first.Keys.Count(k => k.Item1 == t), 100, "T first, with glyphs of the font the asset does not hold");
            Assert.AreEqual(0, first.Keys.Count(k => k.Item2 == t), "T never second");
            // with only its own glyphs' pairs kept, a glyph added later brings its pairs as first glyph only
            Assert.Greater(DesignText.CompleteFeatures(f), 100);
            f.TryAddCharacters("r", out string _, true);
            uint r = f.characterLookupTable['r'].glyphIndex;
            Assert.IsFalse(Pairs(f).ContainsKey((t, r)), "T then r is missing until the records are completed");
            DesignText.CompleteFeatures(f);
            Assert.IsTrue(Pairs(f).ContainsKey((t, r)), "completed");
            Assert.IsTrue(Pairs(f).Keys.All(k => k.Item1 == t || k.Item1 == r), "and only the font's own glyphs' pairs");
        }

        // ---- stale twins -----------------------------------------------------------------------------------------------

        string Kit(string styles)
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-foot-kit-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            File.WriteAllText(dir + "/kit.config.json", "{\"fontsCss\":\"fonts/fonts.css\",\"textStyles\":\"text-styles.json\",\"locales\":[\"tr\"]}\n");
            File.WriteAllText(dir + "/text-styles.json", styles);
            _cleanupDirs.Add(dir);
            return dir;
        }

        readonly List<string> _cleanupDirs = new List<string>();

        [TearDown]
        public void CleanupDirs()
        {
            foreach (var d in _cleanupDirs) if (Directory.Exists(d)) Directory.Delete(d, true);
            _cleanupDirs.Clear();
        }

        const string TwoBoxes = "{ \"label\": { \"fontSize\": 16, \"lineHeight\": 20, \"weight\": 400 }, \"body\": { \"fontSize\": 24, \"lineHeight\": 32, \"weight\": 700 } }";
        const string OneBox = "{ \"label\": { \"fontSize\": 16, \"lineHeight\": 20, \"weight\": 400 } }";

        DesignUiProfile Profile(TMP_FontAsset font, string kit, string folder = Twins)
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            _objects.Add(p);
            p.referenceLocale = "tr";
            p.locales = new[] { "tr" };
            p.localeFonts = new[] { new LocaleFont { locale = "tr", font = font } };
            p.fontTwinFolder = folder;
            p.kitDir = kit;
            return p;
        }

        static string[] Files(string folder) =>
            Directory.GetFiles(folder, "*.asset").Select(f => Path.GetFileName(f)).OrderBy(f => f, StringComparer.Ordinal).ToArray();

        [Test]
        public void KitSync_RemovesTwinsOfFacesAndLineBoxesNothingUses_AndReportsThem()
        {
            var bold = FontFixture.CreateTmp(FontFixture.BoldTtf, "Prune Bold");
            var light = FontFixture.CreateTmp(FontFixture.RegularTtf, "Prune Light");
            var regular = FontFixture.CreateTmp(FontFixture.RegularTtf, "Prune Regular");
            FontFixture.SetWeight(regular, 700, bold);
            FontFixture.SetWeight(regular, 300, light);
            var profile = Profile(regular, Kit(TwoBoxes));

            // an older package: every face of the weight table got twins, and a line box the table no longer has
            var plan = FontMap.Plan(profile, new ProfileLocaleFontResolver(profile, null));
            plan.LineBoxes = new[] { FontTwinGenerator.LineBox.For(16, 20), FontTwinGenerator.LineBox.For(24, 32), FontTwinGenerator.LineBox.For(32, 40) };
            plan.Faces = null;
            FontMap.EnsureTwins(plan);
            CollectionAssert.Contains(Files(Twins), "Prune Light UITK.asset");
            CollectionAssert.Contains(Files(Twins), "Prune Regular UITK r125s32.asset");

            var r = KitSync.Run(profile, Kit(OneBox), new ProfileLocaleFontResolver(profile, null));
            Assert.IsTrue(r.Ok, string.Join("\n", r.Errors));
            CollectionAssert.AreEqual(new[]
            {
                "Prune Bold UITK r125s16.asset", "Prune Bold UITK.asset", "Prune Regular UITK r125s16.asset", "Prune Regular UITK.asset",
            }, Files(Twins), "the twins the kit's faces (400, 700) and its one line box use");
            CollectionAssert.IsSupersetOf(r.RemovedTwins.ToArray(), new[]
            {
                Twins + "/Prune Light UITK.asset", Twins + "/Prune Light UITK r125s16.asset", Twins + "/Prune Regular UITK r125s32.asset",
                Twins + "/Prune Regular UITK r13333s24.asset",
            });
        }

        string SaveProfile(DesignUiProfile p)
        {
            var path = Twins + "/../FootprintProfile.asset";
            path = Path.GetFullPath(path).Replace('\\', '/');
            path = path.Substring(path.IndexOf("/Assets/", StringComparison.Ordinal) + 1);
            var copy = Object.Instantiate(p);
            AssetDatabase.CreateAsset(copy, path);
            _assets.Add(path);
            return path;
        }

        [Test]
        public void Prune_KeepsTheTwinsOfAnotherProfileInTheSameFolder()
        {
            var a = FontFixture.CreateTmp(FontFixture.RegularTtf, "Prune A");
            var b = FontFixture.CreateTmp(FontFixture.BoldTtf, "Prune B");
            var other = Profile(b, Kit(OneBox));
            var otherPath = SaveProfile(other);
            var otherAsset = AssetDatabase.LoadAssetAtPath<DesignUiProfile>(otherPath);
            var rb = KitSync.Run(otherAsset, otherAsset.kitDir, new ProfileLocaleFontResolver(otherAsset, null));
            Assert.IsTrue(rb.Ok, string.Join("\n", rb.Errors));
            CollectionAssert.Contains(Files(Twins), "Prune B UITK.asset");

            var mine = Profile(a, Kit(OneBox));
            var ra = KitSync.Run(mine, mine.kitDir, new ProfileLocaleFontResolver(mine, null));
            Assert.IsTrue(ra.Ok, string.Join("\n", ra.Errors));
            CollectionAssert.IsSubsetOf(new[] { "Prune A UITK.asset", "Prune A UITK r125s16.asset", "Prune B UITK.asset", "Prune B UITK r125s16.asset" }, Files(Twins),
                "the other profile's twins stay");
            CollectionAssert.IsEmpty(ra.RemovedTwins);
        }

        [Test]
        public void Prune_RemovesNothing_WhenAProfileSharingTheFolderCannotBePlanned()
        {
            var a = FontFixture.CreateTmp(FontFixture.RegularTtf, "Prune Kept");
            var broken = Profile(null, null);
            broken.localeFonts = new LocaleFont[0];
            broken.referenceLocale = "";
            SaveProfile(broken);
            var stray = FontTwinGenerator.GetOrCreateTwin(FontFixture.CreateTmp(FontFixture.BoldTtf, "Prune Stray"), Twins);
            Assert.IsNotNull(stray);

            var mine = Profile(a, Kit(OneBox));
            var r = KitSync.Run(mine, mine.kitDir, new ProfileLocaleFontResolver(mine, null));
            Assert.IsTrue(r.Ok, string.Join("\n", r.Errors));
            CollectionAssert.Contains(Files(Twins), "Prune Stray UITK.asset", "nothing removed");
            Assert.IsTrue(r.Warnings.Any(w => w.Contains("unused font twins were not removed")), string.Join("\n", r.Warnings));
        }

        [Test]
        public void FontSet_LinksItsVariants_WhenLoaded_AndAScreenRootLinksThemWhenItsFontsAreSet()
        {
            var (plain, variant, _) = Pair("Foot Set");
            var set = ScriptableObject.CreateInstance<DesignFontSet>();
            set.links = new[] { new DesignFontSet.TwinLink { variant = variant, source = plain } };
            var path = Twins + "/FootSet.asset";
            AssetDatabase.CreateAsset(set, path);

            TwinLinks.Unlink(variant);
            Assert.IsFalse(FontTwinLink.IsLinked(variant));
            Resources.UnloadAsset(set);
            var loaded = AssetDatabase.LoadAssetAtPath<DesignFontSet>(path);
            Assert.IsNotNull(loaded);
            Assert.IsTrue(FontTwinLink.IsLinked(variant), "loading the set linked its variant");

            TwinLinks.Unlink(variant);
            var screen = new DesignScreen { Fonts = loaded };
            Assert.IsTrue(FontTwinLink.IsLinked(variant), "a screen root linked it");
            Assert.AreSame(loaded, screen.Fonts);
        }

        /// <summary>A TextCore member the package reaches by reflection that this Unity version lacks is an issue, never a silent no-op.</summary>
        [Test]
        public void ALocaleController_ReportsTheTextCoreMembersThisUnityVersionLacks()
        {
            var was = DesignText.s_FeatureCheck;
            DesignText.s_FeatureCheck = () => "FontFeatureTable.m_GlyphPairAdjustmentRecordLookup (Unity test)";
            var c = new LocaleFontController(new VisualElement(), null);
            try
            {
                c.SetLocale("tr");
                Assert.IsTrue(c.Issues.Any(i => i.Contains("stray lookup flags") && i.Contains("m_GlyphPairAdjustmentRecordLookup")), string.Join("\n", c.Issues));
                DesignText.s_FeatureCheck = was;
                c.SetLocale("en");
                Assert.IsFalse(c.Issues.Any(i => i.Contains("stray lookup flags")), "on this Unity version every member is there");
            }
            finally
            {
                DesignText.s_FeatureCheck = was;
                c.Dispose();
            }
        }
    }
}
