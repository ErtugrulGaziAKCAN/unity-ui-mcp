using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// Font twins with Project Settings > UI Toolkit > Enable Advanced Text on, set up as games set up their TMP fonts: the
    /// regular face lists itself at 400 and its bold face at 700, the bold face lists both and falls back to the regular one,
    /// and a script font falls back to the Latin regular face. The twins are line-box variants with the characters an import
    /// pre-adds, saved, unloaded and loaded again, as a later Editor session or a player after a scene change meets them.
    /// </summary>
    public class AdvancedTextTwinsTests
    {
        const string ArabicFontPath = "/System/Library/Fonts/SFArabic.ttf";

        /// <summary>
        /// The fonts render multi-material text, so they stay until the test session ends (<see cref="FontFixture.KeptFolder"/>);
        /// each run of the test has its own folder.
        /// </summary>
        readonly string Folder = FontFixture.KeptFolder + "/AdvancedTwins" + Guid.NewGuid().ToString("N").Substring(0, 8);
        string TwinFolder => Folder + "/Twins";

        readonly List<Object> _objects = new List<Object>();
        readonly List<string> _logs = new List<string>();
        LocaleFontController _controller;
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;
        IDisposable _advancedText;

        void OnLog(string message, string stack, LogType type)
        {
            if (type != LogType.Log) _logs.Add(type + ": " + message);
        }

        [SetUp]
        public void Listen() => Application.logMessageReceived += OnLog;

        [TearDown]
        public void Cleanup()
        {
            Application.logMessageReceived -= OnLog;
            try
            {
                _controller?.Dispose();
                _controller = null;
                if (_go != null) Object.DestroyImmediate(_go);
                if (_settings != null) Object.DestroyImmediate(_settings);
                if (_rt != null) Object.DestroyImmediate(_rt);
                foreach (var o in _objects) if (o != null) Object.DestroyImmediate(o);
                _objects.Clear();
            }
            finally
            {
                _advancedText?.Dispose(); // after the panel's text is gone
                _advancedText = null;
            }
        }

        static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var slash = folder.LastIndexOf('/');
            EnsureFolder(folder.Substring(0, slash));
            AssetDatabase.CreateFolder(folder.Substring(0, slash), folder.Substring(slash + 1));
        }

        /// <summary>The game-like TMP set: a Latin regular and bold face with self-listing weight tables, a script font falling back to the Latin regular face.</summary>
        (TMP_FontAsset latin, TMP_FontAsset arabic) GameLikeFonts()
        {
            FontFixture.RequireInter();
            if (!File.Exists(ArabicFontPath)) Assert.Ignore("no Arabic system font at " + ArabicFontPath + " (macOS)");
            EnsureFolder(Folder);
            File.Copy(ArabicFontPath, Folder + "/SFArabic.ttf", true);
            AssetDatabase.ImportAsset(Folder + "/SFArabic.ttf", ImportAssetOptions.ForceSynchronousImport);
            var latin = FontFixture.CreateTmp(FontFixture.RegularTtf, "Game Latin", folder: Folder);
            var bold = FontFixture.CreateTmp(FontFixture.BoldTtf, "Game Latin Bold", folder: Folder);
            var arabic = FontFixture.CreateTmp(Folder + "/SFArabic.ttf", "Game Arabic", folder: Folder);
            FontFixture.SetWeight(latin, 400, latin);
            FontFixture.SetWeight(latin, 700, bold);
            FontFixture.SetWeight(bold, 400, latin);
            FontFixture.SetWeight(bold, 700, bold);
            FontFixture.SetFallbacks(bold, latin);
            FontFixture.SetFallbacks(arabic, latin);
            return (latin, arabic);
        }

        VisualElement Root()
        {
            _rt = new RenderTexture(1280, 1024, 24);
            _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _settings.clearColor = true;
            _settings.colorClearValue = Color.black;
            _go = new GameObject("AdvancedTextTwinsTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            var root = new VisualElement { name = "screen-root" };
            root.style.width = 1280;
            root.style.height = 1024;
            doc.rootVisualElement.Add(root);
            return root;
        }

        /// <summary>Ink per column of the lit pixels in rows [y0, y1), cropped to the ink and resampled to 64 bins (sum 1).</summary>
        static float[] InkProfile(Color32[] px, int width, int height, int y0, int y1)
        {
            var cols = new float[width];
            for (int y = y0; y < y1; y++)
                for (int x = 0; x < width; x++) cols[x] += px[(height - 1 - y) * width + x].r / 255f;
            int a = Array.FindIndex(cols, v => v > 0.5f), b = Array.FindLastIndex(cols, v => v > 0.5f);
            Assert.GreaterOrEqual(a, 0, "ink in rows " + y0 + "–" + y1);
            var bins = new float[64];
            for (int x = a; x <= b; x++) bins[Math.Min(63, (x - a) * 64 / (b - a + 1))] += cols[x];
            var sum = bins.Sum();
            for (int i = 0; i < bins.Length; i++) bins[i] /= sum;
            return bins;
        }

        static float Distance(float[] p, float[] q) => p.Zip(q, (x, y) => Math.Abs(x - y)).Sum();

        const int Row = 72;

        /// <summary>
        /// Twins render with the advanced generator: an Arabic screen through the locale controller shapes its text, keeps
        /// "2026" and "12:15" in order inside right-to-left paragraphs and draws the Latin letters its Latin fallback gives;
        /// the Latin twin draws its text too, bold included. No fallback cycle is reported. Before, the reloaded twins drew
        /// nothing (TextCore could not find them by instance ID) and the weight tables' cycles cost the script twin its Latin
        /// fallback.
        /// </summary>
        [UnityTest]
        public IEnumerator ProjectSettingOn_ReloadedTwins_RenderShapedArabicAndLatin_WithTheAdvancedGenerator()
        {
            if (!ProjectAdvancedText.Available) Assert.Ignore("this Unity version has no Enable Advanced Text project setting");
            var (latinTmp, arabicTmp) = GameLikeFonts();
            var box = FontTwinGenerator.LineBox.For(36, 48);
            var run = new FontTwinGenerator.TwinRun(new TMP_FontAsset[0]);
            foreach (var tmp in new[] { latinTmp, arabicTmp })
            {
                FontTwinGenerator.GetOrCreateTwin(tmp, TwinFolder, run);
                FontTwinGenerator.GetOrCreateTwin(tmp, TwinFolder, run, box);
            }
            const string ArabicLine = "سلام 2026 12:15", LatinLine = "Takvim 2026 12:15", Mixed = "Takvim سلام 2026";
            foreach (var t in run.Twins.Where(kv => kv.Key.Item1 == latinTmp || kv.Key.Item1 == arabicTmp).Select(kv => kv.Value))
                DesignText.Prepare(t, ArabicLine + LatinLine + Mixed); // as the import pre-adds a screen's strings
            var paths = run.Twins.Values.Distinct().Select(AssetDatabase.GetAssetPath).ToList();
            foreach (var t in run.Twins.Values.Distinct())
            {
                FontTwinGenerator.StoreSubAssets(t);
                EditorUtility.SetDirty(t);
                AssetDatabase.SaveAssetIfDirty(t);
            }
            yield return null; // the Editor's own repair after the import has run: what follows is up to the locale controller
            // unloaded and loaded again from disk, under the same instance IDs
            foreach (var t in run.Twins.Values.Distinct().ToList()) Resources.UnloadAsset(t);
            run = null;
            GC.Collect();
            GC.WaitForPendingFinalizers();
            FontAsset Load(TMP_FontAsset tmp, FontTwinGenerator.LineBox b = null) => AssetDatabase.LoadAssetAtPath<FontAsset>(FontTwinGenerator.TwinPath(tmp, TwinFolder, b));
            FontAsset latin = Load(latinTmp), latinBox = Load(latinTmp, box), arabic = Load(arabicTmp), arabicBox = Load(arabicTmp, box);
            Assert.IsTrue(paths.All(p => AssetDatabase.LoadAssetAtPath<FontAsset>(p) != null));

            _advancedText = new ProjectAdvancedText(true); // before the panel exists
            var root = Root();
            yield return null;
            var set = ScriptableObject.CreateInstance<DesignFontSet>();
            _objects.Add(set);
            set.referenceLocale = "tr";
            set.locales = new[]
            {
                new DesignFontSet.LocaleFonts { locale = "tr", fonts = new[] { latin, latinBox } },
                new DesignFontSet.LocaleFonts { locale = "ar", fonts = new[] { arabic, arabicBox } },
            };
            _controller = new LocaleFontController(root, set, new DesignLocaleRules(), new LocaleFontControllerTests.Locales("ar"));
            Assert.IsTrue(_controller.UsesAdvancedText, string.Join(" | ", _controller.Issues));

            var glyphs = new Dictionary<string, int>();
            Label Line(string key, string text, int row, FontAsset font, bool reference = false, bool bold = false)
            {
                var l = new Label(text);
                l.style.position = Position.Absolute;
                l.style.left = 20;
                l.style.top = Row * row;
                l.style.fontSize = 36;
                l.style.color = Color.white;
                l.style.unityFontDefinition = FontDefinition.FromSDFFont(font); // a compiled screen's line-box variable
                if (reference)
                {
                    l.style.unityTextGenerator = TextGeneratorType.Standard;
                    l.languageDirection = LanguageDirection.LTR;
                }
                if (bold) l.style.unityFontStyleAndWeight = FontStyle.Bold;
                l.PostProcessTextVertices = g => glyphs[key] = g.Count;
                root.Add(l);
                return l;
            }
            Line("arabic", ArabicLine, 0, arabicBox);
            Line("salam", "سلام", 1, arabicBox);
            Line("digits", "2026", 2, arabicBox);
            Line("time", "12:15", 3, arabicBox);
            Line("mixed", Mixed, 4, arabicBox);
            var latinLine = Line("latin", LatinLine, 5, latinBox);
            latinLine.style.unityTextGenerator = TextGeneratorType.Advanced;
            latinLine.languageDirection = LanguageDirection.LTR;
            var boldLine = Line("bold", "Takvim", 6, latinBox, bold: true);
            boldLine.style.unityTextGenerator = TextGeneratorType.Advanced;
            boldLine.languageDirection = LanguageDirection.LTR;
            Line("ref-digits", "2026", 7, arabicBox, reference: true);
            Line("ref-digits-reversed", "6202", 8, arabicBox, reference: true);
            Line("ref-time", "12:15", 9, arabicBox, reference: true);
            Line("ref-time-reversed", "51:21", 10, arabicBox, reference: true);
            for (int i = 0; i < 20; i++)
            {
                root.Query<Label>().ForEach(l => l.MarkDirtyRepaint());
                yield return null;
            }
            var report = string.Join(", ", glyphs.OrderBy(k => k.Key).Select(k => k.Key + "=" + k.Value)) + " | logs: " + string.Join(" | ", _logs.Distinct().Take(8));

            Assert.AreEqual(TextGeneratorType.Advanced, root.Q<Label>().resolvedStyle.unityTextGenerator);
            Assert.IsFalse(_logs.Any(l => l.Contains("Circular reference")), "no fallback cycle among the twins: " + report);
            Assert.AreEqual(3, glyphs.TryGetValue("salam", out var n) ? n : -1, "the advanced generator shapes lam + alef into one glyph: " + report);
            Assert.AreEqual(ArabicLine.Length - 1, glyphs.TryGetValue("arabic", out n) ? n : -1, "the Arabic line is drawn, shaped: " + report);
            Assert.AreEqual(Mixed.Length - 1, glyphs.TryGetValue("mixed", out n) ? n : -1, "the Latin letters of an Arabic line come from the Latin fallback: " + report);
            Assert.AreEqual(LatinLine.Length, glyphs.TryGetValue("latin", out n) ? n : -1, "the Latin twin draws its text: " + report);
            Assert.AreEqual(6, glyphs.TryGetValue("bold", out n) ? n : -1, "bold Latin text is drawn: " + report);

            var tex = new Texture2D(_rt.width, _rt.height, TextureFormat.RGBA32, false, true);
            _objects.Add(tex);
            var active = RenderTexture.active;
            RenderTexture.active = _rt;
            tex.ReadPixels(new Rect(0, 0, _rt.width, _rt.height), 0, 0, false);
            tex.Apply(false);
            RenderTexture.active = active;
            var px = tex.GetPixels32();
            float[] Ink(int row) => InkProfile(px, _rt.width, _rt.height, row * Row, row * Row + Row - 4);
            foreach (var row in new[] { 0, 4, 5, 6 }) Ink(row); // every line has ink
            float toOrder = Distance(Ink(2), Ink(7)), toReversed = Distance(Ink(2), Ink(8));
            Assert.Less(toOrder, toReversed / 2, "2026 reads 2026 in a right-to-left paragraph (ink distance to 2026: " + toOrder + ", to 6202: " + toReversed + ")");
            toOrder = Distance(Ink(3), Ink(9));
            toReversed = Distance(Ink(3), Ink(10));
            Assert.Less(toOrder, toReversed / 2, "12:15 reads 12:15 in a right-to-left paragraph (ink distance to 12:15: " + toOrder + ", to 51:21: " + toReversed + ")");
        }
    }
}
