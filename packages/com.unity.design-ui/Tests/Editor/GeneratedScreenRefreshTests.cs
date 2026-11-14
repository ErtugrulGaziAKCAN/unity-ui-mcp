using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// <see cref="GeneratedScreenRefresh"/>: generated screens are imported again when the package changed since their
    /// assets were imported, or when a generated UXML's import logged an unknown element; <see cref="PackageStamp"/> agrees
    /// with the MCP server's stamp.
    /// </summary>
    public class GeneratedScreenRefreshTests
    {
        const string Out = "Assets/DesignUiRefreshFixture";
        const string Screen = Out + "/Planner";
        string _record, _savedRecordPath;
        readonly List<string> _tmp = new List<string>();

        [SetUp]
        public void Setup()
        {
            _savedRecordPath = GeneratedScreenRefresh.RecordPath;
            _record = Path.Combine(Path.GetTempPath(), "design-ui-refresh-" + System.Guid.NewGuid().ToString("N") + ".json");
            GeneratedScreenRefresh.RecordPath = _record;
            Directory.CreateDirectory(Screen);
            File.WriteAllText(Out + "/DesignTokens.uss", ":root { --accent: #00ffff; }\n");
            File.WriteAllText(Screen + "/" + ScreenCompiler.ManifestFileName, "{\n  \"screen\": \"planner\"\n}\n");
            File.WriteAllText(Screen + "/Planner.uss", ".title { color: var(--accent); }\n");
            File.WriteAllText(Screen + "/PlannerItem.uxml", "<ui:UXML xmlns:ui=\"UnityEngine.UIElements\"><ui:Label name=\"item\" /></ui:UXML>\n");
            File.WriteAllText(Screen + "/Planner.uxml", "<ui:UXML xmlns:ui=\"UnityEngine.UIElements\"><ui:Label name=\"title\" text=\"Planner\" /></ui:UXML>\n");
            AssetDatabase.ImportAsset(Out, ImportAssetOptions.ImportRecursive | ImportAssetOptions.ForceSynchronousImport);
            Imported.Clear();
        }

        [TearDown]
        public void Cleanup()
        {
            GeneratedScreenRefresh.RecordPath = _savedRecordPath;
            if (File.Exists(_record)) File.Delete(_record);
            foreach (var d in _tmp) if (Directory.Exists(d)) Directory.Delete(d, true);
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
        }

        /// <summary>The assets imported since the last clear (a test-only postprocessor).</summary>
        static readonly List<string> Imported = new List<string>();

        sealed class Recorder : AssetPostprocessor
        {
            static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom) =>
                Imported.AddRange(imported.Where(p => p.StartsWith(Out + "/", System.StringComparison.Ordinal)));
        }

        [Test]
        public void AnImportOfAGeneratedScreen_IsRecordedUnderThePackageStamp()
        {
            AssetDatabase.ImportAsset(Screen + "/Planner.uxml", ImportAssetOptions.ForceUpdate);
            var record = GeneratedScreenRefresh.ReadRecord();
            Assert.IsTrue(record.TryGetValue(Screen, out var stamp), "recorded: " + string.Join(", ", record.Keys));
            Assert.AreEqual(GeneratedScreenRefresh.Stamp, stamp);
            Assert.IsNotNull(stamp, "the package of this assembly has a stamp");
            CollectionAssert.IsEmpty(GeneratedScreenRefresh.Refresh(stamp, new[] { Out }), "nothing changed since that import");
        }

        [Test]
        public void AfterAPackageChange_TheScreensUxmlAndUssAreImportedAgain_SharedSheetsFirst_Once()
        {
            AssetDatabase.ImportAsset(Screen + "/Planner.uxml", ImportAssetOptions.ForceUpdate);
            Imported.Clear();
            var again = GeneratedScreenRefresh.Refresh("git:0123456789abcdef", new[] { Out });
            CollectionAssert.AreEqual(new[] { Screen }, again);
            CollectionAssert.IsSupersetOf(Imported, new[] { Out + "/DesignTokens.uss", Screen + "/Planner.uss", Screen + "/PlannerItem.uxml", Screen + "/Planner.uxml" });
            CollectionAssert.DoesNotContain(Imported, Screen + "/" + ScreenCompiler.ManifestFileName);
            Assert.AreEqual("git:0123456789abcdef", GeneratedScreenRefresh.ReadRecord()[Screen]);
            Assert.IsNotNull(AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Screen + "/Planner.uxml"));

            Imported.Clear();
            CollectionAssert.IsEmpty(GeneratedScreenRefresh.Refresh("git:0123456789abcdef", new[] { Out }), "the same package again: nothing to import");
            CollectionAssert.IsEmpty(Imported);
        }

        [Test]
        public void AScreenNeverRecorded_IsImportedAgain_AndAnUnknownPackageImportsNothing()
        {
            File.Delete(_record);
            CollectionAssert.IsEmpty(GeneratedScreenRefresh.Refresh(null, new[] { Out }), "without a stamp nothing can be compared");
            CollectionAssert.AreEqual(new[] { Screen }, GeneratedScreenRefresh.Refresh("registry:9.9.9", new[] { Out }), "imported before the package recorded imports");
            CollectionAssert.IsEmpty(GeneratedScreenRefresh.Refresh("registry:9.9.9", new[] { Out + "/Missing" }));
        }

        /// <summary>
        /// The error UI Toolkit logs for an element type it does not know marks every generated screen for an import after the
        /// next script reload, whatever the record says.
        /// </summary>
        [Test]
        public void TheUnknownElementError_ImportsEveryScreenAgain()
        {
            GeneratedScreenRefresh.Refresh(GeneratedScreenRefresh.Stamp ?? "x", new[] { Out }, all: true);
            Assert.IsFalse(GeneratedScreenRefresh.Pending);
            Debug.LogWarning(GeneratedScreenRefresh.InvalidChildMessage + ": DesignUi.DesignLocalizedString");
            Assert.IsTrue(GeneratedScreenRefresh.Pending);
            var stamp = GeneratedScreenRefresh.ReadRecord()[Screen];
            CollectionAssert.AreEqual(new[] { Screen }, GeneratedScreenRefresh.Refresh(stamp, new[] { Out }, GeneratedScreenRefresh.Pending));
            Assert.IsFalse(GeneratedScreenRefresh.Pending, "consumed");
        }

        /// <summary>The content stamp of a local package agrees with the MCP server's (contracts/package-stamp.json).</summary>
        [Test]
        public void ContentStamp_MatchesTheContract()
        {
            var contractPath = Path.GetFullPath(Path.Combine(UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(PackageStamp).Assembly).resolvedPath, "../../contracts/package-stamp.json"));
            if (!File.Exists(contractPath)) Assert.Ignore("the contract is in the repository checkout, not in an installed package (" + contractPath + ")");
            var contract = Newtonsoft.Json.Linq.JObject.Parse(File.ReadAllText(contractPath));
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-stamp-" + System.Guid.NewGuid().ToString("N"));
            _tmp.Add(dir);
            foreach (var kv in (Newtonsoft.Json.Linq.JObject)contract["files"])
            {
                var path = Path.Combine(dir, kv.Key);
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.WriteAllBytes(path, new System.Text.UTF8Encoding(false).GetBytes((string)kv.Value));
            }
            Assert.AreEqual((string)contract["stamp"], PackageStamp.ContentStamp(dir));
        }
    }
}
