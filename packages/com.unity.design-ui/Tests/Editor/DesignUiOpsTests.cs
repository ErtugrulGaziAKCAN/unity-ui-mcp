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
    /// The import and kit-sync operations (<see cref="DesignUiOps"/>) and their batch entry points for a command runner:
    /// <see cref="ImportFromEnv"/> and <see cref="KitSyncFromEnv"/> run the operation with the runner's environment
    /// (<c>DESIGN_UI_PROFILE</c>, <c>DESIGN_UI_EXPORT_DIR</c>, <c>DESIGN_UI_DISCARD_MANUAL_EDITS</c>, <c>DESIGN_UI_KIT_DIR</c>)
    /// and fail with the operation's log unless it answers code 0; without that environment they pass without doing
    /// anything ("not configured"), so a suite filter that includes them never fails on them.
    /// </summary>
    public class DesignUiOpsTests
    {
        readonly List<string> _temp = new List<string>();
        const string ProfilePath = FontFixture.Folder + "/Ops Profile.asset";

        static string Env(params string[] names) =>
            names.Select(Environment.GetEnvironmentVariable).FirstOrDefault(v => !string.IsNullOrEmpty(v));

        // ---- batch entry points ------------------------------------------------------------------------------

        /// <summary>Imports <c>$DESIGN_UI_EXPORT_DIR</c> with the profile <c>$DESIGN_UI_PROFILE</c> (Assets/…).</summary>
        [Test]
        public void ImportFromEnv()
        {
            var export = Env("DESIGN_UI_EXPORT_DIR", "DESIGN_UI_EXPORT");
            if (export == null) Assert.Pass("not configured; nothing imported (set DESIGN_UI_EXPORT_DIR and DESIGN_UI_PROFILE)");
            var profile = Env("DESIGN_UI_PROFILE");
            Assert.IsNotNull(profile, "DESIGN_UI_PROFILE names the DesignUiProfile asset (Assets/…)");
            var discard = string.Equals(Env("DESIGN_UI_DISCARD_MANUAL_EDITS"), "true", StringComparison.OrdinalIgnoreCase);
            var r = DesignUiOps.Import(profile, export, discard);
            Debug.Log("Design UI import (code " + r.Code + "):\n" + r.Log);
            Assert.AreEqual(0, r.Code, r.Log);
        }

        /// <summary>Syncs the kit folder <c>$DESIGN_UI_KIT_DIR</c> with the profile <c>$DESIGN_UI_PROFILE</c>.</summary>
        [Test]
        public void KitSyncFromEnv()
        {
            var kit = Env("DESIGN_UI_KIT_DIR");
            if (kit == null) Assert.Pass("not configured; nothing synced (set DESIGN_UI_KIT_DIR and DESIGN_UI_PROFILE)");
            var profile = Env("DESIGN_UI_PROFILE");
            Assert.IsNotNull(profile, "DESIGN_UI_PROFILE names the DesignUiProfile asset (Assets/…)");
            var r = DesignUiOps.KitSync(profile, kit);
            Debug.Log("Design UI kit sync (code " + r.Code + "):\n" + r.Log);
            Assert.AreEqual(0, r.Code, r.Log);
        }

        // ---- import ------------------------------------------------------------------------------------------

        [TearDown]
        public void Cleanup()
        {
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
        }

        [OneTimeTearDown]
        public void DeleteFonts() => FontFixture.Delete();

        string TempDir(string what)
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-ops-" + what + "-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            return dir;
        }

        /// <summary>A profile asset whose output folder is outside the project, so the generated view is never compiled here.</summary>
        string ProfileAsset(string outputFolder)
        {
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            FontFixture.Use(profile);
            profile.outputFolder = outputFolder;
            AssetDatabase.DeleteAsset(ProfilePath);
            AssetDatabase.CreateAsset(profile, ProfilePath);
            return ProfilePath;
        }

        static string ExportOf(string dir, IrScreen ir)
        {
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));
            return dir;
        }

        static IrScreen Panel(string color) => Screen(Root(Node("panel", "container", ("height", "20px"), ("background-color", color))), "ops.screen");

        [Test]
        public void Import_CompilesTheExport_ThenWritesNothing_AndGuardsHandEdits()
        {
            var output = TempDir("out");
            var profile = ProfileAsset(output);
            var export = ExportOf(TempDir("export"), Panel("#123456"));

            var first = DesignUiOps.Import(profile, export, false);
            Assert.AreEqual(0, first.Code, first.Log);
            StringAssert.StartsWith("Imported ops.screen into " + output + "/OpsScreen: ", first.Log);
            StringAssert.Contains("OpsScreen.uss", first.Log);
            var uss = Path.Combine(output, "OpsScreen", "OpsScreen.uss");
            StringAssert.Contains("#123456", File.ReadAllText(uss));

            var again = DesignUiOps.Import(profile, export, false);
            Assert.AreEqual(0, again.Code, again.Log);
            StringAssert.Contains(": 0 files written", again.Log);

            File.AppendAllText(uss, "/* hand edit */\n");
            ExportOf(export, Panel("#654321"));
            var guarded = DesignUiOps.Import(profile, export, false);
            Assert.AreEqual(1, guarded.Code);
            StringAssert.Contains("edited by hand: ", guarded.Log);
            StringAssert.Contains("hand edit", File.ReadAllText(uss), "nothing was overwritten");

            var discarded = DesignUiOps.Import(profile, export, true);
            Assert.AreEqual(0, discarded.Code, discarded.Log);
            StringAssert.Contains("#654321", File.ReadAllText(uss));
        }

        [Test]
        public void Import_ReportsWhatIsMissingOrWrong_WithCode1()
        {
            var profile = ProfileAsset(TempDir("out"));
            var missingProfile = DesignUiOps.Import("Assets/Nope.asset", TempDir("export"), false);
            Assert.AreEqual(1, missingProfile.Code);
            StringAssert.Contains("No DesignUiProfile at 'Assets/Nope.asset'", missingProfile.Log);

            var nowhere = DesignUiOps.Import(profile, Path.Combine(TempDir("x"), "missing"), false);
            Assert.AreEqual(1, nowhere.Code);
            StringAssert.Contains("No export folder at", nowhere.Log);

            var empty = DesignUiOps.Import(profile, TempDir("export"), false);
            Assert.AreEqual(1, empty.Code);
            StringAssert.Contains("error: no screen.ir.json", empty.Log);

            var grid = Panel("#123456");
            grid.Root.Children[0].Style["base"]["display"] = "grid";
            var bad = DesignUiOps.Import(profile, ExportOf(TempDir("export"), grid), false);
            Assert.AreEqual(1, bad.Code);
            StringAssert.Contains("error: ", bad.Log);
            StringAssert.Contains("display", bad.Log);
        }

        [Test]
        public void Import_ARelativeExportFolder_IsResolvedAgainstTheProjectRoot()
        {
            var profile = ProfileAsset(TempDir("out"));
            var root = Directory.GetCurrentDirectory();
            var dir = Path.Combine(root, "Temp", "design-ui-ops-relative-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            ExportOf(dir, Panel("#123456"));
            var r = DesignUiOps.Import(profile, "Temp/" + Path.GetFileName(dir), false);
            Assert.AreEqual(0, r.Code, r.Log);
            StringAssert.StartsWith("note: export folder 'Temp/" + Path.GetFileName(dir) + "' resolved against the project root", r.Log);
        }
    }
}
