using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.AddressableAssets;
using UnityEditor.AddressableAssets.Settings;
using UnityEditor.Localization;
using UnityEngine.Localization;
using UnityEngine.Localization.Metadata;
using UnityEngine.Localization.Tables;
using Object = UnityEngine.Object;

namespace DesignUi.Editor
{
    /// <summary>
    /// Unity Localization String Tables as the import's localization writer (<see cref="IDesignStringTables"/>, spec 13).
    /// Compiled when com.unity.localization 1.5 or newer is installed; it registers itself in
    /// <see cref="DesignStringTables.Current"/> when the Editor loads.
    /// <list type="bullet">
    /// <item>Keys are exact and case-sensitive (<c>calendar.main.pendingOnly</c>): an existing key is reused only when the
    /// design spells it the same; a new key that differs from one only in letter case is reported.</item>
    /// <item>The screen's collection must have an English and a reference-locale table. A collection that does not exist yet
    /// is created in the profile's folder with a table per project locale (Unity Localization adds the tables to
    /// Addressables under its own addresses, <c>&lt;collection&gt;_&lt;code&gt;</c>, and <c>Locale-&lt;code&gt;</c> labels);
    /// the profile's preload flag and extra labels are applied. It is refused when the project has no Addressables settings
    /// (creating them saves every asset of the project).</item>
    /// <item>A table or shared table data with unsaved changes is refused (the import saves only what it writes and must not
    /// save someone's open edits).</item>
    /// <item>Saves: each written table, the shared table data and, for a new collection, the Addressables settings and groups
    /// that changed, each with an asset-specific save; Addressables assets that had unsaved changes before are not saved
    /// (reported).</item>
    /// </list>
    /// </summary>
    public sealed class UnityStringTables : IDesignStringTables
    {
        [InitializeOnLoadMethod]
        static void Register() => DesignStringTables.Current = new UnityStringTables();

        public IReadOnlyList<string> Check(StringTableRequest request)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            var errors = new List<string>();
            var collection = LocalizationEditorSettings.GetStringTableCollection(request.Collection);
            if (collection == null)
            {
                if (AddressableAssetSettingsDefaultObject.GetSettings(false) == null)
                    errors.Add("String Table collection '" + request.Collection + "' does not exist and the project has no Addressables settings; create them once " +
                               "(Window > Asset Management > Addressables > Groups) or create the collection in the Localization Tables window, then import again");
                var locales = LocalizationEditorSettings.GetLocales();
                foreach (var code in new[] { request.EnglishLocale, request.ReferenceLocale }.Distinct(StringComparer.OrdinalIgnoreCase))
                    if (!locales.Any(l => Same(l.Identifier.Code, code)))
                        errors.Add("the project has no locale '" + code + "' for the new String Table collection '" + request.Collection + "'; add it in Localization Settings > Available Locales");
                var folder = request.NewCollectionFolder ?? "";
                if (!(folder == "Assets" || folder.StartsWith("Assets/", StringComparison.Ordinal)))
                    errors.Add("the folder for the new String Table collection '" + request.Collection + "' must be inside Assets/ (the profile's newCollectionFolder gives '" + folder + "')");
                return errors;
            }
            foreach (var code in new[] { request.EnglishLocale, request.ReferenceLocale }.Distinct(StringComparer.OrdinalIgnoreCase))
                if (TableOf(collection, code) == null)
                    errors.Add("String Table collection '" + request.Collection + "' has no table for locale '" + code + "'; add it in the Localization Tables window");
            foreach (var asset in new Object[] { collection.SharedData, TableOf(collection, request.EnglishLocale), TableOf(collection, request.ReferenceLocale) }.Where(a => a != null).Distinct())
                if (EditorUtility.IsDirty(asset))
                    errors.Add("'" + AssetDatabase.GetAssetPath(asset) + "' has unsaved changes; save or revert them, then import again (the import saves only what it writes)");
            return errors;
        }

