using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// Project Settings > UI Toolkit > Enable Advanced Text switched on the way the settings window does it
    /// (<c>UIToolkitProjectSettings.enableAdvancedText</c>: Unity writes the ICU data into every PanelSettings asset and
    /// saves them), and back off with every file it wrote restored. Documents that exist while it is switched are
    /// rebuilt by Unity, so a test switches it before it makes its panel.
    /// </summary>
    internal sealed class ProjectAdvancedText : IDisposable
    {
        static readonly PropertyInfo Setting = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("UnityEditor.UIElements.UIToolkitProjectSettings"))
            .FirstOrDefault(t => t != null)?.GetProperty("enableAdvancedText", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        readonly Dictionary<string, byte[]> _files = new Dictionary<string, byte[]>();
        /// <summary>Each PanelSettings asset with the ICU data it had (the switch assigns it in memory and on disk).</summary>
        readonly List<(PanelSettings settings, Object icu)> _icu = new List<(PanelSettings, Object)>();
        readonly bool _was;
        readonly Action<bool> _set;

        public static bool Available => Setting != null && Setting.CanWrite;

        /// <param name="set">Switches the setting (the project setting itself by default; a test passes a stand-in).</param>
        public ProjectAdvancedText(bool on, Action<bool> set = null)
        {
            _set = set ?? (v => Setting.SetValue(null, v));
            foreach (var p in AssetDatabase.FindAssets("t:PanelSettings").Select(AssetDatabase.GUIDToAssetPath))
            {
                var asset = AssetDatabase.LoadAssetAtPath<PanelSettings>(p);
                if (asset != null) using (var so = new SerializedObject(asset)) _icu.Add((asset, so.FindProperty("m_ICUDataAsset")?.objectReferenceValue));
            }
            foreach (var p in AssetDatabase.FindAssets("t:PanelSettings").Select(AssetDatabase.GUIDToAssetPath).Concat(new[] { "ProjectSettings/UIToolkitProjectSettings.asset" }))
                if (File.Exists(p)) _files[p] = File.ReadAllBytes(p);
            _was = set == null && (bool)Setting.GetValue(null);
            // a switch that fails midway may already have rewritten PanelSettings files: they are restored before it throws
            try { _set(on); }
            catch
            {
                try { Restore(false); } catch (Exception e) { Debug.LogException(e); }
                throw;
            }
        }

        public void Dispose() => Restore(true);

        /// <summary>Every step runs even when an earlier one throws; the first failure is thrown at the end.</summary>
        void Restore(bool setBack)
        {
            Exception first = null;
            void Step(Action a) { try { a(); } catch (Exception e) { first = first ?? e; } }
            if (setBack) Step(() => _set(_was));
            // the loaded assets first (a later save would write them again), then the files as they were
            foreach (var (settings, icu) in _icu)
            {
                if (settings == null) continue;
                Step(() =>
                {
                    using (var so = new SerializedObject(settings))
                    {
                        var p = so.FindProperty("m_ICUDataAsset");
                        if (p != null && p.objectReferenceValue != icu)
                        {
                            p.objectReferenceValue = icu;
                            so.ApplyModifiedPropertiesWithoutUndo();
                            AssetDatabase.SaveAssetIfDirty(settings);
                        }
                    }
                });
            }
            foreach (var kv in _files) Step(() => File.WriteAllBytes(kv.Key, kv.Value));
            foreach (var kv in _files) if (!kv.Key.StartsWith("ProjectSettings", StringComparison.Ordinal)) Step(() => AssetDatabase.ImportAsset(kv.Key, ImportAssetOptions.ForceUpdate));
            if (first != null) throw first;
        }
    }
}
