using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi.Editor
{
    /// <summary>One thing a capture applies to one element besides the screen state (<c>goldens/matrix.json</c>, <c>apply</c>).</summary>
    public sealed class CaptureApply
    {
        public const string PseudoKind = "pseudo";
        public const string ClassKind = "class";

        /// <summary><see cref="PseudoKind"/> or <see cref="ClassKind"/>.</summary>
        public string Kind;
        /// <summary>The pseudo-state (hover, active, focus, disabled, checked) or the class name.</summary>
        public string Name;
        public string ElementId;
        /// <summary>
        /// A class item of an animation series that takes the class off an element whose markup has it (matrix.json
        /// <c>absent</c>): the off side of a trigger the artboard starts in.
        /// </summary>
        public bool Absent;
        /// <summary>
        /// The element in a later written-out repeat item (matrix.json <c>item</c>): the item of each repeat around it,
        /// outermost first; null for the IR's own element (the first item of each). The capture finds it by the name the
        /// sample filler gives that item's copy (<see cref="ItemSuffix"/>).
        /// </summary>
        public int[] Item;

        public static CaptureApply Pseudo(string pseudo, string elementId) => new CaptureApply { Kind = PseudoKind, Name = pseudo, ElementId = elementId };
        public static CaptureApply Class(string name, string elementId) => new CaptureApply { Kind = ClassKind, Name = name, ElementId = elementId };

        /// <summary>
        /// The suffix the sample filler appends to the design names in written-out repeat items: <c>#k</c> per repeat,
        /// innermost first, for each repeat whose item is a later one or that sits inside a later item of an outer repeat
        /// (<c>day#3</c>, <c>day#0#1</c>, <c>day#3#1</c>); empty for the IR's own items.
        /// </summary>
        public static string ItemSuffix(int[] item)
        {
            if (item == null) return "";
            var sb = new System.Text.StringBuilder();
            for (int k = item.Length - 1; k >= 0; k--)
            {
                bool outerLater = false;
                for (int j = 0; j < k; j++) outerLater |= item[j] > 0;
                if (item[k] > 0 || outerLater) sb.Append('#').Append(item[k]);
            }
            return sb.ToString();
        }

        /// <summary>The name of the element this item applies to on the capture's screen.</summary>
        public string Target => ElementId + ItemSuffix(Item);

        public override string ToString() => Kind + " " + (Absent ? "without " : "") + Name + " on " + Target;
    }

    /// <summary>One Unity capture of a compiled screen.</summary>
    public sealed class CaptureRequest
    {
        /// <summary>The compiled screen folder (project path, <c>&lt;outputFolder&gt;/&lt;Screen&gt;</c>).</summary>
        public string ScreenFolder;
        /// <summary>The design's export folder: <c>screen.ir.json</c> (element ids, binds, repeats) and <c>fixtures/sample-data.json</c>.</summary>
        public string ExportDir;
        public string State = "default";
        /// <summary>Device pixels; the PNG has exactly this size.</summary>
        public Vector2Int Viewport;
        /// <summary>One pseudo-state on one element (the golden's <c>pseudo</c>); added to <see cref="Apply"/>.</summary>
        public string PseudoKind;
        public string PseudoElementId;
        /// <summary>Everything applied besides the state (the job's <c>apply</c>).</summary>
        public List<CaptureApply> Apply = new List<CaptureApply>();
        /// <summary>Keyframe animations the golden shows frozen at their end frame (<see cref="FrozenFrames"/>).</summary>
        public List<FrozenAnimation> Frozen = new List<FrozenAnimation>();
        public string OutDir;
        /// <summary>The capture's name: its key in boxes.jsonl, the meta file and the result.</summary>
        public string CaptureName;
        /// <summary>
        /// The file name of the capture's PNG without <c>.png</c> (the job's matrix.json <c>file</c>, a long name's short
        /// file); <see cref="CaptureName"/> when none is given.
        /// </summary>
        public string CaptureFile
        {
            get => string.IsNullOrEmpty(m_CaptureFile) ? CaptureName : m_CaptureFile;
            set => m_CaptureFile = value;
        }
        string m_CaptureFile;
        /// <summary>Filled by the capture: how it was made where that differs from the plain route (written to the meta file).</summary>
        public readonly List<string> Notes = new List<string>();
        /// <summary>Tests: called with the screen root after the capture is written, before the panel is destroyed.</summary>
        internal Action<VisualElement> Inspect;
    }

    /// <summary>An IR animation: <c>node(ElementId).anims[Index]</c>.</summary>
    public sealed class CaptureAnimRef
    {
        public string ElementId;
        public int Index;
        public override string ToString() => ElementId + "#" + Index;
    }

    /// <summary>A screen condition of an animation series: the state and what is applied (matrix.json <c>anim.from</c>).</summary>
    public sealed class CaptureSetup
    {
        public string State = "default";
        public List<CaptureApply> Apply = new List<CaptureApply>();
    }

    /// <summary>
    /// An animation sample (matrix.json <c>anim</c>): the screen <see cref="Time"/> ms after the change from
    /// <see cref="From"/> (null: the screen opens at time 0) to the job's state and applied set, with the animations of
    /// <see cref="Runs"/> playing and every other animation frozen as in static captures.
    /// </summary>
    public sealed class CaptureAnim
    {
        public List<CaptureAnimRef> Sampled = new List<CaptureAnimRef>();
        public List<CaptureAnimRef> Runs = new List<CaptureAnimRef>();
        public CaptureSetup From;
        public int Sample;
        public double Time;

        /// <summary>Jobs of one series share the change: the same from, state, applied set, viewport and runs.</summary>
        internal string SeriesKey(CaptureJob job) =>
            job.Viewport.x + "x" + job.Viewport.y + "|" + (From == null ? "load" : Setup(From.State, From.Apply)) + ">" + Setup(job.State, job.Apply) + "|" +
            string.Join(",", Runs.Select(r => r.ToString()));

        static string Setup(string state, IEnumerable<CaptureApply> apply) => state + string.Concat(apply.Select(a => "." + a.Kind + "." + (a.Absent ? "!" : "") + a.Name + "." + a.ElementId));
    }

    /// <summary>One job of <c>goldens/matrix.json</c>.</summary>
    public sealed class CaptureJob
    {
        public string Name;
        /// <summary>
        /// The file name of the job's PNG without <c>.png</c> (matrix.json <c>file</c>: the exporter gives a long name a
        /// short, deterministic file); <see cref="Name"/> when the matrix has none (an export from before files were recorded).
        /// The name stays the job's key in boxes.jsonl, the meta file and the result.
        /// </summary>
        public string File
        {
            get => string.IsNullOrEmpty(m_File) ? Name : m_File;
            set => m_File = value;
        }
        string m_File;
        public string State;
        public Vector2Int Viewport;
        public List<CaptureApply> Apply = new List<CaptureApply>();
        /// <summary>An animation sample (<see cref="Anim"/>).</summary>
        public bool Animation;
        /// <summary>The animation sample, or null for a static capture.</summary>
        public CaptureAnim Anim;
        /// <summary>Static captures: the keyframe animations the golden had in effect, frozen at their end frame.</summary>
        public List<FrozenAnimation> Frozen = new List<FrozenAnimation>();

        /// <summary>The jobs of a <c>matrix.json</c> in its order. Throws <see cref="IrFormatException"/> when it is not a capture matrix.</summary>
        public static List<CaptureJob> ReadMatrix(string matrixJsonPath)
        {
            JObject obj;
            try { obj = JObject.Parse(System.IO.File.ReadAllText(matrixJsonPath)); }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is JsonException)
            {
                throw new IrFormatException("cannot read the capture matrix '" + matrixJsonPath + "': " + e.Message, e);
            }
            if (!(obj["captures"] is JArray captures)) throw new IrFormatException("'" + matrixJsonPath + "' has no captures list");
            var jobs = new List<CaptureJob>();
            foreach (var c in captures)
            {
                var name = (string)c["name"];
                if (!ValidName(name)) throw new IrFormatException("'" + matrixJsonPath + "': capture name '" + name + "' is not a file name");
                var file = c["file"];
                if (file != null && file.Type != JTokenType.Null && (file.Type != JTokenType.String || !ValidName((string)file)))
                    throw new IrFormatException("'" + matrixJsonPath + "': capture '" + name + "' has a file '" + file + "' that is not a file name");
                var vp = c["viewport"] as JArray;
                if (vp == null || vp.Count != 2 || vp.Any(v => v.Type != JTokenType.Integer || (int)v < 1))
                    throw new IrFormatException("'" + matrixJsonPath + "': capture '" + name + "' has no viewport [width, height]");
                var job = new CaptureJob
                {
                    Name = name,
                    File = (string)file,
                    State = (string)c["state"] ?? "default",
                    Viewport = new Vector2Int((int)vp[0], (int)vp[1]),
                    Animation = c["anim"] != null && c["anim"].Type != JTokenType.Null,
                };
                foreach (var f in (c["frozen"] as JArray) ?? new JArray())
                {
                    if (!(f is JArray pair) || pair.Count != 2 || pair[0].Type != JTokenType.String || pair[1].Type != JTokenType.String)
                        throw new IrFormatException("'" + matrixJsonPath + "': capture '" + name + "' has a frozen entry that is not [element id, animation name]");
                    job.Frozen.Add(new FrozenAnimation { ElementId = (string)pair[0], Name = (string)pair[1] });
                }
                job.Apply = ReadApply(c["apply"] as JArray, matrixJsonPath, name);
                if (job.Animation) job.Anim = ReadAnim((JObject)c["anim"], matrixJsonPath, name);
                jobs.Add(job);
            }
            return jobs;
        }

        static List<CaptureApply> ReadApply(JArray list, string path, string name)
        {
            var apply = new List<CaptureApply>();
            foreach (var a in list ?? new JArray())
            {
                var kind = (string)a["kind"];
                var element = (string)a["elementId"];
                CaptureApply c;
                if (kind == CaptureApply.PseudoKind) c = CaptureApply.Pseudo((string)a["pseudo"], element);
                else if (kind == CaptureApply.ClassKind)
                {
                    c = CaptureApply.Class((string)a["name"], element);
                    c.Absent = a["absent"]?.Type == JTokenType.Boolean && (bool)a["absent"];
                }
                else throw new IrFormatException("'" + path + "': capture '" + name + "' applies an unknown kind '" + kind + "'");
                if (a["item"] is JArray item)
                {
                    if (item.Any(k => k.Type != JTokenType.Integer || (int)k < 0))
                        throw new IrFormatException("'" + path + "': capture '" + name + "' names repeat items that are not item numbers: " + item.ToString(Newtonsoft.Json.Formatting.None));
                    c.Item = item.Select(k => (int)k).ToArray();
                }
                apply.Add(c);
            }
            return apply;
        }

        static List<CaptureAnimRef> ReadRefs(JToken list, string path, string name, string what)
        {
            var refs = new List<CaptureAnimRef>();
            foreach (var r in (list as JArray) ?? throw new IrFormatException("'" + path + "': animation sample '" + name + "' has no " + what + " list"))
            {
                if (r["elementId"]?.Type != JTokenType.String || r["index"]?.Type != JTokenType.Integer)
                    throw new IrFormatException("'" + path + "': animation sample '" + name + "' has a " + what + " entry that is not {elementId, index}");
                refs.Add(new CaptureAnimRef { ElementId = (string)r["elementId"], Index = (int)r["index"] });
            }
            return refs;
        }

        static CaptureAnim ReadAnim(JObject anim, string path, string name)
        {
            var time = anim["time"];
            if (time == null || (time.Type != JTokenType.Integer && time.Type != JTokenType.Float) || (double)time < 0)
                throw new IrFormatException("'" + path + "': animation sample '" + name + "' has no time");
            var a = new CaptureAnim
            {
                Sampled = ReadRefs(anim["sampled"], path, name, "sampled"),
                Runs = ReadRefs(anim["runs"], path, name, "runs"),
                Sample = anim["sample"]?.Type == JTokenType.Integer ? (int)anim["sample"] : 0,
                Time = (double)time,
            };
            if (a.Sampled.Count == 0) throw new IrFormatException("'" + path + "': animation sample '" + name + "' samples no animation");
            if (anim["from"] is JObject from)
                a.From = new CaptureSetup { State = (string)from["state"] ?? "default", Apply = ReadApply(from["apply"] as JArray, path, name) };
            return a;
        }

        /// <summary>A capture name is a file name: no path separators, no "..".</summary>
        internal static bool ValidName(string name) =>
            !string.IsNullOrEmpty(name) && name.IndexOfAny(new[] { '/', '\\', '\0' }) < 0 && name.IndexOf("..", StringComparison.Ordinal) < 0;
    }

    /// <summary>A capture the run did not produce, and why.</summary>
    public sealed class NotCaptured
    {
        public string Capture;
        public string Reason;
    }

    /// <summary>What <see cref="DesignCapture.CaptureAll"/> produced.</summary>
    public sealed class CaptureResult
    {
        public readonly List<string> Captured = new List<string>();
        public readonly List<NotCaptured> NotCaptured = new List<NotCaptured>();
        /// <summary>Jobs that failed (also listed as not captured): the run is not usable for a verdict on them.</summary>
        public readonly List<string> Errors = new List<string>();
    }
}
