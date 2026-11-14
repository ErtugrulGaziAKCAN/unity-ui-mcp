using System;
using System.Collections.Generic;

namespace DesignUi.Editor
{
    /// <summary>
    /// The profile's <see cref="DesignUiFontResolver"/> asset over the built-in resolver (<see cref="FontMap.ResolverFor"/>): the
    /// asset's answer when it gives a font, else the built-in one. An exception from the asset becomes a
    /// <see cref="FontSetupException"/> that names the asset, its type and the locale.
    /// </summary>
    internal sealed class ProjectFontResolver : IFontResolver
    {
        readonly DesignUiFontResolver _asset;
        readonly IFontResolver _fallback;
        readonly SortedSet<string> _fellBack = new SortedSet<string>(StringComparer.Ordinal);

        public ProjectFontResolver(DesignUiFontResolver asset, IFontResolver fallback)
        {
            _asset = asset != null ? asset : throw new ArgumentNullException(nameof(asset));
            _fallback = fallback;
        }

        /// <summary>The asset's name.</summary>
        public string Name => _asset.name;

        /// <summary>Locales the asset gave no font for (the built-in resolver answered), sorted.</summary>
        public IReadOnlyCollection<string> FallbackLocales => _fellBack;

        public ResolvedFont Resolve(string locale)
        {
            ResolvedFont font;
            try { font = _asset.Resolve(locale); }
            catch (Exception e)
            {
                throw new FontSetupException("the font resolver '" + _asset.name + "' (" + _asset.GetType().FullName + ") failed for locale '" + locale + "': " +
                                             e.GetType().Name + ": " + e.Message);
            }
            if (font?.Primary != null) return font;
            _fellBack.Add(locale);
            return _fallback?.Resolve(locale);
        }
    }
}
