using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using UnityEditor;

namespace DesignUi.Editor
{
    /// <summary>Result of an operation: 0 ok, 1 failed, 2 usage or unavailable.</summary>
    public readonly struct OpResult
    {
        public readonly int Code;
        public readonly string Log;
        /// <summary>
        /// Files the operation wrote because their content changed (an import's generated files and assets); may be null.
        /// Files it deleted are not listed.
        /// </summary>
        public readonly IReadOnlyList<string> Written;
        /// <summary>
        /// The operation's warnings, one entry each (the log has them too): what a client shows before the log, which can be
        /// long. Empty, not null, for a result made by a constructor.
        /// </summary>
        public readonly IReadOnlyList<string> Warnings;
        /// <summary>The operation's errors, one entry each (the log has them too); empty, not null, for a result made by a constructor.</summary>
        public readonly IReadOnlyList<string> Errors;

        public OpResult(int code, string log) : this(code, log, null) { }

        public OpResult(int code, string log, IReadOnlyList<string> written) : this(code, log, written, null, null) { }

        public OpResult(int code, string log, IReadOnlyList<string> written, IReadOnlyList<string> warnings, IReadOnlyList<string> errors)
        {
            Code = code;
            Log = log;
            Written = written;
            Warnings = warnings ?? None;
            Errors = errors ?? None;
        }

        static readonly string[] None = new string[0];

        /// <summary>A failure whose only error is <paramref name="error"/>; the log is <paramref name="log"/>, else the error.</summary>
        internal static OpResult Failure(int code, string error, string log = null) => new OpResult(code, log ?? error, null, null, new[] { error });
    }

    /// <summary>Entry points of the import pipeline (bridge, menu, batchmode).</summary>
    public static class DesignUiOps
    {
        /// <summary>The log line prefix of a generated file that was edited by hand (the import refused to overwrite it).</summary>
        internal const string ManualEditPrefix = "edited by hand: ";

        /// <summary>Whether an import failed only because generated files were edited by hand (it can be retried with discard).</summary>
        internal static bool HasManualEdits(OpResult r) => r.Code != 0 && (r.Log ?? "").Contains(ManualEditPrefix);

        /// <summary>Whether the Editor is in (or entering) Play mode; tests replace it.</summary>
        internal static Func<bool> InPlayMode = () => EditorApplication.isPlayingOrWillChangePlaymode;

        /// <summary>
        /// The refusal of an import or kit sync in Play mode: what they add to the font twins then would be taken back when Play
        /// stops (<see cref="TwinPlayGuard"/>), so the twins would lose the characters an import pre-adds.
        /// </summary>
        internal const string PlayModeError = "Exit Play mode first: an import or kit sync in Play mode would lose what it adds to the font twins (Play's changes to them are taken back when Play stops).";

        /// <summary>The refusal while Play's twin guard is still on outside Play (a Play entry that was given up; it ends on the next editor update).</summary>
        internal const string GuardError = "Font twins are still kept out of saves by the Play guard (Play mode was requested and has not ended); " +
                                           "run the import or kit sync again in a moment, once the Editor is back in Edit mode.";

        /// <summary>The refusal of an import or kit sync now, or null when it may run.</summary>
        static string PlayRefusal() => InPlayMode() ? PlayModeError : TwinPlayGuard.Active ? GuardError : null;

