using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using static DesignUi.Editor.Tests.TestIr;

namespace DesignUi.Editor.Tests
{
    public class DesignAssetImporterTests
    {
        const string OutRoot = "Assets/DesignUiAssetImporterTests";
        const string SharedFolder = OutRoot + "/_assets";

        readonly List<string> _temp = new List<string>();
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;
        DesignUiProfile _profile;

        [SetUp]
        public void Setup()
        {
            _profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            _profile.outputFolder = OutRoot;
        }

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) UnityEngine.Object.DestroyImmediate(_go);
            if (_settings != null) UnityEngine.Object.DestroyImmediate(_settings);
            if (_rt != null) UnityEngine.Object.DestroyImmediate(_rt);
            if (_profile != null) UnityEngine.Object.DestroyImmediate(_profile);
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(OutRoot)) AssetDatabase.DeleteAsset(OutRoot);
        }

        static string Fixture(string file) => IrReaderTests.PackagePath("Tests", "Editor", "Data", "assets~", file);

        /// <summary>An export folder holding the fixture as <c>assets/&lt;name&gt;</c>; returns the folder.</summary>
        string Export(params string[] fixtures)
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-assets-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir + "/assets");
            _temp.Add(dir);
            foreach (var f in fixtures) File.Copy(Fixture(f), dir + "/assets/" + f);
            return dir;
        }

        static IrAsset Asset(string kind, string file) =>
            new IrAsset { Kind = kind, File = "assets/" + file, Sha256 = new string('a', 64), Width = 16, Height = 16 };

        // ---- import settings ---------------------------------------------------------------------------------

        [Test]
        public void Png_ImportsAsAColourTextureWithUiSettings()
        {
            var export = Export("image.png");
            var path = DesignAssetImporter.Import(Asset("image", "image.png"), export, OutRoot, _profile);
            Assert.AreEqual(SharedFolder + "/image.png", path);
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            Assert.IsNotNull(tex);
            Assert.AreEqual(1, tex.mipmapCount);
            Assert.AreEqual(20, tex.width, "no power-of-two scaling");
            Assert.AreEqual(12, tex.height);
            var t = (TextureImporter)AssetImporter.GetAtPath(path);
            Assert.AreEqual(TextureImporterType.Default, t.textureType);
            Assert.IsTrue(t.sRGBTexture, "design colours are sRGB data");
            Assert.IsFalse(t.mipmapEnabled);
            Assert.AreEqual(TextureImporterNPOTScale.None, t.npotScale);
            Assert.IsTrue(t.alphaIsTransparency);
            Assert.AreEqual(FilterMode.Bilinear, t.filterMode);
            Assert.AreEqual(TextureWrapMode.Clamp, t.wrapMode);
            Assert.AreEqual(TextureImporterCompression.Uncompressed, t.textureCompression);
        }

        [Test]
        public void Shadow9_ImportsLikeAnImageAndTakesTheProfileCompression()
        {
            _profile.textureCompression = TextureImporterCompression.CompressedHQ;
            var export = Export("shadow9.png");
            var path = DesignAssetImporter.Import(Asset("shadow9", "shadow9.png"), export, OutRoot, _profile);
            var t = (TextureImporter)AssetImporter.GetAtPath(path);
            Assert.AreEqual(TextureImporterCompression.CompressedHQ, t.textureCompression);
            Assert.IsFalse(t.mipmapEnabled);
            Assert.AreEqual(TextureWrapMode.Clamp, t.wrapMode);
            Assert.AreEqual(0, t.spriteBorder.x, "slices are written by the compiler as -unity-slice-*, not stored in the import");
        }

        [Test]
        public void Svg_ImportsAsAVectorImage()
        {
            var export = Export("icon.svg", "gradient.svg");
            var icon = DesignAssetImporter.Import(Asset("svg", "icon.svg"), export, OutRoot, _profile);
            var grad = DesignAssetImporter.Import(Asset("svg", "gradient.svg"), export, OutRoot, _profile);
            Assert.IsNotNull(AssetDatabase.LoadAssetAtPath<VectorImage>(icon));
            Assert.IsNotNull(AssetDatabase.LoadAssetAtPath<VectorImage>(grad));
            var s = (Unity.VectorGraphics.Editor.SVGImporter)AssetImporter.GetAtPath(grad);
            Assert.AreEqual(Unity.VectorGraphics.Editor.SVGType.VectorImage, s.SvgType);
            Assert.AreEqual(3, (int)s.SvgType);
            Assert.AreEqual(64, s.GradientResolution);
        }

        [Test]
        public void UnknownKind_AndMissingFile_AreErrors()
        {
            var export = Export("image.png");
            Assert.Throws<IrFormatException>(() => DesignAssetImporter.Import(Asset("video", "image.png"), export, OutRoot, _profile));
            Assert.Throws<IrFormatException>(() => DesignAssetImporter.Import(Asset("image", "nope.png"), export, OutRoot, _profile));
        }

        // ---- incremental imports (R22) -----------------------------------------------------------------------

        [Test]
        public void ImportingTheSameAssetTwice_ReturnsTheSamePathWithoutReimport()
        {
            var export = Export("image.png", "icon.svg");
            var assets = new[] { Asset("image", "image.png"), Asset("svg", "icon.svg") };
            foreach (var a in assets)
            {
                var first = DesignAssetImporter.Import(a, export, OutRoot, _profile);
                var hash = AssetDatabase.GetAssetDependencyHash(first);
                var meta = File.GetLastWriteTimeUtc(first + ".meta");
                var file = File.GetLastWriteTimeUtc(first);
                var count = DesignAssetImporter.ImportCount;
                var second = DesignAssetImporter.Import(a, export, OutRoot, _profile);
                Assert.AreEqual(first, second);
                Assert.AreEqual(hash, AssetDatabase.GetAssetDependencyHash(second), "no reimport");
                Assert.AreEqual(count, DesignAssetImporter.ImportCount, "no import queued");
                Assert.AreEqual(meta, File.GetLastWriteTimeUtc(second + ".meta"), ".meta untouched");
                Assert.AreEqual(file, File.GetLastWriteTimeUtc(second), "file untouched");
            }
        }

        [Test]
        public void ChangedProfileCompression_ReimportsOnlyThatAsset()
        {
            var export = Export("image.png", "icon.svg");
            var image = DesignAssetImporter.Import(Asset("image", "image.png"), export, OutRoot, _profile);
            var icon = DesignAssetImporter.Import(Asset("svg", "icon.svg"), export, OutRoot, _profile);
            var iconHash = AssetDatabase.GetAssetDependencyHash(icon);
            _profile.textureCompression = TextureImporterCompression.Compressed;
            var count = DesignAssetImporter.ImportCount;
            DesignAssetImporter.Import(Asset("image", "image.png"), export, OutRoot, _profile);
            DesignAssetImporter.Import(Asset("svg", "icon.svg"), export, OutRoot, _profile);
            Assert.AreEqual(count + 1, DesignAssetImporter.ImportCount);
            Assert.AreEqual(TextureImporterCompression.Compressed, ((TextureImporter)AssetImporter.GetAtPath(image)).textureCompression);
            Assert.AreEqual(iconHash, AssetDatabase.GetAssetDependencyHash(icon));
        }

        [Test]
        public void ImportsQueuedInABatch_TakeTheirSettingsAtTheFirstImport()
        {
            var export = Export("image.png", "shadow9.png", "icon.svg");
            string image, shadow, icon;
            AssetDatabase.StartAssetEditing();
            try
            {
                image = DesignAssetImporter.Import(Asset("image", "image.png"), export, OutRoot, _profile);
                shadow = DesignAssetImporter.Import(Asset("shadow9", "shadow9.png"), export, OutRoot, _profile);
                icon = DesignAssetImporter.Import(Asset("svg", "icon.svg"), export, OutRoot, _profile);
            }
            finally { AssetDatabase.StopAssetEditing(); }
            Assert.AreEqual(1, AssetDatabase.LoadAssetAtPath<Texture2D>(image).mipmapCount);
            Assert.IsFalse(((TextureImporter)AssetImporter.GetAtPath(shadow)).mipmapEnabled);
            Assert.IsTrue(((TextureImporter)AssetImporter.GetAtPath(image)).alphaIsTransparency);
            Assert.IsNotNull(AssetDatabase.LoadAssetAtPath<VectorImage>(icon));
        }

        [Test]
        public void OutputFolderOutsideTheProject_OnlyCopiesAndReturnsAScreenRelativePath()
        {
            var export = Export("image.png");
            var outside = Path.Combine(Path.GetTempPath(), "design-ui-out-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            _temp.Add(outside);
            var count = DesignAssetImporter.ImportCount;
            var path = DesignAssetImporter.Import(Asset("image", "image.png"), export, outside, _profile);
            Assert.AreEqual("../_assets/image.png", path);
            Assert.IsTrue(File.Exists(outside + "/_assets/image.png"));
            Assert.AreEqual(count, DesignAssetImporter.ImportCount);
        }

        [Test]
        public void Compile_ImportsAssetsOnce_AndAnUnchangedScreenPerformsZeroImports()
        {
            var ir = Showcase();
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-assets-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir + "/assets");
            _temp.Add(dir);
            File.WriteAllText(dir + "/" + ScreenCompiler.IrFileName, Newtonsoft.Json.JsonConvert.SerializeObject(ir, Newtonsoft.Json.Formatting.Indented));
            File.Copy(Fixture("shadow9.png"), dir + "/" + ShadowFile);
            File.WriteAllText(dir + "/" + KitTextStyles.FileName, "{ \"label\": { \"fontSize\": 16.515625, \"lineHeight\": 20, \"weight\": 400 } }");

            var first = ScreenCompiler.Compile(dir, _profile);
            Assert.IsTrue(first.Ok, string.Join("\n", first.Errors));
            var shadow = SharedFolder + "/shadow.png";
            Assert.IsNotNull(AssetDatabase.LoadAssetAtPath<Texture2D>(shadow), "the shadow is imported into the shared folder");
            StringAssert.Contains("project://database/" + shadow, File.ReadAllText(OutRoot + "/TestShowcase/TestShowcase.uss"));
            Assert.IsFalse(File.Exists(OutRoot + "/TestShowcase/assets/shadow.png"), "no per-screen copy");

            var count = DesignAssetImporter.ImportCount;
            var hash = AssetDatabase.GetAssetDependencyHash(shadow);
            var second = ScreenCompiler.Compile(dir, _profile);
            Assert.IsTrue(second.Ok, string.Join("\n", second.Errors));
            CollectionAssert.IsEmpty(second.Written);
            Assert.AreEqual(count, DesignAssetImporter.ImportCount, "an unchanged screen imports nothing");
            Assert.AreEqual(hash, AssetDatabase.GetAssetDependencyHash(shadow));
        }

        // ---- on a real panel ---------------------------------------------------------------------------------

        UIDocument Panel(int size)
        {
            _rt = new RenderTexture(size, size, 24);
            _settings = UnityEngine.Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _settings.clearColor = true; // each repaint starts from transparent: earlier sizes must not show through
            _settings.colorClearValue = Color.clear;
            _go = new GameObject("DesignAssetImporterTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            return doc;
        }

        Texture2D Read()
        {
            var previous = RenderTexture.active;
            RenderTexture.active = _rt;
            var tex = new Texture2D(_rt.width, _rt.height, TextureFormat.RGBA32, false, true);
            tex.ReadPixels(new Rect(0, 0, _rt.width, _rt.height), 0, 0);
            tex.Apply();
            RenderTexture.active = previous;
            return tex;
        }

        [UnityTest]
        public IEnumerator TintableSvg_TakesTheBackgroundImageTintColourOnAPanel()
        {
            var export = Export("icon.svg");
            var path = DesignAssetImporter.Import(Asset("svg", "icon.svg"), export, OutRoot, _profile);
            var vector = AssetDatabase.LoadAssetAtPath<VectorImage>(path);
            var doc = Panel(64);
            for (int i = 0; i < 2; i++) yield return null;
            var untinted = new VisualElement();
            var tinted = new VisualElement();
            foreach (var ve in new[] { untinted, tinted })
            {
                ve.style.position = Position.Absolute;
                ve.style.top = 4; ve.style.width = 24; ve.style.height = 24;
                ve.style.backgroundImage = new StyleBackground(vector);
            }
            untinted.style.left = 4;
            tinted.style.left = 36;
            tinted.style.unityBackgroundImageTintColor = new Color(1f, 0f, 0f, 1f);
            doc.rootVisualElement.Add(untinted);
            doc.rootVisualElement.Add(tinted);
            for (int i = 0; i < 6; i++) yield return null;

            var tex = Read();
            var white = tex.GetPixel(16, 64 - 16);
            var red = tex.GetPixel(48, 64 - 16);
            UnityEngine.Object.DestroyImmediate(tex);
            Assert.That(white.r, Is.GreaterThan(0.95f)); Assert.That(white.g, Is.GreaterThan(0.95f)); Assert.That(white.b, Is.GreaterThan(0.95f));
            Assert.That(red.r, Is.GreaterThan(0.95f), "tinted red: " + red);
            Assert.That(red.g, Is.LessThan(0.05f), "tinted red: " + red);
            Assert.That(red.b, Is.LessThan(0.05f), "tinted red: " + red);
        }

        [UnityTest]
        public IEnumerator SlicedShadow_StretchesWithoutSeamsAtThreeSizes()
        {
            var export = Export("shadow9.png");
            var path = DesignAssetImporter.Import(Asset("shadow9", "shadow9.png"), export, OutRoot, _profile);
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            var doc = Panel(128);
            for (int i = 0; i < 2; i++) yield return null;
            foreach (var size in new[] { 24, 53, 100 })
            {
                doc.rootVisualElement.Clear();
                var shadow = new VisualElement();
                shadow.style.position = Position.Absolute;
                shadow.style.left = 0; shadow.style.top = 0; shadow.style.width = size; shadow.style.height = size;
                shadow.style.backgroundImage = new StyleBackground(texture);
                shadow.style.unitySliceLeft = 4; shadow.style.unitySliceTop = 4; shadow.style.unitySliceRight = 4; shadow.style.unitySliceBottom = 4;
                doc.rootVisualElement.Add(shadow);
                for (int i = 0; i < 6; i++) yield return null;

                var tex = Read();
                // alpha of the source: 30 + 40 * min(distance to the edge, 4) -> ring 30,70,110,150, centre 190
                float Alpha(int x, int y) => tex.GetPixel(x, 127 - y).a * 255f;
                var mid = size / 2;
                for (int d = 0; d < 4; d++)
                {
                    var expected = 30 + 40 * d;
                    Assert.AreEqual(expected, Alpha(d, mid), 3f, "left ring, size " + size);
                    Assert.AreEqual(expected, Alpha(size - 1 - d, mid), 3f, "right ring, size " + size);
                    Assert.AreEqual(expected, Alpha(mid, d), 3f, "top ring, size " + size);
                    Assert.AreEqual(expected, Alpha(mid, size - 1 - d), 3f, "bottom ring, size " + size);
                }
                // beyond the ring the centre texel is magnified (size - 8) / 8 times; bilinear filtering spreads the step from
                // the last ring texel to the centre texel over that width. It must be a monotonic ramp (no dip, no overshoot).
                var blend = 4 + Mathf.CeilToInt((size - 8) / 8f) + 1;
                var last = Alpha(3, mid);
                for (int x = 4; x < blend; x++)
                {
                    var a = Alpha(x, mid);
                    Assert.That(a, Is.InRange(last - 1f, 192f), "monotonic ramp at x=" + x + ", size " + size);
                    last = a;
                }
                for (int y = blend; y < size - blend; y++)
                    for (int x = blend; x < size - blend; x++)
                        if (Mathf.Abs(Alpha(x, y) - 190f) > 3f) Assert.Fail("seam at " + x + "," + y + " size " + size + ": alpha " + Alpha(x, y));
                Assert.AreEqual(0f, Alpha(size + 2, mid), 1f, "nothing outside the element, size " + size);
                UnityEngine.Object.DestroyImmediate(tex);
            }
        }
    }
}
