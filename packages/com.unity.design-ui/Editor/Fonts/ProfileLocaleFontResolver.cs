using System;
using System.Linq;
using TMPro;

namespace DesignUi.Editor
{
    /// <summary>
    /// The profile's per-locale fonts (<see cref="DesignUiProfile.localeFonts"/>, spec 6 and 17) over another resolver: a
    /// mapped locale renders with its mapped font, followed by the other resolver's fallbacks (TMP searches its global
    /// fallbacks after any font); an unmapped locale gets the other resolver's answer. Locale codes match ignoring case.
    /// </summary>
    public sealed class ProfileLocaleFontResolver : IFontResolver
    {
        readonly DesignUiProfile _profile;
        readonly IFontResolver _fallback;

        public ProfileLocaleFontResolver(DesignUiProfile p, IFontResolver fallback)
        {
            _profile = p != null ? p : throw new ArgumentNullException(nameof(p));
            _fallback = fallback;
        }

        public ResolvedFont Resolve(string locale)
        {
            var fallback = _fallback?.Resolve(locale);
            var mapped = Mapped(locale);
            if (mapped == null) return fallback;
            var globals = (fallback?.Fallbacks ?? new TMP_FontAsset[0]).Where(f => f != null && f != mapped).ToList();
            return new ResolvedFont { Primary = mapped, Fallbacks = globals };
        }

        TMP_FontAsset Mapped(string locale)
        {
            if (_profile.localeFonts == null || string.IsNullOrEmpty(locale)) return null;
            foreach (var entry in _profile.localeFonts)
                if (entry.font != null && string.Equals((entry.locale ?? "").Trim(), locale.Trim(), StringComparison.OrdinalIgnoreCase))
                    return entry.font;
            return null;
        }
    }
}
