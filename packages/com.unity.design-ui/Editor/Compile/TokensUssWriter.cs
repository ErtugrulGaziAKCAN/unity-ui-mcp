using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace DesignUi.Editor
{
    /// <summary>
    /// Writes the design tokens as USS custom properties on <c>:root</c> (<c>DesignTokens.uss</c>, shared by all screens).
    /// IR token names such as <c>color.accent</c> become <c>--color-accent</c>.
    /// </summary>
    public static class TokensUssWriter
    {
        static readonly Regex Invalid = new Regex(@"[^a-z0-9-]+", RegexOptions.Compiled);

        /// <summary>USS custom property name (without the leading <c>--</c>) for a token name; idempotent.</summary>
        public static string VariableName(string token)
        {
            var name = Invalid.Replace((token ?? "").ToLowerInvariant(), "-").Trim('-');
            if (name.Length == 0) throw new IrFormatException("token '" + token + "' does not give a USS variable name");
            return name;
        }

        public static string Write(IReadOnlyDictionary<string, string> tokens)
        {
            var vars = new SortedDictionary<string, string>(StringComparer.Ordinal);
            foreach (var kv in tokens ?? new Dictionary<string, string>())
            {
                var name = VariableName(kv.Key);
                var value = (kv.Value ?? "").Trim();
                if (value.Length == 0 || value.IndexOfAny(new[] { ';', '{', '}', '\n', '\r' }) >= 0)
                    throw new IrFormatException("token '" + kv.Key + "' has a value USS cannot hold: '" + kv.Value + "'");
                if (vars.TryGetValue(name, out var existing) && existing != value)
                    throw new IrFormatException("tokens map to the same USS variable --" + name + " with different values");
                vars[name] = value;
            }
            var sb = new StringBuilder();
            sb.Append(UssWriter.Header).Append("\n\n:root {\n");
            foreach (var kv in vars) sb.Append("    --").Append(kv.Key).Append(": ").Append(kv.Value).Append(";\n");
            sb.Append("}\n");
            return sb.ToString();
        }

        internal static IEnumerable<KeyValuePair<string, string>> Normalized(IReadOnlyDictionary<string, string> tokens) =>
            (tokens ?? new Dictionary<string, string>()).Select(kv => new KeyValuePair<string, string>(VariableName(kv.Key), (kv.Value ?? "").Trim()));
    }
}
