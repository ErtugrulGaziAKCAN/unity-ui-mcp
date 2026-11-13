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

        public static CaptureApply Pseudo(string pseudo, string elementId) => new CaptureApply { Kind = PseudoKind, Name = pseudo, ElementId = elementId };
        public static CaptureApply Class(string name, string elementId) => new CaptureApply { Kind = ClassKind, Name = name, ElementId = elementId };

        public override string ToString() => Kind + " " + Name + " on " + ElementId;
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
        public string OutDir;
        public string CaptureName;
        /// <summary>Tests: called with the screen root after the capture is written, before the panel is destroyed.</summary>
        internal Action<VisualElement> Inspect;
    }

    /// <summary>One job of <c>goldens/matrix.json</c>.</summary>
    public sealed class CaptureJob
    {
        public string Name;
        public string State;
        public Vector2Int Viewport;
        public List<CaptureApply> Apply = new List<CaptureApply>();
        /// <summary>An animation sample (the animation player is not available yet, so it is not captured).</summary>
        public bool Animation;

        /// <summary>The jobs of a <c>matrix.json</c> in its order. Throws <see cref="IrFormatException"/> when it is not a capture matrix.</summary>
        public static List<CaptureJob> ReadMatrix(string matrixJsonPath)
        {
            JObject obj;
            try { obj = JObject.Parse(File.ReadAllText(matrixJsonPath)); }
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
                var vp = c["viewport"] as JArray;
                if (vp == null || vp.Count != 2 || vp.Any(v => v.Type != JTokenType.Integer || (int)v < 1))
                    throw new IrFormatException("'" + matrixJsonPath + "': capture '" + name + "' has no viewport [width, height]");
                var job = new CaptureJob
                {
                    Name = name,
                    State = (string)c["state"] ?? "default",
                    Viewport = new Vector2Int((int)vp[0], (int)vp[1]),
                    Animation = c["anim"] != null && c["anim"].Type != JTokenType.Null,
                };
                foreach (var a in (c["apply"] as JArray) ?? new JArray())
                {
                    var kind = (string)a["kind"];
                    var element = (string)a["elementId"];
                    if (kind == CaptureApply.PseudoKind) job.Apply.Add(CaptureApply.Pseudo((string)a["pseudo"], element));
                    else if (kind == CaptureApply.ClassKind) job.Apply.Add(CaptureApply.Class((string)a["name"], element));
                    else throw new IrFormatException("'" + matrixJsonPath + "': capture '" + name + "' applies an unknown kind '" + kind + "'");
                }
                jobs.Add(job);
            }
            return jobs;
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
