using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using NUnit.Framework;
using TMPro;
using UnityEditor;
using UnityEngine;
using static DesignUi.Editor.Tests.TestIr;
using Debug = UnityEngine.Debug;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// A font family with many faces (9 weights, upright and italic: 18 TMP font assets in the primary's weight table): kit
    /// sync and import make UI Toolkit twins, and add the screen's glyphs, only for the faces the kit's text styles and the
    /// design use (400 and 700 here), not for every face of the family. The test logs both durations ("twin faces:"), the
    /// measurement of the import-speed fix.
    /// </summary>
    public class TwinFacesTests
    {
        const string Folder = FontFixture.Folder + "/ManyFaces";
        const string Twins = Folder + "/Twins";
        const string Out = "Assets/DesignUiTwinFacesOut";
        const string KitConfig = "{\"fontsCss\":\"fonts/fonts.css\",\"tokensCss\":\"tokens.css\",\"textStyles\":\"text-styles.json\",\"reference\":[2560,1440]," +
                                 "\"viewports\":[[2560,1440],[1920,1080],[1280,720]],\"screenMatch\":0.5,\"filterFunctions\":[],\"locales\":[\"tr\"]}\n";

        readonly List<string> _temp = new List<string>();
        readonly List<UnityEngine.Object> _objects = new List<UnityEngine.Object>();

        [TearDown]
        public void Cleanup()
        {
            foreach (var o in _objects) if (o != null && !EditorUtility.IsPersistent(o)) UnityEngine.Object.DestroyImmediate(o);
            _objects.Clear();
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
            FontFixture.Delete();
        }

        string TempDir(string prefix)
        {
            var dir = Path.Combine(Path.GetTempPath(), prefix + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            return dir;
        }

        static string KitStyles() => File.ReadAllText(Path.GetFullPath(Path.Combine(IrReaderTests.PackagePath(), "..", "..", "design-kit", KitTextStyles.FileName)));

        /// <summary>"Many 400" with a weight table of every weight 100…900, upright and italic (copies of the Inter fixture TTFs).</summary>
        static TMP_FontAsset ManyFaceFamily()
        {
            TMP_FontAsset primary = null;
            var table = new TMP_FontWeightPair[10];
            for (int w = 100; w <= 900; w += 100)
            {
                var ttf = w >= 600 ? FontFixture.BoldTtf : FontFixture.RegularTtf;
                var upright = FontFixture.CreateTmp(ttf, "Many " + w, family: "Many", folder: Folder);
                var italic = FontFixture.CreateTmp(ttf, "Many " + w + " Italic", family: "Many", folder: Folder);
                if (w == 400) primary = upright;
                table[w / 100] = new TMP_FontWeightPair { regularTypeface = w == 400 ? null : upright, italicTypeface = italic };
            }
            for (int i = 1; i <= 9; i++) primary.fontWeightTable[i] = table[i];
            FontFixture.Save(primary);
            return primary;
        }

        DesignUiProfile Profile(TMP_FontAsset primary, string kit)
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            _objects.Add(p);
            p.referenceLocale = "tr";
            p.locales = new[] { "tr" };
            p.localeFonts = new[] { new LocaleFont { locale = "tr", font = primary } };
            p.fontTwinFolder = Twins;
            p.outputFolder = Out;
            p.kitDir = kit;
            p.referenceResolution = new Vector2Int(2560, 1440);
            p.viewports = new[] { new Vector2Int(2560, 1440), new Vector2Int(1920, 1080), new Vector2Int(1280, 720) };
            p.screenMatch = 0.5f;
            return p;
        }

        static string[] TwinFiles() =>
            Directory.Exists(Twins) ? Directory.GetFiles(Twins, "*.asset").Select(Path.GetFileNameWithoutExtension).OrderBy(n => n, StringComparer.Ordinal).ToArray() : new string[0];

        [Test]
        public void KitSyncAndImport_OfAManyFaceFamily_MakeTwinsOnlyForTheFacesTheTextStylesAndTheDesignUse()
        {
            FontFixture.RequireInter();
            var primary = ManyFaceFamily();
            var kit = TempDir("design-ui-kit-");
            File.WriteAllText(kit + "/kit.config.json", KitConfig);
            File.WriteAllText(kit + "/" + KitTextStyles.FileName, KitStyles());
            var profile = Profile(primary, kit);
            var boxes = KitTextStyles.LineBoxesOf(kit + "/" + KitTextStyles.FileName).Count;

            var watch = Stopwatch.StartNew();
            var sync = KitSync.Run(profile, kit, new ProfileLocaleFontResolver(profile, null));
            var syncMs = watch.ElapsedMilliseconds;
            Assert.IsTrue(sync.Ok, string.Join("\n", sync.Errors));
            var afterSync = TwinFiles();

            // a screen whose texts use both text-style weights (the kit's styles are 400 and 700)
            var words = string.Join(" ", Enumerable.Range(0, 60).Select(i => "Örnek" + i + " çğıöşü ÇĞİÖŞÜ WAVE " + (char)('A' + i % 26)));
            var body = Text("body", words, ("font-family", "Many"), ("font-size", "24px"), ("font-weight", "400"), ("width", "800px"));
            body.Text.Style = "body";
            var title = Text("title", "Başlık " + words.ToUpperInvariant(), ("font-family", "Many"), ("font-size", "24px"), ("font-weight", "700"), ("width", "800px"));
            title.Text.Style = "body-bold";
            var ir = Screen(Root(title, body), "twin.faces");
            var export = TempDir("design-ui-export-");
            File.WriteAllText(Path.Combine(export, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));
            File.WriteAllText(Path.Combine(export, KitTextStyles.FileName), KitStyles());
            watch.Restart();
            var compiled = ScreenCompiler.Compile(export, profile, false, NoView());
            var importMs = watch.ElapsedMilliseconds;
            Assert.IsTrue(compiled.Ok, string.Join("\n", compiled.Errors));
            var afterImport = TwinFiles();

            var message = "twin faces: kit sync " + syncMs + " ms (" + afterSync.Length + " twins), import " + importMs + " ms (" + afterImport.Length +
                          " twins), 18 faces in the family, " + boxes + " line boxes";
            Debug.Log(message);
            TestContext.WriteLine(message);

            // 400 and 700 upright: the primary and its 700 face, each plain and per line box
            var expected = new[] { "Many 400", "Many 700" }.SelectMany(f => new[] { f + " UITK" }.Concat(KitTextStyles.LineBoxesOf(kit + "/" + KitTextStyles.FileName)
                .Select(b => f + " UITK " + b.Key))).OrderBy(n => n, StringComparer.Ordinal).ToArray();
            CollectionAssert.AreEqual(expected, afterSync, "kit sync twins only the faces the kit's text styles use");
            CollectionAssert.AreEqual(expected, afterImport, "the import adds no face the design does not use");
            CollectionAssert.AreEqual(new[] { "Many 400 (Many 400)", "Many 700 (Many 700)" }, sync.Faces.ToArray(), "kit sync reports the faces that got twins");
            Assert.AreEqual(16, sync.SkippedFaces, "and how many of the family's faces did not");
            var status = TextStatus.Check(profile, kit);
            Assert.AreEqual("Many 400 (Many 400), Many 700 (Many 700) (16 more faces in the weight tables get no twin: no text style uses them)", status.Faces,
                "the status window's Text section names the chosen faces");
            Assert.IsTrue(status.TwinsCurrent, status.Twins);
            var twin = AssetDatabase.LoadAssetAtPath<FontAsset>(Twins + "/Many 400 UITK.asset");
            var weights = twin.fontWeightTable;
            Assert.IsNotNull(weights[7].regularTypeface, "the 700 face is in the twin's weight table");
            for (int i = 1; i < weights.Length; i++)
            {
                if (i == 7) continue;
                Assert.IsNull(weights[i].regularTypeface, "no twin of an unused face: weight " + i * 100);
                Assert.IsNull(weights[i].italicTypeface, "no twin of an unused italic face: weight " + i * 100);
            }
        }

        [Test]
        public void Import_OfADesignThatUsesItalic_AddsTheItalicFaces()
        {
            FontFixture.RequireInter();
            var primary = ManyFaceFamily();
            var kit = TempDir("design-ui-kit-");
            File.WriteAllText(kit + "/kit.config.json", KitConfig);
            File.WriteAllText(kit + "/" + KitTextStyles.FileName, KitStyles());
            var profile = Profile(primary, kit);
            Assert.IsTrue(KitSync.Run(profile, kit, new ProfileLocaleFontResolver(profile, null)).Ok);
            Assert.IsFalse(File.Exists(Twins + "/Many 400 Italic UITK.asset"));

            var quote = Text("quote", "Alıntı", ("font-family", "Many"), ("font-size", "24px"), ("font-style", "italic"), ("width", "800px"));
            quote.Text.Style = "body";
            var export = TempDir("design-ui-export-");
            File.WriteAllText(Path.Combine(export, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(Screen(Root(quote), "twin.italic"), Formatting.Indented));
            File.WriteAllText(Path.Combine(export, KitTextStyles.FileName), KitStyles());
            var compiled = ScreenCompiler.Compile(export, profile, false, NoView());
            Assert.IsTrue(compiled.Ok, string.Join("\n", compiled.Errors));
            Assert.IsTrue(File.Exists(Twins + "/Many 400 Italic UITK.asset"), "the design's italic text gets its face");
            Assert.IsFalse(File.Exists(Twins + "/Many 300 UITK.asset"));
            Assert.IsFalse(File.Exists(Twins + "/Many 700 Italic UITK.asset"), "bold italic is not used");
        }
    }
}
