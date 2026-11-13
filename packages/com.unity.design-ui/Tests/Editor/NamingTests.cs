using System.Globalization;
using System.Threading;
using NUnit.Framework;

namespace DesignUi.Editor.Tests
{
    public class NamingTests
    {
        [Test]
        public void Pascal_JoinsTheDottedDashedAndUnderscoredParts()
        {
            Assert.AreEqual("InboxMessageList", Naming.Pascal("inbox.message-list"));
            Assert.AreEqual("CardShadowhost", Naming.Pascal("card__shadowhost"));
            Assert.AreEqual("PlayLabel", Naming.Pascal("play_label"));
            Assert.AreEqual("Row2", Naming.Pascal("row-2"));
            Assert.AreEqual("OpenBtn", Naming.Pascal("openBtn"));
        }

        [Test]
        public void Pascal_IsCultureInvariant()
        {
            var culture = Thread.CurrentThread.CurrentCulture;
            try
            {
                Thread.CurrentThread.CurrentCulture = new CultureInfo("tr-TR");
                Assert.AreEqual("InboxItem", Naming.Pascal("inbox.item"), "the Turkish upper case of i is İ");
            }
            finally { Thread.CurrentThread.CurrentCulture = culture; }
        }

        [Test]
        public void Pascal_NonAsciiNeverBecomesAName()
        {
            var e = Assert.Throws<IrFormatException>(() => Naming.Pascal("ilk.işlem"));
            StringAssert.Contains("ilk.işlem", e.Message);
        }

        [TestCase("2fa")]
        [TestCase("")]
        [TestCase("--")]
        [TestCase(null)]
        [TestCase("a b")]
        public void Pascal_IdWithoutAValidName_Throws(string id)
        {
            Assert.Throws<IrFormatException>(() => Naming.Pascal(id));
        }
    }
}
