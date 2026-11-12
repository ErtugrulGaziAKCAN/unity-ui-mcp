// M0 spike (throwaway, deleted in Task 4): captures the 14 UI Toolkit twins of spike/fixtures (R4-R8).
// Run through scripts/unity-check.sh --warm --editmode "DesignUi.Spike". The twins are copied from the repo's
// spike/fixtures into Assets/Spike/Generated at test time (clone only). Outputs go to <repo>/spike/out/unity
// (override: SPIKE_OUT). SPIKE_ROUTE=play|editmode picks the capture route (default play), SPIKE_TARGET the
// RenderTexture setup of the default captures (default SrgbRt), SPIKE_ONLY a regex on fixture names.
// This project reloads the domain on entering/exiting Play: the test enumerator is serialized across
// EnterPlayMode/ExitPlayMode and statics are reset, so all state is rebuilt lazily (Init) and findings are
// appended to files as they are measured.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using NUnit.Framework;
using Unity.VectorGraphics.Editor;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.TextCore.LowLevel;
using UnityEngine.TextCore.Text;
using UnityEngine.UIElements;
using TextElement = UnityEngine.UIElements.TextElement;

namespace DesignUi.Spike.Tests
{
    public class SpikeCaptureTests
    {
        const string Generated = "Assets/Spike/Generated";
        const string FixtureFolder = Generated + "/Fixtures";
        const string RegularTtf = "Assets/Fonts/Inter/Inter_18pt-Regular.ttf";
        const string BoldTtf = "Assets/Fonts/Inter/Inter_18pt-Bold.ttf";
        // Reference TMP font asset settings of the first consumer project (read-only): sampling point size 72,
        // padding 7, SDFAA (4165), multi-atlas; regular atlas 2048x2048 (static), bold atlas 1024x1024 (dynamic).
        const int Sampling = 72, Padding = 7, AtlasRegular = 2048, AtlasBold = 1024;

        public static readonly string[] Fixtures =
        {
            "f01-row-fixed", "f02-flex-grow-shrink", "f03-percent-auto-parent", "f04-min-size-shrink",
            "f05-absolute-in-flex", "f06-wrap-margins", "f07-text-lines", "f08-bold-synthetic", "f09-font-metrics",
            "f10-solid-colors-alpha", "f11-gradients", "f12-box-shadow", "f13-hover-active", "f14-radius-border",
        };

        static string s_Repo;
        static FontAsset s_Inter;        // Regular + weight table 700 -> Bold asset
        static FontAsset s_InterBold;
        static FontAsset s_InterRegularOnly; // no weight table: bold is synthesized
        static readonly Dictionary<string, VectorImage> s_Gradients = new Dictionary<string, VectorImage>();
        static readonly List<string> s_Log = new List<string>();

        static bool Play => (Environment.GetEnvironmentVariable("SPIKE_ROUTE") ?? "play") != "editmode";
        static SpikeTarget DefaultTarget
        {
            get
            {
                var env = Environment.GetEnvironmentVariable("SPIKE_TARGET");
                return string.IsNullOrEmpty(env) ? SpikeTarget.SrgbRt : (SpikeTarget)Enum.Parse(typeof(SpikeTarget), env);
            }
        }
        static bool Selected(string fixture)
        {
            var only = Environment.GetEnvironmentVariable("SPIKE_ONLY");
            return string.IsNullOrEmpty(only) || Regex.IsMatch(fixture, only);
        }

        static bool s_Hooked;
        static int s_Logged;

        static void OnLog(string message, string stack, LogType type)
        {
            if (type == LogType.Log && !message.Contains("[Spike]")) return;
            var line = type + ": " + message;
            lock (s_Log) s_Log.Add(line);
            if (SpikeCapture.OutRoot != null && s_Logged++ < 400) Note("engine-log", line.Length > 600 ? line.Substring(0, 600) + " ..." : line);
        }

        static string FindingPath(string name)
        {
            var dir = Path.Combine(SpikeCapture.OutRoot, "_findings");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, name + ".txt");
        }

        static void Finding(string name, string text) => File.WriteAllText(FindingPath(name), text);
        static void Note(string name, string line) => File.AppendAllText(FindingPath(name), line + "\n");

