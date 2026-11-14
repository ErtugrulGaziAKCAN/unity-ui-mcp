using System;
using System.Collections.Generic;
using System.Linq;

namespace DesignUi.Editor
{
    /// <summary>
    /// The profile's <see cref="DesignUiFontResolver"/> asset over the built-in resolver (<see cref="FontMap.ResolverFor"/>): the
    /// asset's answer when it gives a font, followed by TMP Settings' global fallbacks the way the built-in resolver adds them
    /// (unless the asset opts out), else the built-in answer. An exception from the asset becomes a
    /// <see cref="FontSetupException"/> that names the asset, its type and the locale.
    /// </summary>
    internal sealed class ProjectFontResolver : IFontResolver
    {
        readonly DesignUiFontResolver _asset;
        readonly IFontResolver _fallback;
        readonly IFontResolver _tmp;
        readonly SortedSet<string> _fellBack = new SortedSet<string>(StringComparer.Ordinal);

        /// <param name="fallback">Answers the locales the asset gives no font for (the built-in resolver).</param>
        /// <param name="tmp">TMP Settings' resolver: its answer's fallbacks are the global fallbacks that follow the asset's fonts.</param>
        public ProjectFontResolver(DesignUiFontResolver asset, IFontResolver fallback, IFontResolver tmp)
        {
            _asset = asset != null ? asset : throw new ArgumentNullException(nameof(asset));
            _fallback = fallback;
            _tmp = tmp;
        }

        /// <summary>The asset's name.</summary>
        public string Name => _asset.name;

        /// <summary>Locales the asset gave no font for (the built-in resolver answered), sorted.</summary>
        public IReadOnlyCollection<string> FallbackLocales => _fellBack;

        public ResolvedFont Resolve(string locale)
        {
            ResolvedFont font;
            bool globals;
            try
            {
                font = _asset.Resolve(locale);
                globals = font?.Primary != null && _asset.IncludeGlobalFallbacks;
            }
            catch (Exception e)
            {
                throw new FontSetupException("the font resolver '" + _asset.name + "' (" + _asset.GetType().FullName + ") failed for locale '" + locale + "': " +
                                             e.GetType().Name + ": " + e.Message);
            }
            if (font?.Primary == null)
            {
                _fellBack.Add(locale);
                return _fallback?.Resolve(locale);
            }
            if (!globals) return font;
            // TMP searches its global fallbacks after any font: the built-in resolver adds them to every locale, so does this one
            var all = (font.Fallbacks ?? new TMPro.TMP_FontAsset[0]).Concat(_tmp?.Resolve(locale)?.Fallbacks ?? new TMPro.TMP_FontAsset[0])
                .Where(f => f != null && f != font.Primary).Distinct().ToList();
            return new ResolvedFont { Primary = font.Primary, Fallbacks = all };
        }
    }
}
