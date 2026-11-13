using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.UIElements;
using Object = UnityEngine.Object;

namespace DesignUi.Editor
{
    /// <summary>
    /// A capture that cannot be made as the job asks (for example hover on an element no point of which picks it); not a
    /// failure of the run: <see cref="DesignCapture.CaptureAll"/> lists the job as not captured, with this message.
    /// </summary>
    public sealed class NotCapturableException : Exception
    {
        public NotCapturableException(string message) : base(message) { }
    }

    /// <summary>
    /// Renders a compiled screen the way the design's golden capture shows it (spec 15; docs/findings/m0.md, capture route,
    /// pseudo-states and text lines), so that <c>design-export compare</c> can judge it. Runs in an EditMode
    /// <c>UnityTest</c> (editor updates drive the panel; batchmode on Metal renders it), never in Play mode.
    /// <list type="bullet">
    /// <item>Panel: a copy of the profile's design PanelSettings (the package's DesignUiPanelSettings by default) with Scale With
    /// Screen Size at the profile's reference resolution and match, which must equal the export's; the target is an
    /// <c>R8G8B8A8_UNorm</c> RenderTexture of the viewport with a <c>D24_UNorm_S8_UInt</c> depth-stencil,
    /// <c>forceGammaRendering</c> on (gamma-space blending, as the browser), cleared to magenta (pixels left magenta were
    /// not covered). The document root is stretched over the panel.</item>
    /// <item>Screen: the compiled UXML, the reference locale's class on the screen root and the shared <c>DesignFonts.uss</c>;
    /// the runtime wiring of the generated view (a Clickable on the manifest's elements, a PseudoStateMirror from an element
    /// to its shadow host); sample data from <c>fixtures/sample-data.json</c> by element name: bound texts, Smart String
    /// arguments, and repeat items (their count, their texts and their <c>$classes</c>; inline items are cloned from the
    /// template and renamed, so only the first item carries the design ids, as in the golden; list items fill the
    /// ListView's slots).</item>
    /// <item>Job: the state class on the root, classes on their elements (and on a shadow host that mirrors them), disabled and
    /// checked through SetEnabled and the toggle's value, focus through Focus, and hover and active through real pointer
    /// events at a point of the element that picks it (the element and its ancestors hover; a press makes it active).</item>
    /// <item>Output: <c>&lt;OutDir&gt;/&lt;CaptureName&gt;.png</c> (the RenderTexture bytes unchanged, exactly the viewport's size)
    /// and the capture's entry in <c>&lt;OutDir&gt;/boxes.json</c> (<see cref="BoxesWriter"/>).</item>
    /// </list>
    /// Frames: 20 editor updates after mounting, 5 after each change and pointer event.
    /// </summary>
    public static class DesignCapture
    {
        /// <summary>Next to boxes.json: what the run did not capture and why (boxes.json itself holds only captures).</summary>
        public const string MetaFileName = "boxes.meta.json";
        /// <summary>
        /// Written last by a capture run that went through every job: the run id, the job count and the captured and
        /// not-captured counts. A capture folder without it was not captured (the run stopped or never ran).
        /// </summary>
        public const string DoneFileName = "capture-done.json";
        public const string MatrixPath = "goldens/matrix.json";
        public const string FixturesPath = "fixtures/" + IrFixtures.FileName;

        const string DefaultState = "default";
        const int MountFrames = 20;
        const int ChangeFrames = 5;
        static readonly Color Sentinel = new Color(1f, 0f, 1f, 1f);

