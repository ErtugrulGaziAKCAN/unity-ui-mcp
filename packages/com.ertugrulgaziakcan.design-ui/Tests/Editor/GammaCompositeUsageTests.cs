using System;
using System.IO;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// Whether the project shows design screens the way verify captures them: the colour path a capture records, and the
    /// warning for a Linear project whose profile says Gamma Composite while no scene or prefab has DesignUiGammaComposite.
    /// </summary>
    public class GammaCompositeUsageTests
    {
        string _dir;
        DesignUiProfile _profile;

        [SetUp]
        public void SetUp()
        {
            _dir = Path.Combine(Path.GetTempPath(), "design-ui-usage-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(_dir + "/Prefabs");
            _profile = ScriptableObject.CreateInstance<DesignUiProfile>();
        }

        [TearDown]
        public void TearDown()
        {
            if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
            Object.DestroyImmediate(_profile);
        }

        [Test]
        public void CapturePath_IsWhatTheCaptureRendersThrough()
        {
            bool linear = QualitySettings.activeColorSpace == ColorSpace.Linear;
            Assert.AreEqual(linear ? "gamma-composite" : "gamma-project", GammaCompositeUsage.CapturePath(_profile));
            _profile.colorPath = DesignColorPath.LinearPanel;
            Assert.AreEqual(linear ? "linear-panel" : "gamma-project", GammaCompositeUsage.CapturePath(_profile), "a Gamma project has no composite and no linear panel");
        }

        [Test]
        public void InProject_FindsTheComponentInAPrefabOrScene_ByItsScriptGuid()
        {
            var guid = AssetDatabase.AssetPathToGUID(GammaCompositeUsage.ScriptPath);
            Assert.IsFalse(string.IsNullOrEmpty(guid), "the package's DesignUiGammaComposite script");
            File.WriteAllText(_dir + "/Prefabs/Hud.prefab", "MonoBehaviour:\n  m_Script: {fileID: 11500000, guid: 0123456789abcdef0123456789abcdef, type: 3}\n");
            Assert.IsFalse(GammaCompositeUsage.InProject(_dir));
            File.WriteAllText(_dir + "/Main.unity", "MonoBehaviour:\n  m_Script: {fileID: 11500000, guid: " + guid + ", type: 3}\n");
            Assert.IsTrue(GammaCompositeUsage.InProject(_dir));
        }

        [Test]
        public void Warning_OnlyForALinearProject_OnTheGammaCompositePath_WithoutTheComponent()
        {
            if (QualitySettings.activeColorSpace != ColorSpace.Linear)
            {
                Assert.IsNull(GammaCompositeUsage.Warning(_profile, _dir), "a Gamma project needs no composite");
                return;
            }
            StringAssert.Contains("no scene or prefab of the project has DesignUiGammaComposite", GammaCompositeUsage.Warning(_profile, _dir));
            File.WriteAllText(_dir + "/Main.unity", "m_Script: {fileID: 11500000, guid: " + AssetDatabase.AssetPathToGUID(GammaCompositeUsage.ScriptPath) + ", type: 3}\n");
            Assert.IsNull(GammaCompositeUsage.Warning(_profile, _dir), "the component is there");
            File.Delete(_dir + "/Main.unity");
            _profile.colorPath = DesignColorPath.LinearPanel;
            Assert.IsNull(GammaCompositeUsage.Warning(_profile, _dir), "the profile says the game shows an ordinary panel (verify warns about that itself)");
        }
    }
}
