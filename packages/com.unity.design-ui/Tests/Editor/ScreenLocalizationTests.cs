using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using static DesignUi.Editor.Tests.TestIr;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The compiler's localization step (spec 13) against a String Table writer stand-in: what the generated UXML binds,
    /// what the writer is asked to write, when the compile stops, and that every locale's translations reach the twins.
    /// The writer itself (Unity Localization) is tested in DesignUi.Localization.Tests.
    /// </summary>
    public class ScreenLocalizationTests
    {
        const string Collection = "LocTest";

        sealed class FakeTables : IDesignStringTables
        {
            public readonly List<string> CheckErrors = new List<string>();
            public readonly Dictionary<string, IReadOnlyList<string>> LocaleStrings = new Dictionary<string, IReadOnlyList<string>>();
            public StringTableRequest Checked, Written;
            public int Writes;

            public IReadOnlyList<string> Check(StringTableRequest request)
            {
                Checked = request;
                return CheckErrors;
            }

            public LocalizationReport Write(StringTableRequest request)
            {
                Written = request;
                Writes++;
                var report = new LocalizationReport { Collection = request.Collection };
                report.Added.AddRange(request.Texts.Select(t => t.Key + " (en, tr)"));
                return report;
            }

            public IReadOnlyDictionary<string, IReadOnlyList<string>> Strings(string collection, IEnumerable<string> keys) => LocaleStrings;
        }

        readonly List<string> _temp = new List<string>();
        IDesignStringTables _current;

        [SetUp]
        public void Remember() => _current = DesignStringTables.Current;

        [TearDown]
        public void Cleanup()
        {
            DesignStringTables.Current = _current;
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            FontFixture.Delete();
        }

        string TempDir()
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-l10n-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            return dir;
        }

        static IrNode Keyed(IrNode n, string key, string en)
        {
            n.Text.Key = key;
            n.Text.En = en;
            return n;
        }

        /// <summary>
        /// A screen with a plain text, a text with two arguments, a bound runtime value with a sample, a button label, an
        /// input with a placeholder and a title, an image with alt text and a list repeat whose rows hold a keyed text.
        /// </summary>
        static IrScreen LocalizedIr()
        {
            var title = Keyed(Text("title", "Kulüp"), "loc.title", "Club");
            var score = Keyed(Text("score", "{team}: {count} maç"), "loc.score", "{team}: {count} matches");
            score.Text.Args = new[] { "team", "count" };
            var player = Text("player", "Ali Veli");
            player.Bind = "player";
            player.Text.Key = null;
            var play = Node("play", "button", ("width", "100px"), ("height", "30px")).Add(Keyed(Text("play-label", "Oyna"), "loc.playNow", "Play"));
            play.Action = "play";
            var query = Node("query", "input", ("width", "200px"), ("height", "30px"));
            query.Initial = new IrInitial();
            query.AttrTexts["placeholder"] = new IrText { Key = "loc.search", Tr = "Ara", En = "Search" };
            query.AttrTexts["title"] = new IrText { Key = "loc.search-hint", Tr = "İsim yaz", En = "Type a name" };
            var crest = Node("crest", "image", ("width", "32px"), ("height", "32px"));
            crest.Asset = new IrAsset { Kind = "image", File = "assets/crest.png", Width = 32, Height = 32 };
            crest.AttrTexts["alt"] = new IrText { Key = "loc.crest", Tr = "Arma", En = "Crest" };
            var rowName = Keyed(Text("row-name", "Oyuncu"), "loc.row", "Player");
            var row = Node("row", "container", ("display", "flex"), ("height", "20px")).Add(rowName);
            var rows = Node("rows", "list", ("display", "flex"), ("flex-direction", "column"), ("overflow-y", "auto"), ("height", "100px")).Add(row);
            rows.Repeat = new IrRepeat { Name = "row", Mode = "list", Count = 2 };
            return Screen(Root(title, score, player, play, query, crest, rows), "loc.screen");
        }

        string Export(IrScreen ir)
        {
            var dir = TempDir();
            Directory.CreateDirectory(Path.Combine(dir, "assets"));
            var tex = new Texture2D(4, 4, TextureFormat.RGBA32, false);
            File.WriteAllBytes(Path.Combine(dir, "assets", "crest.png"), tex.EncodeToPNG());
            Object.DestroyImmediate(tex);
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));
            return dir;
        }

        static DesignUiProfile Profile(string output, bool localize = true, DesignArgumentFormat format = DesignArgumentFormat.SmartString)
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            p.outputFolder = output;
            FontFixture.Use(p);
            p.localization.enabled = localize;
            p.localization.argumentFormat = format;
            p.localization.screenTables = new[] { new DesignScreenTable { screen = "loc.screen", collection = Collection } };
            return p;
        }

        CompileResult Compile(IrScreen ir, DesignUiProfile profile, FakeTables tables, out string output)
        {
            output = TempDir();
            profile.outputFolder = output;
            try { return ScreenCompiler.Compile(Export(ir), profile, false, new CompileHooks { ViewCode = _ => null, Tables = tables }); }
            finally { Object.DestroyImmediate(profile); }
        }

        static string Uxml(string output) => File.ReadAllText(Path.Combine(output, "LocScreen", "LocScreen.uxml"));

        static string Binding(string property, string entry) =>
            "<DesignUi.DesignLocalizedString property=\"" + property + "\" table=\"" + Collection + "\" entry=\"" + entry + "\" />";

        /// <summary>The UXML line of an element, by name.</summary>
        static string Line(string uxml, string name) => uxml.Split('\n').Single(l => l.Contains(" name=\"" + name + "\""));

        // ---- the generated UXML ------------------------------------------------------------------------------------------

        [Test]
        public void LocalizedTexts_BindTheirStringTableEntries_AndTheUxmlHoldsNoCopy()
        {
            var tables = new FakeTables();
            var result = Compile(LocalizedIr(), Profile(null), tables, out var output);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var uxml = Uxml(output);

            StringAssert.Contains("    <ui:Label name=\"title\"", uxml);
            StringAssert.Contains(Binding("text", "loc.title"), uxml);
            StringAssert.Contains(Binding("text", "loc.score"), uxml);
            StringAssert.Contains(Binding("text", "loc.playNow"), uxml, "a mixed-case key is written exactly as the table spells it");
            StringAssert.Contains(Binding("placeholderText", "loc.search"), uxml);
            StringAssert.Contains(Binding("tooltip", "loc.search-hint"), uxml);
            foreach (var copy in new[] { "Kulüp", "maç", "Ali Veli", "Oyna", "Ara", "İsim", "Club", "Search" })
                StringAssert.DoesNotContain(copy, uxml, "no player-visible copy in the screen's UXML");
            Assert.IsFalse(uxml.Contains("placeholder-text=") || uxml.Contains("tooltip="), "attribute texts are bound, not written");
            StringAssert.Contains("enable-rich-text=\"false\"", Line(uxml, "title"), "a translation is plain text unless the design marked it rich");
            // the element keeps one line, its bindings are its first children
            var lines = uxml.Split('\n').ToList();
            var at = lines.FindIndex(l => l.Contains(" name=\"title\""));
            Assert.AreEqual("            <Bindings>", lines[at + 1]);
            Assert.AreEqual("                " + Binding("text", "loc.title"), lines[at + 2]);
            Assert.AreEqual("            </Bindings>", lines[at + 3]);
            Assert.AreEqual("        </ui:Label>", lines[at + 4]);

            var item = File.ReadAllText(Path.Combine(output, "LocScreen", "RowItem.uxml"));
            StringAssert.Contains(Binding("text", "loc.row"), item, "list items bind in their item template");
            StringAssert.DoesNotContain("Oyuncu", item);
            StringAssert.Contains("selection-type=\"None\"", Line(uxml, "rows"), "compiled ListViews leave selection to the view's class layer");
        }

        [Test]
        public void TheWriter_GetsEveryKeyOnce_WithEnglishAndTheReferenceText_AfterTheCheck()
        {
            var tables = new FakeTables();
            var result = Compile(LocalizedIr(), Profile(null), tables, out _);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            Assert.AreSame(tables.Checked, tables.Written, "checked, then written");
            Assert.AreEqual(1, tables.Writes);
            var r = tables.Written;
            Assert.AreEqual(Collection, r.Collection);
            Assert.AreEqual("en", r.EnglishLocale);
            Assert.AreEqual("tr", r.ReferenceLocale);
            Assert.AreEqual("Assets/Localization/" + Collection, r.NewCollectionFolder);
            CollectionAssert.AreEquivalent(new[] { "loc.title", "loc.score", "loc.playNow", "loc.search", "loc.search-hint", "loc.crest", "loc.row" }, r.Texts.Select(t => t.Key));
            var score = r.Texts.Single(t => t.Key == "loc.score");
            Assert.AreEqual("{team}: {count} matches", score.En, "Smart Strings keep the names");
            Assert.AreEqual("{team}: {count} maç", score.Reference);
            CollectionAssert.AreEqual(new[] { "team", "count" }, score.Args);
            Assert.AreEqual("query@placeholder", r.Texts.Single(t => t.Key == "loc.search").Places.Single());
            Assert.AreEqual("Crest", r.Texts.Single(t => t.Key == "loc.crest").En, "alt text is localized copy too (kept in the manifest, not drawn)");
            Assert.IsNotNull(result.Localization, "the report reaches the compile result");
            CollectionAssert.Contains(result.Localization.Lines().ToList(), "localization written: loc.title (en, tr)");
        }

        [Test]
        public void IndexedFormat_WritesPositionalPlaceholders_InTheOrderTheViewSetsThem()
        {
            var tables = new FakeTables();
            var result = Compile(LocalizedIr(), Profile(null, format: DesignArgumentFormat.Indexed), tables, out _);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var score = tables.Written.Texts.Single(t => t.Key == "loc.score");
            Assert.AreEqual("{0}: {1} matches", score.En);
            Assert.AreEqual("{0}: {1} maç", score.Reference);
            Assert.AreEqual("{0} {x} {1}{0}", ScreenLocalization.Format("{a} {x} {b}{a}", new[] { "a", "b" }, DesignArgumentFormat.Indexed), "only the text's own arguments");
        }

        [Test]
        public void LocalizationOff_KeepsTheStaticDesignText()
        {
            var tables = new FakeTables();
            var result = Compile(LocalizedIr(), Profile(null, localize: false), tables, out var output);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var uxml = Uxml(output);
            StringAssert.Contains("text=\"Kulüp\"", Line(uxml, "title"));
            StringAssert.DoesNotContain("<Bindings>", uxml);
            Assert.AreEqual(0, tables.Writes);
            Assert.IsNull(result.Localization);
        }

        // ---- when the compile stops --------------------------------------------------------------------------------------

        [Test]
        public void TheWritersCheck_StopsTheCompile_BeforeAnythingIsWritten()
        {
            var tables = new FakeTables();
            tables.CheckErrors.Add("'Assets/Loc/LocTest_en.asset' has unsaved changes");
            var result = Compile(LocalizedIr(), Profile(null), tables, out var output);
            Assert.IsFalse(result.Ok);
            CollectionAssert.AreEqual(tables.CheckErrors, result.Errors);
            Assert.AreEqual(0, tables.Writes);
            Assert.IsFalse(Directory.Exists(Path.Combine(output, "LocScreen")), "no generated file");
        }

        [Test]
        public void TextsWithoutKeys_ClashingKeys_AndScreensWithoutACollection_FailTheCompile()
        {
            var noKey = LocalizedIr();
            noKey.Root.Children[0].Text.Key = null;
            var r = Compile(noKey, Profile(null), new FakeTables(), out _);
            Assert.IsFalse(r.Ok);
            StringAssert.Contains("'title' shows text without a localization key", r.Errors.Single());

            var clash = LocalizedIr();
            clash.Root.Children[1].Text.Key = "loc.title";
            r = Compile(clash, Profile(null), new FakeTables(), out _);
            Assert.IsFalse(r.Ok);
            StringAssert.Contains("localization key 'loc.title' has two different texts", r.Errors.Single());

            var profile = Profile(null);
            profile.localization.screenTables = new DesignScreenTable[0];
            r = Compile(LocalizedIr(), profile, new FakeTables(), out _);
            Assert.IsFalse(r.Ok);
            StringAssert.Contains("names no String Table collection for screen 'loc.screen'", r.Errors.Single());

            profile = Profile(null);
            profile.localization.screenTables = new DesignScreenTable[0];
            profile.localization.defaultCollection = "Screens{Screen}";
            var tables = new FakeTables();
            r = Compile(LocalizedIr(), profile, tables, out _);
            Assert.IsTrue(r.Ok, string.Join("\n", r.Errors));
            Assert.AreEqual("ScreensLocScreen", tables.Written.Collection, "the default collection pattern");
        }

        [Test]
        public void WithoutUnityLocalization_ALocalizingProfileFails()
        {
            DesignStringTables.Current = null;
            var output = TempDir();
            var profile = Profile(output);
            try
            {
                var r = ScreenCompiler.Compile(Export(LocalizedIr()), profile, false, NoView());
                Assert.IsFalse(r.Ok);
                StringAssert.Contains("Unity Localization (com.unity.localization 1.5 or newer) is not installed", r.Errors.Single());
            }
            finally { Object.DestroyImmediate(profile); }
        }

        [Test]
        public void NestedActions_FailTheCompile()
        {
            var ir = LocalizedIr();
            var play = ir.Root.Children.Single(n => n.Id == "play");
            play.Children[0].Action = "play-label";
            var r = Compile(ir, Profile(null), new FakeTables(), out _);
            Assert.IsFalse(r.Ok);
            StringAssert.Contains("'play-label' (data-u-action 'play-label') is inside 'play' (data-u-action 'play'); move the action to one element", r.Errors.Single());
        }

        // ---- every locale's translations reach the twins -----------------------------------------------------------------

        [Test]
        public void EveryLocalesTranslations_ReachTheTwinsThatLocaleRendersWith()
        {
            var tables = new FakeTables();
            // a German and a French table: neither has its own font, both render with the reference locale's twins
            tables.LocaleStrings["de"] = new[] { "Größe", "Spieler" };
            tables.LocaleStrings["fr"] = new[] { "Équipe" };
            var result = Compile(LocalizedIr(), Profile(null), tables, out _);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var twin = AssetDatabase.LoadAssetAtPath<FontAsset>(FontFixture.TwinFolder + "/Inter Fixture UITK.asset");
            foreach (var c in "ößÉq")
                Assert.IsTrue(twin.characterLookupTable.ContainsKey(c), "a translation's character '" + c + "' is in the twin before any text needs it");
            Assert.IsFalse(result.Notes.Any(n => n.Contains("translations")), string.Join("\n", result.Notes));

            // a script the locale's fonts lack is reported per locale, never silently
            tables = new FakeTables();
            tables.LocaleStrings["ja"] = new[] { "選手" };
            result = Compile(LocalizedIr(), Profile(null), tables, out _);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            CollectionAssert.Contains(result.Notes, "no font of locale 'ja' has these characters of its translations: 選手");
        }

        [Test]
        public void Report_Lines_NameConflictsAndPendingLocales()
        {
            var report = new LocalizationReport { Collection = "C" };
            report.Reused.Add("a");
            report.Conflicts.Add("b: English in the table 'B', in the design 'Bee' (b)");
            report.Pending.Add(new PendingTranslation { Locale = "de", FallsBackToEnglish = true });
            report.Pending[0].Keys.AddRange(new[] { "a", "b" });
            report.Pending.Add(new PendingTranslation { Locale = "ja" });
            report.Pending[1].Keys.Add("a");
            CollectionAssert.AreEqual(new[]
            {
                "localization: collection 'C': 0 written, 1 reused, 1 conflicts",
                "localization conflict (not overwritten): b: English in the table 'B', in the design 'Bee' (b)",
                "translation pending: de (2 keys: a, b); shows English meanwhile",
                "translation pending: ja (1 key: a); its fallback does not reach English: add a Fallback Locale to it",
            }, report.Lines().ToList());
        }
    }
}
