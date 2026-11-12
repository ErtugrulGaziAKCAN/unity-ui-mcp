using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor
{
    public struct BridgeRequestInfo
    {
        public DateTime Utc;
        public string Op;
        public int Code;
    }

    /// <summary>Loopback HTTP endpoint inside the open Editor. The listener thread never calls Unity APIs.</summary>
    [InitializeOnLoad]
    public static class DesignUiBridge
    {
        const string TokenKey = "DesignUi.BridgeToken";
        const int MaxBodyBytes = 1024 * 1024;

        internal static Func<string, string, bool, OpResult> ImportHandler = DesignUiOps.Import;
        internal static Func<string, string, OpResult> KitSyncHandler = DesignUiOps.KitSync;

        sealed class WorkItem
        {
            public Func<OpResult> Run;
            public string Op;
            public int Generation;
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

        static DesignUiBridge()
        {
            AssemblyReloadEvents.beforeAssemblyReload += OnBeforeReload;
            EditorApplication.quitting += OnQuitting;
            EditorApplication.update += Update;
            // Auto-start runs on the first update tick: delayCall is not processed while Unity is unfocused.
            if (!Application.isBatchMode) s_AutoStartPending = true;
        }

        internal static void ResetLastRequestForTests()
        {
            lock (s_Lock) { s_LastRequest = null; s_LastOperation = null; }
        }

        internal static void RequestAutoStartForTests() => s_AutoStartPending = true;

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
                try { r = item.Run(); }
                catch (Exception e) { r = new OpResult(1, "Unhandled error: " + e.Message); Debug.LogException(e); }
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
                s_MainActions.Enqueue(() => Debug.LogException(e));
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
                var body = new JObject
                {
                    ["projectPath"] = s_ProjectPath,
                    ["isCompiling"] = s_IsCompiling,
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
                Respond(ctx, 200, new JObject { ["code"] = result.Code, ["log"] = result.Log ?? "" });
            }
            finally
            {
                Volatile.Write(ref s_Busy, 0);
            }
        }
    }
}
