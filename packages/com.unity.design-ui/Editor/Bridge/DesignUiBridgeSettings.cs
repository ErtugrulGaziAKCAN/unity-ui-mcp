using System;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace DesignUi.Editor
{
    public static class DesignUiBridgeSettings
    {
        internal static string ProjectRoot => Directory.GetParent(Application.dataPath).FullName;
        internal static string SettingsPath => Path.Combine(ProjectRoot, "UserSettings", "DesignUi.json");

        static bool? s_Enabled;

        public static bool Enabled
        {
            get
            {
                if (s_Enabled.HasValue) return s_Enabled.Value;
                s_Enabled = Read();
                return s_Enabled.Value;
            }
            set
            {
                s_Enabled = value;
                Write(value);
                if (value) DesignUiBridge.Start();
                else DesignUiBridge.Stop(true);
            }
        }

        // Drops the cached value so the next read comes from disk (used after tests restore the file).
        internal static void ResetCache()
        {
            s_Enabled = null;
        }

        internal static void WriteAtomic(string path, string text)
        {
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, text);
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }

        static bool Read()
        {
            try
            {
                var path = SettingsPath;
                if (!File.Exists(path)) return true;
                var o = JObject.Parse(File.ReadAllText(path));
                var t = o["bridgeEnabled"];
                return t == null || t.Type != JTokenType.Boolean || t.Value<bool>();
            }
            catch (Exception)
            {
                return true;
            }
        }

        static void Write(bool value)
        {
            try
            {
                var path = SettingsPath;
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                JObject o;
                try { o = File.Exists(path) ? JObject.Parse(File.ReadAllText(path)) : new JObject(); }
                catch (Exception) { o = new JObject(); }
                o["bridgeEnabled"] = value;
                WriteAtomic(path, o.ToString());
            }
            catch (Exception e)
            {
                Debug.LogWarning("DesignUi: could not save bridge settings: " + e.Message);
            }
        }
    }
}
