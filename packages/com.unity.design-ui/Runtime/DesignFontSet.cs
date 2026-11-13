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

        /// <summary>The twins of <paramref name="locale"/>, else the reference locale's, else none.</summary>
        public IReadOnlyList<FontAsset> FontsFor(string locale)
        {
            LocaleFonts reference = null;
            foreach (var l in locales ?? new LocaleFonts[0])
            {
                if (l == null) continue;
                if (l.locale == locale) return l.fonts ?? new FontAsset[0];
                if (l.locale == referenceLocale) reference = l;
            }
            return reference?.fonts ?? new FontAsset[0];
        }

        /// <summary>The locale of the nearest element at or above <paramref name="element"/> that carries a locale class, or null.</summary>
        public static string LocaleOf(VisualElement element)
        {
            for (var e = element; e != null; e = e.hierarchy.parent)
                foreach (var c in e.GetClasses())
                    if (c.StartsWith(LocaleClassPrefix, StringComparison.Ordinal) && c.Length > LocaleClassPrefix.Length) return c.Substring(LocaleClassPrefix.Length);
            return null;
        }
    }
}
