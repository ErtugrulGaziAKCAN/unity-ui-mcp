import type { BoxRect } from "../ir/types.js";
export type { BoxRect };
/** All rects in device pixels. The box, `visible` and `lines` rules are in schema.json (descriptions); both capture sides follow them. */
export interface CaptureBoxes {
  capture: string; viewport: [number, number]; scale: number;
  /** `rotation`: design side only (degrees on screen, absent when 0); see schema.json. */
  elements: Record<string, BoxRect & { visible: boolean; text: boolean; rotation?: number; lines: (BoxRect & { baseline: number })[] }>;
  external: string[];
  /**
   * The border boxes of the IR elements' copies in later written-out repeat items, keyed `<id><suffix>` (capture.ts
   * itemSuffix, the Unity capture's names), both sides alike; absent when the screen has no repeat with more than one item.
   * The comparison places the edge bands of a repeat's later items with them; nothing else compares them.
   */
  items?: Record<string, BoxRect & { visible: boolean }>;
}
