/**
 * Effects USS cannot draw, per style layer: outer and inset box-shadows (baked 9-slices) and background images (url()
 * assets and baked gradient SVGs). A layer gets its own bake when its value differs from what the layers inside it
 * give — another shadow or gradient (a hover lift), or the same one for another box (radii, size, borders) — so the
 * compiler swaps images per layer exactly like it swaps USS rules.
 *
 * `effectProblems` is shared with lint U-CSS-014, so a design lint accepts is one the export can bake.
 */
import type { Page } from "playwright";
import type { IrAsset, IrNode, IrShadow } from "../ir/types.js";
import { splitTopLevel } from "../lint/css-values.js";
import { CORNERS, cornerProperty, resolveRadii } from "../lint/resolve/radius.js";
import type { Size } from "../lint/snapshot.js";
import { backgroundIssues, gradientStopGap, gradientToSvg } from "../bake/gradient.js";
import { bakeShadow, splitShadows } from "../bake/shadow.js";
import { transitionsAt } from "./anims.js";
import { writeAsset } from "./assets.js";
import { dimsOf, keyOf, subset } from "./layers.js";
import { fmt } from "./naming.js";
import { normalizeColor, unions, type StyleExtractor } from "./styles.js";

export type NodeEffects = Pick<IrNode, "shadow" | "shadowLayers" | "insetShadow" | "insetShadowLayers" | "background" | "backgroundLayers">;
export const NO_EFFECTS = (): NodeEffects => ({ shadow: null, shadowLayers: {}, insetShadow: null, insetShadowLayers: {}, background: null, backgroundLayers: {} });

