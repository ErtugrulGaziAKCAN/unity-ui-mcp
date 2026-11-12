using System.Collections.Generic;
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
    }

    public class IrAsset
    {
        /// <summary>image | svg | shadow9</summary>
        [JsonProperty("kind")] public string Kind;
        [JsonProperty("file")] public string File;
        [JsonProperty("sha256")] public string Sha256;
        [JsonProperty("width")] public int Width;
        [JsonProperty("height")] public int Height;
        /// <summary>9-slice insets (four values, as written by the exporter), or null.</summary>
        [JsonProperty("slice")] public int[] Slice;
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
    }

    public sealed class IrNode
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("kind")] public string Kind;
        [JsonProperty("external")] public bool External;
        [JsonProperty("classes")] public string[] Classes = new string[0];
        /// <summary>Layer (base, hover, active, focus, disabled, checked, bp:n, state:n) -> CSS property -> value.</summary>
        [JsonProperty("style")] public Dictionary<string, Dictionary<string, string>> Style = new Dictionary<string, Dictionary<string, string>>();
        [JsonProperty("text")] public IrText Text;
        [JsonProperty("asset")] public IrAsset Asset;
        [JsonProperty("background")] public IrAsset Background;
        [JsonProperty("shadow")] public IrShadow Shadow;
        [JsonProperty("bind")] public string Bind;
        [JsonProperty("action")] public string Action;
        [JsonProperty("repeat")] public IrRepeat Repeat;
        [JsonProperty("anims")] public object[] Anims = new object[0];
        [JsonProperty("children")] public IrNode[] Children = new IrNode[0];

        /// <summary>
        /// Set by Lowering.Apply: the element compiles to a control carrying a Clickable, so that :active works.
        /// Not part of the IR file.
        /// </summary>
        [JsonIgnore] public bool Clickable;
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
