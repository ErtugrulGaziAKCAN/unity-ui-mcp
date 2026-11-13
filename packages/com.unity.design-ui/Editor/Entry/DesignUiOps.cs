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
        /// over TMP Settings). <paramref name="profilePath"/> is the profile's asset path (Assets/…); a relative
        /// <paramref name="kitDir"/> is resolved against the Unity project root, and the log says so.
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
            var dir = r.KitDir ?? kitDir;
            if (r.Ok) log.Append("Kit synced into ").Append(dir).Append(": ").Append(r.Files.Count).Append(" files, ").Append(r.Written.Count).Append(" written.\n");
            else if (r.Written.Count == 0 && r.Twins.Count == 0) log.Append("Kit sync failed; nothing was written into ").Append(dir).Append(" and no font twin was changed.\n");
            else log.Append("Kit sync failed while writing into ").Append(dir).Append(".\n");
            foreach (var n in r.Notes) log.Append("note: ").Append(n).Append('\n');
            foreach (var e in r.Errors) log.Append("error: ").Append(e).Append('\n');
            foreach (var w in r.Warnings) log.Append("warning: ").Append(w).Append('\n');
            if (r.Written.Count > 0) log.Append("written: ").Append(string.Join(", ", r.Written)).Append('\n');
            if (r.Files.Count > 0) log.Append("files: ").Append(string.Join(", ", r.Files)).Append('\n');
            if (r.Twins.Count > 0) log.Append("font twins: ").Append(string.Join(", ", r.Twins)).Append('\n');
            return new OpResult(r.Ok ? 0 : 1, log.ToString().TrimEnd('\n'));
        }

        /// <summary>
        /// Compiles an export folder (<c>screen.ir.json</c>, assets, goldens) into the project with the profile
        /// (<see cref="ScreenCompiler.Compile(string, DesignUiProfile, bool)"/>): the generated files and the design assets
        /// are written and imported in one asset-editing batch. Code 0 with a log of what was written, 1 with the errors
        /// (nothing written when the design cannot be compiled or a generated file was edited by hand, unless
        /// <paramref name="discardManualEdits"/>). A relative <paramref name="exportDir"/> is resolved against the Unity
        /// project root, and the log says so.
        /// </summary>
        public static OpResult Import(string profilePath, string exportDir, bool discardManualEdits)
        {
            var profile = string.IsNullOrEmpty(profilePath) ? null : AssetDatabase.LoadAssetAtPath<DesignUiProfile>(profilePath);
            if (profile == null) return new OpResult(1, "No DesignUiProfile at '" + profilePath + "'.");
            if (string.IsNullOrEmpty(exportDir)) return new OpResult(1, "No export folder.");
            var log = new StringBuilder();
            var dir = exportDir;
            if (!System.IO.Path.IsPathRooted(dir))
            {
                dir = System.IO.Path.GetFullPath(System.IO.Path.Combine(System.IO.Directory.GetCurrentDirectory(), dir));
                log.Append("note: export folder '").Append(exportDir).Append("' resolved against the project root: ").Append(dir).Append('\n');
            }
            if (!System.IO.Directory.Exists(dir)) return new OpResult(1, log + "No export folder at '" + dir + "'.");

            CompileResult r;
            var watch = System.Diagnostics.Stopwatch.StartNew();
            try { r = ScreenCompiler.Compile(dir, profile, discardManualEdits); }
            catch (Exception e) when (e is FontSetupException || e is System.IO.IOException || e is UnauthorizedAccessException || e is IrFormatException || e is UnsupportedStyleException)
            {
                return new OpResult(1, log + "Import failed: " + e.Message);
            }
            var ms = watch.ElapsedMilliseconds;
            if (r.Ok)
            {
                log.Append("Imported ").Append(r.Screen ?? "the screen").Append(" into ").Append(r.Folder ?? profile.outputFolder).Append(": ")
                    .Append(r.Written.Count).Append(r.Written.Count == 1 ? " file" : " files").Append(" written (").Append(ms).Append(" ms).\n");
            }
            else log.Append("Import failed; nothing was written for the screen.\n");
            foreach (var e in r.Errors) log.Append("error: ").Append(e).Append('\n');
            foreach (var n in r.Notes) log.Append("note: ").Append(n).Append('\n');
            foreach (var m in r.ManualEdits) log.Append("edited by hand: ").Append(m).Append('\n');
            if (r.Written.Count > 0) log.Append("written: ").Append(string.Join(", ", r.Written)).Append('\n');
            foreach (var o in r.Orphans) log.Append("orphan screen folder (not deleted): ").Append(o).Append('\n');
            foreach (var a in r.StaleAssets) log.Append("asset no screen uses (not deleted): ").Append(a).Append('\n');
            return new OpResult(r.Ok ? 0 : 1, log.ToString().TrimEnd('\n'));
        }
    }
}