        /// <summary>
        /// Font sync into the kit folder (<c>KitSync.Run</c>) with the profile's resolver (<see cref="FontMap.ResolverFor"/>:
        /// its font resolver asset, else its per-locale fonts over TMP Settings). <paramref name="profilePath"/> is the profile's asset path (Assets/…); a relative
        /// <paramref name="kitDir"/> is resolved against the Unity project root, and the log says so. The result carries the
        /// sync's warnings and errors as lists too.
        /// </summary>
        public static OpResult KitSync(string profilePath, string kitDir)
        {
            if (PlayRefusal() is string refusal) return Failed(refusal);
            var profile = string.IsNullOrEmpty(profilePath) ? null : AssetDatabase.LoadAssetAtPath<DesignUiProfile>(profilePath);
            if (profile == null) return Failed("No DesignUiProfile at '" + profilePath + "'.");
            KitSyncResult r;
            try { r = global::DesignUi.Editor.KitSync.Run(profile, kitDir, FontMap.ResolverFor(profile)); }
            catch (Exception e) when (e is FontSetupException || e is System.IO.IOException || e is UnauthorizedAccessException)
            {
                return new OpResult(1, "Kit sync failed: " + e.Message, null, null, new[] { e.Message });
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
            if (r.Faces.Count > 0)
                log.Append("font faces with twins: ").Append(string.Join(", ", r.Faces))
                   .Append(r.SkippedFaces > 0 ? " (" + r.SkippedFaces + " more face" + (r.SkippedFaces == 1 ? "" : "s") + " in the weight tables: no text style or compiled screen uses them)" : "").Append('\n');
            if (r.Twins.Count > 0) log.Append("font twins: ").Append(string.Join(", ", r.Twins)).Append('\n');
            if (r.RemovedTwins.Count > 0)
                log.Append("removed ").Append(r.RemovedTwins.Count).Append(" font twin").Append(r.RemovedTwins.Count == 1 ? "" : "s")
                   .Append(" no text style, compiled screen or locale font uses: ").Append(string.Join(", ", r.RemovedTwins)).Append('\n');
            return new OpResult(r.Ok ? 0 : 1, log.ToString().TrimEnd('\n'), null, r.Warnings.ToList(), r.Errors.ToList());
        }

        /// <summary>A failed operation whose only error is <paramref name="message"/> (also its log).</summary>
        static OpResult Failed(string message) => OpResult.Failure(1, message);

        /// <summary>
        /// Compiles an export folder (<c>screen.ir.json</c>, assets, goldens) into the project with the profile
        /// (<see cref="ScreenCompiler.Compile(string, DesignUiProfile, bool)"/>): the generated files and the design assets
        /// are written and imported in one asset-editing batch. Code 0 with a log of what was written, 1 with the errors
        /// (nothing written when the design cannot be compiled or a generated file was edited by hand, unless
        /// <paramref name="discardManualEdits"/>). A relative <paramref name="exportDir"/> is resolved against the Unity
        /// project root, and the log says so. The result carries the errors (hand-edited files among them) and the warnings
        /// (String Table conflicts and warnings, translations whose fallback misses English, orphan folders and unused
        /// assets) as lists too.
        /// </summary>
        public static OpResult Import(string profilePath, string exportDir, bool discardManualEdits)
        {
            if (PlayRefusal() is string refusal) return Failed(refusal);
            var profile = string.IsNullOrEmpty(profilePath) ? null : AssetDatabase.LoadAssetAtPath<DesignUiProfile>(profilePath);
            if (profile == null) return Failed("No DesignUiProfile at '" + profilePath + "'.");
            if (string.IsNullOrEmpty(exportDir)) return Failed("No export folder.");
            var log = new StringBuilder();
            var dir = exportDir;
            if (!System.IO.Path.IsPathRooted(dir))
            {
                dir = System.IO.Path.GetFullPath(System.IO.Path.Combine(System.IO.Directory.GetCurrentDirectory(), dir));
                log.Append("note: export folder '").Append(exportDir).Append("' resolved against the project root: ").Append(dir).Append('\n');
            }
            if (!System.IO.Directory.Exists(dir))
                return new OpResult(1, log + "No export folder at '" + dir + "'.", null, null, new[] { "No export folder at '" + dir + "'." });

            CompileResult r;
            var watch = System.Diagnostics.Stopwatch.StartNew();
            try { r = ScreenCompiler.Compile(dir, profile, discardManualEdits); }
            catch (Exception e) when (e is FontSetupException || e is System.IO.IOException || e is UnauthorizedAccessException || e is IrFormatException || e is UnsupportedStyleException)
            {
                return new OpResult(1, log + "Import failed: " + e.Message, null, null, new[] { e.Message });
            }
            var ms = watch.ElapsedMilliseconds;
            if (r.Ok)
            {
                log.Append("Imported ").Append(r.Screen ?? "the screen").Append(" into ").Append(r.Folder ?? profile.outputFolder).Append(": ")
                    .Append(r.Written.Count).Append(r.Written.Count == 1 ? " file" : " files").Append(" written (").Append(ms).Append(" ms).\n");
            }
            else log.Append(r.Localization != null ? "Import failed after its String Table entries were written (listed below); no screen file was written.\n"
                : "Import failed; nothing was written for the screen.\n");
            foreach (var e in r.Errors) log.Append("error: ").Append(e).Append('\n');
            foreach (var n in r.Notes) log.Append("note: ").Append(n).Append('\n');
            if (r.Localization != null) foreach (var l in r.Localization.Lines()) log.Append(l).Append('\n');
            foreach (var m in r.ManualEdits) log.Append(ManualEditPrefix).Append(m).Append('\n');
            if (r.Written.Count > 0) log.Append("written: ").Append(string.Join(", ", r.Written)).Append('\n');
            foreach (var o in r.Orphans) log.Append("orphan screen folder (not deleted): ").Append(o).Append('\n');
            foreach (var a in r.StaleAssets) log.Append("asset no screen uses (not deleted): ").Append(a).Append('\n');
            var errors = r.Errors.Concat(r.ManualEdits.Select(m => ManualEditPrefix + m)).ToList();
            var warnings = new List<string>();
            if (r.Localization != null)
            {
                warnings.AddRange(r.Localization.Conflicts.Select(c => "localization conflict (not overwritten): " + c));
                warnings.AddRange(r.Localization.Warnings.Select(w => "localization warning: " + w));
                warnings.AddRange(r.Localization.Pending.Where(p => !p.FallsBackToEnglish)
                    .Select(p => "translation pending: " + p.Locale + " (" + p.Keys.Count + (p.Keys.Count == 1 ? " key" : " keys") + "); its fallback does not reach English: add a Fallback Locale to it"));
            }
            warnings.AddRange(r.Orphans.Select(o => "orphan screen folder (not deleted): " + o));
            warnings.AddRange(r.StaleAssets.Select(a => "asset no screen uses (not deleted): " + a));
            return new OpResult(r.Ok ? 0 : 1, log.ToString().TrimEnd('\n'), r.Written, warnings, errors);
        }
    }
}
