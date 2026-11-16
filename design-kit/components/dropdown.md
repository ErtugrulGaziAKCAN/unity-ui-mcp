A dropdown picks one value from a short list: a select box with a chevron icon drawn over it.

**Compiles to** a UI Toolkit `DropdownField`; each `<option>` is a choice and the `selected` one is the value shown.

**Markup:** `<select data-u-id="…"><option data-l10n="…" data-en="Option" selected>Option</option>…</select>` inside a `position: relative` box, with an inline `<svg>` chevron positioned absolutely on the right and `pointer-events: none`.

**States:** `:hover` changes the background, `:focus` the border colour, `:disabled` the colours (`--color-disabled-*`, U-CSS-039).

**Do:** leave room for the chevron with right padding; paint the chevron with `currentColor` so it follows the text colour.

**Don't:** use a background-image arrow on the select together with a gradient, or nest other elements inside `<select>`.
