using System.IO;
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
            Assert.AreEqual(1, screen.IrVersion);
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
            Assert.AreEqual(8f, card.Shadow.Offset.Y);
            CollectionAssert.AreEqual(new[] { 40f, 40f, 40f, 40f }, card.Shadow.Slice);
            Assert.AreEqual("image", card.Asset.Kind);
            var title = root.Children[0];
            Assert.AreEqual("playerName", title.Bind);
            Assert.AreEqual("sample.title", title.Text.Key);
            Assert.AreEqual("name", title.Text.Args[0]);
            var play = root.Children[2];
            Assert.AreEqual("play", play.Action);
            Assert.AreEqual("#1fa89e", play.Style["active"]["background-color"]);
            var rows = root.Children[3];
            Assert.AreEqual("list", rows.Repeat.Mode);
            Assert.AreEqual("row", rows.Children[0].Id);
        }

        [Test]
        public void Read_UnsupportedVersion_Throws()
        {
            var path = WriteTemp("{\"irVersion\":2,\"root\":{}}");
            try
            {
                var e = Assert.Throws<IrFormatException>(() => IrReader.Read(path));
                StringAssert.Contains("irVersion", e.Message);
            }
            finally { File.Delete(path); }
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
            var path = WriteTemp("{\"irVersion\":1}");
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
            var path = WriteTemp("{\"irVersion\":1,\"root\":{\"id\":\"r\",\"kind\":\"text\",\"text\":{\"key\":null,\"tr\":\"2026-11-12T10:00:00\",\"en\":null,\"args\":[],\"rich\":false}}}");
            try { Assert.AreEqual("2026-11-12T10:00:00", IrReader.Read(path).Root.Text.Tr); }
            finally { File.Delete(path); }
        }

        [Test]
        public void Read_FractionalAssetSizes_AreKept()
        {
            var path = WriteTemp("{\"irVersion\":1,\"root\":{\"id\":\"r\",\"kind\":\"image\",\"asset\":{\"kind\":\"image\",\"file\":\"a.png\",\"sha256\":\"x\",\"width\":96.5,\"height\":20.25,\"slice\":null}}}");
            try
            {
                var a = IrReader.Read(path).Root.Asset;
                Assert.AreEqual(96.5f, a.Width);
                Assert.AreEqual(20.25f, a.Height);
            }
            finally { File.Delete(path); }
        }
    }
}
