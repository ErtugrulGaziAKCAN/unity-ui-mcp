using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace DesignUi.Editor
{
    public struct BridgeRequestInfo
    {
        public DateTime Utc;
        public string Op;
        public int Code;
    }

    /// <summary>
    /// Loopback HTTP endpoint inside the open Editor. The listener thread never calls Unity APIs.
    /// <para>
    /// <c>POST /import</c> answers as soon as the written files are imported: <c>{ code, log, changed, imported, compiled,
    /// compiling, compileId, ms }</c>. When a generated C# file changed (<c>compiled</c>), Unity compiles and reloads the
    /// scripts afterwards; <c>compiling</c> stays true in <c>GET /status</c> until that reload (or until the compile fails or
    /// never starts), and <c>lastCompile</c> then says how it ended for that <c>compileId</c>.
    /// </para>
    /// </summary>
    [InitializeOnLoad]
    public static class DesignUiBridge
    {
        const string TokenKey = "DesignUi.BridgeToken";
        const string CompileIdKey = "DesignUi.Bridge.CompileId";
        const string PendingCompileKey = "DesignUi.Bridge.PendingCompile";
        const string LastCompileKey = "DesignUi.Bridge.LastCompile";
        const int MaxBodyBytes = 1024 * 1024;
        const int MaxCompileErrors = 20;

        /// <summary>How long an import's script change may wait for Unity to start compiling before it counts as not started.</summary>
        internal static TimeSpan CompileStartTimeout = TimeSpan.FromSeconds(60);

        internal static Func<string, string, bool, OpResult> ImportHandler = DesignUiOps.Import;
        internal static Func<string, string, OpResult> KitSyncHandler = DesignUiOps.KitSync;

        sealed class WorkItem
        {
            public Func<OpResult> Run;
            public string Op;
            public int Generation;
            public long Ms;
            /// <summary>Extra answer fields, set on the main thread before Done.</summary>
            public JObject Answer;
            public readonly TaskCompletionSource<OpResult> Done =
                new TaskCompletionSource<OpResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        static readonly object s_Lock = new object();
        static readonly ConcurrentQueue<WorkItem> s_Work = new ConcurrentQueue<WorkItem>();
        static readonly ConcurrentQueue<Action> s_MainActions = new ConcurrentQueue<Action>();

        static HttpListener s_Listener;
        static int s_Port;
        static string s_Token;
        static int s_Busy;
        static BridgeRequestInfo? s_LastRequest;
        static BridgeRequestInfo? s_LastOperation;
        static volatile bool s_IsCompiling;
        static volatile bool s_AutoStartPending;
        static int s_Generation;

        // The script compile an import started (0: none); persisted in SessionState so the next domain can end it.
        static volatile int s_PendingCompile;
        static DateTime s_PendingSince;
        static bool s_CompileSeen;
        static volatile string s_LastCompile = "";
        static readonly List<string> s_CompileErrors = new List<string>();
        static List<string> s_FinishedErrors = new List<string>();
        static int s_CompilesFinished;

        // Cached on the main thread for the listener thread.
        static string s_ProjectPath;
        static string s_Version = "unknown";

        public static bool IsListening
        {
            get { lock (s_Lock) return s_Listener != null && s_Listener.IsListening; }
        }

        public static int Port
        {
            get { lock (s_Lock) return s_Listener != null && s_Listener.IsListening ? s_Port : 0; }
        }

        public static BridgeRequestInfo? LastRequest
        {
            get { lock (s_Lock) return s_LastRequest; }
        }

        public static event Action StateChanged;

        internal static bool IsBusy => Volatile.Read(ref s_Busy) != 0;

        /// <summary>An import changed scripts and the Editor has not reloaded them yet.</summary>
        internal static bool CompilePending => s_PendingCompile != 0;

        static DesignUiBridge()
        {
            AssemblyReloadEvents.beforeAssemblyReload += OnBeforeReload;
            EditorApplication.quitting += OnQuitting;
            EditorApplication.update += Update;
            CompilationPipeline.compilationStarted += OnCompilationStarted;
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompiled;
            CompilationPipeline.compilationFinished += OnCompilationFinished;
            AfterReload();
            // Auto-start runs on the first update tick: delayCall is not processed while Unity is unfocused.
            if (!Application.isBatchMode) s_AutoStartPending = true;
        }

        internal static void ResetLastRequestForTests()
        {
            lock (s_Lock) { s_LastRequest = null; s_LastOperation = null; }
        }

        internal static void RequestAutoStartForTests() => s_AutoStartPending = true;

        internal static void AfterReloadForTests() => AfterReload();

        internal static void CompileFinishedForTests(IEnumerable<string> errors)
        {
            OnCompilationStarted(null);
            s_CompileErrors.AddRange(errors);
            OnCompilationFinished(null);
        }

        internal static void ResetCompileForTests()
        {
            SessionState.EraseInt(PendingCompileKey);
            SessionState.EraseString(LastCompileKey);
            s_PendingCompile = 0;
            s_LastCompile = "";
            s_CompileErrors.Clear();
            CompileStartTimeout = TimeSpan.FromSeconds(60);
        }

        // ---- the script compile after an import -----------------------------------------------------------------

        /// <summary>The domain was (re)loaded: a compile an import was waiting for has finished with this reload.</summary>
        static void AfterReload()
        {
            s_LastCompile = SessionState.GetString(LastCompileKey, "");
            var pending = SessionState.GetInt(PendingCompileKey, 0);
            if (pending != 0) EndCompile(pending, "reloaded", null);
        }

        static int BeginCompile()
        {
            var id = SessionState.GetInt(CompileIdKey, 0) + 1;
            SessionState.SetInt(CompileIdKey, id);
            SessionState.SetInt(PendingCompileKey, id);
            s_PendingSince = DateTime.UtcNow;
            s_CompileSeen = false;
            s_PendingCompile = id;
            return id;
        }

        static void EndCompile(int id, string state, IEnumerable<string> errors)
        {
            SessionState.SetInt(PendingCompileKey, 0);
            s_PendingCompile = 0;
            var o = new JObject
            {
                ["id"] = id,
                ["state"] = state,
                ["ok"] = state == "reloaded",
                ["errors"] = new JArray((errors ?? Enumerable.Empty<string>()).Take(MaxCompileErrors).Cast<object>().ToArray()),
                ["finishedAt"] = DateTime.UtcNow.ToString("o"),
            };
            var json = o.ToString(Newtonsoft.Json.Formatting.None);
            SessionState.SetString(LastCompileKey, json);
            s_LastCompile = json;
            Notify();
        }

        static void OnCompilationStarted(object _)
        {
            s_CompileErrors.Clear();
            if (s_PendingCompile != 0) s_CompileSeen = true;
        }

        static void OnAssemblyCompiled(string assembly, CompilerMessage[] messages)
        {
            foreach (var m in messages ?? new CompilerMessage[0])
                if (m.type == CompilerMessageType.Error) s_CompileErrors.Add(m.message);
        }

        // A failed compile reloads nothing, so it ends the wait here; a successful one ends it in the next domain.
        static void OnCompilationFinished(object _)
        {
            s_FinishedErrors = s_CompileErrors.ToList();
            s_CompilesFinished++;
            if (s_PendingCompile != 0 && s_FinishedErrors.Count > 0) EndCompile(s_PendingCompile, "failed", s_FinishedErrors);
        }

        /// <summary>The import answer's fields about what changed, and the compile wait when a C# file changed.</summary>
        static JObject ImportAnswer(OpResult r, int compilesBefore)
        {
            var changed = (r.Changed ?? new string[0]).Where(p => !string.IsNullOrEmpty(p)).ToList();
            var imported = changed.Select(ScreenCompiler.ProjectPath).Where(p => p != null).ToList();
            var compiled = imported.Where(p => p.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)).ToList();
            int id = 0;
            if (r.Code == 0 && compiled.Count > 0)
            {
                id = BeginCompile();
                // a compile that already ran inside the import (it happens synchronously in some Editor states)
                if (s_CompilesFinished != compilesBefore)
                {
                    s_CompileSeen = true;
                    if (s_FinishedErrors.Count > 0) EndCompile(id, "failed", s_FinishedErrors);
                }
            }
            return new JObject
            {
                ["changed"] = new JArray(changed.Cast<object>().ToArray()),
                ["imported"] = new JArray(imported.Cast<object>().ToArray()),
                ["compiled"] = new JArray(compiled.Cast<object>().ToArray()),
                ["compiling"] = id != 0 && s_PendingCompile == id,
                ["compileId"] = id != 0 ? (JToken)id : JValue.CreateNull(),
            };
        }

        /// <summary>A client that went away before its answer was written: not an error of the bridge.</summary>
        internal static bool IsClientDisconnect(Exception e)
        {
            if (e is AggregateException a) return a.InnerExceptions.Count > 0 && a.InnerExceptions.All(IsClientDisconnect);
            return e is HttpListenerException || e is IOException || e is ObjectDisposedException || e is SocketException;
        }

        public static void Restart()
        {
            Stop(false);
            if (DesignUiBridgeSettings.Enabled) Start();
        }

        internal static void StartForTests() => Start();
        internal static void StopForTests() => Stop(true);

        static void OnBeforeReload() => Stop(false);

        static void OnQuitting() => Stop(true);

        static void Update()
        {
            s_IsCompiling = EditorApplication.isCompiling;
            if (s_PendingCompile != 0)
            {
                if (s_IsCompiling) s_CompileSeen = true;
                else if (!s_CompileSeen && DateTime.UtcNow - s_PendingSince > CompileStartTimeout)
                    EndCompile(s_PendingCompile, "not-started", new[]
                    {
                        "Unity did not start compiling the changed scripts within " + CompileStartTimeout.TotalSeconds.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture) +
                        " s (Auto Refresh off, or the Editor waits for focus); bring Unity to the front or refresh it",
                    });
            }
            if (s_AutoStartPending)
            {
                s_AutoStartPending = false;
                if (DesignUiBridgeSettings.Enabled) Start();
            }
            while (s_Work.TryDequeue(out var item))
            {
                if (item.Generation != Volatile.Read(ref s_Generation))
                {
                    item.Done.TrySetResult(new OpResult(1, "Bridge stopped."));
                    continue;
                }
                OpResult r;
                var watch = System.Diagnostics.Stopwatch.StartNew();
                int compilesBefore = s_CompilesFinished;
                try { r = item.Run(); }
                catch (Exception e) { r = new OpResult(1, "Unhandled error: " + e.Message); Debug.LogException(e); }
                item.Ms = watch.ElapsedMilliseconds;
                if (item.Op == "import") item.Answer = ImportAnswer(r, compilesBefore);
                Record(item.Op, r.Code, true);
                item.Done.TrySetResult(r);
            }
            while (s_MainActions.TryDequeue(out var a))
            {
                try { a(); } catch (Exception e) { Debug.LogException(e); }
            }
        }

        static string BridgeJsonPath =>
            Path.Combine(DesignUiBridgeSettings.ProjectRoot, "Library", "DesignUi", "bridge.json");

        static string GetOrCreateToken()
        {
            var t = SessionState.GetString(TokenKey, "");
            if (!string.IsNullOrEmpty(t) && t.Length == 64) return t;
            var bytes = new byte[32];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            var sb = new StringBuilder(64);
            foreach (var b in bytes) sb.Append(b.ToString("x2"));
            t = sb.ToString();
            SessionState.SetString(TokenKey, t);
            return t;
        }

        static int ReadPreviousPort()
        {
            try
            {
                var p = BridgeJsonPath;
                if (File.Exists(p))
                {
                    var port = JObject.Parse(File.ReadAllText(p)).Value<int?>("port") ?? 0;
                    if (port >= 1 && port <= 65535) return port;
                }
            }
            catch (Exception) { }
            return 0;
        }

        static int FindFreePort()
        {
            var l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            try { return ((IPEndPoint)l.LocalEndpoint).Port; }
            finally { l.Stop(); }
        }

        static HttpListener TryListen(int port)
        {
            if (port < 1 || port > 65535) return null;
            HttpListener l = null;
            try
            {
                l = new HttpListener();
                l.Prefixes.Add("http://127.0.0.1:" + port + "/");
                l.Start();
                return l;
            }
            catch (Exception)
            {
                try { l?.Close(); } catch (Exception) { }
                return null;
            }
        }

        internal static void Start()
        {
            lock (s_Lock)
            {
                if (s_Listener != null && s_Listener.IsListening) return;
            }

            s_ProjectPath = DesignUiBridgeSettings.ProjectRoot;
            if (s_Version == "unknown")
            {
                var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(DesignUiBridge).Assembly);
                if (info != null) s_Version = info.version;
            }
            s_Token = GetOrCreateToken();
            s_IsCompiling = EditorApplication.isCompiling;

            int port = ReadPreviousPort();
            HttpListener listener = TryListen(port);
            for (int i = 0; i < 10 && listener == null; i++)
            {
                try { port = FindFreePort(); }
                catch (Exception) { continue; }
                listener = TryListen(port);
            }

            if (listener == null)
            {
                Debug.LogWarning("DesignUi: bridge could not find a free loopback port.");
                return;
            }

            lock (s_Lock)
            {
                s_Listener = listener;
                s_Port = port;
            }

            WriteBridgeJson(port);
            Task.Run(() => AcceptLoop(listener));
            Notify();
        }

        static void WriteBridgeJson(int port)
        {
            try
            {
                var p = BridgeJsonPath;
                Directory.CreateDirectory(Path.GetDirectoryName(p));
                var o = new JObject
                {
                    ["port"] = port,
                    ["token"] = s_Token,
                    ["projectPath"] = s_ProjectPath,
                    ["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id,
                    ["version"] = s_Version,
                };
                DesignUiBridgeSettings.WriteAtomic(p, o.ToString());
            }
            catch (Exception e)
            {
                Debug.LogWarning("DesignUi: could not write bridge.json: " + e.Message);
            }
        }

        internal static void Stop(bool deleteFile)
        {
            HttpListener l;
            lock (s_Lock)
            {
                l = s_Listener;
                s_Listener = null;
                s_Port = 0;
            }
            Interlocked.Increment(ref s_Generation);
            while (s_Work.TryDequeue(out var item))
                item.Done.TrySetResult(new OpResult(1, "Bridge stopped."));
            // an answer being written (e.g. an import right before the reload it caused) goes out before the listener closes
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (l != null && IsBusy && sw.ElapsedMilliseconds < 2000) Thread.Sleep(5);
            if (l != null)
            {
                try { l.Stop(); } catch (Exception) { }
                try { l.Close(); } catch (Exception) { }
            }
            if (deleteFile)
            {
                try
                {
                    var p = BridgeJsonPath;
                    if (File.Exists(p)) File.Delete(p);
                }
                catch (Exception) { }
            }
            if (l != null) Notify();
        }

        static void Notify()
        {
            // StateChanged is raised on the main thread; Start/Stop already run there, but requests do not.
            s_MainActions.Enqueue(() => StateChanged?.Invoke());
        }

        static void Record(string op, int code, bool isOperation)
        {
            var info = new BridgeRequestInfo { Utc = DateTime.UtcNow, Op = op, Code = code };
            lock (s_Lock)
            {
                s_LastRequest = info;
                if (isOperation) s_LastOperation = info;
            }
            Notify();
        }

        static async Task AcceptLoop(HttpListener listener)
        {
            while (listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = await listener.GetContextAsync().ConfigureAwait(false); }
                catch (Exception) { return; }
                _ = Task.Run(() => HandleSafe(ctx));
            }
        }

        static async Task HandleSafe(HttpListenerContext ctx)
        {
            try { await Handle(ctx).ConfigureAwait(false); }
            catch (Exception e)
            {
                if (IsClientDisconnect(e))
                    s_MainActions.Enqueue(() => Debug.Log("DesignUi: a bridge client closed the connection before its answer was sent (" + e.GetType().Name + ": " + e.Message + ")."));
                else s_MainActions.Enqueue(() => Debug.LogException(e));
                try { ctx.Response.Abort(); } catch (Exception) { }
            }
        }

        static void Respond(HttpListenerContext ctx, int status, JObject body)
        {
            var bytes = Encoding.UTF8.GetBytes(body.ToString(Newtonsoft.Json.Formatting.None));
            var r = ctx.Response;
            r.StatusCode = status;
            r.ContentType = "application/json; charset=utf-8";
            r.ContentLength64 = bytes.Length;
            r.OutputStream.Write(bytes, 0, bytes.Length);
            r.OutputStream.Close();
        }

        static void Error(HttpListenerContext ctx, int status, string message) =>
            Respond(ctx, status, new JObject { ["error"] = message });

        static bool TokenOk(HttpListenerRequest req)
        {
            var h = req.Headers["Authorization"];
            var expected = "Bearer " + s_Token;
            if (string.IsNullOrEmpty(h) || h.Length != expected.Length) return false;
            int diff = 0;
            for (int i = 0; i < h.Length; i++) diff |= h[i] ^ expected[i];
            return diff == 0;
        }

        // Discards up to 16 MB of the rest of the upload so the client sees the 413 instead of a reset connection.
        static void Drain(HttpListenerRequest req, long alreadyRead)
        {
            try
            {
                var buf = new byte[8192];
                long total = alreadyRead;
                int n;
                while (total < 16L * 1024 * 1024 && (n = req.InputStream.Read(buf, 0, buf.Length)) > 0) total += n;
            }
            catch (Exception) { }
        }

        static string ReadBody(HttpListenerRequest req, out bool tooLarge)
        {
            tooLarge = false;
            if (req.ContentLength64 > MaxBodyBytes) { tooLarge = true; Drain(req, 0); return null; }
            using (var ms = new MemoryStream())
            {
                var buf = new byte[8192];
                int n;
                while ((n = req.InputStream.Read(buf, 0, buf.Length)) > 0)
                {
                    ms.Write(buf, 0, n);
                    if (ms.Length > MaxBodyBytes) { tooLarge = true; Drain(req, ms.Length); return null; }
                }
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }

        static async Task Handle(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            if (!TokenOk(req)) { Error(ctx, 401, "unauthorized"); return; }

            var path = req.Url.AbsolutePath;
            var method = req.HttpMethod;

            if (path == "/status")
            {
                if (method != "GET") { Error(ctx, 405, "method not allowed"); return; }
                BridgeRequestInfo? last;
                lock (s_Lock) last = s_LastOperation;
                var lastCompile = s_LastCompile;
                var body = new JObject
                {
                    ["projectPath"] = s_ProjectPath,
                    ["isCompiling"] = s_IsCompiling,
                    ["compiling"] = s_IsCompiling || s_PendingCompile != 0,
                    ["lastCompile"] = string.IsNullOrEmpty(lastCompile) ? JValue.CreateNull() : JToken.Parse(lastCompile),
                    ["busy"] = IsBusy,
                    ["last"] = last.HasValue
                        ? new JObject
                        {
                            ["op"] = last.Value.Op,
                            ["code"] = last.Value.Code,
                            ["finishedAt"] = last.Value.Utc.ToString("o"),
                        }
                        : (JToken)JValue.CreateNull(),
                };
                Respond(ctx, 200, body);
                Record("status", 0, false);
                return;
            }

            if (path != "/import" && path != "/kit-sync") { Error(ctx, 404, "not found"); return; }
            if (method != "POST") { Error(ctx, 405, "method not allowed"); return; }

            var text = ReadBody(req, out var tooLarge);
            if (tooLarge) { Error(ctx, 413, "body too large"); return; }

            JObject json;
            try { json = JObject.Parse(text); }
            catch (Exception) { Error(ctx, 400, "invalid json"); return; }

            bool isImport = path == "/import";
            string profile = json["profile"]?.Type == JTokenType.String ? json.Value<string>("profile") : null;
            string dir = json[isImport ? "exportDir" : "kitDir"]?.Type == JTokenType.String
                ? json.Value<string>(isImport ? "exportDir" : "kitDir") : null;
            bool discard = false;
            if (isImport)
            {
                var d = json["discardManualEdits"];
                if (d == null || d.Type != JTokenType.Boolean) { Error(ctx, 400, "missing discardManualEdits"); return; }
                discard = d.Value<bool>();
            }
            if (profile == null) { Error(ctx, 400, "missing profile"); return; }
            if (dir == null) { Error(ctx, 400, isImport ? "missing exportDir" : "missing kitDir"); return; }

            if (Interlocked.CompareExchange(ref s_Busy, 1, 0) != 0) { Error(ctx, 409, "busy"); return; }
            try
            {
                var item = new WorkItem();
                var op = isImport ? "import" : "kit-sync";
                item.Op = op;
                item.Generation = Volatile.Read(ref s_Generation);
                item.Run = () => isImport ? ImportHandler(profile, dir, discard) : KitSyncHandler(profile, dir);
                s_Work.Enqueue(item);
                var result = await item.Done.Task.ConfigureAwait(false);
                var answer = new JObject { ["code"] = result.Code, ["log"] = result.Log ?? "", ["ms"] = item.Ms };
                if (item.Answer != null) foreach (var p in item.Answer.Properties()) answer[p.Name] = p.Value;
                else answer["compiling"] = false;
                Respond(ctx, 200, answer);
            }
            finally
            {
                Volatile.Write(ref s_Busy, 0);
            }
        }
    }
}
