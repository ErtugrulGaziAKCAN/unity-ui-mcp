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

        /// <summary>
        /// The generator names members exactly as lint expects (design-export U-MRK-005 memberPart): every case of
        /// contracts/member-names.json, the list both sides test against.
        /// </summary>
        [Test]
        public void Pascal_AgreesWithLint_OnEveryCaseOfTheMemberNameContract()
        {
            var path = System.IO.Path.GetFullPath(System.IO.Path.Combine(IrReaderTests.PackagePath(), "..", "..", "contracts", "member-names.json"));
            if (!System.IO.File.Exists(path)) Assert.Pass("the package is not inside the unity-ui-mcp repository; contracts/ is not here");
            var cases = (Newtonsoft.Json.Linq.JArray)Newtonsoft.Json.Linq.JObject.Parse(System.IO.File.ReadAllText(path))["cases"];
            Assert.Greater(cases.Count, 5);
            foreach (var c in cases)
            {
                var name = (string)c["name"];
                var member = (string)c["member"];
                if (member == null) Assert.Throws<IrFormatException>(() => Naming.Pascal(name), name);
                else Assert.AreEqual(member, Naming.Pascal(name), name);
            }
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
