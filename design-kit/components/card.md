Cards group related content on a raised surface: a card with a gradient header and an action, a clickable card that lifts on hover, and a sunken well.

**Compiles to** `VisualElement`s; the box shadows and the gradient are baked into images by the exporter (outer shadows behind the card, inset shadows as an overlay over the padding box).

**Markup:** a `display: flex; flex-direction: column` box with `--radius-lg`, `--shadow-card` and padding; a clickable card has `data-u-id` and `data-u-action`.

**States:** a clickable card lifts on `:hover` (`translate` plus a larger shadow) and shows a ring for `.is-selected` (a spread box-shadow).

**Do:** use the shadow tokens; give the top child of a rounded card matching top corner radii; keep inset shadows on boxes whose text sits in child elements.

**Don't:** transition `box-shadow` (U-CSS-014: transition the transform), fade the card with opacity (U-CSS-039: it paints a background and children), or put an inset shadow on an element with its own text (U-CSS-037).
