using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// A localized text binding of a compiled screen (the compiler's <c>DesignLocalizedString</c>, in the optional
    /// DesignUi.Runtime.Localization assembly): the String Table entry the element shows. A text with arguments
    /// (<c>{name}</c> in the design text) gets its values from the generated view through <see cref="DesignTextArgs"/>.
    /// </summary>
    public interface IDesignLocalizedText
    {
        /// <summary>
        /// Declares the text's arguments in the order <see cref="SetArgument"/> addresses them: Smart String variables by
        /// name (<c>{name}</c>) and, in the same order, format arguments (<c>{0}</c>, <c>{1}</c>). Each starts empty.
        /// </summary>
        void DeclareArguments(string[] names);

        /// <summary>Sets argument <paramref name="index"/> and refreshes the text (an unchanged value writes nothing).</summary>
        void SetArgument(int index, string value);
    }

    /// <summary>Finds the localized text binding of an element.</summary>
    public static class DesignLocalizedTexts
    {
        /// <summary>The element's localized text binding (on any of its properties), or null.</summary>
        public static IDesignLocalizedText Of(VisualElement element)
        {
            if (element == null) return null;
            foreach (var info in element.GetBindingInfos())
                if (info.binding is IDesignLocalizedText text) return text;
            return null;
        }
    }
}
