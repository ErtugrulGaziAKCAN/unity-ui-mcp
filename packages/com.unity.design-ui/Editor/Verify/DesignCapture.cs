using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
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
    /// arguments, and repeat items (their count, their texts, their <c>$classes</c>, their controls' <c>$states</c> and the
    /// elements their markup hides, <c>$hidden</c>, applied as the generated view applies classes, enabled state and
    /// visibility; inline items are cloned from the repeat's item template, as the view clones them, and renamed, so only the
    /// first item carries the design ids, as in the golden; list items fill the ListView's slots). A localized text (a screen compiled with the profile's localization: a String Table binding
    /// and no text in the UXML) shows the design's reference text, the IR's <c>tr</c> with its arguments from the sample
    /// data, exactly as the golden shows it; its binding is taken off first, so no table can replace it.</item>
    /// <item>Job: the state class on the root, classes on their elements (and on a shadow host that mirrors them), disabled and
    /// checked through SetEnabled and the toggle's value, focus through Focus, and hover and active through real pointer
    /// events at a point of the element that picks it (the element and its ancestors hover; a press makes it active).</item>
    /// <item>Animations: the screen's <see cref="DesignUiAnimationPlayer"/> runs on a manual clock. A static capture holds it in
    /// reduced motion, so every animation shows the frame the golden's freeze shows; an animation series opens the screen at
    /// its <c>from</c> setup that way, then plays, applies the change at time 0 and steps the clock to each sample time
    /// (<see cref="RunSeries"/>). Class items marked <c>absent</c> take a markup class off.</item>
    /// <item>Output: <c>&lt;OutDir&gt;/&lt;CaptureName&gt;.png</c> (the RenderTexture bytes unchanged, exactly the viewport's size)
    /// and the capture's entry in <c>&lt;OutDir&gt;/boxes.json</c> (<see cref="BoxesWriter"/>).</item>
    /// </list>
    /// Frames: 20 editor updates after mounting, 5 after each change and pointer event, 2 after each animation sample.
    /// <para><see cref="CaptureAll"/> mounts a viewport's screen once and moves it from job to job, as the golden capture moves
    /// its page (classes and states off and on, the pointer and focus moved, a press released off the element so no click
    /// happens, disabled and checked back to the markup's values, scroll offsets back to the mount's, descendants made to
    /// ignore the pointer picking again once the pointer moves on; a setup change takes the pointer and focus off first, as
    /// a fresh mount has none while its setup is applied; an element a list cloned anew is looked up again; a job that
    /// leaves an overlay open, such as a dropdown's menu, makes the next job mount the screen again); a job's capture is the
    /// one <see cref="Run"/> makes on a freshly mounted screen. PNGs are encoded off the main thread.</para>
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
        /// <summary>Editor updates between the player writing a sample's values and the capture (the panel repaints).</summary>
        const int SampleFrames = 2;
        static readonly Color Sentinel = new Color(1f, 0f, 1f, 1f);

        /// <summary>
        /// Captures one request; throws when the screen, the export or the request does not fit, and
        /// <see cref="NotCapturableException"/> when the job cannot be made as the golden shows it. Notes about how a
        /// capture was made (for example a pointer target whose children were made transparent to the pointer) go to
        /// <see cref="CaptureRequest.Notes"/>.
        /// </summary>
        public static IEnumerator Run(CaptureRequest req, DesignUiProfile profile)
        {
            var session = new Session(req, profile);
            try
            {
                // a static capture shows every animation at its end, as the golden's freeze: the player's reduced motion
                foreach (var f in session.Open(req.State, true)) yield return f;
                foreach (var f in session.GoTo(req.State, Applied(req))) yield return f;
                if (req.Frozen != null && req.Frozen.Count > 0)
                {
                    if (session.Player == null)
                    {
                        // a screen compiled without animation data: write the golden's frozen frames as inline styles
                        FrozenFrames.ApplyAll(session.DocRoot, session.Screen.Ir, req.Frozen);
                        req.Notes.Add("keyframe animations shown at their frozen end frame, as in the golden (the compiled screen has no animation player): " + string.Join(", ", req.Frozen));
                        for (int i = 0; i < ChangeFrames; i++) yield return null;
                    }
                    else
                    {
                        var missing = req.Frozen.Where(f => !session.Plays(f.ElementId, f.Name)).ToList();
                        if (missing.Count > 0) req.Notes.Add("the golden shows these keyframe animations at their end frame, the player does not play them: " + string.Join(", ", missing));
                    }
                }
                session.Write(req.CaptureName);
                req.Inspect?.Invoke(session.Root);
            }
            finally
            {
                session.Dispose();
            }
        }

        /// <summary>
        /// Captures one animation series (spec 11): the jobs of one change, sample times ascending. The screen opens at the
        /// series' <c>from</c> setup with every animation at its end (reduced motion, as the golden's freeze), then the
        /// player plays and the change is applied at clock time 0 (a series without <c>from</c> plays from the screen's
        /// opening); for each job the clock steps to its time, the player writes its values and the frame is captured.
        /// <paramref name="done"/> counts the jobs written, so a caller can list the rest as not captured when it throws.
        /// </summary>
        internal static IEnumerator RunSeries(CaptureRequest req, IReadOnlyList<CaptureJob> jobs, DesignUiProfile profile, SeriesProgress done, Screen screen = null)
        {
            if (jobs == null || jobs.Count == 0 || jobs.Any(j => j.Anim == null)) throw new ArgumentException("an animation series needs animation jobs", nameof(jobs));
            var first = jobs[0];
            var from = first.Anim.From;
            var session = new Session(req, profile, screen);
            try
            {
                foreach (var f in session.Open(from?.State ?? first.State, from != null)) yield return f;
                if (session.Player == null)
                    throw new NotCapturableException("the compiled screen has no animation player (no animation data in its USS): recompile it with this version of the package");
                if (from != null)
                {
                    foreach (var f in session.GoTo(from.State, from.Apply)) yield return f;
                    session.Player.ReducedMotion = false;
                }
                foreach (var f in session.GoTo(first.State, first.Apply)) yield return f;
                var idle = first.Anim.Sampled.Where(r => !session.Started(r)).ToList();
                if (idle.Count > 0) req.Notes.Add("the change did not start " + string.Join(", ", idle) + " in the player");
                foreach (var job in jobs)
                {
                    session.Clock.Milliseconds = job.Anim.Time;
                    session.Player.Tick();
                    for (int i = 0; i < SampleFrames; i++) yield return null;
                    session.Write(job.Name);
                    done.Count++;
                }
            }
            finally
            {
                session.Dispose();
            }
        }

        /// <summary>Jobs of one capture run between flushes of boxes.json and the meta file (a stopped run keeps what it captured).</summary>
        const int FlushEveryJobs = 25;
        const double FlushEverySeconds = 10;

        /// <summary>The screen <see cref="CaptureAll"/> keeps mounted for consecutive static jobs at one viewport.</summary>
        sealed class SharedSession
        {
            public Session Session;

            public void Drop()
            {
                Session?.Dispose();
                Session = null;
            }
        }

        /// <summary>
        /// One static job on the run's mounted screen (mounted first, or again at another viewport or after a job that
        /// stopped): the screen moves from the previous job's setup to this one's; the PNG is encoded off the main thread.
        /// A job whose frozen frames the screen can only show as inline styles (no animation player) leaves the screen
        /// changed, so the next job mounts it again.
        /// </summary>
        static IEnumerator RunShared(SharedSession shared, CaptureRequest req, DesignUiProfile profile, Screen screen, List<(string, Task)> pngs)
        {
            screen = screen ?? Prepare(req, profile); // the run could not read it: this job fails with the reason
            CheckRequest(req, screen);
            if (shared.Session != null && shared.Session.Viewport != req.Viewport) shared.Drop();
            if (shared.Session == null)
            {
                var opened = new Session(req, profile, screen) { Shared = true };
                shared.Session = opened; // before mounting: a failure while mounting still destroys the panel
                foreach (var f in opened.Open(DefaultState, true)) yield return f;
            }
            var session = shared.Session;
            session.Begin(req);
            foreach (var f in session.RestoreScroll()) yield return f;
            foreach (var f in session.GoTo(req.State, Applied(req))) yield return f;
            bool dirty = false;
            if (req.Frozen != null && req.Frozen.Count > 0)
            {
                if (session.Player == null)
                {
                    FrozenFrames.ApplyAll(session.DocRoot, session.Screen.Ir, req.Frozen);
                    req.Notes.Add("keyframe animations shown at their frozen end frame, as in the golden (the compiled screen has no animation player): " + string.Join(", ", req.Frozen));
                    for (int i = 0; i < ChangeFrames; i++) yield return null;
                    dirty = true;
                }
                else
                {
                    var missing = req.Frozen.Where(f => !session.Plays(f.ElementId, f.Name)).ToList();
                    if (missing.Count > 0) req.Notes.Add("the golden shows these keyframe animations at their end frame, the player does not play them: " + string.Join(", ", missing));
                }
            }
            pngs.Add((req.CaptureName, session.Write(req.CaptureName, true)));
            BoundPngBacklog(pngs);
            req.Inspect?.Invoke(session.Root);
            // an overlay the job opened (a dropdown's menu) stays open: the next job mounts the screen again
            if (dirty || session.Overlaid()) shared.Drop();
        }

        /// <summary>PNGs encoded at the same time at most: each holds a whole frame (14.7 MB at 2560×1440) until it is on disk.</summary>
        internal const int MaxPendingPngs = 8;

        /// <summary>
        /// The most PNG encodes a capture run had pending right after starting one (boxes.meta.json
        /// <c>timings.pngPendingPeak</c>): at most <see cref="MaxPendingPngs"/> + 1.
        /// </summary>
        static int s_PendingPeak;

        /// <summary>Waits for the oldest PNGs still being encoded while more than <see cref="MaxPendingPngs"/> are (their errors are read at the end of the run).</summary>
        static void BoundPngBacklog(List<(string name, Task task)> pngs)
        {
            var pending = pngs.Where(p => !p.task.IsCompleted).Select(p => p.task).ToList();
            s_PendingPeak = Math.Max(s_PendingPeak, pending.Count);
            for (int i = 0; pending.Count - i > MaxPendingPngs; i++)
                try { pending[i].Wait(); } catch (AggregateException) { }
        }

        /// <summary>How many jobs of a series <see cref="RunSeries"/> wrote.</summary>
        internal sealed class SeriesProgress
        {
            public int Count;
        }

        /// <summary>
        /// Captures every job of <c>&lt;exportDir&gt;/goldens/matrix.json</c> into <paramref name="outDir"/> with the goldens'
        /// names, copies the compiled <c>.design-ui.json</c> (removed wrappers) next to them and writes
        /// <see cref="MetaFileName"/>. The files a capture owns (PNGs, boxes.json, the meta file, the copied manifest, the done
        /// marker) are deleted first, so nothing of an earlier run can be compared; the meta file says <c>running</c> until the
        /// run completes, and <see cref="DoneFileName"/> is written last. Animation samples are captured series by series
        /// (<see cref="RunSeries"/>). A job that cannot be made, or fails, is listed with its reason and leaves no PNG or boxes
        /// entry behind.
        /// </summary>
        public static IEnumerator CaptureAll(string exportDir, string screenFolder, DesignUiProfile profile, string outDir, CaptureResult result, string runId = null)
        {
            if (result == null) throw new ArgumentNullException(nameof(result));
            if (string.IsNullOrEmpty(outDir)) throw new ArgumentException("no output folder", nameof(outDir));
            var total = Stopwatch.StartNew();
            // a runner passes its own run id, so it can tell this run's done marker from an earlier run's
            var run = new RunInfo { Id = string.IsNullOrEmpty(runId) ? Guid.NewGuid().ToString("N") : runId, Started = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture) };
            Clear(outDir);
            WriteMeta(outDir, exportDir, screenFolder, result, run, "running", total.Elapsed.TotalMilliseconds);
            var jobs = CaptureJob.ReadMatrix(Path.Combine(exportDir, MatrixPath));
            var manifest = Path.Combine(screenFolder, ScreenCompiler.ManifestFileName);
            if (!File.Exists(manifest)) throw new InvalidOperationException("'" + screenFolder + "' is not a compiled screen (no " + ScreenCompiler.ManifestFileName + ")");
            File.Copy(manifest, Path.Combine(outDir, ScreenCompiler.ManifestFileName), true);
            var boxes = new JObject(); // written with the meta file now and then (a stopped run keeps what it captured), and before the done marker
            // the export and the compiled screen are read once for every job (when that fails, every job fails with the reason)
            Screen screen = null;
            try { screen = LoadScreen(exportDir, screenFolder, profile); }
            catch (Exception e) when (!(e is ArgumentNullException)) { UnityEngine.Debug.LogWarning("Design UI capture: " + e.Message); }
            var shared = new SharedSession();
            var pngs = new List<(string name, Task task)>();
            s_PendingPeak = 0;
            var flushed = Stopwatch.StartNew();
            int sinceFlush = 0;
            double flushMs = 0;
            void Flush(bool force)
            {
                // every 25 jobs, but a flush rewrites the whole boxes.json (megabytes for a thousand animation samples): the
                // next one waits ten times as long as the last one took, so flushing stays a small part of the run
                bool due = sinceFlush >= FlushEveryJobs && flushed.Elapsed.TotalMilliseconds >= 10 * flushMs;
                if (!force && !due && flushed.Elapsed.TotalSeconds < FlushEverySeconds) return;
                var took = Stopwatch.StartNew();
                BoxesWriter.WriteAll(Path.Combine(outDir, BoxesWriter.FileName), boxes);
                WriteMeta(outDir, exportDir, screenFolder, result, run, "running", total.Elapsed.TotalMilliseconds);
                flushMs = took.Elapsed.TotalMilliseconds;
                sinceFlush = 0;
                flushed.Restart();
            }
            try
            {
            for (int j = 0; j < jobs.Count; j++)
            {
                var job = jobs[j];
                sinceFlush++;
                Flush(false);
                if (job.Animation)
                {
                    shared.Drop(); // a series mounts its own screen
                    // one series: the consecutive samples of one change, times ascending
                    var series = new List<CaptureJob> { job };
                    var key = job.Anim.SeriesKey(job);
                    while (j + 1 < jobs.Count && jobs[j + 1].Animation && jobs[j + 1].Anim.SeriesKey(jobs[j + 1]) == key && jobs[j + 1].Anim.Time >= series[series.Count - 1].Anim.Time)
                        series.Add(jobs[++j]);
                    var sreq = new CaptureRequest
                    {
                        ExportDir = exportDir, ScreenFolder = screenFolder, State = job.State, Viewport = job.Viewport, Apply = job.Apply,
                        OutDir = outDir, CaptureName = job.Name, Boxes = boxes,
                    };
                    var progress = new SeriesProgress();
                    var swatch = Stopwatch.StartNew();
                    var srun = RunSeries(sreq, series, profile, progress, screen);
                    string sfailure = null, sskipped = null;
                    try
                    {
                        while (true)
                        {
                            bool more;
                            try { more = srun.MoveNext(); }
                            catch (NotCapturableException e) { sskipped = e.Message; break; }
                            catch (Exception e) { sfailure = e.GetType().Name + ": " + e.Message; break; }
                            if (!more) break;
                            yield return srun.Current;
                        }
                    }
                    finally
                    {
                        (srun as IDisposable)?.Dispose();
                    }
                    var each = Math.Round(swatch.Elapsed.TotalMilliseconds / series.Count, 1);
                    for (int k = 0; k < series.Count; k++)
                    {
                        var name = series[k].Name;
                        run.Times[name] = each;
                        if (k < progress.Count)
                        {
                            result.Captured.Add(name);
                            if (sreq.Notes.Count > 0) run.Notes[name] = new JArray(sreq.Notes);
                        }
                        else if (sfailure != null)
                        {
                            result.Errors.Add(name + ": " + sfailure);
                            NotCaptured(result, outDir, name, "error: " + sfailure);
                            boxes.Remove(name);
                        }
                        else
                        {
                            NotCaptured(result, outDir, name, sskipped ?? "the animation series stopped before this sample");
                            boxes.Remove(name);
                        }
                    }
                    sinceFlush += series.Count - 1; // every sample is a job for the periodic flush
                    continue;
                }
                var req = new CaptureRequest
                {
                    ExportDir = exportDir, ScreenFolder = screenFolder, State = job.State, Viewport = job.Viewport, Apply = job.Apply,
                    Frozen = job.Frozen, OutDir = outDir, CaptureName = job.Name, Boxes = boxes,
                };
                var watch = Stopwatch.StartNew();
                var capture = RunShared(shared, req, profile, screen, pngs);
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
                    (capture as IDisposable)?.Dispose();
                }
                // a job that stopped midway may have left the screen anywhere: the next job mounts it again; a PNG it already
                // started is on disk before NotCaptured deletes it
                if (failure != null || skipped != null)
                {
                    shared.Drop();
                    foreach (var (_, task) in pngs.Where(p => p.name == job.Name).ToList()) try { task.Wait(); } catch (AggregateException) { }
                    pngs.RemoveAll(p => p.name == job.Name);
                }
                run.Times[job.Name] = Math.Round(watch.Elapsed.TotalMilliseconds, 1);
                if (failure != null)
                {
                    result.Errors.Add(job.Name + ": " + failure);
                    NotCaptured(result, outDir, job.Name, "error: " + failure);
                    boxes.Remove(job.Name);
                }
                else if (skipped != null)
                {
                    NotCaptured(result, outDir, job.Name, skipped);
                    boxes.Remove(job.Name);
                }
                else
                {
                    result.Captured.Add(job.Name);
                    if (req.Notes.Count > 0) run.Notes[job.Name] = new JArray(req.Notes);
                }
            }
            }
            finally
            {
                shared.Drop(); // an abandoned run still destroys its panel
            }
            // every PNG is on disk before the boxes and the done marker say the run went through
            foreach (var (name, task) in pngs)
            {
                try { task.Wait(); }
                catch (AggregateException e)
                {
                    var why = e.InnerException?.Message ?? e.Message;
                    result.Captured.Remove(name);
                    result.Errors.Add(name + ": writing the PNG failed: " + why);
                    NotCaptured(result, outDir, name, "error: writing the PNG failed: " + why);
                    boxes.Remove(name);
                }
            }
            BoxesWriter.WriteAll(Path.Combine(outDir, BoxesWriter.FileName), boxes);
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
        public static IEnumerator CaptureEach(IReadOnlyList<string> exportDirs, IReadOnlyList<string> outDirs, DesignUiProfile profile, List<string> errors, string runId = null)
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
                try { run = CaptureAll(export, DefaultScreenFolder(export, profile), profile, outDirs[i], result, runId); }
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

        /// <summary>
        /// How long a capture run of <paramref name="jobs"/> jobs may take, for the test that runs it (its own NUnit timeout):
        /// 120 s for opening and the first mounts, plus 2 s per job, about seven times the 0.3 s a warm job may take.
        /// </summary>
        public static int TestTimeoutMs(int jobs) => (int)Math.Min(int.MaxValue, 120_000L + 2_000L * Math.Max(0, jobs));

        /// <summary>The number of jobs in an export's <c>goldens/matrix.json</c> (0 when it has none or cannot be read).</summary>
        public static int JobCount(string exportDir)
        {
            try { return CaptureJob.ReadMatrix(Path.Combine(exportDir, MatrixPath)).Count; }
            catch (IrFormatException) { return 0; }
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

        internal sealed class Screen
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

        static Screen Prepare(CaptureRequest req, DesignUiProfile profile)
        {
            if (req == null) throw new ArgumentNullException(nameof(req));
            if (profile == null) throw new ArgumentNullException(nameof(profile));
            if (string.IsNullOrEmpty(req.ExportDir)) throw new ArgumentException("capture '" + req.CaptureName + "' has no export folder");
            var screen = LoadScreen(req.ExportDir, req.ScreenFolder, profile);
            CheckRequest(req, screen);
            return screen;
        }

        /// <summary>What a capture needs of its request: a file name, a viewport, an output folder and a state the screen declares.</summary>
        static void CheckRequest(CaptureRequest req, Screen screen)
        {
            if (req == null) throw new ArgumentNullException(nameof(req));
            if (!CaptureJob.ValidName(req.CaptureName)) throw new ArgumentException("capture name '" + req.CaptureName + "' is not a file name");
            if (req.Viewport.x < 1 || req.Viewport.y < 1) throw new ArgumentException("capture '" + req.CaptureName + "' has no viewport");
            if (string.IsNullOrEmpty(req.OutDir)) throw new ArgumentException("capture '" + req.CaptureName + "' has no output folder");
            if (req.State != DefaultState && !(screen.Ir.States ?? new string[0]).Contains(req.State))
                throw new InvalidOperationException("capture '" + req.CaptureName + "' asks for state '" + req.State + "', which the screen does not declare");
        }

        /// <summary>The export's IR and sample data and the compiled screen (UXML, manifest, fonts), read once per capture run.</summary>
        static Screen LoadScreen(string exportDir, string screenFolder, DesignUiProfile profile)
        {
            if (profile == null) throw new ArgumentNullException(nameof(profile));
            if (string.IsNullOrEmpty(exportDir)) throw new ArgumentException("no export folder", nameof(exportDir));
            var folder = ScreenCompiler.ProjectPath((screenFolder ?? "").Replace('\\', '/').TrimEnd('/'))
                         ?? throw new InvalidOperationException("the compiled screen folder '" + screenFolder + "' is not inside the project");
            var ir = IrReader.Read(Path.Combine(exportDir, ScreenCompiler.IrFileName));
            var reference = ir.ReferenceViewport;
            if (reference == null || reference.Length != 2 || reference[0] != profile.referenceResolution.x || reference[1] != profile.referenceResolution.y ||
                Math.Abs(ir.ScreenMatch - profile.screenMatch) > 1e-6f)
                throw new InvalidOperationException("the export's reference viewport " + (reference == null ? "(none)" : string.Join("×", reference)) + " and screen match " +
                                                    ir.ScreenMatch.ToString(System.Globalization.CultureInfo.InvariantCulture) + " differ from the profile's " +
                                                    profile.referenceResolution.x + "×" + profile.referenceResolution.y + " and " +
                                                    profile.screenMatch.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                                                    "; the capture would not be comparable with the goldens");
            var manifest = GeneratedManifest.Load(folder + "/" + ScreenCompiler.ManifestFileName)
                           ?? throw new InvalidOperationException("'" + folder + "' is not a compiled screen (no " + ScreenCompiler.ManifestFileName + ")");
            if (manifest.screen != ir.Screen)
                throw new InvalidOperationException("'" + folder + "' holds screen '" + manifest.screen + "', not the export's '" + ir.Screen + "'");
            var uxml = folder + "/" + Path.GetFileName(folder) + ".uxml";
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(uxml) ?? throw new InvalidOperationException("no compiled UXML at '" + uxml + "'");
            var fixtures = Path.Combine(exportDir, FixturesPath);
            return new Screen
            {
                Ir = ir, Manifest = manifest, Tree = tree, Folder = folder,
                Fixtures = File.Exists(fixtures) ? IrFixtures.Read(fixtures) : new IrFixtures(),
                Fonts = AssetDatabase.LoadAssetAtPath<StyleSheet>(Path.GetDirectoryName(folder)?.Replace('\\', '/') + "/" + FontMap.FileName),
                // the compiled screens' font set (DesignFonts.asset next to DesignFonts.uss): the reference locale's twins
                TextFonts = AssetDatabase.LoadAssetAtPath<DesignUi.DesignFontSet>(Path.GetDirectoryName(folder)?.Replace('\\', '/') + "/" + DesignUi.DesignFontSet.FileName)
                    ?.FontsFor(profile.referenceLocale).ToList() ?? new List<UnityEngine.TextCore.Text.FontAsset>(),
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

            /// <summary>
            /// The RenderTexture as a PNG, its bytes unchanged (no colour conversion), encoded on a worker thread
            /// (<see cref="ImageConversion.EncodeArrayToPNG"/> is thread-safe) and written to <paramref name="path"/>.
            /// </summary>
            public Task WritePngAsync(string path)
            {
                var tex = new Texture2D(Target.width, Target.height, TextureFormat.RGBA32, false, true) { hideFlags = HideFlags.DontSave };
                var active = RenderTexture.active;
                byte[] raw;
                uint w = (uint)Target.width, h = (uint)Target.height;
                try
                {
                    RenderTexture.active = Target;
                    tex.ReadPixels(new Rect(0, 0, Target.width, Target.height), 0, 0, false); // CPU-side data: no Apply (GPU upload) needed
                    raw = tex.GetRawTextureData();
                }
                finally
                {
                    RenderTexture.active = active;
                    Object.DestroyImmediate(tex);
                }
                return Task.Run(() => File.WriteAllBytes(path, ImageConversion.EncodeArrayToPNG(raw, GraphicsFormat.R8G8B8A8_UNorm, w, h)));
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
        /// One mounted screen and the setup applied to it (state, classes, disabled and checked, pointer, focus), changed
        /// step by step as a real user and the view would change it, with the screen's animation player on a manual clock.
        /// </summary>
        sealed class Session : IDisposable
        {
            CaptureRequest m_Req;
            readonly DesignUiProfile m_Profile;
            /// <summary>Kept mounted from job to job (<see cref="CaptureAll"/>): a press is released off the element (no click).</summary>
            public bool Shared;
            public Vector2Int Viewport => m_Req.Viewport;
            /// <summary>disabled/checked of an element before the session first changed it, by <c>id|state</c>.</summary>
            readonly Dictionary<string, bool> m_Originals = new Dictionary<string, bool>(StringComparer.Ordinal);
            /// <summary>Scroll offsets right after mounting.</summary>
            readonly List<(ScrollView view, Vector2 offset)> m_Scroll = new List<(ScrollView, Vector2)>();
            /// <summary>Design ids to their elements (they stay the same while the screen is mounted).</summary>
            readonly Dictionary<string, VisualElement> m_Named = new Dictionary<string, VisualElement>(StringComparer.Ordinal);
            public readonly Screen Screen;
            public readonly Mount Mount = new Mount();
            public readonly DesignManualClock Clock = new DesignManualClock();
            public VisualElement DocRoot, Root;
            public IPanel Panel;
            public DesignUiAnimationPlayer Player;
            SampleFiller m_Filler;
            double m_Scale;
            string m_State = DefaultState;
            List<CaptureApply> m_Applied = new List<CaptureApply>();
            VisualElement m_PointerTarget, m_Focus;
            Vector2? m_PointerAt;
            bool m_Pressed;
            /// <summary>Descendants of the pointer target made to ignore the pointer (<see cref="Untouchable"/>), restored when it moves on.</summary>
            readonly List<VisualElement> m_Untouched = new List<VisualElement>();
            /// <summary>The panel's and the document's top elements after mounting: one added later is an overlay (an open dropdown menu).</summary>
            readonly HashSet<VisualElement> m_Tops = new HashSet<VisualElement>();

            public Session(CaptureRequest req, DesignUiProfile profile, Screen screen = null)
            {
                m_Req = req;
                m_Profile = profile;
                if (screen == null) Screen = Prepare(req, profile);
                else
                {
                    CheckRequest(req, screen);
                    Screen = screen;
                }
            }

            /// <summary>The next job on the mounted screen: its output, notes and boxes.</summary>
            public void Begin(CaptureRequest req)
            {
                if (req.Viewport != m_Req.Viewport) throw new InvalidOperationException("the mounted screen renders " + m_Req.Viewport + ", not " + req.Viewport);
                m_Req = req;
            }

            /// <summary>Scroll offsets back to the mount's (a focus may have scrolled a view).</summary>
            public IEnumerable<object> RestoreScroll()
            {
                bool moved = false;
                foreach (var (view, offset) in m_Scroll)
                    if (view.scrollOffset != offset)
                    {
                        view.scrollOffset = offset;
                        moved = true;
                    }
                if (moved) for (int i = 0; i < ChangeFrames; i++) yield return null;
            }

            VisualElement Named(string id)
            {
                if (m_Named.TryGetValue(id, out var e))
                {
                    if (e == null || e.panel != null) return e;
                    // an element left the tree (a list bound its slots again and cloned new items): every lookup is stale
                    m_Named.Clear();
                }
                e = BoxesWriter.Find(DocRoot, id);
                m_Named[id] = e;
                return e;
            }

            /// <summary>
            /// Whether the panel shows an element it did not have after mounting (a dropdown menu a press opened, which stays
            /// open): the screen is not the one a fresh mount shows, so the next job mounts it again.
            /// </summary>
            public bool Overlaid()
            {
                var tree = Panel?.visualTree;
                if (tree != null) for (int i = 0; i < tree.hierarchy.childCount; i++) if (!m_Tops.Contains(tree.hierarchy[i])) return true;
                for (int i = 0; i < DocRoot.hierarchy.childCount; i++) if (!m_Tops.Contains(DocRoot.hierarchy[i])) return true;
                return false;
            }

            /// <summary>The previous pointer target's descendants take the pointer again.</summary>
            void RestorePicking()
            {
                foreach (var e in m_Untouched) e.pickingMode = PickingMode.Position;
                m_Untouched.Clear();
            }

            /// <summary>
            /// Takes the pointer off the screen (released off it: no click, so a toggle keeps its value) and focus off its
            /// element, as on a freshly mounted screen; the pointer target's descendants take the pointer again.
            /// </summary>
            IEnumerable<object> Release()
            {
                var away = new Vector2(-10000f, -10000f);
                SendPointer(Panel, EventType.MouseMove, away);
                if (m_Pressed) SendPointer(Panel, EventType.MouseUp, away);
                m_Pressed = Mount.Pressed = false;
                m_PointerAt = Mount.PointerAt = null;
                m_PointerTarget = null;
                RestorePicking();
                if (m_Focus != null)
                {
                    m_Focus.Blur();
                    m_Focus = null;
                }
                for (int i = 0; i < ChangeFrames; i++) yield return null;
            }

            /// <summary>Mounts the screen with its sample data, in <paramref name="state"/>, with the player's reduced motion as given.</summary>
            public IEnumerable<object> Open(string state, bool reducedMotion)
            {
                Mount.Open(m_Req.Viewport, m_Profile, Screen.Tree);
                DocRoot = Mount.Document.rootVisualElement;
                Root = BoxesWriter.Find(DocRoot, Screen.Manifest.root ?? Screen.Ir.Root.Id)
                       ?? throw new InvalidOperationException("the compiled screen has no root element '" + (Screen.Manifest.root ?? Screen.Ir.Root.Id) + "'");
                // an animated compiled root (DesignScreen) attached its player when it was attached; any other root with
                // animated elements gets it here, as its generated view would attach it; it runs on the capture's clock
                Player = DesignUiAnimationPlayer.For(Root);
                if (Player == null && Root.Q(className: DesignAnimationData.MarkerClass) != null) Player = DesignUiAnimationPlayer.Attach(Root);
                if (Player != null)
                {
                    Player.Clock = Clock;
                    Player.ReducedMotion = reducedMotion;
                }
                if (Screen.Fonts != null && !DocRoot.styleSheets.Contains(Screen.Fonts)) DocRoot.styleSheets.Add(Screen.Fonts);
                Root.AddToClassList(FontMap.LocaleClass(m_Profile.referenceLocale));
                m_Filler = new SampleFiller(Screen);
                m_Filler.FillScreen(DocRoot);
                Player?.Rescan(); // repeat items cloned from the template
                if (state != DefaultState) Root.AddToClassList(ScreenBuilder.StateClassPrefix + state);
                m_State = state;
                // the breakpoints that hold at this viewport, as classes on the screen root (the golden's @media rules)
                foreach (var name in ActiveBreakpoints(Screen.Ir, m_Req.Viewport)) Root.AddToClassList(ScreenBuilder.BreakpointClassPrefix + name);
                for (int i = 0; i < MountFrames; i++) yield return null;
                Player?.Rescan(); // list slots made by the ListView's first layout
                Panel = Mount.Panel;
                m_Scale = PanelScale(Panel, m_Req.Viewport);
                DocRoot.Query<ScrollView>().ForEach(v => m_Scroll.Add((v, v.scrollOffset)));
                for (int i = 0; i < Panel.visualTree.hierarchy.childCount; i++) m_Tops.Add(Panel.visualTree.hierarchy[i]);
                for (int i = 0; i < DocRoot.hierarchy.childCount; i++) m_Tops.Add(DocRoot.hierarchy[i]);
            }

            static string Label(CaptureApply a) => a.Kind + " " + (a.Absent ? "!" : "") + a.Name + " " + a.Target;

            /// <summary>The element an item applies to: the IR's own, or its copy in a later written-out repeat item.</summary>
            VisualElement Element(CaptureApply a) =>
                Named(a.Target) ?? throw new InvalidOperationException("the capture applies " + a + ", but the screen has no element '" + a.Target + "'" +
                                                                       (a.Item != null ? " (the sample data has no such written-out repeat item)" : ""));

            static bool IsPointer(CaptureApply a) => a.Kind == CaptureApply.PseudoKind && (a.Name == "hover" || a.Name == "active");
            static bool IsFocus(CaptureApply a) => a.Kind == CaptureApply.PseudoKind && a.Name == "focus";

            /// <summary>Changes the screen from the current setup to <paramref name="state"/> with <paramref name="target"/> applied.</summary>
            public IEnumerable<object> GoTo(string state, List<CaptureApply> target)
            {
                target = target ?? new List<CaptureApply>();
                var now = new HashSet<string>(m_Applied.Select(Label));
                var next = new HashSet<string>(target.Select(Label));
                var off = m_Applied.Where(a => !next.Contains(Label(a)) && !IsPointer(a) && !IsFocus(a)).ToList();
                var on = target.Where(a => !now.Contains(Label(a)) && !IsPointer(a) && !IsFocus(a)).ToList();
                bool changed = state != m_State || off.Count > 0 || on.Count > 0;
                // a fresh mount gets its setup before any pointer or focus: a kept screen whose setup changes lets go of
                // them first, so the pointer then finds its target where the new setup puts it
                if (Shared && changed && (m_PointerTarget != null || m_Pressed || m_Focus != null))
                    foreach (var f in Release()) yield return f;
                if (state != m_State)
                {
                    if (m_State != DefaultState) Root.RemoveFromClassList(ScreenBuilder.StateClassPrefix + m_State);
                    if (state != DefaultState) Root.AddToClassList(ScreenBuilder.StateClassPrefix + state);
                    m_State = state;
                }
                foreach (var a in off) Set(a, false);
                foreach (var a in on) Set(a, true);
                if (changed)
                {
                    m_Filler.SyncMirrors();
                    for (int i = 0; i < ChangeFrames; i++) yield return null;
                }

                var pointer = target.Where(IsPointer).ToList();
                if (pointer.Count > 1)
                    throw new NotCapturableException("hover/active on " + string.Join(" and ", pointer.Select(p => "'" + p.ElementId + "'")) +
                                                     ", which are not ancestors of each other: one pointer cannot be on both");
                var focusItem = target.FirstOrDefault(IsFocus);
                var focus = focusItem != null ? Element(focusItem) : null;
                var pointerTarget = pointer.Count == 1 ? Element(pointer[0]) : null;
                bool press = pointer.Count == 1 && pointer[0].Name == "active";
                if (m_Pressed && (pointerTarget != m_PointerTarget || !press))
                {
                    if (Shared)
                    {
                        // released off the screen: no click (a toggle would change its value), the pointer comes back below
                        var away = new Vector2(-10000f, -10000f);
                        SendPointer(Panel, EventType.MouseMove, away);
                        SendPointer(Panel, EventType.MouseUp, away);
                        m_PointerAt = Mount.PointerAt = null;
                        m_PointerTarget = null;
                    }
                    else SendPointer(Panel, EventType.MouseUp, m_PointerAt.Value);
                    m_Pressed = Mount.Pressed = false;
                    for (int i = 0; i < ChangeFrames; i++) yield return null;
                }
                if (pointerTarget != m_PointerTarget)
                {
                    RestorePicking(); // the previous target's descendants take the pointer again
                    if (pointerTarget == null)
                    {
                        SendPointer(Panel, EventType.MouseMove, new Vector2(-10000f, -10000f));
                        m_PointerAt = Mount.PointerAt = null;
                    }
                    else
                    {
                        var at = PointOn(Panel, pointerTarget);
                        if (at == null && Untouchable(pointerTarget, m_Untouched, out var covering))
                        {
                            // children cover every point: they stop taking the pointer, so only the element and its ancestors hover, as in the golden
                            at = PointOn(Panel, pointerTarget);
                            if (at != null) m_Req.Notes.Add("the pointer is on '" + pointerTarget.name + "' with its descendants ignoring the pointer (" + string.Join(", ", covering) + "): they cover it everywhere");
                        }
                        if (at == null)
                            throw new NotCapturableException("no point of '" + pointer[0].ElementId + "' picks it (it ignores the pointer or other elements cover it), so a real pointer cannot " +
                                                             pointer[0].Name + " it");
                        SendPointer(Panel, EventType.MouseMove, at.Value);
                        m_PointerAt = Mount.PointerAt = at;
                    }
                    m_PointerTarget = pointerTarget;
                    for (int i = 0; i < ChangeFrames; i++) yield return null;
                }
                if (press && !m_Pressed)
                {
                    SendPointer(Panel, EventType.MouseDown, m_PointerAt.Value);
                    m_Pressed = Mount.Pressed = true;
                    for (int i = 0; i < ChangeFrames; i++) yield return null;
                    // UI Toolkit focuses a focusable element on press; the golden forces :active (and :hover) only
                    if (Panel.focusController.focusedElement is VisualElement pressed && pressed != focus)
                    {
                        pressed.Blur();
                        for (int i = 0; i < ChangeFrames; i++) yield return null;
                    }
                }
                if (m_Focus != null && m_Focus != focus)
                {
                    m_Focus.Blur();
                    m_Focus = null;
                    for (int i = 0; i < ChangeFrames; i++) yield return null;
                }
                if (focus != null && focus != m_Focus)
                {
                    focus.Focus();
                    for (int i = 0; i < ChangeFrames; i++) yield return null;
                    var focused = Panel.focusController.focusedElement as VisualElement;
                    if (focused == null || focused != focus && !focus.Contains(focused))
                        throw new NotCapturableException("'" + focus.name + "' does not take focus in Unity (not focusable, disabled or hidden; focused: " +
                                                         (focused?.name ?? "nothing") + ")");
                    m_Focus = focus;
                }
                m_Applied = new List<CaptureApply>(target);
            }

            /// <summary>Applies or removes a class, disabled or checked.</summary>
            void Set(CaptureApply a, bool on)
            {
                var el = Element(a);
                // off again: what the screen had before the session changed it (its markup's and sample data's), not the opposite of on
                var key = a.Target + "|" + a.Kind + "|" + a.Name;
                if (a.Kind == CaptureApply.ClassKind)
                {
                    // an absent item takes a markup class off; leaving it puts the class back; a class the element has (an
                    // item's sample class) stays when the item that added it again is left
                    if (!m_Originals.ContainsKey(key)) m_Originals[key] = el.ClassListContains(a.Name);
                    bool present = a.Absent ? !on && m_Originals[key] : on || m_Originals[key];
                    el.EnableInClassList(a.Name, present);
                    m_Filler.MirrorClass(DocRoot, a.ElementId, a.Name, present, CaptureApply.ItemSuffix(a.Item));
                    return;
                }
                switch (a.Name)
                {
                    case "disabled":
                        if (!m_Originals.ContainsKey(key)) m_Originals[key] = !el.enabledSelf;
                        el.SetEnabled(!(on || m_Originals[key]));
                        break;
                    case "checked":
                        if (!(el is INotifyValueChanged<bool> toggle)) throw new NotCapturableException("checked applies to '" + a.ElementId + "', which is not a toggle in Unity");
                        if (!m_Originals.ContainsKey(key)) m_Originals[key] = toggle.value;
                        toggle.value = on || m_Originals[key];
                        break;
                    default:
                        throw new NotCapturableException("unknown pseudo-state '" + a.Name + "'");
                }
            }

            /// <summary>The element of an IR id that carries its animations: it, or the shadow host its animations moved to.</summary>
            IEnumerable<VisualElement> Animated(string id)
            {
                var el = BoxesWriter.Find(DocRoot, id);
                if (el != null) yield return el;
                var host = BoxesWriter.Find(DocRoot, id + "__shadowhost");
                if (host != null) yield return host;
            }

            /// <summary>Whether the player plays keyframe animation <paramref name="name"/> on the element (or its shadow host).</summary>
            public bool Plays(string id, string name) => Player != null && Animated(id).Any(e => Player.IsPlaying(e, name, out _));

            /// <summary>Whether the player runs the IR animation (a transition of one of its properties, or the keyframe animation).</summary>
            public bool Started(CaptureAnimRef r)
            {
                var node = Find(Screen.Ir.Root, r.ElementId);
                var a = node?.Anims != null && r.Index < node.Anims.Count ? node.Anims[r.Index] : null;
                if (a == null || Player == null) return false;
                if (a.Kind == IrAnim.KeyframesKind) return Plays(r.ElementId, a.Name);
                foreach (var e in Animated(r.ElementId))
                    foreach (var prop in a.Properties ?? new string[0])
                        if (DesignAnimProperties.TryGet(prop, out var p) && Player.IsTransitioning(e, p)) return true;
                return false;
            }

            static IrNode Find(IrNode n, string id)
            {
                if (n == null) return null;
                if (n.Id == id) return n;
                foreach (var c in n.Children ?? new IrNode[0])
                {
                    var hit = Find(c, id);
                    if (hit != null) return hit;
                }
                return null;
            }

            /// <summary>Writes the capture's PNG and its boxes entry.</summary>
            public void Write(string name)
            {
                Directory.CreateDirectory(m_Req.OutDir);
                File.WriteAllBytes(Path.Combine(m_Req.OutDir, name + ".png"), Mount.ReadPng());
                WriteBoxes(name);
            }

            /// <summary>Writes the capture's boxes entry now and its PNG on a worker thread (the task ends once the PNG is on disk).</summary>
            public Task Write(string name, bool encodeOffThread)
            {
                if (!encodeOffThread)
                {
                    Write(name);
                    return Task.CompletedTask;
                }
                Directory.CreateDirectory(m_Req.OutDir);
                var png = Mount.WritePngAsync(Path.Combine(m_Req.OutDir, name + ".png"));
                WriteBoxes(name);
                return png;
            }

            void WriteBoxes(string name)
            {
                var boxes = BoxesWriter.Measure(name, Named, m_Req.Viewport, m_Scale, Screen.Ir);
                if (m_Req.Boxes != null) m_Req.Boxes[name] = boxes;
                else BoxesWriter.Merge(Path.Combine(m_Req.OutDir, BoxesWriter.FileName), boxes);
            }

            public void Dispose() => Mount.Dispose();
        }

        /// <summary>
        /// Makes the element's pickable descendants ignore the pointer (picking mode is not drawn) when they cover every
        /// point of it; adds them to <paramref name="changed"/> (to restore later), returns whether any did and names them.
        /// </summary>
        static bool Untouchable(VisualElement target, List<VisualElement> changed, out List<string> covering)
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
                    changed.Add(e);
                    covering.Add(string.IsNullOrEmpty(e.name) ? e.GetType().Name : e.name);
                }
                for (int i = 0; i < e.hierarchy.childCount; i++) stack.Push(e.hierarchy[i]);
            }
            return covering.Count > 0;
        }

        /// <summary>
        /// The IR breakpoints that hold at a viewport, as the exporter decides them (capture/matrix.ts breakpointsHold): the
        /// panel's logical size under Scale With Screen Size (<c>scale = lerp(W/refW, H/refH, match)</c>, the IR's reference
        /// and match), rounded to whole px, against each breakpoint's min/max width and aspect ratio, in IR order. It mirrors
        /// the exporter for the capture; the runtime breakpoint controller should replace it once it exists.
        /// </summary>
        public static IEnumerable<string> ActiveBreakpoints(IrScreen ir, Vector2Int viewport)
        {
            if (ir?.Breakpoints == null || ir.Breakpoints.Length == 0) yield break;
            var reference = ir.ReferenceViewport != null && ir.ReferenceViewport.Length == 2 ? ir.ReferenceViewport : new[] { 2560, 1440 };
            double rw = viewport.x / (double)reference[0], rh = viewport.y / (double)reference[1];
            double scale = rw + (rh - rw) * ir.ScreenMatch;
            double w = Math.Round(viewport.x / scale, MidpointRounding.AwayFromZero), h = Math.Round(viewport.y / scale, MidpointRounding.AwayFromZero);
            foreach (var b in ir.Breakpoints)
                if ((b.MinWidth == null || w >= b.MinWidth) && (b.MaxWidth == null || w <= b.MaxWidth) &&
                    (b.MinAspect == null || w / h >= b.MinAspect) && (b.MaxAspect == null || w / h <= b.MaxAspect))
                    yield return b.Name;
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
        /// <summary>
        /// The picked element is the target or one of the target control's own parts (a text field's visual input and
        /// text element: unnamed or <c>unity-</c> named, never a design element), so the pointer hovers the target and no
        /// design element below it.
        /// </summary>
        static bool IsPartOf(VisualElement picked, VisualElement target)
        {
            for (var x = picked; x != null; x = x.hierarchy.parent)
            {
                if (x == target) return true;
                if (!string.IsNullOrEmpty(x.name) && !x.name.StartsWith("unity-", StringComparison.Ordinal)) return false;
            }
            return false;
        }

        static Vector2? PointOn(IPanel panel, VisualElement target)
        {
            var b = target.worldBound;
            if (float.IsNaN(b.width) || b.width <= 0 || b.height <= 0) return null;
            bool Hits(Vector2 p) => IsPartOf(panel.Pick(p), target);
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
            /// <summary>The scope is a later written-out item of a repeat, or inside one: its own repeats' first items get a name suffix too.</summary>
            public readonly bool InClone;

            public Scope(IrFixtures data, Scope parent, bool clone = false)
            {
                Data = data ?? new IrFixtures();
                _parent = parent;
                InClone = clone || (parent?.InClone ?? false);
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
            readonly Dictionary<string, VisualTreeAsset> _templates = new Dictionary<string, VisualTreeAsset>(StringComparer.Ordinal);

            public SampleFiller(Screen screen)
            {
                _screen = screen;
            }

            public void FillScreen(VisualElement docRoot)
            {
                var roots = new[] { docRoot };
                Fill(_screen.Ir.Root, roots, new Scope(_screen.Fixtures, null), _screen.Tree);
                Wire(roots);
                SyncMirrors(); // the items' disabled and checked reach their shadow hosts at once
            }

            /// <summary>The item template of a repeat (<c>&lt;Repeat&gt;Item.uxml</c>), the one its generated view clones items from; null when the screen has none.</summary>
            VisualTreeAsset ItemTemplate(RepeatEntry entry)
            {
                if (string.IsNullOrEmpty(entry.template)) return null;
                if (!_templates.TryGetValue(entry.template, out var t))
                    _templates[entry.template] = t = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(_screen.Folder + "/" + entry.template);
                return t;
            }

            /// <summary>An inline repeat's item roots cloned from its item template, else from the whole screen's tree (an older compile).</summary>
            List<VisualElement> CloneItem(RepeatEntry entry, VisualTreeAsset source)
            {
                var template = ItemTemplate(entry);
                if (template != null)
                {
                    var holder = new VisualElement();
                    template.CloneTree(holder);
                    var roots = holder.Children().ToList();
                    if (roots.Count == entry.items.Length && roots.Select(r => r.name).SequenceEqual(entry.items))
                    {
                        foreach (var r in roots) r.RemoveFromHierarchy();
                        return roots;
                    }
                }
                var fresh = source.Instantiate();
                var clones = entry.items.Select(n => BoxesWriter.Find(fresh, n) ?? throw new InvalidOperationException("no repeat item '" + n + "' in the template")).ToList();
                foreach (var c in clones) c.RemoveFromHierarchy();
                return clones;
            }

            /// <summary>
            /// Puts a class the job applies on (or takes it off) the shadow hosts that mirror it for the element (with
            /// <paramref name="suffix"/>: its copy in a later written-out repeat item).
            /// </summary>
            public void MirrorClass(VisualElement docRoot, string elementId, string cls, bool on = true, string suffix = "")
            {
                foreach (var m in _screen.Manifest.mirrors.Where(m => m.element == elementId && m.classes != null && m.classes.Contains(cls)))
                    BoxesWriter.Find(docRoot, m.host + suffix)?.EnableInClassList(cls, on);
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
                if (el != null)
                {
                    FillLocalized(node, el);
                    FillText(node, el, scope);
                }
                if (node.Repeat != null)
                {
                    Repeat(node, roots, scope, source);
                    return;
                }
                foreach (var c in node.Children ?? new IrNode[0]) Fill(c, roots, scope, source);
            }

            /// <summary>
            /// The localized texts of an element (String Table bindings of a localizing profile's compile, which hold no text in
            /// the UXML): each binding is taken off and the element shows the design's reference text (the IR's <c>tr</c>; a
            /// text's arguments are filled in afterwards by <see cref="FillText"/>, as for a static compile).
            /// </summary>
            void FillLocalized(IrNode node, VisualElement el)
            {
                List<BindingId> localized = null;
                foreach (var info in el.GetBindingInfos())
                    if (info.binding is DesignUi.IDesignLocalizedText) (localized ?? (localized = new List<BindingId>())).Add(info.bindingId);
                if (localized == null) return;
                IrText Attr(string name) => node.AttrTexts != null && node.AttrTexts.TryGetValue(name, out var t) ? t : null;
                foreach (var id in localized)
                {
                    el.ClearBinding(id);
                    switch (id.ToString())
                    {
                        case "text":
                        case "value":
                            if (node.Text == null) break;
                            PrepareFonts(node.Text.Tr ?? "");
                            SetText(el, node.Text.Tr ?? "", node.Text.Rich);
                            break;
                        case "placeholderText":
                            if (el is TextField field && Attr("placeholder") != null) field.textEdition.placeholder = Attr("placeholder").Tr ?? "";
                            break;
                        case "tooltip":
                            if (Attr("title") != null) el.tooltip = Attr("title").Tr ?? "";
                            break;
                    }
                }
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
                    var clones = CloneItem(entry, source);
                    FillItem(node, clones, new Scope(Item(i), scope, true), source);
                    Wire(clones);
                    foreach (var c in clones)
                    {
                        c.RemoveFromClassList(ScreenBuilder.FirstItemClass);
                        Rename(c, "#" + i);
                        container.Insert(at++, c);
                    }
                }
                // the first item inside a later item of an outer repeat is named "#0" (then the outer item's "#k"), so every
                // written-out copy has its own name (CaptureApply.ItemSuffix): wired first, while it still has the design ids
                if (scope.InClone)
                {
                    Wire(first);
                    foreach (var r in first) Rename(r, "#0");
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
                    FillItem(node, itemRoots, new Scope(item(i), scope, i > 0), template);
                    Wire(itemRoots);
                    if (i > 0 || scope.InClone) foreach (var r in itemRoots) Rename(r, "#" + i);
                };
                list.itemsSource = Enumerable.Range(0, count).ToList();
            }

            /// <summary>
            /// Fills one item (the repeat node's children below the item's compiled roots) and gives it what its written-out
            /// sample shows: its classes (on the element and the shadow hosts that mirror them), its controls' disabled and
            /// checked states, and the elements its markup hides, through the item view's visibility setter's path
            /// (<see cref="DesignUi.DesignView.SetVisible"/> on the element the manifest names as the owner).
            /// </summary>
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
                foreach (var kv in scope.Data.States)
                {
                    var el = Find(itemRoots, kv.Key);
                    if (el == null) continue;
                    DesignUi.DesignView.SetEnabled(el, !kv.Value.Contains("disabled"), null);
                    if (el is INotifyValueChanged<bool> toggle) toggle.SetValueWithoutNotify(kv.Value.Contains("checked"));
                }
                foreach (var kv in scope.Data.Hidden)
                {
                    if (_screen.Manifest.visibility == null || !_screen.Manifest.visibility.TryGetValue(kv.Key, out var owner))
                        throw new InvalidOperationException("the sample data hides '" + kv.Key + "' in a repeat item, but the compiled screen has no visibility setter for it; " +
                                                            "import the screen again from a current export");
                    var target = Find(itemRoots, owner);
                    if (target != null) DesignUi.DesignView.SetVisible(target, !kv.Value);
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
                if (File.Exists(path + ".tmp")) File.Delete(path + ".tmp"); // a write a stopped run left
            }
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
                ["timings"] = new JObject { ["captures"] = run.Times, ["pngPendingPeak"] = s_PendingPeak, ["totalMs"] = Math.Round(totalMs, 1) },
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
                BoxesWriter.WriteText(path, sw.ToString().Replace("\r\n", "\n") + "\n");
            }
        }
    }
}
