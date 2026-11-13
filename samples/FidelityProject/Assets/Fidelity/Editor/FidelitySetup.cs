using System;
using System.IO;
using DesignUi.Editor;
using NUnit.Framework;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.TextCore.LowLevel;
using UnityEngine.UIElements;

namespace FidelityProject
{
    /// <summary>
    /// The fidelity suite's setup of this sample project (<c>scripts/fidelity.sh</c> runs it in a copy of the project, never
    /// in an open Editor): TMP font assets "Inter UI" (Regular, with Bold as its 700 face) from <c>Assets/Fonts/Inter</c>, a
    /// DesignUiProfile for them, and a kit sync into the run's kit folder, so the exporter and the compiler use the same
    /// fonts. Everything goes below <c>$DESIGN_UI_FIDELITY_ROOT</c> (an Assets/… folder): <c>DesignUiProfile.asset</c>,
    /// <c>Fonts/</c>, the font twins in <c>Fonts/Twins/</c> and the compiled screens in <c>Generated/</c>. Without that
    /// variable the test passes without doing anything ("not configured").
    /// <para>
    /// Measurement knobs (all optional; each variant needs its own root): <c>DESIGN_UI_FIDELITY_RENDER_MODE</c> (a
    /// <see cref="GlyphRenderMode"/> name, default SDFAA), <c>DESIGN_UI_FIDELITY_POINT_SIZE</c> (atlas sampling size,
    /// default 72), <c>DESIGN_UI_FIDELITY_PADDING</c> (default 7) and <c>DESIGN_UI_FIDELITY_TEXT_GENERATOR</c>
    /// (<c>advanced</c>: the profile renders with a PanelSettings copy whose theme sets <c>-unity-text-generator: advanced</c>
    /// on the panel root).
    /// </para>
    /// </summary>
    public class FidelitySetup
    {
        const string Family = "Inter UI";
        const string RegularTtf = "Assets/Fonts/Inter/Inter_18pt-Regular.ttf";
        const string BoldTtf = "Assets/Fonts/Inter/Inter_18pt-Bold.ttf";
        const string Locale = "tr";

        static string Env(string name)
        {
            var v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? null : v;
        }

        [Test]
        public void SetupFromEnv()
        {
            var root = Env("DESIGN_UI_FIDELITY_ROOT");
            if (root == null) Assert.Pass("not configured; nothing set up (set DESIGN_UI_FIDELITY_ROOT and DESIGN_UI_KIT_DIR)");
            root = root.Replace('\\', '/').TrimEnd('/');
            Assert.IsTrue(root.StartsWith("Assets/", StringComparison.Ordinal), "DESIGN_UI_FIDELITY_ROOT is an Assets/… folder: " + root);
            var kit = Env("DESIGN_UI_KIT_DIR");
            Assert.IsNotNull(kit, "DESIGN_UI_KIT_DIR names the kit folder the fonts are synced into");

            var mode = Env("DESIGN_UI_FIDELITY_RENDER_MODE") ?? nameof(GlyphRenderMode.SDFAA);
            Assert.IsTrue(Enum.TryParse(mode, out GlyphRenderMode renderMode), "DESIGN_UI_FIDELITY_RENDER_MODE: no GlyphRenderMode '" + mode + "'");
            int pointSize = int.Parse(Env("DESIGN_UI_FIDELITY_POINT_SIZE") ?? "72");
            int padding = int.Parse(Env("DESIGN_UI_FIDELITY_PADDING") ?? "7");

            Folder(root + "/Fonts");
            var bold = Tmp(BoldTtf, root + "/Fonts/" + Family + " Bold.asset", renderMode, pointSize, padding);
            var regular = Tmp(RegularTtf, root + "/Fonts/" + Family + ".asset", renderMode, pointSize, padding);
            if (regular.fontWeightTable[7].regularTypeface != bold)
            {
                regular.fontWeightTable[7].regularTypeface = bold;
                Save(regular);
            }

            var path = root + "/DesignUiProfile.asset";
            var profile = AssetDatabase.LoadAssetAtPath<DesignUiProfile>(path);
            if (profile == null)
            {
                profile = ScriptableObject.CreateInstance<DesignUiProfile>();
                AssetDatabase.CreateAsset(profile, path);
            }
            profile.outputFolder = root + "/Generated";
            profile.fontTwinFolder = root + "/Fonts/Twins";
            // a namespace per root: the view classes of another root's (or another profile's) screens of the same name never
            // collide with these in the project's assembly
            profile.generatedNamespace = "FidelityProject." + Identifier(root.Substring(root.LastIndexOf('/') + 1));
            profile.kitDir = kit;
            profile.referenceLocale = Locale;
            profile.locales = new[] { Locale };
            profile.localeFonts = new[] { new LocaleFont { locale = Locale, font = regular } };
            profile.panelSettings = PanelSettingsFor(root, Env("DESIGN_UI_FIDELITY_TEXT_GENERATOR"));
            Save(profile);

            var r = DesignUiOps.KitSync(path, kit);
            Debug.Log("Fidelity setup: " + path + " (" + renderMode + ", " + pointSize + "/" + padding + ", text generator " +
                      (Env("DESIGN_UI_FIDELITY_TEXT_GENERATOR") ?? "standard") + ")\nKit sync (code " + r.Code + "):\n" + r.Log);
            Assert.AreEqual(0, r.Code, r.Log);
        }

