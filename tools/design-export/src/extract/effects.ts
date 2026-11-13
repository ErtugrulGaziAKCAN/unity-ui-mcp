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
import { backgroundIssues, gradientStopGap, gradientToSvg, reportedElsewhere } from "../bake/gradient.js";
import { bakeShadow, shadowIssues, splitShadows } from "../bake/shadow.js";
import { transitionsAt } from "./anims.js";
import { writeAsset } from "./assets.js";
import { dimsOf, keyOf, subset } from "./layers.js";
import { fmt } from "./naming.js";
import { px } from "../lint/css-values.js";
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

/** Border widths in px (a side without a visible style has none). */
function borderWidths(eff: (p: string) => string | undefined): [number, number, number, number] {
  return SIDES.map((s) => {
    const st = eff(`border-${s}-style`);
    if (!st || /^(none|hidden)$/i.test(st)) return 0;
    const w = eff(`border-${s}-width`) ?? "medium";
    return WIDTH_KEYWORDS[w] ?? (parseFloat(w) || 0);
  }) as [number, number, number, number];
}
const opaque = (c: string | undefined) => /^#[0-9a-f]{6}$/.test(normalizeColor(c ?? "rgba(0, 0, 0, 0)"));
const usesEm = (v: string | undefined) => !!v && /\d(em)\b/i.test(v);
const usesCurrent = (v: string | undefined) => !!v && /currentcolor/i.test(v);
const colourless = (v: string | undefined) => !!v && splitTopLevel(v, ",").some((item) => !splitTopLevel(item, " ").some((t) => !/^inset$/i.test(t) && !/^[-+.\d]/.test(t) && !/^currentcolor$/i.test(t)));

/**
 * Why the element's shadows or background images cannot be baked, for every layer (empty when they can): what the bake
 * itself rejects (the same conversion runs on the element's box), a transition of box-shadow or background-image or of
 * a property that changes the baked image in that layer (UI Toolkit swaps the image; nothing interpolates it), images UI
 * Toolkit cannot draw as one background, gradients laid out other than over the whole padding box. Shared by lint
 * U-CSS-014 and the export, which throws it.
 */
