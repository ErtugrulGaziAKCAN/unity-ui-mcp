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
    /// <item>Keys are exact and case-sensitive (<c>inbox.main.unreadOnly</c>): an existing key is reused only when the
    /// design spells it the same; a new key that differs from one only in letter case is reported.</item>
    /// <item>The screen's collection must have an English and a reference-locale table. A collection that does not exist yet
    /// is created in the profile's folder with a table per project locale (Unity Localization adds the tables to
    /// Addressables under its own addresses, <c>&lt;collection&gt;_&lt;code&gt;</c>, and <c>Locale-&lt;code&gt;</c> labels);
    /// the profile's preload flag and extra labels are applied. Creating it is refused when the project has no Addressables
    /// settings (creating them saves every asset of the project) and while the project has unsaved work (assets with unsaved
    /// changes, unsaved scenes): Addressables saves the whole project when it creates a group for the new tables
    /// (AddressableAssetGroup.AddSchema), and no public Addressables API creates a usable group without that save.</item>
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
                // Localization adds the new tables to Addressables, which saves the whole project when it creates a group
                // (AddressableAssetGroup.AddSchema): no one's unsaved work may be in the project then
                var unsaved = UnsavedWork();
                if (unsaved.Count > 0)
                    errors.Add("creating String Table collection '" + request.Collection + "' can make Unity Localization and Addressables save the whole project; " +
                               "save or revert these first: " + string.Join(", ", unsaved.Take(12)) + (unsaved.Count > 12 ? " and " + (unsaved.Count - 12) + " more" : "") +
                               " (or create the collection in the Localization Tables window), then import again");
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

        /// <summary>
        /// What a project-wide save would write that the import did not change, by path: project assets in Unity's own format
        /// (and project settings) with unsaved changes; plus open scenes that are not saved. Imported files (fonts, textures)
        /// and the Editor's built-in resources are not written by a save and are left out.
        /// </summary>
        public static IReadOnlyList<string> UnsavedWork()
        {
            var paths = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var o in UnityEngine.Resources.FindObjectsOfTypeAll<Object>())
            {
                if (o == null || !EditorUtility.IsDirty(o) || !EditorUtility.IsPersistent(o)) continue;
                var path = AssetDatabase.GetAssetPath(o);
                if (string.IsNullOrEmpty(path)) continue;
                if (path.StartsWith("ProjectSettings/", StringComparison.Ordinal) ||
                    (path.StartsWith("Assets/", StringComparison.Ordinal) || path.StartsWith("Packages/", StringComparison.Ordinal)) && AssetDatabase.IsNativeAsset(o))
                    paths.Add(path);
            }
            var result = paths.ToList();
            for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++)
            {
                var scene = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);
                if (scene.isDirty) result.Add((string.IsNullOrEmpty(scene.path) ? "Untitled" : scene.path) + " (unsaved scene)");
            }
            var stage = UnityEditor.SceneManagement.PrefabStageUtility.GetCurrentPrefabStage();
            if (stage != null && stage.scene.isDirty) result.Add(stage.assetPath + " (unsaved prefab)");
            return result;
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
                var key = shared.GetEntry(text.Key); // exact and case-sensitive: keys are never folded
                if (key == null)
                {
                    var near = shared.Entries.FirstOrDefault(e => string.Equals(e.Key, text.Key, StringComparison.OrdinalIgnoreCase));
                    if (near != null)
                        report.Notes.Add("new key '" + text.Key + "' differs from the existing key '" + near.Key + "' only in letter case; keys are exact: " +
                                         "spell it as the table does to reuse its translations");
                }
                var enEntry = key != null ? en.GetEntry(key.Id) : null;
                var refEntry = !sameTable && key != null ? reference.GetEntry(key.Id) : null;
                var writeEn = enEntry == null || string.IsNullOrEmpty(enEntry.Value);
                var writeRef = !sameTable && (refEntry == null || string.IsNullOrEmpty(refEntry.Value));
                var conflicts = new List<string>();
                if (!writeEn && !string.Equals(enEntry.Value, text.En, StringComparison.Ordinal))
                    conflicts.Add(text.Key + ": English in the table '" + enEntry.Value + "', in the design '" + text.En + "' (" + string.Join(", ", text.Places) + ")");
                else if (!writeEn && smart && !enEntry.IsSmart)
                    conflicts.Add(text.Key + ": the English entry is not a Smart String, but the design sets {" + string.Join("}, {", text.Args) + "} in it");
                if (!sameTable && !writeRef && !string.Equals(refEntry.Value, text.Reference, StringComparison.Ordinal))
                    conflicts.Add(text.Key + ": " + request.ReferenceLocale + " in the table '" + refEntry.Value + "', in the design '" + text.Reference + "' (" +
                                  string.Join(", ", text.Places) + ")");
                if (conflicts.Count > 0)
                {
                    report.Conflicts.AddRange(conflicts); // nothing of a conflicting key is written
                    continue;
                }
                if (writeEn)
                {
                    Write(en, text.Key, text.En, smart);
                    written.Add(request.EnglishLocale);
                }
                if (writeRef)
                {
                    Write(reference, text.Key, text.Reference, smart);
                    written.Add(request.ReferenceLocale);
                }
                if (written.Count > 0)
                {
                    report.Added.Add(text.Key + " (" + string.Join(", ", written) + ")");
                    touched.Add(shared);
                    if (writeEn) touched.Add(en);
                    if (writeRef) touched.Add(reference);
                }
                else report.Reused.Add(text.Key);
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
            SmartFlags(collection, request, report);
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

        /// <summary>The Addressables settings, their groups and each group's schemas (Localization creates schemas with a new locale's group).</summary>
        static IEnumerable<Object> AddressablesAssets(AddressableAssetSettings settings)
        {
            if (settings == null) yield break;
            yield return settings;
            foreach (var group in settings.groups)
            {
                if (group == null) continue;
                yield return group;
                foreach (var schema in group.Schemas)
                    if (schema != null) yield return schema;
            }
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
                var pending = new PendingTranslation { Locale = code, FallsBackToEnglish = ReachesEnglish(locale, request.EnglishLocale), NoTable = table == null };
                pending.Keys.AddRange(keys.Where(k => table == null || string.IsNullOrEmpty(table.GetEntry(k)?.Value)));
                if (pending.Keys.Count > 0) report.Pending.Add(pending);
            }
        }

        /// <summary>
        /// Entries of texts with arguments whose Smart flag differs from the profile's format, in any locale: the screen formats
        /// each entry by its own flag (a Smart String gets the arguments by name, a plain entry by index), so such a
        /// translation shows its placeholders differently than the design's English. Reported, never changed.
        /// </summary>
        static void SmartFlags(StringTableCollection collection, StringTableRequest request, LocalizationReport report)
        {
            var smartProfile = request.Format == DesignArgumentFormat.SmartString;
            foreach (var text in request.Texts.Where(t => t.Args.Length > 0))
            {
                if (report.Conflicts.Any(c => c.StartsWith(text.Key + ":", StringComparison.Ordinal))) continue;
                foreach (var table in collection.StringTables.Where(t => t != null).OrderBy(t => t.LocaleIdentifier.Code, StringComparer.Ordinal))
                {
                    var entry = table.GetEntry(text.Key);
                    if (entry == null || string.IsNullOrEmpty(entry.Value) || entry.IsSmart == smartProfile) continue;
                    report.Warnings.Add(text.Key + " (" + table.LocaleIdentifier.Code + "): " + (smartProfile
                        ? "not a Smart String, but the profile writes Smart Strings; the screen gives it the arguments by index ({0}), not by name ({" + text.Args[0] + "})"
                        : "a Smart String, but the profile writes plain {0} placeholders; the screen gives it the arguments by name ({" + text.Args[0] + "}), not by index ({0})") +
                        ". Mark it " + (smartProfile ? "Smart" : "not Smart") + " in the Localization Tables window, or write its placeholders that way");
                }
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
