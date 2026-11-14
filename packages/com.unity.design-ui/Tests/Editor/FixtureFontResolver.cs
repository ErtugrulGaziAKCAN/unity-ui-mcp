using System;
using UnityEngine;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// A project font resolver asset for tests: fixed TMP fonts per locale (null for any other locale), or an exception
    /// with <see cref="throwMessage"/> when it is set.
    /// </summary>
    public sealed class FixtureFontResolver : DesignUiFontResolver
    {
        public LocaleFont[] fonts = new LocaleFont[0];
        public string throwMessage;

        public override ResolvedFont Resolve(string locale)
        {
            if (!string.IsNullOrEmpty(throwMessage)) throw new InvalidOperationException(throwMessage);
            foreach (var f in fonts ?? new LocaleFont[0])
                if (f.font != null && string.Equals(f.locale, locale, StringComparison.OrdinalIgnoreCase)) return new ResolvedFont { Primary = f.font };
            return null;
        }
    }
}
