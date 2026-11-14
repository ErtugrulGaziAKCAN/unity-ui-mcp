using UnityEngine;

namespace DesignUi.Editor
{
    /// <summary>
    /// Base class of a project's font resolver (spec 6): an Editor-side asset that answers which TMP font renders each locale
    /// from the project's own font system. A project derives from it in one of its Editor assemblies (one that may reference
    /// that font system), creates an asset and sets it as the profile's <see cref="DesignUiProfile.fontResolver"/>. Kit sync,
    /// the compile and the Design UI window then use it; a locale it gives no font for (null) falls back to the profile's
    /// <see cref="DesignUiProfile.localeFonts"/> over TMP Settings. Runtime needs nothing: the compiled
    /// <see cref="DesignUi.DesignFontSet"/> carries the result.
    /// </summary>
    public abstract class DesignUiFontResolver : ScriptableObject, IFontResolver
    {
        /// <summary>The locale's font, or null when the project's font system has none for it (the profile's mapping answers then).</summary>
        public abstract ResolvedFont Resolve(string locale);
    }
}
