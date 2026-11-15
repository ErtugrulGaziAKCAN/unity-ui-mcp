using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>
    /// Batchmode entry points for <c>-executeMethod</c> (CI, scripts): each parses its arguments from the command line, runs
    /// the <see cref="DesignUiOps"/> operation and exits Unity with its code: 0 ok, 1 failed, 2 usage (an argument is
    /// missing, unknown or given twice). The log goes to the Editor log (<c>-logFile</c>).
    /// <code>
    /// Unity -batchmode -projectPath &lt;project&gt; -executeMethod DesignUi.Editor.DesignUiBatch.Import \
    ///   -designUiProfile Assets/DesignUi/DesignUiProfile.asset -designUiExport &lt;export&gt;[:&lt;export&gt;…] [-designUiDiscardManualEdits]
    /// Unity -batchmode -projectPath &lt;project&gt; -executeMethod DesignUi.Editor.DesignUiBatch.KitSync \
    ///   -designUiProfile Assets/DesignUi/DesignUiProfile.asset -designUiKit &lt;kit folder&gt; [-designUiAddProfileViewports]
    /// </code>
    /// <c>-designUiExport</c> takes one export folder or several, separated like PATH (':' on macOS and Linux, ';' on
    /// Windows); each is imported even when an earlier one fails, and the code is 1 when any failed. Relative folders are
    /// resolved against the Unity project root. The Unity capture is not an entry here: it is the EditMode test
    /// <c>DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv</c> (the panel needs editor updates to render).
    /// </summary>
    public static class DesignUiBatch
    {
        public const string KitSyncCommand = "KitSync";
        public const string ImportCommand = "Import";

        const string Profile = "-designUiProfile";
        const string Kit = "-designUiKit";
        const string Export = "-designUiExport";
        const string Discard = "-designUiDiscardManualEdits";
        const string AddViewports = "-designUiAddProfileViewports";

        /// <summary>
        /// The environment variable a command runner sets for a kit sync that adds the kit's viewports to the profile (the MCP
        /// server's <c>addProfileViewports</c>); the same as <c>-designUiAddProfileViewports</c>.
        /// </summary>
        public const string AddProfileViewportsVariable = "DESIGN_UI_ADD_PROFILE_VIEWPORTS";
        const string Prefix = "-designUi";

        public const string Usage =
            "Usage: Unity -batchmode -projectPath <project> -executeMethod DesignUi.Editor.DesignUiBatch.<command> <options>\n" +
            "  Import   -designUiProfile <asset path> -designUiExport <dir>[<path list separator><dir>…] [-designUiDiscardManualEdits]\n" +
            "  KitSync  -designUiProfile <asset path> -designUiKit <dir> [-designUiAddProfileViewports]\n" +
            "Exit codes: 0 ok, 1 failed, 2 usage.";

        /// <summary><c>-executeMethod DesignUi.Editor.DesignUiBatch.KitSync</c>: <see cref="DesignUiOps.KitSync"/>, then exits.</summary>
        public static void KitSync() => Exit(Run(KitSyncCommand, Environment.GetCommandLineArgs()));

        /// <summary><c>-executeMethod DesignUi.Editor.DesignUiBatch.Import</c>: <see cref="DesignUiOps.Import"/> per export folder, then exits.</summary>
        public static void Import() => Exit(Run(ImportCommand, Environment.GetCommandLineArgs(), Environment.GetEnvironmentVariable(ImportDoneVariable)));

        static void Exit(OpResult r)
        {
            if (r.Code == 0) Debug.Log("Design UI: " + r.Log);
            else Debug.LogError("Design UI (exit " + r.Code + "): " + r.Log);
            EditorApplication.Exit(r.Code);
        }

        /// <summary>
        /// The whole entry without exiting: parses <paramref name="args"/> (a Unity command line; arguments that do not start
        /// with <c>-designUi</c> belong to Unity and are skipped) for <paramref name="command"/> and runs it.
        /// </summary>
        public static OpResult Run(string command, string[] args) => Run(command, args, null);

        /// <summary><see cref="Run(string, string[])"/>; an import writes <paramref name="importDone"/> (see <see cref="ImportEach"/>).</summary>
        static OpResult Run(string command, string[] args, string importDone)
        {
            try { return RunUnguarded(command, args, importDone); }
            catch (Exception e) { return OpResult.Failure(1, "Design UI " + command + " stopped: " + e.GetType().Name + ": " + e.Message); }
        }

        static OpResult RunUnguarded(string command, string[] args, string importDone)
        {
            var allowed = command == ImportCommand ? new[] { Profile, Export, Discard }
                : command == KitSyncCommand ? new[] { Profile, Kit, AddViewports }
                : null;
            if (allowed == null) return UsageError("unknown command '" + command + "' (Import or KitSync)");

            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            args = args ?? new string[0];
            for (int i = 0; i < args.Length; i++)
            {
                var a = args[i];
                if (a == null || !a.StartsWith(Prefix, StringComparison.Ordinal)) continue;
                if (a != Profile && a != Kit && a != Export && a != Discard && a != AddViewports) return UsageError("unknown option " + a);
                if (Array.IndexOf(allowed, a) < 0) return UsageError(a + " is not an option of " + command);
                if (values.ContainsKey(a)) return UsageError(a + " is given twice");
                if (a == Discard || a == AddViewports) { values[a] = "true"; continue; }
                if (i + 1 >= args.Length || args[i + 1] == null || args[i + 1].StartsWith("-", StringComparison.Ordinal)) return UsageError(a + " needs a value");
                values[a] = args[++i];
            }
            foreach (var required in allowed.Where(o => o != Discard && o != AddViewports))
                if (!values.ContainsKey(required)) return UsageError("missing " + required);

            if (command == KitSyncCommand)
                return DesignUiOps.KitSync(values[Profile], values[Kit], values.ContainsKey(AddViewports) || Environment.GetEnvironmentVariable(AddProfileViewportsVariable) == "true");
            var exports = PathList(values[Export]);
            if (exports.Count == 0) return UsageError(Export + " needs a value");
            return ImportEach(values[Profile], exports, values.ContainsKey(Discard), null, importDone);
        }

        /// <summary>The environment variable naming the import done marker a command runner checks (see <see cref="ImportEach"/>).</summary>
        public const string ImportDoneVariable = "DESIGN_UI_IMPORT_DONE";

        /// <summary>
        /// <see cref="DesignUiOps.Import"/> for each folder, in order; a failure does not stop the next. One folder answers
        /// with its own log; several prefix each log with <c>== &lt;folder&gt;</c> and end with a count of the failed ones.
        /// <paramref name="doneFile"/> (a command runner's <c>DESIGN_UI_IMPORT_DONE</c>): written last, <c>{ "imports": [ {
        /// exportDir, code, irSha } ] }</c> with the SHA-256 of each folder's screen.ir.json, so the runner knows which design
        /// this run imported.
        /// </summary>
        public static OpResult ImportEach(string profilePath, IReadOnlyList<string> exportDirs, bool discardManualEdits, Action<string, OpResult> each = null, string doneFile = null)
        {
            if (!string.IsNullOrEmpty(doneFile))
            {
                var done = new Newtonsoft.Json.Linq.JArray();
                var r = ImportEach(profilePath, exportDirs, discardManualEdits, (dir, one) =>
                {
                    var ir = Path.Combine(dir, ScreenCompiler.IrFileName);
                    string sha = null;
                    if (File.Exists(ir))
                        using (var h = System.Security.Cryptography.SHA256.Create())
                            sha = string.Concat(h.ComputeHash(File.ReadAllBytes(ir)).Select(b => b.ToString("x2")));
                    done.Add(new Newtonsoft.Json.Linq.JObject { ["exportDir"] = dir, ["code"] = one.Code, ["irSha"] = sha });
                    each?.Invoke(dir, one);
                });
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(doneFile)));
                File.WriteAllText(doneFile, new Newtonsoft.Json.Linq.JObject { ["imports"] = done }.ToString() + "\n");
                return r;
            }
            if (exportDirs == null || exportDirs.Count == 0) return OpResult.Failure(1, "No export folder.");
            if (exportDirs.Count == 1)
            {
                var one = DesignUiOps.Import(profilePath, exportDirs[0], discardManualEdits);
                each?.Invoke(exportDirs[0], one);
                return one;
            }
            var log = new StringBuilder();
            var warnings = new List<string>();
            var errors = new List<string>();
            int failed = 0;
            foreach (var dir in exportDirs)
            {
                var r = DesignUiOps.Import(profilePath, dir, discardManualEdits);
                each?.Invoke(dir, r);
                if (r.Code != 0) failed++;
                log.Append("== ").Append(dir).Append('\n').Append(r.Log).Append('\n');
                warnings.AddRange((r.Warnings ?? new string[0]).Select(w => dir + ": " + w));
                errors.AddRange((r.Errors ?? new string[0]).Select(e => dir + ": " + e));
            }
            log.Append(failed == 0 ? "All " + exportDirs.Count + " export folders imported." : failed + " of " + exportDirs.Count + " export folders failed.");
            return new OpResult(failed == 0 ? 0 : 1, log.ToString(), null, warnings, errors);
        }

        /// <summary>A PATH-style list (<see cref="Path.PathSeparator"/>): its non-empty parts, trimmed.</summary>
        public static IReadOnlyList<string> PathList(string value) =>
            string.IsNullOrEmpty(value)
                ? new string[0]
                : value.Split(Path.PathSeparator).Select(p => p.Trim()).Where(p => p.Length > 0).ToArray();

        static OpResult UsageError(string why) => OpResult.Failure(2, why, why + "\n" + Usage);
    }
}
