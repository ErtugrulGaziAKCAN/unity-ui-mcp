using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.TextCore.LowLevel;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The kerning of a twin whose glyphs arrive in several batches (import pre-adds of different screens, runtime text):
    /// it holds the same pairs as a twin that got the word in one batch, and a letter-spaced word is as wide as in Chromium.
    /// </summary>
    public class KerningBatchTests
    {
        const string Word = "Transfer dönemi";

        /// <summary>
        /// Chromium's width of <see cref="Word"/> in Inter 18pt Bold at 36 px (Chrome Headless Shell 158, a Range's width), plain
        /// and with letter-spacing -0.72px (which includes the spacing after the last character).
        /// </summary>
        const double ChromiumPlain = 285.234, ChromiumTracked = 274.438, Tracking = -0.72;

        readonly List<Object> _objects = new List<Object>();

        [TearDown]
        public void Cleanup()
        {
            foreach (var o in _objects) if (o != null) Object.DestroyImmediate(o);
            _objects.Clear();
            FontFixture.Delete();
        }

        static List<GlyphPairAdjustmentRecord> Records(FontAsset f) =>
            (List<GlyphPairAdjustmentRecord>)f.fontFeatureTable.GetType().GetProperty("glyphPairAdjustmentRecords", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)
                .GetValue(f.fontFeatureTable);

        /// <summary>
        /// The pairs among the word's glyphs, with their adjustments and whether they drop letter-spacing (runtime text may add
        /// other glyphs too, such as the ellipsis, whose pairs are not compared).
        /// </summary>
        static SortedSet<string> PairsAmongGlyphs(FontAsset f)
        {
            var present = new HashSet<uint>(Word.Where(c => f.characterLookupTable.ContainsKey(c)).Select(c => f.characterLookupTable[c].glyphIndex));
            Assert.AreEqual(Word.Distinct().Count(), present.Count, "every character of the word is in the twin");
            return new SortedSet<string>(Records(f)
                .Where(r => present.Contains(r.firstAdjustmentRecord.glyphIndex) && present.Contains(r.secondAdjustmentRecord.glyphIndex))
                .Select(r => r.firstAdjustmentRecord.glyphIndex + "-" + r.secondAdjustmentRecord.glyphIndex + " " + r.firstAdjustmentRecord.glyphValueRecord.xAdvance.ToString("0.###") +
                             "/" + r.secondAdjustmentRecord.glyphValueRecord.xPlacement.ToString("0.###") +
                             ((r.featureLookupFlags & FontFeatureLookupFlags.IgnoreSpacingAdjustments) != 0 ? " no-spacing" : "")), StringComparer.Ordinal);
        }

        static FontAsset Twin(string name) => FontTwinGenerator.GetOrCreateTwin(FontFixture.CreateTmp(FontFixture.BoldTtf, name), FontFixture.TwinFolder);

        [Test]
        public void GlyphsAddedInBatches_HaveThePairsOfOneBatch_AndNoneDropsLetterSpacing()
        {
            var one = Twin("Kern One Batch");
            var many = Twin("Kern Many Batches");
            DesignText.Prepare(one, Word);
            foreach (var batch in new[] { "T", "r", "ansfe", " ", "dönemi" }) DesignText.Prepare(many, batch);
            var a = PairsAmongGlyphs(one);
            var b = PairsAmongGlyphs(many);
            Assert.That(a.Count, Is.GreaterThan(2), "the word has kerning pairs (Tr, ra, fe)");
            CollectionAssert.AreEqual(a, b, "pairs of the batched twin\n  only in one batch: " + string.Join(", ", a.Except(b)) + "\n  only in batches: " + string.Join(", ", b.Except(a)));
            CollectionAssert.IsEmpty(a.Where(p => p.EndsWith("no-spacing", StringComparison.Ordinal)),
                "Chromium adds letter-spacing between every two characters, kerned or not");
        }

        /// <summary>
        /// Glyphs that runtime text adds (a label laid out before any pre-add: TextCore adds the glyphs and, later, their
        /// pairs) and glyphs pre-added afterwards: the same pairs as one batch, none dropping letter-spacing.
        /// </summary>
        [UnityTest]
        public IEnumerator GlyphsAddedByRuntimeText_ThenPreAdded_HaveThePairsOfOneBatch()
        {
            var one = Twin("Kern Runtime One");
            var mixed = Twin("Kern Runtime Mixed");
            DesignText.Prepare(one, Word);
            var root = Panel();
            yield return null;
            foreach (var runtime in new[] { "Tr", "ns" })
            {
                var l = new Label(runtime);
                l.style.fontSize = 36;
                l.style.unityFontDefinition = FontDefinition.FromSDFFont(mixed);
                root.Add(l);
                for (int i = 0; i < 4; i++) { l.MarkDirtyRepaint(); yield return null; }
            }
            DesignText.Prepare(mixed, "afe dönemi");
            for (int i = 0; i < 4; i++) yield return null;
            var a = PairsAmongGlyphs(one);
            var b = PairsAmongGlyphs(mixed);
            CollectionAssert.AreEqual(a, b, "only in one batch: " + string.Join(", ", a.Except(b)) + "\n  only in runtime + pre-add: " + string.Join(", ", b.Except(a)));
        }

        VisualElement Panel()
        {
            var rt = new RenderTexture(1280, 200, 24);
            var settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            settings.scale = 1f;
            settings.targetTexture = rt;
            var go = new GameObject("KerningBatchTests");
            _objects.AddRange(new Object[] { go, settings, rt });
            var doc = go.AddComponent<UIDocument>();
            doc.panelSettings = settings;
            return doc.rootVisualElement;
        }

        [UnityTest]
        public IEnumerator ALetterSpacedWord_IsAsWideAsInChromium_WhenItsGlyphsCameInBatches()
        {
            var twin = Twin("Kern Width");
            foreach (var batch in new[] { "T", "r", "ansfe", " ", "dönemi" }) DesignText.Prepare(twin, batch);
            var rt = new RenderTexture(1280, 200, 24);
            var settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            settings.scale = 1f;
            settings.targetTexture = rt;
            var go = new GameObject("KerningBatchTests");
            _objects.AddRange(new Object[] { go, settings, rt });
            var doc = go.AddComponent<UIDocument>();
            doc.panelSettings = settings;
            yield return null;
            Label Line(float uss, int row)
            {
                var l = new Label(Word);
                l.style.position = Position.Absolute;
                l.style.top = 60 * row;
                l.style.fontSize = 36;
                l.style.letterSpacing = uss;
                l.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
                doc.rootVisualElement.Add(l);
                return l;
            }
            var plain = Line(0, 0);
            var tracked = Line((float)(Tracking * 100 / 36), 1); // the compiler's conversion of -0.72px
            for (int i = 0; i < 6; i++) { plain.MarkDirtyRepaint(); tracked.MarkDirtyRepaint(); yield return null; }
            float Width(Label l) => l.MeasureTextSize(Word, 0, VisualElement.MeasureMode.Undefined, 0, VisualElement.MeasureMode.Undefined).x;
            const double limit = 1; // boxPx of tools/design-export/fidelity-thresholds.json
            Debug.Log("KerningBatchTests: '" + Word + "' 36 px bold, Unity " + Width(plain) + " / " + Width(tracked) + " px, Chromium " + ChromiumPlain + " / " + (ChromiumTracked - Tracking) + " px (plain / -0.72px without the last spacing)");
            Assert.That(Width(plain), Is.EqualTo(ChromiumPlain).Within(limit), "plain");
            // the standard generator draws no spacing after the last character; Chromium's width has it
            Assert.That(Width(tracked), Is.EqualTo(ChromiumTracked - Tracking).Within(limit), "letter-spacing -0.72px (Chromium without the last spacing: " + (ChromiumTracked - Tracking) + ")");
        }
    }
}
