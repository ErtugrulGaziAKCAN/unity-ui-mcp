using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;

namespace DesignUi
{
    /// <summary>
    /// The font twins of the design screens per locale (written by the compiler next to <c>DesignFonts.uss</c> as
    /// <c>DesignFonts.asset</c>): each locale's primary twin and its line-box variants. <see cref="DesignText"/> prepares a
    /// bound text in these fonts before it is assigned, without waiting for the element's styles to resolve.
    /// <para>It also lists every line-box variant of those fonts (their fallbacks' and weight faces' included) with the twin
    /// it shares its glyphs with (<see cref="FontTwinLink"/>) and links them when it is loaded: a compiled screen's UXML
    /// references its font set, so its fonts are linked before any of its text is laid out.</para>
    /// </summary>
    public sealed class DesignFontSet : ScriptableObject
    {
        /// <summary>The class a compiled screen root carries for the locale it shows: <c>locale-&lt;code&gt;</c>.</summary>
        public const string LocaleClassPrefix = "locale-";
        public const string FileName = "DesignFonts.asset";

        [Serializable]
        public sealed class LocaleFonts
        {
            public string locale;
            public FontAsset[] fonts = new FontAsset[0];
        }

        public string referenceLocale;
        public LocaleFonts[] locales = new LocaleFonts[0];

        /// <summary>A line-box variant and the twin whose glyphs it shares.</summary>
        [Serializable]
        public sealed class TwinLink
        {
            public FontAsset variant;
            public FontAsset source;
        }

        /// <summary>Every line-box variant of the set's fonts with the twin it shares its glyphs with (written by the compiler).</summary>
        public TwinLink[] links = new TwinLink[0];

        void OnEnable()
        {
            try { LinkTwins(); }
            catch (Exception e) { Debug.LogException(e, this); } // a font set that cannot link still loads; its variants add their own glyphs
        }

        /// <summary>
        /// Links every variant of <see cref="links"/> to its twin (<see cref="FontTwinLink.Link(FontAsset, FontAsset)"/>); a
        /// variant already linked to a twin that gained nothing since costs a few comparisons. Returns how many it linked.
        /// </summary>
        public int LinkTwins()
        {
            int n = 0;
            var all = links ?? new TwinLink[0];
            for (int i = 0; i < all.Length; i++)
                if (all[i] != null && FontTwinLink.Link(all[i].variant, all[i].source)) n++;
            return n;
        }

        /// <summary>
        /// The text-size steps the compiled screens have rules for (the profile's, when the set was written); empty when the
        /// profile declares none. The locale controller reports a game text size that is not one of them.
        /// </summary>
        public DesignTextSize[] textSizes = new DesignTextSize[0];

        static readonly FontAsset[] None = new FontAsset[0];

        /// <summary>The twins of <paramref name="locale"/>, else the reference locale's, else none. Allocates nothing.</summary>
        public IReadOnlyList<FontAsset> FontsFor(string locale)
        {
            LocaleFonts reference = null;
            var all = locales ?? new LocaleFonts[0];
            for (int i = 0; i < all.Length; i++)
            {
                var l = all[i];
                if (l == null) continue;
                if (l.locale == locale) return l.fonts ?? None;
                if (l.locale == referenceLocale) reference = l;
            }
            return reference?.fonts ?? None;
        }

        /// <summary>The locale of the nearest element at or above <paramref name="element"/> that carries a locale class, or null.</summary>
        public static string LocaleOf(VisualElement element)
        {
            for (var e = element; e != null; e = e.hierarchy.parent)
                foreach (var c in e.GetClasses())
                    if (c.StartsWith(LocaleClassPrefix, StringComparison.Ordinal) && c.Length > LocaleClassPrefix.Length) return c.Substring(LocaleClassPrefix.Length);
            return null;
        }

        /// <summary>The compiled step for a text-size key, or null.</summary>
        public DesignTextSize TextSizeFor(string key)
        {
            if (textSizes == null || key == null) return null;
            foreach (var s in textSizes)
                if (s != null && s.key == key) return s;
            return null;
        }
    }
}
