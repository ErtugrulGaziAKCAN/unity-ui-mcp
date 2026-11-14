using Unity.Properties;
using UnityEngine.Localization;
using UnityEngine.Localization.SmartFormat.Core.Extensions;
using UnityEngine.Localization.Settings;
using UnityEngine.Localization.SmartFormat.PersistentVariables;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// The localized text of a compiled screen element: Unity Localization's <see cref="LocalizedString"/> UI Toolkit
    /// binding (table and entry in the screen's UXML, so the text follows the selected locale while the screen is open),
    /// whose every write goes through <see cref="DesignText"/>: the text's characters reach the twins of the element's
    /// locale, with their kerning pairs, before it is laid out. The write happens in the panel's binding update, after the
    /// locale controller has moved the screen to the new locale's class and font in the same frame.
    /// <para>Missing translations use the locale's fallback chain (<see cref="FallbackBehavior.UseFallback"/>), which the
    /// project points at English. Arguments (<see cref="IDesignLocalizedText"/>) are both Smart String variables by name and
    /// format arguments by index, so an entry may use <c>{name}</c> (Smart String) or <c>{0}</c> (plain format). An entry
    /// made only of arguments whose values are all empty shows no text (Unity Localization would show its missing-translation
    /// message, which names the key). Nothing here loads synchronously.</para>
    /// </summary>
    [UxmlObject]
    public partial class DesignLocalizedString : LocalizedString, IDesignLocalizedText
    {
        /// <summary>A Smart String variable whose value the view sets; it raises no change event (the text refreshes once per set).</summary>
        sealed class Argument : IVariable
        {
            public string Value = "";
            public object GetSourceValue(ISelectorInfo selector) => Value;
        }

        readonly ChangeHandler m_Track;
        VisualElement m_Target;
        string m_Value;
        bool m_HasValue, m_EmptyFormat;
        Argument[] m_Arguments = new Argument[0];
        object[] m_Values = new object[0];

        public DesignLocalizedString()
        {
            m_Track = Track;
            FallbackState = FallbackBehavior.UseFallback;
        }

        /// <summary>The text the binding writes next (the last localized value), or null before the first one.</summary>
        public string Text => m_HasValue ? m_Value : null;

        public void DeclareArguments(string[] names)
        {
            names = names ?? new string[0];
            m_Arguments = new Argument[names.Length];
            m_Values = new object[names.Length];
            for (int i = 0; i < names.Length; i++)
            {
                m_Arguments[i] = new Argument();
                m_Values[i] = "";
                Add(names[i], m_Arguments[i]);
            }
            Arguments = m_Values;
        }

        public void SetArgument(int index, string value)
        {
            if (value == null) value = "";
            var argument = m_Arguments[index];
            if (string.Equals(argument.Value, value, System.StringComparison.Ordinal)) return;
            argument.Value = value;
            m_Values[index] = value;
            RefreshString(); // false while the entry loads: the load formats with the values set by then
        }

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

        protected override void Initialize()
        {
            base.Initialize();
            StringChanged += m_Track;
        }

        protected override void Cleanup()
        {
            StringChanged -= m_Track;
            base.Cleanup();
            m_HasValue = false;
            m_Value = null;
        }

        void Track(string value)
        {
            // Localization treats an empty formatted text as untranslated; an entry of arguments only is empty by design here
            m_EmptyFormat = m_Arguments.Length > 0 && ArgumentsEmpty() && OnlyArguments(EntryValue());
            m_Value = m_EmptyFormat ? "" : value;
            m_HasValue = true;
            // a panel that updates only when it has to repaint (an Editor panel outside Play mode) applies the binding too
            m_Target?.MarkDirtyRepaint();
        }

        protected override BindingResult Update(in BindingContext context)
        {
            if (m_HasValue && CurrentLoadingOperationHandle.IsValid() && CurrentLoadingOperationHandle.IsDone)
            {
                var element = context.targetElement;
                if (m_EmptyFormat)
                    return ConverterGroups.TrySetValueGlobal(ref element, context.bindingId, "", out VisitReturnCode _) ? new BindingResult(BindingStatus.Success) : base.Update(context);
                // what DesignText.SetText does: the characters reach the locale's twins, then the text is assigned (by the base)
                if (!string.IsNullOrEmpty(m_Value)) DesignText.Prepare(element, m_Value, FontsOf(element));
            }
            return base.Update(context);
        }

        string EntryValue() => CurrentLoadingOperationHandle.IsValid() && CurrentLoadingOperationHandle.IsDone ? CurrentLoadingOperationHandle.Result.Entry?.Value : null;

        bool ArgumentsEmpty()
        {
            for (int i = 0; i < m_Arguments.Length; i++)
                if (m_Arguments[i].Value.Length > 0) return false;
            return true;
        }

        /// <summary>Whether <paramref name="text"/> is nothing but placeholders (<c>{who}</c>, <c>{0}{1}</c>).</summary>
        static bool OnlyArguments(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            int depth = 0;
            foreach (var c in text)
            {
                if (c == '{') depth++;
                else if (c == '}') depth--;
                else if (depth == 0) return false;
                if (depth < 0) return false;
            }
            return depth == 0;
        }

        /// <summary>The font set of the compiled screen above <paramref name="element"/>, else null (<see cref="DesignText.Fonts"/>).</summary>
        static DesignFontSet FontsOf(VisualElement element)
        {
            for (var e = element; e != null; e = e.hierarchy.parent)
                if (e is DesignScreen screen && screen.Fonts != null) return screen.Fonts;
            return null;
        }
    }
}
