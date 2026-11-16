using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Xml;
using NUnit.Framework;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The runtime reaches internal Unity members by reflection (each with a fallback): a player build's code stripping must
    /// keep them. The package's <c>Runtime/link.xml</c> names them, the Editor's linker processor hands it to the build, and
    /// every type and member it names exists in this Unity's assemblies (a name that does not resolve keeps nothing).
    /// </summary>
    public class LinkXmlTests
    {
        const BindingFlags All = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;

        static string LinkXml => IrReaderTests.PackagePath("Runtime", "link.xml");

        [Test]
        public void TheLinkXml_NamesTypesAndMembersThatExist_AndTheBuildGetsIt()
        {
            Assert.IsTrue(File.Exists(LinkXml), "Runtime/link.xml");
            var doc = new XmlDocument();
            doc.Load(LinkXml);
            int members = 0;
            foreach (XmlElement a in doc.DocumentElement.GetElementsByTagName("assembly"))
            {
                var name = a.GetAttribute("fullname");
                var asm = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(x => x.GetName().Name == name);
                Assert.IsNotNull(asm, "assembly " + name);
                foreach (XmlElement t in a.GetElementsByTagName("type"))
                {
                    var type = asm.GetType(t.GetAttribute("fullname"));
                    Assert.IsNotNull(type, "type " + t.GetAttribute("fullname") + " in " + name);
                    foreach (XmlElement m in t.ChildNodes.OfType<XmlElement>())
                    {
                        var member = m.GetAttribute("name");
                        var found = m.Name == "field" ? type.GetField(member, All) != null
                            : m.Name == "property" ? type.GetProperty(member, All) != null
                            : m.Name == "method" && type.GetMethods(All).Any(x => x.Name == member);
                        Assert.IsTrue(found, m.Name + " " + type.FullName + "." + member);
                        members++;
                    }
                }
            }
            // the members the runtime reflects (DesignText, DesignTextFit, FontTwinLink, TextAssetRegistry, DesignUiOverlayOrder,
            // DesignUiGammaComposite, LocaleFontController)
            Assert.GreaterOrEqual(members, 40);
            Assert.AreEqual(Path.GetFullPath(LinkXml), Path.GetFullPath(new DesignUiLinkXml().GenerateAdditionalLinkXmlFile(null, null)));
        }
    }
}
