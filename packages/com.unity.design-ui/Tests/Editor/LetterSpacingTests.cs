using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using FontAsset = UnityEngine.TextCore.Text.FontAsset;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// How UI Toolkit applies USS <c>letter-spacing</c> (Unity 6000.3), measured on a real panel with both generators, at panel
    /// scales 1, 0.75 and 0.5 (docs/findings/letter-spacing.md): the spacing after each character is <c>value × font-size / 100</c>
    /// (hundredths of an em), exactly with the standard generator and truncated to 1/64 device px with the advanced one; a
    /// text-sized element's width leaves out the spacing after the last character with the standard generator and includes
    /// it with the advanced one. The compiler converts CSS px with this (StyleMapper.LetterSpacing).
    /// </summary>
    public class LetterSpacingTests
    {
        readonly List<Object> _objects = new List<Object>();
        IDisposable _advanced;

        [TearDown]
        public void Cleanup()
        {
            foreach (var o in _objects) if (o != null) Object.DestroyImmediate(o);
            _objects.Clear();
            _advanced?.Dispose();
            _advanced = null;
        }

        (VisualElement root, FontAsset font) Panel(float scale)
        {
            FontFixture.RequireInter();
            var rt = new RenderTexture(2560, 1440, 24);
            var settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            settings.scale = scale;
            settings.targetTexture = rt;
            var go = new GameObject("LetterSpacingTests");
            var doc = go.AddComponent<UIDocument>();
            doc.panelSettings = settings;
            var font = FontAsset.CreateFontAsset(AssetDatabase.LoadAssetAtPath<Font>(FontFixture.RegularTtf));
            _objects.AddRange(new Object[] { go, settings, rt, font });
            return (doc.rootVisualElement, font);
        }

        [UnityTest]
        public IEnumerator UssLetterSpacing_IsHundredthsOfAnEm_WithBothGenerators()
        {
            const int N = 40;
            var table = new List<string>();
            foreach (var advanced in new[] { false, true })
            {
                if (advanced)
                {
                    if (!ProjectAdvancedText.Available) continue;
                    _advanced = new ProjectAdvancedText(true);
                }
                foreach (var scale in new[] { 1f, 0.75f, 0.5f })
                {
                    var (root, font) = Panel(scale);
                    yield return null;
                    var labels = new List<(Label l, float size, float spacing, float[] xs)>();
                    int row = 0;
                    foreach (var size in new[] { 12f, 16f, 24f, 40f })
                        foreach (var spacing in new[] { -2f, -0.5f, 0f, 0.5f, 1f, 2f, 10f })
                        {
                            var l = new Label(new string('H', N));
                            l.style.position = Position.Absolute;
                            l.style.left = 0;
                            l.style.top = 30 * row++;
                            l.style.fontSize = size;
                            l.style.letterSpacing = spacing;
                            l.style.unityFontDefinition = FontDefinition.FromSDFFont(font);
                            l.style.unityTextGenerator = advanced ? TextGeneratorType.Advanced : TextGeneratorType.Standard;
                            l.style.paddingLeft = l.style.paddingRight = 0;
                            var xs = new float[N];
                            l.PostProcessTextVertices = g =>
                            {
                                int i = 0;
                                foreach (var glyph in g) { if (i < N) xs[i] = Math.Min(glyph.vertices[0].position.x, glyph.vertices[1].position.x); i++; }
                            };
                            root.Add(l);
                            labels.Add((l, size, spacing, xs));
                        }
                    for (int i = 0; i < 8; i++) { root.Query<Label>().ForEach(x => x.MarkDirtyRepaint()); yield return null; }
                    foreach (var size in new[] { 12f, 16f, 24f, 40f })
                    {
                        var zero = labels.Single(x => x.size == size && x.spacing == 0);
                        float step0 = (zero.xs[N - 1] - zero.xs[0]) / (N - 1);
                        foreach (var x in labels.Where(x => x.size == size && x.spacing != 0))
                        {
                            float perChar = (x.xs[N - 1] - x.xs[0]) / (N - 1) - step0;
                            float extra = x.l.layout.width - zero.l.layout.width;
                            float expected = x.spacing * size / 100f, device = 1f / 64f / scale;
                            if (advanced) Assert.That(Math.Abs(perChar - expected), Is.LessThan(device + 1e-4f), "advanced, scale " + scale + ", size " + size + ", " + x.spacing + ": " + perChar);
                            else Assert.That(perChar, Is.EqualTo(expected).Within(1e-3f), "standard, scale " + scale + ", size " + size + ", " + x.spacing);
                            if (Math.Abs(perChar) >= 3.9f) Assert.That(extra / perChar, Is.EqualTo(advanced ? N : N - 1).Within(0.45f), "spacings in the width (layout widths are whole device px)");
                            table.Add((advanced ? "advanced" : "standard") + "\t" + scale.ToString(CultureInfo.InvariantCulture) + "\t" + size + "\t" + x.spacing.ToString(CultureInfo.InvariantCulture) +
                                      "\t" + perChar.ToString("0.00000", CultureInfo.InvariantCulture) + "\t" + (x.spacing * size / 100f).ToString("0.00000", CultureInfo.InvariantCulture) +
                                      "\t" + (perChar != 0 ? (extra / perChar).ToString("0.00", CultureInfo.InvariantCulture) : "-"));
                        }
                    }
                    foreach (var x in labels) x.l.RemoveFromHierarchy();
                }
            }
            Debug.Log("LETTERSPACING generator\tscale\tsize\tuss\tper-char-pt\tuss*size/100\tspacings-in-width\n" + string.Join("\n", table));
        }
    }
}
