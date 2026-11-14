using System;
using System.Collections.Generic;
using TMPro;

namespace DesignUi.Editor
{
    /// <summary>
    /// The TMP font asset that renders a locale (spec 6): <see cref="Primary"/>, and <see cref="Fallbacks"/>, the font
    /// assets TMP searches after the primary and its own fallback list (TMP Settings' global fallbacks).
    /// </summary>
    public sealed class ResolvedFont
    {
        public TMP_FontAsset Primary;
        public IReadOnlyList<TMP_FontAsset> Fallbacks = new TMP_FontAsset[0];
    }

    /// <summary>
    /// Answers "which TMP font asset renders locale X" (spec 6). The Unity project is the source of truth for fonts: the
    /// kit, the font twins and the per-locale font variables are all derived from the answer.
    /// </summary>
    public interface IFontResolver
    {
        /// <summary>The locale's font, or null when the resolver knows no font for it.</summary>
        ResolvedFont Resolve(string locale);
    }

    /// <summary>A font setup the pipeline cannot use (no source font file, a twin folder outside Assets/, …); the message names the fix.</summary>
    public sealed class FontSetupException : Exception
    {
        public FontSetupException(string message) : base(message) { }
    }
}
