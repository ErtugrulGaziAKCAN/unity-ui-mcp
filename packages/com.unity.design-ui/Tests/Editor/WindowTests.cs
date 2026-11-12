using System.Collections;
using System.IO;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;

namespace DesignUi.Editor.Tests
{
    public class WindowTests
    {
        bool m_WasListening;
        bool m_SettingsExisted;
        string m_SettingsBackup;

        [SetUp]
        public void SetUp()
        {
            m_WasListening = DesignUiBridge.IsListening;
            var p = DesignUiBridgeSettings.SettingsPath;
            m_SettingsExisted = File.Exists(p);
            m_SettingsBackup = m_SettingsExisted ? File.ReadAllText(p) : null;
            DesignUiBridge.StartForTests();
        }

        [TearDown]
        public void TearDown()
        {
            foreach (var w in Resources.FindObjectsOfTypeAll<DesignUiWindow>()) w.Close();
            var p = DesignUiBridgeSettings.SettingsPath;
            if (m_SettingsExisted) File.WriteAllText(p, m_SettingsBackup);
            else if (File.Exists(p)) File.Delete(p);
            DesignUiBridgeSettings.ResetCache();
            DesignUiBridge.StopForTests();
            if (m_WasListening && DesignUiBridgeSettings.Enabled) DesignUiBridge.StartForTests();
        }

        static bool HasLabel(DesignUiWindow w, string contains)
        {
            foreach (var l in w.rootVisualElement.Query<Label>().ToList())
                if (l.text != null && l.text.Contains(contains)) return true;
            return false;
        }

        [UnityTest]
        public IEnumerator Menu_OpensWindow_ShowsStatus()
        {
            DesignUiBridge.ResetLastRequestForTests();
            Assert.IsTrue(EditorApplication.ExecuteMenuItem("Window/Design UI/Status"));
            yield return null;
            yield return null;
            var w = EditorWindow.GetWindow<DesignUiWindow>();
            w.Refresh();
            Assert.IsTrue(HasLabel(w, "Listening on 127.0.0.1:" + DesignUiBridge.Port));
            Assert.IsTrue(HasLabel(w, "None yet"));
            Assert.IsTrue(HasLabel(w, "Design UI "));

            var saved = DesignUiBridge.ImportHandler;
            DesignUiBridge.ImportHandler = (p, d, x) => new OpResult(3, "x");
            try
            {
                var cfg = Newtonsoft.Json.Linq.JObject.Parse(File.ReadAllText(
                    Path.Combine(DesignUiBridgeSettings.ProjectRoot, "Library", "DesignUi", "bridge.json")));
                var task = System.Threading.Tasks.Task.Run(async () =>
                {
                    using (var c = new System.Net.Http.HttpClient())
                    {
                        var req = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Post,
                            "http://127.0.0.1:" + cfg.Value<int>("port") + "/import");
                        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", cfg.Value<string>("token"));
                        req.Content = new System.Net.Http.StringContent("{\"profile\":\"p\",\"exportDir\":\"e\",\"discardManualEdits\":false}");
                        (await c.SendAsync(req)).Dispose();
                    }
                });
                var sw = System.Diagnostics.Stopwatch.StartNew();
                while (!task.IsCompleted && sw.Elapsed.TotalSeconds < 20) yield return null;
                Assert.IsTrue(task.IsCompleted);
                yield return null;
                yield return null;
                Assert.IsTrue(HasLabel(w, "\u00b7 import \u00b7 code 3"));
            }
            finally { DesignUiBridge.ImportHandler = saved; }

            DesignUiBridgeSettings.Enabled = false;
            yield return null;
            yield return null;
            Assert.IsTrue(HasLabel(w, "Disabled"));
        }
    }
}
