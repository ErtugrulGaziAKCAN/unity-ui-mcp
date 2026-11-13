using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json;

namespace DesignUi.Editor
{
    /// <summary>Layout rectangle in CSS px.</summary>
    public sealed class BoxRect
    {
        [JsonProperty("x")] public float X;
        [JsonProperty("y")] public float Y;
        [JsonProperty("w")] public float W;
        [JsonProperty("h")] public float H;
    }

    public sealed class IrSource
    {
        [JsonProperty("path")] public string Path;
        [JsonProperty("sha256")] public string Sha256;
    }

    public sealed class IrBreakpoint
    {
        [JsonProperty("name")] public string Name;
        [JsonProperty("minWidth")] public float? MinWidth;
        [JsonProperty("maxWidth")] public float? MaxWidth;
        [JsonProperty("minAspect")] public float? MinAspect;
        [JsonProperty("maxAspect")] public float? MaxAspect;
    }

    public sealed class IrFont
    {
        [JsonProperty("locale")] public string Locale;
        [JsonProperty("family")] public string Family;
        [JsonProperty("file")] public string File;
        [JsonProperty("sha256")] public string Sha256;
        [JsonProperty("weight")] public int Weight;
    }

    public sealed class IrText
    {
        [JsonProperty("key")] public string Key;
        [JsonProperty("tr")] public string Tr;
        [JsonProperty("en")] public string En;
        [JsonProperty("args")] public string[] Args = new string[0];
        [JsonProperty("rich")] public bool Rich;
        /// <summary>Name of the matched kit text style (text-styles.json), or null; its font size is written exactly.</summary>
        [JsonProperty("style")] public string Style;
    }

    public class IrAsset
    {
        /// <summary>image | svg | shadow9</summary>
        [JsonProperty("kind")] public string Kind;
        [JsonProperty("file")] public string File;
        [JsonProperty("sha256")] public string Sha256;
        [JsonProperty("width")] public float Width;
        [JsonProperty("height")] public float Height;
        /// <summary>9-slice insets (four values, as written by the exporter), or null.</summary>
        [JsonProperty("slice")] public float[] Slice;
        /// <summary>
        /// An SVG painted with currentColor, written white: the compiler tints it with the node's <c>color</c> in each layer
        /// (<c>-unity-background-image-tint-color</c>). Always false on shadows.
        /// </summary>
        [JsonProperty("tint")] public bool Tint;
    }

    /// <summary>
    /// Baked box-shadow. Offset.X/Y is the shadow image's top-left relative to the element's border-box
    /// top-left (CSS px, may be negative); Offset.W/H is the shadow image size minus the element size.
    /// </summary>
    public sealed class IrShadow : IrAsset
    {
        [JsonProperty("offset")] public BoxRect Offset;
    }

    public sealed class IrRepeat
    {
        [JsonProperty("name")] public string Name;
        [JsonProperty("mode")] public string Mode;
        /// <summary>
        /// Number of sample items in the design. The compiler writes one item template; the verifier fills this many
        /// items from the fixtures, so the count is not duplicated into the compiled tree.
        /// </summary>
        [JsonProperty("count")] public int Count;
    }

    /// <summary>The pseudo-states a form control starts in (its disabled and checked attributes).</summary>
    public sealed class IrInitial
    {
        [JsonProperty("disabled")] public bool Disabled;
        [JsonProperty("checked")] public bool Checked;
    }

    /// <summary>One keyframe: offset 0..1, the values it sets, and the easing of the segment that starts here (null: the animation's).</summary>
    public sealed class IrKeyframe
    {
        [JsonProperty("offset")] public float Offset;
        [JsonProperty("values")] public Dictionary<string, string> Values = new Dictionary<string, string>();
        [JsonProperty("easing")] public string Easing;
    }

