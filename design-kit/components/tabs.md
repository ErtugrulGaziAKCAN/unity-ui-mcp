Tabs switch between views of one screen: a row of tab buttons with an underline on the selected tab and one panel per tab.

**Compiles to** `Button`s in a row; the selected tab and the visible panel are `is-*` classes the generated view toggles (`is-selected`, `is-active`).

**Markup:** `<button class="tab is-selected" data-u-id="tab-…" data-u-action="show-…" data-l10n="…" data-en="…">Sekme</button>`; panels are `display: none` until `.tab-panel.is-active` shows them.

**States:** `:hover` and `.is-selected` change the text colour, `.is-selected` also the 4px bottom border colour; `:active` and `:focus` change the background.

**Do:** keep every tab the same height; mark the initially selected tab and panel in the markup.

**Don't:** use `:first-child` or sibling selectors to pick the selected tab, or `gap` on a container whose children hide themselves with an `is-*` class (U-CSS-034).
