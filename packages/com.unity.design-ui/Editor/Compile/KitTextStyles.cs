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
