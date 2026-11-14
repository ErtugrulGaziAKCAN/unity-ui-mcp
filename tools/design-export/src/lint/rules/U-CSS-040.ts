import { parseShadow, splitShadows } from "../../bake/shadow.js";
import { exactViewports, type KitConfig } from "../../kit.js";
import { logicalViewport } from "../../viewport.js";
import { px } from "../css-values.js";
import { layoutOf } from "../layout.js";
import type { DomSnapshot, SnapElement } from "../snapshot.js";
import type { Rule } from "../types.js";
import { declRule, declText, declsAt, make, sourcesOf } from "./util.js";

const WIDTHS = new Set(["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"]);
const KEYWORDS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The panel scale of every exact viewport the kit declares (the reference first when the kit does not list it): the
 * viewports where every kit value must be whole device px. Scaled viewports (viewport.ts ViewportClass) are exempt.
 */
export function kitScales(kit: Pick<KitConfig, "reference" | "viewports" | "scaledViewports" | "screenMatch">): { viewport: [number, number]; scale: number }[] {
  return exactViewports(kit).map((viewport) => ({ viewport, scale: logicalViewport(viewport, kit.reference, kit.screenMatch).scale }));
}

/** Border widths (whole CSS px, up to 64) that are whole device px at every scale: the first three. */
export function wholeBorderWidths(scales: number[], count = 3): number[] {
  const out: number[] = [];
  for (let w = 1; w <= 64 && out.length < count; w++) if (scales.every((s) => Number.isInteger(round6(w * s)))) out.push(w);
  return out;
}

/** Painted boxes thinner than this (CSS px) are lines: their thickness must be whole device px at every viewport. */
export const THIN_BOX_PX = 8;

const TRANSPARENT = /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/;
/** The element fills its box with a colour, an image or a border (what a line or a bar is drawn with). */
const fillsBox = (e: SnapElement) => {
  const k = e.computed;
  return !TRANSPARENT.test((k["background-color"] ?? "").trim()) || (k["background-image"] ?? "none") !== "none"
    || ["top", "right", "bottom", "left"].some((sd) => !/^(none|hidden)$/.test(k[`border-${sd}-style`] ?? "none") && parseFloat(k[`border-${sd}-width`] ?? "0") > 0);
};

/**
 * Painted lines on the device grid: UI Toolkit rounds both edges of a box to whole device px, so a painted box whose
 * width or height under THIN_BOX_PX is not whole device px at a viewport draws thicker or thinner there (1px at 0.75 is
 * 0.75 device px, which can round to nothing) where Chromium draws the fraction anti-aliased.
 */
function thinBoxes(s: DomSnapshot, scales: { viewport: [number, number]; scale: number }[], ok: number[]): ReturnType<typeof make>[] {
  const L = layoutOf(s);
  const lengths = ok.filter((w) => w < THIN_BOX_PX).map((w) => `${w}px`).join(" or ") || `${THIN_BOX_PX}px`;
  const out: ReturnType<typeof make>[] = [];
  for (const e of s.elements) {
    if (!L.inScreen(e.index) || e.tag === "svg" || !e.rendered || e.computed.display === "none" || e.computed.visibility !== "visible" || !fillsBox(e)) continue;
    const size = e.size ?? e.box;
    if (!size) continue;
    const bad = ([["wide", size.w], ["tall", size.h]] as const).flatMap(([what, v]) => {
      if (!(v > 0) || v >= THIN_BOX_PX) return [];
      const off = scales.find((x) => !Number.isInteger(round6(v * x.scale)));
      return off ? [`${L.name(e.index)} is ${round6(v)}px ${what}: ${round6(v * off.scale)} device px at ${off.viewport[0]}×${off.viewport[1]}`] : [];
    });
    if (bad.length) out.push(make(rule, e.path, `${bad.join("; ")} (a painted line UI Toolkit draws on whole device px)`,
      `Give a painted line or bar under ${THIN_BOX_PX}px a thickness of ${lengths}, a whole number of device pixels at every exact viewport the kit ` +
      `declares (${scales.map((x) => `${x.viewport[0]}×${x.viewport[1]}`).join(", ")}), or make it ${THIN_BOX_PX}px or more. UI Toolkit puts both of its ` +
      `edges on whole device pixels, so any other thickness comes out thicker or vanishes where Chromium draws the fraction anti-aliased.`));
  }
  return out;
}

