using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The lint and the compiler agree on every probe of <c>contracts/css-support-cases.json</c> (written by the
    /// exporter's tests from css-support.json): each case is one declaration on one element of a small screen, the IR the
    /// exporter builds for it, and what the Unity compiler must do with that IR, <c>compile</c> or <c>reject</c> (null:
    /// no IR, or the exporter drops or rewrites the value, so lint is the only gate). Every case's IR goes through the
    /// real route (<see cref="IrReader"/>, <see cref="Lowering"/>, <see cref="StyleMapper"/> in
    /// <see cref="ScreenBuilder"/>) with the repository kit's text styles. A rejection that names a rule must name one the
    /// lint reports for the case. The file belongs to the repository: a package installed elsewhere has no contracts
    /// folder and skips the check.
    /// </summary>
    public class CssSupportAgreementTests
    {
        static string RepositoryRoot() => Path.GetFullPath(Path.Combine(IrReaderTests.PackagePath(), "..", ".."));

        internal static string CasesPath() => Path.Combine(RepositoryRoot(), "contracts", "css-support-cases.json");

        static string Line(JToken c) => (string)c["id"] ?? ((string)c["property"] + ": " + (string)c["value"]);

        [Test]
        public void TheUnityCompilerAgreesWithEveryCase()
        {
            if (!Directory.Exists(Path.Combine(RepositoryRoot(), "contracts")))
                Assert.Pass("the package is not inside the unity-ui-mcp repository; contracts/ is not here");
            var path = CasesPath();
            Assert.IsTrue(File.Exists(path), "contracts/css-support-cases.json is missing (the exporter's tests write it)");
            var file = JObject.Parse(File.ReadAllText(path));
            Assert.AreEqual(1, (int)file["version"], "css-support-cases.json version");
            var cases = (JArray)file["cases"];
            Assert.IsNotEmpty(cases);

            var stylesPath = Path.Combine(RepositoryRoot(), "design-kit", KitTextStyles.FileName);
            var sizes = KitTextStyles.Load(stylesPath);
            var lineBoxes = KitTextStyles.LoadLineBoxes(stylesPath);
            var temp = Path.Combine(Path.GetTempPath(), "design-ui-css-cases-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);

            var disagreements = new List<string>();
            int compiled = 0, rejected = 0, lintOnly = 0;
            try
            {
                foreach (var c in cases)
                {
                    var expected = (string)c["unity"];
                    if (expected == null) { lintOnly++; continue; }
                    Assert.IsTrue(expected == "compile" || expected == "reject", Line(c) + ": unity must be compile, reject or null, not '" + expected + "'");
                    Assert.AreEqual(JTokenType.Object, c["ir"]?.Type ?? JTokenType.Null, Line(c) + ": a case Unity judges carries its IR");
                    var lint = ((JArray)c["lint"] ?? new JArray()).Select(t => (string)t).ToList();

                    var irFile = Path.Combine(temp, ((string)c["id"] ?? "case") + ".json");
                    File.WriteAllText(irFile, c["ir"].ToString(Newtonsoft.Json.Formatting.None));
                    Exception error = null;
                    try
                    {
                        var ir = IrReader.Read(irFile);
                        var screen = ScreenBuilder.Build(ir, a => "assets/" + Path.GetFileName(a.File), null, sizes, lineBoxes);
                        // the compile's font check (FontMap.ScreenErrors) with the case page's kit family: the screen root's
                        var fonts = new FontMap.FontsPlan();
                        fonts.Fonts["tr"] = null;
                        if (ir.Root.Style.TryGetValue("base", out var rootStyle) && rootStyle.TryGetValue("font-family", out var family))
                        {
                            var name = CssSupport.SplitTop(family, ',')[0].Trim().Trim('"', '\'');
                            fonts.Families[StyleMapper.FamilyNameSlug(name)] = name;
                        }
                        var fontErrors = FontMap.ScreenErrors(fonts, screen);
                        if (fontErrors.Count > 0) throw new IrFormatException(string.Join("\n", fontErrors));
                    }
                    catch (Exception e) when (e is UnsupportedStyleException || e is IrFormatException) { error = e; }

                    if (expected == "compile")
                    {
                        compiled++;
                        if (error != null) disagreements.Add(Line(c) + ": must compile, the compiler rejects it: " + error.Message);
                        continue;
                    }
                    rejected++;
                    if (error == null) { disagreements.Add(Line(c) + ": must be rejected (lint " + string.Join(", ", lint) + "), the compiler compiles it"); continue; }
                    var rule = (error as UnsupportedStyleException)?.RuleId;
                    if (rule != null && !lint.Contains(rule))
                        disagreements.Add(Line(c) + ": rejected with " + rule + ", the lint reports " + (lint.Count > 0 ? string.Join(", ", lint) : "nothing") + ": " + error.Message);
                }
            }
            finally { Directory.Delete(temp, true); }

            Assert.IsEmpty(disagreements, (compiled + rejected) + " cases judged (" + compiled + " compile, " + rejected + " reject; " + lintOnly + " lint only), " +
                                          disagreements.Count + " disagree:\n" + string.Join("\n", disagreements));
        }
    }
}
