using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.TestTools.Constraints;
using UnityEngine.UIElements;
using static DesignUi.Editor.Tests.TestIr;
using Object = UnityEngine.Object;

namespace DesignUi.Editor.Tests
{
    /// <summary>
    /// The animation player on a compiled screen: the compiler's animation data in the USS, every trigger kind (show, a
    /// screen state, a view class, hover, focus, disabled), values at clock times, the hand-back to the USS rule, the
    /// display rule, reduced motion and allocation-free frames.
    /// </summary>
    public class AnimationPlayerTests
    {
        const string Out = "Assets/DesignUiAnimationPlayerTests";

        readonly List<string> _temp = new List<string>();
        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            if (_rt != null) Object.DestroyImmediate(_rt);
            foreach (var dir in _temp) if (Directory.Exists(dir)) Directory.Delete(dir, true);
            _temp.Clear();
            if (AssetDatabase.IsValidFolder(Out)) AssetDatabase.DeleteAsset(Out);
            FontFixture.Delete();
        }

        internal static IrAnim Transition(string trigger, string phase, float duration, float delay, string timing, params string[] props) => new IrAnim
        {
            Kind = IrAnim.Transition, Trigger = trigger, Phase = phase, Properties = props, Duration = duration, Delay = delay, Timing = timing,
            Iterations = 1, Direction = "normal", FillMode = "none", PlayState = "running", Restart = true,
        };

        /// <summary>A transition both ways (enter and leave) with one timing, as the exporter records a rule's transition.</summary>
        internal static IEnumerable<IrAnim> BothWays(string trigger, float duration, float delay, string timing, params string[] props)
        {
            yield return Transition(trigger, "enter", duration, delay, timing, props);
            yield return Transition(trigger, "leave", duration, delay, timing, props);
        }

        internal static IrAnim Keyframes(string trigger, string name, float duration, float delay, string timing, float iterations, string direction, string fill,
            params (float offset, string easing, (string k, string v)[] values)[] frames) => new IrAnim
        {
            Kind = IrAnim.KeyframesKind, Trigger = trigger, Phase = "enter", Name = name, Duration = duration, Delay = delay, Timing = timing,
            Iterations = iterations, Direction = direction, FillMode = fill, PlayState = "running", Restart = true,
            Properties = frames.SelectMany(f => f.values.Select(v => v.k)).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToArray(),
            Keyframes = frames.Select(f => new IrKeyframe { Offset = f.offset, Easing = f.easing, Values = Layer(f.values) }).ToList(),
        };

        static IrNode Box(string id, string bg) =>
            Node(id, "container", ("width", "100px"), ("height", "50px"), ("flex-shrink", "0"), ("background-color", bg));

        /// <summary>One element per trigger kind.</summary>
        internal static IrScreen AnimatedIr()
        {
            var hover = Box("hover", "#123c47").With("hover", ("background-color", "#16c2d5"), ("scale", "1.05"));
            hover.Anims.AddRange(BothWays("hover", 400, 0, "linear", "background-color", "scale"));
            var chip = Box("chip", "#123c47").With("class:is-on", ("background-color", "#f2b544"), ("rotate", "8deg"));
            chip.Anims.AddRange(BothWays("class:is-on", 400, 0, "ease", "background-color", "rotate"));
            var stated = Box("stated", "#123c47").With("state:go", ("translate", "24px"));
            stated.Anims.AddRange(BothWays("state:go", 400, 100, "ease-out", "translate"));
            var press = Node("press", "button", ("width", "100px"), ("height", "50px"), ("flex-shrink", "0"), ("background-color", "#123c47"),
                ("border-top-width", "4px"), ("border-top-style", "solid"), ("border-top-color", "#2b6573"))
                .With("disabled", ("background-color", "#0d2830")).With("focus", ("border-top-color", "#9be9f2"));
            press.Anims.AddRange(BothWays("disabled", 400, 0, "linear", "background-color"));
            press.Anims.AddRange(BothWays("focus", 400, 0, "steps(4, jump-end)", "border-top-color"));
            var dot = Box("dot", "#16c2d5");
            dot.Anims.Add(Keyframes("show", "slide", 800, 0, "ease-in-out", 2, "alternate", "both",
                (0, null, new[] { ("translate", "-60px") }), (1, null, new[] { ("translate", "60px") })));
            var spin = Box("spin", "#16c2d5");
            spin.Anims.Add(Keyframes("state:go", "spin", 1000, 0, "linear", 1, "normal", "both",
                (0, null, new[] { ("rotate", "0deg") }), (1, null, new[] { ("rotate", "360deg") })));
            var fade = Box("fade", "#16c2d5");
            fade.Anims.Add(Keyframes("show", "fade", 1000, 0, "linear", float.PositiveInfinity, "normal", "none",
                (0, null, new[] { ("opacity", "1") }), (0.5f, "ease-in", new[] { ("opacity", "0.2") }), (1, null, new[] { ("opacity", "1") })));
            var hidden = Box("late", "#16c2d5").With("state:go", ("display", "flex"));
            hidden.Style["base"]["display"] = "none";
            hidden.Anims.Add(Keyframes("show", "pop", 500, 0, "linear", 1, "normal", "both",
                (0, null, new[] { ("scale", "0.5") }), (1, null, new[] { ("scale", "1") })));
            var plain = Box("plain", "#16c2d5");
            var ir = Screen(Root(hover, chip, stated, press, dot, spin, fade, hidden, plain), "anim.sample");
            ir.States = new[] { "default", "go" };
            return ir;
        }

