using System;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.AddressableAssets;
using UnityEngine.Localization;
using UnityEngine.Localization.Settings;
using UnityEngine.ResourceManagement.AsyncOperations;
using UnityEngine.UIElements;
using Object = UnityEngine.Object;

namespace DesignUi.Localization.Tests
{
    /// <summary>
    /// <see cref="UnityLocalizationLocaleSource"/>: Unity Localization's selected locale drives a design screen, live, without
    /// a synchronous load. The test project has no Localization settings or Addressables catalog, so the settings are a
    /// test instance whose initialization is complete at once.
    /// </summary>
    public class UnityLocalizationLocaleSourceTests
    {
        sealed class ReadySettings : LocalizationSettings
        {
            public override AsyncOperationHandle<LocalizationSettings> GetInitializationOperation() =>
                Addressables.ResourceManager.CreateCompletedOperation<LocalizationSettings>(this, null);
        }

        /// <summary>Outside Play mode LocalizationSettings stores the selected locale in this Editor preference (shared by every project).</summary>
        const string EditorLocalePref = "com.unity.localization-edit-locale";

        bool _hadPref;
        string _pref;
        ReadySettings _settings;
        Locale _tr, _ar;
        Func<IDesignLocaleSource> _default;

        [SetUp]
        public void Setup()
        {
            _hadPref = EditorPrefs.HasKey(EditorLocalePref);
            _pref = EditorPrefs.GetString(EditorLocalePref, "");
            _default = DesignLocaleSources.Default;
            _settings = ScriptableObject.CreateInstance<ReadySettings>();
            LocalizationSettings.Instance = _settings;
            _tr = Locale.CreateLocale("tr");
            _ar = Locale.CreateLocale("ar");
        }

        [TearDown]
        public void Cleanup()
        {
            DesignLocaleSources.Default = _default;
            LocalizationSettings.Instance = null; // the project's settings (or a default) again on next use
            Object.DestroyImmediate(_settings);
            Object.DestroyImmediate(_tr);
            Object.DestroyImmediate(_ar);
            if (_hadPref) EditorPrefs.SetString(EditorLocalePref, _pref);
            else EditorPrefs.DeleteKey(EditorLocalePref);
        }

        [Test]
        public void SelectedLocaleChanged_SwitchesTheScreenLive()
        {
            LocalizationSettings.SelectedLocale = _tr;
            var source = new UnityLocalizationLocaleSource();
            Assert.AreEqual("tr", source.LocaleCode, "a selection that is already known is there at once");

            var root = new VisualElement();
            var controller = new LocaleFontController(root, null, new DesignLocaleRules(), source);
            try
            {
                Assert.IsTrue(root.ClassListContains("locale-tr"));
                string raised = null;
                source.LocaleChanged += c => raised = c;

                LocalizationSettings.SelectedLocale = _ar;
                Assert.AreEqual("ar", raised);
                Assert.AreEqual("ar", source.LocaleCode);
                Assert.IsTrue(root.ClassListContains("locale-ar"), "the open screen switches with the selection");
                Assert.IsFalse(root.ClassListContains("locale-tr"));
                Assert.IsTrue(root.ClassListContains(LocaleFontController.RtlClass));

                source.Dispose();
                LocalizationSettings.SelectedLocale = _tr;
                Assert.IsTrue(root.ClassListContains("locale-ar"), "a disposed source no longer follows the selection");
            }
            finally
            {
                controller.Dispose();
                source.Dispose();
            }
        }

        [Test]
        public void IsTheDefaultLocaleSource_WhenUnityLocalizationIsInstalled()
        {
            LocalizationSettings.SelectedLocale = _tr;
            Assert.IsNotNull(DesignLocaleSources.Default, "registered on load");
            var source = DesignLocaleSources.Default();
            try
            {
                Assert.IsInstanceOf<UnityLocalizationLocaleSource>(source);
                Assert.AreEqual("tr", source.LocaleCode);
            }
            finally
            {
                (source as IDisposable)?.Dispose();
            }
        }
    }
}
