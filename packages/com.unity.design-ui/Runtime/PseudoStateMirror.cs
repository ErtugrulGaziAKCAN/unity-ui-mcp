using UnityEngine.UIElements;

namespace DesignUi
{
    /// <summary>
    /// Mirrors the pseudo-states of the element it is attached to onto another element (a shadow host) as the classes
    /// <c>dui-hover</c>, <c>dui-active</c>, <c>dui-focus</c>, <c>dui-checked</c> and <c>dui-disabled</c>, so the
    /// host can be styled by the element's states (a press scale, a hover lift). The element keeps its own Clickable.
    /// Hover from pointer enter/leave; active from the primary button's pointer down (trickle, before a Clickable
    /// stops the event) until pointer up, cancel or capture loss, cleared while the pointer is outside and restored when
    /// it re-enters with the primary button still held or the pointer captured by the element (a press released
    /// elsewhere ends there, so it cannot stick);
    /// focus from the element's own FocusEvent/BlurEvent, which the focus controller sends to every focus target (the
    /// focused element and the composite roots above it, such as a TextField whose inner input has focus) and which do
    /// not bubble, so a focused descendant that is not part of the element's control does not count; checked from a bool
    /// value element (Toggle); disabled by a light poll of enabledInHierarchy (up to 100 ms late).
    /// Detaching removes all dui-* classes from the host.
    /// </summary>
    public sealed class PseudoStateMirror : Manipulator
    {
        public const string HoverClass = "dui-hover";
        public const string ActiveClass = "dui-active";
        public const string FocusClass = "dui-focus";
        public const string CheckedClass = "dui-checked";
        public const string DisabledClass = "dui-disabled";

        static readonly string[] States = { "hover", "active", "focus", "checked", "disabled" };

        readonly VisualElement _host;
        IVisualElementScheduledItem _poll;
        bool _pressed;

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
            target.RegisterCallback<FocusEvent>(OnFocus);
            target.RegisterCallback<BlurEvent>(OnBlur);
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
            target.UnregisterCallback<FocusEvent>(OnFocus);
            target.UnregisterCallback<BlurEvent>(OnBlur);
            target.UnregisterCallback<ChangeEvent<bool>>(OnChecked);
            _poll?.Pause();
            _poll = null;
            _pressed = false;
            foreach (var state in States) SetState(state, false);
        }

        /// <summary>Copies the polled states (disabled, checked) now.</summary>
        public void Sync()
        {
            if (target == null) return;
            SetState("disabled", !target.enabledInHierarchy);
            if (target is INotifyValueChanged<bool> toggle) SetState("checked", toggle.value);
        }

        void OnEnter(PointerEnterEvent e)
        {
            SetState("hover", true);
            // The press goes on while the primary button is held, or while the element holds the pointer capture (its
            // Clickable releases it on up, and the panel's own enter after a capture reports no buttons). Otherwise
            // the press was released outside the element, where no up reached it, and ends here.
            if (_pressed && (e.pressedButtons & 1) == 0 && !target.HasPointerCapture(e.pointerId)) _pressed = false;
            if (_pressed) SetState("active", true);
        }

        void OnLeave(PointerLeaveEvent e) { SetState("hover", false); SetState("active", false); }
        void OnDown(PointerDownEvent e) { if (e.button != 0) return; _pressed = true; SetState("active", true); }
        void OnUp(PointerUpEvent e) { if (e.button != 0) return; _pressed = false; SetState("active", false); }
        void OnCancel(PointerCancelEvent e) { _pressed = false; SetState("active", false); }
        void OnCaptureOut(PointerCaptureOutEvent e) { _pressed = false; SetState("active", false); }
        // registered for the bubble-up phase: FocusEvent and BlurEvent only trickle down, so this runs for the element's own events only
        void OnFocus(FocusEvent e) => SetState("focus", true);
        void OnBlur(BlurEvent e) => SetState("focus", false);
        void OnChecked(ChangeEvent<bool> e) { if (e.target == target) SetState("checked", e.newValue); }
    }
}
