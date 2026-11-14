using System;
using System.IO;
using System.Linq;
using DesignUi.Editor;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.Localization;
using UnityEngine.Localization.Tables;

namespace DesignUi.Localization.Tests
{
    /// <summary>
    /// The import's String Table writer on Unity Localization (spec 13) with a temporary collection: new keys get their
    /// English and Turkish entries, an existing key with the same English is reused untouched, any other value is a
    /// conflict and stays, other locales are reported pending (with whether they fall back to English), and only the
    /// touched tables are saved.
    /// </summary>
    public class StringTableWriterTests
    {
        const string Name = "DuiWriterTest";
        static readonly string CollectionFolder = LocalizationFixture.Folder + "/" + Name;

        LocalizationFixture _fixture;
        StringTableCollection _collection;
        readonly UnityStringTables _tables = new UnityStringTables();

        [SetUp]
        public void Setup()
        {
            _fixture = new LocalizationFixture("en", "tr");
            _fixture.AddLocale("de", fallback: "en");
            _fixture.AddLocale("fr");
            _collection = LocalizationEditorSettings.CreateStringTableCollection(Name, CollectionFolder);
            Entry("en", "known.same", "Club");
            Entry("tr", "known.same", "Kulüp");
            Entry("de", "known.same", "Verein");
            Entry("fr", "known.same", "Club");
            Entry("en", "known.diff", "Old text");
            Entry("tr", "known.diff", "Eski metin");
            Entry("en", "known.no-tr", "Play");
            // a game's existing key in mixed case, translated into every locale
            Entry("en", "calendar.main.pendingOnly", "Pending only");
            Entry("tr", "calendar.main.pendingOnly", "Yalnız bekleyenler");
            Entry("de", "calendar.main.pendingOnly", "Nur offene");
            Entry("fr", "calendar.main.pendingOnly", "En attente");
            foreach (var t in _collection.StringTables) Save(t);
            Save(_collection.SharedData);
        }

        [TearDown]
        public void Cleanup() => _fixture.Dispose();

        StringTable Table(string code) => _collection.StringTables.Single(t => t.LocaleIdentifier.Code == code);

        void Entry(string code, string key, string value) => Table(code).AddEntry(key, value);

        static void Save(UnityEngine.Object asset)
        {
            EditorUtility.SetDirty(asset);
            AssetDatabase.SaveAssetIfDirty(asset);
        }

        static ScreenText Text(string key, string en, string tr, params string[] args)
        {
            var t = new ScreenText { Key = key, En = en, Reference = tr, Args = args };
            t.Places.Add(key.Replace('.', '-'));
            return t;
        }

        static StringTableRequest Request(params ScreenText[] texts) => new StringTableRequest
        {
            Screen = "writer.test", Collection = Name, EnglishLocale = "en", ReferenceLocale = "tr", Format = DesignArgumentFormat.SmartString, Texts = texts,
            NewCollectionFolder = CollectionFolder,
        };

        static string FileText(UnityEngine.Object asset) => File.ReadAllText(AssetDatabase.GetAssetPath(asset));

        [Test]
        public void Write_AddsNewKeys_ReusesTheSameEnglish_AndReportsConflictsWithoutOverwriting()
        {
            var report = _tables.Write(Request(
                Text("new.key", "New", "Yeni"),
                Text("known.same", "Club", "Kulüp"),
                Text("known.diff", "New text", "Yeni metin"),
                Text("known.no-tr", "Play", "Oyna"),
                Text("args.key", "{name} won", "{name} kazandı", "name")));

            CollectionAssert.AreEqual(new[] { "new.key (en, tr)", "known.no-tr (tr)", "args.key (en, tr)" }, report.Added);
            CollectionAssert.AreEqual(new[] { "known.same" }, report.Reused);
            Assert.AreEqual(1, report.Conflicts.Count);
            StringAssert.StartsWith("known.diff: English in the table 'Old text', in the design 'New text'", report.Conflicts[0]);
            Assert.IsFalse(report.CreatedCollection);

            Assert.AreEqual("Yeni", Table("tr").GetEntry("new.key").Value);
            Assert.AreEqual("New", Table("en").GetEntry("new.key").Value);
            Assert.AreEqual("Old text", Table("en").GetEntry("known.diff").Value, "a conflict is never overwritten");
            Assert.AreEqual("Eski metin", Table("tr").GetEntry("known.diff").Value);
            Assert.AreEqual("Oyna", Table("tr").GetEntry("known.no-tr").Value, "a missing Turkish entry of a reused key is added");
            Assert.AreEqual("Play", Table("en").GetEntry("known.no-tr").Value);
            Assert.IsTrue(Table("en").GetEntry("args.key").IsSmart && Table("tr").GetEntry("args.key").IsSmart, "a text with arguments is a Smart String");
            Assert.IsFalse(Table("en").GetEntry("new.key").IsSmart);
            Assert.IsNull(Table("de").GetEntry("new.key"), "other locales get no entry: fallback is not translation");

            // saved, and only what was written
            CollectionAssert.AreEquivalent(new[] { AssetDatabase.GetAssetPath(Table("en")), AssetDatabase.GetAssetPath(Table("tr")), AssetDatabase.GetAssetPath(_collection.SharedData) }, report.Saved);
            foreach (var t in new[] { Table("en"), Table("tr") }) Assert.IsFalse(EditorUtility.IsDirty(t), t.name + " is saved");
            StringAssert.Contains("kazand", FileText(Table("tr")));
            StringAssert.Contains("new.key", FileText(_collection.SharedData));
        }

