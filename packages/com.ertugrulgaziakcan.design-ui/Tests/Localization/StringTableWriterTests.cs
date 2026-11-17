using System;
using System.IO;
using System.Linq;
using DesignUi.Editor;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.Localization;
using UnityEditor.SceneManagement;
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

        /// <summary>Outside the fixture's folder: an asset with someone's unsaved edit must survive whatever the test runs.</summary>
        const string SentinelFolder = "Assets/DesignUiLocalizationSentinel";

        LocalizationFixture _fixture;
        StringTableCollection _collection;
        DesignFontSet _sentinel;
        readonly UnityStringTables _tables = new UnityStringTables();

        [SetUp]
        public void Setup()
        {
            try
            {
                // an empty untitled scene first (earlier tests leave the test scene modified; a scene change also destroys
                // in-memory objects nothing references, so it must come before the fixture's)
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                LocalizationFixture.SaveFontFixtureLeftovers();
                _sentinel = Sentinel();
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
                // an existing key in mixed case, translated into every locale
                Entry("en", "inbox.main.unreadOnly", "Unread only");
                Entry("tr", "inbox.main.unreadOnly", "Yalnız okunmamışlar");
                Entry("de", "inbox.main.unreadOnly", "Nur ungelesene");
                Entry("fr", "inbox.main.unreadOnly", "Non lus");
                foreach (var t in _collection.StringTables) Save(t);
                Save(_collection.SharedData);
                Assert.IsTrue(EditorUtility.IsDirty(_sentinel), "the fixture and the collection were set up without a project-wide save");
                _sentinel.referenceLocale = "saved"; // the file's value: a test sets its own unsaved edit
                AssetDatabase.SaveAssetIfDirty(_sentinel);
            }
            catch
            {
                Cleanup();
                throw;
            }
        }

        [TearDown]
        public void Cleanup()
        {
            try { _fixture?.Dispose(); }
            finally
            {
                _fixture = null;
                if (AssetDatabase.IsValidFolder(SentinelFolder)) AssetDatabase.DeleteAsset(SentinelFolder);
            }
        }

        /// <summary>A saved asset with an unsaved edit (someone's open work).</summary>
        static DesignFontSet Sentinel()
        {
            if (!AssetDatabase.IsValidFolder(SentinelFolder)) AssetDatabase.CreateFolder("Assets", SentinelFolder.Substring("Assets/".Length));
            var asset = UnityEngine.ScriptableObject.CreateInstance<DesignFontSet>();
            asset.referenceLocale = "saved";
            AssetDatabase.CreateAsset(asset, SentinelFolder + "/Sentinel-" + System.Guid.NewGuid().ToString("N") + ".asset"); // a fresh path: no pending import of an earlier test's file
            asset.referenceLocale = "unsaved-edit";
            EditorUtility.SetDirty(asset);
            return asset;
        }

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

        static StringTableRequest Request(params ScreenText[] texts) => Request(DesignArgumentFormat.SmartString, texts);

        static StringTableRequest Request(DesignArgumentFormat format, params ScreenText[] texts) => new StringTableRequest
        {
            Screen = "writer.test", Collection = Name, EnglishLocale = "en", ReferenceLocale = "tr", Format = format, Texts = texts,
            NewCollectionFolder = CollectionFolder,
        };

        /// <summary>A request for a collection that does not exist yet.</summary>
        static StringTableRequest NewCollection(string name, params ScreenText[] texts)
        {
            var r = Request(texts);
            r.Collection = name;
            r.NewCollectionFolder = LocalizationFixture.Folder + "/Tables/" + name;
            return r;
        }

        /// <summary>No unsaved work in the project (the setup opened an empty scene and saved what it wrote).</summary>
        static void CleanProject() => CollectionAssert.IsEmpty(UnityStringTables.UnsavedWork(), "the test starts without unsaved work");

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
            Assert.AreEqual(2, report.Conflicts.Count, "every difference of the key: English and Turkish");
            StringAssert.StartsWith("known.diff: English in the table 'Old text', in the design 'New text'", report.Conflicts[0]);
            StringAssert.StartsWith("known.diff: tr in the table 'Eski metin', in the design 'Yeni metin'", report.Conflicts[1]);
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
            var report = _tables.Write(Request(Text("inbox.main.unreadOnly", "Unread only", "Yalnız okunmamışlar")));
            CollectionAssert.AreEqual(new[] { "inbox.main.unreadOnly" }, report.Reused);
            CollectionAssert.IsEmpty(report.Added);
            CollectionAssert.IsEmpty(report.Conflicts);
            CollectionAssert.IsEmpty(report.Saved, "reused untouched");
            Assert.AreEqual("Nur ungelesene", Table("de").GetEntry("inbox.main.unreadOnly").Value, "the other locales keep their translations");
            Assert.AreEqual("Non lus", Table("fr").GetEntry("inbox.main.unreadOnly").Value);
            CollectionAssert.IsEmpty(report.Pending, "every locale has it");

            // keys are exact: another spelling is another key, and the report points at the table's spelling
            report = _tables.Write(Request(Text("inbox.main.unreadonly", "Unread only", "Yalnız okunmamışlar")));
            CollectionAssert.AreEqual(new[] { "inbox.main.unreadonly (en, tr)" }, report.Added);
            CollectionAssert.Contains(report.Notes, "new key 'inbox.main.unreadonly' differs from the existing key 'inbox.main.unreadOnly' only in letter case; " +
                                                    "keys are exact: spell it as the table does to reuse its translations");
            Assert.AreEqual("Unread only", Table("en").GetEntry("inbox.main.unreadOnly").Value);
            Assert.AreEqual("Nur ungelesene", Table("de").GetEntry("inbox.main.unreadOnly").Value);
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
            Assert.AreEqual(2, report.Pending.Count, string.Join(", ", report.Pending.Select(p => p.Locale)));
            var de = report.Pending.Single(p => p.Locale == "de");
            CollectionAssert.AreEqual(new[] { "new.key" }, de.Keys, "known.same has a German translation");
            Assert.IsTrue(de.FallsBackToEnglish);
            var fr = report.Pending.Single(p => p.Locale == "fr");
            CollectionAssert.AreEqual(new[] { "new.key" }, fr.Keys);
            Assert.IsFalse(fr.FallsBackToEnglish, "fr has no fallback locale");
            Assert.IsFalse(de.NoTable || fr.NoTable);

            CollectionAssert.Contains(report.Lines().ToList(), "translation pending: fr (1 key: new.key); its fallback does not reach English: add a Fallback Locale to it");
            // a locale the collection has no table for: translators need the table first
            _fixture.AddLocale("it", fallback: "en");
            report = _tables.Write(Request(Text("known.same", "Club", "Kulüp")));
            var it = report.Pending.Single(p => p.Locale == "it");
            Assert.IsTrue(it.NoTable);
            CollectionAssert.Contains(report.Lines().ToList(), "translation pending: it (no table in collection '" + Name + "'; 1 key: known.same); shows English meanwhile");
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
            CleanProject();
            var request = NewCollection("DuiFresh", Text("fresh.key", "Fresh", "Taze"));
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
            var other = NewCollection("DuiRefused", Text("x.key", "X", "X"));
            _fixture.WithoutAddressables(() => StringAssert.Contains("the project has no Addressables settings", string.Join("\n", _tables.Check(other))));
        }

        [Test]
        public void TwoNewCollectionsInARow_BothImport_AndSaveTheSchemasOfTheGroupsTheyCreated_ButNotForeignOnes()
        {
            _fixture.Dispose(); // the setup's fixture has no schema groups: this test needs Localization to create them
            _fixture = LocalizationFixture.WithSchemaGroups("en", "tr");
            CleanProject();
            var first = _tables.Write(NewCollection("DuiFirst", Text("first.key", "First", "Birinci")));
            Assert.IsTrue(first.CreatedCollection);
            var schemas = _fixture.Settings.groups.Where(g => g != null).SelectMany(g => g.Schemas).Where(s => s != null).ToList();
            Assert.IsNotEmpty(schemas, "Localization created groups with schemas");
            foreach (var schema in schemas) Assert.IsFalse(EditorUtility.IsDirty(schema), AssetDatabase.GetAssetPath(schema) + " is saved");

            // the next import checks for unsaved work first: the first import left none behind
            var request = NewCollection("DuiSecond", Text("second.key", "Second", "Ikinci"));
            CollectionAssert.IsEmpty(_tables.Check(request));
            Assert.IsTrue(_tables.Write(request).CreatedCollection);
            foreach (var schema in _fixture.Settings.groups.Where(g => g != null).SelectMany(g => g.Schemas).Where(s => s != null))
                Assert.IsFalse(EditorUtility.IsDirty(schema), AssetDatabase.GetAssetPath(schema) + " is saved");
            CollectionAssert.IsEmpty(UnityStringTables.UnsavedWork());

            // a schema someone had changed before the import stays unsaved, and the import says so
            var foreign = schemas[0];
            EditorUtility.SetDirty(foreign);
            var third = NewCollection("DuiThird", Text("third.key", "Third", "Ucuncu"));
            Assert.Throws<InvalidOperationException>(() => _tables.Write(third), "unsaved work is refused up front");
            Assert.IsTrue(EditorUtility.IsDirty(foreign));
        }

        [Test]
        public void ANewCollection_IsRefused_WhileForeignWorkIsUnsaved_AndTheWorkStaysUnsaved()
        {
            CleanProject();
            _sentinel.referenceLocale = "unsaved-edit";
            EditorUtility.SetDirty(_sentinel);
            var request = NewCollection("DuiRefused", Text("x.key", "X", "X"));
            var errors = _tables.Check(request);
            Assert.AreEqual(1, errors.Count, string.Join("\n", errors));
            StringAssert.Contains("save or revert", errors[0]);
            StringAssert.Contains(AssetDatabase.GetAssetPath(_sentinel), errors[0]);
            Assert.Throws<InvalidOperationException>(() => _tables.Write(request));
            Assert.IsNull(LocalizationEditorSettings.GetStringTableCollection("DuiRefused"), "nothing was created");
            Assert.IsTrue(EditorUtility.IsDirty(_sentinel), "the unsaved edit is still unsaved");
            StringAssert.Contains("referenceLocale: saved", FileText(_sentinel));
            Assert.AreEqual("unsaved-edit", _sentinel.referenceLocale);

            // an existing collection's write saves only its tables: someone's open edit stays unsaved
            _tables.Write(Request(Text("new.key", "New", "Yeni")));
            Assert.IsTrue(EditorUtility.IsDirty(_sentinel));
            StringAssert.Contains("referenceLocale: saved", FileText(_sentinel));

            // an unsaved scene counts too (left for the next setup's empty scene)
            AssetDatabase.SaveAssetIfDirty(_sentinel);
            new UnityEngine.GameObject("Unsaved");
            EditorSceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());
            errors = _tables.Check(request);
            Assert.AreEqual(1, errors.Count, string.Join("\n", errors));
            StringAssert.Contains("(unsaved scene)", errors[0]);
        }

        [Test]
        public void Write_WarnsAboutTranslationsWhoseSmartFlagDiffersFromTheProfile()
        {
            void Smart(string code, string key) { Table(code).GetEntry(key).IsSmart = true; }
            Entry("en", "args.won", "{who} won");
            Entry("tr", "args.won", "{who} kazandı");
            Entry("de", "args.won", "{who} hat gewonnen"); // a translator did not mark it Smart
            Entry("fr", "args.won", "{who} a gagné");
            foreach (var code in new[] { "en", "tr", "fr" }) Smart(code, "args.won");
            Entry("en", "args.lost", "{0} lost");
            Entry("tr", "args.lost", "{0} kaybetti");
            Entry("de", "args.lost", "{0} hat verloren");
            Entry("fr", "args.lost", "{who} a perdu");
            Smart("fr", "args.lost"); // Smart in a profile of plain placeholders
            foreach (var t in _collection.StringTables) Save(t);
            Save(_collection.SharedData);

            var report = _tables.Write(Request(Text("args.won", "{who} won", "{who} kazandı", "who")));
            CollectionAssert.AreEqual(new[] { "args.won" }, report.Reused);
            Assert.AreEqual(1, report.Warnings.Count, string.Join("\n", report.Warnings));
            StringAssert.StartsWith("args.won (de): not a Smart String", report.Warnings[0]);
            CollectionAssert.Contains(report.Lines().ToList(), "localization warning: " + report.Warnings[0]);

            report = _tables.Write(Request(DesignArgumentFormat.Indexed, Text("args.lost", "{0} lost", "{0} kaybetti", "who")));
            Assert.AreEqual(1, report.Warnings.Count, string.Join("\n", report.Warnings));
            StringAssert.StartsWith("args.lost (fr): a Smart String", report.Warnings[0]);
        }

        [Test]
        public void AConflictingKey_IsNotWrittenAtAll()
        {
            Entry("en", "half.key", "");
            Entry("tr", "half.key", "Yarım");
            Save(Table("en"));
            Save(Table("tr"));
            Save(_collection.SharedData);
            var report = _tables.Write(Request(Text("half.key", "Half", "Bütün")));
            Assert.AreEqual(1, report.Conflicts.Count, string.Join("\n", report.Conflicts));
            StringAssert.StartsWith("half.key: tr in the table 'Yarım'", report.Conflicts[0]);
            CollectionAssert.IsEmpty(report.Added, "the empty English entry is not filled while the key conflicts");
            Assert.AreEqual("", Table("en").GetEntry("half.key").Value);
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
