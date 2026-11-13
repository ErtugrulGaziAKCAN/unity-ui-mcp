using System.Collections.Generic;
using System.IO;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.UIElements;

namespace DesignUi.Editor.Tests
{
    public class FrozenFramesTests
    {
        static IrAnim Slide(string direction) => new IrAnim
        {
            Kind = IrAnim.KeyframesKind, Name = "slide", Direction = direction, FillMode = "none", Iterations = 2,
            Keyframes = new List<IrKeyframe>
            {
                new IrKeyframe { Offset = 0, Values = new Dictionary<string, string> { { "translate", "-60px" }, { "opacity", "0.5" } } },
                new IrKeyframe { Offset = 0.5f, Values = new Dictionary<string, string> { { "rotate", "10deg" } } },
                new IrKeyframe { Offset = 1, Values = new Dictionary<string, string> { { "translate", "60px" } } },
            },
        };

        [Test]
        public void EndValues_AreTheLastKeyframeOfOneIteration_FirstWhenRunningBackwards()
        {
            // the golden's freeze: one iteration, fill both, so alternate ends like normal and alternate-reverse like reverse
            CollectionAssert.AreEquivalent(new Dictionary<string, string> { { "translate", "60px" } }, FrozenFrames.EndValues(Slide("normal")));
            CollectionAssert.AreEquivalent(new Dictionary<string, string> { { "translate", "60px" } }, FrozenFrames.EndValues(Slide("alternate")));
            var back = new Dictionary<string, string> { { "translate", "-60px" }, { "opacity", "0.5" } };
            CollectionAssert.AreEquivalent(back, FrozenFrames.EndValues(Slide("reverse")));
            CollectionAssert.AreEquivalent(back, FrozenFrames.EndValues(Slide("alternate-reverse")));
        }

        [Test]
        public void Apply_WritesTheFrameAsInlineStyles_WithCssValueSemantics()
        {
            var el = new VisualElement();
            FrozenFrames.Apply(el, new Dictionary<string, string>
            {
                { "translate", "-60px" }, { "rotate", "0.25turn" }, { "scale", "1.4" }, { "opacity", "0.2" },
                { "color", "#f0605d" }, { "background-color", "rgba(18, 60, 71, 0.5)" }, { "border-left-color", "transparent" },
            }, tintedImage: true);
            var t = el.style.translate.value;
            Assert.AreEqual(-60f, t.x.value);
            Assert.AreEqual(0f, t.y.value, "one translate value moves along x only");
            Assert.AreEqual(90f, el.style.rotate.value.angle.ToDegrees(), 1e-3f);
            Assert.AreEqual(new Vector3(1.4f, 1.4f, 1f), el.style.scale.value.value, "one scale value scales both axes");
            Assert.AreEqual(0.2f, el.style.opacity.value, 1e-6f);
            Assert.AreEqual(new Color(0xf0 / 255f, 0x60 / 255f, 0x5d / 255f, 1f), el.style.color.value);
            Assert.AreEqual(el.style.color.value, el.style.unityBackgroundImageTintColor.value, "a tinted icon's colour is its tint");
            var bg = el.style.backgroundColor.value;
            Assert.AreEqual(18 / 255f, bg.r, 1e-6f);
            Assert.AreEqual(0.5f, bg.a, 1e-6f);
            Assert.AreEqual(0f, el.style.borderLeftColor.value.a);
            Assert.Throws<NotCapturableException>(() => FrozenFrames.Apply(new VisualElement(), new Dictionary<string, string> { { "width", "10px" } }));
            Assert.Throws<NotCapturableException>(() => FrozenFrames.Apply(new VisualElement(), new Dictionary<string, string> { { "translate", "1em" } }));
        }

        [Test]
        public void ApplyAll_FindsTheAnimationOnItsElement()
        {
            var dot = TestIr.Node("dot", "container");
            dot.Anims.Add(Slide("normal"));
            var ir = TestIr.Screen(TestIr.Root(dot));
            var docRoot = new VisualElement();
            var el = new VisualElement { name = "dot" };
            docRoot.Add(el);
            FrozenFrames.ApplyAll(docRoot, ir, new[] { new FrozenAnimation { ElementId = "dot", Name = "slide" } });
            Assert.AreEqual(60f, el.style.translate.value.x.value);
            Assert.Throws<NotCapturableException>(() => FrozenFrames.ApplyAll(docRoot, ir, new[] { new FrozenAnimation { ElementId = "dot", Name = "spin" } }));
            Assert.Throws<NotCapturableException>(() => FrozenFrames.ApplyAll(docRoot, ir, new[] { new FrozenAnimation { ElementId = "nope", Name = "slide" } }));
        }

        [Test]
        public void ReadMatrix_ReadsTheFrozenAnimationsOfAStaticCapture()
        {
            var path = Path.Combine(Path.GetTempPath(), "dui-matrix-" + System.Guid.NewGuid().ToString("N") + ".json");
            try
            {
                File.WriteAllText(path, "{\"captures\":[{\"name\":\"default@2560x1440\",\"state\":\"default\",\"viewport\":[2560,1440],\"apply\":[]," +
                                        "\"frozen\":[[\"dot\",\"slide\"],[\"text\",\"tint\"]]},{\"name\":\"go@2560x1440\",\"state\":\"go\",\"viewport\":[2560,1440],\"apply\":[]}]}");
                var jobs = CaptureJob.ReadMatrix(path);
                Assert.AreEqual(2, jobs[0].Frozen.Count);
                Assert.AreEqual("dot", jobs[0].Frozen[0].ElementId);
                Assert.AreEqual("tint", jobs[0].Frozen[1].Name);
                Assert.AreEqual(0, jobs[1].Frozen.Count);
                File.WriteAllText(path, "{\"captures\":[{\"name\":\"a\",\"viewport\":[10,10],\"frozen\":[[\"dot\"]]}]}");
                Assert.Throws<IrFormatException>(() => CaptureJob.ReadMatrix(path));
            }
            finally { File.Delete(path); }
        }
    }
}
