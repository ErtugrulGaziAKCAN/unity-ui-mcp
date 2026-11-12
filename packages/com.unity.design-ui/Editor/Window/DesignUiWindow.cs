using System;
using System.Globalization;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi.Editor
{
    public sealed class DesignUiWindow : EditorWindow
    {
        static string s_Version;
        Label m_Status;
        Toggle m_Enable;
        Label m_Project;
        Label m_Last;
        Label m_Package;

        [MenuItem("Window/Design UI/Status")]
        public static void Open()
        {
            var w = GetWindow<DesignUiWindow>();
            w.titleContent = new GUIContent("Design UI");
            w.Show();
        }

        void CreateGUI()
        {
            var root = rootVisualElement;
            root.style.paddingLeft = root.style.paddingRight = root.style.paddingTop = root.style.paddingBottom = 8;

            root.Add(Section("Bridge", out var bridge));
            m_Status = new Label();
            bridge.Add(m_Status);
            m_Enable = new Toggle("Enable bridge");
            m_Enable.RegisterValueChangedCallback(e =>
            {
                if (e.newValue != DesignUiBridgeSettings.Enabled) DesignUiBridgeSettings.Enabled = e.newValue;
            });
            bridge.Add(m_Enable);
            bridge.Add(new Button(DesignUiBridge.Restart) { text = "Restart" });
            m_Project = new Label();
            m_Project.style.whiteSpace = WhiteSpace.Normal;
            bridge.Add(m_Project);

            root.Add(Section("Last request", out var last));
            m_Last = new Label();
            last.Add(m_Last);

            root.Add(Section("Package", out var pkg));
            m_Package = new Label();
            pkg.Add(m_Package);

            DesignUiBridge.StateChanged -= Refresh;
            DesignUiBridge.StateChanged += Refresh;
            root.schedule.Execute(Refresh).Every(1000);
            Refresh();
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

        internal void Refresh()
        {
            if (m_Status == null) return;
            if (!DesignUiBridgeSettings.Enabled) m_Status.text = "Disabled";
            else if (DesignUiBridge.IsListening) m_Status.text = "Listening on 127.0.0.1:" + DesignUiBridge.Port;
            else m_Status.text = "Stopped";
            m_Enable.SetValueWithoutNotify(DesignUiBridgeSettings.Enabled);
            m_Project.text = DesignUiBridgeSettings.ProjectRoot;

            var last = DesignUiBridge.LastRequest;
            m_Last.text = last.HasValue
                ? last.Value.Utc.ToLocalTime().ToString("HH:mm:ss", CultureInfo.InvariantCulture) + " · " + last.Value.Op + " · code " + last.Value.Code
                : "None yet";

            if (s_Version == null)
            {
                var info = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(DesignUiWindow).Assembly);
                s_Version = info != null ? info.version : "unknown";
            }
            m_Package.text = "Design UI " + s_Version;
        }
    }
}
