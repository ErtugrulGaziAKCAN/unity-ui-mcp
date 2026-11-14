using System;
using System.Collections.Generic;

namespace DesignUi.Editor
{
    /// <summary>One localized text of a screen: its key, English source and reference-locale text (spec 13).</summary>
    public sealed class ScreenText
    {
        public string Key;
        /// <summary>English, as the String Table stores it (arguments already in the profile's format).</summary>
        public string En;
        /// <summary>The design's own text in the reference locale (the IR's <c>tr</c>), in the same format.</summary>
        public string Reference;
        /// <summary>The argument names in the order the generated view sets them (empty without arguments).</summary>
        public string[] Args = new string[0];
        /// <summary>Where the screen shows it, for reports: <c>element</c> or <c>element@attribute</c>.</summary>
        public readonly List<string> Places = new List<string>();
    }

    /// <summary>What the import writes into a screen's String Table collection.</summary>
    public sealed class StringTableRequest
    {
        public string Screen;
        public string Collection;
        public string EnglishLocale;
        public string ReferenceLocale;
        public DesignArgumentFormat Format;
        public IReadOnlyList<ScreenText> Texts = new ScreenText[0];
        /// <summary>The folder of a collection the import creates (pattern applied).</summary>
        public string NewCollectionFolder;
        public bool PreloadNewTables;
        public string[] NewTableLabels = new string[0];
    }

    /// <summary>A locale whose table lacks translations of the screen's keys. Fallback is not translation.</summary>
    public sealed class PendingTranslation
    {
        public string Locale;
        public readonly List<string> Keys = new List<string>();
        /// <summary>The locale's fallback chain reaches English, so the screen shows English for these keys meanwhile.</summary>
        public bool FallsBackToEnglish;
        /// <summary>The collection has no table for the locale (translators add it first).</summary>
        public bool NoTable;
    }

    /// <summary>What the import did in the String Tables.</summary>
    public sealed class LocalizationReport
    {
        public string Collection;
        public bool CreatedCollection;
        /// <summary>Entries written (<c>key (en, tr)</c>).</summary>
        public readonly List<string> Added = new List<string>();
        /// <summary>Keys whose English matches the table (left as they are).</summary>
        public readonly List<string> Reused = new List<string>();
        /// <summary>Keys the table holds with another value: reported, never overwritten.</summary>
        public readonly List<string> Conflicts = new List<string>();
        public readonly List<PendingTranslation> Pending = new List<PendingTranslation>();
        /// <summary>Entries the screen shows differently than the profile intends (e.g. a translation's Smart flag); nothing was changed.</summary>
        public readonly List<string> Warnings = new List<string>();
        /// <summary>Assets saved (asset-specific saves).</summary>
        public readonly List<string> Saved = new List<string>();
        public readonly List<string> Notes = new List<string>();

        /// <summary>Log lines for the import report.</summary>
        public IEnumerable<string> Lines()
        {
            yield return "localization: collection '" + Collection + "'" + (CreatedCollection ? " (created)" : "") + ": " + Added.Count + " written, " +
                         Reused.Count + " reused, " + Conflicts.Count + " conflicts";
            foreach (var a in Added) yield return "localization written: " + a;
            foreach (var c in Conflicts) yield return "localization conflict (not overwritten): " + c;
            foreach (var w in Warnings) yield return "localization warning: " + w;
            foreach (var p in Pending)
                yield return "translation pending: " + p.Locale + " (" + (p.NoTable ? "no table in collection '" + Collection + "'; " : "") +
                             p.Keys.Count + (p.Keys.Count == 1 ? " key" : " keys") + ": " + string.Join(", ", p.Keys) + ")" +
                             (p.FallsBackToEnglish ? "; shows English meanwhile" : "; its fallback does not reach English: add a Fallback Locale to it");
            foreach (var n in Notes) yield return "localization: " + n;
        }
    }

    /// <summary>
    /// The String Tables the import writes a screen's texts into (spec 13). Unity Localization's implementation lives in the
    /// optional DesignUi.Editor.Localization assembly (compiled when com.unity.localization 1.5 or newer is installed), which
    /// registers itself in <see cref="DesignStringTables.Current"/>.
    /// </summary>
    public interface IDesignStringTables
    {
        /// <summary>Why the request cannot be written, without writing anything (empty when it can).</summary>
        IReadOnlyList<string> Check(StringTableRequest request);

        /// <summary>
        /// Writes the request: new keys with their English and reference-locale entries; an existing key with the same English
        /// is reused untouched (a missing reference-locale entry is added); any different value is a conflict, reported and
        /// never overwritten, and nothing of that key is written. Other active locales without the keys are reported as
        /// pending, entries whose Smart flag differs from the profile's format as warnings. Only the touched assets are saved,
        /// each by itself; a step that can save the whole project (creating a collection) is refused while the project has
        /// unsaved work.
        /// </summary>
        LocalizationReport Write(StringTableRequest request);

        /// <summary>Every locale's non-empty texts of <paramref name="keys"/> in the collection, by locale code.</summary>
        IReadOnlyDictionary<string, IReadOnlyList<string>> Strings(string collection, IEnumerable<string> keys);
    }

    /// <summary>Where the compiler finds the String Tables.</summary>
    public static class DesignStringTables
    {
        /// <summary>Unity Localization's tables when the package is installed (registered on load), else null.</summary>
        public static IDesignStringTables Current { get; set; }
    }

    /// <summary>The localization binding of a compiled element: a property bound to a String Table entry.</summary>
    public readonly struct CompiledBinding
    {
        /// <summary>The bound property (<c>text</c>, <c>value</c>, <c>placeholderText</c>, <c>tooltip</c>).</summary>
        public readonly string Property;
        public readonly string Table;
        public readonly string Entry;

        public CompiledBinding(string property, string table, string entry)
        {
            Property = property ?? throw new ArgumentNullException(nameof(property));
            Table = table ?? throw new ArgumentNullException(nameof(table));
            Entry = entry ?? throw new ArgumentNullException(nameof(entry));
        }
    }
}
