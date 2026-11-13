using System;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEditor.UIElements;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi.Editor
{
    /// <summary>
    /// <c>Window &gt; Design UI &gt; Status</c>: the Editor bridge (state, port, on/off, Restart) and its last request; the
    /// project's design-ui.config.json, design root, last verification report and DesignUiProfile; Kit Sync and Import
    /// Screen…; whether the kit fonts, font twins and DesignFonts.asset are current; and the MCP client configuration of
    /// this project for Claude Code, Cursor, Codex and Claude Desktop. The MCP server is started by the client, never here.
    /// </summary>
    public sealed class DesignUiWindow : EditorWindow
    {
        // ---- seams (tests replace them; ResetSeamsForTests restores them) ------------------------------------------
        internal static string ProjectRootOverride;
        internal static Action<string> OpenPath;
        internal static Action<string> Clipboard;
        internal static Action<string, OpResult> ShowResult;
        internal static Func<string, string, OpResult> KitSyncOp;
        internal static Func<string, string, bool, OpResult> ImportOp;
        internal static Func<string, string, string> PickFolder;
        internal static Func<string, bool> Confirm;

        static DesignUiWindow() => ResetSeams();

        internal static void ResetSeams()
        {
            ProjectRootOverride = null;
            OpenPath = EditorUtility.OpenWithDefaultApp;
            Clipboard = text => EditorGUIUtility.systemCopyBuffer = text;
            ShowResult = DesignUiMenu.Report;
            KitSyncOp = DesignUiOps.KitSync;
            ImportOp = DesignUiOps.Import;
            PickFolder = (title, start) => EditorUtility.OpenFolderPanel(title, start, "");
            Confirm = text => EditorUtility.DisplayDialog("Design UI", text, "Discard and import", "Keep my edits");
        }

        static string ProjectRoot => ProjectRootOverride ?? DesignUiBridgeSettings.ProjectRoot;

        static string s_Version;
        Label m_Status, m_Project, m_Last, m_Package;
        Toggle m_Enable;
        Label m_ConfigPath, m_DesignRoot, m_LastReport, m_ProfileNote, m_OpResult, m_TextKit, m_TextTwins, m_TextFontSet, m_ServerPath, m_CopyResult;
        Button m_OpenConfig, m_OpenDesignRoot, m_OpenReport, m_CreateProfile;
        ObjectField m_ProfileField;

        DesignUiProjectConfig m_Config;
        DesignUiProjectConfig.Report m_Report;
        /// <summary>A profile picked in the field for this window's operations; null uses the config's.</summary>
        DesignUiProfile m_ProfileOverride;

        [MenuItem("Window/Design UI/Status")]
        public static void Open()
        {
            var w = GetWindow<DesignUiWindow>();
            w.titleContent = new GUIContent("Design UI");
            w.Show();
        }

        /// <summary>Builds the UI now when Unity has not called CreateGUI yet (tests).</summary>
        internal void EnsureBuilt() => CreateGUI();

        void CreateGUI()
        {
            if (m_Status != null) return;
            var scroll = new ScrollView();
            rootVisualElement.Add(scroll);
            var root = scroll.contentContainer;
            root.style.paddingLeft = root.style.paddingRight = root.style.paddingTop = root.style.paddingBottom = 8;

            root.Add(Section("Bridge", out var bridge));
            m_Status = new Label { name = "bridge-status" };
            bridge.Add(m_Status);
            m_Enable = new Toggle("Enable bridge");
            m_Enable.RegisterValueChangedCallback(e =>
            {
                if (e.newValue != DesignUiBridgeSettings.Enabled) DesignUiBridgeSettings.Enabled = e.newValue;
            });
            bridge.Add(m_Enable);
            bridge.Add(new Button(DesignUiBridge.Restart) { text = "Restart" });
            m_Project = Wrapped("project-path");
            bridge.Add(m_Project);

            root.Add(Section("Last request", out var last));
            m_Last = new Label { name = "last-request" };
            last.Add(m_Last);

            root.Add(Section("Project", out var project));
            project.Add(Row(m_ConfigPath = Wrapped("config-path"), m_OpenConfig = Btn("open-config", "Open", OpenConfig)));
            project.Add(Row(m_DesignRoot = Wrapped("design-root"), m_OpenDesignRoot = Btn("open-design-root", "Open", OpenDesignRoot)));
            project.Add(Row(m_LastReport = Wrapped("last-report"), m_OpenReport = Btn("open-report", "Open", OpenLastReport)));
            m_ProfileField = new ObjectField("Profile") { name = "profile", objectType = typeof(DesignUiProfile), allowSceneObjects = false };
            m_ProfileField.RegisterValueChangedCallback(e =>
            {
                m_ProfileOverride = e.newValue as DesignUiProfile;
                RefreshProject();
                RefreshText();
            });
            project.Add(Row(m_ProfileField, m_CreateProfile = Btn("create-profile", "Create Profile", () => CreateProfile())));
            m_ProfileField.style.flexGrow = 1;
            project.Add(m_ProfileNote = Wrapped("profile-note"));

            root.Add(Section("Operations", out var ops));
            ops.Add(Row(Btn("kit-sync", "Kit Sync", KitSync), Btn("import-screen", "Import Screen…", ImportScreen)));
            ops.Add(m_OpResult = Wrapped("op-result"));

            root.Add(Section("Text", out var text));
            text.Add(m_TextKit = Wrapped("text-kit"));
            text.Add(m_TextTwins = Wrapped("text-twins"));
            text.Add(m_TextFontSet = Wrapped("text-font-set"));
            text.Add(Row(Btn("text-check", "Check", RefreshText)));

            root.Add(Section("MCP clients", out var clients));
            clients.Add(m_ServerPath = Wrapped("server-path"));
            var copies = new VisualElement();
            copies.style.flexDirection = FlexDirection.Row;
            copies.style.flexWrap = Wrap.Wrap;
            foreach (var client in McpClientSnippets.All)
            {
                var c = client;
                copies.Add(Btn("copy-" + McpClientSnippets.Id(c), "Copy " + McpClientSnippets.Label(c), () => CopySnippet(c)));
            }
            clients.Add(copies);
            clients.Add(m_CopyResult = Wrapped("copy-result"));

            root.Add(Section("Package", out var pkg));
            m_Package = new Label { name = "package" };
            pkg.Add(m_Package);

            DesignUiBridge.StateChanged -= Refresh;
            DesignUiBridge.StateChanged += Refresh;
            rootVisualElement.schedule.Execute(Refresh).Every(1000);
            RefreshProject();
            RefreshText();
            Refresh();
        }

        void OnFocus()
        {
            if (m_ConfigPath != null) RefreshProject();
        }

        void OnDisable()
        {
            DesignUiBridge.StateChanged -= Refresh;
        }

        static VisualElement Section(string title, out VisualElement body)
        {
            var box = new VisualElement();
            box.style.marginBottom = 10;
            var h = new Label(title);
            h.style.unityFontStyleAndWeight = FontStyle.Bold;
            h.style.marginBottom = 2;
            box.Add(h);
            body = box;
            return box;
        }

        static Label Wrapped(string name)
        {
            var l = new Label { name = name };
            l.style.whiteSpace = WhiteSpace.Normal;
            l.style.flexShrink = 1;
            l.style.flexGrow = 1;
            return l;
        }

        static Button Btn(string name, string text, Action click) => new Button(click) { name = name, text = text };

        static VisualElement Row(params VisualElement[] children)
        {
            var row = new VisualElement();
            row.style.flexDirection = FlexDirection.Row;
            row.style.alignItems = Align.Center;
            foreach (var c in children) row.Add(c);
            return row;
        }

        static void SetShown(VisualElement e, bool shown) => e.style.display = shown ? DisplayStyle.Flex : DisplayStyle.None;

        /// <summary>The profile the operations use: one picked in the field, else the config's (null when it does not exist).</summary>
        DesignUiProfile CurrentProfile =>
            m_ProfileOverride != null ? m_ProfileOverride : AssetDatabase.LoadAssetAtPath<DesignUiProfile>(m_Config.ProfilePath);

        string ProfilePathForOps => m_ProfileOverride != null ? AssetDatabase.GetAssetPath(m_ProfileOverride) : m_Config.ProfilePath;

        // ---- bridge (every second) ----------------------------------------------------------------------------------

        internal void Refresh()
        {
            if (m_Status == null) return;
            if (!DesignUiBridgeSettings.Enabled) m_Status.text = "Disabled";
            else if (DesignUiBridge.IsListening) m_Status.text = "Listening on 127.0.0.1:" + DesignUiBridge.Port;
            else m_Status.text = "Stopped";
            m_Enable.SetValueWithoutNotify(DesignUiBridgeSettings.Enabled);
            m_Project.text = ProjectRoot;

            var last = DesignUiBridge.LastRequest;
            m_Last.text = last.HasValue
                ? last.Value.Utc.ToLocalTime().ToString("HH:mm:ss", CultureInfo.InvariantCulture) + " · " + last.Value.Op + " · code " + last.Value.Code +
                  (DesignUiBridge.CompilePending ? " · waiting for the script compile" : "")
                : "None yet";

            if (s_Version == null)
            {
                var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(DesignUiWindow).Assembly);
                s_Version = info != null ? info.version : "unknown";
            }
            m_Package.text = "Design UI " + s_Version;
        }

        // ---- project (on open, focus and after operations) ----------------------------------------------------------

        internal void RefreshProject()
        {
            if (m_ConfigPath == null) return;
            m_Config = DesignUiProjectConfig.Read(ProjectRoot);
            m_Report = m_Config.LastReport();

            m_ConfigPath.text = m_Config.Error != null ? "Config: " + m_Config.Error
                : m_Config.Exists ? "Config: " + m_Config.Path
                : "No design-ui.config.json in " + ProjectRoot + " (scripts/setup.sh in your unity-ui-mcp clone writes one).";
            m_OpenConfig.SetEnabled(m_Config.Exists);

            bool rootExists = m_Config.DesignRoot != null && Directory.Exists(m_Config.DesignRoot);
            m_DesignRoot.text = m_Config.DesignRoot == null ? "Designs: — (no designRoot in design-ui.config.json)"
                : "Designs: " + m_Config.DesignRoot + (rootExists ? "" : " (missing)");
            m_OpenDesignRoot.SetEnabled(rootExists);

            bool reportExists = m_Report != null && !string.IsNullOrEmpty(m_Report.Path) && File.Exists(m_Report.Path);
            m_LastReport.text = m_Report == null
                ? "Last report: none yet (design_ui_verify writes <screen>/report.html)"
                : "Last report: " + m_Report.Screen + " · " + (m_Report.Verdict ?? "—") + " · " +
                  m_Report.When.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) + (reportExists ? "" : " (report missing)");
            m_OpenReport.SetEnabled(reportExists);

            var configured = AssetDatabase.LoadAssetAtPath<DesignUiProfile>(m_Config.ProfilePath);
            m_ProfileField.SetValueWithoutNotify(m_ProfileOverride != null ? m_ProfileOverride : configured);
            SetShown(m_CreateProfile, configured == null && m_ProfileOverride == null);
            m_ProfileNote.text = m_ProfileOverride != null && m_ProfileOverride != configured
                ? "This window uses " + AssetDatabase.GetAssetPath(m_ProfileOverride) + "; the MCP server uses " + m_Config.ProfilePath + " (profileAsset)."
                : configured == null ? "No DesignUiProfile at " + m_Config.ProfilePath + (m_Config.ProfileAsset != null ? " (profileAsset in design-ui.config.json)." : " (the default path).")
                : m_Config.ProfilePath;

            m_ServerPath.text = m_Config.ServerPath == null ? McpClientSnippets.UnknownServer
                : "Server: " + m_Config.ServerPath + (File.Exists(m_Config.ServerPath) ? "" : " (not built yet: run scripts/setup.sh in that clone)");
        }

        internal void OpenConfig() { if (m_Config.Exists) OpenPath(m_Config.Path); }

        internal void OpenDesignRoot() { if (m_Config.DesignRoot != null && Directory.Exists(m_Config.DesignRoot)) OpenPath(m_Config.DesignRoot); }

        internal void OpenLastReport() { if (m_Report?.Path != null && File.Exists(m_Report.Path)) OpenPath(m_Report.Path); }

        /// <summary>Creates the DesignUiProfile at the config's profileAsset (or the default path), with the config's folders.</summary>
        internal DesignUiProfile CreateProfile()
        {
            var path = m_Config.ProfilePath.Replace('\\', '/');
            if (!path.StartsWith("Assets/", StringComparison.Ordinal) || !path.EndsWith(".asset", StringComparison.Ordinal))
            {
                m_ProfileNote.text = "Cannot create a profile at '" + path + "': profileAsset must be an Assets/….asset path.";
                return null;
            }
            var existing = AssetDatabase.LoadAssetAtPath<DesignUiProfile>(path);
            if (existing != null) return existing;
            EnsureFolder(path.Substring(0, path.LastIndexOf('/')));
            var profile = CreateInstance<DesignUiProfile>();
            profile.panelSettings = DesignUiProfile.LoadDefaultPanelSettings();
            profile.designRoot = m_Config.DesignRoot;
            profile.kitDir = m_Config.KitDir;
            AssetDatabase.CreateAsset(profile, path);
            m_ProfileOverride = null;
            RefreshProject();
            RefreshText();
            EditorGUIUtility.PingObject(profile);
            return profile;
        }

        static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var slash = folder.LastIndexOf('/');
            EnsureFolder(folder.Substring(0, slash));
            AssetDatabase.CreateFolder(folder.Substring(0, slash), folder.Substring(slash + 1));
        }

        // ---- operations ---------------------------------------------------------------------------------------------

        /// <summary>Kit Sync into the config's kit folder (else the profile's, else one picked).</summary>
        internal void KitSync()
        {
            var kit = m_Config.KitDir ?? DesignUiMenu.KitFolder(CurrentProfile);
            if (kit == null)
            {
                kit = PickFolder("Design UI: kit folder to sync into", ProjectRoot);
                if (string.IsNullOrEmpty(kit)) return;
            }
            Finish("Kit Sync", KitSyncOp(ProfilePathForOps, kit));
        }

        /// <summary>Import Screen…: a screen folder under the design root (its .design-ui/export) or an export folder.</summary>
        internal void ImportScreen()
        {
            var start = m_Config.DesignRoot != null && Directory.Exists(m_Config.DesignRoot) ? m_Config.DesignRoot : ProjectRoot;
            var chosen = PickFolder("Design UI: screen folder to import (its exported screen.ir.json)", start);
            if (string.IsNullOrEmpty(chosen)) return;
            var export = DesignUiProjectConfig.ExportFolderOf(chosen, out var error);
            if (export == null)
            {
                Finish("Import", new OpResult(1, error));
                return;
            }
            var profile = ProfilePathForOps;
            var r = ImportOp(profile, export, false);
            if (r.Code != 0 && (r.Log ?? "").Contains("edited by hand: ") && Confirm(DesignUiMenu.DialogText(r) + "\n\nDiscard the hand edits and import again?"))
                r = ImportOp(profile, export, true);
            Finish("Import", r);
        }

        void Finish(string what, OpResult r)
        {
            var first = (r.Log ?? "").Split('\n')[0];
            m_OpResult.text = what + (r.Code == 0 ? ": " : " failed (code " + r.Code + "): ") + first;
            ShowResult(what, r);
            RefreshProject();
            RefreshText();
        }

        // ---- text ---------------------------------------------------------------------------------------------------

        internal void RefreshText()
        {
            if (m_TextKit == null) return;
            var profile = CurrentProfile;
            var s = TextStatus.Check(profile, m_Config.KitDir ?? DesignUiMenu.KitFolder(profile));
            m_TextKit.text = "Kit fonts: " + s.Kit;
            m_TextTwins.text = "Font twins: " + s.Twins;
            m_TextFontSet.text = "DesignFonts.asset: " + s.FontSet;
        }

        // ---- MCP clients --------------------------------------------------------------------------------------------

        /// <summary>Copies the client's configuration for this project and returns it.</summary>
        internal string CopySnippet(McpClient client)
        {
            var text = McpClientSnippets.For(client, ProjectRoot, m_Config.ServerPath);
            Clipboard(text);
            m_CopyResult.text = "Copied the " + McpClientSnippets.Label(client) + " configuration: " + McpClientSnippets.Where(client) + "." +
                                (m_Config.ServerPath == null ? " It holds a placeholder for the server path (see above)." : "");
            return text;
        }
    }
}