        /// <summary>Rebuilds static state after a domain reload (repo path, output root, log hook, font twins).</summary>
        static void Init()
        {
            if (!s_Hooked) { Application.logMessageReceived += OnLog; s_Hooked = true; }
            if (SpikeCapture.OutRoot == null)
            {
                // The clone's manifest points at the package with an absolute file: path, so the package path finds the repo.
                var pkg = UnityEditor.PackageManager.PackageInfo.FindForAssetPath("Packages/com.unity.design-ui");
                Assert.NotNull(pkg, "com.unity.design-ui not resolved");
                s_Repo = Path.GetFullPath(Path.Combine(pkg.resolvedPath, "..", ".."));
                var env = Environment.GetEnvironmentVariable("SPIKE_OUT");
                SpikeCapture.OutRoot = string.IsNullOrEmpty(env) ? Path.Combine(s_Repo, "spike", "out", "unity") : env;
                Directory.CreateDirectory(SpikeCapture.OutRoot);
            }
            if (s_Inter == null)
            {
                var regular = AssetDatabase.LoadAssetAtPath<Font>(RegularTtf);
                var bold = AssetDatabase.LoadAssetAtPath<Font>(BoldTtf);
                Assert.NotNull(regular, RegularTtf);
                Assert.NotNull(bold, BoldTtf);
                s_Inter = SpikeCapture.CreateDynamicFontAsset(regular, "Inter-Regular-dyn", Sampling, Padding, GlyphRenderMode.SDFAA, AtlasRegular);
                s_InterBold = SpikeCapture.CreateDynamicFontAsset(bold, "Inter-Bold-dyn", Sampling, Padding, GlyphRenderMode.SDFAA, AtlasBold);
                s_InterRegularOnly = SpikeCapture.CreateDynamicFontAsset(regular, "Inter-RegularOnly-dyn", Sampling, Padding, GlyphRenderMode.SDFAA, AtlasRegular);
                var table = s_Inter.fontWeightTable; // FontWeightPair[]: element assignment edits the asset's own table
                table[7].regularTypeface = s_InterBold;
            }
        }

        // ------------------------------------------------------------------ setup

