using System;
using System.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// <see cref="TextAssetRegistry"/>: a font asset unloaded and loaded again is not findable by the advanced text generator
    /// (Unity 6000.3 keeps the unloaded asset's entry), until it is repaired, with its fallbacks and weight faces.
    /// </summary>
    public class TextAssetRegistryTests
    {
        const string Folder = FontFixture.Folder + "/Registry";

        [TearDown]
        public void Cleanup() => FontFixture.Delete();

        [Test]
        public void Lookup_KnowsThisEditorVersion()
        {
            Assert.IsTrue(TextAssetRegistry.Supported, "TextCore's font registry was not found (" + TextAssetRegistry.Lookup + "): check whether the advanced text generator " +
                                                       "still loses reloaded font assets on Unity " + Application.unityVersion + " and extend TextAssetRegistry");
        }

        /// <summary>Twins of a regular face with a bold weight face and a fallback, saved, unloaded and loaded again.</summary>
        static (FontAsset regular, FontAsset bold, FontAsset fallback) Reloaded()
        {
            var bold = FontFixture.CreateTmp(FontFixture.BoldTtf, "Registry Bold");
            var fallback = FontFixture.CreateTmp(FontFixture.BoldTtf, "Registry Fallback");
            var regular = FontFixture.CreateTmp(FontFixture.RegularTtf, "Registry Regular");
            FontFixture.SetWeight(regular, 700, bold);
            FontFixture.SetFallbacks(regular, fallback);
            var run = new FontTwinGenerator.TwinRun(new TMPro.TMP_FontAsset[0]);
            var twin = FontTwinGenerator.GetOrCreateTwin(regular, Folder, run);
            var paths = run.Twins.Values.Select(AssetDatabase.GetAssetPath).ToList();
            foreach (var t in run.Twins.Values.ToList()) Resources.UnloadAsset(t);
            twin = null;
            GC.Collect();
            GC.WaitForPendingFinalizers();
            var loaded = paths.Select(AssetDatabase.LoadAssetAtPath<FontAsset>).ToList();
            return (loaded.Single(f => f.name == "Registry Regular UITK"), loaded.Single(f => f.name == "Registry Bold UITK"), loaded.Single(f => f.name == "Registry Fallback UITK"));
        }

        [Test]
        public void ReloadedFontAssets_AreRegisteredAgain_WithTheirFallbacksAndWeightFaces()
        {
            if (!TextAssetRegistry.Supported) Assert.Ignore(TextAssetRegistry.Lookup);
            var (regular, bold, fallback) = Reloaded();
            Assert.IsFalse(TextAssetRegistry.IsRegistered(regular), "Unity keeps the unloaded asset's entry: the reloaded one is not registered " +
                                                                  "(if this fails, Unity registers reloaded font assets now and TextAssetRegistry may go)");
            Assert.AreEqual(3, TextAssetRegistry.Repair(regular), "the font, its weight face and its fallback");
            Assert.IsTrue(TextAssetRegistry.IsRegistered(regular));
            Assert.IsTrue(TextAssetRegistry.IsRegistered(bold));
            Assert.IsTrue(TextAssetRegistry.IsRegistered(fallback));
            Assert.AreEqual(0, TextAssetRegistry.Repair(regular), "nothing left to repair");
        }

        [Test]
        public void RepairLoaded_RegistersEveryLoadedFontAsset()
        {
            if (!TextAssetRegistry.Supported) Assert.Ignore(TextAssetRegistry.Lookup);
            var (regular, bold, fallback) = Reloaded();
            Assert.GreaterOrEqual(TextAssetRegistry.RepairLoaded(), 3);
            Assert.IsTrue(new[] { regular, bold, fallback }.All(TextAssetRegistry.IsRegistered));
        }
    }
}
