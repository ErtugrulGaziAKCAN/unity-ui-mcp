using System;
using UnityEngine;
using UnityEngine.Localization;
using UnityEngine.Localization.Settings;
using UnityEngine.ResourceManagement.AsyncOperations;

namespace DesignUi
{
    /// <summary>
    /// Unity Localization's selected locale as a design screen's locale source (compiled when com.unity.localization 1.5
    /// or newer is installed, and then the default of <see cref="DesignLocaleSources"/>). It follows
    /// <c>LocalizationSettings.SelectedLocaleChanged</c>. The first locale comes from <c>SelectedLocaleAsync</c> without
    /// waiting on it: until the selection is known <see cref="LocaleCode"/> is null and the screen keeps its locale.
    /// </summary>
    public sealed class UnityLocalizationLocaleSource : IDesignLocaleSource, IDisposable
    {
        string m_Code;
        bool m_Disposed;

        public UnityLocalizationLocaleSource()
        {
            LocalizationSettings.SelectedLocaleChanged += OnSelectedLocaleChanged;
            var selected = LocalizationSettings.SelectedLocaleAsync;
            if (!selected.IsValid()) return;
            if (selected.IsDone)
            {
                if (selected.Status == AsyncOperationStatus.Succeeded) m_Code = Code(selected.Result);
            }
            else
                selected.Completed += op =>
                {
                    if (op.Status == AsyncOperationStatus.Succeeded) OnSelectedLocaleChanged(op.Result);
                };
        }

        public string LocaleCode => m_Code;

        public event Action<string> LocaleChanged;

        public void Dispose()
        {
            if (m_Disposed) return;
            m_Disposed = true;
            LocalizationSettings.SelectedLocaleChanged -= OnSelectedLocaleChanged;
        }

        void OnSelectedLocaleChanged(Locale locale)
        {
            var code = Code(locale);
            if (m_Disposed || code == null || code == m_Code) return; // null: a refresh without a selection keeps the current one
            m_Code = code;
            LocaleChanged?.Invoke(code);
        }

        static string Code(Locale locale)
        {
            var code = locale != null ? locale.Identifier.Code : null;
            return string.IsNullOrEmpty(code) ? null : code;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void Register() => DesignLocaleSources.Default = () => new UnityLocalizationLocaleSource();

#if UNITY_EDITOR
        [UnityEditor.InitializeOnLoadMethod]
        static void RegisterInEditor() => Register();
#endif
    }
}
