using System;
using System.Globalization;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DesignUi.Editor
{
    /// <summary>
    /// The project's <c>design-ui.config.json</c> as the Design UI window shows it (the MCP server reads the same file):
    /// relative paths are resolved against the project root, like the server does. Read-only; a missing or invalid file
    /// gives empty values and the reason.
    /// </summary>
    internal sealed class DesignUiProjectConfig
    {
        public const string FileName = "design-ui.config.json";
        /// <summary>The profile path the repository's setup script writes into a new config.</summary>
        public const string DefaultProfileAsset = "Assets/DesignUi/DesignUiProfile.asset";

        public string ProjectRoot;
        /// <summary>Absolute path of the config file, whether it exists or not.</summary>
        public string Path;
        public bool Exists;
        /// <summary>Why the file could not be read; null when it was read (or does not exist).</summary>
        public string Error;
        /// <summary>Absolute <c>designRoot</c>, or null.</summary>
        public string DesignRoot;
        /// <summary>Absolute <c>kitDir</c>, or null.</summary>
        public string KitDir;
        /// <summary><c>profileAsset</c> as written (an Assets/… path), or null.</summary>
        public string ProfileAsset;
        /// <summary>Absolute <c>mcpServer</c> (the MCP server's dist/server.js, written by the setup script), or null.</summary>
        public string ServerPath;

        /// <summary>The profile the config names, else the setup script's default path.</summary>
        public string ProfilePath => string.IsNullOrEmpty(ProfileAsset) ? DefaultProfileAsset : ProfileAsset;

        public static DesignUiProjectConfig Read(string projectRoot)
        {
            var c = new DesignUiProjectConfig { ProjectRoot = projectRoot, Path = System.IO.Path.Combine(projectRoot, FileName) };
            c.Exists = File.Exists(c.Path);
            if (!c.Exists) return c;
            JObject o;
            try { o = JObject.Parse(File.ReadAllText(c.Path)); }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is JsonException)
            {
                c.Error = FileName + " cannot be read: " + e.Message;
                return c;
            }
            c.DesignRoot = c.Resolve(Str(o, "designRoot"));
            c.KitDir = c.Resolve(Str(o, "kitDir"));
            c.ProfileAsset = Str(o, "profileAsset");
            c.ServerPath = c.Resolve(Str(o, "mcpServer"));
            return c;
        }

        static string Str(JObject o, string key) =>
            o[key]?.Type == JTokenType.String && !string.IsNullOrWhiteSpace(o.Value<string>(key)) ? o.Value<string>(key) : null;

        string Resolve(string value)
        {
            if (value == null) return null;
            try { return System.IO.Path.GetFullPath(System.IO.Path.IsPathRooted(value) ? value : System.IO.Path.Combine(ProjectRoot, value)); }
            catch (Exception e) when (e is ArgumentException || e is NotSupportedException || e is PathTooLongException) { return null; }
        }

        /// <summary>A verification the MCP server recorded (<c>&lt;screen&gt;/.design-ui/last-verify.json</c>).</summary>
        internal sealed class Report
        {
            public string Screen;
            public string Verdict;
            public string Path;
            public DateTime When;
        }

        /// <summary>The newest verification under the design root, or null when there is none.</summary>
        public Report LastReport()
        {
            if (DesignRoot == null || !Directory.Exists(DesignRoot)) return null;
            Report best = null;
            foreach (var dir in Directory.GetDirectories(DesignRoot))
            {
                if (System.IO.Path.GetFileName(dir).StartsWith(".", StringComparison.Ordinal)) continue;
                var file = System.IO.Path.Combine(dir, ".design-ui", "last-verify.json");
                if (!File.Exists(file)) continue;
                try
                {
                    // dates stay strings: a parsed date token would come back in another format
                    var o = JObject.Load(new JsonTextReader(new StringReader(File.ReadAllText(file))) { DateParseHandling = DateParseHandling.None });
                    if (!DateTime.TryParse(o.Value<string>("verifiedAt"), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var when)) continue;
                    if (best != null && when <= best.When) continue;
                    best = new Report
                    {
                        Screen = o.Value<string>("screen") ?? System.IO.Path.GetFileName(dir),
                        Verdict = o.Value<string>("verdict"),
                        Path = o.Value<string>("reportPath"),
                        When = when,
                    };
                }
                catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is JsonException || e is InvalidCastException) { }
            }
            return best;
        }

        /// <summary>
        /// The export folder (holding <c>screen.ir.json</c>) of a chosen folder: the folder itself, or a screen folder's
        /// <c>.design-ui/export</c> (where the MCP server exports a screen); null with the reason when it has none.
        /// </summary>
        public static string ExportFolderOf(string chosen, out string error)
        {
            error = null;
            if (File.Exists(System.IO.Path.Combine(chosen, ScreenCompiler.IrFileName))) return chosen;
            var inner = System.IO.Path.Combine(chosen, ".design-ui", "export");
            if (File.Exists(System.IO.Path.Combine(inner, ScreenCompiler.IrFileName))) return inner;
            error = "'" + chosen + "' has no export (no " + ScreenCompiler.IrFileName + " in it or in its .design-ui/export folder). " +
                    "Export the screen first: design_ui_import in your MCP client exports and imports it.";
            return null;
        }
    }
}
