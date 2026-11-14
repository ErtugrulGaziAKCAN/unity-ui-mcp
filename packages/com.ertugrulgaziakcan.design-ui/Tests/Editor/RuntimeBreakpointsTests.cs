using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using static DesignUi.Editor.Tests.TestIr;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The design's <c>@media</c> breakpoints at runtime: the compiler writes them on the screen root, and the root applies
    /// their <c>bp-*</c> classes from its panel's size, as the verifier applies them, again whenever the panel is resized.
    /// </summary>
    public class RuntimeBreakpointsTests
    {
        const string Out = "Assets/DesignUiRuntimeBreakpointsTests";

        readonly List<string> _temp = new List<string>();
        GameObject _go;
        PanelSettings _settings;
        readonly List<RenderTexture> _rts = new List<RenderTexture>();

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            foreach (var rt in _rts) if (rt != null) Object.DestroyImmediate(rt);
            _rts.Clear();
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
            FontFixture.Delete();
        }

        static IrBreakpoint[] TwoBreakpoints() => new[]
        {
            new IrBreakpoint { Name = "narrow", MaxWidth = 1600 },
            new IrBreakpoint { Name = "tall", MaxAspect = 1.2f },
        };

        static IrScreen BreakpointIr()
        {
            var hero = Node("hero", "container", ("height", "40px"), ("flex-shrink", "0"), ("background-color", "#16c2d5"))
                .With("bp:narrow", ("height", "24px"));
            var ir = Screen(Root(hero), "bp.sample");
            ir.Breakpoints = TwoBreakpoints();
            return ir;
        }

        [Test]
        public void Breakpoints_EncodeAndParse_RoundTrip_AndHoldAtTheRoundedLogicalSize()
        {
            var ir = BreakpointIr();
            var encoded = DesignBreakpoints.Encode(ScreenBuilder.BreakpointsOf(ir));
            Assert.AreEqual("narrow::1600::;tall::::" + ((double)1.2f).ToString("R", System.Globalization.CultureInfo.InvariantCulture), encoded);
            var parsed = DesignBreakpoints.Parse(encoded);
            Assert.AreEqual(2, parsed.All.Count);
            Assert.AreEqual(1600, parsed.All[0].MaxWidth);
            Assert.IsNull(parsed.All[0].MinWidth);
            CollectionAssert.AreEqual(new string[0], parsed.Active(2560, 1440).ToArray());
            CollectionAssert.AreEqual(new[] { "narrow" }, parsed.Active(1600.4, 900).ToArray(), "1600.4 rounds to 1600, as the exporter rounds it");
            CollectionAssert.AreEqual(new string[0], parsed.Active(1600.5, 900).ToArray(), "1600.5 rounds away from zero to 1601");
            CollectionAssert.AreEqual(new[] { "narrow", "tall" }, parsed.Active(1000, 1000).ToArray());
            Assert.AreEqual(1, DesignBreakpoints.Parse("narrow::1600::;broken;:1:2:3:4").All.Count, "malformed entries are left out");
        }

        [Test]
        public void Compiler_WritesTheBreakpointsOnTheScreenRoot_OnlyWhenTheDesignHasSome()
        {
            var screen = ScreenBuilder.Build(BreakpointIr(), RelativeAsset, null, null);
            Assert.AreEqual(ScreenBuilder.ScreenTag, screen.Root.Tag);
            CollectionAssert.Contains(screen.Root.Attributes,
                new KeyValuePair<string, string>("breakpoints", DesignBreakpoints.Encode(ScreenBuilder.BreakpointsOf(BreakpointIr()))));

            var none = BreakpointIr();
            none.Breakpoints = new IrBreakpoint[0];
            Assert.IsFalse(ScreenBuilder.Build(none, RelativeAsset, null, null).Root.Attributes.Any(a => a.Key == "breakpoints"));
        }

        [UnityTest]
        public IEnumerator Runtime_ResizedPanel_AppliesTheBreakpointsThatHold_AndTheirLayers()
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-bp-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(BreakpointIr(), Formatting.Indented));
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            profile.outputFolder = Out;
            FontFixture.Use(profile);
            var result = ScreenCompiler.Compile(dir, profile, false, NoView());
            Object.DestroyImmediate(profile);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));

            // a 2560×1440 panel at 1 px per logical px: no breakpoint holds
            _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = Texture(2560, 1440);
            _go = new GameObject("RuntimeBreakpointsTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            yield return Frames(2);
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/BpSample/BpSample.uxml").Instantiate();
            doc.rootVisualElement.Add(tree);
            var screen = tree.Q<DesignScreen>("root");
            Assert.IsNotNull(screen, "the compiled root is a DesignScreen");
            yield return Frames(4);
            Assert.AreEqual(new Vector2(2560, 1440), screen.panel.visualTree.layout.size);
            CollectionAssert.AreEqual(new string[0], Classes(screen), "2560×1440");
            Assert.AreEqual(40f, screen.Q("hero").resolvedStyle.height, 1e-3f);

            // narrower than 1600 logical px: bp-narrow, and its layer
            _settings.targetTexture = Texture(1280, 720);
            yield return Frames(4);
            CollectionAssert.AreEqual(new[] { "bp-narrow" }, Classes(screen), "1280×720");
            Assert.AreEqual(24f, screen.Q("hero").resolvedStyle.height, 1e-3f, "the bp:narrow layer applies");

            // 1280×720 px at scale 0.5 is 2560×1440 logical px again (a new texture makes the panel take the new scale)
            _settings.scale = 0.5f;
            _settings.targetTexture = Texture(1280, 720);
            yield return Frames(4);
            Assert.AreEqual(new Vector2(2560, 1440), screen.panel.visualTree.layout.size, "1280×720 at scale 0.5");
            CollectionAssert.AreEqual(new string[0], Classes(screen), "1280×720 at scale 0.5");
            Assert.AreEqual(40f, screen.Q("hero").resolvedStyle.height, 1e-3f);

            // both, at a square panel: the same breakpoints the verifier applies at that viewport
            _settings.scale = 1f;
            _settings.targetTexture = Texture(900, 900);
            yield return Frames(4);
            CollectionAssert.AreEqual(new[] { "bp-narrow", "bp-tall" }, Classes(screen), "900×900");
            var ir = BreakpointIr();
            ir.ReferenceViewport = new[] { 900, 900 };
            CollectionAssert.AreEqual(DesignCapture.ActiveBreakpoints(ir, new Vector2Int(900, 900)).Select(n => "bp-" + n).ToArray(), Classes(screen));

            // a detached screen stops listening; attached again it applies what holds then
            tree.RemoveFromHierarchy();
            _settings.targetTexture = Texture(2560, 1440);
            yield return Frames(2);
            CollectionAssert.AreEqual(new[] { "bp-narrow", "bp-tall" }, Classes(screen), "unchanged while detached");
            doc.rootVisualElement.Add(tree);
            yield return Frames(4);
            CollectionAssert.AreEqual(new string[0], Classes(screen), "applied again on attach");
        }

        RenderTexture Texture(int w, int h)
        {
            var rt = new RenderTexture(w, h, 24);
            _rts.Add(rt);
            return rt;
        }

        static string[] Classes(VisualElement e) => e.GetClasses().Where(c => c.StartsWith(DesignBreakpoints.ClassPrefix, StringComparison.Ordinal)).OrderBy(c => c, StringComparer.Ordinal).ToArray();

        static IEnumerator Frames(int n)
        {
            for (int i = 0; i < n; i++) yield return null;
        }
    }
}
