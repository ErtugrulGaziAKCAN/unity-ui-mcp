using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.AddressableAssets;
using UnityEditor.AddressableAssets.Settings;
using UnityEditor.Localization;
using UnityEngine.Localization;
using UnityEngine.Localization.Metadata;
using Object = UnityEngine.Object;

namespace DesignUi.Localization.Tests
{
    /// <summary>
    /// Temporary project locales (Locale assets under <see cref="Folder"/>) and in-memory Addressables settings for String
    /// Table tests. Unity Localization adds every Locale and table to Addressables; on a project without Addressables
    /// settings it would create them, which saves every asset of the project. The fixture swaps in non-persisted settings
    /// for the test (Addressables keeps the default in a private static; no public API sets one without saving), so
    /// nothing outside <see cref="Folder"/> is written, and restores the project's on dispose.
    /// </summary>
    internal sealed class LocalizationFixture : IDisposable
    {
        public const string Folder = "Assets/DesignUiLocalizationTests";

        static readonly FieldInfo s_Default = typeof(AddressableAssetSettingsDefaultObject).GetField("s_DefaultSettingsObject", BindingFlags.Static | BindingFlags.NonPublic);

        readonly AddressableAssetSettings _previous;
        public readonly AddressableAssetSettings Settings;
        public readonly Dictionary<string, Locale> Locales = new Dictionary<string, Locale>();

        public LocalizationFixture(params string[] codes)
        {
            Assert.IsNotNull(s_Default, "Addressables has no AddressableAssetSettingsDefaultObject.s_DefaultSettingsObject any more; update the test fixture");
            _previous = (AddressableAssetSettings)s_Default.GetValue(null);
            Settings = AddressableAssetSettings.Create(Folder + "/AddressableAssetsData", "DesignUiTestSettings", true, false);
            s_Default.SetValue(null, Settings);
            if (!AssetDatabase.IsValidFolder(Folder)) AssetDatabase.CreateFolder("Assets", Folder.Substring("Assets/".Length));
            foreach (var code in codes) AddLocale(code);
        }

        /// <summary>A project locale (asset) whose fallback is <paramref name="fallback"/>, when given.</summary>
        public Locale AddLocale(string code, string fallback = null)
        {
            var locale = Locale.CreateLocale(code);
            if (fallback != null) locale.Metadata.AddMetadata(new FallbackLocale(Locales[fallback]));
            AssetDatabase.CreateAsset(locale, Folder + "/Locale-" + code + ".asset");
            LocalizationEditorSettings.AddLocale(locale);
            Locales[code] = locale;
            return locale;
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
            foreach (var l in Locales.Values.Where(l => l != null)) LocalizationEditorSettings.RemoveLocale(l);
            if (AssetDatabase.IsValidFolder(Folder)) AssetDatabase.DeleteAsset(Folder);
            s_Default.SetValue(null, _previous);
            foreach (var group in Settings.groups.Where(g => g != null).ToList())
            {
                foreach (var schema in group.Schemas.Where(s => s != null).ToList()) Object.DestroyImmediate(schema);
                Object.DestroyImmediate(group);
            }
            Object.DestroyImmediate(Settings);
        }
    }
}
