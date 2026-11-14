using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DesignUi.Editor
{
    /// <summary>
    /// The sample values of a design (<c>fixtures/sample-data.json</c>, spec 7), used only by verification and never by
    /// game data or saves: bind and Smart String argument names map to text, a repeat name maps to one object per item.
    /// Per item, by template element id: <c>$classes</c> the <c>is-*</c> classes that item shows, <c>$states</c> the
    /// states of its controls that are on (<c>disabled</c>, <c>checked</c>) where they differ from the template's, and
    /// <c>$hidden</c> whether the item's own markup hides the element (true) or shows it (false) where the template differs.
    /// </summary>
    public sealed class IrFixtures
    {
        public const string FileName = "sample-data.json";
        public const string ClassesKey = "$classes";
        public const string StatesKey = "$states";
        public const string HiddenKey = "$hidden";

        /// <summary>Bind and argument name to sample text.</summary>
        public readonly Dictionary<string, string> Values = new Dictionary<string, string>(StringComparer.Ordinal);
        /// <summary>Repeat name to its items, in design order.</summary>
        public readonly Dictionary<string, List<IrFixtures>> Repeats = new Dictionary<string, List<IrFixtures>>(StringComparer.Ordinal);
        /// <summary>Repeat items only: template element id to the <c>is-*</c> classes this item shows (empty when none).</summary>
        public readonly Dictionary<string, string[]> Classes = new Dictionary<string, string[]>(StringComparer.Ordinal);
        /// <summary>Repeat items only: template element id to the control states that are on in this item (disabled, checked).</summary>
        public readonly Dictionary<string, string[]> States = new Dictionary<string, string[]>(StringComparer.Ordinal);
        /// <summary>Repeat items only: template element id to whether this item's markup hides the element (true) or shows it (false).</summary>
        public readonly Dictionary<string, bool> Hidden = new Dictionary<string, bool>(StringComparer.Ordinal);

        public static IrFixtures Read(string path)
        {
            string text;
            try { text = File.ReadAllText(path); }
            catch (Exception e) { throw new IrFormatException("cannot read fixtures '" + path + "': " + e.Message, e); }
            JObject obj;
            try
            {
                using (var reader = new JsonTextReader(new StringReader(text)) { DateParseHandling = DateParseHandling.None })
                    obj = JObject.Load(reader);
            }
            catch (JsonException e) { throw new IrFormatException("fixtures '" + path + "' are not valid JSON: " + e.Message, e); }
            return Parse(obj, "");
        }

        public static IrFixtures Parse(JObject obj, string where = "")
        {
            var result = new IrFixtures();
            foreach (var p in obj.Properties())
            {
                var at = where + "/" + p.Name;
                if (p.Name == ClassesKey)
                {
                    if (!(p.Value is JObject classes)) throw new IrFormatException("fixtures " + at + " must map template ids to class lists");
                    foreach (var c in classes.Properties())
                    {
                        if (!(c.Value is JArray list) || list.Any(x => x.Type != JTokenType.String) || list.Any(x => !((string)x).StartsWith("is-", StringComparison.Ordinal)))
                            throw new IrFormatException("fixtures " + at + "/" + c.Name + " must be a list of is-* classes");
                        result.Classes[c.Name] = list.Select(x => (string)x).ToArray();
                    }
                    continue;
                }
                if (p.Name == StatesKey)
                {
                    if (!(p.Value is JObject states)) throw new IrFormatException("fixtures " + at + " must map template ids to state lists");
                    foreach (var c in states.Properties())
                    {
                        if (!(c.Value is JArray list) || list.Any(x => x.Type != JTokenType.String) || list.Any(x => (string)x != "disabled" && (string)x != "checked"))
                            throw new IrFormatException("fixtures " + at + "/" + c.Name + " must be a list of the states disabled and checked");
                        result.States[c.Name] = list.Select(x => (string)x).ToArray();
                    }
                    continue;
                }
                if (p.Name == HiddenKey)
                {
                    if (!(p.Value is JObject hidden)) throw new IrFormatException("fixtures " + at + " must map template ids to true or false");
                    foreach (var c in hidden.Properties())
                    {
                        if (c.Value.Type != JTokenType.Boolean) throw new IrFormatException("fixtures " + at + "/" + c.Name + " must be true or false");
                        result.Hidden[c.Name] = (bool)c.Value;
                    }
                    continue;
                }
                switch (p.Value.Type)
                {
                    case JTokenType.String:
                        result.Values[p.Name] = (string)p.Value;
                        break;
                    case JTokenType.Array:
                        var items = new List<IrFixtures>();
                        int i = 0;
                        foreach (var item in (JArray)p.Value)
                        {
                            if (!(item is JObject o)) throw new IrFormatException("fixtures " + at + "[" + i + "] must be an object");
                            items.Add(Parse(o, at + "[" + i + "]"));
                            i++;
                        }
                        result.Repeats[p.Name] = items;
                        break;
                    default:
                        throw new IrFormatException("fixtures " + at + " must be text or a list of repeat items");
                }
            }
            return result;
        }
    }
}
