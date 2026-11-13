using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace DesignUi.Editor
{
    public sealed class IrFormatException : Exception
    {
        public IrFormatException(string message) : base(message) { }
        public IrFormatException(string message, Exception inner) : base(message, inner) { }
    }

    public static class IrReader
    {
        public const int SupportedVersion = 1;

        public static IrScreen Read(string path)
        {
            string text;
            try { text = File.ReadAllText(path); }
            catch (Exception e) { throw new IrFormatException("cannot read IR file '" + path + "': " + e.Message, e); }

            JObject obj;
            try
            {
                using (var reader = new JsonTextReader(new StringReader(text)) { DateParseHandling = DateParseHandling.None })
                    obj = JObject.Load(reader);
            }
            catch (JsonException e) { throw new IrFormatException("IR file is not valid JSON: " + e.Message, e); }

            var version = obj["irVersion"];
            if (version == null || version.Type != JTokenType.Integer || version.Value<int>() != SupportedVersion)
                throw new IrFormatException("irVersion " + (version == null ? "missing" : version.ToString()) +
                                            " is not supported (expected " + SupportedVersion + ")");

            IrScreen screen;
            try { screen = obj.ToObject<IrScreen>(JsonSerializer.Create(new JsonSerializerSettings { DateParseHandling = DateParseHandling.None })); }
            catch (JsonException e) { throw new IrFormatException("IR file does not match the IR schema: " + e.Message, e); }

            if (screen == null || screen.Root == null)
                throw new IrFormatException("IR file has no root node");
            Validate(screen.Root);
            return screen;
        }

        static readonly HashSet<string> AttrTextNames = new HashSet<string> { "placeholder", "title", "alt", "aria-label" };
        static readonly HashSet<string> Directions = new HashSet<string> { "normal", "reverse", "alternate", "alternate-reverse" };
        static readonly HashSet<string> FillModes = new HashSet<string> { "none", "forwards", "backwards", "both" };

        /// <summary>
        /// Checks what the JSON types cannot: canonical layer keys and animation triggers (spec 7 grammar), attribute text
        /// names, untinted shadows and the per-kind animation fields. Missing collections become empty.
        /// </summary>
        static void Validate(IrNode node)
        {
            if (string.IsNullOrEmpty(node.Id)) throw new IrFormatException("a node has no id");
            node.Classes = node.Classes ?? new string[0];
            node.Style = node.Style ?? new Dictionary<string, Dictionary<string, string>>();
            node.AttrTexts = node.AttrTexts ?? new Dictionary<string, IrText>();
            node.Anims = node.Anims ?? new List<IrAnim>();
            node.Children = node.Children ?? new IrNode[0];
            foreach (var key in node.Style.Keys)
                if (!LayerKey.IsCanonical(key, out var canonical))
                    throw new IrFormatException("style layer '" + key + "' of node '" + node.Id + "' is not in canonical order (expected '" + canonical + "')");
            foreach (var name in node.AttrTexts.Keys)
                if (!AttrTextNames.Contains(name))
                    throw new IrFormatException("node '" + node.Id + "' has an unknown attribute text '" + name + "' (placeholder, title, alt or aria-label)");
            if (node.Shadow != null && node.Shadow.Tint) throw new IrFormatException("the shadow of node '" + node.Id + "' is tinted; shadows never are");
            foreach (var anim in node.Anims) ValidateAnim(anim, node.Id);
            foreach (var child in node.Children) Validate(child);
        }

        static void ValidateAnim(IrAnim a, string id)
        {
            string Where() => "animation " + (a.Name ?? a.Kind ?? "?") + " of node '" + id + "'";
            void Require(bool ok, string what)
            {
                if (!ok) throw new IrFormatException(Where() + ": " + what);
            }

            Require(a.Kind == IrAnim.Transition || a.Kind == IrAnim.KeyframesKind, "kind must be transition or keyframes, not '" + a.Kind + "'");
            Require(a.Trigger != null, "no trigger");
            Require(a.Trigger != LayerKey.BaseText, "the trigger of the base layer is written 'show', not 'base'");
            if (a.Trigger != LayerKey.ShowTrigger)
            {
                LayerKey.IsCanonical(a.Trigger, out var canonical);
                Require(canonical == a.Trigger, "trigger '" + a.Trigger + "' is not in canonical order (expected '" + canonical + "')");
            }
            Require(a.Phase == "enter" || a.Phase == "leave", "phase must be enter or leave, not '" + a.Phase + "'");
            Require(a.Properties != null && a.Properties.Length > 0 && a.Properties.All(p => !string.IsNullOrEmpty(p)), "no properties");
            Require(a.Duration >= 0 && !float.IsInfinity(a.Duration), "duration must be a finite number of ms >= 0");
            Require(!float.IsNaN(a.Delay) && !float.IsInfinity(a.Delay), "delay must be a finite number of ms");
            Require(!string.IsNullOrEmpty(a.Timing), "no timing function");
            Require(a.Iterations >= 0, "iterations must be >= 0 or infinite");
            Require(Directions.Contains(a.Direction ?? ""), "direction '" + a.Direction + "' is not normal, reverse, alternate or alternate-reverse");
            Require(FillModes.Contains(a.FillMode ?? ""), "fill mode '" + a.FillMode + "' is not none, forwards, backwards or both");
            Require(a.PlayState == "running" || a.PlayState == "paused", "play state must be running or paused, not '" + a.PlayState + "'");
            a.Keyframes = a.Keyframes ?? new List<IrKeyframe>();
            if (a.Kind == IrAnim.Transition)
            {
                Require(a.Name == null, "a transition has no name");
                Require(a.Iterations == 1, "a transition runs once");
                Require(a.Direction == "normal" && a.FillMode == "none" && a.PlayState == "running", "a transition has direction normal, fill mode none and play state running");
                Require(a.Restart, "a transition always restarts");
                Require(a.Keyframes.Count == 0, "a transition has no keyframes");
            }
            else
            {
                Require(!string.IsNullOrEmpty(a.Name), "a keyframe animation has a name");
                Require(a.Phase == "enter", "a keyframe animation runs on enter");
                Require(a.Keyframes.Count > 0, "a keyframe animation has keyframes");
                foreach (var k in a.Keyframes)
                {
                    Require(k.Offset >= 0 && k.Offset <= 1, "keyframe offset " + k.Offset.ToString(CultureInfo.InvariantCulture) + " is outside 0..1");
                    k.Values = k.Values ?? new Dictionary<string, string>();
                }
            }
        }
    }
}