        /// <summary>
        /// Captures one request; throws when the screen, the export or the request does not fit, and
        /// <see cref="NotCapturableException"/> when the job cannot be made as the golden shows it. Notes about how a
        /// capture was made (for example a pointer target whose children were made transparent to the pointer) go to
        /// <see cref="CaptureRequest.Notes"/>.
        /// </summary>
        public static IEnumerator Run(CaptureRequest req, DesignUiProfile profile)
        {
            var screen = Prepare(req, profile);
            var mount = new Mount();
            try
            {
                mount.Open(req.Viewport, profile, screen.Tree);
                var docRoot = mount.Document.rootVisualElement;
                var root = BoxesWriter.Find(docRoot, screen.Manifest.root ?? screen.Ir.Root.Id)
                           ?? throw new InvalidOperationException("the compiled screen has no root element '" + (screen.Manifest.root ?? screen.Ir.Root.Id) + "'");
                if (screen.Fonts != null && !docRoot.styleSheets.Contains(screen.Fonts)) docRoot.styleSheets.Add(screen.Fonts);
                root.AddToClassList(FontMap.LocaleClass(profile.referenceLocale));
                var filler = new SampleFiller(screen);
                filler.FillScreen(docRoot);
                if (req.State != DefaultState) root.AddToClassList(ScreenBuilder.StateClassPrefix + req.State);
                for (int i = 0; i < MountFrames; i++) yield return null;
                var panel = mount.Panel;
                var scale = PanelScale(panel, req.Viewport);

                var applied = Applied(req);
                var pointer = new List<CaptureApply>();
                bool changed = false;
                VisualElement focus = null;
                foreach (var a in applied)
                {
                    var el = BoxesWriter.Find(docRoot, a.ElementId) ?? throw new InvalidOperationException("the capture applies " + a + ", but the screen has no element '" + a.ElementId + "'");
                    if (a.Kind == CaptureApply.ClassKind)
                    {
                        el.AddToClassList(a.Name);
                        filler.MirrorClass(docRoot, a.ElementId, a.Name);
                        changed = true;
                        continue;
                    }
                    switch (a.Name)
                    {
                        case "hover":
                        case "active":
                            pointer.Add(a);
                            break;
                        case "focus":
                            focus = el;
                            break;
                        case "disabled":
                            el.SetEnabled(false);
                            changed = true;
                            break;
                        case "checked":
                            if (!(el is INotifyValueChanged<bool> toggle)) throw new NotCapturableException("checked applies to '" + a.ElementId + "', which is not a toggle in Unity");
                            toggle.value = true;
                            changed = true;
                            break;
                        default:
                            throw new NotCapturableException("unknown pseudo-state '" + a.Name + "'");
                    }
                }
                if (changed)
                {
                    filler.SyncMirrors();
                    for (int i = 0; i < ChangeFrames; i++) yield return null;
                }
                if (pointer.Count > 1)
                    throw new NotCapturableException("hover/active on " + string.Join(" and ", pointer.Select(p => "'" + p.ElementId + "'")) +
                                                     ", which are not ancestors of each other: one pointer cannot be on both");
                if (pointer.Count == 1)
                {
                    var target = BoxesWriter.Find(docRoot, pointer[0].ElementId);
                    var at = PointOn(panel, target);
                    if (at == null && Untouchable(target, out var covering))
                    {
                        // children cover every point: they stop taking the pointer, so only the element and its ancestors hover, as in the golden
                        at = PointOn(panel, target);
                        if (at != null) req.Notes.Add("the pointer is on '" + target.name + "' with its descendants ignoring the pointer (" + string.Join(", ", covering) + "): they cover it everywhere");
                    }
                    if (at == null)
                        throw new NotCapturableException("no point of '" + pointer[0].ElementId + "' picks it (it ignores the pointer or other elements cover it), so a real pointer cannot " +
                                                         pointer[0].Name + " it");
                    SendPointer(panel, EventType.MouseMove, at.Value);
                    mount.PointerAt = at;
                    for (int i = 0; i < ChangeFrames; i++) yield return null;
                    if (pointer[0].Name == "active")
                    {
                        SendPointer(panel, EventType.MouseDown, at.Value);
                        mount.Pressed = true;
                        for (int i = 0; i < ChangeFrames; i++) yield return null;
                        // UI Toolkit focuses a focusable element on press; the golden forces :active (and :hover) only
                        if (panel.focusController.focusedElement is VisualElement pressed && pressed != focus)
                        {
                            pressed.Blur();
                            for (int i = 0; i < ChangeFrames; i++) yield return null;
                        }
                    }
                }
                if (focus != null)
                {
                    focus.Focus();
                    for (int i = 0; i < ChangeFrames; i++) yield return null;
                    var focused = panel.focusController.focusedElement as VisualElement;
                    if (focused == null || focused != focus && !focus.Contains(focused))
                        throw new NotCapturableException("'" + focus.name + "' does not take focus in Unity (not focusable, disabled or hidden; focused: " +
                                                         (focused?.name ?? "nothing") + ")");
                }

                Directory.CreateDirectory(req.OutDir);
                File.WriteAllBytes(Path.Combine(req.OutDir, req.CaptureName + ".png"), mount.ReadPng());
                BoxesWriter.Merge(Path.Combine(req.OutDir, BoxesWriter.FileName), BoxesWriter.Measure(req.CaptureName, docRoot, req.Viewport, scale, screen.Ir));
                req.Inspect?.Invoke(root);
            }
            finally
            {
                mount.Dispose();
            }
        }