    /// <summary>
    /// A transition or a keyframe animation (spec 11), kept as data for the animation player; the compiler never writes
    /// it as USS. <see cref="Trigger"/> is <c>show</c> (the screen opens) or a layer key (<see cref="LayerKey"/>): the
    /// animation runs when that layer starts to hold (<c>enter</c>) or stops holding (<c>leave</c>). Times are in ms.
    /// A transition has no name, one iteration, direction normal, fill mode none, play state running, restart true and no
    /// keyframes; a keyframe animation has a name, phase enter and at least one keyframe, and <see cref="Restart"/> is
    /// false when its layer only changes the play state or timing of the running animation.
    /// </summary>
    public sealed class IrAnim
    {
        public const string Transition = "transition";
        public const string KeyframesKind = "keyframes";

        [JsonProperty("kind")] public string Kind;
        [JsonProperty("trigger")] public string Trigger;
        [JsonProperty("phase")] public string Phase;
        [JsonProperty("name")] public string Name;
        [JsonProperty("properties")] public string[] Properties = new string[0];
        [JsonProperty("duration")] public float Duration;
        [JsonProperty("delay")] public float Delay;
        [JsonProperty("timing")] public string Timing;
        /// <summary>Iteration count; <see cref="float.PositiveInfinity"/> for <c>infinite</c>.</summary>
        [JsonProperty("iterations"), JsonConverter(typeof(IterationsConverter))] public float Iterations = 1;
        [JsonProperty("direction")] public string Direction;
        [JsonProperty("fillMode")] public string FillMode;
        [JsonProperty("playState")] public string PlayState;
        [JsonProperty("restart")] public bool Restart;
        [JsonProperty("keyframes")] public List<IrKeyframe> Keyframes = new List<IrKeyframe>();

        public IrAnim Clone() => new IrAnim
        {
            Kind = Kind, Trigger = Trigger, Phase = Phase, Name = Name, Properties = (string[])Properties?.Clone() ?? new string[0],
            Duration = Duration, Delay = Delay, Timing = Timing, Iterations = Iterations, Direction = Direction, FillMode = FillMode,
            PlayState = PlayState, Restart = Restart,
            Keyframes = (Keyframes ?? new List<IrKeyframe>()).Select(k => new IrKeyframe
            {
                Offset = k.Offset, Easing = k.Easing, Values = new Dictionary<string, string>(k.Values ?? new Dictionary<string, string>()),
            }).ToList(),
        };
    }

    /// <summary>Reads and writes an iteration count: a number, or <c>"infinite"</c> as positive infinity.</summary>
    public sealed class IterationsConverter : JsonConverter<float>
    {
        public override float ReadJson(JsonReader reader, Type objectType, float existingValue, bool hasExistingValue, JsonSerializer serializer)
        {
            switch (reader.TokenType)
            {
                case JsonToken.Integer:
                case JsonToken.Float:
                    return Convert.ToSingle(reader.Value, CultureInfo.InvariantCulture);
                case JsonToken.String when (string)reader.Value == "infinite":
                    return float.PositiveInfinity;
                default:
                    throw new JsonSerializationException("iterations must be a number or \"infinite\", not " + reader.TokenType + " '" + reader.Value + "'");
            }
        }

        public override void WriteJson(JsonWriter writer, float value, JsonSerializer serializer)
        {
            if (float.IsPositiveInfinity(value)) writer.WriteValue("infinite");
            else writer.WriteValue(value);
        }
    }

