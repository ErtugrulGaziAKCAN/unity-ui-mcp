using System;

namespace DesignUi
{
    /// <summary>
    /// The locale a design screen shows. Unity Localization's selected locale is the default source (the package's
    /// optional DesignUi.Runtime.Localization assembly, compiled when com.unity.localization 1.5 or newer is installed);
    /// a game without it, or with its own language setting, implements this.
    /// </summary>
    public interface IDesignLocaleSource
    {
        /// <summary>The locale code (<c>tr</c>, <c>ar-SA</c>, <c>zh-Hans</c>), or null while it is not known yet.</summary>
        string LocaleCode { get; }

        /// <summary>Raised with the new code when the locale changes.</summary>
        event Action<string> LocaleChanged;
    }

    /// <summary>Where a screen host gets its locale source when the game sets none.</summary>
    public static class DesignLocaleSources
    {
        /// <summary>
        /// Creates the default source, or null when there is none. The Unity Localization adapter registers itself here
        /// when the package is installed; a game can replace it.
        /// </summary>
        public static Func<IDesignLocaleSource> Default { get; set; }
    }
}
