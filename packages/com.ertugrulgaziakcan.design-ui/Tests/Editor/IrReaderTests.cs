using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEditor.PackageManager;

namespace DesignUi.Editor.Tests
{
    public class IrReaderTests
    {
        internal static string PackagePath(params string[] parts)
        {
            var info = PackageInfo.FindForAssembly(typeof(IrReader).Assembly);
            return Path.Combine(info.resolvedPath, Path.Combine(parts));
        }

        internal static string SamplePath() => PackagePath("Tests", "Editor", "Data", "ir-sample.json");

        static string WriteTemp(string json)
        {
            var path = Path.Combine(Path.GetTempPath(), "design-ui-ir-" + System.Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(path, json);
            return path;
        }

        [Test]
        public void Read_Sample_ParsesRootAndScreenFields()
        {
            var screen = IrReader.Read(SamplePath());
            Assert.AreEqual("root", screen.Root.Id);
            Assert.AreEqual(2, screen.IrVersion);
            Assert.AreEqual("sample.screen", screen.Screen);
            CollectionAssert.AreEqual(new[] { 2560, 1440 }, screen.ReferenceViewport);
            Assert.AreEqual(2, screen.Viewports.Length);
            Assert.AreEqual("narrow", screen.Breakpoints[0].Name);
            Assert.AreEqual(1600f, screen.Breakpoints[0].MaxWidth);
            Assert.AreEqual("#2fd1c5", screen.Tokens["color.accent"]);
            Assert.AreEqual("Inter", screen.Fonts[0].Family);
            Assert.AreEqual("svg", screen.Root.Background.Kind);
        }

        [Test]
        public void Read_Sample_ParsesNodeDetails()
        {
            var root = IrReader.Read(SamplePath()).Root;
            var card = root.Children[1];
            Assert.AreEqual("card", card.Id);
            Assert.AreEqual("shadow9", card.Shadow.Kind);
            Assert.AreEqual(-19f, card.Shadow.Offset.Y);
            CollectionAssert.AreEqual(new[] { 59f, 62f, 59f, 62f }, card.Shadow.Slice);
            Assert.AreEqual("image", card.Asset.Kind);
            Assert.IsFalse(card.Asset.Tint);
            var title = root.Children[0];
            Assert.IsNull(title.Bind);
            Assert.AreEqual("sample.title", title.Text.Key);
            Assert.AreEqual("Hoş geldin {name}", title.Text.Ref, "Smart String arguments are named");
            Assert.AreEqual("name", title.Text.Args[0]);
            Assert.AreEqual("title", title.Text.Style);
            Assert.IsNull(title.Initial);
            CollectionAssert.IsEmpty(title.AttrTexts);
            var play = root.Children[2];
            Assert.AreEqual("play", play.Action);
            Assert.AreEqual("#1fa89e", play.Style["active"]["background-color"]);
            Assert.AreEqual("#2fd1c5", play.Style["state:loading+hover"]["background-color"], "compound layer");
            Assert.IsFalse(play.Initial.Disabled);
            Assert.IsFalse(play.Initial.Checked);
            Assert.AreEqual("sample.play.title", play.AttrTexts["title"].Key);
            Assert.AreEqual("Maçı başlat", play.AttrTexts["title"].Ref);
            var rows = root.Children[3];
            Assert.AreEqual("list", rows.Repeat.Mode);
            Assert.AreEqual(3, rows.Repeat.Count);
            Assert.AreEqual("row", rows.Children[0].Id);
            var name = rows.Children[0].Children[0];
            Assert.AreEqual("player-name", name.Bind);
            Assert.AreEqual("#0b1f26", name.Style["anc(row):class:is-selected"]["color"], "ancestor layer");
        }

        [Test]
        public void Read_Sample_TypedAnimations()
        {
            var root = IrReader.Read(SamplePath()).Root;
            var pulse = root.Children[1].Anims.Single();
            Assert.AreEqual(IrAnim.KeyframesKind, pulse.Kind);
            Assert.AreEqual("show", pulse.Trigger);
            Assert.AreEqual("pulse", pulse.Name);
            Assert.AreEqual(float.PositiveInfinity, pulse.Iterations, "infinite");
            Assert.AreEqual("alternate", pulse.Direction);
            Assert.AreEqual("both", pulse.FillMode);
            Assert.IsTrue(pulse.Restart);
            Assert.AreEqual(3, pulse.Keyframes.Count);
            Assert.AreEqual(0.5f, pulse.Keyframes[1].Offset);
            Assert.AreEqual("0.6", pulse.Keyframes[1].Values["opacity"]);
            Assert.AreEqual("linear", pulse.Keyframes[1].Easing);
            Assert.IsNull(pulse.Keyframes[0].Easing);

            var hover = root.Children[2].Anims;
            Assert.AreEqual(2, hover.Count);
            Assert.AreEqual(IrAnim.Transition, hover[0].Kind);
            Assert.AreEqual("hover", hover[0].Trigger);
            Assert.AreEqual("enter", hover[0].Phase);
            Assert.AreEqual("leave", hover[1].Phase);
            Assert.AreEqual(200f, hover[0].Duration);
            Assert.AreEqual("cubic-bezier(0.4, 0, 0.2, 1)", hover[0].Timing);
            Assert.AreEqual(1f, hover[0].Iterations);
            CollectionAssert.AreEqual(new[] { "background-color" }, hover[0].Properties);
        }

        [Test]
        public void Read_Sample_AnimationsSurviveTheJsonRoundTrip()
        {
            var screen = IrReader.Read(SamplePath());
            var path = WriteTemp(Newtonsoft.Json.JsonConvert.SerializeObject(screen));
            try
            {
                var again = IrReader.Read(path);
                Assert.AreEqual(float.PositiveInfinity, again.Root.Children[1].Anims[0].Iterations);
                StringAssert.Contains("\"iterations\":\"infinite\"", File.ReadAllText(path));
                Assert.AreEqual("Maçı başlat", again.Root.Children[2].AttrTexts["title"].Ref);
            }
            finally { File.Delete(path); }
        }

        [Test]
        public void Read_UnsupportedVersion_Throws()
        {
            var path = WriteTemp("{\"irVersion\":3,\"root\":{}}");
            try
            {
                // an export of a newer exporter: the message says which side to update, never a field-level schema error
                var e = Assert.Throws<IrFormatException>(() => IrReader.Read(path));
                StringAssert.StartsWith("the export is IR version 3, made by a newer design-export; this com.ertugrulgaziakcan.design-ui package reads IR version 2", e.Message);
                StringAssert.Contains("update the package", e.Message);
            }
            finally { File.Delete(path); }
        }

        [Test]
        public void Read_AnExportOfIrVersion1_IsRefused_ExportTheScreenAgain()
        {
            // IR version 1: an earlier exporter (texts under "tr") or one of the same release before the version bump (texts
            // under "ref"); read field by field the first would compile without its texts, so both are refused as a version
            Assert.AreEqual(2, IrReader.SupportedVersion);
            foreach (var json in new[]
            {
                "{\"irVersion\":1,\"root\":{\"id\":\"r\",\"kind\":\"text\",\"text\":{\"key\":\"s.t\",\"tr\":\"Kadro\",\"en\":\"Squad\",\"args\":[],\"rich\":false,\"style\":null}}}",
                "{\"irVersion\":1,\"root\":{\"id\":\"r\",\"kind\":\"container\",\"children\":[{\"id\":\"f\",\"kind\":\"input\",\"attrTexts\":" +
                "{\"placeholder\":{\"key\":\"s.find\",\"tr\":\"Ara\",\"en\":\"Search\",\"args\":[],\"rich\":false,\"style\":\"body\"}}}]}}",
                "{\"irVersion\":1,\"root\":{\"id\":\"r\",\"kind\":\"text\",\"text\":{\"key\":\"s.t\",\"ref\":\"Squad\",\"en\":\"Squad\",\"args\":[],\"rich\":false,\"style\":null}}}",
            })
            {
                var path = WriteTemp(json);
                try
                {
                    var e = Assert.Throws<IrFormatException>(() => IrReader.Read(path));
                    StringAssert.StartsWith("the export is IR version 1, made by an earlier design-export; this com.ertugrulgaziakcan.design-ui package reads IR version 2", e.Message);
                    StringAssert.Contains("export the screen again", e.Message);
                    StringAssert.Contains("design_ui_import exports it again by itself", e.Message);
                }
                finally { File.Delete(path); }
            }
        }

        [Test]
        public void Read_MissingVersion_Throws()
        {
            var path = WriteTemp("{\"root\":{}}");
            try { Assert.Throws<IrFormatException>(() => IrReader.Read(path)); }
            finally { File.Delete(path); }
        }

        [Test]
        public void Read_InvalidJson_ThrowsIrFormatException()
        {
            var path = WriteTemp("{ not json");
            try { Assert.Throws<IrFormatException>(() => IrReader.Read(path)); }
            finally { File.Delete(path); }
        }

        [Test]
        public void Read_MissingRoot_Throws()
        {
            var path = WriteTemp("{\"irVersion\":2}");
            try
            {
                var e = Assert.Throws<IrFormatException>(() => IrReader.Read(path));
                StringAssert.Contains("root", e.Message);
            }
            finally { File.Delete(path); }
        }

        [Test]
        public void Read_MissingFile_ThrowsIrFormatException()
        {
            Assert.Throws<IrFormatException>(() => IrReader.Read(Path.Combine(Path.GetTempPath(), "design-ui-no-such-" + System.Guid.NewGuid().ToString("N"))));
        }

        [Test]
        public void Read_DateLikeText_StaysVerbatim()
        {
            var path = WriteTemp("{\"irVersion\":2,\"root\":{\"id\":\"r\",\"kind\":\"text\",\"text\":{\"key\":null,\"ref\":\"2026-11-12T10:00:00\",\"en\":null,\"args\":[],\"rich\":false}}}");
            try { Assert.AreEqual("2026-11-12T10:00:00", IrReader.Read(path).Root.Text.Ref); }
            finally { File.Delete(path); }
        }

        [Test]
        public void Read_FractionalAssetSizes_AreKept()
        {
            var path = WriteTemp("{\"irVersion\":2,\"root\":{\"id\":\"r\",\"kind\":\"image\",\"asset\":{\"kind\":\"image\",\"file\":\"a.png\",\"sha256\":\"x\",\"width\":96.5,\"height\":20.25,\"slice\":null}}}");
            try
            {
                var a = IrReader.Read(path).Root.Asset;
                Assert.AreEqual(96.5f, a.Width);
                Assert.AreEqual(20.25f, a.Height);
            }
            finally { File.Delete(path); }
        }

        const string Transition = "{\"kind\":\"transition\",\"trigger\":\"state:loading+hover\",\"phase\":\"enter\",\"name\":null,\"properties\":[\"opacity\"]," +
                                  "\"duration\":200,\"delay\":-50,\"timing\":\"ease\",\"iterations\":1,\"direction\":\"normal\",\"fillMode\":\"none\"," +
                                  "\"playState\":\"running\",\"restart\":true,\"keyframes\":[]}";

        const string Spin = "{\"kind\":\"keyframes\",\"trigger\":\"anc(card):hover\",\"phase\":\"enter\",\"name\":\"spin\",\"properties\":[\"rotate\"]," +
                            "\"duration\":1000,\"delay\":0,\"timing\":\"linear\",\"iterations\":2.5,\"direction\":\"reverse\",\"fillMode\":\"forwards\"," +
                            "\"playState\":\"paused\",\"restart\":false,\"keyframes\":[{\"offset\":0,\"values\":{\"rotate\":\"0deg\"},\"easing\":null}," +
                            "{\"offset\":1,\"values\":{\"rotate\":\"360deg\"},\"easing\":\"steps(4)\"}]}";

        static string WithAnims(params string[] anims) =>
            "{\"irVersion\":2,\"root\":{\"id\":\"r\",\"kind\":\"text\",\"anims\":[" + string.Join(",", anims) +
            "],\"text\":{\"key\":\"a.b\",\"ref\":\"x\",\"en\":\"x\",\"args\":[],\"rich\":false,\"style\":\"label-bold\"}}}";

        [Test]
        public void Read_TextStyleAndTypedAnims_AreAccepted_AndCopiedByLowering()
        {
            var path = WriteTemp(WithAnims(Transition, Spin));
            try
            {
                var root = IrReader.Read(path).Root;
                Assert.AreEqual("label-bold", root.Text.Style);
                Assert.AreEqual(2, root.Anims.Count);
                Assert.AreEqual("state:loading+hover", root.Anims[0].Trigger);
                Assert.AreEqual(-50f, root.Anims[0].Delay);
                Assert.IsNull(root.Anims[0].Name);
                Assert.AreEqual(2.5f, root.Anims[1].Iterations);
                Assert.IsFalse(root.Anims[1].Restart, "the layer keeps the running animation");
                Assert.AreEqual("paused", root.Anims[1].PlayState);
                Assert.AreEqual("steps(4)", root.Anims[1].Keyframes[1].Easing);
                Assert.AreEqual("360deg", root.Anims[1].Keyframes[1].Values["rotate"]);

                var lowered = Lowering.Apply(root);
                Assert.AreEqual(Newtonsoft.Json.JsonConvert.SerializeObject(root.Anims), Newtonsoft.Json.JsonConvert.SerializeObject(lowered.Anims),
                    "anims pass through lowering unchanged");
                Assert.AreNotSame(root.Anims[1].Keyframes[0].Values, lowered.Anims[1].Keyframes[0].Values, "deep copy");
                Assert.AreEqual("label-bold", lowered.Text.Style);
            }
            finally { File.Delete(path); }
        }

        [TestCase("\"name\":null", "\"name\":\"fade\"", "a transition has no name")]
        [TestCase("\"iterations\":1", "\"iterations\":2", "a transition runs once")]
        [TestCase("\"restart\":true", "\"restart\":false", "a transition always restarts")]
        [TestCase("\"fillMode\":\"none\"", "\"fillMode\":\"both\"", "fill mode none")]
        [TestCase("\"keyframes\":[]", "\"keyframes\":[{\"offset\":0,\"values\":{},\"easing\":null}]", "no keyframes")]
        [TestCase("\"trigger\":\"state:loading+hover\"", "\"trigger\":\"hover+state:loading\"", "canonical order")]
        [TestCase("\"trigger\":\"state:loading+hover\"", "\"trigger\":\"pseudo:hover\"", "malformed")]
        [TestCase("\"trigger\":\"state:loading+hover\"", "\"trigger\":\"base\"", "'show'")]
        [TestCase("\"phase\":\"enter\"", "\"phase\":\"start\"", "phase")]
        [TestCase("\"direction\":\"normal\"", "\"direction\":\"sideways\"", "direction")]
        [TestCase("\"iterations\":1", "\"iterations\":\"forever\"", "iterations")]
        public void Read_TransitionBreakingItsKindsRules_Throws(string from, string to, string message)
        {
            Assert.IsTrue(Transition.Contains(from));
            var path = WriteTemp(WithAnims(Transition.Replace(from, to)));
            try { StringAssert.Contains(message, Assert.Throws<IrFormatException>(() => IrReader.Read(path)).Message); }
            finally { File.Delete(path); }
        }

        [TestCase("\"name\":\"spin\"", "\"name\":null", "without a name (animation: none) has no keyframes")]
        [TestCase("\"name\":\"spin\"", "\"name\":\"\"", "has a name")]
        [TestCase("\"phase\":\"enter\"", "\"phase\":\"leave\"", "runs on enter")]
        [TestCase("\"offset\":1,", "\"offset\":1.5,", "outside 0..1")]
        public void Read_KeyframesBreakingItsKindsRules_Throws(string from, string to, string message)
        {
            Assert.IsTrue(Spin.Contains(from));
            var path = WriteTemp(WithAnims(Spin.Replace(from, to)));
            try { StringAssert.Contains(message, Assert.Throws<IrFormatException>(() => IrReader.Read(path)).Message); }
            finally { File.Delete(path); }
        }

        const string Stop = "{\"kind\":\"keyframes\",\"trigger\":\"class:is-still\",\"phase\":\"enter\",\"name\":null,\"properties\":[\"rotate\"]," +
                            "\"duration\":0,\"delay\":0,\"timing\":\"ease\",\"iterations\":1,\"direction\":\"normal\",\"fillMode\":\"none\"," +
                            "\"playState\":\"running\",\"restart\":true,\"keyframes\":[]}";

        [Test]
        public void Read_ALayersAnimationNone_IsAKeyframesEntryWithoutANameOrKeyframes()
        {
            var path = WriteTemp(WithAnims(Spin.Replace("anc(card):hover", "show").Replace("\"restart\":false", "\"restart\":true"), Stop));
            try
            {
                var stop = IrReader.Read(path).Root.Anims[1];
                Assert.AreEqual(IrAnim.KeyframesKind, stop.Kind);
                Assert.IsNull(stop.Name);
                Assert.AreEqual("class:is-still", stop.Trigger);
                Assert.IsEmpty(stop.Keyframes);
            }
            finally { File.Delete(path); }
            path = WriteTemp(WithAnims(Stop.Replace("class:is-still", "show")));
            try { StringAssert.Contains("for a layer, not for show", Assert.Throws<IrFormatException>(() => IrReader.Read(path)).Message); }
            finally { File.Delete(path); }
        }

        [Test]
        public void Read_KeyframesWithoutKeyframes_Throws()
        {
            var empty = Spin.Substring(0, Spin.IndexOf("\"keyframes\":[", System.StringComparison.Ordinal)) + "\"keyframes\":[]}";
            var path = WriteTemp(WithAnims(empty));
            try { StringAssert.Contains("has keyframes", Assert.Throws<IrFormatException>(() => IrReader.Read(path)).Message); }
            finally { File.Delete(path); }
        }

        static string Node(string extra) => "{\"irVersion\":2,\"root\":{\"id\":\"r\",\"kind\":\"container\"," + extra + "}}";

        [Test]
        public void Read_StyleKeys_MustBeCanonicalAndWellFormed()
        {
            foreach (var (style, message) in new[]
                     {
                         ("{\"base\":{},\"hover+state:loading\":{}}", "canonical order"),
                         ("{\"base\":{},\"pseudo:hover\":{}}", "malformed"),
                         ("{\"base\":{},\"anc(card)hover\":{}}", "malformed"),
                         ("{\"base\":{},\"hover+hover\":{}}", "twice"),
                         ("{\"base\":{},\"visited\":{}}", "malformed"),
                     })
            {
                var path = WriteTemp(Node("\"style\":" + style));
                try { StringAssert.Contains(message, Assert.Throws<IrFormatException>(() => IrReader.Read(path), style).Message, style); }
                finally { File.Delete(path); }
            }
            var ok = WriteTemp(Node("\"style\":{\"base\":{},\"bp:a+bp:b+state:x+class:is-on+anc(card):class:is-open+anc(card):hover+active+hover\":{}}"));
            try { Assert.AreEqual(2, IrReader.Read(ok).Root.Style.Count); }
            finally { File.Delete(ok); }
        }

        [Test]
        public void Read_NewNodeFields()
        {
            var path = WriteTemp(Node("\"kind\":\"input\",\"initial\":{\"disabled\":true,\"checked\":false}," +
                                      "\"attrTexts\":{\"placeholder\":{\"key\":\"s.find\",\"ref\":\"Ara\",\"en\":\"Search\",\"args\":[],\"rich\":false,\"style\":\"body\"}}," +
                                      "\"asset\":{\"kind\":\"svg\",\"file\":\"assets/i.svg\",\"sha256\":\"x\",\"width\":24,\"height\":24,\"slice\":null,\"tint\":true}").Replace("\"kind\":\"container\",", ""));
            try
            {
                var root = IrReader.Read(path).Root;
                Assert.IsTrue(root.Initial.Disabled);
                Assert.IsFalse(root.Initial.Checked);
                Assert.AreEqual("Ara", root.AttrTexts["placeholder"].Ref);
                Assert.AreEqual("body", root.AttrTexts["placeholder"].Style);
                Assert.IsTrue(root.Asset.Tint);
            }
            finally { File.Delete(path); }

            var unknown = WriteTemp(Node("\"attrTexts\":{\"label\":{\"key\":null,\"ref\":\"x\",\"en\":null,\"args\":[],\"rich\":false,\"style\":null}}"));
            try { StringAssert.Contains("label", Assert.Throws<IrFormatException>(() => IrReader.Read(unknown)).Message); }
            finally { File.Delete(unknown); }

            var tinted = WriteTemp(Node("\"shadow\":{\"kind\":\"shadow9\",\"file\":\"s.png\",\"sha256\":\"x\",\"width\":8,\"height\":8,\"slice\":[2,2,2,2],\"offset\":{\"x\":0,\"y\":0,\"w\":0,\"h\":0},\"tint\":true}"));
            try { StringAssert.Contains("tinted", Assert.Throws<IrFormatException>(() => IrReader.Read(tinted)).Message); }
            finally { File.Delete(tinted); }
        }

        [Test]
        public void Read_Sample_Defaults()
        {
            var root = IrReader.Read(SamplePath()).Root;
            Assert.AreEqual(0, root.Anims.Count);
            Assert.IsNull(root.Initial);
            CollectionAssert.IsEmpty(root.AttrTexts);
        }

        // ---- fixtures ---------------------------------------------------------------------------------------

        [Test]
        public void Fixtures_ValuesRepeatsAndItemClasses()
        {
            var path = WriteTemp("{\"name\":\"Ali\",\"items\":[{\"label\":\"One\",\"$classes\":{\"rows__0\":[\"is-selected\"]}},{\"label\":\"Two\"}," +
                                 "{\"label\":\"Three\",\"$classes\":{\"rows__0\":[\"is-selected\",\"is-new\"]}}]}");
            try
            {
                var f = IrFixtures.Read(path);
                Assert.AreEqual("Ali", f.Values["name"]);
                var items = f.Repeats["items"];
                Assert.AreEqual(3, items.Count);
                Assert.AreEqual("One", items[0].Values["label"]);
                CollectionAssert.AreEqual(new[] { "is-selected" }, items[0].Classes["rows__0"]);
                CollectionAssert.IsEmpty(items[1].Classes);
                CollectionAssert.AreEqual(new[] { "is-selected", "is-new" }, items[2].Classes["rows__0"]);
                Assert.IsFalse(items[0].Values.ContainsKey(IrFixtures.ClassesKey));
            }
            finally { File.Delete(path); }

            foreach (var bad in new[] { "{\"x\":3}", "{\"items\":[{\"$classes\":{\"a\":[\"selected\"]}}]}", "{\"items\":[\"a\"]}" })
            {
                var p = WriteTemp(bad);
                try { Assert.Throws<IrFormatException>(() => IrFixtures.Read(p), bad); }
                finally { File.Delete(p); }
            }
        }

        [Test]
        public void Fixtures_ImageSamples_AreExportFilesOrNone()
        {
            var sha = new string('a', 64);
            var path = WriteTemp("{\"logo\":{\"$image\":{\"file\":\"assets/" + sha + ".png\",\"sha256\":\"" + sha + "\",\"width\":72,\"height\":48}}," +
                                 "\"rows\":[{\"crest\":{\"$image\":{\"file\":\"assets/" + sha + ".svg\",\"sha256\":\"" + sha + "\",\"width\":8.5,\"height\":8}},\"name\":\"Bir\"}," +
                                 "{\"crest\":{\"$image\":null},\"name\":\"İki\"}]}");
            try
            {
                var f = IrFixtures.Read(path);
                var logo = f.Images["logo"];
                Assert.AreEqual(("image", "assets/" + sha + ".png", sha, 72f, 48f), (logo.Kind, logo.File, logo.Sha256, logo.Width, logo.Height));
                Assert.IsNull(logo.Slice);
                Assert.IsFalse(logo.Tint);
                Assert.IsFalse(f.Values.ContainsKey("logo"), "an image is not a text");
                var rows = f.Repeats["rows"];
                Assert.AreEqual(("svg", 8.5f), (rows[0].Images["crest"].Kind, rows[0].Images["crest"].Width));
                Assert.IsTrue(rows[1].Images.ContainsKey("crest"));
                Assert.IsNull(rows[1].Images["crest"], "an item that shows no image");
                Assert.AreEqual("İki", rows[1].Values["name"]);
            }
            finally { File.Delete(path); }

            foreach (var bad in new[]
                     {
                         "{\"logo\":{}}", "{\"logo\":{\"$image\":null,\"x\":1}}", "{\"logo\":{\"image\":null}}", "{\"logo\":{\"$image\":\"a.png\"}}",
                         "{\"logo\":{\"$image\":{\"file\":\"assets/a.png\",\"sha256\":\"a\",\"width\":1}}}",
                         "{\"logo\":{\"$image\":{\"file\":\"../a.png\",\"sha256\":\"a\",\"width\":1,\"height\":1}}}",
                         "{\"logo\":{\"$image\":{\"file\":\"/tmp/a.png\",\"sha256\":\"a\",\"width\":1,\"height\":1}}}",
                         "{\"logo\":{\"$image\":{\"file\":\"\",\"sha256\":\"a\",\"width\":1,\"height\":1}}}",
                     })
            {
                var p = WriteTemp(bad);
                try { Assert.Throws<IrFormatException>(() => IrFixtures.Read(p), bad); }
                finally { File.Delete(p); }
            }
        }
    }
}