/** The width Chromium lays out and paints for a declared one: whole CSS px, rounded down, never below 1 (0 stays 0). */
export function chromiumBorderWidth(declared: number): number {
  return declared <= 0 ? 0 : declared < 1 ? 1 : Math.floor(declared);
}

/**
 * Border widths on the device grid (docs/findings/borders.md): Chromium lays a border out and paints it at its exact device
 * width (2px at scale 0.75: 1.5 device px, one solid pixel and an anti-aliased one, the content 1.5 px in), UI Toolkit lays
 * out and paints whole device pixels (rounding half up, at least 1: 2). No width the compiler could write makes Unity paint
 * a fraction, so a border is an error unless its width is whole device px at every exact viewport the kit declares. The same
 * holds for the hard edges of a box-shadow without blur (a spread ring, an offset copy): its offsets and spread.
 */
export const rule: Rule = {
  id: "U-CSS-040", severity: "error",
  check(s, kit) {
    const scales = kitScales(kit);
    const ok = wholeBorderWidths(scales.map((x) => x.scale));
    const list = ok.length ? `${ok.map((w) => `${w}px`).join(", ")} …` : "none below 64px";
    const fix = `Use a border width that is a whole number of device pixels at every exact viewport the kit declares ` +
      `(${scales.map((x) => `${x.viewport[0]}×${x.viewport[1]}`).join(", ")}): ${list}, or no border; the same lengths for a ` +
      `line drawn as an element and for the offsets and spread of a box-shadow without blur. UI Toolkit draws a ` +
      `border as whole device pixels, rounding 1.5 up to 2, where Chromium draws the fraction anti-aliased; the layout after the ` +
      `border moves with it, and a baked hard shadow edge falls between pixels.`;
    // a width without a visible style paints and lays out nothing (`border: none` sets every width to medium)
    const NONE = /^(none|hidden)$/i;
    const styled = (i: number, side: string) => s.elements[i].computed[`border-${side}-style`] !== undefined && !NONE.test(s.elements[i].computed[`border-${side}-style`].trim())
      || sourcesOf(s)[i].some((src) => declsAt(src, i).some((x) => x.name === `border-${side}-style` && !NONE.test(x.value.trim())));
    const offGrid = (v: number) => scales.find((x) => !Number.isInteger(round6(v * x.scale)));
    return [...declRule(s, rule, fix, (d, v, src, t) => {
      if (d.name === "box-shadow") {
        // a shadow without blur has hard edges: its offsets and spread draw edges on the device grid only when whole there
        const { outer, inset } = splitShadows(v);
        for (const item of [...outer, ...inset]) {
          let p; try { p = parseShadow(item, {}); } catch { continue; }
          if (p.blur > 0) continue;
          for (const [what, len] of [["offset", p.ox], ["offset", p.oy], ["spread", p.spread]] as const) {
            const off = offGrid(len);
            if (off) return `box-shadow ${item.trim()}: its ${what} ${len}px is ${round6(len * off.scale)} device px at ${off.viewport[0]}×${off.viewport[1]} (a hard edge without blur)`;
          }
        }
        return null;
      }
      if (!WIDTHS.has(d.name)) return null;
      const side = d.name.split("-")[1];
      if (declsAt(src, t.element?.index ?? null).some((x) => x.name === `border-${side}-style` && NONE.test(x.value.trim()))) return null;
      if (t.element && src.elements.length && !src.elements.some((i) => styled(i, side))) return null;
      const raw = v.trim().toLowerCase();
      // rem and em resolve like the exporter's computed width (0.125rem is 2px)
      const rel = /^(-?(?:\d+\.?\d*|\.\d+))(r?em)$/.exec(raw);
      const em = rel ? (rel[2] === "rem" ? s.rootFontSize : px(t.element?.computed["font-size"]) ?? s.rootFontSize) : 0;
      const declared = raw in KEYWORDS ? KEYWORDS[raw] : rel ? Number(rel[1]) * em : px(raw);
      if (declared === null) return null;
      const w = chromiumBorderWidth(declared);
      if (w === 0) return null;
      const off = scales.find((x) => !Number.isInteger(round6(w * x.scale)));
      return off ? `${declText(d, v)} is ${round6(w * off.scale)} device px at ${off.viewport[0]}×${off.viewport[1]}` : null;
    }, { keyframes: true, pseudo: true }), ...thinBoxes(s, scales, ok)];
  },
};
