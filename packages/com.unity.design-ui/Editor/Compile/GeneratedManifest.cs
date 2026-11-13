using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DesignUi.Editor
{
    /// <summary>A shadow host and the element whose pseudo-states it mirrors (the view attaches a PseudoStateMirror).</summary>
    public sealed class MirrorEntry
    {
        public string element;
        public string host;
    }

    /// <summary>A repeat: container, mode, list-mode template file and item names.</summary>
    public sealed class RepeatEntry
    {
        public string name;
        public string mode;
        public string container;
        public string template;
        public string[] items = new string[0];
    }

    /// <summary>
    /// <c>.design-ui.json</c> next to a screen's generated files (spec 8): source, IR and generator identity, the hash of
    /// every generated file (the manual-edit guard and the incremental writer compare against them), and what the view
    /// must wire at runtime because UXML cannot declare it. Written with sorted keys and \n line endings.
    /// </summary>
    public sealed class GeneratedManifest
    {
        public string screen;
        public string sourceSha256;
        public string irSha256;
        public string generatorVersion;
        /// <summary>File path relative to the manifest's folder to the SHA-256 (lowercase hex) of its bytes.</summary>
        public Dictionary<string, string> files = new Dictionary<string, string>(StringComparer.Ordinal);
        public string[] removedElements = new string[0];
        /// <summary>Name of the screen root element, which carries the <c>state-*</c> and <c>bp-*</c> classes.</summary>
        public string root;
        /// <summary>Reserved name of the generated view class file (<c>&lt;Screen&gt;View.g.cs</c>), written only when its text changes.</summary>
        public string view;
        /// <summary>Elements that need a Clickable from the view so that :active applies (UXML cannot declare manipulators).</summary>
        public string[] clickable = new string[0];
        public MirrorEntry[] mirrors = new MirrorEntry[0];
        public RepeatEntry[] repeats = new RepeatEntry[0];
        /// <summary>Shared manifest only: the union of all screens' tokens (USS variable name to value).</summary>
        public Dictionary<string, string> tokens;

        /// <summary>The manifest at <paramref name="path"/>, or null when there is none. Throws InvalidDataException when it is unreadable.</summary>
        public static GeneratedManifest Load(string path)
        {
            if (!File.Exists(path)) return null;
            GeneratedManifest m;
            try { m = JsonConvert.DeserializeObject<GeneratedManifest>(File.ReadAllText(path)); }
            catch (JsonException e) { throw new InvalidDataException("generated manifest '" + path + "' is not valid: " + e.Message, e); }
            if (m == null) throw new InvalidDataException("generated manifest '" + path + "' is empty");
            m.files = m.files == null ? new Dictionary<string, string>(StringComparer.Ordinal) : new Dictionary<string, string>(m.files, StringComparer.Ordinal);
            m.removedElements = m.removedElements ?? new string[0];
            m.clickable = m.clickable ?? new string[0];
            m.mirrors = m.mirrors ?? new MirrorEntry[0];
            m.repeats = m.repeats ?? new RepeatEntry[0];
            return m;
        }

        public void Save(string path) => File.WriteAllText(path, ToJson(), new UTF8Encoding(false));

        /// <summary>The manifest text: sorted keys, two-space indentation, \n line endings, null fields left out.</summary>
        public string ToJson()
        {
            var serializer = JsonSerializer.Create(new JsonSerializerSettings { NullValueHandling = NullValueHandling.Ignore });
            var token = Sort(JToken.FromObject(this, serializer));
            using (var sw = new StringWriter { NewLine = "\n" })
            {
                using (var writer = new JsonTextWriter(sw) { Formatting = Formatting.Indented, Indentation = 2 })
                    token.WriteTo(writer);
                return sw.ToString().Replace("\r\n", "\n") + "\n";
            }
        }

        static JToken Sort(JToken t)
        {
            if (t is JObject o)
                return new JObject(o.Properties().OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => new JProperty(p.Name, Sort(p.Value))));
            if (t is JArray a) return new JArray(a.Select(Sort));
            return t;
        }

        /// <summary>
        /// Generated files under <paramref name="outDir"/> whose bytes no longer match their recorded hash, i.e. that were
        /// edited by hand. A missing file is not an edit (it is written again). Paths are <c>outDir/relative</c>.
        /// </summary>
        public IReadOnlyList<string> FindManualEdits(string outDir)
        {
            var result = new List<string>();
            foreach (var kv in files.OrderBy(k => k.Key, StringComparer.Ordinal))
            {
                var path = Combine(outDir, kv.Key);
                if (File.Exists(path) && !string.Equals(Sha256Hex(File.ReadAllBytes(path)), kv.Value, StringComparison.OrdinalIgnoreCase))
                    result.Add(path);
            }
            return result;
        }

        internal static string Combine(string dir, string relative) => dir.TrimEnd('/', '\\') + "/" + relative;

        public static string Sha256Hex(byte[] bytes)
        {
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(bytes);
                var sb = new StringBuilder(hash.Length * 2);
                foreach (var b in hash) sb.Append(b.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }
    }
}
