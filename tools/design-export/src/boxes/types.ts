import type { BoxRect } from "../ir/types.js";
export type { BoxRect };
/** All rects in device pixels. The box, `visible` and `lines` rules are in schema.json (descriptions); both capture sides follow them. */
/** A text line's box and baseline; `mixed`: design side only (schema.json). */
export type TextLine = BoxRect & { baseline: number; mixed?: boolean; ellipsis?: LineEllipsis };
/**
 * Design side only: where Chromium places the ellipsis of a line it cuts (ruling R146), device px: `at` the x where the kept
 * prefix ends inside the whole line, `last` and `next` the in-line advances of the last kept and the first dropped grapheme,
 * `width` the ellipsis's own advance.
 */
export interface LineEllipsis { at: number; last: number; next: number; width: number }

export interface CaptureBoxes {
  capture: string; viewport: [number, number]; scale: number;
  /**
   * `rotation`: design side only (degrees on screen, absent when 0); `color` and `opacity`: design side only, a text's computed
   * colour ([r, g, b, alpha]) and the opacity it draws with (its own times its ancestors'); a line's `mixed`: design side only,
   * true when some of its text is drawn in another colour or opacity than the element's (a rich inline span); `paints` and
   * `shadow`: design side only, whether it paints something of its own in the capture and how far its outer shadows reach;
   * see schema.json.
   */
  elements: Record<string, BoxRect & { visible: boolean; text: boolean; rotation?: number; lines: TextLine[]; color?: [number, number, number, number]; opacity?: number } & Painted>;
  external: string[];
  /**
   * The IR elements' copies in later written-out repeat items, keyed `<id><suffix>` (capture.ts itemSuffix, the Unity
   * capture's names), both sides alike: border box, visibility and, for a copy of an element that carries text, its own
   * text lines, by the elements' rules; absent when the screen has no repeat with more than one item. The comparison places
   * the edge bands of a repeat's later items with their boxes, and masks and checks their text as the IR elements' text.
   */
  items?: Record<string, BoxRect & { visible: boolean; text: boolean; lines: TextLine[]; color?: [number, number, number, number]; opacity?: number } & Painted>;
}

/**
 * Design side only (schema.json): what an element or a copy paints of its own in the capture, in its own state (a copy's
 * item's state included): a background, a visible border, a box shadow or picture/vector content (`paints`), and the
 * rect its outer box shadows and text shadows can reach, in device px (`shadow`, absent when it casts none).
 */
export interface Painted { paints?: boolean; shadow?: BoxRect }