        /// <summary>The package's design PanelSettings, or a copy whose theme also sets the text generator on the panel root.</summary>
        static PanelSettings PanelSettingsFor(string root, string generator)
        {
            var shipped = DesignUiProfile.LoadDefaultPanelSettings();
            Assert.IsNotNull(shipped, "the package's DesignUiPanelSettings");
            if (generator == null) return shipped;
            Assert.AreEqual("advanced", generator, "DESIGN_UI_FIDELITY_TEXT_GENERATOR is 'advanced' or unset");
            var tss = root + "/TextGenerator.tss";
            File.WriteAllText(tss, "@import url(\"project://database/" + DesignUiProfile.RuntimeThemePath + "\");\n:root { -unity-text-generator: " + generator + "; }\n");
            AssetDatabase.ImportAsset(tss, ImportAssetOptions.ForceUpdate);
            var theme = AssetDatabase.LoadAssetAtPath<ThemeStyleSheet>(tss);
            Assert.IsNotNull(theme, tss);
            var path = root + "/TextGenerator PanelSettings.asset";
            var copy = AssetDatabase.LoadAssetAtPath<PanelSettings>(path);
            if (copy == null)
            {
                copy = UnityEngine.Object.Instantiate(shipped);
                AssetDatabase.CreateAsset(copy, path);
            }
            copy.themeStyleSheet = theme;
            Save(copy);
            return copy;
        }

        /// <summary>A dynamic TMP font asset made from a TTF as TMP's Font Asset Creator makes it, its settings applied on every run.</summary>
        static TMP_FontAsset Tmp(string ttf, string path, GlyphRenderMode renderMode, int pointSize, int padding)
        {
            var font = AssetDatabase.LoadAssetAtPath<Font>(ttf);
            Assert.IsNotNull(font, ttf);
            var tmp = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(path);
            FontEngine.InitializeFontEngine();
            Assert.AreEqual(FontEngineError.Success, FontEngine.LoadFontFace(font, pointSize), "load " + ttf);
            var face = FontEngine.GetFaceInfo();
            face.familyName = Family;
            if (tmp == null)
            {
                tmp = ScriptableObject.CreateInstance<TMP_FontAsset>();
                tmp.name = Path.GetFileNameWithoutExtension(path);
                tmp.faceInfo = face;
                AssetDatabase.CreateAsset(tmp, path);
            }
            else tmp.faceInfo = face;
            using (var so = new SerializedObject(tmp))
            {
                so.FindProperty("m_SourceFontFileGUID").stringValue = AssetDatabase.AssetPathToGUID(ttf);
                so.FindProperty("m_SourceFontFile").objectReferenceValue = font;
                so.FindProperty("m_AtlasPopulationMode").intValue = (int)AtlasPopulationMode.Dynamic;
                so.FindProperty("m_AtlasWidth").intValue = 1024;
                so.FindProperty("m_AtlasHeight").intValue = 1024;
                so.FindProperty("m_AtlasPadding").intValue = padding;
                so.FindProperty("m_AtlasRenderMode").intValue = (int)renderMode;
                so.FindProperty("m_IsMultiAtlasTexturesEnabled").boolValue = true;
                so.ApplyModifiedPropertiesWithoutUndo();
            }
            Save(tmp);
            return tmp;
        }

        static string Identifier(string folder)
        {
            var chars = folder.ToCharArray();
            for (int i = 0; i < chars.Length; i++) if (!char.IsLetterOrDigit(chars[i]) && chars[i] != '_') chars[i] = '_';
            var id = new string(chars);
            return id.Length == 0 || char.IsDigit(id[0]) ? "_" + id : id;
        }

        static void Save(UnityEngine.Object o)
        {
            EditorUtility.SetDirty(o);
            AssetDatabase.SaveAssetIfDirty(o);
        }

        static void Folder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var slash = folder.LastIndexOf('/');
            Folder(folder.Substring(0, slash));
            AssetDatabase.CreateFolder(folder.Substring(0, slash), folder.Substring(slash + 1));
        }
    }
}
