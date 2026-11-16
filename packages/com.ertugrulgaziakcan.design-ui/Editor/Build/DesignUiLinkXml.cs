using System.IO;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.UnityLinker;

namespace DesignUi.Editor
{
    /// <summary>
    /// Hands the package's <c>Runtime/link.xml</c> to a player build's code stripping: it keeps the internal Unity members the
    /// runtime reaches by reflection (text measurement, font twins, the overlay order and the gamma composite), which a
    /// stripped player would otherwise lose (each has a fallback, but the fallback draws differently).
    /// </summary>
    public sealed class DesignUiLinkXml : IUnityLinkerProcessor
    {
        public int callbackOrder => 0;

        public string GenerateAdditionalLinkXmlFile(BuildReport report, UnityLinkerBuildPipelineData data)
        {
            var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(DesignUiLinkXml).Assembly);
            return info == null ? null : Path.GetFullPath(Path.Combine(info.resolvedPath, "Runtime", "link.xml"));
        }
    }
}