        string TempDir()
        {
            var dir = Path.Combine(Path.GetTempPath(), "design-ui-anim-" + Guid.NewGuid().ToString("N")).Replace('\\', '/');
            Directory.CreateDirectory(dir);
            _temp.Add(dir);
            return dir;
        }

        CompileResult Compile(IrScreen ir)
        {
            var dir = TempDir();
            File.WriteAllText(Path.Combine(dir, ScreenCompiler.IrFileName), JsonConvert.SerializeObject(ir, Formatting.Indented));
            var profile = ScriptableObject.CreateInstance<DesignUiProfile>();
            profile.outputFolder = Out;
            FontFixture.Use(profile);
            var result = ScreenCompiler.Compile(dir, profile, false, NoView());
            Object.DestroyImmediate(profile);
            return result;
        }

        VisualElement Panel()
        {
            _rt = new RenderTexture(1280, 720, 24);
            _settings = Object.Instantiate(DesignUiProfile.LoadDefaultPanelSettings());
            _settings.scaleMode = PanelScaleMode.ConstantPixelSize;
            _settings.scale = 1f;
            _settings.targetTexture = _rt;
            _go = new GameObject("AnimationPlayerTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            return doc.rootVisualElement;
        }

        static IEnumerator Frames(int n)
        {
            for (int i = 0; i < n; i++) yield return null;
        }

        static void Pointer(VisualElement any, Vector2 at)
        {
            using (var move = PointerMoveEvent.GetPooled(new Event { type = EventType.MouseMove, mousePosition = at })) any.panel.visualTree.SendEvent(move);
        }

        static Color Hex(string hex)
        {
            ColorUtility.TryParseHtmlString(hex, out var c);
            return c;
        }

        static void AssertColor(Color expected, Color actual, string what, float tolerance = 0.002f)
        {
            Assert.AreEqual(expected.r, actual.r, tolerance, what + " r");
            Assert.AreEqual(expected.g, actual.g, tolerance, what + " g");
            Assert.AreEqual(expected.b, actual.b, tolerance, what + " b");
        }

        sealed class Mounted
        {
            public DesignScreen Screen;
            public DesignUiAnimationPlayer Player;
            public DesignManualClock Clock;
            public VisualElement this[string name] => Screen.Q(name);

            /// <summary>Steps the clock to <paramref name="ms"/> and writes the values.</summary>
            public void At(double ms)
            {
                Clock.Milliseconds = ms;
                Player.Tick();
            }
        }

        IEnumerator Mount(Mounted m)
        {
            var result = Compile(AnimatedIr());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var root = Panel();
            yield return Frames(2);
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/AnimSample/AnimSample.uxml").Instantiate();
            m.Clock = new DesignManualClock();
            root.Add(tree);
            m.Screen = tree.Q<DesignScreen>("root");
            Assert.IsNotNull(m.Screen, "the compiled root is a DesignScreen");
            Assert.IsTrue(m.Screen.Animated, "the compiler marks an animated screen");
            m.Player = m.Screen.Animations;
            Assert.IsNotNull(m.Player, "an animated screen attaches its player on attach");
            m.Player.Clock = m.Clock;
            yield return Frames(4);
        }

        // ---- compiler ------------------------------------------------------------------------------------------------------

        [Test]
        public void Compiler_WritesTheAnimationData_NextToTheValues()
        {
            var screen = ScreenBuilder.Build(AnimatedIr(), RelativeAsset, null, null);
            var uss = UssWriter.Write(screen);
            var hover = screen.Find("hover");
            Assert.Contains(DesignAnimationData.MarkerClass, hover.Classes);
            Assert.IsFalse(screen.Find("plain").Classes.Contains(DesignAnimationData.MarkerClass), "an element without animations is not watched");
            Assert.IsTrue(screen.Root.Attributes.Contains(new KeyValuePair<string, string>("animated", "true")), "the root attaches the player");
            string Rule(string selectorEnd) => screen.Rules.Where(r => r.Selector.EndsWith(selectorEnd, StringComparison.Ordinal))
                .Select(r => string.Join("; ", r.Declarations.Select(d => d.Property + ": " + d.Value))).FirstOrDefault() ?? "(no rule " + selectorEnd + ")";
            var cls = "." + hover.Classes[0];
            StringAssert.Contains("--dui-t: \"background-color scale\"", Rule(cls));
            StringAssert.Contains("--dui-t-background-color: \"#123c47|400 0 linear\"", Rule(cls));
            StringAssert.Contains("--dui-t-scale: \"|400 0 linear\"", Rule(cls), "base sets no scale: the element's own value");
            StringAssert.Contains("--dui-t-background-color: \"#16c2d5|400 0 linear\"", Rule(cls + ":hover"));
            StringAssert.Contains("--dui-t-scale: \"1.05|400 0 linear\"", Rule(cls + ":hover"));
            var dot = "." + screen.Find("dot").Classes[0];
            StringAssert.Contains("--dui-a: \"slide 0 800 0 2 alternate both running ease-in-out\"", Rule(dot));
            StringAssert.Contains("--dui-k-0: \"0||translate=-60px;1||translate=60px\"", Rule(dot));
            var spin = "." + screen.Find("spin").Classes[0];
            StringAssert.Contains("--dui-a: \"\"", Rule(spin), "base declares no animation");
            StringAssert.Contains("--dui-a: \"+spin 0 1000 0 1 normal both running linear\"", Rule(".state-go " + spin), "started by the layer");
            StringAssert.Contains("0.5|ease-in|opacity=0.2;", uss, "per-keyframe easing");
            StringAssert.Contains("steps(4, jump-end)", Rule("." + screen.Find("press").Classes[0] + ":focus"));
        }

        [Test]
        public void View_OfAnAnimatedScreen_ExposesItsPlayer()
        {
            var animated = ViewCodeWriter.Write(ScreenBuilder.Build(AnimatedIr(), RelativeAsset, null, null), "Game.Ui", "AnimSampleView");
            StringAssert.Contains("public global::DesignUi.DesignUiAnimationPlayer Animations { get; }", animated);
            StringAssert.Contains("Animations = global::DesignUi.DesignUiAnimationPlayer.Attach(ScreenRoot);", animated);
            var plain = ViewCodeWriter.Write(ScreenBuilder.Build(Screen(Root(Box("plain", "#16c2d5")), "plain.sample"), RelativeAsset, null, null), "Game.Ui", "PlainSampleView");
            StringAssert.DoesNotContain("Animations", plain);
        }

        [Test]
        public void Compiler_NotesTransitionsThePlayerDoesNotAnimate_AndRejectsUnknownTiming()
        {
            var ir = AnimatedIr();
            var hover = ir.Root.Children.First(c => c.Id == "hover");
            hover.Style["hover"]["letter-spacing"] = "2px";
            hover.Anims.Add(Transition("hover", "enter", 200, 0, "linear", "letter-spacing"));
            var screen = ScreenBuilder.Build(ir, RelativeAsset, null, null);
            Assert.IsTrue(screen.Notes.Any(n => n.Contains("letter-spacing") && n.Contains("without a transition")), string.Join("\n", screen.Notes));

            var bad = AnimatedIr();
            bad.Root.Children.First(c => c.Id == "chip").Anims[0].Timing = "linear(0, 0.5, 1)";
            var e = Assert.Throws<UnsupportedStyleException>(() => ScreenBuilder.Build(bad, RelativeAsset, null, null));
            Assert.AreEqual("U-CSS-008", e.RuleId);
        }

        // ---- triggers and values -------------------------------------------------------------------------------------------

        [UnityTest]
        public IEnumerator Hover_AnimatesFromTheShownValue_ThenHandsTheValueBackToTheRule()
        {
            var m = new Mounted();
            yield return Mount(m);
            var el = m["hover"];
            AssertColor(Hex("#123c47"), el.resolvedStyle.backgroundColor, "rest");
            Pointer(el, el.worldBound.center);
            yield return Frames(1);
            Assert.IsTrue(m.Player.IsTransitioning(el, DesignAnimProperty.BackgroundColor), "hover starts the transition");
            AssertColor(Hex("#123c47"), el.resolvedStyle.backgroundColor, "the first frame shows the value before the change");
            m.At(200);
            AssertColor(Color.Lerp(Hex("#123c47"), Hex("#16c2d5"), 0.5f), el.resolvedStyle.backgroundColor, "linear at 200 of 400 ms");
            Assert.AreEqual(1.025f, el.resolvedStyle.scale.value.x, 1e-4);
            m.At(400);
            Assert.AreEqual(StyleKeyword.Null, el.style.backgroundColor.keyword, "the inline style is removed at the end");
            Assert.AreEqual(StyleKeyword.Null, el.style.scale.keyword);
            AssertColor(Hex("#16c2d5"), el.resolvedStyle.backgroundColor, "the USS hover rule shows");
            Assert.IsFalse(m.Player.IsTransitioning(el, DesignAnimProperty.BackgroundColor), "the transition ended");

            // leave half-way back: the reverse transition starts from the value shown
            Pointer(el, new Vector2(-1000, -1000));
            yield return Frames(1);
            m.At(500);
            AssertColor(Color.Lerp(Hex("#16c2d5"), Hex("#123c47"), 0.25f), el.resolvedStyle.backgroundColor, "100 of 400 ms back");
            Pointer(el, el.worldBound.center);
            yield return Frames(1);
            var shown = Color.Lerp(Hex("#16c2d5"), Hex("#123c47"), 0.25f);
            AssertColor(shown, el.resolvedStyle.backgroundColor, "re-entered: from the shown value");
            m.At(700);
            AssertColor(Color.Lerp(shown, Hex("#16c2d5"), 0.5f), el.resolvedStyle.backgroundColor, "and on to the hover value");
        }

        [UnityTest]
        public IEnumerator ViewClass_State_Disabled_AndFocus_StartTheirTransitions()
        {
            var m = new Mounted();
            yield return Mount(m);
            var chip = m["chip"];
            DesignView.SetClass(chip, "is-on", true, null);
            yield return Frames(1);
            m.At(200);
            Assert.AreEqual(8 * DesignTimingFunction.Ease.Evaluate(0.5), chip.resolvedStyle.rotate.angle.ToDegrees(), 1e-3, "ease at the middle");

            var stated = m["stated"];
            DesignView.SetState(m.Screen, new[] { null, "state-go" }, 1);
            yield return Frames(1);
            m.At(250); // 50 ms into its 100 ms delay
            Assert.AreEqual(0, stated.resolvedStyle.translate.x, 1e-4, "the delay holds the start value");
            m.At(500);
            Assert.AreEqual(24 * DesignTimingFunction.EaseOut.Evaluate(0.5), stated.resolvedStyle.translate.x, 1e-3);

            var press = m["press"];
            DesignView.SetEnabled(press, false, null);
            yield return Frames(1);
            m.At(600);
            AssertColor(Color.Lerp(Hex("#123c47"), Hex("#0d2830"), 0.25f), press.resolvedStyle.backgroundColor, ":disabled, 100 of 400 ms");
            DesignView.SetEnabled(press, true, null);
            yield return Frames(1);
            press.Focus();
            yield return Frames(1);
            m.At(800); // 200 of 400 ms at the next panel update? the start is the clock time of the style change
            var steps = m.Player.IsTransitioning(press, DesignAnimProperty.BorderTopColor);
            Assert.IsTrue(steps, ":focus starts the border transition");
        }

        [UnityTest]
        public IEnumerator Keyframes_PlayOnShow_OnAState_AndWhenTheElementGetsABox()
        {
            var m = new Mounted();
            yield return Mount(m);
            var dot = m["dot"];
            m.At(200);
            Assert.AreEqual(-44.5006f, dot.resolvedStyle.translate.x, 2e-3, "alternate, ease-in-out, first iteration (Chromium -44.5006px)");
            m.At(1000);
            Assert.AreEqual(44.5006f, dot.resolvedStyle.translate.x, 2e-3, "second iteration runs backwards");
            m.At(5000);
            Assert.AreEqual(-60f, dot.resolvedStyle.translate.x, 1e-3, "fill both holds the end of iteration 2 (backwards)");
            Assert.AreNotEqual(StyleKeyword.Null, dot.style.translate.keyword, "a fill holds its inline value");

            var fade = m["fade"];
            m.At(5750);
            Assert.AreEqual(0.452285f, fade.resolvedStyle.opacity, 1e-3, "per-keyframe easing, infinite (Chromium 0.452285)");

            var spin = m["spin"];
            var late = m["late"];
            Assert.IsFalse(m.Player.IsPlaying(spin, "spin", out _), "not before its state");
            Assert.IsFalse(m.Player.IsPlaying(late, "pop", out _), "not while display: none");
            DesignView.SetState(m.Screen, new[] { null, "state-go" }, 1);
            yield return Frames(1);
            m.At(6000);
            Assert.AreEqual(90f, spin.resolvedStyle.rotate.angle.ToDegrees(), 1e-3, "the state starts it at the change (5750)");
            Assert.AreEqual(0.75f, late.resolvedStyle.scale.value.x, 1e-3, "shown by the state: it starts then");
            m.At(6250);
            Assert.AreEqual(180f, spin.resolvedStyle.rotate.angle.ToDegrees(), 1e-3);
            Assert.AreEqual(1f, late.resolvedStyle.scale.value.x, 1e-3, "pop ended (500 ms), fill both holds it");

            DesignView.SetState(m.Screen, new[] { null, "state-go" }, 0);
            yield return Frames(1);
            Assert.IsFalse(m.Player.IsPlaying(spin, "spin", out _), "leaving the state removes the animation");
            Assert.AreEqual(StyleKeyword.Null, spin.style.rotate.keyword, "and hands rotate back");
        }

        [UnityTest]
        public IEnumerator ReducedMotion_JumpsTransitions_AndFreezesKeyframesAtTheStaticFrame()
        {
            var m = new Mounted();
            yield return Mount(m);
            m.Player.ReducedMotion = true;
            var dot = m["dot"];
            Assert.IsTrue(m.Player.IsPlaying(dot, "slide", out var frozen) && frozen, "turning it on freezes what plays");
            Assert.AreEqual(60f, dot.resolvedStyle.translate.x, 1e-3, "the end of one iteration (alternate starts forwards)");
            m.At(400);
            Assert.AreEqual(60f, dot.resolvedStyle.translate.x, 1e-3, "and stays there");
            var hover = m["hover"];
            Pointer(hover, hover.worldBound.center);
            yield return Frames(1);
            Assert.IsFalse(m.Player.IsTransitioning(hover, DesignAnimProperty.BackgroundColor));
            AssertColor(Hex("#16c2d5"), hover.resolvedStyle.backgroundColor, "the hover value at once");
            DesignView.SetState(m.Screen, new[] { null, "state-go" }, 1);
            yield return Frames(1);
            Assert.IsTrue(m.Player.IsPlaying(m["spin"], "spin", out frozen) && frozen, "an animation that starts now is frozen too");
            Assert.AreEqual(0f, Mathf.Repeat(m["spin"].resolvedStyle.rotate.angle.ToDegrees(), 360f), 1e-3, "rotate 360deg");
        }

        [UnityTest]
        public IEnumerator Frames_AllocateNothing_WhileAnimationsRun()
        {
            var m = new Mounted();
            yield return Mount(m);
            var hover = m["hover"];
            Pointer(hover, hover.worldBound.center);
            DesignView.SetClass(m["chip"], "is-on", true, null);
            DesignView.SetState(m.Screen, new[] { null, "state-go" }, 1);
            yield return Frames(2);
            m.At(1); // warm-up: every path once
            Assert.GreaterOrEqual(m.Player.ActiveCount, 5, "transitions and keyframes run");
            var player = m.Player;
            var clock = m.Clock;
            Assert.That(() =>
            {
                for (int i = 2; i < 300; i++)
                {
                    clock.Milliseconds = i;
                    player.Tick();
                }
            }, UnityEngine.TestTools.Constraints.Is.Not.AllocatingGCMemory(), "298 frames of the player");
        }

        /// <summary>A panel and a menu whose markup already has their trigger class (the artboard starts open).</summary>
        static IrScreen StartsOpenIr()
        {
            var panel = Box("panel", "#123c47").With("class:is-open", ("translate", "0px"));
            panel.Style["base"]["translate"] = "-300px";
            panel.Classes = new[] { "panel", "is-open" };
            panel.Anims.AddRange(BothWays("class:is-open", 200, 0, "linear", "translate"));
            var menu = Box("menu", "#16c2d5");
            menu.Classes = new[] { "menu", "is-open" };
            menu.Anims.Add(Keyframes("class:is-open", "menu-in", 100, 0, "linear", 1, "normal", "both",
                (0, null, new[] { ("translate", "0px -40px") }), (1, null, new[] { ("translate", "0px 0px") })));
            var ir = Screen(Root(panel, menu), "anim.open");
            ir.States = new[] { "default" };
            return ir;
        }

        [UnityTest]
        public IEnumerator ATriggerTheMarkupStartsIn_ShowsItsEnd_AndStillAnimatesOffAndOn()
        {
            var result = Compile(StartsOpenIr());
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var root = Panel();
            yield return Frames(2);
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/AnimOpen/AnimOpen.uxml").Instantiate();
            var clock = new DesignManualClock();
            root.Add(tree);
            var screen = tree.Q<DesignScreen>("root");
            var player = screen.Animations;
            player.Clock = clock;
            yield return Frames(4);
            var panel = screen.Q("panel");
            var menu = screen.Q("menu");
            Assert.IsTrue(panel.ClassListContains("is-open") && menu.ClassListContains("is-open"), "the compiled markup keeps the classes");
            Assert.IsFalse(player.IsTransitioning(panel, DesignAnimProperty.Translate), "no transition on the first style");
            Assert.AreEqual(0f, panel.resolvedStyle.translate.x, 1e-3, "the layer's value");
            Assert.IsTrue(player.IsPlaying(menu, "menu-in", out var frozen) && frozen, "the layer's animation shows its end, not playing");
            Assert.AreEqual(0f, menu.resolvedStyle.translate.y, 1e-3);

            DesignView.SetClass(panel, "is-open", false, null);
            DesignView.SetClass(menu, "is-open", false, null);
            yield return Frames(1);
            clock.Milliseconds = 100;
            player.Tick();
            Assert.AreEqual(-150f, panel.resolvedStyle.translate.x, 1e-3, "off: the transition runs back (100 of 200 ms)");
            Assert.IsFalse(player.IsPlaying(menu, "menu-in", out _), "off: the animation is removed");

            DesignView.SetClass(panel, "is-open", true, null);
            DesignView.SetClass(menu, "is-open", true, null);
            yield return Frames(1);
            clock.Milliseconds = 150;
            player.Tick();
            Assert.IsTrue(player.IsPlaying(menu, "menu-in", out frozen) && !frozen, "on again: it plays");
            Assert.AreEqual(-20f, menu.resolvedStyle.translate.y, 1e-3, "50 of 100 ms");
            Assert.AreEqual(-112.5f, panel.resolvedStyle.translate.x, 1e-3, "on again: from -150 to 0, 50 of 200 ms");
        }

        [UnityTest]
        public IEnumerator Detach_GivesTheValuesBack_AndReattachStartsOver()
        {
            var m = new Mounted();
            yield return Mount(m);
            var dot = m["dot"];
            m.At(200);
            var parent = m.Screen.parent;
            m.Screen.RemoveFromHierarchy();
            Assert.AreEqual(StyleKeyword.Null, dot.style.translate.keyword, "detached: the inline style is removed");
            m.Clock.Milliseconds = 10000;
            parent.Add(m.Screen);
            yield return Frames(2);
            m.At(10200);
            Assert.AreEqual(-44.5006f, dot.resolvedStyle.translate.x, 2e-3, "inserted again: the show animation starts over");
        }

        // ---- negative delays, play state, animation: none, reversing (CSS values measured in Chromium) ----------------------

        /// <summary>
        /// One element per case: keyframes with a negative delay, a transition with a negative delay, a transition that
        /// reverses, a layer that pauses a running animation, an animation paused from its start, a layer with
        /// animation: none.
        /// </summary>
        internal static IrScreen TimingIr()
        {
            var negDot = Box("neg-dot", "#16c2d5");
            negDot.Anims.Add(Keyframes("show", "slide", 800, -200, "ease-in-out", 1, "normal", "both",
                (0, null, new[] { ("translate", "-60px") }), (1, null, new[] { ("translate", "60px") })));
            var negT = Box("neg-t", "#000000").With("class:is-on", ("background-color", "#c86428"));
            negT.Anims.AddRange(BothWays("class:is-on", 400, -100, "linear", "background-color"));
            var never = Box("never", "#000000").With("class:is-on", ("background-color", "#c86428"));
            never.Anims.AddRange(BothWays("class:is-on", 100, -200, "linear", "background-color"));
            var rev = Box("rev", "#123c47").With("class:is-on", ("rotate", "8deg"));
            rev.Anims.AddRange(BothWays("class:is-on", 400, 0, "ease", "rotate"));
            var pause = Box("pause", "#16c2d5").With("class:is-paused", ("background-color", "#16c2d5"));
            pause.Anims.Add(Keyframes("show", "spin", 1000, 0, "linear", 1, "normal", "both",
                (0, null, new[] { ("rotate", "0deg") }), (1, null, new[] { ("rotate", "360deg") })));
            var held = Keyframes("class:is-paused", "spin", 1000, 0, "linear", 1, "normal", "both",
                (0, null, new[] { ("rotate", "0deg") }), (1, null, new[] { ("rotate", "360deg") }));
            held.PlayState = "paused";
            held.Restart = false;
            pause.Anims.Add(held);
            var paused0 = Box("paused0", "#16c2d5");
            var p0 = Keyframes("show", "slide", 800, -200, "linear", 1, "normal", "both",
                (0, null, new[] { ("translate", "-60px") }), (1, null, new[] { ("translate", "60px") }));
            p0.PlayState = "paused";
            paused0.Anims.Add(p0);
            var still = Box("still", "#16c2d5").With("class:is-still", ("background-color", "#16c2d5"));
            still.Anims.Add(Keyframes("show", "spin", 1000, 0, "linear", float.PositiveInfinity, "normal", "none",
                (0, null, new[] { ("rotate", "0deg") }), (1, null, new[] { ("rotate", "360deg") })));
            still.Anims.Add(new IrAnim
            {
                Kind = IrAnim.KeyframesKind, Trigger = "class:is-still", Phase = "enter", Name = null, Properties = new[] { "rotate" }, Duration = 0, Delay = 0,
                Timing = "ease", Iterations = 1, Direction = "normal", FillMode = "none", PlayState = "running", Restart = true,
            });
            var ir = Screen(Root(negDot, negT, never, rev, pause, paused0, still), "anim.timing");
            ir.States = new[] { "default" };
            return ir;
        }

        IEnumerator MountIr(Mounted m, IrScreen ir, string folder)
        {
            var result = Compile(ir);
            Assert.IsTrue(result.Ok, string.Join("\n", result.Errors));
            var root = Panel();
            yield return Frames(2);
            var tree = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(Out + "/" + folder + "/" + folder + ".uxml").Instantiate();
            m.Clock = new DesignManualClock();
            root.Add(tree);
            m.Screen = tree.Q<DesignScreen>("root");
            m.Player = m.Screen.Animations;
            m.Player.Clock = m.Clock;
            yield return Frames(4);
        }

        static Color Rgb(float r, float g, float b) => new Color(r / 255f, g / 255f, b / 255f);

        [Test]
        public void Compiler_WritesNegativeDelays_AndALayersAnimationNone()
        {
            var screen = ScreenBuilder.Build(TimingIr(), RelativeAsset, null, null);
            string Rule(string selectorEnd) => screen.Rules.Where(r => r.Selector.EndsWith(selectorEnd, StringComparison.Ordinal))
                .Select(r => string.Join("; ", r.Declarations.Select(d => d.Property + ": " + d.Value))).FirstOrDefault() ?? "(no rule " + selectorEnd + ")";
            string Cls(string id) => "." + screen.Find(id).Classes[0];
            StringAssert.Contains("--dui-a: \"slide 0 800 -200 1 normal both running ease-in-out\"", Rule(Cls("neg-dot")));
            StringAssert.Contains("--dui-t-background-color: \"#000000|400 -100 linear\"", Rule(Cls("neg-t")));
            StringAssert.Contains("--dui-t-background-color: \"#000000|\"", Rule(Cls("never")), "100 ms − 200 ms: no transition in CSS");
            StringAssert.Contains("--dui-a: \"\"", Rule(Cls("still") + ".is-still"), "animation: none in the layer");
            StringAssert.Contains("--dui-a: \"spin 0 1000 0 infinite normal none running linear\"", Rule(Cls("still")));
        }
        [UnityTest]
        public IEnumerator NegativeDelays_StartInsideTheTimeline_AsChromiumDoes()
        {
            var m = new Mounted();
            yield return MountIr(m, TimingIr(), "AnimTiming");
            var dot = m["neg-dot"];
            m.At(0);
            Assert.AreEqual(-44.5006f, dot.resolvedStyle.translate.x, 2e-3, "200 ms into its timeline at once");
            m.At(100);
            Assert.AreEqual(-24.8675f, dot.resolvedStyle.translate.x, 2e-3);
            m.At(600);
            Assert.AreEqual(60f, dot.resolvedStyle.translate.x, 2e-3, "it ends 600 ms after it started");

            // a transition delayed by −100 ms of 400: 25 % at the change
            var t = m["neg-t"];
            m.At(1000);
            DesignView.SetClass(t, "is-on", true, null);
            yield return Frames(1);
            m.At(1000);
            AssertColor(Rgb(50, 25, 10), t.resolvedStyle.backgroundColor, "Chromium rgb(50, 25, 10)");
            m.At(1100);
            AssertColor(Rgb(100, 50, 20), t.resolvedStyle.backgroundColor, "Chromium rgb(100, 50, 20)");

            // 100 ms − 200 ms: never starts
            var never = m["never"];
            DesignView.SetClass(never, "is-on", true, null);
            yield return Frames(1);
            Assert.IsFalse(m.Player.IsTransitioning(never, DesignAnimProperty.BackgroundColor));
            AssertColor(Hex("#c86428"), never.resolvedStyle.backgroundColor, "the new value at once");
        }
        [UnityTest]
        public IEnumerator PlayState_PausingHoldsTheFrame_ResumingContinuesFromIt()
        {
            var m = new Mounted();
            yield return MountIr(m, TimingIr(), "AnimTiming");
            var pause = m["pause"];
            m.At(250);
            Assert.AreEqual(90f, pause.resolvedStyle.rotate.angle.ToDegrees(), 1e-3);
            DesignView.SetClass(pause, "is-paused", true, null);
            yield return Frames(1);
            m.At(600);
            Assert.AreEqual(90f, pause.resolvedStyle.rotate.angle.ToDegrees(), 1e-3, "paused at 250 ms: the frame holds");
            Assert.IsTrue(m.Player.IsPlaying(pause, "spin", out var frozen) && !frozen, "still the same animation");
            DesignView.SetClass(pause, "is-paused", false, null);
            yield return Frames(1);
            m.At(850);
            Assert.AreEqual(180f, pause.resolvedStyle.rotate.angle.ToDegrees(), 1e-3, "resumed at 600 ms from 250 ms of its time");

            // paused from its start, 200 ms into its timeline (delay −200 ms): local time 0 holds
            var paused0 = m["paused0"];
            Assert.AreEqual(-30f, paused0.resolvedStyle.translate.x, 1e-3);
            m.At(5000);
            Assert.AreEqual(-30f, paused0.resolvedStyle.translate.x, 1e-3);
        }

        [UnityTest]
        public IEnumerator ALayersAnimationNone_StopsTheAnimations_AndTheyStartOverWhenItEnds()
        {
            var m = new Mounted();
            yield return MountIr(m, TimingIr(), "AnimTiming");
            var still = m["still"];
            m.At(250);
            Assert.AreEqual(90f, still.resolvedStyle.rotate.angle.ToDegrees(), 1e-3);
            DesignView.SetClass(still, "is-still", true, null);
            yield return Frames(1);
            Assert.IsFalse(m.Player.IsPlaying(still, "spin", out _), "animation: none stops it");
            Assert.AreEqual(StyleKeyword.Null, still.style.rotate.keyword, "and hands rotate back");
            m.At(400);
            DesignView.SetClass(still, "is-still", false, null);
            yield return Frames(1);
            m.At(650);
            Assert.AreEqual(90f, still.resolvedStyle.rotate.angle.ToDegrees(), 1e-3, "it starts over when the layer stops holding (at 400 ms)");
        }
    }
}
