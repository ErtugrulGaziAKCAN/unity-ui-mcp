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
        /// <summary>The package's minimal runtime theme (R31): no Unity default theme, functional defaults only.</summary>
        public const string RuntimeThemePath = "Packages/com.unity.design-ui/Runtime/Themes/DesignUiRuntimeTheme.tss";

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
        [Tooltip("Theme of the PanelSettings that render design screens, in the verifier and in game. Empty uses the package's DesignUiRuntimeTheme.")]
        public ThemeStyleSheet runtimeTheme;

        /// <summary>The theme for design-screen PanelSettings: <see cref="runtimeTheme"/>, or the package's runtime theme when empty.</summary>
        public ThemeStyleSheet RuntimeTheme => runtimeTheme != null ? runtimeTheme : LoadDefaultRuntimeTheme();

        public static ThemeStyleSheet LoadDefaultRuntimeTheme() => AssetDatabase.LoadAssetAtPath<ThemeStyleSheet>(RuntimeThemePath);

        void Reset()
        {
            runtimeTheme = LoadDefaultRuntimeTheme();
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
