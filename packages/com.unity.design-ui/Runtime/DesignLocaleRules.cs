using System;
using UnityEngine;

namespace DesignUi
{
    /// <summary>How start-aligned text behaves in a right-to-left locale. The layout itself is never mirrored.</summary>
    public enum RtlTextAlignment
    {
        /// <summary>Left-aligned (start) text becomes right-aligned; centred and right-aligned text stay.</summary>
        StartToEnd,
        /// <summary>Left and right alignment swap; centred text stays.</summary>
        Mirror,
        /// <summary>Alignment stays as designed.</summary>
        Keep,
    }

    /// <summary>
    /// The project's locale rules for design screens (spec 13): which locales read right to left, which need the advanced
    /// text generator for shaping, and the RTL alignment rule. The DesignUiProfile holds them; a DesignUiPanelRegion added
    /// in the Editor copies them. A code matches an entry when it equals it or starts with it and a '-' or '_' (case
    /// ignored), so <c>ar</c> covers <c>ar-SA</c>; a code whose script subtag is a right-to-left script (<c>pa-Arab</c>)
    /// is right to left too.
    /// </summary>
    [Serializable]
    public sealed class DesignLocaleRules
    {
        static readonly string[] RtlScripts = { "arab", "hebr", "thaa", "syrc", "nkoo", "adlm", "rohg", "samr", "mand" };

        [Tooltip("Locales that read right to left: the screen root gets the 'rtl' class and an RTL language direction, start-aligned text follows the alignment rule, and their text uses the advanced text generator (bidirectional text, shaping).")]
        public string[] rightToLeft = { "ar", "fa", "he", "ur", "ps", "sd", "ug", "yi", "dv", "ckb", "syr" };

        [Tooltip("Left-to-right locales whose scripts need shaping (the advanced text generator): Brahmic and Southeast Asian scripts.")]
        public string[] complexScripts = { "th", "lo", "km", "my", "hi", "mr", "ne", "sa", "bn", "as", "pa", "gu", "or", "ta", "te", "kn", "ml", "si", "bo" };

        [Tooltip("What happens to start-aligned text in a right-to-left locale. The layout is never mirrored.")]
        public RtlTextAlignment rtlAlignment = RtlTextAlignment.StartToEnd;

        public bool IsRightToLeft(string code) => Matches(code, rightToLeft) || HasRtlScript(code);

        /// <summary>Whether text in <paramref name="code"/> needs the advanced text generator: right to left or a complex script.</summary>
        public bool NeedsShaping(string code) => IsRightToLeft(code) || Matches(code, complexScripts);

        public DesignLocaleRules Clone()
        {
            var c = (DesignLocaleRules)MemberwiseClone();
            c.rightToLeft = (string[])rightToLeft?.Clone();
            c.complexScripts = (string[])complexScripts?.Clone();
            return c;
        }

        static bool Matches(string code, string[] entries)
        {
            if (string.IsNullOrEmpty(code) || entries == null) return false;
            foreach (var raw in entries)
            {
                var entry = raw?.Trim();
                if (string.IsNullOrEmpty(entry) || code.Length < entry.Length) continue;
                if (string.Compare(code, 0, entry, 0, entry.Length, StringComparison.OrdinalIgnoreCase) != 0) continue;
                if (code.Length == entry.Length || code[entry.Length] == '-' || code[entry.Length] == '_') return true;
            }
            return false;
        }

        static bool HasRtlScript(string code)
        {
            if (string.IsNullOrEmpty(code)) return false;
            foreach (var part in code.Split('-', '_'))
                if (part.Length == 4)
                    foreach (var script in RtlScripts)
                        if (string.Equals(part, script, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }
    }
}
