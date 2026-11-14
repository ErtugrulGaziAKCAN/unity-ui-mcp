using System;
using System.Collections.Generic;
using Unity.Properties;
using UnityEngine;
using UnityEngine.AddressableAssets;
using UnityEngine.Localization;
using UnityEngine.Localization.Pseudo;
using UnityEngine.Localization.Settings;
using UnityEngine.Localization.Tables;
using UnityEngine.ResourceManagement.AsyncOperations;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// The localized text of a compiled screen element: a UI Toolkit binding of a String Table entry (Unity Localization's
    /// <see cref="LocalizedString"/> as declared in the screen's UXML: table, entry, its lifetime with the panel), so the
    /// text follows the selected locale while the screen is open. Every write goes through <see cref="DesignText"/>: the
    /// text's characters reach the twins of the element's locale, with their kerning pairs, before it is laid out, in the
    /// panel's binding update after the locale controller moved the screen to the new locale's class and font.
    /// <list type="bullet">
    /// <item>The binding loads its entry and formats it itself (no synchronous load), so a translation can never throw out of
    /// a generated setter or out of the locale change other listeners also wait for.</item>
    /// <item>Each entry is formatted by its own Smart flag: a Smart String gets the arguments by name (<c>{who}</c>), a plain
    /// entry gets them by index in the design's argument order (<c>{0}</c>).</item>
    /// <item>An entry that cannot be formatted is reported once per key and locale and replaced by the English entry
    /// formatted the same way, else by the English text as written, else by its own text as written; a missing entry shows
    /// nothing. The screen never shows a key or Unity Localization's missing-translation message (also not for an entry of
    /// arguments only whose values are still empty). English is the screen's <c>source-locale</c>, else <c>en</c>.</item>
    /// <item>Missing translations use the locale's fallback chain (<see cref="FallbackBehavior.UseFallback"/>), which the
    /// project points at English.</item>
    /// </list>
    /// </summary>
    [UxmlObject]
    public partial class DesignLocalizedString : LocalizedString, IDesignLocalizedText
    {
        const string DefaultEnglish = "en";
        static readonly HashSet<string> s_Reported = new HashSet<string>();

        readonly Action<Locale> m_OnLocaleChanged;
        readonly Action<AsyncOperationHandle<LocalizedStringDatabase.TableEntryResult>> m_OnLoaded, m_OnEnglishLoaded;
        AsyncOperationHandle<LocalizedStringDatabase.TableEntryResult> m_Load, m_English;
        VisualElement m_Target;
        bool m_Active, m_HasValue, m_WantsEnglish;
        string m_Value;
        string[] m_Names = new string[0];
        object[] m_Values = new object[0];
        readonly Dictionary<string, object> m_Named = new Dictionary<string, object>(StringComparer.Ordinal);
        object[] m_NamedArgs;

        public DesignLocalizedString()
        {
            m_OnLocaleChanged = OnLocaleChanged;
            m_OnLoaded = _ => Guarded(Refresh);
            m_OnEnglishLoaded = _ => Guarded(Refresh);
            m_NamedArgs = new object[] { m_Named };
            FallbackState = FallbackBehavior.UseFallback;
        }

        /// <summary>The text the binding writes next, or null before the entry is loaded.</summary>
        public string Text => m_HasValue ? m_Value : null;

        public void DeclareArguments(string[] names)
        {
            m_Names = names ?? new string[0];
            m_Values = new object[m_Names.Length];
            m_Named.Clear();
            for (int i = 0; i < m_Names.Length; i++)
            {
                m_Values[i] = "";
                m_Named[m_Names[i]] = "";
            }
        }

        public void SetArgument(int index, string value)
        {
            if (value == null) value = "";
            if (string.Equals((string)m_Values[index], value, StringComparison.Ordinal)) return;
            m_Values[index] = value;
            m_Named[m_Names[index]] = value;
            Guarded(Refresh);
        }

        // ---- lifetime: the base counts activations of the binding (the element in a panel) -------------------------------

        protected override void OnActivated(in BindingActivationContext context)
        {
            m_Target = context.targetElement;
            base.OnActivated(context);
        }

        protected override void OnDeactivated(in BindingActivationContext context)
        {
            base.OnDeactivated(context);
            if (m_Target == context.targetElement) m_Target = null;
        }

        /// <summary>Starts following the selected locale (the base's own loading is not used: it formats inside the locale change).</summary>
        protected override void Initialize()
        {
            m_Active = true;
            LocalizationSettings.SelectedLocaleChanged += m_OnLocaleChanged;
            Guarded(Load);
        }

        protected override void Cleanup()
        {
            LocalizationSettings.SelectedLocaleChanged -= m_OnLocaleChanged;
            m_Active = false;
            Clear();
            m_HasValue = false;
            m_Value = null;
        }

        /// <summary>The table, entry or locale override changed.</summary>
        protected override void ForceUpdate()
        {
            if (m_Active) Guarded(Load);
        }

        void OnLocaleChanged(Locale locale) => Guarded(Load);

        /// <summary>Nothing escapes to a setter or to the listeners of a locale change.</summary>
        void Guarded(Action action)
        {
            try { action(); }
            catch (Exception e) { Report("could not be shown", e.Message); }
        }

        // ---- loading -----------------------------------------------------------------------------------------------------

        void Load()
        {
            Clear();
            if (IsEmpty) return;
            m_Load = LocalizationSettings.StringDatabase.GetTableEntryAsync(TableReference, TableEntryReference, LocaleOverride, FallbackState);
            Addressables.ResourceManager.Acquire(m_Load);
            if (m_Load.IsDone) Refresh();
            else m_Load.Completed += m_OnLoaded;
        }

        static void Release(ref AsyncOperationHandle<LocalizedStringDatabase.TableEntryResult> handle, Action<AsyncOperationHandle<LocalizedStringDatabase.TableEntryResult>> completed)
        {
            if (!handle.IsValid()) return;
            if (!handle.IsDone) handle.Completed -= completed;
            Addressables.Release(handle);
            handle = default;
        }

        void Clear()
        {
            Release(ref m_Load, m_OnLoaded);
            Release(ref m_English, m_OnEnglishLoaded);
            m_WantsEnglish = false;
        }

        /// <summary>The English entry, loaded once an entry of the selected locale could not be formatted.</summary>
        void LoadEnglish()
        {
            m_WantsEnglish = true;
            if (m_English.IsValid()) return;
            // the locales are known once Localization is initialized; before that nothing is looked up (it would wait)
            if (!LocalizationSettings.InitializationOperation.IsDone) return;
            var english = LocalizationSettings.AvailableLocales?.GetLocale(new LocaleIdentifier(EnglishCode()));
            if (english == null) return;
            m_English = LocalizationSettings.StringDatabase.GetTableEntryAsync(TableReference, TableEntryReference, english, FallbackBehavior.DontUseFallback);
            Addressables.ResourceManager.Acquire(m_English);
            if (!m_English.IsDone) m_English.Completed += m_OnEnglishLoaded;
        }

        // ---- formatting --------------------------------------------------------------------------------------------------

        void Refresh()
        {
            if (!m_Load.IsValid() || !m_Load.IsDone) return;
            if (m_Load.Status != AsyncOperationStatus.Succeeded)
            {
                Report("could not be loaded", m_Load.OperationException?.Message);
                Show("");
                return;
            }
            var entry = m_Load.Result.Entry;
            if (entry == null)
            {
                Report("has no entry", null);
                Show(""); // never the key
                return;
            }
            if (TryFormat(entry, out var text, out var error))
            {
                Show(text);
                return;
            }
            Report("could not be formatted", error);
            LoadEnglish();
            var english = m_English.IsValid() && m_English.IsDone && m_English.Status == AsyncOperationStatus.Succeeded ? m_English.Result.Entry : null;
            if (english != null && TryFormat(english, out text, out _)) Show(text);
            else if (english != null && !string.IsNullOrEmpty(english.Value)) Show(english.Value);
            else if (!m_WantsEnglish || !m_English.IsValid() || m_English.IsDone) Show(entry.Value ?? "");
            // else: the English entry is still loading; the element keeps what it shows
        }

        /// <summary>The entry with the arguments: by name for a Smart String, by index for a plain entry.</summary>
        bool TryFormat(StringTableEntry entry, out string text, out string error)
        {
            error = null;
            try
            {
                var locale = LocaleOf(entry);
                var args = entry.IsSmart ? m_NamedArgs : m_Values.Length > 0 ? m_Values : null;
                text = entry.GetLocalizedString(locale, args, locale as PseudoLocale) ?? "";
                return true;
            }
            catch (Exception e)
            {
                text = null;
                error = e.Message;
                return false;
            }
        }

        /// <summary>The locale of the entry's table (its number and date format), or null.</summary>
        static Locale LocaleOf(StringTableEntry entry)
        {
            var id = entry.Table != null ? entry.Table.LocaleIdentifier : default;
            if (!LocalizationSettings.InitializationOperation.IsDone || string.IsNullOrEmpty(id.Code)) return null;
            return LocalizationSettings.AvailableLocales?.GetLocale(id);
        }

        void Show(string text)
        {
            m_Value = text ?? "";
            m_HasValue = true;
            MarkDirty();
            // a panel that updates only when it has to repaint (an Editor panel outside Play mode) applies the binding too
            m_Target?.MarkDirtyRepaint();
        }

        /// <summary>Once per key, table and locale (per session): what failed, and that English or the text as written is shown.</summary>
        void Report(string what, string detail)
        {
            var locale = m_Load.IsValid() && m_Load.IsDone && m_Load.Status == AsyncOperationStatus.Succeeded && m_Load.Result.Table != null
                ? m_Load.Result.Table.LocaleIdentifier.Code : LocaleOverride != null ? LocaleOverride.Identifier.Code : "selected locale";
            var key = TableEntryReference.ReferenceType == TableEntryReference.Type.Name ? TableEntryReference.Key : TableEntryReference.KeyId.ToString();
            var table = TableReference.ReferenceType == TableReference.Type.Name ? TableReference.TableCollectionName : TableReference.TableCollectionNameGuid.ToString();
            if (!s_Reported.Add(table + "/" + key + "/" + locale + "/" + what)) return;
            Debug.LogWarning("Design UI: the String Table entry '" + key + "' of '" + table + "' (" + locale + ") " + what +
                             (string.IsNullOrEmpty(detail) ? "" : " (" + detail.Split('\n')[0] + ")") + "; the screen shows the English entry or the text as written instead");
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetReports() => s_Reported.Clear();

        // ---- the write ---------------------------------------------------------------------------------------------------

        protected override BindingResult Update(in BindingContext context)
        {
            if (IsEmpty) return new BindingResult(BindingStatus.Success);
            if (!m_HasValue) return new BindingResult(BindingStatus.Pending);
            var element = context.targetElement;
            // what DesignText.SetText does: the characters reach the locale's twins, then the text is assigned
            if (m_Value.Length > 0) DesignText.Prepare(element, m_Value, ScreenOf(element)?.Fonts);
            return ConverterGroups.TrySetValueGlobal(ref element, context.bindingId, m_Value, out VisitReturnCode code)
                ? new BindingResult(BindingStatus.Success)
                : new BindingResult(BindingStatus.Failure, "DesignLocalizedString: cannot set '" + context.bindingId + "' on " + element.GetType().Name + " (" + code + ")");
        }

        /// <summary>The compiled screen root above <paramref name="element"/>, or null.</summary>
        static DesignScreen ScreenOf(VisualElement element)
        {
            for (var e = element; e != null; e = e.hierarchy.parent)
                if (e is DesignScreen screen) return screen;
            return null;
        }

        string EnglishCode()
        {
            var code = ScreenOf(m_Target)?.SourceLocale;
            return string.IsNullOrEmpty(code) ? DefaultEnglish : code;
        }
    }
}
