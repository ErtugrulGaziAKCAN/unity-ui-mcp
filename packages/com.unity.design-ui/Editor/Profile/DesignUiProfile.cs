using System;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi.Editor
{
    /// <summary>
    /// A consuming project's Design UI settings (spec 16, 17): where designs and generated files live, the reference
    /// resolution and viewports, locales and their fonts, and the runtime theme design screens render with. Later tasks
    /// (fonts, localization, hosting) read the same asset, so every field is public and serialized.
    /// </summary>
    [CreateAssetMenu(fileName = "DesignUiProfile", menuName = "Design UI/Profile")]
    public sealed class DesignUiProfile : ScriptableObject
    {
        /// <summary>The package's minimal runtime theme: no Unity default theme, functional defaults only (spec 5.3).</summary>
        public const string RuntimeThemePath = "Packages/com.unity.design-ui/Runtime/Themes/DesignUiRuntimeTheme.tss";

        /// <summary>
        /// The package's PanelSettings for design screens, in the verifier and in game: the runtime theme, Scale With
        /// Screen Size at 2560×1440, match 0.5 (spec 12). Copy it with Object.Instantiate and set only what differs (for
        /// example the target texture); creating a PanelSettings without a theme makes the Editor write Unity's default
        /// runtime theme into the project.
        /// </summary>
        public const string PanelSettingsPath = "Packages/com.unity.design-ui/Runtime/Themes/DesignUiPanelSettings.asset";

        [Tooltip("Folder with the design sources, IR and goldens, one subfolder per screen id (outside the product repository by default).")]
        public string designRoot;
        [Tooltip("Design kit folder (tokens.css, fonts, text-styles.json). The compiler reads text-styles.json from the export folder first, then from here.")]
        public string kitDir;
        [Tooltip("Generated screens go to <outputFolder>/<Screen>/; DesignTokens.uss is shared in this folder.")]
        public string outputFolder = "Assets/UI/Generated";
        public string fontTwinFolder = "Assets/UI/Generated/Fonts";
        public string generatedNamespace = "DesignUi.Generated";
        public Vector2Int referenceResolution = new Vector2Int(2560, 1440);
        public Vector2Int[] viewports = { new Vector2Int(2560, 1440), new Vector2Int(1920, 1080), new Vector2Int(1280, 720) };
        [Range(0f, 1f)] public float screenMatch = 0.5f;
        public string referenceLocale = "tr";
        public string[] locales = new string[0];
        public LocaleFont[] localeFonts = new LocaleFont[0];
        public TextureImporterCompression textureCompression = TextureImporterCompression.Uncompressed;
        [Tooltip("PanelSettings that render design screens, in the verifier and in game. Empty uses the package's DesignUiPanelSettings (minimal runtime theme, 2560x1440 reference).")]
        public PanelSettings panelSettings;
        [Tooltip("How design screens sit in a uGUI shell (DesignUiPanelRegion): the panel's sort order and the screen's order on its panel. A region added in the Editor copies these values.")]
        public DesignUi.DesignUiHostSettings host = new DesignUi.DesignUiHostSettings();
        [Tooltip("Right-to-left and complex-script locales and the RTL alignment rule of design screens. The compiler writes the alignment rule into the screens' .rtl rules (recompile after changing it); the runtime LocaleFontController uses the locale lists. A region added in the Editor copies them.")]
        public DesignUi.DesignLocaleRules localeRules = new DesignUi.DesignLocaleRules();
        [Tooltip("The game's text-size steps (key and scale, matching its IDesignTextSizeSource). The compiler writes each step's rules (.text-size-<key> on the screen root) and scaled line-box twins, and reports a step that is not whole device pixels at a declared viewport.")]
        public DesignUi.DesignTextSize[] textSizes = new DesignUi.DesignTextSize[0];
        [Tooltip("Unity Localization: whether screens bind their texts to String Table entries, the collection of each screen, the argument format, and the rules for a collection the import creates. Off keeps static design text (fidelity samples only).")]
        public DesignLocalizationSettings localization = new DesignLocalizationSettings();

        /// <summary>PanelSettings for design screens: <see cref="panelSettings"/>, or the package's settings when empty.</summary>
        public PanelSettings DesignPanelSettings => panelSettings != null ? panelSettings : LoadDefaultPanelSettings();

        /// <summary>The theme of <see cref="DesignPanelSettings"/>.</summary>
        public ThemeStyleSheet RuntimeTheme => DesignPanelSettings != null ? DesignPanelSettings.themeStyleSheet : null;

        public static PanelSettings LoadDefaultPanelSettings() => AssetDatabase.LoadAssetAtPath<PanelSettings>(PanelSettingsPath);

        void Reset()
        {
            panelSettings = LoadDefaultPanelSettings();
            if (panelSettings != null) host.sortingOrder = panelSettings.sortingOrder; // a region keeps the asset's order until changed here
        }
    }

    /// <summary>The TMP font asset a locale renders with (its UI Toolkit twin is generated from it).</summary>
    [Serializable]
    public struct LocaleFont
    {
        public string locale;
        public TMP_FontAsset font;
    }
}
