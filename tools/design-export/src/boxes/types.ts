import type { BoxRect } from "../ir/types.js";
export type { BoxRect };
/** All rects in device pixels. The box, `visible` and `lines` rules are in schema.json (descriptions); both capture sides follow them. */
export interface CaptureBoxes {
  capture: string; viewport: [number, number]; scale: number;
  elements: Record<string, BoxRect & { visible: boolean; text: boolean; lines: (BoxRect & { baseline: number })[] }>;
  external: string[];
}
