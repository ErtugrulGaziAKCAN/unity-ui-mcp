using System;
using System.Text;
using UnityEditor;

namespace DesignUi.Editor
{
    /// <summary>Result of an operation: 0 ok, 1 failed, 2 usage or unavailable.</summary>
    public readonly struct OpResult
    {
        public readonly int Code;
        public readonly string Log;

        public OpResult(int code, string log)
        {
            Code = code;
            Log = log;
        }
    }

    /// <summary>Entry points of the import pipeline (bridge, menu, batchmode).</summary>
    public static class DesignUiOps
    {
        /// <summary>
        /// Font sync into the kit folder (<c>KitSync.Run</c>) with the profile's resolver (per-locale fonts
        /// over TMP Settings). <paramref name="profilePath"/> is the profile's asset path (Assets/…).
        /// </summary>
        public static OpResult KitSync(string profilePath, string kitDir)
        {
            var profile = string.IsNullOrEmpty(profilePath) ? null : AssetDatabase.LoadAssetAtPath<DesignUiProfile>(profilePath);
            if (profile == null) return new OpResult(1, "No DesignUiProfile at '" + profilePath + "'.");
            KitSyncResult r;
            try { r = global::DesignUi.Editor.KitSync.Run(profile, kitDir, FontMap.DefaultResolver(profile)); }
            catch (Exception e) when (e is FontSetupException || e is System.IO.IOException || e is UnauthorizedAccessException)
            {
                return new OpResult(1, "Kit sync failed: " + e.Message);
            }

            var log = new StringBuilder();
            if (r.Ok) log.Append("Kit synced into ").Append(kitDir).Append(": ").Append(r.Files.Count).Append(" files, ").Append(r.Written.Count).Append(" written.\n");
            else log.Append("Kit sync failed; nothing was written into ").Append(kitDir).Append(".\n");
            foreach (var e in r.Errors) log.Append("error: ").Append(e).Append('\n');
            foreach (var w in r.Warnings) log.Append("warning: ").Append(w).Append('\n');
            if (r.Written.Count > 0) log.Append("written: ").Append(string.Join(", ", r.Written)).Append('\n');
            if (r.Files.Count > 0) log.Append("files: ").Append(string.Join(", ", r.Files)).Append('\n');
            if (r.Twins.Count > 0) log.Append("font twins: ").Append(string.Join(", ", r.Twins)).Append('\n');
            return new OpResult(r.Ok ? 0 : 1, log.ToString().TrimEnd('\n'));
        }

        public static OpResult Import(string profilePath, string exportDir, bool discardManualEdits)
        {
            return new OpResult(2, "Not available yet: import arrives with the import pipeline.");
        }
    }
}
