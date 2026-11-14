using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>
    /// Imports generated screens again after the design-ui package changed. UI Toolkit resolves a UXML file's element types
    /// when it imports the file: a screen imported while the package lacked a type it uses (generated files that arrive
    /// before the package update that defines <c>DesignLocalizedString</c>) stays broken in the Library ("Uxml object has an
    /// invalid child element", its labels empty), and a package update does not make Unity import it again.
    /// <para>Each generated screen folder is recorded with the package stamp (<see cref="PackageStamp"/>) its UXML and USS were
    /// imported under (<c>Library/DesignUi/generated-imports.json</c>, outside the project's files). After a script reload, a
    /// folder of a profile's output folder recorded under another stamp, or not at all, has its style sheets and UXML files
    /// imported again: asset by asset in one asset-editing batch (Unity orders the imports inside it), without a refresh or a
    /// save. That error, logged by any UXML import (the message does not name the file), makes every generated screen
    /// import again after the next script reload.</para>
    /// </summary>
    [InitializeOnLoad]
    public static class GeneratedScreenRefresh
    {
        /// <summary>The message UI Toolkit logs for a UXML element whose type it does not know at import.</summary>
        public const string InvalidChildMessage = "Uxml object has an invalid child element";

        const string PendingKey = "DesignUi.GeneratedScreenRefresh.Pending";

        /// <summary>The record of the stamp each screen folder was imported under (tests point it elsewhere).</summary>
        internal static string RecordPath = "Library/DesignUi/generated-imports.json";

        static string s_Stamp;
        static bool s_StampKnown, s_Refreshing;

        static GeneratedScreenRefresh()
        {
            Application.logMessageReceived += OnLog;
            EditorApplication.delayCall += RefreshProfiles;
        }

        /// <summary>This package's stamp, computed once per script reload (a package change reloads the scripts).</summary>
        internal static string Stamp
        {
            get
            {
                if (!s_StampKnown)
                {
                    s_Stamp = PackageStamp.Current;
                    s_StampKnown = true;
                }
                return s_Stamp;
            }
        }

        static void OnLog(string message, string stack, LogType type)
        {
            if (!s_Refreshing && message != null && message.IndexOf(InvalidChildMessage, StringComparison.Ordinal) >= 0) SessionState.SetBool(PendingKey, true);
        }

        /// <summary>Whether an import logged <see cref="InvalidChildMessage"/> since the last refresh.</summary>
        internal static bool Pending => SessionState.GetBool(PendingKey, false);

        static void RefreshProfiles()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            try
            {
                var again = Refresh(Stamp, OutputFolders(), Pending);
                if (again.Count > 0)
                    Debug.Log("Design UI: imported " + again.Count + " generated screen folder" + (again.Count == 1 ? "" : "s") + " again for the installed design-ui package (" +
                              string.Join(", ", again) + ")");
            }
            catch (Exception e)
            {
                Debug.LogWarning("Design UI: could not check the generated screens against the installed package: " + e.Message);
            }
        }

        /// <summary>The output folders of the project's DesignUiProfile assets.</summary>
        internal static IEnumerable<string> OutputFolders() =>
            AssetDatabase.FindAssets("t:" + nameof(DesignUiProfile))
                .Select(g => AssetDatabase.LoadAssetAtPath<DesignUiProfile>(AssetDatabase.GUIDToAssetPath(g)))
                .Where(p => p != null && !string.IsNullOrEmpty(p.outputFolder))
                .Select(p => Normalize(p.outputFolder))
                .Distinct(StringComparer.Ordinal)
                .ToList();

        static string Normalize(string folder) => folder.Replace('\\', '/').TrimEnd('/');

        /// <summary>The generated screen folders of an output folder (those holding a generated manifest), sorted.</summary>
        internal static List<string> ScreenFolders(string outFolder) =>
            Directory.Exists(outFolder)
                ? Directory.GetDirectories(outFolder).Select(Normalize).Where(d => File.Exists(d + "/" + ScreenCompiler.ManifestFileName))
                    .OrderBy(d => d, StringComparer.Ordinal).ToList()
                : new List<string>();

        /// <summary>The screen folder <paramref name="assetPath"/> belongs to, or null.</summary>
        static string ScreenFolderOf(string assetPath)
        {
            var dir = Path.GetDirectoryName(assetPath)?.Replace('\\', '/');
            return dir != null && File.Exists(dir + "/" + ScreenCompiler.ManifestFileName) ? dir : null;
        }

        internal static Dictionary<string, string> ReadRecord()
        {
            try
            {
                if (File.Exists(RecordPath))
                    return JsonConvert.DeserializeObject<Dictionary<string, string>>(File.ReadAllText(RecordPath)) ?? new Dictionary<string, string>();
            }
            catch (Exception e) when (e is IOException || e is JsonException) { }
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }

        static void WriteRecord(Dictionary<string, string> record)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(RecordPath));
            var sorted = new SortedDictionary<string, string>(record, StringComparer.Ordinal);
            File.WriteAllText(RecordPath, JsonConvert.SerializeObject(sorted, Formatting.Indented).Replace("\r\n", "\n") + "\n");
        }

        /// <summary>
        /// Imports again the screens of <paramref name="outputFolders"/> recorded under another stamp than <paramref name="stamp"/>
        /// (or not at all; every screen with <paramref name="all"/>) and records them under it. Returns the screen folders
        /// imported again. A null stamp (the package is unknown) imports nothing.
        /// </summary>
        public static IReadOnlyList<string> Refresh(string stamp, IEnumerable<string> outputFolders, bool all = false)
        {
            SessionState.EraseBool(PendingKey);
            var again = new List<string>();
            if (stamp == null) return again;
            var record = ReadRecord();
            var paths = new List<string>();
            foreach (var outFolder in (outputFolders ?? Enumerable.Empty<string>()).Select(Normalize))
            {
                var stale = ScreenFolders(outFolder).Where(d => all || !record.TryGetValue(d, out var s) || s != stamp).ToList();
                if (stale.Count == 0) continue;
                // the shared sheets (tokens, fonts) before the screen sheets that import them; item templates before the
                // screen UXML that declares them
                paths.AddRange(Directory.GetFiles(outFolder, "*.uss").Select(Normalize).OrderBy(p => p, StringComparer.Ordinal));
                foreach (var folder in stale)
                {
                    var files = Directory.GetFiles(folder).Select(Normalize).ToList();
                    var screenUxml = folder + "/" + Path.GetFileName(folder) + ".uxml";
                    paths.AddRange(files.Where(p => p.EndsWith(".uss", StringComparison.Ordinal)).OrderBy(p => p, StringComparer.Ordinal));
                    paths.AddRange(files.Where(p => p.EndsWith(".uxml", StringComparison.Ordinal) && p != screenUxml).OrderBy(p => p, StringComparer.Ordinal));
                    if (files.Contains(screenUxml)) paths.Add(screenUxml);
                    again.Add(folder);
                }
            }
            if (again.Count == 0) return again;
            s_Refreshing = true;
            AssetDatabase.StartAssetEditing();
            try
            {
                foreach (var p in paths.Distinct(StringComparer.Ordinal)) AssetDatabase.ImportAsset(p, ImportAssetOptions.ForceUpdate);
            }
            finally
            {
                AssetDatabase.StopAssetEditing();
                s_Refreshing = false;
            }
            record = ReadRecord(); // the imports recorded themselves
            foreach (var folder in again) record[folder] = stamp;
            WriteRecord(record);
            return again;
        }

        /// <summary>Records each generated screen folder whose UXML or USS was imported, under the current stamp.</summary>
        sealed class Imports : AssetPostprocessor
        {
            static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
            {
                Dictionary<string, string> record = null;
                foreach (var path in imported)
                {
                    if (!path.EndsWith(".uxml", StringComparison.OrdinalIgnoreCase) && !path.EndsWith(".uss", StringComparison.OrdinalIgnoreCase)) continue;
                    var folder = ScreenFolderOf(path);
                    if (folder == null) continue;
                    var stamp = Stamp;
                    if (stamp == null) return;
                    record = record ?? ReadRecord();
                    record[folder] = stamp;
                }
                if (record != null) WriteRecord(record);
            }
        }
    }
}
