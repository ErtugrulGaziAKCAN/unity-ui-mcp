using System.Globalization;
using NUnit.Framework;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The player's CSS timing against Chromium (Chrome Headless Shell 158, Playwright 1.65.0): easing outputs from
    /// <c>Animation.effect.getComputedTiming().progress</c> of <c>el.animate(…, {easing, fill: "both"})</c> at each input
    /// progress, and keyframe animation values from <c>getComputedStyle().translate/opacity</c> of a paused CSS animation
    /// seeked to each time (the fidelity fixture's <c>slide</c> −60px → 60px and <c>fade</c> 1 → 0.2 (ease-in) → 1).
    /// </summary>
    public class AnimationTimingTests
    {
        static readonly double[] Xs = { 0, 0.05, 0.1, 0.25, 0.3, 0.33, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95, 0.999, 1 };

        static readonly object[] Curves =
        {
            new object[] { "linear", new[] { 0, 0.05, 0.1, 0.25, 0.3, 0.33, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95, 0.999, 1 } },
            new object[] { "ease", new[] { 0, 0.032951541302938495, 0.09479630571576989, 0.4085105913555371, 0.513315160977011, 0.5698887542607908, 0.8024033910598437, 0.8852293098988887, 0.9407646143477034, 0.9604589783649767, 0.9756253738583597, 0.9943164774961483, 0.9986245414517977, 0.999999466346853, 1 } },
            new object[] { "ease-in", new[] { 0, 0.004474615295893126, 0.017026631752235472, 0.0934646510311063, 0.12957676074547098, 0.15341907014166276, 0.31535673426536154, 0.42911976929618073, 0.5548140325266763, 0.621861869174206, 0.6916339332948975, 0.839427844517541, 0.9177577844254551, 0.9982860131264663, 1 } },
            new object[] { "ease-out", new[] { 0, 0.08224221557454482, 0.16057215548245898, 0.378138130825794, 0.4451859674733237, 0.48408872727270363, 0.6846432657346383, 0.7851390612563605, 0.8704232392545289, 0.9065353489688935, 0.9377179939729365, 0.9829733682477645, 0.9955253847041068, 0.9999981124934579, 1 } },
            new object[] { "ease-in-out", new[] { 0, 0.004829749667646691, 0.019722453548276987, 0.129161931047288, 0.18739590670529896, 0.2271501017147606, 0.5, 0.668116153265794, 0.8126040932947011, 0.8708380689527122, 0.918340143734177, 0.9802775464517232, 0.9951702503323533, 0.9999981095053124, 1 } },
            new object[] { "cubic-bezier(.68,-0.55,.27,1.55)", new[] { 0, -0.03703973004892622, -0.06627140862200687, -0.0829350944969853, -0.04980179067816165, -0.014340958790415593, 0.5965962920819935, 0.943067829526787, 1.06813341508479, 1.0888243958895965, 1.0921902965296402, 1.062695448591231, 1.0347027304561829, 1.00075228754857, 1.0000000000000002 } },
            new object[] { "cubic-bezier(0.1, 0.7, 1, 0.1)", new[] { 0, 0.16930236547499505, 0.24477879486730186, 0.35042112077620957, 0.36915632124931114, 0.37843523424687403, 0.4172767830277163, 0.4390768279501375, 0.4688940378792569, 0.4898759978944841, 0.5175285620479739, 0.6099044184360445, 0.6983058389405568, 0.9493860013764632, 1 } },
            new object[] { "steps(4, jump-end)", new[] { 0, 0, 0, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 0.75, 0.75, 0.75, 0.75, 0.75, 1 } },
            new object[] { "steps(4, jump-start)", new[] { 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 0.75, 0.75, 0.75, 1, 1, 1, 1, 1, 1 } },
            new object[] { "steps(3, jump-both)", new[] { 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 1 } },
            new object[] { "steps(5, jump-none)", new[] { 0, 0, 0, 0.25, 0.25, 0.25, 0.5, 0.75, 0.75, 0.75, 1, 1, 1, 1, 1 } },
            new object[] { "step-start", new double[] { 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 } },
            new object[] { "step-end", new double[] { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 } },
            new object[] { "steps(2)", new[] { 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1 } },
        };

        [TestCaseSource(nameof(Curves))]
        public void Easing_MatchesChromium(string css, double[] expected)
        {
            Assert.IsTrue(DesignTimingFunction.TryParse(css, out var f), css);
            for (int i = 0; i < Xs.Length; i++)
                Assert.AreEqual(expected[i], f.Evaluate(Xs[i]), 1e-6, css + " at " + Xs[i].ToString(CultureInfo.InvariantCulture));
        }

        [Test]
        public void Easing_StepsBeforeFlag_HoldsTheValueBeforeAJump()
        {
            var jumpStart = DesignTimingFunction.Parse("steps(4, jump-start)");
            Assert.AreEqual(0.25, jumpStart.Evaluate(0, before: false));
            Assert.AreEqual(0, jumpStart.Evaluate(0, before: true));
            var jumpEnd = DesignTimingFunction.Parse("steps(4, jump-end)");
            Assert.AreEqual(0.5, jumpEnd.Evaluate(0.5, before: false));
            Assert.AreEqual(0.25, jumpEnd.Evaluate(0.5, before: true));
            Assert.AreEqual(jumpEnd.Evaluate(0.6, true), jumpEnd.Evaluate(0.6, false), "only at a step edge");
        }

        [TestCase("linear()")]
        [TestCase("linear(0, 0.5, 1)")]
        [TestCase("cubic-bezier(1.2, 0, 0, 1)")]
        [TestCase("cubic-bezier(0, 0, 1)")]
        [TestCase("steps(0)")]
        [TestCase("steps(1, jump-none)")]
        [TestCase("steps(2, middle)")]
        [TestCase("spring")]
        public void Easing_RejectsWhatThePlayerDoesNotEvaluate(string css) => Assert.IsFalse(DesignTimingFunction.TryParse(css, out _), css);

        // ---- keyframe animations ------------------------------------------------------------------------------------------

        const string Slide = "0||translate=-60px;1||translate=60px";
        const string Fade = "0||opacity=1;0.5|ease-in|opacity=0.2;1||opacity=1";

        /// <summary>The animation's value at each time as CSS shows it: a px number, or null for "no effect" (the element's own "none").</summary>
        static string[] Values(string anim, string frames, double[] times, bool opacity = false)
        {
            var spec = DesignAnimationData.ParseAnimations(anim)[0];
            var set = DesignAnimationData.ParseKeyframes(frames);
            var underlying = default(DesignAnimValue);
            if (opacity) underlying.X = 1;
            var r = new string[times.Length];
            for (int i = 0; i < times.Length; i++)
            {
                if (!DesignAnimationData.Progress(spec, times[i], false, out var x, out var before)) { r[i] = null; continue; }
                var v = DesignAnimationData.Evaluate(set.Properties[0], x, before, spec.Timing, underlying);
                r[i] = v.X.ToString("0.####", CultureInfo.InvariantCulture);
            }
            return r;
        }

        static void AssertValues(string[] expected, string[] actual, string what)
        {
            Assert.AreEqual(expected.Length, actual.Length, what);
            for (int i = 0; i < expected.Length; i++)
            {
                if (expected[i] == null) { Assert.IsNull(actual[i], what + " #" + i); continue; }
                Assert.IsNotNull(actual[i], what + " #" + i + " has no effect, expected " + expected[i]);
                Assert.AreEqual(double.Parse(expected[i], CultureInfo.InvariantCulture), double.Parse(actual[i], CultureInfo.InvariantCulture), 2e-3, what + " #" + i);
            }
        }

        static readonly object[] Configs =
        {
            new object[] { "slide 0 800 0 1 normal both running ease", new double[] { 0, 200, 400, 600, 800, 1000 }, new[] { "-60", "-10.9787", "36.2884", "55.2551", "60", "60" } },
            new object[] { "slide 0 400 0 3 normal both running linear", new double[] { 0, 100, 200, 300, 400, 500, 1100, 1200, 1300 }, new[] { "-60", "-30", "0", "30", "-60", "-30", "30", "60", "60" } },
            new object[] { "slide 0 800 0 2 normal both running ease-in-out", new double[] { 0, 200, 400, 600, 800, 1000, 1600, 1700 }, new[] { "-60", "-44.5006", "0", "44.5006", "-60", "-44.5006", "60", "60" } },
            new object[] { "slide 0 800 0 2 reverse both running ease-in-out", new double[] { 0, 200, 400, 600, 800, 1000, 1600, 1700 }, new[] { "60", "44.5006", "0", "-44.5006", "60", "44.5006", "-60", "-60" } },
            new object[] { "slide 0 800 0 2 alternate both running ease-in-out", new double[] { 0, 200, 400, 600, 800, 1000, 1600, 1700 }, new[] { "-60", "-44.5006", "0", "44.5006", "60", "44.5006", "-60", "-60" } },
            new object[] { "slide 0 800 0 2 alternate-reverse both running ease-in-out", new double[] { 0, 200, 400, 600, 800, 1000, 1600, 1700 }, new[] { "60", "44.5006", "0", "-44.5006", "-60", "-44.5006", "60", "60" } },
            new object[] { "slide 0 600 300 1 normal none running ease-out", new double[] { 0, 150, 300, 450, 600, 750, 900, 1000 }, new[] { null, null, "-60", "-14.6234", "22.1572", "48.7842", null, null } },
            new object[] { "slide 0 600 300 1 normal forwards running ease-out", new double[] { 0, 150, 300, 450, 600, 750, 900, 1000 }, new[] { null, null, "-60", "-14.6234", "22.1572", "48.7842", "60", "60" } },
            new object[] { "slide 0 600 300 1 normal backwards running ease-out", new double[] { 0, 150, 300, 450, 600, 750, 900, 1000 }, new[] { "-60", "-60", "-60", "-14.6234", "22.1572", "48.7842", null, null } },
            new object[] { "slide 0 600 300 1 normal both running ease-out", new double[] { 0, 150, 300, 450, 600, 750, 900, 1000 }, new[] { "-60", "-60", "-60", "-14.6234", "22.1572", "48.7842", "60", "60" } },
            new object[] { "slide 0 1000 0 1 normal both running steps(4, jump-end)", new double[] { 0, 100, 250, 499, 500, 999, 1000 }, new[] { "-60", "-60", "-30", "-30", "0", "30", "60" } },
            new object[] { "slide 0 1000 0 1 normal both running cubic-bezier(.68,-0.55,.27,1.55)", new double[] { 0, 100, 250, 500, 750, 900, 1000 }, new[] { "-60", "-67.9526", "-69.9522", "11.5916", "70.6589", "67.5235", "60" } },
            new object[] { "slide 0 500 0 1.5 alternate both running linear", new double[] { 0, 250, 500, 600, 750, 800 }, new[] { "-60", "0", "60", "36", "0", "0" } },
            new object[] { "slide 0 1000 200 1 normal backwards running steps(4, jump-start)", new double[] { 0, 100, 200.001, 300, 450, 1199 }, new[] { "-60", "-60", "-30", "-30", "0", "60" } },
            new object[] { "slide 0 1000 0 1 reverse both running steps(4, jump-start)", new double[] { 0, 1, 100, 999, 1000, 1100 }, new[] { "60", "60", "60", "-30", "-60", "-60" } },
            new object[] { "slide 0 1000 0 2 alternate both running steps(4, jump-end)", new double[] { 0, 500, 999, 1000, 1001, 1500, 1999, 2000, 2100 }, new[] { "-60", "0", "30", "60", "30", "0", "-60", "-60", "-60" } },
        };

        [TestCaseSource(nameof(Configs))]
        public void Keyframes_IterationsDirectionsFillsAndEasing_MatchChromium(string anim, double[] times, string[] expected) =>
            AssertValues(expected, Values(anim, Slide, times), anim);

        [Test]
        public void Keyframes_PerKeyframeEasing_AndInfiniteIterations_MatchChromium() =>
            AssertValues(new[] { "1", "0.6", "0.2", "0.452285", "1", "0.6", "0.2" },
                Values("fade 0 1000 0 infinite normal none running linear", Fade, new double[] { 0, 250, 500, 750, 1000, 1250, 1500 }, opacity: true), "fade");

        [Test]
        public void Keyframes_ImplicitEndFrames_HoldTheElementsOwnValue()
        {
            // @keyframes { 50% { translate: 30px } }: 0 % and 100 % are the element's own value (here 10px)
            var spec = DesignAnimationData.ParseAnimations("half 0 1000 0 1 normal none running linear")[0];
            var set = DesignAnimationData.ParseKeyframes("0.5||translate=30px");
            var own = new DesignAnimValue { X = 10 };
            DesignAnimationData.Progress(spec, 250, false, out var x, out var before);
            Assert.AreEqual(20f, DesignAnimationData.Evaluate(set.Properties[0], x, before, spec.Timing, own).X, 1e-4);
            DesignAnimationData.Progress(spec, 750, false, out x, out before);
            Assert.AreEqual(20f, DesignAnimationData.Evaluate(set.Properties[0], x, before, spec.Timing, own).X, 1e-4);
        }

        [TestCase("normal", 60f)]
        [TestCase("reverse", -60f)]
        [TestCase("alternate", 60f)]
        [TestCase("alternate-reverse", -60f)]
        public void Keyframes_Frozen_ShowTheStaticCapturesFrame(string direction, float expected)
        {
            // the design's static capture: one iteration, no duration, fill both (design-export load.ts STATIC_CSS)
            var spec = DesignAnimationData.ParseAnimations("slide 0 800 300 infinite " + direction + " none running ease")[0];
            var set = DesignAnimationData.ParseKeyframes(Slide);
            foreach (var t in new[] { 0.0, 500, 1e6 })
            {
                Assert.IsTrue(DesignAnimationData.Progress(spec, t, true, out var x, out var before));
                Assert.AreEqual(expected, DesignAnimationData.Evaluate(set.Properties[0], x, before, spec.Timing, default).X, 1e-4, direction + " at " + t);
            }
        }

        [Test]
        public void Keyframes_Paused_HoldTheirStartFrame()
        {
            var spec = DesignAnimationData.ParseAnimations("slide 0 800 0 1 normal both paused linear")[0];
            Assert.IsTrue(DesignAnimationData.Progress(spec, 500, false, out var x, out _));
            Assert.AreEqual(0, x);
        }

        // ---- values -------------------------------------------------------------------------------------------------------

        [Test]
        public void Colours_InterpolatePremultiplied_AsCss()
        {
            // rgba(255, 0, 0, 0) → #0000ff at 0.5: premultiplied, the transparent red adds no red (Chromium: rgba(0, 0, 255, 0.5))
            Assert.IsTrue(DesignAnimProperties.TryParse(DesignAnimProperty.BackgroundColor, "rgba(255, 0, 0, 0)", out var a));
            Assert.IsTrue(DesignAnimProperties.TryParse(DesignAnimProperty.BackgroundColor, "#0000ff", out var b));
            var m = DesignAnimProperties.Interpolate(DesignAnimProperty.BackgroundColor, a, b, 0.5);
            Assert.AreEqual(0f, m.X, 1e-6);
            Assert.AreEqual(1f, m.Z, 1e-6);
            Assert.AreEqual(0.5f, m.W, 1e-6);
        }

        [Test]
        public void Values_ParseAsTheIrWritesThem()
        {
            Assert.IsTrue(DesignAnimProperties.TryParse(DesignAnimProperty.Translate, "0px 6px", out var t));
            Assert.AreEqual((0f, 6f), (t.X, t.Y));
            Assert.IsTrue(DesignAnimProperties.TryParse(DesignAnimProperty.Translate, "24px", out t));
            Assert.AreEqual((24f, 0f), (t.X, t.Y));
            Assert.IsTrue(DesignAnimProperties.TryParse(DesignAnimProperty.Rotate, "0.5turn", out var r));
            Assert.AreEqual(180f, r.X, 1e-4);
            Assert.IsTrue(DesignAnimProperties.TryParse(DesignAnimProperty.Scale, "1.05", out var s));
            Assert.AreEqual((1.05f, 1.05f), (s.X, s.Y));
            Assert.IsTrue(DesignAnimProperties.TryParse(DesignAnimProperty.Width, "auto", out var w));
            Assert.IsTrue(w.Keyword);
            Assert.IsFalse(DesignAnimProperties.Interpolable(DesignAnimProperty.Width, w, new DesignAnimValue { X = 10 }), "auto does not interpolate");
            Assert.IsFalse(DesignAnimProperties.TryParse(DesignAnimProperty.Width, "10em", out _));
            Assert.IsFalse(DesignAnimProperties.TryParse(DesignAnimProperty.Color, "hsl(0, 0%, 0%)", out _), "the IR resolves hsl()");
        }
    }
}
