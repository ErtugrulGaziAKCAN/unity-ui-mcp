using System.Collections.Generic;
using NUnit.Framework;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.TextCore;
using UnityEngine.TextCore.LowLevel;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// TMP font assets made in the test from the Inter TTFs of the fidelity project (OFL), and a shared pair (Regular with
    /// the Bold face in its weight table) for tests that only need a working font setup. Everything lives under
    /// <see cref="Folder"/>; <see cref="Delete"/> removes it.
    /// </summary>
    internal static class FontFixture
    {
        public const string Folder = "Assets/DesignUiFontFixture";
        public const string TwinFolder = Folder + "/Twins";
        public const string RegularTtf = "Assets/Fonts/Inter/Inter_18pt-Regular.ttf";
        public const string BoldTtf = "Assets/Fonts/Inter/Inter_18pt-Bold.ttf";
        public const string Licence = "Assets/Fonts/Inter/OFL.txt";

        public const string SharedFamily = "Inter";

        static TMP_FontAsset s_Regular, s_Bold;

        /// <summary>
        /// The shared Regular fixture (weight table 700 = <see cref="Bold"/>), created on first use. Its TMP family is
        /// "Inter", the family the test screens name (the TTF's own family name is "Inter 18pt").
        /// </summary>
        public static TMP_FontAsset Regular
        {
            get { EnsureShared(); return s_Regular; }
        }

        public static TMP_FontAsset Bold
        {
            get { EnsureShared(); return s_Bold; }
        }

        /// <summary>Maps the profile's reference locale to the shared Regular fixture; twins go to <see cref="TwinFolder"/>.</summary>
        public static void Use(DesignUiProfile profile)
        {
            profile.localeFonts = new[] { new LocaleFont { locale = profile.referenceLocale, font = Regular } };
            profile.fontTwinFolder = TwinFolder;
        }

        public static void RequireInter()
        {
            if (AssetDatabase.LoadAssetAtPath<Font>(RegularTtf) == null || AssetDatabase.LoadAssetAtPath<Font>(BoldTtf) == null)
                Assert.Ignore("needs the Inter fonts of samples/FidelityProject (" + RegularTtf + ", " + BoldTtf + ")");
        }

        /// <summary>
        /// A dynamic TMP font asset made from a TTF the way TMP's Font Asset Creator does (face info from the font engine,
        /// source font GUID, atlas settings), without atlas texture and material: the test project has no TMP Essential
        /// Resources (no TMP shaders), and nothing here renders TMP text. <paramref name="family"/> renames the TMP face's
        /// family (the fixture has one font family only; kit tests need several).
        /// </summary>
        public static TMP_FontAsset CreateTmp(string ttf, string name, int pointSize = 72, int padding = 7, int atlas = 1024, string family = null)
        {
            RequireInter();
            EnsureFolder(Folder);
            var font = AssetDatabase.LoadAssetAtPath<Font>(ttf);
            FontEngine.InitializeFontEngine();
            Assert.AreEqual(FontEngineError.Success, FontEngine.LoadFontFace(font, pointSize), "load " + ttf);
            var tmp = ScriptableObject.CreateInstance<TMP_FontAsset>();
            tmp.name = name;
            var face = FontEngine.GetFaceInfo();
            if (family != null) face.familyName = family;
            tmp.faceInfo = face;
            var path = Folder + "/" + name + ".asset";
            AssetDatabase.CreateAsset(tmp, path);
            using (var so = new SerializedObject(tmp))
            {
                so.FindProperty("m_SourceFontFileGUID").stringValue = AssetDatabase.AssetPathToGUID(ttf);
                so.FindProperty("m_SourceFontFile").objectReferenceValue = font;
                so.FindProperty("m_AtlasPopulationMode").intValue = (int)TMPro.AtlasPopulationMode.Dynamic;
                so.FindProperty("m_AtlasWidth").intValue = atlas;
                so.FindProperty("m_AtlasHeight").intValue = atlas;
                so.FindProperty("m_AtlasPadding").intValue = padding;
                so.FindProperty("m_AtlasRenderMode").intValue = (int)GlyphRenderMode.SDFAA;
                so.FindProperty("m_IsMultiAtlasTexturesEnabled").boolValue = true;
                so.ApplyModifiedPropertiesWithoutUndo();
            }
            Save(tmp);
            return tmp;
        }

        /// <summary>A TMP font asset whose source font GUID is empty (as a static atlas-only asset can be).</summary>
        public static TMP_FontAsset CreateWithoutSource(string name)
        {
            EnsureFolder(Folder);
            var tmp = ScriptableObject.CreateInstance<TMP_FontAsset>();
            tmp.name = name;
            tmp.faceInfo = new FaceInfo { familyName = "Nameless", pointSize = 72, lineHeight = 80, ascentLine = 60, descentLine = -20 };
            AssetDatabase.CreateAsset(tmp, Folder + "/" + name + ".asset");
            return tmp;
        }

        public static void SetFallbacks(TMP_FontAsset tmp, params TMP_FontAsset[] fallbacks)
        {
            tmp.fallbackFontAssetTable = new List<TMP_FontAsset>(fallbacks);
            Save(tmp);
        }

        public static void SetWeight(TMP_FontAsset tmp, int weight, TMP_FontAsset face)
        {
            tmp.fontWeightTable[weight / 100].regularTypeface = face;
            Save(tmp);
        }

        public static void Save(Object asset)
        {
            EditorUtility.SetDirty(asset);
            AssetDatabase.SaveAssetIfDirty(asset);
        }

        public static void Delete()
        {
            if (AssetDatabase.IsValidFolder(Folder)) AssetDatabase.DeleteAsset(Folder);
            s_Regular = null;
            s_Bold = null;
        }

        static void EnsureShared()
        {
            if (s_Regular != null && s_Bold != null) return;
            foreach (var name in new[] { "Inter Fixture", "Inter Fixture Bold" }) AssetDatabase.DeleteAsset(Folder + "/" + name + ".asset");
            s_Bold = CreateTmp(BoldTtf, "Inter Fixture Bold", family: SharedFamily);
            s_Regular = CreateTmp(RegularTtf, "Inter Fixture", family: SharedFamily);
            SetWeight(s_Regular, 700, s_Bold);
        }

        static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var slash = folder.LastIndexOf('/');
            EnsureFolder(folder.Substring(0, slash));
            AssetDatabase.CreateFolder(folder.Substring(0, slash), folder.Substring(slash + 1));
        }
    }
}