        /// <summary>
        /// Captures every job of <c>&lt;exportDir&gt;/goldens/matrix.json</c> into <paramref name="outDir"/> with the goldens'
        /// names, copies the compiled <c>.design-ui.json</c> (removed wrappers) next to them and writes
        /// <see cref="MetaFileName"/>. The files a capture owns (PNGs, boxes.json, the meta file, the copied manifest, the done
        /// marker) are deleted first, so nothing of an earlier run can be compared; the meta file says <c>running</c> until the
        /// run completes, and <see cref="DoneFileName"/> is written last. Animation samples are listed as not captured until the animation player exists; a job that cannot be
        /// made, or fails, is listed with its reason and leaves no PNG or boxes entry behind.
        /// </summary>
        public static IEnumerator CaptureAll(string exportDir, string screenFolder, DesignUiProfile profile, string outDir, CaptureResult result)
        {
            if (result == null) throw new ArgumentNullException(nameof(result));
            if (string.IsNullOrEmpty(outDir)) throw new ArgumentException("no output folder", nameof(outDir));
            var total = Stopwatch.StartNew();
            var run = new RunInfo { Id = Guid.NewGuid().ToString("N"), Started = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture) };
            Clear(outDir);
            WriteMeta(outDir, exportDir, screenFolder, result, run, "running", total.Elapsed.TotalMilliseconds);
            var jobs = CaptureJob.ReadMatrix(Path.Combine(exportDir, MatrixPath));
            var manifest = Path.Combine(screenFolder, ScreenCompiler.ManifestFileName);
            if (!File.Exists(manifest)) throw new InvalidOperationException("'" + screenFolder + "' is not a compiled screen (no " + ScreenCompiler.ManifestFileName + ")");
            File.Copy(manifest, Path.Combine(outDir, ScreenCompiler.ManifestFileName), true);
            var animated = AnimatedOnShow(IrReader.Read(Path.Combine(exportDir, ScreenCompiler.IrFileName)));
            foreach (var job in jobs)
            {
                if (job.Animation)
                {
                    NotCaptured(result, outDir, job.Name, "animation sample: the animation player that plays the design's animations in Unity is not available yet");
                    continue;
                }
                var req = new CaptureRequest
                {
                    ExportDir = exportDir, ScreenFolder = screenFolder, State = job.State, Viewport = job.Viewport, Apply = job.Apply,
                    OutDir = outDir, CaptureName = job.Name,
                };
                var watch = Stopwatch.StartNew();
                var capture = Run(req, profile);
                string failure = null, skipped = null;
                try
                {
                    while (true)
                    {
                        bool more;
                        try { more = capture.MoveNext(); }
                        catch (NotCapturableException e) { skipped = e.Message; break; }
                        catch (Exception e) { failure = e.GetType().Name + ": " + e.Message; break; }
                        if (!more) break;
                        yield return capture.Current;
                    }
                }
                finally
                {
                    (capture as IDisposable)?.Dispose(); // an abandoned run still destroys its panel
                }
                run.Times[job.Name] = Math.Round(watch.Elapsed.TotalMilliseconds, 1);
                if (failure != null)
                {
                    result.Errors.Add(job.Name + ": " + failure);
                    NotCaptured(result, outDir, job.Name, "error: " + failure);
                }
                else if (skipped != null) NotCaptured(result, outDir, job.Name, skipped);
                else
                {
                    result.Captured.Add(job.Name);
                    if (animated.Count > 0)
                        req.Notes.Add("animations are not played yet: " + string.Join(", ", animated) + " show their unanimated style, the golden a frozen frame");
                    if (req.Notes.Count > 0) run.Notes[job.Name] = new JArray(req.Notes);
                }
            }
            WriteMeta(outDir, exportDir, screenFolder, result, run, "complete", total.Elapsed.TotalMilliseconds);
            WriteJson(Path.Combine(outDir, DoneFileName), new JObject
            {
                ["captured"] = result.Captured.Count,
                ["jobs"] = jobs.Count,
                ["notCaptured"] = result.NotCaptured.Count,
                ["runId"] = run.Id,
            });
        }

        /// <summary>
        /// <see cref="CaptureAll"/> for several exports in one run, the i-th export into the i-th output folder, each with
        /// its default compiled screen (<see cref="DefaultScreenFolder"/>). An export that cannot be captured (not compiled,
        /// no matrix) adds <c>&lt;export&gt;: &lt;reason&gt;</c> to <paramref name="errors"/>, has no done marker, and does not
        /// stop the next; job errors of a captured export are added the same way.
        /// </summary>
        public static IEnumerator CaptureEach(IReadOnlyList<string> exportDirs, IReadOnlyList<string> outDirs, DesignUiProfile profile, List<string> errors)
        {
            if (errors == null) throw new ArgumentNullException(nameof(errors));
            int n = exportDirs?.Count ?? 0, m = outDirs?.Count ?? 0;
            if (n == 0 || n != m)
            {
                errors.Add(n + (n == 1 ? " export folder" : " export folders") + " but " + m + (m == 1 ? " output folder" : " output folders") + ": give one output folder per export");
                yield break;
            }
            for (int i = 0; i < n; i++)
            {
                var export = exportDirs[i];
                var result = new CaptureResult();
                IEnumerator run = null;
                string failure = null;
                try { run = CaptureAll(export, DefaultScreenFolder(export, profile), profile, outDirs[i], result); }
                catch (Exception e) { failure = e.Message; }
                while (run != null)
                {
                    bool more;
                    try { more = run.MoveNext(); }
                    catch (Exception e) { failure = e.Message; break; }
                    if (!more) break;
                    yield return run.Current;
                }
                if (failure != null) errors.Add(export + ": " + failure);
                foreach (var e in result.Errors) errors.Add(export + ": " + e);
                UnityEngine.Debug.Log("Design UI capture " + (i + 1) + "/" + n + " " + export + ": " + (failure != null ? "not captured: " + failure
                    : result.Captured.Count + " captured, " + result.NotCaptured.Count + " not captured into " + outDirs[i]));
            }
        }

        /// <summary>The profile asset at <paramref name="assetPath"/>, or the project's only DesignUiProfile when it is empty.</summary>
        public static DesignUiProfile LoadProfile(string assetPath)
        {
            if (!string.IsNullOrEmpty(assetPath))
                return AssetDatabase.LoadAssetAtPath<DesignUiProfile>(assetPath) ?? throw new InvalidOperationException("no DesignUiProfile at '" + assetPath + "'");
            var paths = AssetDatabase.FindAssets("t:" + nameof(DesignUiProfile)).Select(AssetDatabase.GUIDToAssetPath).OrderBy(p => p, StringComparer.Ordinal).ToList();
            if (paths.Count != 1)
                throw new InvalidOperationException(paths.Count == 0
                    ? "the project has no DesignUiProfile; create one (Assets > Create > Design UI > Profile)"
                    : "the project has several DesignUiProfiles (" + string.Join(", ", paths) + "); name one with DESIGN_UI_PROFILE");
            return AssetDatabase.LoadAssetAtPath<DesignUiProfile>(paths[0]);
        }

