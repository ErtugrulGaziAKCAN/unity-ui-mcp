using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace DesignUi.Editor
{
    /// <summary>
    /// The compiler's localization step (spec 13), when the profile enables it: every design text of the compiled screen
    /// is bound to its String Table entry instead of being written as static text, and the screen's texts are collected
    /// for the String Table writer.
    /// <list type="bullet">
    /// <item>A Label's, Button's or Toggle's text binds <c>text</c>, a TextField's or DropdownField's design text binds
    /// <c>value</c>, a placeholder binds <c>placeholderText</c> and a title binds <c>tooltip</c>, each through the package's
    /// <c>DesignUi.DesignLocalizedString</c> (Unity Localization's LocalizedString binding, written through DesignText).
    /// <c>alt</c> and <c>aria-label</c> texts, which UI Toolkit does not draw, are written to the table and kept in the
    /// manifest.</item>
    /// <item>The UXML keeps no player-visible copy: a bound element's sample value (<c>data-u-bind</c>) is dropped too; the
    /// view sets it. A TextField's keyed design value is a localized default: a locale switch writes it again, also over
    /// what the player typed, so inputs the player edits carry data-u-bind (or a placeholder) instead.</item>
    /// <item>Localized text is plain unless the design marked it rich (a translation is never read as tags).</item>
    /// <item>Arguments: <c>{name}</c> stays for Smart Strings; the indexed format writes <c>{0}</c>, <c>{1}</c> in the order
    /// the generated view sets them (the design's argument order).</item>
    /// </list>
    /// A text without a key, two texts of one key that differ, or a screen without a collection fail the compile
    /// (<see cref="IrFormatException"/>) before anything is written.
    /// </summary>
    internal static class ScreenLocalization
    {
        /// <summary>The UXML type of the binding (an UxmlObject of the optional DesignUi.Runtime.Localization assembly).</summary>
        public const string BindingType = "DesignUi.DesignLocalizedString";
        public const string TextProperty = "text";
        public const string ValueProperty = "value";
        /// <summary>TextInputBaseField's placeholder as a binding id (Unity 6000.3; <c>textEdition.placeholder</c> does not bind).</summary>
        public const string PlaceholderProperty = "placeholderText";
        public const string TooltipProperty = "tooltip";
        /// <summary>The screen root's attribute naming English (<see cref="DesignUi.DesignScreen.SourceLocale"/>).</summary>
        public const string SourceLocaleAttribute = "source-locale";

        internal static StringTableRequest Bind(CompiledScreen compiled, DesignUiProfile profile)
        {
            var settings = profile.localization ?? new DesignLocalizationSettings();
            var collection = settings.CollectionFor(compiled.ScreenId);
            if (string.IsNullOrEmpty(collection))
                throw new IrFormatException("the profile names no String Table collection for screen '" + compiled.ScreenId +
                                            "'; add the screen to the profile's localization screen tables or set a default collection");
            var english = (settings.englishLocale ?? "").Trim();
            if (english.Length == 0) throw new IrFormatException("the profile's localization has no English locale code (englishLocale, e.g. en)");
            var reference = (profile.referenceLocale ?? "").Trim();
            if (reference.Length == 0) throw new IrFormatException("the profile has no reference locale");

            var texts = new List<ScreenText>();
            var byKey = new Dictionary<string, ScreenText>(StringComparer.Ordinal);
            void Collect(IrText text, string place, bool withArgs)
            {
                var args = withArgs ? (text.Args ?? new string[0]).Distinct(StringComparer.Ordinal).ToArray() : new string[0];
                var t = new ScreenText
                {
                    Key = text.Key, En = Format(text.En ?? "", args, settings.argumentFormat), Reference = Format(text.Tr ?? "", args, settings.argumentFormat), Args = args,
                };
                if (byKey.TryGetValue(text.Key, out var known))
                {
                    if (known.En != t.En || known.Reference != t.Reference || !known.Args.SequenceEqual(t.Args))
                        throw new IrFormatException("localization key '" + text.Key + "' has two different texts: '" + known.En + "' / '" + known.Reference + "' at " +
                                                    string.Join(", ", known.Places) + " and '" + t.En + "' / '" + t.Reference + "' at " + place + "; give them different keys");
                    known.Places.Add(place);
                    return;
                }
                t.Places.Add(place);
                byKey[text.Key] = t;
                texts.Add(t);
            }

            foreach (var e in compiled.AllElements())
            {
                var node = e.Source;
                if (node == null) continue;
                var property = TextPropertyOf(e.Tag);
                if (node.Text != null && property != null)
                {
                    if (node.Bind != null) DropStatic(e); // a runtime value: the view sets it
                    else
                    {
                        RequireKey(node.Text, e.Name, null);
                        Collect(node.Text, e.Name, true);
                        DropStatic(e);
                        e.Bindings.Add(new CompiledBinding(property, collection, node.Text.Key));
                        if (e.Tag != "ui:DropdownField") e.EnableRichText = node.Text.Rich ? (bool?)null : false;
                    }
                }
                else if (node.Bind != null) DropStatic(e);
                foreach (var kv in (node.AttrTexts ?? new Dictionary<string, IrText>()).OrderBy(kv => kv.Key, StringComparer.Ordinal))
                {
                    if (kv.Value == null) continue;
                    RequireKey(kv.Value, e.Name, kv.Key);
                    Collect(kv.Value, e.Name + "@" + kv.Key, false);
                    switch (kv.Key)
                    {
                        case "placeholder":
                            e.Attributes.RemoveAll(a => a.Key == ScreenBuilder.PlaceholderAttribute);
                            e.Bindings.Add(new CompiledBinding(PlaceholderProperty, collection, kv.Value.Key));
                            break;
                        case "title":
                            e.Attributes.RemoveAll(a => a.Key == "tooltip");
                            e.Bindings.Add(new CompiledBinding(TooltipProperty, collection, kv.Value.Key));
                            break;
                    }
                }
            }

            // the runtime binding's English (a translation that cannot be formatted falls back to it)
            if (compiled.Root.Tag == ScreenBuilder.ScreenTag) compiled.Root.Attributes.Add(new KeyValuePair<string, string>(SourceLocaleAttribute, english));

            return new StringTableRequest
            {
                Screen = compiled.ScreenId, Collection = collection, EnglishLocale = english, ReferenceLocale = reference, Format = settings.argumentFormat,
                Texts = texts, NewCollectionFolder = (settings.newCollectionFolder ?? "").Replace("{collection}", collection).Replace('\\', '/').TrimEnd('/'),
                PreloadNewTables = settings.preloadNewTables, NewTableLabels = (settings.newTableLabels ?? new string[0]).Where(l => !string.IsNullOrWhiteSpace(l)).Select(l => l.Trim()).ToArray(),
            };
        }

        /// <summary>The property a design text binds on an element of <paramref name="tag"/>, or null when it shows none.</summary>
        static string TextPropertyOf(string tag)
        {
            switch (tag)
            {
                case "ui:Label":
                case "ui:Button":
                case "ui:Toggle":
                    return TextProperty;
                case "ui:TextField":
                case "ui:DropdownField":
                    return ValueProperty;
                default:
                    return null;
            }
        }

        /// <summary>Removes the design's static text of an element: its text, a TextField's value, a DropdownField's choice.</summary>
        static void DropStatic(CompiledElement e)
        {
            e.Text = null;
            if (e.Tag == "ui:TextField") e.Attributes.RemoveAll(a => a.Key == "value");
            if (e.Tag == "ui:DropdownField") e.Attributes.RemoveAll(a => a.Key == "choices" || a.Key == "index");
        }

        static void RequireKey(IrText text, string element, string attribute)
        {
            if (!string.IsNullOrEmpty(text.Key)) return;
            throw new IrFormatException(attribute == null
                ? "'" + element + "' shows text without a localization key; give it data-l10n and data-en (or data-u-bind for a runtime value)"
                : "the " + attribute + " text of '" + element + "' has no localization key; give it data-l10n-" + attribute + " and data-en-" + attribute);
        }

        /// <summary>
        /// The text as the table stores it: Smart Strings keep <c>{name}</c>; the indexed format replaces each argument
        /// <c>{name}</c> with its index in <paramref name="args"/>.
        /// </summary>
        internal static string Format(string text, string[] args, DesignArgumentFormat format)
        {
            if (format != DesignArgumentFormat.Indexed || args.Length == 0 || text.IndexOf('{') < 0) return text;
            var sb = new StringBuilder(text.Length);
            int i = 0;
            while (i < text.Length)
            {
                if (text[i] == '{')
                {
                    int close = text.IndexOf('}', i + 1);
                    int arg = close < 0 ? -1 : Array.IndexOf(args, text.Substring(i + 1, close - i - 1));
                    if (arg >= 0)
                    {
                        sb.Append('{').Append(arg.ToString(System.Globalization.CultureInfo.InvariantCulture)).Append('}');
                        i = close + 1;
                        continue;
                    }
                }
                sb.Append(text[i]);
                i++;
            }
            return sb.ToString();
        }
    }
}
