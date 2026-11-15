using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>
    /// A player build writes loaded objects as they are in memory: before it every PanelSettings a design screen holds gets
    /// its own scale factor back (DesignRootScalePanels). In the Editor outside Play mode nothing that a build includes is
    /// ever held (only <c>DontSave</c> copies are), so this finds nothing unless a player build starts while Play mode holds
    /// a factor; then it gives it back and says so. It runs for player builds only (<c>IPreprocessBuildWithReport</c>):
    /// Unity's <c>BuildPipeline.BuildAssetBundles</c> refuses to run in Play mode, but a Scriptable Build Pipeline or
    /// Addressables content build started in Play mode is not guarded, and a preset or asset copy made while held carries
    /// the factor (documented: build content outside Play mode).
    /// </summary>
    internal sealed class RootScaleBuildGuard : IPreprocessBuildWithReport
    {
        public int callbackOrder => 0;

        public void OnPreprocessBuild(BuildReport report) => BeforeBuild();

        /// <summary>Gives back every held factor; returns how many were held (tests).</summary>
        internal static int BeforeBuild()
        {
            int n = DesignRootScalePanels.BeforeBuild();
            if (n > 0)
                Debug.LogWarning("Design UI: a build started while " + n + " PanelSettings held a design screen's exact-scale factor; each got its own scale factor back before the build.");
            return n;
        }
    }
}