        [Test]
        public void AnExistingMixedCaseKey_IsReusedOnAnExactMatchOnly_AndKeepsItsTranslations()
        {
            var report = _tables.Write(Request(Text("calendar.main.pendingOnly", "Pending only", "Yalnız bekleyenler")));
            CollectionAssert.AreEqual(new[] { "calendar.main.pendingOnly" }, report.Reused);
            CollectionAssert.IsEmpty(report.Added);
            CollectionAssert.IsEmpty(report.Conflicts);
            CollectionAssert.IsEmpty(report.Saved, "reused untouched");
            Assert.AreEqual("Nur offene", Table("de").GetEntry("calendar.main.pendingOnly").Value, "the other locales keep their translations");
            Assert.AreEqual("En attente", Table("fr").GetEntry("calendar.main.pendingOnly").Value);
            CollectionAssert.IsEmpty(report.Pending, "every locale has it");

            // keys are exact: another spelling is another key, and the report points at the table's spelling
            report = _tables.Write(Request(Text("calendar.main.pendingonly", "Pending only", "Yalnız bekleyenler")));
            CollectionAssert.AreEqual(new[] { "calendar.main.pendingonly (en, tr)" }, report.Added);
            CollectionAssert.Contains(report.Notes, "new key 'calendar.main.pendingonly' differs from the existing key 'calendar.main.pendingOnly' only in letter case; " +
                                                    "keys are exact: spell it as the table does to reuse its translations");
            Assert.AreEqual("Pending only", Table("en").GetEntry("calendar.main.pendingOnly").Value);
            Assert.AreEqual("Nur offene", Table("de").GetEntry("calendar.main.pendingOnly").Value);
        }

        [Test]
        public void Write_ReportsATurkishOrSmartStringDifference_AsAConflict()
        {
            Entry("en", "known.plain", "{name} lost");
            Entry("tr", "known.plain", "{name} kaybetti");
            Save(Table("en"));
            Save(Table("tr"));
            Save(_collection.SharedData);
            var report = _tables.Write(Request(Text("known.same", "Club", "Kulübüm"), Text("known.plain", "{name} lost", "{name} kaybetti", "name")));
            Assert.AreEqual(2, report.Conflicts.Count, string.Join("\n", report.Conflicts));
            StringAssert.StartsWith("known.same: tr in the table 'Kulüp', in the design 'Kulübüm'", report.Conflicts[0]);
            StringAssert.StartsWith("known.plain: the English entry is not a Smart String", report.Conflicts[1]);
            Assert.AreEqual("Kulüp", Table("tr").GetEntry("known.same").Value);
            CollectionAssert.IsEmpty(report.Reused);
            CollectionAssert.IsEmpty(report.Saved, "nothing written, nothing saved");
        }

        [Test]
        public void Write_ReportsPendingLocales_AndWhetherTheyShowEnglishMeanwhile()
        {
            var report = _tables.Write(Request(Text("new.key", "New", "Yeni"), Text("known.same", "Club", "Kulüp")));
            Assert.AreEqual(2, report.Pending.Count);
            var de = report.Pending.Single(p => p.Locale == "de");
            CollectionAssert.AreEqual(new[] { "new.key" }, de.Keys, "known.same has a German translation");
            Assert.IsTrue(de.FallsBackToEnglish);
            var fr = report.Pending.Single(p => p.Locale == "fr");
            CollectionAssert.AreEqual(new[] { "new.key" }, fr.Keys);
            Assert.IsFalse(fr.FallsBackToEnglish, "fr has no fallback locale");
            CollectionAssert.Contains(report.Lines().ToList(), "translation pending: fr (1 key: new.key); its fallback does not reach English: add a Fallback Locale to it");
        }