        /// <summary>Where the profile compiles the export's screen: <c>&lt;outputFolder&gt;/&lt;Screen&gt;</c>.</summary>
        public static string DefaultScreenFolder(string exportDir, DesignUiProfile profile)
        {
            if (profile == null) throw new ArgumentNullException(nameof(profile));
            var ir = IrReader.Read(Path.Combine(exportDir, ScreenCompiler.IrFileName));
            return profile.outputFolder.Replace('\\', '/').TrimEnd('/') + "/" + Naming.Pascal(ir.Screen, "screen id");
        }

        // ---- request -------------------------------------------------------------------------------------------

        sealed class Screen
        {
            public IrScreen Ir;
            public IrFixtures Fixtures;
            public GeneratedManifest Manifest;
            public VisualTreeAsset Tree;
            public StyleSheet Fonts;
            public string Folder;
            /// <summary>The reference locale's primary twins (plain and line-box variants): a bound text's characters go there first.</summary>
            public List<UnityEngine.TextCore.Text.FontAsset> TextFonts = new List<UnityEngine.TextCore.Text.FontAsset>();
        }

        /// <summary>The existing twins of the profile's reference locale font, plain and line-box variants (none are created here).</summary>
        static List<UnityEngine.TextCore.Text.FontAsset> ReferenceTwins(DesignUiProfile profile)
        {
            try
            {
                var plan = FontMap.Plan(profile, FontMap.DefaultResolver(profile));
                if (!plan.Fonts.TryGetValue(plan.ReferenceLocale, out var font) || font?.Primary == null || string.IsNullOrEmpty(plan.TwinFolder))
                    return new List<UnityEngine.TextCore.Text.FontAsset>();
                return new FontTwinGenerator.LineBox[] { null }.Concat(FontTwinGenerator.LineBox.Kit)
                    .Select(b => AssetDatabase.LoadAssetAtPath<UnityEngine.TextCore.Text.FontAsset>(FontTwinGenerator.TwinPath(font.Primary, plan.TwinFolder, b)))
                    .Where(f => f != null).ToList();
            }
            catch (FontSetupException) { return new List<UnityEngine.TextCore.Text.FontAsset>(); }
        }

        static Screen Prepare(CaptureRequest req, DesignUiProfile profile)
        {
            if (req == null) throw new ArgumentNullException(nameof(req));
            if (profile == null) throw new ArgumentNullException(nameof(profile));
            if (!CaptureJob.ValidName(req.CaptureName)) throw new ArgumentException("capture name '" + req.CaptureName + "' is not a file name");
            if (req.Viewport.x < 1 || req.Viewport.y < 1) throw new ArgumentException("capture '" + req.CaptureName + "' has no viewport");
            if (string.IsNullOrEmpty(req.OutDir)) throw new ArgumentException("capture '" + req.CaptureName + "' has no output folder");
            if (string.IsNullOrEmpty(req.ExportDir)) throw new ArgumentException("capture '" + req.CaptureName + "' has no export folder");
            var folder = ScreenCompiler.ProjectPath((req.ScreenFolder ?? "").Replace('\\', '/').TrimEnd('/'))
                         ?? throw new InvalidOperationException("the compiled screen folder '" + req.ScreenFolder + "' is not inside the project");
            var ir = IrReader.Read(Path.Combine(req.ExportDir, ScreenCompiler.IrFileName));
            var reference = ir.ReferenceViewport;
            if (reference == null || reference.Length != 2 || reference[0] != profile.referenceResolution.x || reference[1] != profile.referenceResolution.y ||
                Math.Abs(ir.ScreenMatch - profile.screenMatch) > 1e-6f)
                throw new InvalidOperationException("the export's reference viewport " + (reference == null ? "(none)" : string.Join("×", reference)) + " and screen match " +
                                                    ir.ScreenMatch.ToString(System.Globalization.CultureInfo.InvariantCulture) + " differ from the profile's " +
                                                    profile.referenceResolution.x + "×" + profile.referenceResolution.y + " and " +
                                                    profile.screenMatch.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                                                    "; the capture would not be comparable with the goldens");
            if (req.State != DefaultState && !(ir.States ?? new string[0]).Contains(req.State))
                throw new InvalidOperationException("capture '" + req.CaptureName + "' asks for state '" + req.State + "', which the screen does not declare");
            var manifest = GeneratedManifest.Load(folder + "/" + ScreenCompiler.ManifestFileName)
                           ?? throw new InvalidOperationException("'" + folder + "' is not a compiled screen (no " + ScreenCompiler.ManifestFileName + ")");
            if (manifest.screen != ir.Screen)
                throw new InvalidOperationException("'" + folder + "' holds screen '" + manifest.screen + "', not the export's '" + ir.Screen + "'");
            var uxml = folder + "/" + Path.GetFileName(folder) + ".uxml";
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(uxml) ?? throw new InvalidOperationException("no compiled UXML at '" + uxml + "'");
            var fixtures = Path.Combine(req.ExportDir, FixturesPath);
            return new Screen
            {
                Ir = ir, Manifest = manifest, Tree = tree, Folder = folder,
                Fixtures = File.Exists(fixtures) ? IrFixtures.Read(fixtures) : new IrFixtures(),
                Fonts = AssetDatabase.LoadAssetAtPath<StyleSheet>(Path.GetDirectoryName(folder)?.Replace('\\', '/') + "/" + FontMap.FileName),
                TextFonts = ReferenceTwins(profile),
            };
        }

