using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi.Editor
{
    /// <summary>
    /// Boxes of a Unity capture in the exporter's <c>boxes.json</c> schema (<c>tools/design-export/src/boxes/schema.json</c>),
    /// so the comparison reads both sides alike: one entry per IR element Unity has (compiler-removed wrappers are left
    /// out), in device pixels (panel px times the panel's scale, which the capture measures), rounded to 1e-6.
    /// <list type="bullet">
    /// <item>Box: <c>worldBound</c>; an element that is not displayed (display none on it or an ancestor) has a zero box.</item>
    /// <item><c>visible</c>: displayed, visibility visible, and neither it nor an ancestor at opacity 0.</item>
    /// <item><c>text</c>: the IR element carries text.</item>
    /// <item><c>lines</c> (docs/findings/m0.md, text lines): the caret positions
    /// <c>TextElement.selection.GetCursorPositionFromStringIndex(i)</c> of every string index, grouped by their y (the
    /// bottom of the caret's line); a line's top is its bottom minus UI Toolkit's line pitch
    /// (<c>size × faceInfo.lineHeight / pointSize</c>), its height the font's ascent plus descent and its baseline the top
    /// plus the ascent (<c>faceInfo.ascentLine × size / pointSize</c>), its x and width the smallest and largest caret x.
    /// <c>size</c> is the size the text is set at: the standard text generator rounds font sizes to whole device pixels
    /// (16.515625 px is set at 17 px at scale 1 and at 12 device px at scale 0.75), the advanced generator keeps 1/64 px.
    /// Text fields and
    /// dropdowns report no lines (the golden's form controls have none), nor does empty text or text without a font asset.</item>
    /// </list>
    /// </summary>
    public static class BoxesWriter
    {
        public const string FileName = "boxes.json";

        /// <summary>
        /// Device pixels per panel pixel of Scale With Screen Size (match width or height) as UI Toolkit resolves it
        /// (<c>PanelSettings.ResolveScale</c>, 6000.3): the linear blend <c>lerp(W/refW, H/refH, match)</c>, rounded to 1e-9.
        /// Equal to the logarithmic blend at the reference aspect only. A capture measures the panel's own scale instead.
        /// </summary>
        public static double Scale(Vector2Int viewport, Vector2Int reference, float match)
        {
            double m = (double)(decimal)match; // 0.99f reads as 0.99, the exporter's JSON number
            double w = viewport.x / (double)reference.x, h = viewport.y / (double)reference.y;
            return Clean(w + (h - w) * m, 1e9);
        }

        /// <summary>The boxes of one capture: every element of <paramref name="ir"/> found by name below <paramref name="root"/>.</summary>
        public static JObject Measure(string captureName, VisualElement root, Vector2Int viewport, double scale, IrScreen ir)
        {
            if (root == null) throw new ArgumentNullException(nameof(root));
            if (ir?.Root == null) throw new ArgumentNullException(nameof(ir));
            var nodes = new List<IrNode>();
            void Walk(IrNode n) { nodes.Add(n); foreach (var c in n.Children ?? new IrNode[0]) Walk(c); }
            Walk(ir.Root);

            var elements = new SortedDictionary<string, JObject>(StringComparer.Ordinal);
            foreach (var n in nodes)
            {
                var e = Find(root, n.Id);
                if (e != null) elements[n.Id] = Box(e, n.Text != null, scale);
            }
            var els = new JObject();
            foreach (var kv in elements) els[kv.Key] = kv.Value;
            return new JObject
            {
                ["capture"] = captureName,
                ["elements"] = els,
                ["external"] = new JArray(nodes.Where(n => n.External).Select(n => n.Id).Distinct().OrderBy(x => x, StringComparer.Ordinal)),
                ["scale"] = scale,
                ["viewport"] = new JArray(viewport.x, viewport.y),
            };
        }

        /// <summary>Measures one capture and merges it into <paramref name="boxesJsonPath"/>.</summary>
        public static void Merge(string boxesJsonPath, string captureName, VisualElement root, Vector2Int viewport, double scale, IrScreen ir) =>
            Merge(boxesJsonPath, Measure(captureName, root, viewport, scale, ir));

        /// <summary>Adds or replaces the capture (its <c>capture</c> name is the key); other captures stay. Sorted keys, \n endings.</summary>
        public static void Merge(string boxesJsonPath, JObject capture)
        {
            var name = (string)capture?["capture"];
            if (string.IsNullOrEmpty(name)) throw new ArgumentException("the capture has no name", nameof(capture));
            var all = Read(boxesJsonPath);
            all[name] = capture;
            Write(boxesJsonPath, all);
        }

        /// <summary>Removes a capture from the file (nothing happens when the file or the entry does not exist).</summary>
        public static void Remove(string boxesJsonPath, string captureName)
        {
            if (!File.Exists(boxesJsonPath)) return;
            var all = Read(boxesJsonPath);
            if (all.Remove(captureName)) Write(boxesJsonPath, all);
        }

        /// <summary>The element named <paramref name="name"/>: <paramref name="root"/> itself or its first descendant of that name.</summary>
        internal static VisualElement Find(VisualElement root, string name) => root.name == name ? root : root.Q(name);

        static JObject Read(string path)
        {
            if (!File.Exists(path)) return new JObject();
            var text = File.ReadAllText(path);
            if (string.IsNullOrWhiteSpace(text)) return new JObject();
            try { return JObject.Parse(text); }
            catch (JsonException e) { throw new InvalidDataException("'" + path + "' is not a boxes file: " + e.Message, e); }
        }

        static void Write(string path, JObject all)
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            using (var sw = new StringWriter { NewLine = "\n" })
            {
                using (var writer = new JsonTextWriter(sw) { Formatting = Formatting.Indented, Indentation = 2 })
                    Sort(all).WriteTo(writer);
                File.WriteAllText(path, sw.ToString().Replace("\r\n", "\n") + "\n", new UTF8Encoding(false));
            }
        }

        static JToken Sort(JToken t)
        {
            if (t is JObject o) return new JObject(o.Properties().OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => new JProperty(p.Name, Sort(p.Value))));
            if (t is JArray a) return new JArray(a.Select(Sort));
            return t;
        }

        static JObject Box(VisualElement e, bool text, double scale)
        {
            bool displayed = true, transparent = false;
            for (var x = e; x != null; x = x.hierarchy.parent)
            {
                if (x.resolvedStyle.display == DisplayStyle.None) displayed = false;
                if (x.resolvedStyle.opacity <= 0f) transparent = true;
            }
            var b = e.worldBound;
            if (float.IsNaN(b.x) || float.IsNaN(b.y) || float.IsNaN(b.width) || float.IsNaN(b.height)) displayed = false;
            var lines = new JArray();
            if (!displayed) return Entry(0, 0, 0, 0, false, text, lines);
            if (text) foreach (var line in Lines(e, scale)) lines.Add(line);
            var visible = e.resolvedStyle.visibility == Visibility.Visible && !transparent;
            return Entry(Dev(b.x, scale), Dev(b.y, scale), Dev(b.width, scale), Dev(b.height, scale), visible, text, lines);
        }

        static JObject Entry(double x, double y, double w, double h, bool visible, bool text, JArray lines) => new JObject
        {
            ["h"] = h, ["lines"] = lines, ["text"] = text, ["visible"] = visible, ["w"] = w, ["x"] = x, ["y"] = y,
        };

        /// <summary>The element that draws the IR element's own text, or null (form controls, no text).</summary>
        static TextElement TextOf(VisualElement e)
        {
            switch (e)
            {
                case TextField _:
                case DropdownField _:
                    return null;
                case Toggle toggle:
                    return toggle.Query<Label>().ToList().FirstOrDefault(l => !string.IsNullOrEmpty(l.text));
                case TextElement te:
                    return te;
                default:
                    return null;
            }
        }

        static IEnumerable<JObject> Lines(VisualElement e, double scale)
        {
            var te = TextOf(e);
            var text = te?.text;
            if (string.IsNullOrEmpty(text)) yield break;
            var font = te.resolvedStyle.unityFontDefinition.fontAsset;
            if (font == null || font.faceInfo.pointSize <= 0) yield break;
            // the standard text generator rounds font sizes to whole device pixels (measured: caret line pitch and label height
            // of 16.515625 px); the advanced generator keeps 1/64 px (6000.3 source; not measured here)
            double size = te.resolvedStyle.unityTextGenerator == TextGeneratorType.Advanced
                ? Math.Round(te.resolvedStyle.fontSize * scale * 64, MidpointRounding.AwayFromZero) / 64 / scale
                : Math.Round(te.resolvedStyle.fontSize * scale, MidpointRounding.AwayFromZero) / scale;
            if (size <= 0) yield break;
            double pitch = font.faceInfo.lineHeight * size / font.faceInfo.pointSize;
            double ascent = font.faceInfo.ascentLine * size / font.faceInfo.pointSize;
            double glyphs = (font.faceInfo.ascentLine - font.faceInfo.descentLine) * size / font.faceInfo.pointSize; // the schema's line height
            var selection = te.selection;
            var groups = new List<(float bottom, float minX, float maxX)>();
            for (int i = 0; i <= text.Length; i++)
            {
                var p = selection.GetCursorPositionFromStringIndex(i);
                int g = groups.Count - 1;
                if (g < 0 || Mathf.Abs(groups[g].bottom - p.y) > 0.5f) groups.Add((p.y, p.x, p.x));
                else groups[g] = (groups[g].bottom, Mathf.Min(groups[g].minX, p.x), Mathf.Max(groups[g].maxX, p.x));
            }
            // caret positions are in the element's local space (measured on 6000.3: they include its padding)
            foreach (var g in groups)
            {
                var top = te.LocalToWorld(new Vector2(g.minX, g.bottom - (float)pitch));
                var right = te.LocalToWorld(new Vector2(g.maxX, g.bottom - (float)pitch + (float)glyphs));
                var baseline = te.LocalToWorld(new Vector2(g.minX, g.bottom - (float)pitch + (float)ascent));
                yield return new JObject
                {
                    ["baseline"] = Dev(baseline.y, scale), ["h"] = Dev(right.y - top.y, scale), ["w"] = Dev(right.x - top.x, scale),
                    ["x"] = Dev(top.x, scale), ["y"] = Dev(top.y, scale),
                };
            }
        }

        static double Dev(double panelPx, double scale) => Clean(panelPx * scale, 1e6);

        /// <summary>Rounds like the exporter (JavaScript Math.round of v × unit, divided by unit), without -0.</summary>
        static double Clean(double v, double unit)
        {
            var r = Math.Floor(v * unit + 0.5) / unit;
            return r == 0 ? 0 : r;
        }
    }
}
