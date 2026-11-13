using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DesignUi.Editor
{
    /// <summary>
    /// The kit's text styles (<c>text-styles.json</c>: name to <c>{ fontSize, lineHeight, weight }</c>, spec 5.3). The
    /// compiler writes a text node's font size from the style the IR names (<c>text.style</c>), at full precision.
    /// </summary>
    public static class KitTextStyles
    {
        public const string FileName = "text-styles.json";

        /// <summary>
        /// The text-style table a compile uses: the export folder's, else the kit folder's; null when neither has one.
        /// </summary>
        public static string FindTable(string exportDir, string kitDir)
        {
            foreach (var dir in new[] { exportDir, kitDir })
                if (!string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, FileName))) return Path.Combine(dir, FileName);
            return null;
        }

        /// <summary>The line boxes of a table: one per distinct font size and line height of its styles.</summary>
        public static IReadOnlyList<FontTwinGenerator.LineBox> LineBoxesOf(string path)
        {
            var sizes = new List<(double, double)>();
            foreach (var p in Read(path))
            {
                var (s, l) = SizeAndLine(p.Value as JObject);
                if (s > 0 && l > 0) sizes.Add((s, l));
            }
            return FontTwinGenerator.LineBox.Of(sizes);
        }

        /// <summary>
        /// Style name to the key of its line-box variant (<see cref="FontTwinGenerator.LineBox"/>): its font size and line
        /// height, or null for a style without a positive size and line height.
        /// </summary>
        public static IReadOnlyDictionary<string, string> LoadLineBoxes(string path)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var p in Read(path))
            {
                var (s, l) = SizeAndLine(p.Value as JObject);
                result[p.Key] = FontTwinGenerator.LineBox.For(s, l)?.Key;
            }
            return result;
        }

        static (double size, double line) SizeAndLine(JObject style)
        {
            double Num(JToken t) => t != null && (t.Type == JTokenType.Float || t.Type == JTokenType.Integer) ? t.Value<double>() : 0;
            return (Num(style?["fontSize"]), Num(style?["lineHeight"]));
        }

        static JObject Read(string path)
        {
            try
            {
                using (var reader = new JsonTextReader(new StringReader(File.ReadAllText(path))) { FloatParseHandling = FloatParseHandling.Double })
                    return JObject.Load(reader);
            }
            catch (Exception e) when (e is IOException || e is JsonException || e is UnauthorizedAccessException)
            {
                throw new IrFormatException("cannot read text styles '" + path + "': " + e.Message, e);
            }
        }

        /// <summary>Style name to font size in px. Throws IrFormatException when the file is not a valid style table.</summary>
        public static IReadOnlyDictionary<string, double> Load(string path)
        {
            JObject obj;
            try
            {
                using (var reader = new JsonTextReader(new StringReader(File.ReadAllText(path))) { FloatParseHandling = FloatParseHandling.Double })
                    obj = JObject.Load(reader);
            }
            catch (Exception e) when (e is IOException || e is JsonException || e is UnauthorizedAccessException)
            {
                throw new IrFormatException("cannot read text styles '" + path + "': " + e.Message, e);
            }

            var result = new Dictionary<string, double>(StringComparer.Ordinal);
            foreach (var p in obj)
            {
                var size = (p.Value as JObject)?["fontSize"];
                if (size == null || (size.Type != JTokenType.Float && size.Type != JTokenType.Integer) || size.Value<double>() <= 0)
                    throw new IrFormatException("text style '" + p.Key + "' in '" + path + "' has no positive fontSize");
                result[p.Key] = size.Value<double>();
            }
            return result;
        }
    }
}
