using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The Design UI window's project sections: design-ui.config.json, the design root and last report, the profile, the
    /// MCP client snippets, the operations and the Text row. The window reads a temp project root
    /// (<see cref="DesignUiWindow.ProjectRootOverride"/>); opening, copying and the operations go through its seams.
    /// </summary>
    public class WindowSectionsTests
    {
        const string ProfileFolder = "Assets/DesignUiWindowTests";
        const string ProfilePath = ProfileFolder + "/Window Profile.asset";

        string m_Root;
        readonly List<string> m_Opened = new List<string>();
        readonly List<string> m_Copied = new List<string>();
        readonly List<string> m_Shown = new List<string>();
        readonly List<string> m_Calls = new List<string>();
        Func<string, string, string> m_PickFolder;
        Func<string, bool> m_Confirm;

        [SetUp]
        public void SetUp()
        {
            m_Root = Path.Combine(Path.GetTempPath(), "design-ui-window-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(m_Root);
            DesignUiWindow.ProjectRootOverride = m_Root;
            DesignUiWindow.OpenPath = p => m_Opened.Add(p);
            DesignUiWindow.Clipboard = t => m_Copied.Add(t);
            DesignUiWindow.ShowResult = (what, r) => m_Shown.Add(what + " " + r.Code + " " + r.Log);
            DesignUiWindow.KitSyncOp = (p, k) => { m_Calls.Add("kit " + p + " " + k); return new OpResult(0, "synced"); };
            DesignUiWindow.ImportOp = (p, e, d) => { m_Calls.Add("import " + p + " " + e + " " + d); return new OpResult(0, "imported"); };
            m_PickFolder = null;
            DesignUiWindow.PickFolder = (title, start) => m_PickFolder?.Invoke(title, start);
            m_Confirm = null;
            DesignUiWindow.Confirm = text => m_Confirm != null && m_Confirm(text);
        }

        [TearDown]
        public void TearDown()
        {
            foreach (var w in Resources.FindObjectsOfTypeAll<DesignUiWindow>()) w.Close();
            DesignUiWindow.ResetSeams();
            if (Directory.Exists(m_Root)) Directory.Delete(m_Root, true);
            if (AssetDatabase.IsValidFolder(ProfileFolder)) AssetDatabase.DeleteAsset(ProfileFolder);
            m_Opened.Clear(); m_Copied.Clear(); m_Shown.Clear(); m_Calls.Clear();
        }

        [OneTimeTearDown]
        public void DeleteFonts() => FontFixture.Delete();

        void Config(object extra = null)
        {
            var o = new JObject
            {
                ["designRoot"] = "Designs",
                ["kitDir"] = "Kit",
                ["profileAsset"] = ProfilePath,
                ["unityRunner"] = new JObject { ["prefer"] = "editor" },
            };
            if (extra != null) foreach (var p in JObject.FromObject(extra).Properties()) o[p.Name] = p.Value;
            File.WriteAllText(Path.Combine(m_Root, "design-ui.config.json"), o.ToString());
            Directory.CreateDirectory(Path.Combine(m_Root, "Designs"));
            Directory.CreateDirectory(Path.Combine(m_Root, "Kit"));
        }

        string Full(params string[] parts) => Path.GetFullPath(Path.Combine(new[] { m_Root }.Concat(parts).ToArray()));

        void Verified(string screen, string verdict, string at)
        {
            var dir = Full("Designs", screen);
            Directory.CreateDirectory(Path.Combine(dir, ".design-ui"));
            var report = Path.Combine(dir, "report.html");
            File.WriteAllText(report, "<p>report</p>");
            File.WriteAllText(Path.Combine(dir, ".design-ui", "last-verify.json"), new JObject
            {
                ["screen"] = screen, ["verdict"] = verdict, ["reportPath"] = report, ["verifiedAt"] = at,
            }.ToString());
        }

        string Exported(string screen)
        {
            var export = Full("Designs", screen, ".design-ui", "export");
            Directory.CreateDirectory(export);
            File.WriteAllText(Path.Combine(export, ScreenCompiler.IrFileName), "{}");
            return export;
        }

        static DesignUiWindow Open()
        {
            Assert.IsTrue(EditorApplication.ExecuteMenuItem("Window/Design UI/Status"));
            var w = EditorWindow.GetWindow<DesignUiWindow>();
            w.EnsureBuilt();
            w.RefreshProject();
            w.Refresh();
            return w;
        }

        static string Text(DesignUiWindow w, string name)
        {
            var e = w.rootVisualElement.Q<Label>(name);
            Assert.IsNotNull(e, "label " + name);
            return e.text;
        }

        static Button Button(DesignUiWindow w, string name)
        {
            var b = w.rootVisualElement.Q<Button>(name);
            Assert.IsNotNull(b, "button " + name);
            return b;
        }

        static bool Shown(VisualElement e) => e.resolvedStyle.display != DisplayStyle.None && e.style.display != DisplayStyle.None;

        // ---- snippets ---------------------------------------------------------------------------------------------

        [Test]
        public void Snippets_CarryThisProjectAndTheServerPath()
        {
            const string project = "/work/My Game", server = "/clones/unity-ui-mcp/tools/design-ui-mcp/dist/server.js";
            Assert.AreEqual("claude mcp add --scope local design-ui -- node " + server + " --project '/work/My Game'",
                McpClientSnippets.For(McpClient.ClaudeCode, project, server));
            foreach (var client in new[] { McpClient.Cursor, McpClient.ClaudeDesktop })
            {
                var entry = JObject.Parse(McpClientSnippets.For(client, project, server))["mcpServers"]["design-ui"];
                Assert.AreEqual("node", entry.Value<string>("command"), client.ToString());
                CollectionAssert.AreEqual(new[] { server, "--project", project }, entry["args"].Select(a => a.Value<string>()).ToArray(), client.ToString());
            }
            var codex = McpClientSnippets.For(McpClient.Codex, project, server).Split('\n');
            Assert.AreEqual("[mcp_servers.design-ui]", codex[0]);
            Assert.AreEqual("command = \"node\"", codex[1]);
            Assert.AreEqual("args = [\"" + server + "\", \"--project\", \"/work/My Game\"]", codex[2]);
            StringAssert.EndsWith("--project '/it'\\''s'", McpClientSnippets.For(McpClient.ClaudeCode, "/it's", server), "shell quoting");
        }

        [Test]
        public void Snippets_WithoutAServerPath_SayWhereItIs_AndInventNone()
        {
            foreach (var client in McpClientSnippets.All)
            {
                var s = McpClientSnippets.For(client, "/work/game", null);
                StringAssert.Contains(McpClientSnippets.ServerPlaceholder, s, client.ToString());
            }
            StringAssert.Contains("scripts/setup.sh", McpClientSnippets.For(McpClient.ClaudeCode, "/work/game", null));
            StringAssert.Contains("mcpServer", McpClientSnippets.For(McpClient.Codex, "/work/game", null));
            StringAssert.Contains("mcpServer", McpClientSnippets.UnknownServer);
        }

        // ---- project section --------------------------------------------------------------------------------------

        [Test]
        public void Window_ShowsTheConfig_DesignRoot_LastReport_AndOpensThem()
        {
            Config(new { mcpServer = "../unity-ui-mcp/tools/design-ui-mcp/dist/server.js" });
            Verified("older", "fail", "2026-01-01T10:00:00.000Z");
            Verified("newer", "pass", "2026-01-02T10:00:00.000Z");
            var w = Open();

            StringAssert.Contains(Full("design-ui.config.json"), Text(w, "config-path"));
            StringAssert.Contains(Full("Designs"), Text(w, "design-root"));
            StringAssert.Contains("newer", Text(w, "last-report"));
            StringAssert.Contains("pass", Text(w, "last-report"));

            w.OpenConfig();
            w.OpenDesignRoot();
            w.OpenLastReport();
            CollectionAssert.AreEqual(new[] { Full("design-ui.config.json"), Full("Designs"), Full("Designs", "newer", "report.html") }, m_Opened);
            Assert.IsTrue(Button(w, "open-config").enabledSelf);
            Assert.IsTrue(Button(w, "open-report").enabledSelf);
        }

        [Test]
        public void ViewportsLine_ListsEachViewportsClass()
        {
            var profile = DesignUiProfile.CreateNew();
            try
            {
                Assert.AreEqual("Viewports: exact 2560×1440, 1920×1080, 1280×720, 3840×2160 (every kit value whole device px); scaled 1600×900, 1366×768 " +
                                "(verified within ±1 device px, exempt from the whole-pixel rules)", DesignUiWindow.ViewportsText(profile), "a new profile's defaults");
                profile.scaledViewports = new Vector2Int[0];
                profile.viewports = new[] { new Vector2Int(2560, 1440) };
                Assert.AreEqual("Viewports: exact 2560×1440 (every kit value whole device px)", DesignUiWindow.ViewportsText(profile));
                Assert.AreEqual("", DesignUiWindow.ViewportsText(null));
            }
            finally { UnityEngine.Object.DestroyImmediate(profile); }
        }

        [Test]
        public void Window_WithoutAConfig_SaysSo_AndTheSnippetsSayWhereTheServerIs()
        {
            var w = Open();
            StringAssert.Contains("No design-ui.config.json", Text(w, "config-path"));
            Assert.IsFalse(Button(w, "open-config").enabledSelf);
            Assert.IsFalse(Button(w, "open-design-root").enabledSelf);
            StringAssert.Contains("mcpServer", Text(w, "server-path"));
            var text = w.CopySnippet(McpClient.ClaudeCode);
            StringAssert.Contains(McpClientSnippets.ServerPlaceholder, text);
            StringAssert.Contains("--project " + m_Root, text.Replace("'", ""));
        }

        [Test]
        public void PackageSection_ReportsThePackageIdBefore010_WhileTheProjectListsIt()
        {
            const string old = DesignUiWindow.OldPackageName;
            Assert.AreEqual("com.unity.design-ui", old);
            var w = Open();
            var label = w.rootVisualElement.Q<Label>("package-id");
            Assert.AreEqual(DisplayStyle.None, label.style.display.value, "no manifest: nothing to report");

            Directory.CreateDirectory(Full("Packages"));
            File.WriteAllText(Full("Packages", "manifest.json"), "\uFEFF" + new JObject
            {
                ["testables"] = new JArray(old),
                ["dependencies"] = new JObject { [old] = "https://example.invalid/unity-ui-mcp.git?path=/packages/" + old },
            });
            w.RefreshProject();
            Assert.AreEqual(DisplayStyle.Flex, label.style.display.value);
            StringAssert.StartsWith("Old package id " + old + " in Packages/manifest.json (dependencies), Packages/manifest.json (testables): " +
                "the package id is com.ertugrulgaziakcan.design-ui since 0.1.0.", label.text);
            StringAssert.Contains("scripts/setup.sh", label.text);
            StringAssert.Contains("path=/packages/com.ertugrulgaziakcan.design-ui", label.text);

            File.WriteAllText(Full("Packages", "manifest.json"), new JObject
            {
                ["dependencies"] = new JObject { ["com.ertugrulgaziakcan.design-ui"] = "file:../unity-ui-mcp/packages/com.ertugrulgaziakcan.design-ui" },
            }.ToString());
            Directory.CreateDirectory(Full("Packages", old));
            w.RefreshProject();
            Assert.AreEqual("Old package id " + old + " in Packages/" + old + " (an embedded copy)", label.text.Substring(0, label.text.IndexOf(':')));
            Directory.Delete(Full("Packages", old));
            w.RefreshProject();
            Assert.AreEqual(DisplayStyle.None, label.style.display.value, "the new id only");
        }

        [Test]
        public void CopyButtons_CopyEachClientsSnippet_WithThisProjectsPath()
        {
            Config(new { mcpServer = "/srv/unity-ui-mcp/tools/design-ui-mcp/dist/server.js" });
            var w = Open();
            StringAssert.Contains("/srv/unity-ui-mcp/tools/design-ui-mcp/dist/server.js", Text(w, "server-path"));
            foreach (var client in McpClientSnippets.All)
            {
                Assert.IsNotNull(Button(w, "copy-" + McpClientSnippets.Id(client)));
                var text = w.CopySnippet(client);
                Assert.AreEqual(McpClientSnippets.For(client, m_Root, "/srv/unity-ui-mcp/tools/design-ui-mcp/dist/server.js"), text);
                Assert.AreEqual(text, m_Copied.Last());
                StringAssert.Contains(McpClientSnippets.Label(client), Text(w, "copy-result"));
            }
        }

        [Test]
        public void Profile_Missing_OffersCreateProfile_WhichCreatesItAtTheConfigsPath()
        {
            Config();
            var w = Open();
            var create = Button(w, "create-profile");
            Assert.IsTrue(Shown(create));
            Assert.IsNull(w.rootVisualElement.Q<UnityEditor.UIElements.ObjectField>("profile").value);

            var profile = w.CreateProfile();
            Assert.IsNotNull(profile);
            Assert.AreEqual(ProfilePath, AssetDatabase.GetAssetPath(profile));
            // as written in the config (relative to the project), never one machine's absolute paths
            Assert.AreEqual("Designs", profile.designRoot);
            Assert.AreEqual("Kit", profile.kitDir);
            Assert.IsNotNull(profile.panelSettings, "the package's design PanelSettings");
            w.RefreshProject();
            Assert.IsFalse(Shown(create));
            Assert.AreEqual(profile, w.rootVisualElement.Q<UnityEditor.UIElements.ObjectField>("profile").value);
        }

        [UnityEngine.TestTools.UnityTest]
        public System.Collections.IEnumerator ProjectAndText_Refresh_AfterABridgeOperation()
        {
            Config();
            var w = Open();
            StringAssert.Contains("none yet", Text(w, "last-report"));
            bool wasListening = DesignUiBridge.IsListening;
            DesignUiBridge.StartForTests();
            var saved = DesignUiBridge.ImportHandler;
            // an import through the bridge (as from the MCP server); the verification lands on disk meanwhile
            DesignUiBridge.ImportHandler = (p, d, x) => { Verified("inbox", "pass", "2026-02-03T04:05:06.000Z"); return new OpResult(0, "imported"); };
            try
            {
                var cfg = JObject.Parse(File.ReadAllText(Path.Combine(DesignUiBridgeSettings.ProjectRoot, "Library", "DesignUi", "bridge.json")));
                var task = System.Threading.Tasks.Task.Run(async () =>
                {
                    using (var c = new System.Net.Http.HttpClient())
                    {
                        var req = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Post, "http://127.0.0.1:" + cfg.Value<int>("port") + "/import");
                        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", cfg.Value<string>("token"));
                        req.Content = new System.Net.Http.StringContent("{\"profile\":\"p\",\"exportDir\":\"e\",\"discardManualEdits\":false}");
                        (await c.SendAsync(req)).Dispose();
                    }
                });
                var sw = System.Diagnostics.Stopwatch.StartNew();
                while (!task.IsCompleted && sw.Elapsed.TotalSeconds < 20) yield return null;
                Assert.IsTrue(task.IsCompleted);
                yield return null;
                w.Refresh();
                StringAssert.Contains("inbox · pass", Text(w, "last-report"));
            }
            finally
            {
                DesignUiBridge.ImportHandler = saved;
                if (!wasListening) DesignUiBridge.StopForTests();
            }
        }

        [Test]
        public void TextRow_FollowsTheConfigsProfile_WhenTheConfigChanges()
        {
            var w = Open();
            StringAssert.Contains("no DesignUiProfile", Text(w, "text-kit"));
            Config();
            if (!AssetDatabase.IsValidFolder(ProfileFolder)) AssetDatabase.CreateFolder("Assets", "DesignUiWindowTests");
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            FontFixture.Use(profile);
            AssetDatabase.CreateAsset(profile, ProfilePath);
            w.RefreshProject();
            StringAssert.DoesNotContain("no DesignUiProfile", Text(w, "text-kit"));
            StringAssert.Contains("kit.config.json", Text(w, "text-kit"), "the config's kit folder (empty here) is checked");
        }

        // ---- operations ---------------------------------------------------------------------------------------------

        [Test]
        public void KitSync_RunsWithTheProfileAndTheConfigsKitFolder()
        {
            Config();
            var w = Open();
            w.KitSync();
            CollectionAssert.AreEqual(new[] { "kit " + ProfilePath + " " + Full("Kit") }, m_Calls);
            CollectionAssert.AreEqual(new[] { "Kit Sync 0 synced" }, m_Shown);
        }

        [Test]
        public void ImportScreen_PicksAScreenUnderTheDesignRoot_AndImportsItsExport()
        {
            Config();
            var export = Exported("inbox");
            string start = null;
            m_PickFolder = (title, from) => { start = from; return Full("Designs", "inbox"); };
            var w = Open();
            w.ImportScreen();
            Assert.AreEqual(Full("Designs"), start);
            CollectionAssert.AreEqual(new[] { "import " + ProfilePath + " " + export + " False" }, m_Calls);
            Assert.AreEqual("Import 0 imported", m_Shown.Single());

            // the export folder itself is accepted too; a folder without an export is refused with the reason
            m_Calls.Clear(); m_Shown.Clear();
            m_PickFolder = (title, from) => export;
            w.ImportScreen();
            CollectionAssert.AreEqual(new[] { "import " + ProfilePath + " " + export + " False" }, m_Calls);
            m_Calls.Clear(); m_Shown.Clear();
            Directory.CreateDirectory(Full("Designs", "empty"));
            m_PickFolder = (title, from) => Full("Designs", "empty");
            w.ImportScreen();
            CollectionAssert.IsEmpty(m_Calls);
            StringAssert.Contains("has no export", m_Shown.Single());
        }

        [Test]
        public void ImportScreen_AsksBeforeDiscardingHandEdits()
        {
            Config();
            Exported("inbox");
            m_PickFolder = (title, from) => Full("Designs", "inbox");
            int n = 0;
            DesignUiWindow.ImportOp = (p, e, d) =>
            {
                m_Calls.Add("discard=" + d);
                return n++ == 0 ? new OpResult(1, "Import failed; nothing was written for the screen.\nedited by hand: Assets/UI/Inbox/Inbox.uss") : new OpResult(0, "imported");
            };
            string asked = null;
            m_Confirm = text => { asked = text; return true; };
            Open().ImportScreen();
            CollectionAssert.AreEqual(new[] { "discard=False", "discard=True" }, m_Calls);
            StringAssert.Contains("Inbox.uss", asked);
            Assert.AreEqual("Import 0 imported", m_Shown.Single());
        }

        // ---- Text row -----------------------------------------------------------------------------------------------

        [Test]
        public void TextRow_ReportsKitFonts_Twins_AndTheFontSet()
        {
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            FontFixture.Use(profile);
            profile.outputFolder = ProfileFolder + "/Generated";
            if (!AssetDatabase.IsValidFolder(ProfileFolder)) AssetDatabase.CreateFolder("Assets", "DesignUiWindowTests");
            AssetDatabase.CreateFolder(ProfileFolder, "Generated");
            AssetDatabase.CreateAsset(profile, ProfilePath);
            var kit = Full("Kit");
            Config();
            File.WriteAllText(Path.Combine(kit, "kit.config.json"), "{\"fontsCss\":\"fonts/fonts.css\",\"textStyles\":\"text-styles.json\",\"locales\":[]}\n");
            File.WriteAllText(Path.Combine(kit, "text-styles.json"), "{ \"label\": { \"fontSize\": 16, \"lineHeight\": 20, \"weight\": 400 } }");

            var before = TextStatus.Check(profile, kit);
            Assert.IsFalse(before.KitCurrent, before.Kit);
            StringAssert.Contains("Kit Sync", before.Kit);
            Assert.IsFalse(before.FontSetExists);
            StringAssert.Contains(DesignFontSet.FileName, before.FontSet);

            var sync = DesignUiOps.KitSync(ProfilePath, kit);
            Assert.AreEqual(0, sync.Code, sync.Log);
            var after = TextStatus.Check(profile, kit);
            Assert.IsTrue(after.KitCurrent, after.Kit);
            Assert.IsTrue(after.TwinsCurrent, after.Twins);

            // a kit font file that no longer matches the project's font is out of date again
            var ttf = Directory.GetFiles(Path.Combine(kit, "fonts"), "*.ttf").First();
            File.AppendAllText(ttf, "x");
            var changed = TextStatus.Check(profile, kit);
            Assert.IsFalse(changed.KitCurrent);
            StringAssert.Contains(Path.GetFileName(ttf), changed.Kit);

            var set = ScriptableObject.CreateInstance<DesignFontSet>();
            AssetDatabase.CreateAsset(set, ProfileFolder + "/Generated/" + DesignFontSet.FileName);
            Assert.IsTrue(TextStatus.Check(profile, kit).FontSetExists);

            var w = Open();
            w.RefreshText();
            StringAssert.Contains("out of date", Text(w, "text-kit"));
            StringAssert.Contains(DesignFontSet.FileName, Text(w, "text-font-set"));
        }

        [Test]
        public void TextRow_ShowsTheActiveFontResolver()
        {
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            FontFixture.Use(profile);
            if (!AssetDatabase.IsValidFolder(ProfileFolder)) AssetDatabase.CreateFolder("Assets", "DesignUiWindowTests");
            AssetDatabase.CreateAsset(profile, ProfilePath);
            Config();
            var w = Open();
            w.RefreshText();
            StringAssert.StartsWith("Font resolver: built-in", Text(w, "text-resolver"));

            var resolver = ScriptableObject.CreateInstance<FixtureFontResolver>();
            AssetDatabase.CreateAsset(resolver, ProfileFolder + "/Window Fonts.asset");
            profile.fontResolver = resolver;
            FontFixture.Save(profile);
            w.RefreshText();
            StringAssert.StartsWith("Font resolver: 'Window Fonts' (" + typeof(FixtureFontResolver).FullName, Text(w, "text-resolver"));
        }

        [Test]
        public void TextRow_WithoutAProfile_SaysSo()
        {
            var s = TextStatus.Check(null, null);
            Assert.IsFalse(s.KitCurrent);
            Assert.IsFalse(s.TwinsCurrent);
            Assert.IsFalse(s.FontSetExists);
            StringAssert.Contains("no DesignUiProfile", s.Kit);
        }
    }
}