        static List<CaptureApply> Applied(CaptureRequest req)
        {
            var list = new List<CaptureApply>(req.Apply ?? new List<CaptureApply>());
            if (!string.IsNullOrEmpty(req.PseudoKind) && !list.Any(a => a.Kind == CaptureApply.PseudoKind && a.Name == req.PseudoKind && a.ElementId == req.PseudoElementId))
                list.Add(CaptureApply.Pseudo(req.PseudoKind, req.PseudoElementId));
            return list;
        }

        // ---- panel ---------------------------------------------------------------------------------------------

        sealed class Mount : IDisposable
        {
            public RenderTexture Target;
            public PanelSettings Settings;
            public GameObject Host;
            public UIDocument Document;
            public Vector2? PointerAt;
            public bool Pressed;

            public IPanel Panel => Document != null ? Document.rootVisualElement?.panel : null;

            public void Open(Vector2Int viewport, DesignUiProfile profile, VisualTreeAsset tree)
            {
                var source = profile.DesignPanelSettings ?? throw new InvalidOperationException("no design PanelSettings: set the profile's panelSettings or reinstall the package");
                var desc = new RenderTextureDescriptor(viewport.x, viewport.y)
                {
                    graphicsFormat = GraphicsFormat.R8G8B8A8_UNorm,
                    depthStencilFormat = GraphicsFormat.D24_UNorm_S8_UInt, // rounded clipping uses the stencil
                    msaaSamples = 1,
                    mipCount = 1,
                    useMipMap = false,
                    sRGB = false,
                };
                Target = new RenderTexture(desc) { name = "DesignCapture", hideFlags = HideFlags.DontSave };
                Target.Create();
                Settings = Object.Instantiate(source);
                Settings.hideFlags = HideFlags.DontSave;
                Settings.scaleMode = PanelScaleMode.ScaleWithScreenSize;
                Settings.referenceResolution = profile.referenceResolution;
                Settings.screenMatchMode = PanelScreenMatchMode.MatchWidthOrHeight;
                Settings.match = profile.screenMatch;
                Settings.targetTexture = Target;
                Settings.clearColor = true;
                Settings.colorClearValue = Sentinel;
                Settings.forceGammaRendering = true;
                Settings.scale = 1f; // a consumer's PanelSettings may scale on top of Scale With Screen Size
                Host = new GameObject("DesignCapture") { hideFlags = HideFlags.DontSave };
                Host.SetActive(false); // the document registers once, with its settings and tree already set
                Document = Host.AddComponent<UIDocument>();
                Document.panelSettings = Settings;
                Document.visualTreeAsset = tree;
                Host.SetActive(true);
                var root = Document.rootVisualElement ?? throw new InvalidOperationException("the UIDocument has no root element");
                root.style.position = Position.Absolute;
                root.style.left = 0;
                root.style.top = 0;
                root.style.right = 0;
                root.style.bottom = 0;
            }

            /// <summary>The RenderTexture's bytes as a PNG, unchanged (no colour conversion).</summary>
            public byte[] ReadPng()
            {
                var tex = new Texture2D(Target.width, Target.height, TextureFormat.RGBA32, false, true) { hideFlags = HideFlags.DontSave };
                var active = RenderTexture.active;
                try
                {
                    RenderTexture.active = Target;
                    tex.ReadPixels(new Rect(0, 0, Target.width, Target.height), 0, 0, false);
                    tex.Apply(false);
                    return tex.EncodeToPNG();
                }
                finally
                {
                    RenderTexture.active = active;
                    Object.DestroyImmediate(tex);
                }
            }

            public void Dispose()
            {
                // the pointer state is global: release a press and leave the panel before it goes away
                var panel = Panel;
                if (panel != null && PointerAt.HasValue)
                {
                    try
                    {
                        if (Pressed) SendPointer(panel, EventType.MouseUp, PointerAt.Value);
                        SendPointer(panel, EventType.MouseMove, new Vector2(-10000f, -10000f));
                    }
                    catch (Exception e) { UnityEngine.Debug.LogWarning("Design UI capture: resetting the pointer failed: " + e.Message); }
                }
                if (Host != null) Object.DestroyImmediate(Host);
                if (Settings != null) Object.DestroyImmediate(Settings);
                if (Target != null)
                {
                    Target.Release();
                    Object.DestroyImmediate(Target);
                }
            }
        }

