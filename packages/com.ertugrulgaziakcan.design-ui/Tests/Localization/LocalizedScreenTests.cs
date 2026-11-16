using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using DesignUi.Editor;
using DesignUi.Editor.Tests;
using Newtonsoft.Json;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.Localization;
using UnityEngine;
using UnityEngine.AddressableAssets;
using UnityEngine.Localization;
using UnityEngine.Localization.Settings;
using UnityEngine.ResourceManagement.AsyncOperations;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Localization.Tests
{
    /// <summary>
    /// A localized screen end to end on Unity Localization: the import writes the screen's String Table collection and binds
    /// its texts in the UXML; the open screen follows a locale switch without reopening, in the frame the locale controller
    /// moves it to the new locale's class and font; arguments reach the entry as Smart String variables or format arguments;
    /// and the bound text goes through DesignText (its first layout is kerned).
    /// </summary>
    public class LocalizedScreenTests
    {
        sealed class ReadySettings : LocalizationSettings
        {
            public override AsyncOperationHandle<LocalizationSettings> GetInitializationOperation() =>
                Addressables.ResourceManager.CreateCompletedOperation<LocalizationSettings>(this, null);
        }

        const string EditorLocalePref = "com.unity.localization-edit-locale";
        const string Out = "Assets/DesignUiLocalizedScreenTests";
        const string Collection = "DuiScreen";
        /// <summary>Strongly kerned pairs in Inter (AV, VA, AT, TA, To, Wa, Ya); none of A, V, T, R, W, Y is in the screen's strings.</summary>
        const string Kerned = "AVATAR Toyota Wave";
        const float Size = 32f;

        readonly List<string> _temp = new List<string>();
        LocalizationFixture _fixture;
        ReadySettings _settings;
        bool _hadPref;
        string _pref;
        GameObject _go;
        PanelSettings _panel;
        RenderTexture _rt;
        LocaleFontController _controller;
        UnityLocalizationLocaleSource _source;

        [SetUp]
        public void Setup()
        {
            _hadPref = EditorPrefs.HasKey(EditorLocalePref);
            _pref = EditorPrefs.GetString(EditorLocalePref, "");
            try
            {
                // an empty untitled scene first: the import creates a collection, which it refuses while a scene is unsaved
                // (earlier tests leave the test scene modified); a scene change also destroys in-memory objects nothing
                // references, so it comes before the fixture's
                UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Single);
                LocalizationFixture.SaveFontFixtureLeftovers();
                _fixture = new LocalizationFixture("en", "tr");
                _fixture.AddLocale("de", fallback: "en");
                _settings = ScriptableObject.CreateInstance<ReadySettings>();
                LocalizationSettings.Instance = _settings;
                foreach (var l in _fixture.Locales.Values) LocalizationSettings.AvailableLocales.AddLocale(l); // the binding's English lookup
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
                _controller?.Dispose();
                _source?.Dispose();
                if (_go != null) Object.DestroyImmediate(_go);
                if (_panel != null) Object.DestroyImmediate(_panel);
                if (_rt != null) Object.DestroyImmediate(_rt);
                LocalizationSettings.Instance = null;
                if (_settings != null) Object.DestroyImmediate(_settings);
                if (_hadPref) EditorPrefs.SetString(EditorLocalePref, _pref);
                else EditorPrefs.DeleteKey(EditorLocalePref);
                if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
                foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
                _temp.Clear();
                FontFixture.Delete();
            }
        }

        static IrNode Styled(IrNode text, string key, string en, params string[] args)
        {
            text.Style["base"]["font-family"] = "Inter";
            text.Style["base"]["font-size"] = "32px";
            text.Style["base"]["color"] = "#ffffff";
            text.Style["base"]["align-self"] = "flex-start";
            text.Text.Key = key;
            text.Text.En = en;
            text.Text.Args = args;
            return text;
        }

        /// <summary>Compiles a screen (title, an argument-only text, a text with an argument) with Unity Localization's tables; returns the font set.</summary>
        DesignFontSet Compile(DesignArgumentFormat format, out CompileResult result)
        {
            var title = Styled(TestIr.Text("title", "Kulüp"), "loc.clubTitle", "Club");
            var who = Styled(TestIr.Text("who", "{who}"), "loc.who", "{who}", "who");
            var score = Styled(TestIr.Text("score", "{who} kazandı"), "loc.score", "{who} won", "who");
            var ir = TestIr.Screen(TestIr.Root(title, who, score), "loc.live");
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-l10n-live-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));

            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            profile.outputFolder = Out;
            FontFixture.Use(profile);
            // German renders with its own font (a second TMP asset of the Inter family), so the switch swaps fonts
            var german = FontFixture.CreateTmp(FontFixture.BoldTtf, "Inter German Fixture", family: FontFixture.SharedFamily);
            profile.locales = new[] { "de" };
            profile.localeFonts = profile.localeFonts.Concat(new[] { new LocaleFont { locale = "de", font = german } }).ToArray();
            profile.localization.enabled = true;
            profile.localization.argumentFormat = format;
            profile.localization.defaultCollection = Collection;
            profile.localization.newCollectionFolder = LocalizationFixture.Folder + "/{collection}";
            try { result = ScreenCompiler.Compile(dir, profile, false, TestIr.NoView()); }
            finally { Object.DestroyImmediate(profile); }
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/LocLive/LocLive.uxml");
            Assert.IsFalse(vta.importedWithErrors || vta.importedWithWarnings, "the screen's UXML with its String Table bindings imports cleanly");
            return AssetDatabase.LoadAssetAtPath<DesignFontSet>(Out + "/" + DesignFontSet.FileName);
        }

        VisualElement Panel()
        {
            _rt = new RenderTexture(1024, 256, 24);
            _panel = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _panel.scaleMode = PanelScaleMode.ConstantPixelSize;
            _panel.scale = 1f;
            _panel.targetTexture = _rt;
            _go = new GameObject("LocalizedScreenTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _panel;
            return doc.rootVisualElement;
        }

        /// <summary>A translator's entry, saved.</summary>
        static void Translate(string code, string key, string value, bool smart)
        {
            var table = LocalizationEditorSettings.GetStringTableCollection(Collection).StringTables.Single(t => t.LocaleIdentifier.Code == code);
            table.AddEntry(key, value).IsSmart = smart;
            EditorUtility.SetDirty(table);
            AssetDatabase.SaveAssetIfDirty(table);
        }

        /// <summary>The compiled screen in a panel under a locale controller on Unity Localization's selection, with the view's argument setters.</summary>
        (VisualElement root, VisualElement tree, DesignTextArgs who, DesignTextArgs score) Open(DesignFontSet set, string locale)
        {
            LocalizationSettings.SelectedLocale = _fixture.Locales[locale];
            var root = Panel();
            _source = new UnityLocalizationLocaleSource();
            _controller = new LocaleFontController(root, set, new DesignLocaleRules(), _source);
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/LocLive/LocLive.uxml").Instantiate();
            var who = new DesignTextArgs(tree.Q<Label>("who"), null, "who"); // as the generated view creates them
            var score = new DesignTextArgs(tree.Q<Label>("score"), null, "who");
            root.Add(tree);
            return (root, tree, who, score);
        }

        static float Unkerned(FontAsset font, string text, float size) =>
            text.Sum(c => font.characterLookupTable[c].glyph.metrics.horizontalAdvance) * size / font.faceInfo.pointSize;

        static IEnumerator Frames(int n)
        {
            for (int i = 0; i < n; i++) yield return null;
        }

        [UnityTest]
        public IEnumerator OpenScreen_FollowsALocaleSwitch_InTheFrameItsClassAndFontSwap_AndBoundTextGoesThroughDesignText()
        {
            var set = Compile(DesignArgumentFormat.SmartString, out var result);
            Assert.IsTrue(result.Localization.CreatedCollection);
            CollectionAssert.AreEquivalent(new[] { "loc.clubTitle (en, tr)", "loc.who (en, tr)", "loc.score (en, tr)" }, result.Localization.Added);
            Assert.AreEqual("de", result.Localization.Pending.Single().Locale, "German is pending: fallback is not translation");
            // a translator adds German after the import: the open screen shows it on the switch
            var collection = LocalizationEditorSettings.GetStringTableCollection(Collection);
            var de = collection.StringTables.Single(t => t.LocaleIdentifier.Code == "de");
            de.AddEntry("loc.clubTitle", "Größe");
            EditorUtility.SetDirty(de);
            AssetDatabase.SaveAssetIfDirty(de);

            LocalizationSettings.SelectedLocale = _fixture.Locales["tr"];
            var root = Panel();
            _source = new UnityLocalizationLocaleSource();
            _controller = new LocaleFontController(root, set, new DesignLocaleRules(), _source);
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/LocLive/LocLive.uxml").Instantiate();
            var screen = tree.Q("root");
            var title = tree.Q<Label>("title");
            var who = tree.Q<Label>("who");
            var score = tree.Q<Label>("score");
            var whoArgs = new DesignTextArgs(who, null, "who"); // as the generated view creates them
            var scoreArgs = new DesignTextArgs(score, null, "who");
            Assert.IsTrue(whoArgs.IsLocalized && scoreArgs.IsLocalized);
            root.Add(tree);
            yield return Frames(3);
            Assert.AreEqual("Kulüp", title.text);
            Assert.IsTrue(screen.ClassListContains("locale-tr"));
            Assert.AreEqual("", who.text, "an entry of arguments only, not set yet, shows nothing (never the missing-translation message)");
            Assert.AreEqual(" kazandı", score.text);

            whoArgs.Set(0, Kerned);
            scoreArgs.Set(0, "Ali");
            yield return Frames(5);
            var trTwin = set.FontsFor("tr")[0];
            Assert.AreEqual(Kerned, who.text);
            Assert.AreEqual("Ali kazandı", score.text, "a Smart String variable");
            Assert.AreSame(trTwin, who.resolvedStyle.unityFontDefinition.fontAsset);
            Assert.Less(who.layout.width, Unkerned(trTwin, Kerned, Size) - 4, "the first layout of the bound text is kerned: the binding wrote it through DesignText");

            LocalizationSettings.SelectedLocale = _fixture.Locales["de"];
            yield return null; // one frame: text, class and font together
            var deTwin = set.FontsFor("de")[0];
            Assert.AreNotSame(trTwin, deTwin);
            Assert.AreEqual("Größe", title.text, "the open screen shows the new locale without reopening");
            Assert.AreEqual(Kerned, who.text);
            Assert.AreEqual("Ali won", score.text, "an entry German lacks falls back to English");
            Assert.IsTrue(screen.ClassListContains("locale-de") && !screen.ClassListContains("locale-tr"), "the locale controller's class in the same frame");
            Assert.AreSame(deTwin, title.resolvedStyle.unityFontDefinition.fontAsset, "and its font");
            Assert.IsTrue(deTwin.characterLookupTable.ContainsKey('ß'));
            Assert.AreSame(title, tree.Q<Label>("title"), "the same elements: nothing reopened");
        }

        /// <summary>
        /// A regression guard of the String Table binding path (decision D-136's context: a language switched while a screen is
        /// open): the screen's text-sized title follows a locale switch, which brings its text and its font in one frame
        /// through the binding and the locale controller, to the new text's width, and back. This path writes through
        /// <c>text</c>, which sends a change event, so it held on 15fa093 too; D-136's red test is
        /// <c>TextFitTests.AText_ChangedAfterItsFirstLayout_IsMeasuredAgain_HoweverItIsWritten</c> (a write without a change event).
        /// </summary>
        [UnityTest]
        public IEnumerator ATextSizedTitle_FollowsALocaleSwitch_ToItsNewTextsWidth()
        {
            var set = Compile(DesignArgumentFormat.SmartString, out _);
            Translate("de", "loc.clubTitle", "Größe des Vereins und seiner Mannschaft", false);
            var (_, tree, _, _) = Open(set, "tr");
            var title = tree.Q<DesignLabel>("title");
            Assert.IsNotNull(title, "the text-sized title compiles to a DesignLabel");
            yield return Frames(5);
            void Fitted(string what)
            {
                var text = title.Fit.TextWidth();
                Assert.IsFalse(float.IsNaN(text), what + ": measured");
                Assert.AreEqual(DesignTextFit.Snap(text, title.panel.scaledPixelsPerPoint), title.Fit.Width, 1e-3, what + ": the browser's width for '" + title.text + "'");
                Assert.AreEqual(title.Fit.Width, title.layout.width, 1e-3, what + ": laid out at it");
            }
            Assert.AreEqual("Kulüp", title.text);
            Fitted("Turkish");
            float turkish = title.Fit.Width;

            LocalizationSettings.SelectedLocale = _fixture.Locales["de"];
            yield return Frames(5);
            Assert.AreEqual("Größe des Vereins und seiner Mannschaft", title.text);
            Assert.AreSame(set.FontsFor("de")[0], title.resolvedStyle.unityFontDefinition.fontAsset, "the German font");
            Fitted("German, a much longer text in another font");
            Assert.Greater(title.Fit.Width, turkish * 3);

            LocalizationSettings.SelectedLocale = _fixture.Locales["tr"];
            yield return Frames(5);
            Assert.AreEqual("Kulüp", title.text);
            Fitted("Turkish again, a much shorter text");
            Assert.AreEqual(turkish, title.Fit.Width, 1e-3);
        }

        [UnityTest]
        public IEnumerator IndexedFormat_FillsPositionalPlaceholders()
        {
            var set = Compile(DesignArgumentFormat.Indexed, out _);
            var collection = LocalizationEditorSettings.GetStringTableCollection(Collection);
            var en = collection.StringTables.Single(t => t.LocaleIdentifier.Code == "en");
            Assert.AreEqual("{0} won", en.GetEntry("loc.score").Value);
            Assert.IsFalse(en.GetEntry("loc.score").IsSmart, "a plain string.Format entry");

            var (_, tree, _, args) = Open(set, "tr");
            var score = tree.Q<Label>("score");
            yield return Frames(3);
            Assert.AreEqual(" kazandı", score.text, "an argument not set yet is empty");
            args.Set(0, "Ali");
            yield return Frames(2);
            Assert.AreEqual("Ali kazandı", score.text);
            LocalizationSettings.SelectedLocale = _fixture.Locales["en"];
            yield return null;
            Assert.AreEqual("Ali won", score.text);
        }

        [UnityTest]
        public IEnumerator EachEntryIsFormattedByItsOwnSmartFlag()
        {
            // a Smart String profile whose German translation is a plain entry: it gets the arguments by index
            var set = Compile(DesignArgumentFormat.SmartString, out _);
            Translate("de", "loc.score", "{0} hat gewonnen", smart: false);
            var (_, tree, _, args) = Open(set, "de");
            var score = tree.Q<Label>("score");
            args.Set(0, "Ali");
            yield return Frames(3);
            Assert.AreEqual("Ali hat gewonnen", score.text);
            Cleanup();
            Setup();

            // a profile of plain placeholders whose German translation is a Smart String: it gets them by name
            set = Compile(DesignArgumentFormat.Indexed, out _);
            Translate("de", "loc.score", "{who} hat gewonnen", smart: true);
            (_, tree, _, args) = Open(set, "de");
            score = tree.Q<Label>("score");
            args.Set(0, "Ali");
            yield return Frames(3);
            Assert.AreEqual("Ali hat gewonnen", score.text);
        }

        [UnityTest]
        public IEnumerator ABrokenTranslation_ShowsEnglish_AndTheLocaleSwitchReachesEveryListener()
        {
            var set = Compile(DesignArgumentFormat.SmartString, out _);
            // German: a named placeholder in a plain entry (string.Format cannot read it) and a Smart String with an unknown name
            Translate("de", "loc.score", "{who} hat gewonnen", smart: false);
            Translate("de", "loc.clubTitle", "Verein {klub}", smart: true);
            var (_, tree, _, args) = Open(set, "tr");
            var score = tree.Q<Label>("score");
            var title = tree.Q<Label>("title");
            args.Set(0, "Ali");
            yield return Frames(3);
            Assert.AreEqual("Ali kazandı", score.text);

            Locale heard = null;
            Action<Locale> listener = l => heard = l; // subscribed after the screen's bindings
            LocalizationSettings.SelectedLocaleChanged += listener;
            try
            {
                // in the order the screen's bindings load (title, then score)
                LogAssert.Expect(LogType.Warning, new Regex(@"loc\.clubTitle.*\(de\) could not be formatted"));
                LogAssert.Expect(LogType.Warning, new Regex(@"loc\.score.*\(de\) could not be formatted.*English entry"));
                Assert.DoesNotThrow(() => LocalizationSettings.SelectedLocale = _fixture.Locales["de"]);
                Assert.AreSame(_fixture.Locales["de"], heard, "listeners after the screen's bindings still hear the locale change");
                yield return Frames(2);
                Assert.AreEqual("Ali won", score.text, "the English entry, formatted the same way");
                Assert.AreEqual("Club", title.text);
                Assert.IsTrue(tree.Q("root").ClassListContains("locale-de"));

                Assert.DoesNotThrow(() => args.Set(0, "Veli"), "a generated setter never throws");
                yield return Frames(2);
                Assert.AreEqual("Veli won", score.text);
                LogAssert.NoUnexpectedReceived(); // reported once per key and locale
            }
            finally { LocalizationSettings.SelectedLocaleChanged -= listener; }
        }

        [UnityTest]
        public IEnumerator ADetachedScreen_StopsListening_AndShowsTheCurrentLocaleWhenItComesBack()
        {
            var set = Compile(DesignArgumentFormat.SmartString, out _);
            var (root, tree, _, args) = Open(set, "tr");
            var score = tree.Q<Label>("score");
            args.Set(0, "Ali");
            yield return Frames(3);
            Assert.AreEqual("Ali kazandı", score.text);

            tree.RemoveFromHierarchy();
            yield return null;
            LocalizationSettings.SelectedLocale = _fixture.Locales["en"];
            yield return Frames(2);
            Assert.AreEqual("Ali kazandı", score.text, "a detached screen is not written");
            root.Add(tree);
            yield return Frames(3);
            Assert.AreEqual("Ali won", score.text, "back in a panel it shows the current locale");
            args.Set(0, "Veli");
            yield return Frames(2);
            Assert.AreEqual("Veli won", score.text, "and its arguments still reach it");
        }
    }
}