export function effectProblems(ex: StyleExtractor, i: number): string[] {
  const out = new Set<string>();
  const box = ex.baseBox(i) ?? { w: 100, h: 100 };
  const baseEff = (p: string) => ex.effective(i, [], p)?.entry.value;
  for (const [key, m] of ex.raw(i)) {
    const dims = dimsOf(key);
    const eff = (p: string) => ex.effective(i, dims, p)?.entry.value;
    const where = key === "base" ? "" : `layer ${key}: `;
    const shadow = eff("box-shadow"), bg = eff("background-image");
    const fontSize = px(eff("font-size")) ?? undefined, rootFontSize = ex.s.rootFontSize;
    if (key !== "base") {
      // a transition of the effect, or of what the baked image depends on in this layer
      const why = new Map<string, string>();
      for (const p of ["box-shadow", "background-image"]) if (m.has(p)) why.set(p, "");
      const sh = splitShadows(shadow ?? "none"), shBase = splitShadows(baseEff("box-shadow") ?? "none");
      const outer = sh.outer.length + shBase.outer.length > 0, inset = sh.inset.length + shBase.inset.length > 0;
      const gradient = isGradient(bg) || isGradient(baseEff("background-image"));
      if (outer || inset) for (const r of RADII) if (m.has(r)) why.set(r, ", which changes the baked shadow");
      if ((inset || gradient) && SIDES.some((sd) => m.has(`border-${sd}-width`) || m.has(`border-${sd}-style`))) {
        for (const sd of SIDES) for (const p of [`border-${sd}-width`, `border-${sd}-style`]) if (m.has(p)) why.set(p, `, which changes the baked ${gradient ? "gradient" : "shadow"}`);
      }
      if (outer && m.has("background-color") && opaque(eff("background-color")) !== opaque(baseEff("background-color"))) why.set("background-color", ", which changes the baked shadow (opaque and translucent backgrounds clip it differently)");
      if (m.has("color") && ((colourless(shadow) || colourless(baseEff("box-shadow"))) || usesCurrent(bg) || usesCurrent(baseEff("background-image")))) why.set("color", ", which colours the baked image");
      if (m.has("font-size") && (usesEm(shadow) || usesEm(baseEff("box-shadow")) || usesEm(bg))) why.set("font-size", ", which sizes the baked image");
      if (why.size) {
        for (const [at, phase] of [[key, "entering"], ["base", "leaving"]] as const) {
          for (const [p, t] of transitionsAt(ex, i, at, Array.from(why.keys()))) {
            if (t.duration > 0 || t.delay > 0) out.add(`${p} changes in layer ${key} with a ${t.duration}ms transition (${phase})${why.get(p)}`);
          }
        }
      }
    }
    if (shadow && (key === "base" || m.has("box-shadow") || m.has("font-size"))) for (const x of shadowIssues(shadow, { fontSize, rootFontSize })) out.add(`${where}${x}`);
    if (key !== "base" && !["background-image", "background-size", "background-position-x", "background-position-y", "background-repeat", "font-size", "color"].some((p) => m.has(p)) &&
      !SIDES.some((sd) => m.has(`border-${sd}-width`) || m.has(`border-${sd}-style`))) continue;
    if (!bg) continue;
    const issues = backgroundIssues(bg);
    for (const issue of issues) out.add(`${where}${issue}`);
    if (!isGradient(bg)) continue;
    // a gradient image is the positioning area: no smaller tile, no length offset (they would tile or shift it)
    const items = splitTopLevel(bg, ",");
    const nth = (v: string | undefined, k: number, fb: string) => { const l = splitTopLevel(v ?? fb, ","); return (l[k % l.length] ?? fb).trim(); };
    items.forEach((item, k) => {
      if (!isGradient(item)) return;
      const size = nth(eff("background-size"), k, "auto");
      const parts = splitTopLevel(size, " ");
      const fills = /^(cover|contain)$/i.test(size) || (parts.length <= 2 && parts.every((x) => /^(auto|100%)$/i.test(x)));
      if (!fills) out.add(`${where}a gradient with background-size ${size} (it must fill the element: auto or 100%)`);
      for (const axis of ["x", "y"] as const) {
        const pos = nth(eff(`background-position-${axis}`), k, "0%");
        const offset = splitTopLevel(pos, " ").filter((x) => /^-?[\d.]/.test(x) && !/%$/.test(x) && !/^-?0(px)?$/.test(x));
        if (offset.length) out.add(`${where}a gradient with background-position-${axis} ${pos} (only percentages and keywords keep it in place)`);
      }
    });
    // the conversion itself, on the element's box: whatever the export would reject
    if (!issues.length && !reportedElsewhere(bg)) {
      try { gradientToSvg(bg, box.w, box.h, { borders: borderWidths(eff), color: eff("color") ?? "#000000", fontSize, rootFontSize, repeat: eff("background-repeat") }); }
      catch (e) { out.add(`${where}${(e as Error).message}`); }
    }
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
  const watched = ["box-shadow", "background-image", "background-color", "background-repeat", "color", "font-size", ...RADII, ...BORDER];
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

  const values = new Map<string, { shadow: IrShadow | null; inset: IrShadow | null; background: IrAsset | null }>();
  for (const at of ats) {
    const eff = (p: string) => ex.effective(i, at.dims, p)?.entry;
    const color = eff("color")?.value ?? normalizeColor(c.computedColor);
    const lctx = { fontSize: px(eff("font-size")?.value) ?? c.fontSize, rootFontSize: c.rootFontSize };
    const box = at.box;
    const corners: Record<string, string> = {};
    for (const k of CORNERS) { const v = eff(cornerProperty(k))?.value; if (v !== undefined) corners[k] = v; }
    const radii = resolveRadii(corners, box ?? { w: 1e6, h: 1e6 }, lctx);
    if (!radii) throw new Error(`${where}: border radius cannot be resolved for the shadow bake`);
    const radius = `${CORNERS.map((k) => `${fmt(radii[k].x)}px`).join(" ")} / ${CORNERS.map((k) => `${fmt(radii[k].y)}px`).join(" ")}`;
    const borders = borderWidths((p) => eff(p)?.value);
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
        const gopts = { borders, color, ...lctx, repeat: eff("background-repeat")?.value };
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
