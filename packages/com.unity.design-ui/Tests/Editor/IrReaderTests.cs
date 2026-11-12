using System.IO;
using NUnit.Framework;
using UnityEditor.PackageManager;

namespace DesignUi.Editor.Tests
{
    public class IrReaderTests
    {
        internal static string SamplePath()
        {
            var info = PackageInfo.FindForAssembly(typeof(IrReader).Assembly);
            return Path.Combine(info.resolvedPath, "Tests", "Editor", "Data", "ir-sample.json");
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
            CollectionAssert.AreEqual(new[] { 40, 40, 40, 40 }, card.Shadow.Slice);
            Assert.AreEqual("image", card.Asset.Kind);
            var title = root.Children[0];
            Assert.AreEqual("playerName", title.Bind);
            Assert.AreEqual("sample.title", title.Text.Key);
            Assert.AreEqual("name", title.Text.Args[0]);
            var play = root.Children[2];
            Assert.AreEqual("play", play.Action);
            Assert.AreEqual("#1fa89e", play.Style["active"]["background-color"]);
            Assert.AreEqual("row", root.Children[3].Repeat != null ? root.Children[3].Children[0].Id : null);
            Assert.AreEqual("list", root.Children[3].Repeat.Mode);
        }

        [Test]
        public void Read_UnsupportedVersion_Throws()
        {
            var path = Path.Combine(Path.GetTempPath(), "design-ui-ir-v2-" + System.Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(path, "{\"irVersion\":2,\"root\":{}}");
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
            var path = Path.Combine(Path.GetTempPath(), "design-ui-ir-nov-" + System.Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(path, "{\"root\":{}}");
            try { Assert.Throws<IrFormatException>(() => IrReader.Read(path)); }
            finally { File.Delete(path); }
        }
    }
}