        public LocalizationReport Write(StringTableRequest request)
        {
            var errors = Check(request);
            if (errors.Count > 0) throw new InvalidOperationException(string.Join("; ", errors));
            var report = new LocalizationReport { Collection = request.Collection };
            var touched = new List<Object>();
            var collection = LocalizationEditorSettings.GetStringTableCollection(request.Collection) ?? Create(request, report, touched);

            var shared = collection.SharedData;
            var en = TableOf(collection, request.EnglishLocale);
            var reference = TableOf(collection, request.ReferenceLocale);
            var sameTable = en == reference;
            foreach (var text in request.Texts)
            {
                var smart = request.Format == DesignArgumentFormat.SmartString && text.Args.Length > 0;
                var written = new List<string>();
                var conflict = false;
                var key = shared.GetEntry(text.Key); // exact and case-sensitive: keys are never folded
                if (key == null)
                {
                    var near = shared.Entries.FirstOrDefault(e => string.Equals(e.Key, text.Key, StringComparison.OrdinalIgnoreCase));
                    if (near != null)
                        report.Notes.Add("new key '" + text.Key + "' differs from the existing key '" + near.Key + "' only in letter case; keys are exact: " +
                                         "spell it as the table does to reuse its translations");
                }
                var enEntry = key != null ? en.GetEntry(key.Id) : null;
                if (enEntry != null && !string.IsNullOrEmpty(enEntry.Value))
                {
                    if (!string.Equals(enEntry.Value, text.En, StringComparison.Ordinal))
                    {
                        report.Conflicts.Add(text.Key + ": English in the table '" + enEntry.Value + "', in the design '" + text.En + "' (" + string.Join(", ", text.Places) + ")");
                        continue;
                    }
                    if (smart && !enEntry.IsSmart)
                    {
                        report.Conflicts.Add(text.Key + ": the English entry is not a Smart String, but the design sets {" + string.Join("}, {", text.Args) + "} in it");
                        continue;
                    }
                }
                else
                {
                    Write(en, text.Key, text.En, smart);
                    written.Add(request.EnglishLocale);
                }
                if (!sameTable)
                {
                    var refEntry = reference.GetEntry(text.Key);
                    if (refEntry == null || string.IsNullOrEmpty(refEntry.Value))
                    {
                        Write(reference, text.Key, text.Reference, smart);
                        written.Add(request.ReferenceLocale);
                    }
                    else if (!string.Equals(refEntry.Value, text.Reference, StringComparison.Ordinal))
                    {
                        conflict = true;
                        report.Conflicts.Add(text.Key + ": " + request.ReferenceLocale + " in the table '" + refEntry.Value + "', in the design '" + text.Reference + "' (" +
                                             string.Join(", ", text.Places) + ")");
                    }
                }
                if (written.Count > 0)
                {
                    report.Added.Add(text.Key + " (" + string.Join(", ", written) + ")");
                    touched.Add(shared);
                    if (written.Contains(request.EnglishLocale)) touched.Add(en);
                    if (written.Contains(request.ReferenceLocale)) touched.Add(reference);
                }
                else if (!conflict) report.Reused.Add(text.Key);
            }

            foreach (var asset in touched.Distinct())
            {
                if (!EditorUtility.IsPersistent(asset)) continue;
                EditorUtility.SetDirty(asset);
                AssetDatabase.SaveAssetIfDirty(asset);
                report.Saved.Add(AssetDatabase.GetAssetPath(asset));
            }
            if (touched.Count > 0) LocalizationEditorSettings.EditorEvents.RaiseCollectionModified(this, collection);
            Pending(collection, request, report);
            return report;
        }

        public IReadOnlyDictionary<string, IReadOnlyList<string>> Strings(string collectionName, IEnumerable<string> keys)
        {
            var result = new SortedDictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
            var collection = LocalizationEditorSettings.GetStringTableCollection(collectionName);
            if (collection == null) return result;
            var list = keys.Distinct(StringComparer.Ordinal).ToList();
            foreach (var table in collection.StringTables)
            {
                if (table == null) continue;
                var values = list.Select(k => table.GetEntry(k)?.Value).Where(v => !string.IsNullOrEmpty(v)).ToList();
                if (values.Count > 0) result[table.LocaleIdentifier.Code] = values;
            }
            return result;
        }

