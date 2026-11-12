using System;
using System.Collections;
using System.IO;
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
        bool m_OriginalEnabled;
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
            m_OriginalEnabled = DesignUiBridgeSettings.Enabled;
            m_Import = DesignUiBridge.ImportHandler;
            m_Kit = DesignUiBridge.KitSyncHandler;
            // Make sure the bridge runs with the setting on, without persisting a different value than the original.
            DesignUiBridge.StartForTests();
        }

        [TearDown]
        public void TearDown()
        {
            DesignUiBridge.ImportHandler = m_Import;
            DesignUiBridge.KitSyncHandler = m_Kit;
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
        public void Ops_AreNotAvailableYet()
        {
            var i = DesignUiOps.Import("p", "e", false);
            Assert.AreEqual(2, i.Code);
            Assert.AreEqual("Not available yet: import arrives with the import pipeline.", i.Log);
            var k = DesignUiOps.KitSync("p", "k");
            Assert.AreEqual(2, k.Code);
            Assert.AreEqual("Not available yet: kit sync arrives with the import pipeline.", k.Log);
        }

        [Test]
        public void Settings_DisableStopsAndEnableStarts()
        {
            DesignUiBridgeSettings.Enabled = false;
            Assert.IsFalse(DesignUiBridge.IsListening);
            Assert.AreEqual(0, DesignUiBridge.Port);
            Assert.IsFalse(File.Exists(BridgeJson));
            DesignUiBridgeSettings.Enabled = true;
            Assert.IsTrue(DesignUiBridge.IsListening);
            Assert.IsTrue(File.Exists(BridgeJson));
        }
    }
}
