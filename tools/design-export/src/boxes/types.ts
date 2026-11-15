import type { BoxRect } from "../ir/types.js";
export type { BoxRect };
/** All rects in device pixels. The box, `visible` and `lines` rules are in schema.json (descriptions); both capture sides follow them. */
export interface CaptureBoxes {
  capture: string; viewport: [number, number]; scale: number;
  /** `rotation`: design side only (degrees on screen, absent when 0); see schema.json. */
  elements: Record<string, BoxRect & { visible: boolean; text: boolean; rotation?: number; lines: (BoxRect & { baseline: number })[] }>;
  external: string[];
  /**
   * The IR elements' copies in later written-out repeat items, keyed `<id><suffix>` (capture.ts itemSuffix, the Unity
   * capture's names), both sides alike: border box, visibility and, for a copy of an element that carries text, its own
   * text lines, by the elements' rules; absent when the screen has no repeat with more than one item. The comparison places
   * the edge bands of a repeat's later items with their boxes, and masks and checks their text as the IR elements' text.
   */
  items?: Record<string, BoxRect & { visible: boolean; text: boolean; lines: (BoxRect & { baseline: number })[] }>;
}