        /// <summary>
        /// Makes the element's pickable descendants ignore the pointer (picking mode is not drawn) when they cover every
        /// point of it; returns whether any did and names them.
        /// </summary>
        static bool Untouchable(VisualElement target, out List<string> covering)
        {
            covering = new List<string>();
            var stack = new Stack<VisualElement>();
            for (int i = 0; i < target.hierarchy.childCount; i++) stack.Push(target.hierarchy[i]);
            while (stack.Count > 0)
            {
                var e = stack.Pop();
                if (e.pickingMode == PickingMode.Position)
                {
                    e.pickingMode = PickingMode.Ignore;
                    covering.Add(string.IsNullOrEmpty(e.name) ? e.GetType().Name : e.name);
                }
                for (int i = 0; i < e.hierarchy.childCount; i++) stack.Push(e.hierarchy[i]);
            }
            return covering.Count > 0;
        }

        /// <summary>
        /// Device pixels per panel pixel as the panel resolved them (PanelSettings.ResolveScale): the viewport width over
        /// the panel's laid-out width.
        /// </summary>
        static double PanelScale(IPanel panel, Vector2Int viewport)
        {
            var width = panel?.visualTree.layout.width ?? float.NaN;
            if (float.IsNaN(width) || width <= 0) throw new InvalidOperationException("the panel has no layout after mounting the screen");
            return Math.Round(viewport.x / (double)width, 9);
        }

        /// <summary>A pointer event built from an IMGUI event, sent to the panel's tree at panel coordinates.</summary>
        static void SendPointer(IPanel panel, EventType type, Vector2 at)
        {
            var e = new Event { type = type, mousePosition = at, button = 0, clickCount = type == EventType.MouseDown ? 1 : 0 };
            EventBase evt;
            switch (type)
            {
                case EventType.MouseMove: evt = PointerMoveEvent.GetPooled(e); break;
                case EventType.MouseDown: evt = PointerDownEvent.GetPooled(e); break;
                case EventType.MouseUp: evt = PointerUpEvent.GetPooled(e); break;
                default: throw new ArgumentException(type.ToString());
            }
            using (evt) panel.visualTree.SendEvent(evt);
        }

        /// <summary>
        /// A panel point where picking finds the element itself (not a descendant, which would hover too, unlike the
        /// golden): its centre, else the centres of a 5×5 grid over it.
        /// </summary>
        static Vector2? PointOn(IPanel panel, VisualElement target)
        {
            var b = target.worldBound;
            if (float.IsNaN(b.width) || b.width <= 0 || b.height <= 0) return null;
            bool Hits(Vector2 p) => panel.Pick(p) == target;
            if (Hits(b.center)) return b.center;
            for (int iy = 0; iy < 5; iy++)
                for (int ix = 0; ix < 5; ix++)
                {
                    var p = new Vector2(b.xMin + b.width * (ix + 0.5f) / 5f, b.yMin + b.height * (iy + 0.5f) / 5f);
                    if (Hits(p)) return p;
                }
            return null;
        }

        // ---- sample data and runtime wiring -------------------------------------------------------------------

        /// <summary>Sample values seen from one item: its own, then the enclosing ones.</summary>
        sealed class Scope
        {
            public readonly IrFixtures Data;
            readonly Scope _parent;

            public Scope(IrFixtures data, Scope parent)
            {
                Data = data ?? new IrFixtures();
                _parent = parent;
            }

            public string Value(string name) => name != null && Data.Values.TryGetValue(name, out var v) ? v : _parent?.Value(name);

            public List<IrFixtures> Items(string repeat) => repeat != null && Data.Repeats.TryGetValue(repeat, out var items) ? items : _parent?.Items(repeat);
        }

        /// <summary>
        /// Fills the compiled tree from the fixtures by element name and adds the view's runtime wiring. Every scope (the
        /// screen, a cloned inline item, a list slot) is filled and wired while its elements still carry the design ids;
        /// clones are renamed afterwards, so the design ids stay unique and name the first item, as in the golden.
        /// </summary>
        sealed class SampleFiller
        {
            readonly Screen _screen;
            readonly HashSet<VisualElement> _wired = new HashSet<VisualElement>();
            readonly List<PseudoStateMirror> _mirrors = new List<PseudoStateMirror>();

            public SampleFiller(Screen screen)
            {
                _screen = screen;
            }

            public void FillScreen(VisualElement docRoot)
            {
                var roots = new[] { docRoot };
                Fill(_screen.Ir.Root, roots, new Scope(_screen.Fixtures, null), _screen.Tree);
                Wire(roots);
            }

            /// <summary>Puts a class the job applies on the shadow hosts that mirror it for the element.</summary>
            public void MirrorClass(VisualElement docRoot, string elementId, string cls)
            {
                foreach (var m in _screen.Manifest.mirrors.Where(m => m.element == elementId && m.classes != null && m.classes.Contains(cls)))
                    BoxesWriter.Find(docRoot, m.host)?.AddToClassList(cls);
            }

            /// <summary>Copies disabled and checked to the shadow hosts now (the mirror polls them only every 100 ms).</summary>
            public void SyncMirrors()
            {
                foreach (var m in _mirrors) m.Sync();
            }

            static VisualElement Find(IReadOnlyList<VisualElement> roots, string name)
            {
                foreach (var r in roots)
                {
                    var e = BoxesWriter.Find(r, name);
                    if (e != null) return e;
                }
                return null;
            }

