using System.IO;
using NUnit.Framework;

namespace DesignUi.Editor.Tests
{
    public class ThemeTests
    {
        [Test]
        public void RuntimeTheme_ExistsAndImportsNoUnityDefaultTheme()
        {
            var path = IrReaderTests.PackagePath("Runtime", "Themes", "DesignUiRuntimeTheme.tss");
            Assert.IsTrue(File.Exists(path), path);
            var text = File.ReadAllText(path);
            StringAssert.DoesNotContain("unity-theme://", text);
            StringAssert.DoesNotContain("@import", text);
        }
    }
}
