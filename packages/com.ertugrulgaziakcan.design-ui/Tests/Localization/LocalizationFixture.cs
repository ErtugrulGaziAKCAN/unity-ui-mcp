using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.AddressableAssets;
using UnityEditor.AddressableAssets.Settings;
using UnityEditor.Localization;
using UnityEditor.Localization.Addressables;
using UnityEngine.Localization;
using UnityEngine.Localization.Metadata;
using Object = UnityEngine.Object;

namespace DesignUi.Localization.Tests
{
    /// <summary>
    /// Temporary project locales (Locale assets under <see cref="Folder"/>) and in-memory Addressables settings for String
    /// Table tests, set up without any project-wide save. Unity Localization adds every Locale and table to Addressables; on
    /// a project without Addressables settings it would create them, and when a group it expects is missing it creates it
    /// with schemas, both of which save every asset of the project. The fixture swaps in non-persisted settings (Addressables
    /// keeps the default in a private static; no public API sets one without saving) and in-memory Localization group rules
    /// that put every Locale and String Table into two fixed groups, created up front without schemas, so Localization never
    /// creates a group. The project's settings and rules come back on dispose. Construction and disposal are exception-safe.
    /// </summary>
    internal sealed class LocalizationFixture : IDisposable
    {
        public const string Folder = "Assets/DesignUiLocalizationTests";

        static readonly FieldInfo s_Default = typeof(AddressableAssetSettingsDefaultObject).GetField("s_DefaultSettingsObject", BindingFlags.Static | BindingFlags.NonPublic);

        const string LocalesGroup = "DesignUi-Test-Locales";
        const string TablesGroup = "DesignUi-Test-String-Tables";

        readonly AddressableAssetSettings _previous;
        readonly AddressableGroupRules _previousRules, _rules;
        public readonly AddressableAssetSettings Settings;
        public readonly Dictionary<string, Locale> Locales = new Dictionary<string, Locale>();

        public LocalizationFixture(params string[] codes) : this(false, codes) {}

        /// <summary>
        /// Persisted Addressables settings whose String Table groups Localization creates itself, one per locale and with
        /// schema assets (the groups come on a collection's first creation and Addressables saves the project then: use it on
        /// a project without unsaved work). The settings and groups live under <see cref="Folder"/> and go with it.
        /// </summary>
        public static LocalizationFixture WithSchemaGroups(params string[] codes) => new LocalizationFixture(true, codes);

        LocalizationFixture(bool schemaGroups, string[] codes)
        {
            Assert.IsNotNull(s_Default, "Addressables has no AddressableAssetSettingsDefaultObject.s_DefaultSettingsObject any more; update the test fixture");
            _previous = (AddressableAssetSettings)s_Default.GetValue(null);
            _previousRules = AddressableGroupRules.Instance;
            // no default groups: Addressables adds their schemas with a project-wide save
            Settings = AddressableAssetSettings.Create(Folder + "/AddressableAssetsData", "DesignUiTestSettings", false, schemaGroups);
            _rules = UnityEngine.ScriptableObject.CreateInstance<AddressableGroupRules>();
            try
            {
                s_Default.SetValue(null, Settings);
                _rules.LocaleResolver = new GroupResolver(LocalesGroup);
                _rules.StringTablesResolver = schemaGroups ? new GroupResolver("DesignUi-Test-Tables-{LocaleName}", "DesignUi-Test-Tables-Shared") : new GroupResolver(TablesGroup);
                AddressableGroupRules.Instance = _rules; // in memory: not written to the project's config
                Settings.CreateGroup("Default Local Group", true, false, false, null);
                Group(LocalesGroup);
                if (!schemaGroups) Group(TablesGroup);
                if (!AssetDatabase.IsValidFolder(Folder)) AssetDatabase.CreateFolder("Assets", Folder.Substring("Assets/".Length));
                foreach (var code in codes) AddLocale(code);
                if (schemaGroups) // the persisted settings and their groups start saved, one by one (no project-wide save)
                    foreach (var asset in new Object[] { Settings }.Concat(Settings.groups.Where(g => g != null)))
                        AssetDatabase.SaveAssetIfDirty(asset);
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        /// <summary>A project locale (asset) whose fallback is <paramref name="fallback"/>, when given; its Addressables groups exist first.</summary>
        public Locale AddLocale(string code, string fallback = null)
        {
            var locale = Locale.CreateLocale(code);
            if (fallback != null) locale.Metadata.AddMetadata(new FallbackLocale(Locales[fallback]));
            AssetDatabase.CreateAsset(locale, Folder + "/Locale-" + code + ".asset"); // its import adds it to the locales' group
            LocalizationEditorSettings.AddLocale(locale);
            Locales[code] = locale;
            return locale;
        }

        /// <summary>A group without schemas (creating one through Addressables' AddSchema saves the project).</summary>
        void Group(string name)
        {
            if (Settings.FindGroup(name) == null) Settings.CreateGroup(name, false, false, false, null);
        }

        /// <summary>
        /// Saves, one by one, what the font test fixtures left unsaved (their dynamic twins gain glyphs while earlier tests
        /// render text), so a test that creates a collection starts on a project without unsaved work.
        /// </summary>
        public static void SaveFontFixtureLeftovers()
        {
            foreach (var path in DesignUi.Editor.UnityStringTables.UnsavedWork().Where(p => p.StartsWith("Assets/DesignUiFontFixture", StringComparison.Ordinal)))
                AssetDatabase.SaveAssetIfDirty(AssetDatabase.GUIDFromAssetPath(path));
        }

        /// <summary>Runs <paramref name="action"/> as on a project without Addressables settings.</summary>
        public void WithoutAddressables(Action action)
        {
            s_Default.SetValue(null, null);
            try { action(); }
            finally { s_Default.SetValue(null, Settings); }
        }

        /// <summary>The Addressables entry of an asset in the test settings.</summary>
        public AddressableAssetEntry EntryOf(Object asset) => Settings.FindAssetEntry(AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(asset)));

        public void Dispose()
        {
            try
            {
                foreach (var l in Locales.Values.Where(l => l != null)) LocalizationEditorSettings.RemoveLocale(l);
            }
            finally
            {
                try
                {
                    if (AssetDatabase.IsValidFolder(Folder)) AssetDatabase.DeleteAsset(Folder);
                }
                finally
                {
                    AddressableGroupRules.Instance = _previousRules;
                    if (_rules != null) Object.DestroyImmediate(_rules);
                    s_Default.SetValue(null, _previous);
                    foreach (var group in Settings.groups.Where(g => g != null).ToList())
                    {
                        foreach (var schema in group.Schemas.Where(s => s != null).ToList()) Object.DestroyImmediate(schema);
                        Object.DestroyImmediate(group);
                    }
                    if (Settings != null) Object.DestroyImmediate(Settings);
                }
            }
        }
    }
}