            void Fill(IrNode node, IReadOnlyList<VisualElement> roots, Scope scope, VisualTreeAsset source)
            {
                var el = Find(roots, node.Id);
                if (el != null) FillText(node, el, scope);
                if (node.Repeat != null)
                {
                    Repeat(node, roots, scope, source);
                    return;
                }
                foreach (var c in node.Children ?? new IrNode[0]) Fill(c, roots, scope, source);
            }

            /// <summary>
            /// A bound text, or a text with Smart String arguments filled in: its characters reach the screen's twins with their
            /// kerning pairs before it is assigned (<see cref="DesignUi.DesignText.Prepare"/>), as game code does with
            /// <see cref="DesignUi.DesignText.SetText"/>, so its first layout is kerned.
            /// </summary>
            void FillText(IrNode node, VisualElement el, Scope scope)
            {
                var bound = node.Bind != null ? scope.Value(node.Bind) : null;
                if (bound != null)
                {
                    PrepareFonts(bound);
                    SetText(el, bound, node.Text?.Rich ?? false);
                    return;
                }
                var args = node.Text?.Args;
                if (args == null || args.Length == 0) return;
                var text = GetText(el);
                if (text == null) return;
                foreach (var a in args)
                {
                    var v = scope.Value(a);
                    if (v != null) text = text.Replace("{" + a + "}", v);
                }
                PrepareFonts(text);
                SetText(el, text, node.Text.Rich);
            }

            void PrepareFonts(string text)
            {
                foreach (var font in _screen.TextFonts) DesignUi.DesignText.Prepare(font, text);
            }

            static string GetText(VisualElement el)
            {
                switch (el)
                {
                    case TextField f: return f.value;
                    case DropdownField d: return d.value;
                    case Toggle t: return t.text;
                    case TextElement te: return te.text;
                    default: return null;
                }
            }

            static void SetText(VisualElement el, string value, bool rich)
            {
                switch (el)
                {
                    case TextField f:
                        f.value = value;
                        break;
                    case DropdownField d:
                        d.choices = new List<string> { value };
                        d.index = 0;
                        break;
                    case Toggle t:
                        t.text = value;
                        break;
                    case TextElement te:
                        if (!rich && value.IndexOf('<') >= 0) te.enableRichText = false; // as the compiler writes plain text
                        te.text = value;
                        break;
                }
            }

            void Repeat(IrNode node, IReadOnlyList<VisualElement> roots, Scope scope, VisualTreeAsset source)
            {
                var entry = _screen.Manifest.repeats.FirstOrDefault(r => r.name == node.Repeat.Name)
                            ?? throw new InvalidOperationException("the compiled manifest has no repeat '" + node.Repeat.Name + "'");
                var items = scope.Items(node.Repeat.Name);
                var count = items?.Count ?? Math.Max(1, node.Repeat.Count);
                IrFixtures Item(int i) => items != null && i < items.Count ? items[i] : null;
                if (entry.mode == "list")
                {
                    ListRepeat(node, entry, roots, scope, count, Item);
                    return;
                }

                var container = Find(roots, entry.container) ?? throw new InvalidOperationException("no repeat container '" + entry.container + "'");
                var first = entry.items.Select(n => BoxesWriter.Find(container, n) ?? throw new InvalidOperationException("no repeat item '" + n + "'")).ToList();
                FillItem(node, first, new Scope(Item(0), scope), source);
                int at = container.IndexOf(first[first.Count - 1]) + 1;
                for (int i = 1; i < count; i++)
                {
                    var fresh = source.Instantiate();
                    var clones = entry.items.Select(n => BoxesWriter.Find(fresh, n) ?? throw new InvalidOperationException("no repeat item '" + n + "' in the template")).ToList();
                    foreach (var c in clones) c.RemoveFromHierarchy();
                    FillItem(node, clones, new Scope(Item(i), scope), source);
                    Wire(clones);
                    foreach (var c in clones)
                    {
                        c.RemoveFromClassList(ScreenBuilder.FirstItemClass);
                        Rename(c, "#" + i);
                        container.Insert(at++, c);
                    }
                }
            }

            void ListRepeat(IrNode node, RepeatEntry entry, IReadOnlyList<VisualElement> roots, Scope scope, int count, Func<int, IrFixtures> item)
            {
                var list = Find(roots, entry.container) as ListView ?? throw new InvalidOperationException("no ListView '" + entry.container + "' for list repeat '" + entry.name + "'");
                var path = _screen.Folder + "/" + entry.template;
                var template = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(path) ?? throw new InvalidOperationException("no item template at '" + path + "'");
                // a slot of the fixed item height holds one item: the item keeps its own height and margins
                list.makeItem = () => new VisualElement();
                list.bindItem = (slot, i) =>
                {
                    slot.Clear();
                    template.CloneTree(slot);
                    var itemRoots = slot.Children().ToList();
                    FillItem(node, itemRoots, new Scope(item(i), scope), template);
                    Wire(itemRoots);
                    if (i > 0) foreach (var r in itemRoots) Rename(r, "#" + i);
                };
                list.itemsSource = Enumerable.Range(0, count).ToList();
            }

