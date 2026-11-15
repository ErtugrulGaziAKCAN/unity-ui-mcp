using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// Where UI Toolkit breaks a line around quotation marks and apostrophes (Unity 6000.3, Inter Bold 40 px), against
    /// Chromium's breaks of the same strings and box widths (docs/findings/line-breaks.md). Between letters of a text that
    /// has a space to break at, both text generators break at the space, as Chromium does: no quotation mark or apostrophe
    /// gives an extra break opportunity. A word wider than its line is the limit: Chromium keeps it on its line (overflowing),
    /// UI Toolkit breaks it inside, the standard generator after the last character that fits, the advanced one after a
    /// quotation mark (not an apostrophe). Lint W-TEXT-001 warns about such a word.
    /// </summary>
    public class LineBreakTests
    {
        /// <summary>The quotation marks and apostrophes of the kit's locales (French, German, Italian, Turkish, …).</summary>
        static readonly string[] Quotes = { "’", "'", "‘", "ʼ", "“", "”", "„", "‚", "«", "»", "‹", "›", "\"" };

        /// <summary>The advanced generator breaks a too-long word after these (measured), never after the apostrophes.</summary>
        const string AdvancedBreaksAfter = "“”„‚«»‹›\"";

        readonly List<Object> _objects = new List<Object>();
        System.IDisposable _advanced;

        [TearDown]
        public void Cleanup()
        {
            foreach (var o in _objects) if (o != null) Object.DestroyImmediate(o);
            _objects.Clear();
            _advanced?.Dispose();
            _advanced = null;
            FontFixture.Delete();
        }

        static readonly MethodInfo Handle = typeof(TextElement).GetProperty("uitkTextHandle", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetGetMethod(true);

        /// <summary>The index of the first character on the label's second line, or -1 on one line (the text handle's cursor positions).</summary>
        static int SecondLineStart(Label label)
        {
            var handle = Handle?.Invoke(label, null);
            var at = handle?.GetType().GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .FirstOrDefault(m => m.Name == "GetCursorPositionFromStringIndexUsingLineHeight" && m.GetParameters().Length >= 1);
            if (at == null) Assert.Ignore("this Unity version has no TextHandle.GetCursorPositionFromStringIndexUsingLineHeight");
            float Y(int i) => ((Vector2)at.Invoke(handle, at.GetParameters().Select((p, k) => k == 0 ? (object)i : p.HasDefaultValue ? p.DefaultValue : false).ToArray())).y;
            float first = Y(0);
            for (int i = 1; i < label.text.Length; i++) if (Y(i) > first + 1) return i;
            return -1;
        }

        IEnumerator Measure(bool advanced, List<(string text, string fitWidthOf, float extra, int expected, string why)> cases)
        {
            if (advanced)
            {
                if (!ProjectAdvancedText.Available) Assert.Ignore("this Unity version has no Enable Advanced Text project setting");
                _advanced = new ProjectAdvancedText(true);
            }
            var twin = FontTwinGenerator.GetOrCreateTwin(FontFixture.CreateTmp(FontFixture.BoldTtf, advanced ? "Break Advanced" : "Break Standard"), FontFixture.TwinFolder);
            DesignText.Prepare(twin, "AUJOURDHIMOT " + string.Concat(Quotes));
            var rt = new RenderTexture(1600, 1600, 24);
            var settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            settings.scale = 1f;
            settings.targetTexture = rt;
            var go = new GameObject("LineBreakTests");
            _objects.AddRange(new Object[] { go, settings, rt });
            var doc = go.AddComponent<UIDocument>();
            doc.panelSettings = settings;
            yield return null;
            Label Make(string text, float width, int row)
            {
                var l = new Label(text);
                l.style.position = Position.Absolute;
                l.style.top = row % 14 * 110;
                if (width > 0) l.style.width = width;
                l.style.fontSize = 40;
                l.style.whiteSpace = width > 0 ? WhiteSpace.Normal : WhiteSpace.NoWrap;
                l.style.unityFontDefinition = FontDefinition.FromSDFFont(twin);
                l.style.unityTextGenerator = advanced ? TextGeneratorType.Advanced : TextGeneratorType.Standard;
                doc.rootVisualElement.Add(l);
                return l;
            }
            // the widths of the prefixes the boxes are made for, laid out on one line
            var prefixes = cases.Select(c => c.fitWidthOf).Distinct().ToList();
            var free = prefixes.Select((p, i) => Make(p, 0, i)).ToList();
            for (int i = 0; i < 6; i++) { foreach (var l in free) l.MarkDirtyRepaint(); yield return null; }
            var width = prefixes.Select((p, i) => (p, w: free[i].layout.width)).ToDictionary(x => x.p, x => x.w);
            foreach (var l in free) l.RemoveFromHierarchy();
            var labels = cases.Select((c, i) => Make(c.text, width[c.fitWidthOf] + c.extra, i)).ToList();
            for (int i = 0; i < 6; i++) { foreach (var l in labels) l.MarkDirtyRepaint(); yield return null; }
            var failures = new List<string>();
            for (int i = 0; i < cases.Count; i++)
            {
                int got = SecondLineStart(labels[i]);
                if (got != cases[i].expected)
                    failures.Add("'" + cases[i].text + "' in " + (width[cases[i].fitWidthOf] + cases[i].extra) + " px: second line starts at " + got + ", expected " + cases[i].expected + " (" + cases[i].why + ")");
            }
            Assert.IsEmpty(failures, (advanced ? "advanced" : "standard") + " generator:\n" + string.Join("\n", failures));
        }

        /// <summary>A box that fits "MOT AUJOURD" + the mark + one letter: Chromium and both generators break at the space (index 4).</summary>
        static List<(string, string, float, int, string)> QuotesBetweenLetters() =>
            Quotes.Select(q => ("MOT AUJOURD" + q + "HUI", "MOT AUJOURD" + q, 12f, 4, "Chromium breaks at the space")).ToList();

        [UnityTest]
        public IEnumerator Standard_QuotesBetweenLetters_BreakAtTheSpaceAsChromium() => Measure(false, QuotesBetweenLetters());

        [UnityTest]
        public IEnumerator Advanced_QuotesBetweenLetters_BreakAtTheSpaceAsChromium() => Measure(true, QuotesBetweenLetters());

        /// <summary>
        /// The limit: a word one letter too wide for its box. Chromium keeps it on one line (no break opportunity inside it); the
        /// standard generator breaks it after the last character that fits (index 10).
        /// </summary>
        [UnityTest]
        public IEnumerator Standard_AWordWiderThanItsBox_BreaksAfterTheLastCharacterThatFits() =>
            Measure(false, Quotes.Select(q => ("AUJOURD" + q + "HUI", "AUJOURD" + q + "HU", 1f, 10, "Chromium: one line, overflowing")).ToList());

        /// <summary>The limit with the advanced generator: it breaks such a word after a quotation mark (index 8), else after the last character that fits.</summary>
        [UnityTest]
        public IEnumerator Advanced_AWordWiderThanItsBox_BreaksAfterAQuotationMark() =>
            Measure(true, Quotes.Select(q => ("AUJOURD" + q + "HUI", "AUJOURD" + q + "HU", 1f, AdvancedBreaksAfter.Contains(q) ? 8 : 10, "Chromium: one line, overflowing")).ToList());
    }
}
