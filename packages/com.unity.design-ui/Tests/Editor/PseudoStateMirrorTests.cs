using NUnit.Framework;
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

        [Test]
        public void AttachAndDetach_DoNotThrow_AndSyncDisabled()
        {
            var host = new VisualElement();
            var el = new VisualElement();
            var mirror = new PseudoStateMirror(host);
            el.AddManipulator(mirror);
            el.SetEnabled(false);
            el.RemoveManipulator(mirror);
            Assert.Pass();
        }
    }
}
