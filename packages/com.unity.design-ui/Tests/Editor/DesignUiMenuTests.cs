using System.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The menu items' choices that do not need a dialog: which profile an item uses (<see cref="DesignUiMenu.ProfileFor"/>),
    /// the kit folder of Kit Sync and the dialog text of a result.
    /// </summary>
    public class DesignUiMenuTests
    {
        const string ProfilePath = FontFixture.Folder + "/Menu Profile.asset";

        [TearDown]
        public void Cleanup() => AssetDatabase.DeleteAsset(ProfilePath);

        [OneTimeTearDown]
        public void DeleteFolder() => FontFixture.Delete();

        DesignUiProfile Created()
        {
            if (!AssetDatabase.IsValidFolder(FontFixture.Folder)) AssetDatabase.CreateFolder("Assets", FontFixture.Folder.Substring("Assets/".Length));
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            AssetDatabase.CreateAsset(p, ProfilePath);
            return p;
        }

        [Test]
        public void ProfileFor_TheSelectedProfile_WinsOverTheProjectsProfiles()
        {
            var selected = Created();
            Assert.AreEqual(ProfilePath, DesignUiMenu.ProfileFor(selected, new[] { "Assets/A.asset", "Assets/B.asset" }, out var message));
            Assert.IsNull(message);
        }

        [Test]
        public void ProfileFor_WithoutASelectedProfile_TakesTheProjectsOnlyOne_OrSaysWhyNot()
        {
            Assert.AreEqual("Assets/A.asset", DesignUiMenu.ProfileFor(null, new[] { "Assets/A.asset" }, out var one));
            Assert.IsNull(one);

            var texture = new Texture2D(1, 1);
            try { Assert.AreEqual("Assets/A.asset", DesignUiMenu.ProfileFor(texture, new[] { "Assets/A.asset" }, out _), "a selection that is no profile is ignored"); }
            finally { Object.DestroyImmediate(texture); }

            Assert.IsNull(DesignUiMenu.ProfileFor(null, new string[0], out var none));
            StringAssert.Contains("no DesignUiProfile", none);
            StringAssert.Contains("Assets > Create > Design UI > Profile", none);

            Assert.IsNull(DesignUiMenu.ProfileFor(null, new[] { "Assets/A.asset", "Assets/B.asset" }, out var several));
            StringAssert.Contains("several DesignUiProfiles (Assets/A.asset, Assets/B.asset)", several);
            StringAssert.Contains("select the one to use", several);
        }

        [Test]
        public void KitFolder_IsTheProfilesKit_ElseNothing()
        {
            var p = Created();
            p.kitDir = "../design-kit";
            Assert.AreEqual("../design-kit", DesignUiMenu.KitFolder(p));
            p.kitDir = "  ";
            Assert.IsNull(DesignUiMenu.KitFolder(p));
        }

        [Test]
        public void DialogText_IsTheResultsFirstLinesAndPointsToTheConsole()
        {
            var ok = DesignUiMenu.DialogText(new OpResult(0, "Imported a into b: 3 files written (12 ms).\nwritten: x, y, z"));
            StringAssert.StartsWith("Imported a into b: 3 files written (12 ms).", ok);
            StringAssert.Contains("Console", ok);

            var many = string.Join("\n", Enumerable.Range(1, 30).Select(i => "error: line " + i));
            var failed = DesignUiMenu.DialogText(new OpResult(1, many));
            StringAssert.Contains("error: line 1\n", failed);
            StringAssert.DoesNotContain("error: line 30", failed);
            StringAssert.Contains("more lines", failed);
        }
    }
}
