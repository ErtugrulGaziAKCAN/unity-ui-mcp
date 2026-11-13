Toggles switch one setting on or off: a checkbox, a radio group and a switch, each with its label next to it.

**Compiles to** a UI Toolkit `Toggle` per `<input type="checkbox">` or `<input type="radio">`; the label is a separate text element.

**Markup:** `<label class="option"><input type="checkbox" data-u-id="…"><span data-l10n="…" data-en="…">Etiket</span></label>`; mark the initial value with `checked`.

**States:** `:checked` sets the fill (the switch moves its knob by changing its `radial-gradient` background), `:hover` and `:focus` the border colour, `:disabled` the colours (`--color-disabled-*`, U-CSS-039).

**Do:** give the input a fixed square size (`32px`), `flex-shrink: 0` and a circular radius for radios (half the size).

**Don't:** draw the check mark with `::before` or `::after` content, or put an inset shadow on the input (U-CSS-037).