            /// <summary>Fills one item (the repeat node's children below the item's compiled roots) and gives it its classes.</summary>
            void FillItem(IrNode repeatNode, IReadOnlyList<VisualElement> itemRoots, Scope scope, VisualTreeAsset source)
            {
                foreach (var c in repeatNode.Children ?? new IrNode[0]) Fill(c, itemRoots, scope, source);
                foreach (var kv in scope.Data.Classes)
                {
                    var el = Find(itemRoots, kv.Key);
                    if (el == null) continue;
                    foreach (var cls in kv.Value)
                    {
                        el.AddToClassList(cls);
                        foreach (var m in _screen.Manifest.mirrors.Where(m => m.element == kv.Key && m.classes != null && m.classes.Contains(cls)))
                            Find(itemRoots, m.host)?.AddToClassList(cls);
                    }
                }
            }

            /// <summary>The generated view's wiring for the elements below <paramref name="roots"/> that still carry the design ids.</summary>
            void Wire(IReadOnlyList<VisualElement> roots)
            {
                foreach (var name in _screen.Manifest.clickable)
                {
                    var el = Find(roots, name);
                    if (el != null && _wired.Add(el)) el.AddManipulator(new Clickable(() => { }));
                }
                foreach (var m in _screen.Manifest.mirrors)
                {
                    var host = Find(roots, m.host);
                    var el = Find(roots, m.element);
                    if (host == null || el == null || !host.ClassListContains(ScreenBuilder.MirrorHostClass) || !_wired.Add(host)) continue;
                    var mirror = new PseudoStateMirror(host);
                    el.AddManipulator(mirror);
                    _mirrors.Add(mirror);
                }
            }

            /// <summary>Appends <paramref name="suffix"/> to every design name in the subtree (UI Toolkit's own unity-* names stay).</summary>
            static void Rename(VisualElement e, string suffix)
            {
                if (!string.IsNullOrEmpty(e.name) && !e.name.StartsWith("unity-", StringComparison.Ordinal)) e.name += suffix;
                for (int i = 0; i < e.hierarchy.childCount; i++) Rename(e.hierarchy[i], suffix);
            }
        }

        // ---- output ---------------------------------------------------------------------------------------------

        sealed class RunInfo
        {
            public string Id;
            public string Started;
            public readonly JObject Times = new JObject();
            public readonly JObject Notes = new JObject();
        }

        /// <summary>Deletes what a capture run writes into the folder (PNGs, boxes, meta, manifest copy); other files stay.</summary>
        static void Clear(string outDir)
        {
            Directory.CreateDirectory(outDir);
            foreach (var png in Directory.GetFiles(outDir, "*.png")) File.Delete(png);
            foreach (var name in new[] { DoneFileName, BoxesWriter.FileName, MetaFileName, ScreenCompiler.ManifestFileName })
            {
                var path = Path.Combine(outDir, name);
                if (File.Exists(path)) File.Delete(path);
            }
        }

        /// <summary>Elements whose keyframe animations start when the screen opens (the capture does not play them yet).</summary>
        static List<string> AnimatedOnShow(IrScreen ir)
        {
            var ids = new List<string>();
            void Walk(IrNode n)
            {
                if ((n.Anims ?? new List<IrAnim>()).Any(a => a.Kind == IrAnim.KeyframesKind && a.Trigger == LayerKey.ShowTrigger)) ids.Add(n.Id);
                foreach (var c in n.Children ?? new IrNode[0]) Walk(c);
            }
            Walk(ir.Root);
            return ids;
        }

        static void NotCaptured(CaptureResult result, string outDir, string name, string reason)
        {
            result.NotCaptured.Add(new NotCaptured { Capture = name, Reason = reason });
            var png = Path.Combine(outDir, name + ".png");
            if (File.Exists(png)) File.Delete(png);
            BoxesWriter.Remove(Path.Combine(outDir, BoxesWriter.FileName), name);
        }

        static void WriteMeta(string outDir, string exportDir, string screenFolder, CaptureResult result, RunInfo run, string status, double totalMs)
        {
            var meta = new JObject
            {
                ["captured"] = new JArray(result.Captured),
                ["errors"] = new JArray(result.Errors),
                ["export"] = exportDir,
                ["notCaptured"] = new JArray(result.NotCaptured.Select(n => new JObject { ["capture"] = n.Capture, ["reason"] = n.Reason })),
                ["notes"] = run.Notes,
                ["runId"] = run.Id,
                ["screen"] = screenFolder,
                ["started"] = run.Started,
                ["status"] = status,
                ["timings"] = new JObject { ["captures"] = run.Times, ["totalMs"] = Math.Round(totalMs, 1) },
                ["unity"] = new JObject
                {
                    ["colorSpace"] = QualitySettings.activeColorSpace.ToString(),
                    ["graphics"] = SystemInfo.graphicsDeviceType.ToString(),
                    ["platform"] = Application.platform.ToString(),
                    ["version"] = Application.unityVersion,
                },
            };
            WriteJson(Path.Combine(outDir, MetaFileName), meta);
        }

        static void WriteJson(string path, JObject json)
        {
            using (var sw = new StringWriter { NewLine = "\n" })
            {
                using (var writer = new JsonTextWriter(sw) { Formatting = Formatting.Indented, Indentation = 2 }) json.WriteTo(writer);
                File.WriteAllText(path, sw.ToString().Replace("\r\n", "\n") + "\n", new UTF8Encoding(false));
            }
        }
    }
}
