using System;
using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>
    /// The default font resolver (spec 6): every locale renders with TMP Settings' default font asset, followed by TMP
    /// Settings' global fallback font assets. The settings are TMP's own (<c>TMP_Settings.instance</c>, loaded through
    /// <c>Resources</c>), never a file path.
    /// </summary>
    public sealed class TmpSettingsFontResolver : IFontResolver
    {
        readonly Func<TMP_Settings> _settings;

        public TmpSettingsFontResolver() : this(Load) { }

        /// <summary>For tests: the settings object to read instead of TMP's.</summary>
        internal TmpSettingsFontResolver(Func<TMP_Settings> settings)
        {
            _settings = settings ?? throw new ArgumentNullException(nameof(settings));
        }

        public ResolvedFont Resolve(string locale)
        {
            var settings = _settings();
            if (settings == null) return null;
            using (var so = new SerializedObject(settings))
            {
                var primary = so.FindProperty("m_defaultFontAsset")?.objectReferenceValue as TMP_FontAsset;
                if (primary == null) return null;
                return new ResolvedFont { Primary = primary, Fallbacks = Globals(so).Where(f => f != primary).ToList() };
            }
        }

        /// <summary>TMP Settings' global fallback font assets (empty without TMP Settings), in order, without duplicates.</summary>
        internal static IReadOnlyList<TMP_FontAsset> GlobalFallbacks()
        {
            var settings = Load();
            if (settings == null) return new TMP_FontAsset[0];
            using (var so = new SerializedObject(settings)) return Globals(so);
        }

        static List<TMP_FontAsset> Globals(SerializedObject settings)
        {
            var fallbacks = new List<TMP_FontAsset>();
            var list = settings.FindProperty("m_fallbackFontAssets");
            if (list != null && list.isArray)
                for (int i = 0; i < list.arraySize; i++)
                    if (list.GetArrayElementAtIndex(i).objectReferenceValue is TMP_FontAsset f && !fallbacks.Contains(f))
                        fallbacks.Add(f);
            return fallbacks;
        }

        /// <summary>
        /// TMP's settings, only when a "TMP Settings" asset is reachable through Resources: asking TMP for settings that do
        /// not exist opens its resource importer window.
        /// </summary>
        static TMP_Settings Load() => Resources.Load<TMP_Settings>("TMP Settings") != null ? TMP_Settings.instance : null;
    }
}
