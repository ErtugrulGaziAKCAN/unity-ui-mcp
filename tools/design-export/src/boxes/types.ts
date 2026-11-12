import type { BoxRect } from "../ir/types.js";
export type { BoxRect };
/** All rects in device pixels. */
export interface CaptureBoxes {
  capture: string; viewport: [number, number]; scale: number;
  elements: Record<string, BoxRect & { visible: boolean; text: boolean; lines: (BoxRect & { baseline: number })[] }>;
  external: string[];
}
