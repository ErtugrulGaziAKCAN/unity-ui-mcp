using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;

namespace DesignUi.Editor.Tests
{
    public class PseudoStateMirrorTests
    {
        [TestCase("hover", "dui-hover")]
        [TestCase("active", "dui-active")]
        [TestCase("focus", "dui-focus")]
        [TestCase("checked", "dui-checked")]
        [TestCase("disabled", "dui-disabled")]
        public void SetState_TogglesTheMirroredClassOnTheHost(string state, string cls)
        {
            var host = new VisualElement();
            var mirror = new PseudoStateMirror(host);
            Assert.AreEqual(cls, PseudoStateMirror.ClassFor(state));
            mirror.SetState(state, true);
            Assert.IsTrue(host.ClassListContains(cls));
            mirror.SetState(state, false);
            Assert.IsFalse(host.ClassListContains(cls));
        }

        [Test]
        public void ClassNames_MatchTheLoweringLayerPrefix()
        {
            Assert.AreEqual(Lowering.ClassPrefix + "hover", "class:" + PseudoStateMirror.HoverClass);
        }

        [Test]
        public void SetState_UnknownState_IsIgnored()
        {
            var host = new VisualElement();
            new PseudoStateMirror(host).SetState("visited", true);
            Assert.AreEqual(0, host.GetClasses().GetEnumerator().MoveNext() ? 1 : 0);
        }

        // ---- events on a real panel ------------------------------------------------------------------------

        GameObject _go;
        PanelSettings _settings;
        RenderTexture _rt;
        VisualElement _host, _el;
        PseudoStateMirror _mirror;

        [UnitySetUp]
        public IEnumerator Panel()
        {
            _rt = new RenderTexture(64, 64, 24);
            _settings = ScriptableObject.CreateInstance<PanelSettings>();
            _settings.targetTexture = _rt;
            _go = new GameObject("PseudoStateMirrorTests");
            var doc = _go.AddComponent<UIDocument>();
            doc.panelSettings = _settings;
            yield return null;
            yield return null;
            _host = new VisualElement();
            _el = new VisualElement { focusable = true };
            _el.style.width = 50; _el.style.height = 50;
            _host.Add(_el);
            doc.rootVisualElement.Add(_host);
            _mirror = new PseudoStateMirror(_host);
            _el.AddManipulator(_mirror);
            yield return null;
            Assert.IsNotNull(_el.panel, "the element is on a panel");
        }

        [TearDown]
        public void Cleanup()
        {
            if (_go != null) Object.DestroyImmediate(_go);
            if (_settings != null) Object.DestroyImmediate(_settings);
            if (_rt != null) Object.DestroyImmediate(_rt);
        }

        static Event Mouse(EventType type, int button = 0) => new Event { type = type, button = button, mousePosition = new Vector2(10, 10) };

        void Send<T>(T e) where T : EventBase<T>, new()
        {
            using (e) { e.target = _el; _el.SendEvent(e); }
        }

        bool Has(string cls) => _host.ClassListContains(cls);

        [UnityTest]
        public IEnumerator Hover_FollowsPointerEnterAndLeave()
        {
            Send(PointerEnterEvent.GetPooled(Mouse(EventType.MouseMove)));
            Assert.IsTrue(Has("dui-hover"));
            Send(PointerLeaveEvent.GetPooled(Mouse(EventType.MouseMove)));
            Assert.IsFalse(Has("dui-hover"));
            yield return null;
        }

        [UnityTest]
        public IEnumerator Active_PrimaryButtonOnly_RestoredOnReenterWhilePressed_ClearedOnUp()
        {
            Send(PointerDownEvent.GetPooled(Mouse(EventType.MouseDown, 1)));
            Assert.IsFalse(Has("dui-active"), "secondary button");
            Send(PointerDownEvent.GetPooled(Mouse(EventType.MouseDown, 0)));
            Assert.IsTrue(Has("dui-active"));
            Send(PointerLeaveEvent.GetPooled(Mouse(EventType.MouseMove)));
            Assert.IsFalse(Has("dui-active"), "pointer outside");
            Send(PointerEnterEvent.GetPooled(Mouse(EventType.MouseMove)));
            Assert.IsTrue(Has("dui-active"), "re-entered while pressed");
            Send(PointerUpEvent.GetPooled(Mouse(EventType.MouseUp, 0)));
            Assert.IsFalse(Has("dui-active"));
            Send(PointerLeaveEvent.GetPooled(Mouse(EventType.MouseMove)));
            Send(PointerEnterEvent.GetPooled(Mouse(EventType.MouseMove)));
            Assert.IsFalse(Has("dui-active"), "not pressed any more");
            yield return null;
        }

        [UnityTest]
        public IEnumerator Focus_OnlyWhenTheElementItselfIsFocused()
        {
            var child = new VisualElement { focusable = true };
            _el.Add(child);
            yield return null;
            child.Focus();
            yield return null;
            Assert.IsFalse(Has("dui-focus"), "a focused descendant does not focus the element");
            _el.Focus();
            yield return null;
            Assert.IsTrue(Has("dui-focus"));
            child.Focus();
            yield return null;
            Assert.IsFalse(Has("dui-focus"));
        }

        [UnityTest]
        public IEnumerator Disabled_And_Checked_AreCopiedBySync()
        {
            _el.SetEnabled(false);
            _mirror.Sync();
            Assert.IsTrue(Has("dui-disabled"));
            _el.SetEnabled(true);
            _mirror.Sync();
            Assert.IsFalse(Has("dui-disabled"));

            var toggle = new Toggle();
            var host2 = new VisualElement();
            host2.Add(toggle);
            _host.Add(host2);
            var m = new PseudoStateMirror(host2);
            toggle.AddManipulator(m);
            toggle.value = true;
            m.Sync();
            Assert.IsTrue(host2.ClassListContains("dui-checked"));
            yield return null;
        }

        [UnityTest]
        public IEnumerator Detach_RemovesEveryMirroredClass()
        {
            _mirror.SetState("hover", true);
            _mirror.SetState("active", true);
            _mirror.SetState("focus", true);
            _mirror.SetState("checked", true);
            _mirror.SetState("disabled", true);
            _el.RemoveManipulator(_mirror);
            foreach (var cls in new[] { "dui-hover", "dui-active", "dui-focus", "dui-checked", "dui-disabled" })
                Assert.IsFalse(Has(cls), cls);
            yield return null;
        }
    }
}
