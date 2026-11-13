A button runs one command when it is pressed: primary, secondary, ghost and destructive styles in two sizes.

**Compiles to** a UI Toolkit `Button`; its own text is the label, centred by `display: flex`, `align-items: center` and `justify-content: center`.

**Markup:** `<button data-u-id="…" data-u-action="…" data-l10n="…" data-en="…">Etiket</button>` with a text style class (`text-body-bold`, `text-label-bold`).

**States:** `:hover` and `:active` change the background colour, `:focus` the border colour (a 4px border, transparent at rest: UI Toolkit has no outline), `:disabled` the colours (`--color-disabled-*`, U-CSS-039).

**Do:** use the colour tokens (`--color-accent`, `--color-surface-700`, …) and `--radius-md`; give a fixed `height` and horizontal padding. The kit pages have no transitions, because animations are not verified yet; a transition of colours or opacity compiles and is played by the animation player.

**Don't:** put the label in a nested element when it is plain text, transition `box-shadow`, or use `outline`.
