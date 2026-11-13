Scroll areas show more content than fits: a scrolling text panel and a scrolling message list.

**Compiles to** a UI Toolkit `ScrollView` for `overflow-y: auto`; a `data-u-repeat` list inside it compiles to a virtualized `ListView`.

**Markup:** `<div class="scroll" data-u-id="…">` with a fixed `height` and `overflow-y: auto`; for a list, the repeated rows are the scroll area's only children.

**States:** rows inside take `:hover` and `is-*` classes (`.is-unread`) like any element.

**Do:** give the scroll area a fixed size and put the padding on it; give rows `flex-shrink: 0` so they keep their height.

**Don't:** put an inset shadow on the scroll area itself (wrap it instead), or use `gap` on a wrapping container.
