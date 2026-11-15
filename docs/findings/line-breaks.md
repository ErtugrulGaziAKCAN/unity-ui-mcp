# Line breaks around quotation marks and apostrophes (Unity 6000.3)

Measured in `samples/FidelityProject` (Unity 6000.3.6f1, macOS, EditMode panels on a RenderTexture) with a font twin of
Inter 18pt Bold at 40 px, against Chromium (the exporter's Playwright build) with the same font file, size and box widths.
Unity's breaks are read from the text handle's cursor positions, Chromium's from a Range's client rects per character.
`LineBreakTests` keeps the Unity side; lint W-TEXT-001 warns about the case that differs.

## The question

A pilot saw the French "AUJOURD’HUI" (a right single quotation mark between letters) break into two lines in Unity and
stay on one line in Chromium. UAX #14 gives no break opportunity on either side of a quotation mark between letters
(class QU, rules LB19 and LB19a), so Chromium never breaks there. Does UI Toolkit treat the mark as a break opportunity?

## Answer: no; it breaks every word that does not fit its line

Each string was laid out in a box that fits all of it but one letter, so a break opportunity, if there is one, decides
where the line ends. "Second line starts at" is a character index; "1 line" means the line overflows its box.

| Text, box | Chromium | Standard generator | Advanced generator (Enable Advanced Text) |
|---|---|---|---|
| `MOT AUJOURD’HUI`, fits `MOT AUJOURD’` + 12 px, for each of ’ ' ‘ ʼ “ ” „ ‚ « » ‹ › " | 4 (the space) | 4 | 4 |
| `AUJOURD’HUI`, fits `AUJOURD’HU` + 1 px; also with ' ‘ ʼ . or a letter in place of ’ | 1 line (overflowing) | 10 (last character that fits) | 10 |
| `AUJOURD«HUI`, same box; also » “ ” „ ‚ ‹ › " ( ) , : % ! / ` | 1 line (overflowing) | 10 | 8 (after the mark) |
| `AUJOURD-HUI`, same box (hyphen) | 8 | 8 | 8 |
| `MOT AUJOURD?HUI` / `MOT AUJOURD´HUI` (fits `MOT AUJOURD?` + 12 px) | 12 / 11 | 4 / 4 | 12 / 11 |
| `MOT AUJOURD!HUI` / `MOT AUJOURD/HUI`, same box | 4 / 4 | 4 / 4 | 12 / 12 |

- **Quotation marks and apostrophes between letters give no extra break opportunity** in either generator: a text with a
  space breaks at the space, as in Chromium, for every mark of the kit's locales (’ ' ‘ ʼ “ ” „ ‚ « » ‹ › ").
- **A word wider than its line is broken inside it** by both generators, where Chromium (`overflow-wrap: normal`) keeps it
  on its line and lets it overflow the box. The standard generator breaks after the last character that fits; the
  advanced generator breaks after a quotation mark or other punctuation in the word (« » “ ” „ ‚ ‹ › " ( ) , : % ! / `),
  else after the last character that fits; never after an apostrophe (’ ' ‘ ʼ) or a full stop. That is the pilot's case:
  the word was 185 px wide in a 176 px box.
- A **WORD JOINER** (U+2060) next to the mark does not help: both generators then break one character later (after the
  joiner), and it changes nothing where there is no difference to begin with. It renders with no width (Inter has the
  character). So no runtime mitigation (a joiner inserted in the displayed text) is possible: the break comes from UI
  Toolkit breaking every overflowing word, not from the mark.
- Other differences measured on the way, outside the quotation marks: Chromium breaks `AUJOURD?HUI` after the `?` (index 8)
  and `AUJOURD´HUI` before the `´` (index 7), as the advanced generator does, where the standard generator breaks after the
  last character that fits (10); in a text with a space the standard generator breaks at the space instead (table). The
  advanced generator breaks after `!` and `/` between letters where Chromium breaks at the space. Rare in game text; not
  linted.

## What the package does

- **A limit, documented:** UI Toolkit never lets a word overflow its line. A design whose wrapping text has a word wider
  than its box breaks differently in Unity (verify reports the line count and breaks).
- **Lint W-TEXT-001 (warning)** names such a word in the design's own text: the word, its width, the box's width and, when
  the word holds a quotation mark, that the advanced generator breaks after it. The fix: room for the longest word (also in
  the translations), or `white-space: nowrap` with `overflow: hidden` and `text-overflow: ellipsis` where it may be cut.
- Translations are not linted (lint sees the design's own text): a translated word wider than its box breaks the same way
  in Unity. Give a text that holds single long words (a day name, a "today" label) room for the longest translation, or
  make it one line with an ellipsis.