        [OneTimeSetUp]
        public void SetUp()
        {
            LogAssert.ignoreFailingMessages = true; // importer errors are findings, not setup failures
            SpikeCapture.OutRoot = null;
            Init();
            // OneTimeSetUp runs again after the Play-mode domain reload; clear old findings once per editor session.
            var findings = Path.Combine(SpikeCapture.OutRoot, "_findings");
            if (!SessionState.GetBool("spike.findings.cleared", false) && Directory.Exists(findings)) Directory.Delete(findings, true);
            SessionState.SetBool("spike.findings.cleared", true);
            Note("setup", "OneTimeSetUp at " + DateTime.UtcNow.ToString("O") + " isPlaying=" + Application.isPlaying);

            // twins: spike/fixtures/*.uxml + *.uss -> Assets/Spike/Generated/Fixtures (clone only)
            if (!AssetDatabase.IsValidFolder(Generated)) AssetDatabase.CreateFolder("Assets/Spike", "Generated");
            if (!AssetDatabase.IsValidFolder(FixtureFolder)) AssetDatabase.CreateFolder(Generated, "Fixtures");
            var src = Path.Combine(s_Repo, "spike", "fixtures");
            foreach (var ext in new[] { ".uss", ".uxml" })
                foreach (var f in Fixtures)
                {
                    var asset = FixtureFolder + "/" + f + ext;
                    File.Copy(Path.Combine(src, f + ext), asset, true);
                    AssetDatabase.ImportAsset(asset, ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
                }
        }

        [OneTimeTearDown]
        public void TearDown()
        {
            Application.logMessageReceived -= OnLog;
            s_Hooked = false;
        }

        [SetUp]
        public void PerTest() { LogAssert.ignoreFailingMessages = true; Init(); } // findings are recorded; engine errors must not hide outputs

        // ------------------------------------------------------------------ helpers

        static VisualTreeAsset Twin(string fixture)
        {
            var vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(FixtureFolder + "/" + fixture + ".uxml");
            Assert.NotNull(vta, fixture);
            return vta;
        }

        static void ApplyFonts(SpikeSession s, string fixture)
        {
            s.TwinRoot.style.unityFontDefinition = FontDefinition.FromSDFFont(s_Inter);
            if (fixture == "f08-bold-synthetic")
            {
                s.TwinRoot.Q("f08-bold-synth").style.unityFontDefinition = FontDefinition.FromSDFFont(s_InterRegularOnly);
                s.TwinRoot.Q("f08-bold-synth-sm").style.unityFontDefinition = FontDefinition.FromSDFFont(s_InterRegularOnly);
            }
        }

        static SpikeSession Open(string fixture, SpikeTarget mode, Action<SpikeSession> customize = null)
        {
            Init();
            LogAssert.ignoreFailingMessages = true;
            var s = SpikeCapture.Mount(Twin(fixture), mode);
            ApplyFonts(s, fixture);
            if (fixture == "f11-gradients") ApplyGradients(s);
            SpikeCapture.HookGlyphs(s);
            customize?.Invoke(s);
            return s;
        }

        /// <summary>Frames until the twin is laid out, stretched and rendered, public API only. Play: player-loop
        /// frames. EditMode: editor update ticks (R5 showed they render RT panels in batchmode too, pixel-identical).</summary>
        static IEnumerable Settle(SpikeSession s, bool play, int frames = 3)
        {
            int n = play ? 2 : 10;
            for (int i = 0; i < n; i++) yield return null;
            SpikeCapture.EnsureStretched(s);
            n = play ? frames : 10;
            for (int i = 0; i < n; i++) yield return null;
        }

        static IEnumerable Frames(SpikeSession s, bool play, int frames)
        {
            int n = play ? frames : Math.Max(frames, 5);
            for (int i = 0; i < n; i++) yield return null;
        }

        static Texture2D Save(SpikeSession s, string fixture, string suffix, string state, string route)
        {
            var dir = SpikeCapture.FixtureDir(fixture);
            var tex = SpikeCapture.ReadBack(s.Target, SpikeReadback.ReadPixels);
            SpikeCapture.WritePng(tex, Path.Combine(dir, "unity" + suffix + ".png"));
            var meta = SpikeCapture.EnvMeta(s);
            meta["readback"] = "ReadPixels into Texture2D(RGBA32, linear:true), EncodeToPNG";
            meta["route"] = route;
            File.WriteAllText(Path.Combine(dir, "unity" + suffix + "-boxes.json"), SpikeCapture.BoxesJson(s, fixture, state, meta));
            return tex;
        }

        static string RouteName(bool play) => play
            ? "EditMode test -> EnterPlayMode; UIDocument + PanelSettings.targetTexture rendered by the player loop (public API)"
            : "EditMode test; UIDocument + PanelSettings.targetTexture rendered on editor update ticks (public API)";

        static int DiffPixels(Texture2D a, Texture2D b, int tolerance)
        {
            var pa = a.GetPixels32(); var pb = b.GetPixels32();
            int n = 0;
            for (int i = 0; i < pa.Length; i++)
                if (Math.Abs(pa[i].r - pb[i].r) > tolerance || Math.Abs(pa[i].g - pb[i].g) > tolerance || Math.Abs(pa[i].b - pb[i].b) > tolerance) n++;
            return n;
        }

        /// <summary>Centre pixel of the first named leaf with an opaque background vs its resolved (authored) colour.</summary>
        static string Probe(SpikeSession s, Texture2D tex)
        {
            var leaf = SpikeCapture.Walk(s.TwinRoot).FirstOrDefault(v => v != s.TwinRoot && !string.IsNullOrEmpty(v.name) && v.childCount == 0 && v.resolvedStyle.backgroundColor.a > 0.99f);
            int magenta = SpikeCapture.CountColor(tex, new Color32(255, 0, 255, 255));
            if (leaf == null) return "magenta=" + magenta;
            var c = leaf.worldBound.center;
            return string.Format(CultureInfo.InvariantCulture, "magenta={0} {1}@({2},{3}) pixel={4} resolved={5}", magenta, leaf.name, (int)c.x, (int)c.y,
                SpikeCapture.Hex(SpikeCapture.Sample(tex, (int)c.x, (int)c.y)), SpikeCapture.Hex((Color32)leaf.resolvedStyle.backgroundColor));
        }

        // ------------------------------------------------------------------ R5: capture routes

        static Texture2D LoadPng(string path)
        {
            var t = new Texture2D(2, 2, TextureFormat.RGBA32, false, true) { hideFlags = HideFlags.DontSave };
            t.LoadImage(File.ReadAllBytes(path));
            return t;
        }

        [UnityTest]
        public IEnumerator A_R5_Routes()
        {
            const string N = "r5-route";
            Note(N, "graphicsDeviceType=" + SystemInfo.graphicsDeviceType + " name=" + SystemInfo.graphicsDeviceName + " version=" + SystemInfo.graphicsDeviceVersion);
            Note(N, "batchMode=" + Application.isBatchMode + " colorSpace=" + QualitySettings.activeColorSpace + " unity=" + Application.unityVersion
                    + " enterPlayModeOptionsEnabled=" + EditorSettings.enterPlayModeOptionsEnabled + " enterPlayModeOptions=" + EditorSettings.enterPlayModeOptions);
            var dir = SpikeCapture.FixtureDir("_r5");
            var sw = new Stopwatch();

            foreach (var fx in new[] { "f01-row-fixed", "f07-text-lines" })
            {
                // 1) EditMode, public API only: editor update ticks, no explicit repaint
                using (var s = Open(fx, SpikeTarget.SrgbRt))
                {
                    for (int i = 0; i < 10; i++) yield return null;
                    var t = SpikeCapture.ReadBack(s.Target, SpikeReadback.ReadPixels);
                    Note(N, fx + " editmode-public (10 editor ticks, no stretch): docRoot=" + SpikeCapture.R(s.Document.rootVisualElement.worldBound) + " #root=" + SpikeCapture.R(s.TwinRoot.worldBound) + " " + Probe(s, t));
                    SpikeCapture.WritePng(t, Path.Combine(dir, fx + "-editmode-public.png"));
                    bool st = SpikeCapture.EnsureStretched(s);
                    for (int i = 0; i < 10; i++) yield return null;
                    t = SpikeCapture.ReadBack(s.Target, SpikeReadback.ReadPixels);
                    Note(N, fx + " editmode-public (+stretch " + st + ", +10 editor ticks): docRoot=" + SpikeCapture.R(s.Document.rootVisualElement.worldBound) + " " + Probe(s, t));
                    SpikeCapture.WritePng(t, Path.Combine(dir, fx + "-editmode-public-stretched.png"));
                }
                // 2) EditMode, internal RepaintPanel + RenderPanel
                using (var s = Open(fx, SpikeTarget.SrgbRt))
                {
                    sw.Restart();
                    SpikeCapture.Pump(s, 1);
                    var before = SpikeCapture.R(s.Document.rootVisualElement.worldBound);
                    bool stretched = SpikeCapture.EnsureStretched(s);
                    SpikeCapture.Pump(s, 2);
                    var renderMs = sw.ElapsedMilliseconds;
                    sw.Restart();
                    var a = SpikeCapture.ReadBack(s.Target, SpikeReadback.ReadPixels);
                    var readMs = sw.ElapsedMilliseconds;
                    sw.Restart();
                    var b = SpikeCapture.ReadBack(s.Target, SpikeReadback.AsyncGpu);
                    var asyncMs = sw.ElapsedMilliseconds;
                    sw.Restart();
                    SpikeCapture.WritePng(a, Path.Combine(dir, fx + "-editmode-internal.png"));
                    var pngMs = sw.ElapsedMilliseconds;
                    Note(N, fx + " editmode-internal: docRoot after 1st pass=" + before + " stretchApplied=" + stretched + " #root=" + SpikeCapture.R(s.TwinRoot.worldBound) + " " + Probe(s, a));
                    Note(N, fx + " editmode-internal: ReadPixels vs AsyncGPUReadback(raw) differing pixels (tol 0): " + DiffPixels(a, b, 0) + " of " + a.width * a.height + "; AsyncGPU " + Probe(s, b));
                    Note(N, fx + " timings ms: render(3 passes)=" + renderMs + " ReadPixels=" + readMs + " AsyncGPU=" + asyncMs + " EncodeToPNG+write=" + pngMs);
                    SpikeCapture.WritePng(b, Path.Combine(dir, fx + "-editmode-internal-asyncgpu.png"));
                    Note(N, fx + " editmode-public(stretched) vs editmode-internal differing pixels: tol0=" + DiffPixels(a, LoadPng(Path.Combine(dir, fx + "-editmode-public-stretched.png")), 0));
                }
            }

            // 3) Play mode entered from the EditMode test, public API only (player loop renders the RT panel)
            SessionState.SetString("spike.r5.t0", DateTime.UtcNow.Ticks.ToString(CultureInfo.InvariantCulture));
            yield return new EnterPlayMode();
            Init();
            var ms = (DateTime.UtcNow.Ticks - long.Parse(SessionState.GetString("spike.r5.t0", "0"), CultureInfo.InvariantCulture)) / TimeSpan.TicksPerMillisecond;
            Note(N, "EnterPlayMode took " + ms + " ms; isPlaying=" + Application.isPlaying);
            foreach (var fx in new[] { "f01-row-fixed", "f07-text-lines" })
            {
                var d = SpikeCapture.FixtureDir("_r5");
                using (var s = Open(fx, SpikeTarget.SrgbRt))
                {
                    int frame0 = Time.frameCount;
                    yield return null;
                    var t1 = SpikeCapture.ReadBack(s.Target, SpikeReadback.ReadPixels);
                    Note(N, fx + " play after 1 frame: docRoot=" + SpikeCapture.R(s.Document.rootVisualElement.worldBound) + " " + Probe(s, t1));
                    foreach (var _ in Settle(s, true)) yield return null;
                    var t = SpikeCapture.ReadBack(s.Target, SpikeReadback.ReadPixels);
                    Note(N, fx + " play settled (" + (Time.frameCount - frame0) + " frames): docRoot before stretch=" + s.DocRootBefore + " stretchApplied=" + s.StretchApplied + " #root=" + SpikeCapture.R(s.TwinRoot.worldBound) + " " + Probe(s, t));
                    SpikeCapture.WritePng(t, Path.Combine(d, fx + "-play.png"));
                    var em = LoadPng(Path.Combine(d, fx + "-editmode-internal.png"));
                    Note(N, fx + " play vs editmode-internal differing pixels: tol0=" + DiffPixels(t, em, 0) + " tol2=" + DiffPixels(t, em, 2));
                }
            }
            yield return new ExitPlayMode();
            Init();
            Note(N, "ExitPlayMode done; isPlaying=" + Application.isPlaying);
        }

        // ------------------------------------------------------------------ R4: font twin + TMP_FontAsset

        [Test]
        public void B_R4_FontTwin()
        {
            var f = new StringBuilder();
            f.AppendLine("API: FontAsset.CreateFontAsset(Font, samplingPointSize, atlasPadding, GlyphRenderMode, atlasWidth, atlasHeight, AtlasPopulationMode.Dynamic, enableMultiAtlasSupport: true)");
            f.AppendLine("regular: " + SpikeCapture.DescribeFace(s_Inter));
            f.AppendLine("bold:    " + SpikeCapture.DescribeFace(s_InterBold));
            f.AppendLine("weightTable[7].regularTypeface == bold asset after element assignment: " + (s_Inter.fontWeightTable[7].regularTypeface == s_InterBold));
            var fi = s_Inter.faceInfo;
            f.AppendLine("per font-size px (faceInfo scaled by size/pointSize): size lineHeight ascent descent(abs) ascent+descent");
            foreach (var px in new[] { 12, 14, 16, 18, 20, 24, 28, 32, 40, 48 })
            {
                float k = px / fi.pointSize;
                f.AppendLine(string.Format(CultureInfo.InvariantCulture, "  {0} {1:0.###} {2:0.###} {3:0.###} {4:0.###}", px, fi.lineHeight * k, fi.ascentLine * k, -fi.descentLine * k, (fi.ascentLine - fi.descentLine) * k));
            }

            var allowed = typeof(FontDefinition).GetProperty("allowedAssetTypes", BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null) as IEnumerable<Type>;
            f.AppendLine("FontDefinition.allowedAssetTypes (INTERNAL, used by the USS importer for url()): " + (allowed == null ? "?" : string.Join(", ", allowed.Select(t => t.FullName))));
            var tmpType = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TMPro.TMP_FontAsset")).FirstOrDefault(t => t != null);
            f.AppendLine("TMPro.TMP_FontAsset: " + (tmpType == null ? "not loaded" : tmpType.AssemblyQualifiedName));
            if (tmpType != null)
            {
                var chain = new List<string>();
                for (var t = tmpType; t != null; t = t.BaseType) chain.Add(t.FullName);
                f.AppendLine("TMP_FontAsset base chain: " + string.Join(" -> ", chain));
                chain.Clear();
                for (var t = typeof(FontAsset); t != null; t = t.BaseType) chain.Add(t.FullName);
                f.AppendLine("TextCore FontAsset base chain: " + string.Join(" -> ", chain));
                f.AppendLine("typeof(TextCore FontAsset).IsAssignableFrom(TMP_FontAsset): " + typeof(FontAsset).IsAssignableFrom(tmpType)
                             + " -> FontDefinition.FromSDFFont(FontAsset) cannot take a TMP_FontAsset at compile time");
                UnityEngine.Object tmp = null;
                var create = tmpType.GetMethod("CreateFontAsset", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(Font) }, null);
                try { tmp = (UnityEngine.Object)create?.Invoke(null, new object[] { AssetDatabase.LoadAssetAtPath<Font>(RegularTtf) }); f.AppendLine("TMP_FontAsset.CreateFontAsset(Font): " + (tmp == null ? "null" : "ok")); }
                catch (Exception ex) { f.AppendLine("TMP_FontAsset.CreateFontAsset(Font) threw " + (ex.InnerException ?? ex).GetType().Name + ": " + (ex.InnerException ?? ex).Message); }
                if (tmp == null) { tmp = ScriptableObject.CreateInstance(tmpType); f.AppendLine("fallback: ScriptableObject.CreateInstance(TMP_FontAsset)"); }
                try
                {
                    var def = typeof(FontDefinition).GetMethod("FromObject", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { tmp });
                    var fd = (FontDefinition)def;
                    f.AppendLine("FontDefinition.FromObject(TMP asset) (INTERNAL): font=" + (fd.font == null ? "null" : fd.font.name) + " fontAsset=" + (fd.fontAsset == null ? "null" : fd.fontAsset.name));
                }
                catch (Exception ex) { f.AppendLine("FontDefinition.FromObject(TMP asset) threw " + (ex.InnerException ?? ex).GetType().Name + ": " + (ex.InnerException ?? ex).Message); }
                try { var cast = (FontAsset)(object)tmp; f.AppendLine("cast to TextCore FontAsset succeeded: " + cast); }
                catch (Exception ex) { f.AppendLine("(FontAsset)tmpAsset threw " + ex.GetType().Name); }

                // USS path: url() to a saved TMP asset, imported by the USS importer
                var assetPath = Generated + "/TmpProbe.asset";
                AssetDatabase.DeleteAsset(assetPath);
                AssetDatabase.CreateAsset(tmp, assetPath);
                AssetDatabase.SaveAssetIfDirty(tmp);
                var ussPath = Generated + "/tmp-font.uss";
                lock (s_Log) s_Log.Clear();
                File.WriteAllText(ussPath, "#probe { -unity-font-definition: url(\"project://database/" + assetPath + "\"); font-size: 32px; }\n");
                AssetDatabase.ImportAsset(ussPath, ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
                var sheet = AssetDatabase.LoadAssetAtPath<StyleSheet>(ussPath);
                string logs; lock (s_Log) logs = string.Join(" | ", s_Log.Where(l => !l.StartsWith("Log")));
                f.AppendLine("USS -unity-font-definition: url(<TMP asset>): import " + (sheet == null ? "FAILED (no StyleSheet)" : "produced a StyleSheet") + "; warnings/errors: " + (logs.Length == 0 ? "none" : logs));
                if (sheet != null)
                {
                    using (var s = SpikeCapture.Mount(Twin("f09-font-metrics"), SpikeTarget.SrgbRt))
                    {
                        var probe = new Label("Hxgy Wag") { name = "probe" };
                        probe.styleSheets.Add(sheet);
                        s.TwinRoot.Add(probe);
                        SpikeCapture.Pump(s, 2);
                        var rd = probe.resolvedStyle.unityFontDefinition;
                        f.AppendLine("Label with that sheet: resolved font=" + (rd.font == null ? "null" : rd.font.name) + " fontAsset=" + (rd.fontAsset == null ? "null" : rd.fontAsset.name)
                                     + " fontSize=" + probe.resolvedStyle.fontSize + " worldBound=" + SpikeCapture.R(probe.worldBound));
                    }
                }
            }
            Finding("r4-font-twin", f.ToString());
        }

        // ------------------------------------------------------------------ R8: SVG gradients as VectorImage

        static readonly (string id, string body)[] GradientSvgs =
        {
            ("f11-l90", "<linearGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"400\" y2=\"0\"><stop offset=\"0\" stop-color=\"#1f8a70\"/><stop offset=\"1\" stop-color=\"#2c6fbb\"/></linearGradient>"),
            ("f11-l180", "<linearGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"200\"><stop offset=\"0\" stop-color=\"#00e5ff\"/><stop offset=\"1\" stop-color=\"#0b1f26\"/></linearGradient>"),
            // CSS 45deg on 400x200: gradient line length 400*sin45 + 200*cos45 = 424.264, centred at (200,100)
            ("f11-l45", "<linearGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" x1=\"50\" y1=\"250\" x2=\"350\" y2=\"-50\"><stop offset=\"0\" stop-color=\"#c0572b\"/><stop offset=\"1\" stop-color=\"#d4a017\"/></linearGradient>"),
            ("f11-l3", "<linearGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"400\" y2=\"0\"><stop offset=\"0\" stop-color=\"#ff0000\"/><stop offset=\"0.5\" stop-color=\"#00ff00\"/><stop offset=\"1\" stop-color=\"#0000ff\"/></linearGradient>"),
            ("f11-lalpha", "<linearGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"400\" y2=\"0\"><stop offset=\"0\" stop-color=\"#ffffff\" stop-opacity=\"0\"/><stop offset=\"1\" stop-color=\"#ffffff\" stop-opacity=\"0.8\"/></linearGradient>"),
            ("f11-lhard", "<linearGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"400\" y2=\"0\"><stop offset=\"0\" stop-color=\"#1f8a70\"/><stop offset=\"0.5\" stop-color=\"#1f8a70\"/><stop offset=\"0.5\" stop-color=\"#2c6fbb\"/><stop offset=\"1\" stop-color=\"#2c6fbb\"/></linearGradient>"),
            // CSS circle farthest-corner from the centre: r = sqrt(200^2 + 100^2) = 223.607
            ("f11-rcircle", "<radialGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" cx=\"200\" cy=\"100\" r=\"223.607\"><stop offset=\"0\" stop-color=\"#00e5ff\"/><stop offset=\"1\" stop-color=\"#0b1f26\"/></radialGradient>"),
            // CSS ellipse farthest-corner: rx = 200*sqrt2 = 282.843, ry = 100*sqrt2 = 141.421
            ("f11-rellipse", "<radialGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" cx=\"200\" cy=\"100\" r=\"282.843\" gradientTransform=\"translate(200 100) scale(1 0.5) translate(-200 -100)\"><stop offset=\"0\" stop-color=\"#d4a017\"/><stop offset=\"1\" stop-color=\"#d4a017\" stop-opacity=\"0\"/></radialGradient>"),
            // CSS circle at 25% 25% (100,50), farthest corner (400,200): r = sqrt(300^2 + 150^2) = 335.410; second stop at 70%
            ("f11-roff", "<radialGradient id=\"g\" gradientUnits=\"userSpaceOnUse\" cx=\"100\" cy=\"50\" r=\"335.410\"><stop offset=\"0\" stop-color=\"#8e44ad\"/><stop offset=\"0.7\" stop-color=\"#0b1f26\"/></radialGradient>"),
        };

        static string Svg(string body) =>
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"400\" height=\"200\" viewBox=\"0 0 400 200\"><defs>" + body +
            "</defs><rect x=\"0\" y=\"0\" width=\"400\" height=\"200\" fill=\"url(#g)\"/></svg>\n";

        /// <summary>Writes the f11 gradients as SVG files under Assets/Spike/Generated and imports them with the core
        /// SVG importer set to the UI Toolkit vector image type. Returns the importer log.</summary>
        static string ImportGradients()
        {
            var f = new StringBuilder();
            var svgOut = Path.Combine(SpikeCapture.FixtureDir("f11-gradients"), "svg");
            Directory.CreateDirectory(svgOut);
            if (!AssetDatabase.IsValidFolder(Generated)) AssetDatabase.CreateFolder("Assets/Spike", "Generated");
            foreach (var (id, body) in GradientSvgs)
            {
                var path = Generated + "/" + id + ".svg";
                AssetDatabase.DeleteAsset(path);
                var text = Svg(body);
                File.WriteAllText(path, text);
                File.WriteAllText(Path.Combine(svgOut, id + ".svg"), text);
                AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
                var importer = AssetImporter.GetAtPath(path);
                f.Append(id).Append(": importer=").Append(importer == null ? "null" : importer.GetType().FullName);
                if (importer is SVGImporter svg)
                {
                    f.Append(" firstImport SvgType=").Append(svg.SvgType).Append(" mainAsset=").Append(AssetDatabase.LoadMainAssetAtPath(path)?.GetType().Name ?? "null");
                    svg.SvgType = SVGType.VectorImage;
                    svg.SaveAndReimport();
                    var re = (SVGImporter)AssetImporter.GetAtPath(path);
                    f.Append(" -> SvgType=").Append(re.SvgType).Append(" (").Append((int)re.SvgType).Append(")")
                     .Append(" gradientResolution=").Append(re.GradientResolution)
                     .Append(" tessellation=").Append(re.TessellationMode)
                     .Append(" preserveViewport=").Append(re.PreserveViewport);
                }
                var vi = AssetDatabase.LoadAssetAtPath<VectorImage>(path);
                f.Append(" VectorImage=").Append(vi == null ? "null" : vi.width + "x" + vi.height);
                f.AppendLine();
                s_Gradients[id] = vi;
            }
            return f.ToString();
        }

        static bool GradientsImported() =>
            GradientSvgs.All(g => AssetDatabase.LoadAssetAtPath<VectorImage>(Generated + "/" + g.id + ".svg") != null);

        [Test]
        public void C_R8_SvgImport()
        {
            s_Gradients.Clear();
            Finding("r8-svg-import", ImportGradients());
            Assert.IsTrue(s_Gradients.Values.All(v => v != null), "some SVGs did not import as VectorImage");
        }

        static void ApplyGradients(SpikeSession s)
        {
            foreach (var (id, _) in GradientSvgs)
            {
                var vi = AssetDatabase.LoadAssetAtPath<VectorImage>(Generated + "/" + id + ".svg");
                var el = s.TwinRoot.Q(id);
                if (el != null && vi != null) el.style.backgroundImage = new StyleBackground(vi);
            }
        }

        // ------------------------------------------------------------------ captures: every fixture + R4/R6/R8 variants

        [UnityTest]
        public IEnumerator D_Capture()
        {
            bool play = Play;
            var route = RouteName(play);
            var mode = DefaultTarget;
            if (!GradientsImported()) Note("capture-timing", "gradients imported by D_Capture: " + ImportGradients().Replace("\n", " | "));
            if (play) yield return new EnterPlayMode();
            Init();
            play = Play; route = RouteName(play); mode = DefaultTarget; // recomputed: the enumerator crossed a domain reload
            Note("capture-timing", "route: " + route + " isPlaying=" + Application.isPlaying);
            var sw = Stopwatch.StartNew();

            // default state of every fixture
            foreach (var fx in Fixtures.Where(Selected))
            {
                sw.Restart();
                using (var s = Open(fx, mode))
                {
                    foreach (var _ in Settle(s, play)) yield return null;
                    Save(s, fx, "", "default", route);
                }
                Note("capture-timing", fx + " mount+settle+readback+png+boxes " + sw.ElapsedMilliseconds + " ms");
            }

            // R2/R4: advanced text generator on the text fixtures
            foreach (var fx in new[] { "f07-text-lines", "f08-bold-synthetic", "f09-font-metrics" }.Where(Selected))
            {
                using (var s = Open(fx, mode, ss =>
                       {
                           foreach (var te in ss.TwinRoot.Query<TextElement>().ToList()) te.style.unityTextGenerator = TextGeneratorType.Advanced;
                       }))
                {
                    foreach (var _ in Settle(s, play)) yield return null;
                    Save(s, fx, "-advanced", "default:advanced", route);
                }
            }

            // R6: :hover / :active on f13 through dispatched pointer events
            if (Selected("f13-hover-active"))
            {
                const string fx = "f13-hover-active";
                var f = new StringBuilder();
                f.AppendLine("route: " + route);
                foreach (var withClickable in new[] { false, true })
                {
                    foreach (var target in new[] { "f13-btn", "f13-btn2" })
                    {
                        Action<SpikeSession> customize = null;
                        if (withClickable)
                            customize = ss =>
                            {
                                ss.TwinRoot.Q("f13-btn").AddManipulator(new Clickable(() => { }));
                                ss.TwinRoot.Q("f13-btn2").AddManipulator(new Clickable(() => { }));
                            };
                        using (var s = Open(fx, mode, customize))
                        {
                            foreach (var _ in Settle(s, play)) yield return null;
                            var el = s.TwinRoot.Q(target);
                            var c = el.worldBound.center;
                            string tag = (withClickable ? "clickable" : "plain") + " " + target;
                            string State() => "pseudo=" + SpikeCapture.PseudoStates(el) + " bg=" + SpikeCapture.Hex((Color32)el.resolvedStyle.backgroundColor) + " border=" + SpikeCapture.Hex((Color32)el.resolvedStyle.borderTopColor);
                            f.AppendLine(tag + " default: " + State());
                            string suffix = target == "f13-btn" ? "" : "-btn2";

                            SpikeCapture.SendPointer(s.Panel, EventType.MouseMove, c);
                            f.AppendLine(tag + " right after PointerMoveEvent at " + c + ": " + State());
                            foreach (var _ in Frames(s, play, 1)) yield return null;
                            f.AppendLine(tag + "   +1 frame: " + State());
                            foreach (var _ in Frames(s, play, 4)) yield return null;
                            f.AppendLine(tag + "   +5 frames: " + State());
                            if (!withClickable) Save(s, fx, "-hover" + suffix, "hover:" + target, route);

                            SpikeCapture.SendPointer(s.Panel, EventType.MouseDown, c);
                            f.AppendLine(tag + " right after PointerDownEvent: " + State());
                            foreach (var _ in Frames(s, play, 3)) yield return null;
                            f.AppendLine(tag + "   +3 frames: " + State());
                            Save(s, fx, (withClickable ? "-active" : "-active-noclickable") + suffix, "active:" + target, route);

                            SpikeCapture.SendPointer(s.Panel, EventType.MouseUp, c);
                            foreach (var _ in Frames(s, play, 3)) yield return null;
                            f.AppendLine(tag + " after PointerUpEvent +3 frames: " + State());

                            SpikeCapture.SendPointer(s.Panel, EventType.MouseMove, new Vector2(2500, 1400));
                            foreach (var _ in Frames(s, play, 3)) yield return null;
                            f.AppendLine(tag + " after PointerMoveEvent outside +3 frames: " + State());
                        }
                    }
                }
                Finding("r6-pseudo", f.ToString());
            }

            // R8: colour routes on f10 and f11
            foreach (var fx in new[] { "f10-solid-colors-alpha", "f11-gradients" }.Where(Selected))
            {
                foreach (SpikeTarget m in Enum.GetValues(typeof(SpikeTarget)))
                {
                    using (var s = Open(fx, m))
                    {
                        foreach (var _ in Settle(s, play)) yield return null;
                        foreach (SpikeReadback rb in Enum.GetValues(typeof(SpikeReadback)))
                        {
                            var tex = SpikeCapture.ReadBack(s.Target, rb);
                            SpikeCapture.WritePng(tex, Path.Combine(SpikeCapture.FixtureDir(fx), "r8", m + "-" + rb + ".png"));
                        }
                    }
                }
            }

            if (play) yield return new ExitPlayMode();
        }
    }
}
