using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace DesignUi.Editor.Tests
{
    /// <summary>Small builders for IR trees used by the writer and compiler tests.</summary>
    internal static class TestIr
    {
        public static Dictionary<string, string> Layer(params (string k, string v)[] style)
        {
            var d = new Dictionary<string, string>();
            foreach (var (k, v) in style) d[k] = v;
            return d;
        }

        public static IrNode Node(string id, string kind, params (string k, string v)[] style)
        {
            var n = new IrNode { Id = id, Kind = kind };
            n.Style["base"] = Layer(style);
            return n;
        }

        public static IrNode Text(string id, string tr, params (string k, string v)[] style)
        {
            var n = Node(id, "text", style);
            n.Text = new IrText { Key = "test." + id, Tr = tr, En = tr };
            return n;
        }

        public static IrNode Add(this IrNode n, params IrNode[] kids)
        {
            n.Children = n.Children.Concat(kids).ToArray();
            return n;
        }

        public static IrNode With(this IrNode n, string layer, params (string k, string v)[] style)
        {
            n.Style[layer] = Layer(style);
            return n;
        }

        public static IrNode Root(params IrNode[] kids) =>
            Node("root", "container", ("display", "flex"), ("flex-direction", "column"), ("width", "100%"), ("height", "100%")).Add(kids);

        public static IrScreen Screen(IrNode root, string id = "test.screen") => new IrScreen
        {
            IrVersion = 1,
            Screen = id,
            Source = new IrSource { Path = "test.html", Sha256 = new string('a', 64) },
            ReferenceViewport = new[] { 2560, 1440 },
            Viewports = new[] { new[] { 2560, 1440 } },
            ScreenMatch = 0.5f,
            States = new[] { "default", "loading" },
            Breakpoints = new[] { new IrBreakpoint { Name = "narrow", MaxWidth = 1600 } },
            Root = root,
        };

        public static string RelativeAsset(IrAsset a) => "assets/" + Path.GetFileName(a.File);

        public const string ShadowFile = "assets/shadow.png";

        /// <summary>
        /// One of each selector form: root state/breakpoint layers, a descendant state layer, pseudo layers on a button
        /// and on a plain element (Clickable from the view), a shadowed element whose hover layer moves to its host
        /// (mirror), an inline repeat with a gap (__first), and a text node with a kit text style.
        /// </summary>
        public static IrScreen Showcase(string screenId = "test.showcase")
        {
            var label = Text("go-label", "Giriş", ("color", "#ffffff"), ("font-size", "16.5156px"), ("font-family", "Inter"));
            label.Text.Style = "label";

            var card = Node("card", "container", ("width", "100px"), ("height", "50px"), ("background-color", "#666666"))
                .With("hover", ("opacity", "0.8"));
            card.Shadow = new IrShadow
            {
                Kind = "shadow9", File = ShadowFile, Sha256 = new string('d', 64), Width = 8, Height = 8,
                Slice = new float[] { 2, 2, 2, 2 }, Offset = new BoxRect { X = 0, Y = 4, W = 0, H = 0 },
            };

            var items = Node("items", "container", ("display", "flex"), ("flex-direction", "column"), ("gap", "8px")).Add(
                Node("item-a", "container", ("height", "10px"), ("background-color", "#777777")),
                Node("item-b", "container", ("height", "10px"), ("background-color", "#777777")));
            items.Repeat = new IrRepeat { Name = "item", Mode = "inline" };

            var go = Node("go", "button", ("background-color", "#444444"), ("height", "30px"))
                .With("active", ("background-color", "#555555"))
                .Add(label);
            go.Action = "go";

            var root = Root(
                    Node("panel", "container", ("height", "20px"), ("background-color", "#111111"))
                        .With("state:loading", ("background-color", "#222222"))
                        .With("hover", ("background-color", "#333333")),
                    go,
                    Node("tile", "container", ("height", "10px")).With("active", ("opacity", "0.7")),
                    card,
                    items)
                .With("state:loading", ("opacity", "0.5"))
                .With("bp:narrow", ("opacity", "0.9"));
            return Screen(root, screenId);
        }
    }
}