        /// <summary>Creates the collection with a table per project locale and applies the profile's preload and label rules.</summary>
        static StringTableCollection Create(StringTableRequest request, LocalizationReport report, List<Object> touched)
        {
            var settings = AddressableAssetSettingsDefaultObject.GetSettings(false);
            var dirtyBefore = new HashSet<Object>(AddressablesAssets(settings).Where(EditorUtility.IsDirty));
            EnsureFolder(request.NewCollectionFolder);
            var collection = LocalizationEditorSettings.CreateStringTableCollection(request.Collection, request.NewCollectionFolder);
            report.CreatedCollection = true;
            foreach (var table in collection.StringTables)
            {
                if (request.PreloadNewTables) LocalizationEditorSettings.SetPreloadTableFlag(table, true);
                var entry = settings.FindAssetEntry(AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(table)));
                if (entry != null)
                    foreach (var label in request.NewTableLabels) entry.SetLabel(label, true, true);
            }
            touched.Add(collection);
            touched.Add(collection.SharedData);
            touched.AddRange(collection.StringTables);
            foreach (var asset in AddressablesAssets(settings).Where(EditorUtility.IsDirty))
            {
                if (dirtyBefore.Contains(asset))
                    report.Notes.Add("'" + AssetDatabase.GetAssetPath(asset) + "' had unsaved changes before the import and was not saved; save the project to keep the new tables' Addressables entries");
                else touched.Add(asset);
            }
            return collection;
        }

        /// <summary>The Addressables settings and their groups.</summary>
        static IEnumerable<Object> AddressablesAssets(AddressableAssetSettings settings)
        {
            if (settings == null) yield break;
            yield return settings;
            foreach (var group in settings.groups)
                if (group != null) yield return group;
        }

        static void EnsureFolder(string folder)
        {
            if (string.IsNullOrEmpty(folder) || AssetDatabase.IsValidFolder(folder)) return;
            var slash = folder.LastIndexOf('/');
            if (slash <= 0) return;
            EnsureFolder(folder.Substring(0, slash));
            AssetDatabase.CreateFolder(folder.Substring(0, slash), folder.Substring(slash + 1));
        }

        static void Write(StringTable table, string key, string value, bool smart)
        {
            var entry = table.AddEntry(key, value);
            if (smart) entry.IsSmart = true;
        }

        /// <summary>Every other project locale whose table lacks a translation of the screen's keys.</summary>
        static void Pending(StringTableCollection collection, StringTableRequest request, LocalizationReport report)
        {
            var keys = request.Texts.Select(t => t.Key).ToList();
            foreach (var locale in LocalizationEditorSettings.GetLocales().OrderBy(l => l.Identifier.Code, StringComparer.Ordinal))
            {
                var code = locale.Identifier.Code;
                if (Same(code, request.EnglishLocale) || Same(code, request.ReferenceLocale)) continue;
                var table = TableOf(collection, code);
                var pending = new PendingTranslation { Locale = code, FallsBackToEnglish = ReachesEnglish(locale, request.EnglishLocale) };
                pending.Keys.AddRange(keys.Where(k => table == null || string.IsNullOrEmpty(table.GetEntry(k)?.Value)));
                if (pending.Keys.Count > 0) report.Pending.Add(pending);
            }
        }

        /// <summary>Whether the locale's fallback chain (Fallback Locale metadata) reaches English.</summary>
        static bool ReachesEnglish(Locale locale, string english)
        {
            var seen = new HashSet<Locale>();
            for (var l = locale; l != null && seen.Add(l); l = l.Metadata?.GetMetadata<FallbackLocale>()?.Locale)
                if (Same(l.Identifier.Code, english)) return true;
            return false;
        }

        static StringTable TableOf(StringTableCollection collection, string code) =>
            collection.StringTables.FirstOrDefault(t => t != null && Same(t.LocaleIdentifier.Code, code));

        static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    }
}
