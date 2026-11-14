/**
 * What the animation player plays, seen from the lint (U-CSS-013, U-CSS-042, U-CSS-043): the CSS properties it animates,
 * the CSS properties CSS itself interpolates (a transition of any other property only switches, in CSS as in the player),
 * and per element the transitions and keyframe animations the IR would record for it (extract/anims.ts, the exporter's
 * own reading of the cascade) plus the properties its transition-property names explicitly.
 */
import { animsOf, covers, list, timeMs } from "../extract/anims.js";
import { dimsOf } from "../extract/layers.js";
import { cssSupport } from "./allowed-css.js";
import type { Layout } from "./layout.js";
import { physicalNames } from "./snapshot.js";

/** Longhands of a property name (shorthands expanded; transform: its translate, rotate and scale split). */
export const longhands = (name: string): string[] => {
  const n = name.trim().toLowerCase();
  return n === "transform" ? ["translate", "rotate", "scale"] : physicalNames(n);
};

/** The longhands the animation player animates (css-support.json keyframeProperties, shorthands expanded). */
export const PLAYER_PROPERTIES: ReadonlySet<string> = new Set(
  cssSupport.keyframeProperties.filter((p) => p !== "animation-timing-function").flatMap(longhands));

/**
 * Longhands CSS transitions and animations interpolate (animation type other than discrete), among the properties a
 * design may use. A transition of any other property (display, flex-direction, font-family, …) changes at once in CSS,
 * as the player changes it.
 */
export const CSS_INTERPOLATED: ReadonlySet<string> = new Set([
  "color", "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color",
  "opacity", "translate", "rotate", "scale", "transform-origin",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
  "width", "height", "min-width", "min-height", "max-width", "max-height", "aspect-ratio",
  "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "top", "right", "bottom", "left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "outline-width", "outline-offset", "flex-basis", "flex-grow", "flex-shrink", "row-gap", "column-gap",
  "font-size", "line-height", "letter-spacing", "word-spacing", "font-weight", "z-index", "visibility",
  "box-shadow", "text-shadow", "filter", "backdrop-filter", "background-position-x", "background-position-y", "background-size", "object-position",
]);

/** Layout properties: an animation of them lays the screen out in every frame (U-CSS-013, U-CSS-042 point to transforms). */
export const isLayoutProperty = (longhand: string) =>
  cssSupport.isLayoutTransitionProperty(longhand) || ["font-size", "line-height", "row-gap", "column-gap", "aspect-ratio"].includes(longhand);

/** Properties U-CSS-014 owns for transitions (the exporter bakes them per layer). */
const BAKED = new Set(["box-shadow", "background-image"]);

/** A longhand whose transition or animation CSS plays and the player does not. */
export const notPlayed = (longhand: string) => CSS_INTERPOLATED.has(longhand) && !PLAYER_PROPERTIES.has(longhand) && !BAKED.has(longhand);

export interface Motion {
  /** Longhand → the layers (`base` included) whose transition-property names it explicitly with a positive combined duration. */
  named: Map<string, Set<string>>;
  /** Longhand → the IR transitions' triggers (what really transitions: a property some layer changes). */
  transitioned: Map<string, Set<string>>;
  /** Longhand → the names of the keyframe animations that animate it. */
  keyframed: Map<string, Set<string>>;
}

const TIMING = /^(transition|animation)-/;
const add = (m: Map<string, Set<string>>, k: string, v: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(v); };

/**
 * The element's transitions and keyframe animations as the exporter records them; null when it declares none (in any
 * layer) or when its cascade cannot be read (other rules report the selectors).
 */
export function motionOf(L: Layout, i: number): Motion | null {
  let raw;
  try { raw = L.ex.raw(i); } catch { return null; }
  if (!Array.from(raw.values()).some((m) => Array.from(m.keys()).some((p) => TIMING.test(p)))) return null;
  const out: Motion = { named: new Map(), transitioned: new Map(), keyframed: new Map() };
  for (const key of raw.keys()) {
    const v = (p: string) => L.ex.effective(i, dimsOf(key), p)?.entry.value;
    const names = list(v("transition-property"), "all"), durs = list(v("transition-duration"), "0s"), delays = list(v("transition-delay"), "0s");
    names.forEach((n, j) => {
      const c = covers(n);
      if (c === "all" || n.toLowerCase() === "none") return;
      const combined = (timeMs(durs[j % durs.length]) ?? 0) + (timeMs(delays[j % delays.length]) ?? 0);
      if (combined > 0) for (const p of c.flatMap(longhands)) add(out.named, p, key);
    });
  }
  try {
    for (const a of animsOf(L.ex, i, raw, L.ex.layers(i), new Set())) {
      for (const p of a.properties.flatMap(longhands)) {
        if (a.kind === "transition") add(out.transitioned, p, a.trigger);
        else if (a.name !== null) add(out.keyframed, p, a.name);
      }
    }
  } catch { /* a keyframe transform other rules reject */ }
  return out;
}
