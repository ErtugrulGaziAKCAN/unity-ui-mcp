using System.Runtime.CompilerServices;
using UnityEngine.TestTools;

// the Unity Localization tests reuse the font fixture and IR builders
[assembly: InternalsVisibleTo("DesignUi.Localization.Tests")]
// the fonts kept for the session go before and after the whole run, never between test assemblies
[assembly: PrebuildSetup(typeof(DesignUi.Editor.Tests.FontFixtureSession))]
[assembly: PostBuildCleanup(typeof(DesignUi.Editor.Tests.FontFixtureSession))]