        [Test]
        public void TablesWithUnsavedChanges_AreRefused_AndOtherTablesAreNeverSaved()
        {
            Table("de").AddEntry("known.diff", "Alter Text"); // an existing key: the shared table data stays as it is
            EditorUtility.SetDirty(Table("de")); // someone's open edit in another locale: not the writer's to save
            _tables.Write(Request(Text("new.key", "New", "Yeni")));
            Assert.IsTrue(EditorUtility.IsDirty(Table("de")), "a table the import did not write keeps its unsaved state");
            StringAssert.DoesNotContain("Alter Text", FileText(Table("de")));

            Table("en").AddEntry("open.edit", "Unsaved");
            EditorUtility.SetDirty(Table("en"));
            var errors = _tables.Check(Request(Text("other.key", "Other", "Diğer")));
            Assert.AreEqual(1, errors.Count, string.Join("\n", errors));
            StringAssert.Contains(Name + "_en.asset' has unsaved changes", errors[0]);
            Assert.Throws<InvalidOperationException>(() => _tables.Write(Request(Text("other.key", "Other", "Diğer"))));
            Assert.IsNull(Table("tr").GetEntry("other.key"), "nothing was written");
        }

        [Test]
        public void ANewCollection_FollowsTheProfilesPreloadAndLabelRules_UnderLocalizationsOwnAddresses()
        {
            var request = Request(Text("fresh.key", "Fresh", "Taze"));
            request.Collection = "DuiFresh";
            request.NewCollectionFolder = LocalizationFixture.Folder + "/Tables/DuiFresh";
            request.PreloadNewTables = true;
            request.NewTableLabels = new[] { "ui-screens" };
            CollectionAssert.IsEmpty(_tables.Check(request));
            var report = _tables.Write(request);

            Assert.IsTrue(report.CreatedCollection);
            var collection = LocalizationEditorSettings.GetStringTableCollection("DuiFresh");
            Assert.IsNotNull(collection);
            StringAssert.StartsWith(request.NewCollectionFolder + "/", AssetDatabase.GetAssetPath(collection));
            CollectionAssert.AreEquivalent(new[] { "de", "en", "fr", "tr" }, collection.StringTables.Select(t => t.LocaleIdentifier.Code), "a table per project locale");
            foreach (var table in collection.StringTables)
            {
                var entry = _fixture.EntryOf(table);
                Assert.IsNotNull(entry, table.name + " is addressable");
                Assert.AreEqual("DuiFresh_" + table.LocaleIdentifier.Code, entry.address, "the address Unity Localization loads it by");
                CollectionAssert.IsSupersetOf(entry.labels, new[] { "Locale-" + table.LocaleIdentifier.Code, "Preload", "ui-screens" });
                Assert.IsFalse(EditorUtility.IsDirty(table), table.name + " is saved");
            }
            Assert.AreEqual("Taze", collection.StringTables.Single(t => t.LocaleIdentifier.Code == "tr").GetEntry("fresh.key").Value);

            // without Addressables settings a new collection is refused: creating them would save the whole project
            var other = Request(Text("x.key", "X", "X"));
            other.Collection = "DuiRefused";
            _fixture.WithoutAddressables(() =>
            {
                var errors = _tables.Check(other);
                Assert.AreEqual(1, errors.Count, string.Join("\n", errors));
                StringAssert.Contains("the project has no Addressables settings", errors[0]);
            });
        }

        [Test]
        public void Strings_GivesEveryLocalesTextsOfTheKeys()
        {
            var strings = _tables.Strings(Name, new[] { "known.same", "known.diff", "missing" });
            CollectionAssert.AreEqual(new[] { "Club", "Old text" }, strings["en"]);
            CollectionAssert.AreEqual(new[] { "Verein" }, strings["de"]);
            CollectionAssert.AreEqual(new[] { "Kulüp", "Eski metin" }, strings["tr"]);
            Assert.AreEqual(4, strings.Count);
        }

        [Test]
        public void IsTheRegisteredWriter_WhenUnityLocalizationIsInstalled() => Assert.IsInstanceOf<UnityStringTables>(DesignStringTables.Current);
    }
}
