using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DesignUi.Editor
{
    public enum CssHandling { Direct, Lowered, Dropped, Error }

    public sealed class CssPropertySpec
    {
        public string Name;
        public CssHandling Handling;
        public string[] Keywords = new string[0];
        public string[] Types = new string[0];
        public string[] Functions = new string[0];
        public string[] DropValues = new string[0];
        public Dictionary<string, string> MapValues = new Dictionary<string, string>();
        public int MinComponents = 1;
        public int MaxComponents = 1;
        public bool List;
        public string Rule;
        public string Fix;
    }

    /// <summary>
    /// The single source of CSS support (Editor/Data/css-support.json): which properties the pipeline handles, how,
    /// and which values are valid. The exporter's lint reads the same file.
    /// </summary>
    public sealed class CssSupport
    {
        public const string RelativePath = "Editor/Data/css-support.json";
        public const string UnknownPropertyRule = "U-CSS-023";
        public const string UnknownFunctionRule = "U-CSS-024";

        static CssSupport _default;
        public static CssSupport Default => _default ?? (_default = Load(DefaultPath()));

        public readonly string[] Units;
        public readonly string[] ColorFunctions;
        public readonly string[] ColorKeywords;
        readonly Dictionary<string, CssPropertySpec> _props = new Dictionary<string, CssPropertySpec>(StringComparer.Ordinal);

        public IEnumerable<CssPropertySpec> Properties => _props.Values;
        public bool TryGet(string property, out CssPropertySpec spec) => _props.TryGetValue(property, out spec);

        static string DefaultPath()
        {
            var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(CssSupport).Assembly);
            if (info == null) throw new InvalidOperationException("css-support.json: the DesignUi.Editor assembly is not in a package");
            return Path.Combine(info.resolvedPath, RelativePath);
        }

        public static CssSupport Load(string path)
        {
            var obj = JObject.Parse(File.ReadAllText(path));
            return new CssSupport(obj);
        }

        CssSupport(JObject o)
        {
            Units = Strings(o["units"]);
            var colors = (JObject)o["colors"];
            ColorFunctions = Strings(colors["functions"]);
            ColorKeywords = Strings(colors["keywords"]);
            foreach (var p in (JObject)o["properties"])
            {
                var v = (JObject)p.Value;
                var spec = new CssPropertySpec
                {
                    Name = p.Key,
                    Handling = (CssHandling)Enum.Parse(typeof(CssHandling), (string)v["handling"], true),
                    Keywords = Strings(v["keywords"]),
                    Types = Strings(v["types"]),
                    Functions = Strings(v["functions"]),
                    DropValues = Strings(v["dropValues"]),
                    List = v["list"] != null && (bool)v["list"],
                    Rule = (string)v["rule"],
                    Fix = (string)v["fix"],
                };
                if (v["components"] is JArray c) { spec.MinComponents = (int)c[0]; spec.MaxComponents = (int)c[1]; }
                if (v["mapValues"] is JObject m) foreach (var kv in m) spec.MapValues[kv.Key] = (string)kv.Value;
                _props[p.Key] = spec;
            }
        }

        static string[] Strings(JToken t) => t is JArray a ? a.Select(x => (string)x).ToArray() : new string[0];

        // ---- value validation ------------------------------------------------------------------------------

        static readonly Regex Num = new Regex(@"^-?(\d+\.?\d*|\.\d+)$", RegexOptions.Compiled);
        static readonly Regex Length = new Regex(@"^(-?(\d+\.?\d*|\.\d+)px|0)$", RegexOptions.Compiled);
        static readonly Regex Percent = new Regex(@"^-?(\d+\.?\d*|\.\d+)%$", RegexOptions.Compiled);
        static readonly Regex Angle = new Regex(@"^-?(\d+\.?\d*|\.\d+)(deg|rad|grad|turn)$", RegexOptions.Compiled);
        static readonly Regex Time = new Regex(@"^-?(\d+\.?\d*|\.\d+)(s|ms)$", RegexOptions.Compiled);
        static readonly Regex Ident = new Regex(@"^-?[a-zA-Z][a-zA-Z0-9-]*$", RegexOptions.Compiled);
        static readonly Regex Str = new Regex(@"^(""[^""]*""|'[^']*')$", RegexOptions.Compiled);
        static readonly Regex Ratio = new Regex(@"^(\d+\.?\d*|\.\d+)(\s*/\s*(\d+\.?\d*|\.\d+))?$", RegexOptions.Compiled);
        static readonly Regex Hex = new Regex(@"^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", RegexOptions.Compiled);
        static readonly Regex RgbArgs = new Regex(@"^\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)$", RegexOptions.Compiled);

        /// <summary>Throws UnsupportedStyleException when the value is not valid for the property.</summary>
        public void ValidateValue(CssPropertySpec spec, string value)
        {
            var v = (value ?? "").Trim();
            if (v.Length == 0) throw new UnsupportedStyleException(spec.Name, value);
            var items = SplitTop(v, ',');
            if (!spec.List && items.Count > 1) throw new UnsupportedStyleException(spec.Name, value);
            foreach (var item in items)
            {
                var part = item.Trim();
                if (part.Length == 0) throw new UnsupportedStyleException(spec.Name, value);
                if (Array.IndexOf(spec.Keywords, part) >= 0 || spec.MapValues.ContainsKey(part)) continue;
                if (Array.IndexOf(spec.Types, "ratio") >= 0 && Ratio.IsMatch(part)) continue;
                var comps = SplitTop(part, ' ');
                if (comps.Count < spec.MinComponents || comps.Count > spec.MaxComponents)
                    throw new UnsupportedStyleException(spec.Name, value);
                foreach (var comp in comps)
                    if (!ComponentOk(spec, comp, value)) throw new UnsupportedStyleException(spec.Name, value);
            }
        }

        bool ComponentOk(CssPropertySpec spec, string comp, string whole)
        {
            if (Array.IndexOf(spec.Keywords, comp) >= 0) return true;
            int paren = comp.IndexOf('(');
            if (paren >= 0)
            {
                var fn = comp.Substring(0, paren).ToLowerInvariant();
                if (Array.IndexOf(spec.Types, "color") >= 0 && Array.IndexOf(ColorFunctions, fn) >= 0 &&
                    comp.EndsWith(")", StringComparison.Ordinal) && RgbArgs.IsMatch(comp.Substring(paren)))
                    return true;
                if (Array.IndexOf(spec.Functions, fn) >= 0) return true;
                throw new UnsupportedStyleException(spec.Name, whole, UnknownFunctionRule,
                    "Value function '" + fn + "' is not supported; resolve it to a plain px, % or colour value.");
            }
            foreach (var type in spec.Types)
            {
                switch (type)
                {
                    case "length": if (Length.IsMatch(comp)) return true; break;
                    case "percent": if (Percent.IsMatch(comp)) return true; break;
                    case "number": if (Num.IsMatch(comp)) return true; break;
                    case "angle": if (Angle.IsMatch(comp)) return true; break;
                    case "time": if (Time.IsMatch(comp)) return true; break;
                    case "ident": if (Ident.IsMatch(comp)) return true; break;
                    case "string": if (Str.IsMatch(comp)) return true; break;
                    case "color":
                        if (Hex.IsMatch(comp) || Array.IndexOf(ColorKeywords, comp.ToLowerInvariant()) >= 0) return true;
                        break;
                }
            }
            return false;
        }

        /// <summary>Splits at top-level separators (outside parentheses and quotes).</summary>
        public static List<string> SplitTop(string s, char sep)
        {
            var result = new List<string>();
            int depth = 0; char quote = '\0'; int start = 0;
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (quote != '\0') { if (c == quote) quote = '\0'; continue; }
                if (c == '"' || c == '\'') { quote = c; continue; }
                if (c == '(') depth++;
                else if (c == ')') depth--;
                else if (depth == 0 && (sep == ' ' ? char.IsWhiteSpace(c) : c == sep))
                {
                    if (sep != ' ' || i > start) result.Add(s.Substring(start, i - start));
                    start = i + 1;
                }
            }
            if (sep != ' ' || start < s.Length) result.Add(s.Substring(start));
            return result.Where(x => sep != ' ' || x.Length > 0).ToList();
        }
    }
}
