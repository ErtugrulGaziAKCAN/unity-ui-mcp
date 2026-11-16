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
            if (version == null || version.Type != JTokenType.Integer)
                throw new IrFormatException("irVersion " + (version == null ? "missing" : version.ToString()) + " is not supported (expected " + SupportedVersion + ")");
            // the IR version is the schema's major version: another one is another format, never read field by field
            int major = version.Value<int>();
            if (major > SupportedVersion)
                throw new IrFormatException("the export is IR version " + major + ", made by a newer design-export; this com.ertugrulgaziakcan.design-ui " +
                                            "package reads IR version " + SupportedVersion + ": update the package to the version of the MCP server " +
                                            "(scripts/setup.sh of the unity-ui-mcp clone), then import again");
            if (major != SupportedVersion)
                throw new IrFormatException("the export is IR version " + major + ", made by an older design-export; this com.ertugrulgaziakcan.design-ui " +
                                            "package reads IR version " + SupportedVersion + ": export the design again with the current MCP server");

            // an earlier exporter wrote the design's text under "tr": read field by field, every text would compile empty
            if (HasOldTextField(obj))
                throw new IrFormatException("the export was made by an earlier design-export: its texts are under \"tr\", where this " +
                                            "com.ertugrulgaziakcan.design-ui package reads \"ref\"; export the design again with the current MCP " +
                                            "server (design_ui_import exports it again by itself), then import it");

            IrScreen screen;
            try { screen = obj.ToObject<IrScreen>(JsonSerializer.Create(new JsonSerializerSettings { DateParseHandling = DateParseHandling.None })); }
            catch (JsonException e) { throw new IrFormatException("IR file does not match the IR schema: " + e.Message, e); }

            if (screen == null || screen.Root == null)
                throw new IrFormatException("IR file has no root node");
            Validate(screen.Root);
            return screen;
        }

        /// <summary>Whether a text object anywhere in the IR (a key, English text and args) has the field "tr" and no "ref".</summary>
        static bool HasOldTextField(JToken token)
        {
            if (token is JObject o)
            {
                if (o.Property("tr") != null && o.Property("ref") == null && o.Property("en") != null && o.Property("args") != null) return true;
                foreach (var p in o.Properties()) if (HasOldTextField(p.Value)) return true;
            }
            else if (token is JArray a)
                foreach (var item in a) if (HasOldTextField(item)) return true;
            return false;
        }

        static readonly HashSet<string> AttrTextNames =new HashSet<string> { "placeholder", "title", "alt", "aria-label" };
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
            node.ShadowLayers = node.ShadowLayers ?? new Dictionary<string, IrShadow>();
            node.InsetShadowLayers = node.InsetShadowLayers ?? new Dictionary<string, IrShadow>();
            node.BackgroundLayers = node.BackgroundLayers ?? new Dictionary<string, IrAsset>();
            ValidateShadow(node.Shadow, node.Id, "shadow");
            ValidateShadow(node.InsetShadow, node.Id, "inset shadow");
            foreach (var kv in node.ShadowLayers) ValidateEffectLayer(kv.Key, node.Id, "shadowLayers", () => ValidateShadow(kv.Value, node.Id, "shadow of layer '" + kv.Key + "'"));
            foreach (var kv in node.InsetShadowLayers) ValidateEffectLayer(kv.Key, node.Id, "insetShadowLayers", () => ValidateShadow(kv.Value, node.Id, "inset shadow of layer '" + kv.Key + "'"));
            foreach (var kv in node.BackgroundLayers) ValidateEffectLayer(kv.Key, node.Id, "backgroundLayers", null);
            foreach (var anim in node.Anims) ValidateAnim(anim, node.Id);
            foreach (var child in node.Children) Validate(child);
        }

        /// <summary>A baked shadow is an untinted 9-slice (four insets) with its drawn rect's offset.</summary>
        static void ValidateShadow(IrShadow s, string id, string what)
        {
            if (s == null) return;
            if (s.Tint) throw new IrFormatException("the " + what + " of node '" + id + "' is tinted; shadows never are");
            if (s.Offset == null) throw new IrFormatException("the " + what + " of node '" + id + "' has no offset (its drawn rect)");
            if (s.Slice == null || s.Slice.Length != 4) throw new IrFormatException("the " + what + " of node '" + id + "' is not a 9-slice (four insets)");
        }

        /// <summary>An effect map's key is a canonical, non-base layer key (base is the node's own field).</summary>
        static void ValidateEffectLayer(string key, string id, string map, Action value)
        {
            if (key == LayerKey.BaseText) throw new IrFormatException(map + " of node '" + id + "' names 'base'; the base value is the node's own field");
            if (!LayerKey.IsCanonical(key, out var canonical))
                throw new IrFormatException(map + " layer '" + key + "' of node '" + id + "' is not in canonical order (expected '" + canonical + "')");
            value?.Invoke();
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
            else if (a.Name == null)
            {
                // a layer's animation: none: it stops the element's animations while it holds
                Require(a.Phase == "enter", "a keyframe animation runs on enter");
                Require(a.Trigger != LayerKey.ShowTrigger, "animation: none is recorded for a layer, not for show");
                Require(a.Keyframes.Count == 0, "a keyframe animation without a name (animation: none) has no keyframes");
            }
            else
            {
                Require(a.Name.Length > 0, "a keyframe animation has a name");
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
