using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// Mirrors the pseudo-states of the element it is attached to onto another element (a shadow host) as the classes
    /// <c>dui-hover</c>, <c>dui-active</c>, <c>dui-focus</c>, <c>dui-checked</c> and <c>dui-disabled</c>, so the
    /// host can be styled by the element's states (a press scale, a hover lift). The element keeps its own Clickable.
    /// Active is mirrored from the pointer down (before the Clickable stops the event) until pointer up, cancel,
    /// capture loss or leave; checked from a bool value element (Toggle); disabled by a light poll of
    /// enabledInHierarchy.
    /// </summary>
    public sealed class PseudoStateMirror : Manipulator
    {
        public const string HoverClass = "dui-hover";
        public const string ActiveClass = "dui-active";
        public const string FocusClass = "dui-focus";
        public const string CheckedClass = "dui-checked";
        public const string DisabledClass = "dui-disabled";

        readonly VisualElement _host;
        IVisualElementScheduledItem _poll;

        public PseudoStateMirror(VisualElement host)
        {
            _host = host;
        }

        /// <summary>The class a pseudo-state (hover, active, focus, checked, disabled) is mirrored as, or null.</summary>
        public static string ClassFor(string state)
        {
            switch (state)
            {
                case "hover": return HoverClass;
                case "active": return ActiveClass;
                case "focus": return FocusClass;
                case "checked": return CheckedClass;
                case "disabled": return DisabledClass;
                default: return null;
            }
        }

        /// <summary>Sets or clears the mirrored class of a pseudo-state on the host.</summary>
        public void SetState(string state, bool on)
        {
            var cls = ClassFor(state);
            if (cls != null) _host.EnableInClassList(cls, on);
        }

        protected override void RegisterCallbacksOnTarget()
        {
            target.RegisterCallback<PointerEnterEvent>(OnEnter);
            target.RegisterCallback<PointerLeaveEvent>(OnLeave);
            target.RegisterCallback<PointerDownEvent>(OnDown, TrickleDown.TrickleDown);
            target.RegisterCallback<PointerUpEvent>(OnUp);
            target.RegisterCallback<PointerCancelEvent>(OnCancel);
            target.RegisterCallback<PointerCaptureOutEvent>(OnCaptureOut);
            target.RegisterCallback<FocusInEvent>(OnFocusIn);
            target.RegisterCallback<FocusOutEvent>(OnFocusOut);
            target.RegisterCallback<ChangeEvent<bool>>(OnChecked);
            _poll = target.schedule.Execute(Sync).Every(100);
            Sync();
        }

        protected override void UnregisterCallbacksFromTarget()
        {
            target.UnregisterCallback<PointerEnterEvent>(OnEnter);
            target.UnregisterCallback<PointerLeaveEvent>(OnLeave);
            target.UnregisterCallback<PointerDownEvent>(OnDown, TrickleDown.TrickleDown);
            target.UnregisterCallback<PointerUpEvent>(OnUp);
            target.UnregisterCallback<PointerCancelEvent>(OnCancel);
            target.UnregisterCallback<PointerCaptureOutEvent>(OnCaptureOut);
            target.UnregisterCallback<FocusInEvent>(OnFocusIn);
            target.UnregisterCallback<FocusOutEvent>(OnFocusOut);
            target.UnregisterCallback<ChangeEvent<bool>>(OnChecked);
            _poll?.Pause();
            _poll = null;
        }

        void Sync()
        {
            SetState("disabled", !target.enabledInHierarchy);
            if (target is INotifyValueChanged<bool> toggle) SetState("checked", toggle.value);
        }

        void OnEnter(PointerEnterEvent e) => SetState("hover", true);
        void OnLeave(PointerLeaveEvent e) { SetState("hover", false); SetState("active", false); }
        void OnDown(PointerDownEvent e) => SetState("active", true);
        void OnUp(PointerUpEvent e) => SetState("active", false);
        void OnCancel(PointerCancelEvent e) => SetState("active", false);
        void OnCaptureOut(PointerCaptureOutEvent e) => SetState("active", false);
        void OnFocusIn(FocusInEvent e) => SetState("focus", true);
        void OnFocusOut(FocusOutEvent e) => SetState("focus", false);
        void OnChecked(ChangeEvent<bool> e) { if (e.target == target) SetState("checked", e.newValue); }
    }
}
