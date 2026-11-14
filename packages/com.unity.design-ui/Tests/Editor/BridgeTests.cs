using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace DesignUi.Editor.Tests
{
    public class BridgeTests
    {
        static int s_MainThread;
        static readonly HttpClient s_Http = new HttpClient();

        bool m_WasListening;
        bool m_SettingsExisted;
        string m_SettingsBackup;
        Func<string, string, bool, OpResult> m_Import;
        Func<string, string, OpResult> m_Kit;

        static string Root => DesignUiBridgeSettings.ProjectRoot;
        static string BridgeJson => Path.Combine(Root, "Library", "DesignUi", "bridge.json");

        [OneTimeSetUp]
        public void OneTimeSetUp() => s_MainThread = Thread.CurrentThread.ManagedThreadId;

        [SetUp]
        public void SetUp()
        {
            m_WasListening = DesignUiBridge.IsListening;
            var p = DesignUiBridgeSettings.SettingsPath;
            m_SettingsExisted = File.Exists(p);
            m_SettingsBackup = m_SettingsExisted ? File.ReadAllText(p) : null;
            m_Import = DesignUiBridge.ImportHandler;
            m_Kit = DesignUiBridge.KitSyncHandler;
            DesignUiBridge.ResetCompileForTests();
            // Make sure the bridge runs with the setting on, without persisting a different value than the original.
            DesignUiBridge.StartForTests();
        }

        [TearDown]
        public void TearDown()
        {
            DesignUiBridge.ImportHandler = m_Import;
            DesignUiBridge.KitSyncHandler = m_Kit;
            DesignUiBridge.ResetCompileForTests();
            var p = DesignUiBridgeSettings.SettingsPath;
            if (m_SettingsExisted) File.WriteAllText(p, m_SettingsBackup);
            else if (File.Exists(p)) File.Delete(p);
            DesignUiBridgeSettings.ResetCache();
            DesignUiBridge.StopForTests();
            if (m_WasListening && DesignUiBridgeSettings.Enabled) DesignUiBridge.StartForTests();
        }

        static JObject Cfg() => JObject.Parse(File.ReadAllText(BridgeJson));

        static Task<(int status, JObject body)> Send(string method, string path, string token, string json = null)
        {
            var cfg = Cfg();
            int port = cfg.Value<int>("port");
            return Task.Run(async () =>
            {
                var req = new HttpRequestMessage(new HttpMethod(method), "http://127.0.0.1:" + port + path);
                if (token != null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                if (json != null) req.Content = new StringContent(json, Encoding.UTF8, "application/json");
                using (var res = await s_Http.SendAsync(req))
                {
                    var text = await res.Content.ReadAsStringAsync();
                    JObject o = null;
                    try { o = JObject.Parse(text); } catch (Exception) { }
                    return ((int)res.StatusCode, o);
                }
            });
        }

        static IEnumerator Wait(Task t)
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (!t.IsCompleted)
            {
                if (sw.Elapsed.TotalSeconds > 20) Assert.Fail("HTTP request timed out");
                yield return null;
            }
            if (t.IsFaulted) throw t.Exception;
        }

        static string Token() => Cfg().Value<string>("token");

        [Test]
        public void BridgeJson_HasTokenAndProjectPath()
        {
            Assert.IsTrue(DesignUiBridge.IsListening);
            Assert.IsTrue(File.Exists(BridgeJson));
            var cfg = Cfg();
            StringAssert.IsMatch("^[0-9a-f]{64}$", cfg.Value<string>("token"));
            Assert.AreEqual(Path.GetFullPath(Root), Path.GetFullPath(cfg.Value<string>("projectPath")));
            Assert.AreEqual(DesignUiBridge.Port, cfg.Value<int>("port"));
            Assert.IsNotEmpty(cfg.Value<string>("version"));
            Assert.Greater(cfg.Value<int>("pid"), 0);
        }

        [UnityTest]
        public IEnumerator NoToken_Is401()
        {
            var t = Send("GET", "/status", null);
            yield return Wait(t);
            Assert.AreEqual(401, t.Result.status);
            Assert.AreEqual("unauthorized", t.Result.body.Value<string>("error"));
        }

        [UnityTest]
        public IEnumerator WrongToken_Is401()
        {
            var t = Send("GET", "/status", new string('0', 64));
            yield return Wait(t);
            Assert.AreEqual(401, t.Result.status);
        }

        [UnityTest]
        public IEnumerator Status_ReportsProject()
        {
            var t = Send("GET", "/status", Token());
            yield return Wait(t);
            Assert.AreEqual(200, t.Result.status);
            Assert.AreEqual(Path.GetFullPath(Root), Path.GetFullPath(t.Result.body.Value<string>("projectPath")));
            Assert.IsFalse(t.Result.body.Value<bool>("busy"));
        }

        [UnityTest]
        public IEnumerator Import_RunsHandlerOnMainThread()
        {
            string gotProfile = null, gotDir = null; bool gotDiscard = false; int thread = -1;
            DesignUiBridge.ImportHandler = (p, d, x) =>
            {
                gotProfile = p; gotDir = d; gotDiscard = x;
                thread = Thread.CurrentThread.ManagedThreadId;
                return new OpResult(1, "boom");
            };
            var t = Send("POST", "/import", Token(),
                "{\"profile\":\"/p/profile.json\",\"exportDir\":\"/e\",\"discardManualEdits\":true}");
            yield return Wait(t);
            Assert.AreEqual(200, t.Result.status);
            Assert.AreEqual(1, t.Result.body.Value<int>("code"));
            Assert.AreEqual("boom", t.Result.body.Value<string>("log"));
            Assert.AreEqual("/p/profile.json", gotProfile);
            Assert.AreEqual("/e", gotDir);
            Assert.IsTrue(gotDiscard);
            Assert.AreEqual(s_MainThread, thread);
            Assert.IsTrue(DesignUiBridge.LastRequest.HasValue);
            Assert.AreEqual("import", DesignUiBridge.LastRequest.Value.Op);
            Assert.AreEqual(1, DesignUiBridge.LastRequest.Value.Code);
        }

        [UnityTest]
        public IEnumerator KitSync_RunsHandler()
        {
            string gotKit = null;
            DesignUiBridge.KitSyncHandler = (p, k) => { gotKit = k; return new OpResult(0, "ok"); };
            var t = Send("POST", "/kit-sync", Token(), "{\"profile\":\"/p\",\"kitDir\":\"/k\"}");
            yield return Wait(t);
            Assert.AreEqual(200, t.Result.status);
            Assert.AreEqual("/k", gotKit);
            Assert.AreEqual("kit-sync", DesignUiBridge.LastRequest.Value.Op);
        }

        [UnityTest]
        public IEnumerator Operations_AnswerTheirWarningsAndErrorsAsLists()
        {
            DesignUiBridge.KitSyncHandler = (p, k) => new OpResult(1, "Kit sync failed.\nerror: e1\nwarning: w1", null, new[] { "w1" }, new[] { "e1" });
            var sync = Send("POST", "/kit-sync", Token(), "{\"profile\":\"/p\",\"kitDir\":\"/k\"}");
            yield return Wait(sync);
            Assert.AreEqual(200, sync.Result.status);
            CollectionAssert.AreEqual(new[] { "w1" }, sync.Result.body["warnings"].Values<string>().ToArray());
            CollectionAssert.AreEqual(new[] { "e1" }, sync.Result.body["errors"].Values<string>().ToArray());

            DesignUiBridge.ImportHandler = (p, d, x) => new OpResult(0, "Imported.\norphan screen folder (not deleted): A", new string[0], new[] { "orphan screen folder (not deleted): A" }, null);
            var import = Send("POST", "/import", Token(), "{\"profile\":\"/p\",\"exportDir\":\"/e\",\"discardManualEdits\":false}");
            yield return Wait(import);
            Assert.AreEqual(200, import.Result.status);
            CollectionAssert.AreEqual(new[] { "orphan screen folder (not deleted): A" }, import.Result.body["warnings"].Values<string>().ToArray());
            CollectionAssert.IsEmpty(import.Result.body["errors"].Values<string>().ToArray());

            // a result with a log only answers empty lists
            DesignUiBridge.KitSyncHandler = (p, k) => new OpResult(0, "ok");
            var plain = Send("POST", "/kit-sync", Token(), "{\"profile\":\"/p\",\"kitDir\":\"/k\"}");
            yield return Wait(plain);
            CollectionAssert.IsEmpty(plain.Result.body["warnings"].Values<string>().ToArray());
            CollectionAssert.IsEmpty(plain.Result.body["errors"].Values<string>().ToArray());
        }

        [UnityTest]
        public IEnumerator SecondOperationWhileBusy_Is409()
        {
            DesignUiBridge.ImportHandler = (p, d, x) => { Thread.Sleep(500); return new OpResult(0, "slow"); };
            const string body = "{\"profile\":\"p\",\"exportDir\":\"e\",\"discardManualEdits\":false}";
            var token = Token();
            var first = Send("POST", "/import", token, body);
            // Busy is only observable from a background thread: the main thread is blocked by the handler.
            var second = Task.Run(async () =>
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                while (!DesignUiBridge.IsBusy)
                {
                    if (sw.Elapsed.TotalSeconds > 10) throw new TimeoutException("first request never became busy");
                    await Task.Delay(1);
                }
                return await Send("POST", "/import", token, body);
            });
            yield return Wait(second);
            Assert.AreEqual(409, second.Result.status);
            Assert.AreEqual("busy", second.Result.body.Value<string>("error"));
            yield return Wait(first);
            Assert.AreEqual(200, first.Result.status);
        }

        [UnityTest]
        public IEnumerator MissingField_Is400()
        {
            var t = Send("POST", "/import", Token(), "{\"profile\":\"p\",\"discardManualEdits\":false}");
            yield return Wait(t);
            Assert.AreEqual(400, t.Result.status);
            var bad = Send("POST", "/import", Token(), "{not json");
            yield return Wait(bad);
            Assert.AreEqual(400, bad.Result.status);
        }

        [UnityTest]
        public IEnumerator UnknownPath_Is404_WrongMethod_Is405()
        {
            var t = Send("GET", "/nope", Token());
            yield return Wait(t);
            Assert.AreEqual(404, t.Result.status);
            var m = Send("GET", "/import", Token());
            yield return Wait(m);
            Assert.AreEqual(405, m.Result.status);
        }

        [UnityTest]
        public IEnumerator BodyOver1MB_Is413()
        {
            var big = "{\"profile\":\"" + new string('a', 1024 * 1024 + 10) + "\"}";
            var t = Send("POST", "/import", Token(), big);
            yield return Wait(t);
            Assert.AreEqual(413, t.Result.status);
        }

        [Test]
        public void Ops_ImportAndKitSyncRun()
        {
            var i = DesignUiOps.Import("p", "e", false);
            Assert.AreEqual(1, i.Code, "import runs: a missing profile is a failure, not 'not available'");
            StringAssert.Contains("No DesignUiProfile at 'p'", i.Log);
            var k = DesignUiOps.KitSync("p", "k");
            Assert.AreEqual(1, k.Code, "kit sync runs: a missing profile is a failure, not 'not available'");
            StringAssert.Contains("No DesignUiProfile at 'p'", k.Log);
        }

        [UnityTest]
        public IEnumerator KitSync_RunsTheRealOperation()
        {
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            FontFixture.Use(profile);
            var profilePath = FontFixture.Folder + "/Bridge Profile.asset";
            UnityEditor.AssetDatabase.CreateAsset(profile, profilePath);
            var kit = Path.Combine(Path.GetTempPath(), "design-ui-bridge-kit-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(kit);
            try
            {
                File.WriteAllText(Path.Combine(kit, "kit.config.json"), "{\"fontsCss\":\"fonts/fonts.css\",\"textStyles\":\"text-styles.json\",\"locales\":[]}\n");
                File.WriteAllText(Path.Combine(kit, "text-styles.json"), "{ \"label\": { \"fontSize\": 16, \"lineHeight\": 20, \"weight\": 400 } }");
                DesignUiBridge.KitSyncHandler = DesignUiOps.KitSync;
                var body = new JObject { ["profile"] = profilePath, ["kitDir"] = kit }.ToString();
                var t = Send("POST", "/kit-sync", Token(), body);
                yield return Wait(t);
                Assert.AreEqual(200, t.Result.status);
                Assert.AreEqual(0, t.Result.body.Value<int>("code"), t.Result.body.Value<string>("log"));
                Assert.IsTrue(File.Exists(Path.Combine(kit, "fonts", "fonts.css")));
                Assert.AreEqual("kit-sync", DesignUiBridge.LastRequest.Value.Op);
                Assert.AreEqual(0, DesignUiBridge.LastRequest.Value.Code);
            }
            finally
            {
                Directory.Delete(kit, true);
                FontFixture.Delete();
            }
        }

        [UnityTest]
        public IEnumerator Import_RunsTheRealCompile()
        {
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            FontFixture.Use(profile);
            var outDir = Path.Combine(Path.GetTempPath(), "design-ui-bridge-out-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            profile.outputFolder = outDir; // outside the project: the generated view is never compiled into the test run
            var profilePath = FontFixture.Folder + "/Bridge Import Profile.asset";
            UnityEditor.AssetDatabase.CreateAsset(profile, profilePath);
            var export = Path.Combine(Path.GetTempPath(), "design-ui-bridge-export-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(export);
            try
            {
                var ir = TestIr.Screen(TestIr.Root(TestIr.Node("panel", "container", ("height", "20px"), ("background-color", "#123456"))), "bridge.import");
                File.WriteAllText(Path.Combine(export, ScreenCompiler.IrFileName), Newtonsoft.Json.JsonConvert.SerializeObject(ir));
                DesignUiBridge.ImportHandler = DesignUiOps.Import;
                var body = new JObject { ["profile"] = profilePath, ["exportDir"] = export, ["discardManualEdits"] = false }.ToString();
                var t = Send("POST", "/import", Token(), body);
                yield return Wait(t);
                Assert.AreEqual(200, t.Result.status);
                var log = t.Result.body.Value<string>("log");
                Assert.AreEqual(0, t.Result.body.Value<int>("code"), log);
                StringAssert.Contains("Imported bridge.import into " + outDir + "/BridgeImport", log);
                Assert.IsTrue(File.Exists(Path.Combine(outDir, "BridgeImport", "BridgeImport.uss")));
                Assert.AreEqual("import", DesignUiBridge.LastRequest.Value.Op);
                Assert.AreEqual(0, DesignUiBridge.LastRequest.Value.Code);
            }
            finally
            {
                Directory.Delete(export, true);
                if (Directory.Exists(outDir)) Directory.Delete(outDir, true);
                FontFixture.Delete();
            }
        }

        [Test]
        public void Settings_DisableStopsAndEnableStarts()
        {
            DesignUiBridgeSettings.Enabled = false;
            Assert.IsFalse(DesignUiBridge.IsListening);
            Assert.AreEqual(0, DesignUiBridge.Port);
            Assert.IsFalse(File.Exists(BridgeJson));
            var o = JObject.Parse(File.ReadAllText(DesignUiBridgeSettings.SettingsPath));
            Assert.AreEqual(false, o.Value<bool>("bridgeEnabled"));
            DesignUiBridgeSettings.Enabled = true;
            Assert.IsTrue(DesignUiBridge.IsListening);
            Assert.IsTrue(File.Exists(BridgeJson));
            o = JObject.Parse(File.ReadAllText(DesignUiBridgeSettings.SettingsPath));
            Assert.AreEqual(true, o.Value<bool>("bridgeEnabled"));
        }

        [Test]
        public void Settings_PreserveOtherKeys()
        {
            var path = DesignUiBridgeSettings.SettingsPath;
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "{\"other\": 7}");
            DesignUiBridgeSettings.Enabled = false;
            DesignUiBridgeSettings.Enabled = true;
            var o = JObject.Parse(File.ReadAllText(path));
            Assert.AreEqual(7, o.Value<int>("other"));
            Assert.AreEqual(true, o.Value<bool>("bridgeEnabled"));
        }

        [UnityTest]
        public IEnumerator ThrowingHandler_IsRecordedWithCode1()
        {
            DesignUiBridge.ImportHandler = (p, d, x) => throw new InvalidOperationException("kaboom");
            LogAssert.Expect(LogType.Exception, new Regex("kaboom"));
            var t = Send("POST", "/import", Token(),
                "{\"profile\":\"p\",\"exportDir\":\"e\",\"discardManualEdits\":false}");
            yield return Wait(t);
            Assert.AreEqual(200, t.Result.status);
            Assert.AreEqual(1, t.Result.body.Value<int>("code"));
            Assert.AreEqual("import", DesignUiBridge.LastRequest.Value.Op);
            Assert.AreEqual(1, DesignUiBridge.LastRequest.Value.Code);
            var st = Send("GET", "/status", Token());
            yield return Wait(st);
            Assert.AreEqual(1, st.Result.body["last"].Value<int>("code"));
        }

        const string Ok = "{\"profile\":\"p\",\"exportDir\":\"e\",\"discardManualEdits\":false}";

        static string InProject(string relative) => Path.Combine(Root, relative).Replace('\\', '/');

        static string[] Strings(JToken t) => t is JArray a ? a.Select(x => x.Value<string>()).ToArray() : null;

        [UnityTest]
        public IEnumerator Import_AnswersWhatChanged_AndStaysCompilingUntilTheReload()
        {
            var outside = Path.Combine(Path.GetTempPath(), "design-ui-outside", "A.uss").Replace('\\', '/');
            DesignUiBridge.ImportHandler = (p, d, x) => new OpResult(0, "imported", new[]
            {
                InProject("Assets/UI/Generated/A/A.uss"), InProject("Assets/UI/Generated/A/AView.g.cs"), outside,
            });
            var t = Send("POST", "/import", Token(), Ok);
            yield return Wait(t);
            var body = t.Result.body;
            Assert.AreEqual(0, body.Value<int>("code"));
            CollectionAssert.AreEqual(new[] { InProject("Assets/UI/Generated/A/A.uss"), InProject("Assets/UI/Generated/A/AView.g.cs"), outside }, Strings(body["changed"]));
            CollectionAssert.AreEqual(new[] { "Assets/UI/Generated/A/A.uss", "Assets/UI/Generated/A/AView.g.cs" }, Strings(body["imported"]));
            CollectionAssert.AreEqual(new[] { "Assets/UI/Generated/A/AView.g.cs" }, Strings(body["compiled"]));
            Assert.IsTrue(body.Value<bool>("compiling"));
            var id = body.Value<int>("compileId");
            Assert.Greater(id, 0);
            Assert.GreaterOrEqual(body.Value<long>("ms"), 0);

            var st = Send("GET", "/status", Token());
            yield return Wait(st);
            Assert.IsTrue(st.Result.body.Value<bool>("compiling"), "the reload is still to come");

            DesignUiBridge.SimulateReloadForTests(); // a new domain: statics gone, then what the bridge does on load
            st = Send("GET", "/status", Token());
            yield return Wait(st);
            Assert.IsFalse(st.Result.body.Value<bool>("compiling"));
            // the import before the reload is still the last operation (the window and /status show it)
            Assert.AreEqual("import", DesignUiBridge.LastOperation.Value.Op);
            Assert.AreEqual("import", st.Result.body["last"].Value<string>("op"));
            StringAssert.Contains("scripts reloaded", DesignUiBridge.LastOperationSummary());
            var last = st.Result.body["lastCompile"];
            Assert.AreEqual(id, last.Value<int>("id"));
            Assert.AreEqual("reloaded", last.Value<string>("state"));
            Assert.IsTrue(last.Value<bool>("ok"));
        }

        [UnityTest]
        public IEnumerator Import_WithoutACSharpChange_IsNotCompiling()
        {
            DesignUiBridge.ImportHandler = (p, d, x) => new OpResult(0, "imported", new[] { InProject("Assets/UI/Generated/A/A.uss") });
            var t = Send("POST", "/import", Token(), Ok);
            yield return Wait(t);
            Assert.IsFalse(t.Result.body.Value<bool>("compiling"));
            CollectionAssert.IsEmpty(Strings(t.Result.body["compiled"]));
            Assert.AreEqual(JTokenType.Null, t.Result.body["compileId"].Type);
            var st = Send("GET", "/status", Token());
            yield return Wait(st);
            Assert.IsFalse(st.Result.body.Value<bool>("compiling"));
        }

        [UnityTest]
        public IEnumerator FailedImport_IsNotCompiling()
        {
            DesignUiBridge.ImportHandler = (p, d, x) => new OpResult(1, "failed", new[] { InProject("Assets/UI/Generated/A/AView.g.cs") });
            var t = Send("POST", "/import", Token(), Ok);
            yield return Wait(t);
            Assert.AreEqual(1, t.Result.body.Value<int>("code"));
            Assert.IsFalse(t.Result.body.Value<bool>("compiling"));
        }

        [UnityTest]
        public IEnumerator CompileErrors_EndCompiling_WithTheErrors()
        {
            DesignUiBridge.ImportHandler = (p, d, x) => new OpResult(0, "imported", new[] { InProject("Assets/UI/Generated/A/AView.g.cs") });
            var t = Send("POST", "/import", Token(), Ok);
            yield return Wait(t);
            var id = t.Result.body.Value<int>("compileId");
            StringAssert.Contains("scripts compiling", DesignUiBridge.LastOperationSummary());
            DesignUiBridge.CompileFinishedForTests(new[] { "Assets/UI/Generated/A/AView.g.cs(3,1): error CS1002: ; expected" });
            StringAssert.Contains("script compile failed (1 error;", DesignUiBridge.LastOperationSummary());
            var st = Send("GET", "/status", Token());
            yield return Wait(st);
            Assert.IsFalse(st.Result.body.Value<bool>("compiling"));
            var last = st.Result.body["lastCompile"];
            Assert.AreEqual(id, last.Value<int>("id"));
            Assert.AreEqual("failed", last.Value<string>("state"));
            Assert.IsFalse(last.Value<bool>("ok"));
            StringAssert.Contains("CS1002", Strings(last["errors"])[0]);
        }

        [UnityTest]
        public IEnumerator ACompileThatFailsInsideTheImport_IsInTheAnswer()
        {
            // some Editor states compile synchronously while the import's asset batch ends
            DesignUiBridge.ImportHandler = (p, d, x) =>
            {
                DesignUiBridge.CompileFinishedForTests(new[] { "Assets/UI/Generated/A/AView.g.cs(3,1): error CS0101: duplicate type" });
                return new OpResult(0, "imported", new[] { InProject("Assets/UI/Generated/A/AView.g.cs") });
            };
            var t = Send("POST", "/import", Token(), Ok);
            yield return Wait(t);
            var body = t.Result.body;
            Assert.IsFalse(body.Value<bool>("compiling"));
            var id = body.Value<int>("compileId");
            var last = body["lastCompile"];
            Assert.IsNotNull(last, "the ended compile travels with the answer");
            Assert.AreEqual(id, last.Value<int>("id"));
            Assert.AreEqual("failed", last.Value<string>("state"));
            StringAssert.Contains("CS0101", Strings(last["errors"])[0]);
        }

        [UnityTest]
        public IEnumerator ScriptsFailed_IsInTheImportAnswer_AndInStatus()
        {
            DesignUiBridge.ScriptsFailedProbe = () => true;
            DesignUiBridge.ImportHandler = (p, d, x) => new OpResult(0, "imported", new string[0]);
            var t = Send("POST", "/import", Token(), Ok);
            yield return Wait(t);
            Assert.IsTrue(t.Result.body.Value<bool>("scriptsFailed"), "an import that changes no script still says the scripts do not compile");
            yield return null;
            var st = Send("GET", "/status", Token());
            yield return Wait(st);
            Assert.IsTrue(st.Result.body.Value<bool>("scriptsFailed"));
            DesignUiBridge.ScriptsFailedProbe = () => false;
            yield return null;
            st = Send("GET", "/status", Token());
            yield return Wait(st);
            Assert.IsFalse(st.Result.body.Value<bool>("scriptsFailed"));
        }

        [UnityTest]
        public IEnumerator ASecondImportWhileACompileIsPending_SharesItsCompileId()
        {
            DesignUiBridge.ImportHandler = (p, d, x) => new OpResult(0, "imported", new[] { InProject("Assets/UI/Generated/A/AView.g.cs") });
            var first = Send("POST", "/import", Token(), Ok);
            yield return Wait(first);
            var second = Send("POST", "/import", Token(), Ok);
            yield return Wait(second);
            Assert.AreEqual(first.Result.body.Value<int>("compileId"), second.Result.body.Value<int>("compileId"));
            Assert.IsTrue(second.Result.body.Value<bool>("compiling"));
        }

        [UnityTest]
        public IEnumerator HandlerExceptions_ClientDisconnectsAreInfo_OthersAreErrors()
        {
            LogAssert.Expect(LogType.Log, new Regex("closed the connection before its answer was sent"));
            LogAssert.Expect(LogType.Exception, new Regex("a real bug"));
            DesignUiBridge.ReportHandlerException(new IOException("Connection reset by peer"));
            DesignUiBridge.ReportHandlerException(new InvalidOperationException("a real bug"));
            yield return null; // logged on the main thread
            yield return null;
            LogAssert.NoUnexpectedReceived();
        }

        [UnityTest]
        public IEnumerator ACompileThatNeverStarts_EndsCompiling()
        {
            DesignUiBridge.CompileStartTimeout = TimeSpan.FromMilliseconds(100);
            DesignUiBridge.ImportHandler = (p, d, x) => new OpResult(0, "imported", new[] { InProject("Assets/UI/Generated/A/AView.g.cs") });
            var t = Send("POST", "/import", Token(), Ok);
            yield return Wait(t);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < 400) yield return null;
            var st = Send("GET", "/status", Token());
            yield return Wait(st);
            Assert.IsFalse(st.Result.body.Value<bool>("compiling"));
            Assert.AreEqual("not-started", st.Result.body["lastCompile"].Value<string>("state"));
        }

        [UnityTest]
        public IEnumerator KitSync_AnswersItsTime_AndNeverCompiles()
        {
            DesignUiBridge.KitSyncHandler = (p, k) => new OpResult(0, "ok");
            var t = Send("POST", "/kit-sync", Token(), "{\"profile\":\"/p\",\"kitDir\":\"/k\"}");
            yield return Wait(t);
            Assert.GreaterOrEqual(t.Result.body.Value<long>("ms"), 0);
            Assert.IsFalse(t.Result.body.Value<bool>("compiling"));
        }

        [Test]
        public void ClientDisconnects_AreNotErrors()
        {
            Assert.IsTrue(DesignUiBridge.IsClientDisconnect(new System.Net.HttpListenerException(64)));
            Assert.IsTrue(DesignUiBridge.IsClientDisconnect(new IOException("Broken pipe")));
            Assert.IsTrue(DesignUiBridge.IsClientDisconnect(new ObjectDisposedException("stream")));
            Assert.IsTrue(DesignUiBridge.IsClientDisconnect(new AggregateException(new IOException("reset"))));
            Assert.IsFalse(DesignUiBridge.IsClientDisconnect(new InvalidOperationException("bug")));
            Assert.IsFalse(DesignUiBridge.IsClientDisconnect(new NullReferenceException()));
        }

        [UnityTest]
        public IEnumerator AutoStartPending_StartsOnUpdateTick()
        {
            DesignUiBridge.StopForTests();
            Assert.IsFalse(DesignUiBridge.IsListening);
            DesignUiBridge.RequestAutoStartForTests();
            for (int i = 0; i < 5 && !DesignUiBridge.IsListening; i++) yield return null;
            Assert.IsTrue(DesignUiBridge.IsListening);
        }

        [Test]
        public void CorruptBridgeJson_DoesNotKeepBridgeDead()
        {
            foreach (var content in new[] { "{\"port\":70000,\"token\":\"x\"}", "{\"port\":-5}", "garbage{{" })
            {
                DesignUiBridge.StopForTests();
                Directory.CreateDirectory(Path.GetDirectoryName(BridgeJson));
                File.WriteAllText(BridgeJson, content);
                DesignUiBridge.Restart();
                Assert.IsTrue(DesignUiBridge.IsListening, content);
                Assert.That(DesignUiBridge.Port, Is.InRange(1, 65535));
                Assert.AreEqual(DesignUiBridge.Port, Cfg().Value<int>("port"));
            }
        }
    }
}
