Text fields take typed input: single-line fields, a search field and a multi-line notes area, each with a label above it.

**Compiles to** a UI Toolkit `TextField` per `<input type="text|search|password|number|email|tel|url">` and per `<textarea>` (multi-line).

**Markup:** `<input type="text" data-u-id="…" placeholder="Text" data-l10n-placeholder="…" data-en-placeholder="Text">`; a field that shows a runtime value uses `value="…"` with `data-u-bind`.

**States:** `:hover` changes the background, `:focus` the border colour, `:disabled` the colours (`--color-disabled-*`, U-CSS-039). The placeholder colour comes from the kit base stylesheet (`--color-text-muted`).

**Do:** give a fixed `height` (64px for `text-body`), horizontal padding and a 4px border; label the field with a visible text element.

**Don't:** rely on browser default borders or fonts (the base stylesheet resets them), or put an inset shadow on the field itself.
