using System.Collections.Generic;
using NUnit.Framework;
using TMPro;
using UnityEditor;
using UnityEngine;

namespace DesignUi.Editor.Tests
{
    public class FontResolverTests
    {
        readonly List<Object> _objects = new List<Object>();

        [TearDown]
        public void Cleanup()
        {
            foreach (var o in _objects) if (o != null) Object.DestroyImmediate(o);
            _objects.Clear();
            FontFixture.Delete();
        }

        DesignUiProfile Profile(params LocaleFont[] fonts)
        {
            var p = ScriptableObject.CreateInstance<DesignUiProfile>();
            p.localeFonts = fonts;
            _objects.Add(p);
            return p;
        }

        /// <summary>An in-memory TMP Settings object with a default font asset and global fallbacks.</summary>
        TMP_Settings Settings(TMP_FontAsset defaultFont, params TMP_FontAsset[] fallbacks)
        {
            var s = ScriptableObject.CreateInstance<TMP_Settings>();
            _objects.Add(s);
            using (var so = new SerializedObject(s))
            {
                so.FindProperty("m_defaultFontAsset").objectReferenceValue = defaultFont;
                var list = so.FindProperty("m_fallbackFontAssets");
                list.arraySize = fallbacks.Length;
                for (int i = 0; i < fallbacks.Length; i++) list.GetArrayElementAtIndex(i).objectReferenceValue = fallbacks[i];
                so.ApplyModifiedPropertiesWithoutUndo();
            }
            return s;
        }

        [Test]
        public void TmpSettings_ResolvesTheDefaultFontAndItsGlobalFallbacksForEveryLocale()
        {
            var regular = FontFixture.CreateTmp(FontFixture.RegularTtf, "Resolver Default");
            var bold = FontFixture.CreateTmp(FontFixture.BoldTtf, "Resolver Global Fallback");
            var resolver = new TmpSettingsFontResolver(() => Settings(regular, bold, regular, null));
            foreach (var locale in new[] { "tr", "en", "ja" })
            {
                var r = resolver.Resolve(locale);
                Assert.AreSame(regular, r.Primary, locale);
                CollectionAssert.AreEqual(new[] { bold }, r.Fallbacks, "nulls and the primary itself are not fallbacks");
            }
        }

        [Test]
        public void TmpSettings_WithoutSettingsOrDefaultFont_ResolvesNothing()
        {
            Assert.IsNull(new TmpSettingsFontResolver(() => null).Resolve("tr"));
            Assert.IsNull(new TmpSettingsFontResolver(() => Settings(null)).Resolve("tr"));
        }

        [Test]
        public void ProfileLocale_ReturnsTheMappedFontForTr_AndTheTmpDefaultForAnUnmappedLocale()
        {
            var mapped = FontFixture.CreateTmp(FontFixture.RegularTtf, "Resolver Turkish");
            var tmpDefault = FontFixture.CreateTmp(FontFixture.BoldTtf, "Resolver Default");
            var global = FontFixture.CreateTmp(FontFixture.BoldTtf, "Resolver Global");
            var tmp = new TmpSettingsFontResolver(() => Settings(tmpDefault, global));
            var resolver = new ProfileLocaleFontResolver(Profile(new LocaleFont { locale = "tr", font = mapped }), tmp);

            var tr = resolver.Resolve("tr");
            Assert.AreSame(mapped, tr.Primary);
            CollectionAssert.AreEqual(new[] { global }, tr.Fallbacks, "TMP searches its global fallbacks after any font");

            var en = resolver.Resolve("en");
            Assert.AreSame(tmpDefault, en.Primary);
            CollectionAssert.AreEqual(new[] { global }, en.Fallbacks);
        }

        [Test]
        public void ProfileLocale_MatchesLocaleCodesIgnoringCase_AndSkipsEmptyEntries()
        {
            var mapped = FontFixture.CreateTmp(FontFixture.RegularTtf, "Resolver Mapped");
            var resolver = new ProfileLocaleFontResolver(Profile(
                new LocaleFont { locale = "tr", font = null },
                new LocaleFont { locale = "TR", font = mapped }), null);
            Assert.AreSame(mapped, resolver.Resolve("tr").Primary);
            Assert.IsNull(resolver.Resolve("en"), "no mapping and no fallback resolver");
        }

        [Test]
        public void SourceFontPath_IsTheTtfTheTmpAssetWasMadeFrom()
        {
            var tmp = FontFixture.CreateTmp(FontFixture.RegularTtf, "Resolver Source");
            Assert.AreEqual(FontFixture.RegularTtf, TmpSourceFont.GetSourceFontPath(tmp));
        }

        [Test]
        public void SourceFontPath_WithoutSourceGuid_Throws()
        {
            var tmp = FontFixture.CreateWithoutSource("Resolver No Source");
            var e = Assert.Throws<FontSetupException>(() => TmpSourceFont.GetSourceFontPath(tmp));
            StringAssert.Contains("Resolver No Source", e.Message);
        }
    }
}