const SIDES = ["top", "right", "bottom", "left"] as const;
const WIDTH_KEYWORDS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
const RADII = CORNERS.map(cornerProperty);
const BORDER = SIDES.flatMap((s) => [`border-${s}-width`, `border-${s}-style`]);
const isGradient = (v: string | undefined) => !!v && /(linear|radial)-gradient\(/i.test(v);
const shadowOf = (v: string | undefined) => !!v && !/^none$/i.test(v.trim());

/** The element has a box-shadow or a gradient background in some layer (the effects need its layer boxes). */
export function hasEffects(ex: StyleExtractor, i: number): boolean {
  for (const m of ex.raw(i).values()) {
    if (shadowOf(m.get("box-shadow")?.value) || isGradient(m.get("background-image")?.value)) return true;
  }
  return false;
}

/**
 * Why the element's shadows or background images cannot be baked, for every layer (empty when they can): a transition
 * of box-shadow or background-image (UI Toolkit swaps the image; the animation player cannot interpolate it), images
 * UI Toolkit cannot draw as one background, gradients laid out other than over the whole padding box.
 */
export function effectProblems(ex: StyleExtractor, i: number): string[] {
  const out = new Set<string>();
  for (const [key, m] of ex.raw(i)) {
    const dims = dimsOf(key);
    const eff = (p: string) => ex.effective(i, dims, p)?.entry.value;
    const changed = ["box-shadow", "background-image"].filter((p) => m.has(p));
    if (key !== "base" && changed.length) {
      for (const [at, phase] of [[key, "entering"], ["base", "leaving"]] as const) {
        for (const [p, t] of transitionsAt(ex, i, at, changed)) {
          if (t.duration > 0 || t.delay > 0) out.add(`${p} changes in layer ${key} with a ${t.duration}ms transition (${phase})`);
        }
      }
    }
    if (key !== "base" && !["background-image", "background-size", "background-position-x", "background-position-y"].some((p) => m.has(p))) continue;
    const bg = eff("background-image");
    if (!bg) continue;
    for (const issue of backgroundIssues(bg)) out.add(`${key === "base" ? "" : `layer ${key}: `}${issue}`);
    if (!isGradient(bg)) continue;
    // a gradient image is the positioning area: no smaller tile, no length offset (they would tile or shift it)
    const items = splitTopLevel(bg, ",");
    const nth = (v: string | undefined, k: number, fb: string) => { const l = splitTopLevel(v ?? fb, ","); return (l[k % l.length] ?? fb).trim(); };
    items.forEach((item, k) => {
      if (!isGradient(item)) return;
      const size = nth(eff("background-size"), k, "auto");
      const parts = splitTopLevel(size, " ");
      const fills = /^(cover|contain)$/i.test(size) || (parts.length <= 2 && parts.every((x) => /^(auto|100%)$/i.test(x)));
      if (!fills) out.add(`${key === "base" ? "" : `layer ${key}: `}a gradient with background-size ${size} (it must fill the element: auto or 100%)`);
      for (const axis of ["x", "y"] as const) {
        const pos = nth(eff(`background-position-${axis}`), k, "0%");
        const offset = splitTopLevel(pos, " ").filter((x) => /^-?[\d.]/.test(x) && !/%$/.test(x) && !/^-?0(px)?$/.test(x));
        if (offset.length) out.add(`${key === "base" ? "" : `layer ${key}: `}a gradient with background-position-${axis} ${pos} (only percentages and keywords keep it in place)`);
      }
    });
  }
  return Array.from(out);
}

export interface EffectContext {
  ex: StyleExtractor;
  /** Bake page (see openBakePage). */
  page: () => Promise<Page>;
  outDir: string;
  /** Layer key → element index → border box measured with that layer applied. */
  boxes: Map<string, Map<number, Size>> | undefined;
  /** url() of a background-image (absolute) → its asset. */
  urlAsset: (abs: string) => IrAsset;
  /** Absolute URLs of the url()s in a value, against its base. */
  urls: (value: string, base: string | undefined) => string[];
  computedColor: string;
  fontSize: number | undefined;
  rootFontSize: number;
}

interface At { key: string; dims: string[]; box: Size | null }

/** Per-layer shadows and background images of element `i` (see NodeEffects). Throws what effectProblems reports. */
export async function nodeEffects(i: number, c: EffectContext, where: string): Promise<NodeEffects> {
  const { ex } = c;
  if (!hasEffects(ex, i) && !Array.from(ex.raw(i).values()).some((m) => m.has("background-image"))) return NO_EFFECTS();
  const problems = effectProblems(ex, i);
  if (problems.length) throw new Error(`${where}: ${problems.join("; ")}`);

  // layers that can change an effect: the effect properties, the box (radii, size, borders), colours they read
  const raw = ex.raw(i);
  const watched = ["box-shadow", "background-image", "background-color", "color", ...RADII, ...BORDER];
  const sets = new Map<string, string[]>();
  for (const [key, m] of raw) if (key !== "base" && watched.some((p) => m.has(p))) sets.set(key, dimsOf(key));
  for (const [key, els] of c.boxes ?? []) if (key !== "base" && els.has(i)) sets.set(key, dimsOf(key));
  for (const u of unions(Array.from(sets.values()), ex.breakpoints)) sets.set(keyOf(u), u);
  const baseBox = ex.baseBox(i);
  const boxAt = (dims: string[]): Size | null => {
    let best: { n: number; key: string; box: Size } | null = null;
    for (const [key, els] of c.boxes ?? []) {
      const b = els.get(i), kd = dimsOf(key);
      if (!b || !subset(kd, dims)) continue;
      if (!best || kd.length > best.n || (kd.length === best.n && key < best.key)) best = { n: kd.length, key, box: b };
    }
    return best?.box ?? baseBox;
  };
  const ats: At[] = [{ key: "base", dims: [], box: baseBox }, ...Array.from(sets, ([key, dims]) => ({ key, dims, box: boxAt(dims) }))]
    .sort((a, b) => a.dims.length - b.dims.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const lctx = { fontSize: c.fontSize, rootFontSize: c.rootFontSize };
  const values = new Map<string, { shadow: IrShadow | null; inset: IrShadow | null; background: IrAsset | null }>();
  for (const at of ats) {
    const eff = (p: string) => ex.effective(i, at.dims, p)?.entry;
    const color = eff("color")?.value ?? normalizeColor(c.computedColor);
    const box = at.box;
    const corners: Record<string, string> = {};
    for (const k of CORNERS) { const v = eff(cornerProperty(k))?.value; if (v !== undefined) corners[k] = v; }
    const radii = resolveRadii(corners, box ?? { w: 1e6, h: 1e6 }, lctx);
    if (!radii) throw new Error(`${where}: border radius cannot be resolved for the shadow bake`);
    const radius = `${CORNERS.map((k) => `${fmt(radii[k].x)}px`).join(" ")} / ${CORNERS.map((k) => `${fmt(radii[k].y)}px`).join(" ")}`;
    const borders = SIDES.map((s) => {
      const st = eff(`border-${s}-style`)?.value;
      if (!st || /^(none|hidden)$/i.test(st)) return 0;
      const w = eff(`border-${s}-width`)?.value ?? "medium";
      return WIDTH_KEYWORDS[w] ?? (parseFloat(w) || 0);
    }) as [number, number, number, number];
    const bgColor = normalizeColor(eff("background-color")?.value ?? "rgba(0, 0, 0, 0)");
    const sh = splitShadows(eff("box-shadow")?.value ?? "none");
    const opts = { box: box ?? undefined, borders, color, opaqueBackground: /^#[0-9a-f]{6}$/.test(bgColor), ...lctx };
    const page = sh.outer.length || sh.inset.length ? await c.page() : null;
    const shadow = sh.outer.length ? await bakeShadow(page!, sh.outer.join(", "), radius, c.outDir, opts) : null;
    const inset = sh.inset.length ? await bakeShadow(page!, sh.inset.join(", "), radius, c.outDir, opts) : null;
    let background: IrAsset | null = null;
    const bg = eff("background-image");
    if (bg && !/^none$/i.test(bg.value.trim())) {
      // one url() is an asset; anything else is baked as gradients (the bake rejects what it cannot reproduce)
      if (!/^url\(/i.test(bg.value.trim()) || splitTopLevel(bg.value, ",").length > 1) {
        const b = box ?? { w: 1, h: 1 };
        const gopts = { borders, color, ...lctx };
        const svg = gradientToSvg(bg.value, b.w, b.h, gopts);
        background = writeAsset(c.outDir, Buffer.from(svg, "utf8"), "svg", "svg", b.w, b.h, false, gradientStopGap(bg.value, b.w, b.h, gopts));
      } else {
        const [u] = c.urls(bg.value, bg.base);
        if (u) background = c.urlAsset(u);
      }
    }
    values.set(at.key, { shadow, inset, background });
  }

  // a layer is recorded when it differs from base or from a recorded layer inside it (so the compiler never applies
  // an inner layer's image where this one holds)
  const sig = (a: IrAsset | null) => (a === null ? "none" : `${a.sha256}\u0000${JSON.stringify((a as IrShadow).offset ?? null)}\u0000${a.width}x${a.height}`);
  const pick = <T extends IrAsset | null>(get: (v: { shadow: IrShadow | null; inset: IrShadow | null; background: IrAsset | null }) => T): [T, Record<string, T>] => {
    const base = get(values.get("base")!);
    const recorded = new Map<string, T>();
    for (const at of ats) {
      if (at.key === "base") continue;
      const v = get(values.get(at.key)!);
      const differs = sig(v) !== sig(base) || Array.from(recorded).some(([k, r]) => subset(dimsOf(k), at.dims) && sig(r) !== sig(v));
      if (differs) recorded.set(at.key, v);
    }
    return [base, Object.fromEntries(Array.from(recorded).sort((a, b) => (a[0] < b[0] ? -1 : 1)))];
  };
  const [shadow, shadowLayers] = pick((v) => v.shadow);
  const [insetShadow, insetShadowLayers] = pick((v) => v.inset);
  const [background, backgroundLayers] = pick((v) => v.background);
  return { shadow, shadowLayers, insetShadow, insetShadowLayers, background, backgroundLayers };
}
