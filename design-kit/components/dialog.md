A dialog asks for a decision over the current screen: a scrim over the whole screen, a centred panel with a title, text and two buttons.

**Compiles to** an absolutely positioned `VisualElement` over the screen; the dialog's shadow is baked; a screen state (`data-u-state="saving"`) swaps the buttons for a progress text.

**Markup:** `<div class="scrim" data-u-id="scrim">` with `position: absolute`, the full reference size and `--color-scrim`, after the screen content in the markup; the panel inside uses `--shadow-dialog` and `--radius-lg`.

**States:** the buttons have hover, press and focus styles; `.state-saving` hides the actions and shows the saving text.

**Do:** put the scrim last among its siblings so it paints on top; keep the screen root `position: relative`.

**Don't:** use `position: fixed` (U-CSS-017) or a `z-index` the markup order does not already give (U-CSS-004).