    public sealed class IrNode
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("kind")] public string Kind;
        [JsonProperty("external")] public bool External;
        [JsonProperty("classes")] public string[] Classes = new string[0];
        /// <summary>Layer key (<see cref="LayerKey"/>, e.g. <c>base</c>, <c>state:loading+hover</c>, <c>anc(card):hover</c>) -> CSS property -> value.</summary>
        [JsonProperty("style")] public Dictionary<string, Dictionary<string, string>> Style = new Dictionary<string, Dictionary<string, string>>();
        [JsonProperty("text")] public IrText Text;
        /// <summary>Content image or SVG (an <c>img</c>, an inline <c>svg</c>, or an element painted only by a url() background).</summary>
        [JsonProperty("asset")] public IrAsset Asset;
        /// <summary>
        /// The base layer's background image: a baked gradient (SVG), or a url() image whose <c>background-size</c>,
        /// <c>background-repeat</c> and <c>background-position-x/-y</c> stay in the style layers (every layer's url is
        /// rewritten to its asset file).
        /// </summary>
        [JsonProperty("background")] public IrAsset Background;
        /// <summary>Baked 9-slice box-shadow; its offset is relative to the element, in CSS px.</summary>
        [JsonProperty("shadow")] public IrShadow Shadow;
        /// <summary>Text in attributes (<c>placeholder</c>, <c>title</c>, <c>alt</c>, <c>aria-label</c>), each with its own key.</summary>
        [JsonProperty("attrTexts")] public Dictionary<string, IrText> AttrTexts = new Dictionary<string, IrText>();
        /// <summary>Form controls: the pseudo-states the markup starts in; null for other elements.</summary>
        [JsonProperty("initial")] public IrInitial Initial;
        [JsonProperty("bind")] public string Bind;
        [JsonProperty("action")] public string Action;
        [JsonProperty("repeat")] public IrRepeat Repeat;
        /// <summary>Transitions and keyframe animations with their triggers, for the animation player (never written as USS).</summary>
        [JsonProperty("anims")] public List<IrAnim> Anims = new List<IrAnim>();
        [JsonProperty("children")] public IrNode[] Children = new IrNode[0];

        /// <summary>
        /// Set by Lowering.Apply: the element compiles to a control carrying a Clickable, so that :active works.
        /// Not part of the IR file.
        /// </summary>
        [JsonIgnore] public bool Clickable;

        /// <summary>
        /// Set by Lowering.Apply: the element has a <c>:focus</c> style (its own, or one a descendant's layer names), so it
        /// is written focusable (UI Toolkit elements are not focusable by default). Not part of the IR file.
        /// </summary>
        [JsonIgnore] public bool Focusable;

        /// <summary>
        /// Set by Lowering.Apply for a baked shadow image and for elements with pointer-events: none; the compiler
        /// emits picking-mode Ignore. Not part of the IR file.
        /// </summary>
        [JsonIgnore] public bool PickingIgnore;

        /// <summary>
        /// Set on a shadow host whose rules for the element's pseudo-states use the class dimensions <c>class:dui-hover</c>,
        /// <c>class:dui-active</c>, <c>class:dui-focus</c>, <c>class:dui-checked</c> or <c>class:dui-disabled</c> (alone or
        /// in a compound key): the compiler attaches the runtime PseudoStateMirror, which toggles those classes on the host.
        /// Not part of the IR file.
        /// </summary>
        [JsonIgnore] public bool MirrorPseudoState;

        /// <summary>
        /// Set on a shadow host whose rules depend on the element's own view-toggled classes (moved layers of
        /// <c>class:is-x</c>): the view toggles these classes on the host whenever it toggles them on the element. The host
        /// starts with the ones the element starts with. Not part of the IR file.
        /// </summary>
        [JsonIgnore] public string[] MirrorClasses = new string[0];

        /// <summary>
        /// Transition declarations per layer, taken out of Style by Lowering.Apply for the animation player (they are
        /// never written as USS). Not part of the IR file.
        /// </summary>
        [JsonIgnore] public Dictionary<string, Dictionary<string, string>> Transitions = new Dictionary<string, Dictionary<string, string>>();
    }

    public sealed class IrScreen
    {
        [JsonProperty("irVersion")] public int IrVersion;
        [JsonProperty("screen")] public string Screen;
        [JsonProperty("source")] public IrSource Source;
        [JsonProperty("referenceViewport")] public int[] ReferenceViewport;
        [JsonProperty("viewports")] public int[][] Viewports;
        [JsonProperty("screenMatch")] public float ScreenMatch;
        [JsonProperty("states")] public string[] States = new string[0];
        [JsonProperty("breakpoints")] public IrBreakpoint[] Breakpoints = new IrBreakpoint[0];
        [JsonProperty("tokens")] public Dictionary<string, string> Tokens = new Dictionary<string, string>();
        [JsonProperty("fonts")] public IrFont[] Fonts = new IrFont[0];
        [JsonProperty("root")] public IrNode Root;
    }
}
