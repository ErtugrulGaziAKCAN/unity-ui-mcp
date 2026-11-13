using System;
using System.Collections.Generic;
using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// What a generated view and its item views share: the compiled screen root, the font set its bound text is prepared
    /// in, and the screen's item templates. The font set is the screen's own reference (the <see cref="DesignScreen"/>
    /// root's <c>fonts</c>, written by the compiler), else the one its host gave <see cref="DesignText.Fonts"/> (a
    /// <see cref="DesignUiPanelRegion"/> does on attach); games never wire it. The item templates are the
    /// <c>&lt;ui:Template&gt;</c> declarations of the screen's UXML, found through the root's
    /// <see cref="VisualElement.visualTreeAssetSource"/>.
    /// </summary>
    public sealed class DesignViewContext
    {
        readonly string m_View;
        readonly DesignScreen m_Screen;

        /// <param name="screenRoot">The compiled screen root the view found.</param>
        /// <param name="view">The generated view's class name, for error messages.</param>
        public DesignViewContext(VisualElement screenRoot, string view)
        {
            ScreenRoot = screenRoot ?? throw new ArgumentNullException(nameof(screenRoot));
            m_View = view;
            m_Screen = screenRoot as DesignScreen;
            // a DesignScreen reports its own attach; any other root is reported here, so a LocaleFontController above it
            // gives it the locale, right-to-left and text-size classes wherever it was inserted
            if (m_Screen == null)
            {
                screenRoot.RegisterCallback<AttachToPanelEvent>(_ => LocaleFontController.ScreenAttached(screenRoot));
                screenRoot.RegisterCallback<DetachFromPanelEvent>(_ => LocaleFontController.ScreenDetached(screenRoot));
                if (screenRoot.panel != null) LocaleFontController.ScreenAttached(screenRoot);
            }
        }

        public VisualElement ScreenRoot { get; }

        /// <summary>The font set bound text is prepared in: the screen's own, else <see cref="DesignText.Fonts"/>, else null.</summary>
        public DesignFontSet Fonts
        {
            get
            {
                var own = m_Screen != null ? m_Screen.Fonts : null;
                return own != null ? own : DesignText.Fonts;
            }
        }

        /// <summary>
        /// The item template <paramref name="name"/> (<c>&lt;Repeat&gt;Item</c>) the screen's UXML declares. Throws
        /// InvalidOperationException when the screen was not cloned from its compiled UXML or the UXML does not declare it.
        /// </summary>
        public VisualTreeAsset Template(string name)
        {
            var source = ScreenRoot.visualTreeAssetSource;
            if (source != null)
                foreach (var t in source.templateDependencies)
                    if (t != null && t.name == name) return t;
            throw new InvalidOperationException(m_View + ": the screen's UXML " + (source == null ? "is unknown (the root was not cloned from a UXML file)" : "'" + source.name + "' declares no template") +
                                                " '" + name + "' for its repeated items; build the screen from its compiled UXML and recompile the screen when the design changed");
        }
    }

    /// <summary>A shadow host that mirrors view-toggled classes of its element (the compiler's mirrored <c>is-*</c> layers).</summary>
    public sealed class DesignClassMirror
    {
        public readonly VisualElement Element;
        public readonly VisualElement Host;
        readonly string[] m_Classes;

        public DesignClassMirror(VisualElement element, VisualElement host, params string[] classes)
        {
            Element = element ?? throw new ArgumentNullException(nameof(element));
            Host = host ?? throw new ArgumentNullException(nameof(host));
            m_Classes = classes ?? new string[0];
        }

        public bool Mirrors(string className)
        {
            for (int i = 0; i < m_Classes.Length; i++)
                if (m_Classes[i] == className) return true;
            return false;
        }
    }

    /// <summary>Helpers of generated views (spec 9). Generated code calls them; games use the views.</summary>
    public static class DesignView
    {
        /// <summary>The class the view keeps on the first item of an inline repeat (USS has no <c>:first-child</c>).</summary>
        public const string FirstItemClass = "__first";

        /// <summary>
        /// The element named <paramref name="name"/>: <paramref name="root"/> itself or its first descendant of that name.
        /// Throws InvalidOperationException naming the view and the element when there is none of type T.
        /// </summary>
        public static T Find<T>(VisualElement root, string name, string view) where T : VisualElement
        {
            if (root == null) throw new ArgumentNullException(nameof(root));
            var element = root.name == name ? root as T : root.Q<T>(name);
            if (element == null) throw Missing(typeof(T), name, root.name, view);
            return element;
        }

        /// <summary>The element named <paramref name="name"/> at or below one of an item's root elements, in order.</summary>
        public static T Find<T>(IReadOnlyList<VisualElement> roots, string name, string view) where T : VisualElement
        {
            if (roots == null) throw new ArgumentNullException(nameof(roots));
            for (int i = 0; i < roots.Count; i++)
            {
                var r = roots[i];
                var element = r.name == name ? r as T : r.Q<T>(name);
                if (element != null) return element;
            }
            throw Missing(typeof(T), name, roots.Count > 0 ? roots[0].name : "", view);
        }

        static InvalidOperationException Missing(Type type, string name, string below, string view) =>
            new InvalidOperationException(view + ": no " + type.Name + " named '" + name + "' below '" + below +
                                          "'; pass the screen's tree and recompile the screen when the design changed");

        /// <summary>
        /// Shows a text on a text-carrying control through <see cref="DesignText"/> (its characters reach the locale's twins
        /// before it is assigned, so its first layout is kerned): a Label's or Button's text, a Toggle's label, a TextField's
        /// or DropdownField's value (set without a change event).
        /// </summary>
        public static void SetText(VisualElement element, string text, DesignViewContext context)
        {
            var fonts = context?.Fonts;
            switch (element)
            {
                case TextElement t:
                    DesignText.SetText(t, text, fonts);
                    break;
                case Toggle t:
                    DesignText.Prepare(t, text, fonts);
                    t.text = text;
                    break;
                case TextField f:
                    DesignText.Prepare(f, text, fonts);
                    f.SetValueWithoutNotify(text);
                    break;
                case DropdownField d:
                    DesignText.Prepare(d, text, fonts);
                    d.SetValueWithoutNotify(text);
                    break;
                case null:
                    throw new ArgumentNullException(nameof(element));
                default:
                    throw new ArgumentException("element '" + element.name + "' (" + element.GetType().Name + ") carries no text", nameof(element));
            }
        }

        /// <summary>The text a text-carrying control shows now (see <see cref="SetText"/>), or null.</summary>
        public static string GetText(VisualElement element)
        {
            switch (element)
            {
                case TextElement t: return t.text;
                case Toggle t: return t.text;
                case TextField f: return f.value;
                case DropdownField d: return d.value;
                default: return null;
            }
        }

        /// <summary>Shows <paramref name="image"/> as the background image of the element that paints a design image.</summary>
        public static void SetImage(VisualElement element, Background image)
        {
            if (element == null) throw new ArgumentNullException(nameof(element));
            element.style.backgroundImage = new StyleBackground(image);
        }

        /// <summary>
        /// Adds or removes a view-state class (<c>is-*</c>) on <paramref name="element"/> and on the shadow hosts that mirror
        /// it, so the design's <c>class:is-x</c> layers apply.
        /// </summary>
        public static void SetClass(VisualElement element, string className, bool on, DesignClassMirror[] mirrors)
        {
            if (element == null) throw new ArgumentNullException(nameof(element));
            if (string.IsNullOrEmpty(className)) throw new ArgumentException("no class name", nameof(className));
            element.EnableInClassList(className, on);
            if (mirrors == null) return;
            for (int i = 0; i < mirrors.Length; i++)
                if (mirrors[i].Element == element && mirrors[i].Mirrors(className)) mirrors[i].Host.EnableInClassList(className, on);
        }

        /// <summary>
        /// Enables or disables <paramref name="element"/> (Unity's enabled state, so the design's <c>:disabled</c> layer
        /// applies) and copies the state to the shadow hosts of <paramref name="mirrors"/> at once.
        /// </summary>
        public static void SetEnabled(VisualElement element, bool enabled, PseudoStateMirror[] mirrors)
        {
            if (element == null) throw new ArgumentNullException(nameof(element));
            if (element.enabledSelf != enabled) element.SetEnabled(enabled);
            if (mirrors == null) return;
            for (int i = 0; i < mirrors.Length; i++) mirrors[i].Sync();
        }

        /// <summary>Shows the classes a state gives the screen root: its class on, the other states' classes off.</summary>
        public static void SetState(VisualElement screenRoot, string[] stateClasses, int state)
        {
            if (screenRoot == null) throw new ArgumentNullException(nameof(screenRoot));
            if (state < 0 || state >= stateClasses.Length) throw new ArgumentOutOfRangeException(nameof(state));
            for (int i = 0; i < stateClasses.Length; i++)
                if (stateClasses[i] != null) screenRoot.EnableInClassList(stateClasses[i], i == state);
        }
    }

    /// <summary>
    /// A text with Smart String arguments (<c>{name}</c> in the design text): the view keeps the text the element shows when
    /// it is created as the template and writes the text with the arguments filled in (an argument not set yet is empty)
    /// whenever one changes, through <see cref="DesignView.SetText"/>.
    /// </summary>
    public sealed class DesignTextArgs
    {
        readonly VisualElement m_Element;
        readonly DesignViewContext m_Context;
        readonly string m_Template;
        readonly string[] m_Names;
        readonly string[] m_Values;
        readonly System.Text.StringBuilder m_Text = new System.Text.StringBuilder();

        /// <param name="names">The argument names, in the order the view's setters address them.</param>
        public DesignTextArgs(VisualElement element, DesignViewContext context, params string[] names)
        {
            m_Element = element ?? throw new ArgumentNullException(nameof(element));
            m_Context = context;
            m_Template = DesignView.GetText(element) ?? "";
            m_Names = names ?? new string[0];
            m_Values = new string[m_Names.Length];
        }

        /// <summary>The template the arguments are filled into (the design text).</summary>
        public string Template => m_Template;

        /// <summary>Sets argument <paramref name="index"/>; an unchanged value writes nothing.</summary>
        public void Set(int index, string value)
        {
            if (value == null) value = "";
            if (m_Values[index] != null && string.Equals(m_Values[index], value, StringComparison.Ordinal)) return;
            m_Values[index] = value;
            DesignView.SetText(m_Element, Format(), m_Context);
        }

        string Format()
        {
            m_Text.Length = 0;
            int i = 0;
            while (i < m_Template.Length)
            {
                char c = m_Template[i];
                if (c == '{')
                {
                    int close = m_Template.IndexOf('}', i + 1);
                    int arg = close < 0 ? -1 : ArgIndex(i + 1, close - i - 1);
                    if (arg >= 0)
                    {
                        m_Text.Append(m_Values[arg] ?? "");
                        i = close + 1;
                        continue;
                    }
                }
                m_Text.Append(c);
                i++;
            }
            return m_Text.ToString();
        }

        int ArgIndex(int start, int length)
        {
            for (int k = 0; k < m_Names.Length; k++)
                if (m_Names[k].Length == length && string.CompareOrdinal(m_Template, start, m_Names[k], 0, length) == 0) return k;
            return -1;
        }
    }
}
