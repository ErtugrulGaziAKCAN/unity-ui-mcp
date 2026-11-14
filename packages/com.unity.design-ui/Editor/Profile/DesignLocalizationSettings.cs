using System;
using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>How a text with arguments is written into the String Tables (spec 13).</summary>
    public enum DesignArgumentFormat
    {
        /// <summary>Smart Strings: <c>{amount}</c> by name, the entry marked Smart.</summary>
        SmartString,
        /// <summary>Plain <c>string.Format</c> placeholders: <c>{0}</c>, <c>{1}</c> in the order of the design's arguments.</summary>
        Indexed,
    }

    /// <summary>The String Table collection of one screen.</summary>
    [Serializable]
    public struct DesignScreenTable
    {
        [Tooltip("Screen id (data-u-screen), e.g. club.overview.")]
        public string screen;
        [Tooltip("String Table collection name.")]
        public string collection;
    }

    /// <summary>
    /// The profile's localization adapter (spec 13, 16): whether screens bind their texts to Unity Localization String Tables,
    /// which collection each screen uses, how arguments are written, and the rules for a collection the import creates.
    /// </summary>
    [Serializable]
    public sealed class DesignLocalizationSettings
    {
        [Tooltip("Bind texts to String Table entries (Unity Localization 1.5+) and write the design's English and reference-locale texts into the screen's collection. Off: texts are static design text (only for fidelity samples).")]
        public bool enabled;

        [Tooltip("Locale code of English, the source and fallback language (e.g. en).")]
        public string englishLocale = "en";

        [Tooltip("How texts with arguments are written: Smart Strings ({amount}) or plain string.Format placeholders ({0}).")]
        public DesignArgumentFormat argumentFormat = DesignArgumentFormat.SmartString;

        [Tooltip("The collection of each screen. A screen not listed uses the default collection.")]
        public DesignScreenTable[] screenTables = new DesignScreenTable[0];

        [Tooltip("Collection of screens not listed above: a name, or a pattern with {Screen} (PascalCase screen id, ClubOverview) or {screen} (the id). Empty: every screen must be listed.")]
        public string defaultCollection = "";

        [Tooltip("Folder of a collection the import creates; {collection} is its name.")]
        public string newCollectionFolder = "Assets/Localization/{collection}";

        [Tooltip("Mark the tables of a collection the import creates for preloading (Unity Localization's Preload label).")]
        public bool preloadNewTables;

        [Tooltip("Extra Addressables labels for the tables of a collection the import creates. Their addresses stay Unity Localization's own (<collection>_<locale>), which it loads them by.")]
        public string[] newTableLabels = new string[0];

        /// <summary>
        /// The collection of <paramref name="screenId"/>: its entry, else the default (pattern applied), else null.
        /// </summary>
        public string CollectionFor(string screenId)
        {
            foreach (var t in screenTables ?? new DesignScreenTable[0])
                if (string.Equals(t.screen, screenId, StringComparison.Ordinal) && !string.IsNullOrWhiteSpace(t.collection)) return t.collection.Trim();
            if (string.IsNullOrWhiteSpace(defaultCollection)) return null;
            return defaultCollection.Trim().Replace("{Screen}", Naming.Pascal(screenId, "screen id")).Replace("{screen}", screenId);
        }
    }
}
