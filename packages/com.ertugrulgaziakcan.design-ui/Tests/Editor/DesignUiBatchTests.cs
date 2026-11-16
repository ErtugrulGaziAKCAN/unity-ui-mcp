using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using static DesignUi.Editor.Tests.TestIr;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The batchmode entry points (<see cref="DesignUiBatch"/>): the command line is parsed into a <see cref="DesignUiOps"/>
    /// call whose code becomes the exit code (0 ok, 1 failed, 2 usage). <see cref="DesignUiBatch.Run"/> is the whole entry
    /// without <c>EditorApplication.Exit</c>.
    /// </summary>
    public class DesignUiBatchTests
    {
        const string ProfilePath = FontFixture.Folder + "/Batch Profile.asset";
        readonly List<string> _temp = new List<string>();

        [TearDown]
        public void Cleanup()
        {
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            AssetDatabase.DeleteAsset(ProfilePath);
        }

        [OneTimeTearDown]
        public void DeleteFonts() => FontFixture.Delete();

        string TempDir(string what)
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-batch-" + what + "-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            return dir;
        }

        string Profile(string outputFolder)
        {
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            FontFixture.Use(profile);
            profile.outputFolder = outputFolder;
            AssetDatabase.DeleteAsset(ProfilePath);
            AssetDatabase.CreateAsset(profile, ProfilePath);
            return ProfilePath;
        }

        static string Export(string dir, string screen, string color)
        {
            var ir = Screen(Root(Node("panel", "container", ("height", "20px"), ("background-color", color))), screen);
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));
            return dir;
        }

        /// <summary>A Unity command line: the editor's own arguments around the entry's.</summary>
        static string[] Line(string method, params string[] args) =>
            new[] { "Unity", "-batchmode", "-projectPath", "/p", "-executeMethod", "DesignUi.Editor.DesignUiBatch." + method }
                .Concat(args).Concat(new[] { "-logFile", "-", "-quit" }).ToArray();

        [Test]
        public void Import_CompilesTheExport_WithCode0()
        {
            var output = TempDir("out");
            var profile = Profile(output);
            var export = Export(TempDir("export"), "batch.screen", "#123456");

            var r = DesignUiBatch.Run(DesignUiBatch.ImportCommand, Line("Import", "-designUiProfile", profile, "-designUiExport", export));
            Assert.AreEqual(0, r.Code, r.Log);
            StringAssert.StartsWith("Imported batch.screen into " + output + "/BatchScreen: ", r.Log);
            StringAssert.Contains("#123456", File.ReadAllText(Path.Combine(output, "BatchScreen", "BatchScreen.uss")));
        }

        [Test]
        public void Import_SeveralExportFolders_ImportsEach_AndFailsWhenOneFails()
        {
            var output = TempDir("out");
            var profile = Profile(output);
            var a = Export(TempDir("a"), "batch.a", "#111111");
            var b = Export(TempDir("b"), "batch.b", "#222222");
            var list = a + Path.PathSeparator + b;

            var r = DesignUiBatch.Run(DesignUiBatch.ImportCommand, Line("Import", "-designUiProfile", profile, "-designUiExport", list));
            Assert.AreEqual(0, r.Code, r.Log);
            StringAssert.Contains("== " + a + "\n", r.Log);
            StringAssert.Contains("== " + b + "\n", r.Log);
            Assert.IsTrue(File.Exists(Path.Combine(output, "BatchA", "BatchA.uss")));
            Assert.IsTrue(File.Exists(Path.Combine(output, "BatchB", "BatchB.uss")));

            var missing = Path.Combine(TempDir("x"), "missing");
            var c = Export(TempDir("c"), "batch.c", "#333333");
            var failed = DesignUiBatch.Run(DesignUiBatch.ImportCommand, Line("Import", "-designUiProfile", profile, "-designUiExport", missing + Path.PathSeparator + c));
            Assert.AreEqual(1, failed.Code, failed.Log);
            StringAssert.Contains("No export folder at", failed.Log);
            Assert.IsTrue(File.Exists(Path.Combine(output, "BatchC", "BatchC.uss")), "a failed folder does not stop the others");
            StringAssert.Contains("1 of 2 export folders failed", failed.Log);
        }

        [Test]
        public void ImportEach_ReportsEveryFoldersResult_ToTheCaller()
        {
            var profile = Profile(TempDir("out"));
            var good = Export(TempDir("good"), "batch.good", "#111111");
            var missing = Path.Combine(TempDir("x"), "missing");
            var seen = new List<string>();
            var r = DesignUiBatch.ImportEach(profile, new[] { good, missing }, false, (dir, one) => seen.Add(one.Code + " " + dir));
            Assert.AreEqual(1, r.Code);
            CollectionAssert.AreEqual(new[] { "0 " + good, "1 " + missing }, seen);
            var single = new List<string>();
            DesignUiBatch.ImportEach(profile, new[] { good }, false, (dir, one) => single.Add(one.Code + " " + dir));
            CollectionAssert.AreEqual(new[] { "0 " + good }, single, "one folder is reported too");
        }

        [Test]
        public void ImportEach_WritesTheDoneMarker_WithEachIrsSha256AndCode()
        {
            var profile = Profile(TempDir("out"));
            var good = Export(TempDir("good"), "batch.good", "#111111");
            var missing = Path.Combine(TempDir("x"), "missing");
            var done = Path.Combine(TempDir("done"), "sub", "import-done.json");
            DesignUiBatch.ImportEach(profile, new[] { good, missing }, false, null, done);
            var o = Newtonsoft.Json.Linq.JObject.Parse(File.ReadAllText(done));
            var imports = (Newtonsoft.Json.Linq.JArray)o["imports"];
            Assert.AreEqual(2, imports.Count);
            Assert.AreEqual(good, imports[0].Value<string>("exportDir"));
            Assert.AreEqual(0, imports[0].Value<int>("code"));
            string sha;
            using (var h = System.Security.Cryptography.SHA256.Create())
                sha = string.Concat(h.ComputeHash(File.ReadAllBytes(Path.Combine(good, ScreenCompiler.IrFileName))).Select(b => b.ToString("x2")));
            Assert.AreEqual(sha, imports[0].Value<string>("irSha"));
            Assert.AreEqual(1, imports[1].Value<int>("code"));
            Assert.AreEqual(Newtonsoft.Json.Linq.JTokenType.Null, imports[1]["irSha"].Type);
        }

        [Test]
        public void KitSync_WritesTheDoneMarker_WithTheKitFolderAndItsCode()
        {
            // a command runner checks the marker, not the exit code: a kit sync that failed records its code
            var kit = TempDir("kit");
            var done = Path.Combine(TempDir("done"), "sub", "kit-sync-done.json");
            var r = DesignUiBatch.KitSyncWithDone("Assets/Nope.asset", kit, false, done);
            Assert.AreEqual(1, r.Code, r.Log);
            var o = Newtonsoft.Json.Linq.JObject.Parse(File.ReadAllText(done));
            Assert.AreEqual(kit, o["kitSync"].Value<string>("kitDir"));
            Assert.AreEqual(1, o["kitSync"].Value<int>("code"));
            Assert.IsFalse(File.Exists(done + ".tmp"));
        }

        [Test]
        public void Import_DiscardManualEdits_OverwritesAHandEditedFile()
        {
            var output = TempDir("out");
            var profile = Profile(output);
            var export = Export(TempDir("export"), "batch.screen", "#123456");
            Assert.AreEqual(0, DesignUiBatch.Run(DesignUiBatch.ImportCommand, Line("Import", "-designUiProfile", profile, "-designUiExport", export)).Code);
            var uss = Path.Combine(output, "BatchScreen", "BatchScreen.uss");
            File.AppendAllText(uss, "/* hand edit */\n");
            Export(export, "batch.screen", "#654321");

            var guarded = DesignUiBatch.Run(DesignUiBatch.ImportCommand, Line("Import", "-designUiProfile", profile, "-designUiExport", export));
            Assert.AreEqual(1, guarded.Code);
            StringAssert.Contains("edited by hand: ", guarded.Log);

            var discarded = DesignUiBatch.Run(DesignUiBatch.ImportCommand,
                Line("Import", "-designUiProfile", profile, "-designUiExport", export, "-designUiDiscardManualEdits"));
            Assert.AreEqual(0, discarded.Code, discarded.Log);
            StringAssert.Contains("#654321", File.ReadAllText(uss));
        }

        [TestCase(DesignUiBatch.ImportCommand, new[] { "-designUiExport", "/e" }, "-designUiProfile")]
        [TestCase(DesignUiBatch.ImportCommand, new[] { "-designUiProfile", "Assets/P.asset" }, "-designUiExport")]
        [TestCase(DesignUiBatch.KitSyncCommand, new[] { "-designUiProfile", "Assets/P.asset" }, "-designUiKit")]
        [TestCase(DesignUiBatch.KitSyncCommand, new[] { "-designUiKit", "/k" }, "-designUiProfile")]
        public void MissingArgument_IsAUsageError(string command, string[] args, string missing)
        {
            var r = DesignUiBatch.Run(command, Line(command, args));
            Assert.AreEqual(2, r.Code, r.Log);
            StringAssert.Contains("missing " + missing, r.Log);
            Assert.AreEqual("missing " + missing, r.Errors.Single(), "the usage error, without the usage text");
            StringAssert.Contains("Usage: ", r.Log);
        }

        [Test]
        public void AFlagWithoutItsValue_AnUnknownOption_AndARepeatedOne_AreUsageErrors()
        {
            var noValue = DesignUiBatch.Run(DesignUiBatch.ImportCommand, Line("Import", "-designUiExport", "/e", "-designUiProfile"));
            Assert.AreEqual(2, noValue.Code);
            StringAssert.Contains("-designUiProfile needs a value", noValue.Log);

            var flagAsValue = DesignUiBatch.Run(DesignUiBatch.ImportCommand, Line("Import", "-designUiProfile", "-designUiExport", "/e"));
            Assert.AreEqual(2, flagAsValue.Code);
            StringAssert.Contains("-designUiProfile needs a value", flagAsValue.Log);

            var typo = DesignUiBatch.Run(DesignUiBatch.ImportCommand, Line("Import", "-designUiProfile", "P", "-designUiExportDir", "/e"));
            Assert.AreEqual(2, typo.Code);
            StringAssert.Contains("unknown option -designUiExportDir", typo.Log);

            var foreign = DesignUiBatch.Run(DesignUiBatch.KitSyncCommand, Line("KitSync", "-designUiProfile", "P", "-designUiKit", "/k", "-designUiExport", "/e"));
            Assert.AreEqual(2, foreign.Code);
            StringAssert.Contains("-designUiExport is not an option of KitSync", foreign.Log);

            var twice = DesignUiBatch.Run(DesignUiBatch.ImportCommand, Line("Import", "-designUiProfile", "P", "-designUiProfile", "Q", "-designUiExport", "/e"));
            Assert.AreEqual(2, twice.Code);
            StringAssert.Contains("-designUiProfile is given twice", twice.Log);

            var unknownCommand = DesignUiBatch.Run("Capture", Line("Capture"));
            Assert.AreEqual(2, unknownCommand.Code);
        }

        [Test]
        public void TheOperationsOwnFailures_AreCode1()
        {
            var noProfile = DesignUiBatch.Run(DesignUiBatch.ImportCommand, Line("Import", "-designUiProfile", "Assets/Nope.asset", "-designUiExport", TempDir("e")));
            Assert.AreEqual(1, noProfile.Code);
            StringAssert.Contains("No DesignUiProfile at 'Assets/Nope.asset'", noProfile.Log);

            var kit = DesignUiBatch.Run(DesignUiBatch.KitSyncCommand, Line("KitSync", "-designUiProfile", "Assets/Nope.asset", "-designUiKit", TempDir("k")));
            Assert.AreEqual(1, kit.Code);
            StringAssert.Contains("No DesignUiProfile at 'Assets/Nope.asset'", kit.Log);
        }

        [Test]
        public void PathList_SplitsOnThePlatformsSeparator_AndDropsEmptyParts()
        {
            var sep = Path.PathSeparator;
            CollectionAssert.AreEqual(new[] { "/a", "/b c" }, DesignUiBatch.PathList("/a" + sep + sep + "/b c" + sep));
            CollectionAssert.AreEqual(new[] { "/a" }, DesignUiBatch.PathList(" /a "));
            CollectionAssert.IsEmpty(DesignUiBatch.PathList(null));
            CollectionAssert.IsEmpty(DesignUiBatch.PathList(""));
        }
    }
}
