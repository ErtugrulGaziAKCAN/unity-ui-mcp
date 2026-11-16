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

        /// <summary>
        /// Writes <paramref name="text"/> to <paramref name="path"/> through a temporary file. <paramref name="ownerOnly"/> (a
        /// secret, such as the bridge token): on macOS and Linux the file is readable and writable by its user only (mode 0600,
        /// set before the text is written); on Windows it keeps the ACLs of the project's folder.
        /// </summary>
        internal static void WriteAtomic(string path, string text, bool ownerOnly = false)
        {
            var tmp = path + ".tmp";
            if (ownerOnly)
            {
                File.WriteAllText(tmp, "");
                RestrictToOwner(tmp);
            }
            File.WriteAllText(tmp, text);
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }

        [System.Runtime.InteropServices.DllImport("libc", EntryPoint = "chmod", SetLastError = true)]
        static extern int Chmod(string path, int mode);

        /// <summary>Mode 0600 on macOS and Linux (the file's user reads and writes it, nobody else); nothing on Windows.</summary>
        static void RestrictToOwner(string path)
        {
            if (Application.platform == RuntimePlatform.WindowsEditor) return;
            int result;
            try { result = Chmod(path, 0x180); } // 0600
            catch (Exception e) { throw new IOException("could not restrict " + path + " to its user: " + e.Message, e); }
            if (result != 0)
                throw new IOException("could not restrict " + path + " to its user (chmod error " + System.Runtime.InteropServices.Marshal.GetLastWin32Error() + ")");
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
