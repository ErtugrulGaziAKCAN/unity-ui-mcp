import { logicalViewport } from "../../viewport.js";
import { px, splitTopLevel } from "../css-values.js";
import { splitTransform } from "../resolve/transform.js";
import type { DomSnapshot, SnapElement } from "../snapshot.js";
import type { Rule } from "../types.js";
import { isExternal, make, nonDesign } from "./util.js";

type Size = { w: number; h: number };
const round = (n: number) => Math.round(n * 100) / 100;

/** The size an image of natural size `n` is drawn at in a box `box` for a fit (object-fit, or background-size cover/contain). */
function fit(n: Size, box: Size, mode: string): Size {
  const contain = Math.min(box.w / n.w, box.h / n.h), cover = Math.max(box.w / n.w, box.h / n.h);
  switch (mode) {
    case "contain": return { w: n.w * contain, h: n.h * contain };
    case "cover": return { w: n.w * cover, h: n.h * cover };
    case "none": return n;
    case "scale-down": return contain < 1 ? { w: n.w * contain, h: n.h * contain } : n;
    default: return box; // fill
  }
}

/** One background-size length (px or % of the positioning area), or null for auto. */
const bgLength = (v: string, of: number): number | null => (v === "auto" ? null : v.endsWith("%") ? (parseFloat(v) / 100) * of : px(v));

/**
 * The CSS size the element draws its image at: an `<img>` by its object-fit in its content box, a background image by
 * its background-size in its padding box (auto: the natural size, one auto keeps the aspect ratio). Null when it has no
 * box.
 */
export function drawnSize(e: SnapElement): Size | null {
  const img = e.image, size = e.size;
  if (!img || !size || img.w <= 0 || img.h <= 0) return null;
  const k = e.computed;
  const side = (p: string) => (px(k[p]) ?? 0);
  const borders = { w: side("border-left-width") + side("border-right-width"), h: side("border-top-width") + side("border-bottom-width") };
  const natural = { w: img.w, h: img.h };
  if (e.tag === "img") {
    const content = { w: size.w - borders.w - side("padding-left") - side("padding-right"), h: size.h - borders.h - side("padding-top") - side("padding-bottom") };
    if (content.w <= 0 || content.h <= 0) return null;
    return fit(natural, content, (k["object-fit"] ?? "fill").trim());
  }
  const area = { w: size.w - borders.w, h: size.h - borders.h };
  if (area.w <= 0 || area.h <= 0) return null;
  // the background-size of the image's own layer (a shorter list repeats)
  const sizes = splitTopLevel(k["background-size"] ?? "auto", ",");
  const bs = (sizes[(img.layer ?? 0) % Math.max(1, sizes.length)] ?? "auto").trim();
  if (bs === "cover" || bs === "contain") return fit(natural, area, bs);
  const [a, b = "auto"] = bs.split(/\s+/);
  const w = bgLength(a, area.w), h = bgLength(b, area.h);
  if (w === null && h === null) return natural;
  if (w === null) return { w: (h! * natural.w) / natural.h, h: h! };
  if (h === null) return { w: w, h: (w * natural.h) / natural.w };
  return { w, h };
}

/** The larger axis factor of a CSS `scale` value ("1.4", "1.4 1.2", "140%"), or null. */
function scaleValue(v: string | undefined): number | null {
  if (!v || v.trim() === "none") return null;
  const parts = v.trim().split(/\s+/).map((p) => (p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p)));
  return parts.length && parts.every(Number.isFinite) ? Math.max(...parts.slice(0, 2).map(Math.abs)) : null;
}

/** The larger axis factor of a CSS `transform` value (a computed matrix() or an authored list), or null. */
function transformScale(v: string | undefined): number | null {
  if (!v || v.trim() === "none") return null;
  const m = /^matrix\(([^)]*)\)$/.exec(v.trim());
  if (m) {
    const [a, b, c, d] = m[1].split(",").map(Number);
    return [a, b, c, d].every(Number.isFinite) ? Math.max(Math.hypot(a, b), Math.hypot(c, d)) : null;
  }
  const r = splitTransform(v);
  return r.ok && r.split.scale ? Math.max(Math.abs(r.split.scale[0]), Math.abs(r.split.scale[1])) : null;
}

/**
 * The largest scale an element is drawn at by its own transforms: its computed `scale` and `transform` now, and any
 * `scale` or `transform` a rule that reaches it (in any state: hover, a class, a screen state) or a keyframe animation it
 * uses gives it. Its ancestors' multiply (`scaleOf`).
 */
function ownScale(s: DomSnapshot, i: number): number {
  const e = s.elements[i];
  let now = 1;
  const sv = scaleValue(e.computed["scale"]);
  const tv = transformScale(e.computed["transform"]);
  if (sv !== null) now *= sv;
  if (tv !== null) now *= tv;
  let most = now;
  const names = new Set<string>();
  for (const r of s.rules) {
    if (!r.selectors.some((x) => x.elements?.includes(i))) continue;
    for (const d of r.decls) {
      const f = d.name === "scale" ? scaleValue(d.value) : d.name === "transform" ? transformScale(d.value) : null;
      if (f !== null) most = Math.max(most, f);
      if (d.name === "animation-name") for (const n of splitTopLevel(d.value, ",")) names.add(n.trim());
    }
  }
  for (const k of s.keyframes)
    if (names.has(k.name))
      for (const frame of k.frames)
        for (const d of frame.decls) {
          const f = d.name === "scale" ? scaleValue(d.value) : d.name === "transform" ? transformScale(d.value) : null;
          if (f !== null) most = Math.max(most, f);
        }
  return most;
}

/** The largest scale the element is drawn at by its own and its ancestors' transforms (1 without any). */
export function scaleOf(s: DomSnapshot, i: number): number {
  let k = 1;
  for (let j = i; j >= 0; j = s.elements[j].parent) k *= ownScale(s, j);
  return k;
}

/** A readable name for an image source: its file name (decoded when it decodes), a data URI's type. */
export function imageName(src: string): string {
  if (/^data:/i.test(src)) return `${/^data:([^;,]*)/i.exec(src)?.[1] || "data"} data URI`;
  const raw = src.replace(/[?#].*$/, "").replace(/^.*\//, "");
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/**
 * A raster image drawn larger than its pixels at a declared viewport: both the browser and Unity scale it up there, and
 * they resample differently (at 3840×2160 a picture drawn at 1.5 times its pixel size measured element SSIM 0.948–0.962
 * against the picture limit 0.985). The design exports every raster image with at least as many pixels as its largest
 * drawn size at the largest declared viewport (a scale the element or an ancestor gets in a state or an animation
 * included) and gives it its size in CSS (an `<img>` width and height, a background-size), not its natural size.
 */
export const rule: Rule = {
  id: "W-IMG-001", severity: "warning",
  check(s, kit) {
    const viewports = kit.viewports.length ? kit.viewports : [kit.reference];
    const scales = viewports.map((v) => ({ v, scale: logicalViewport(v, kit.reference, kit.screenMatch).scale })).sort((a, b) => b.scale - a.scale);
    const largest = scales[0];
    if (!largest) return [];
    const out = [];
    for (const e of s.elements) {
      // a one-pixel image is a flat colour: scaled up, both renderers draw the same colour
      if (!e.image?.raster || (e.image.w <= 1 && e.image.h <= 1) || !e.rendered || nonDesign(s)[e.index] || isExternal(s, e.index)) continue;
      const css = drawnSize(e);
      if (!css) continue;
      const k = scaleOf(s, e.index);
      const drawn = { w: css.w * k, h: css.h * k };
      const need = { w: Math.ceil(drawn.w * largest.scale - 0.5), h: Math.ceil(drawn.h * largest.scale - 0.5) };
      if (e.image.w >= need.w && e.image.h >= need.h) continue;
      const name = imageName(e.image.src);
      const where = scales.filter((x) => e.image!.w < drawn.w * x.scale - 0.5 || e.image!.h < drawn.h * x.scale - 0.5)
        .map((x) => `${x.v[0]}×${x.v[1]}`).join(", ");
      out.push(make(rule, e.path,
        `image "${name}" is ${e.image.w}×${e.image.h} px and drawn at ${round(drawn.w)}×${round(drawn.h)} px${k !== 1 ? ` (scaled ${round(k)})` : ""}, ` +
        `${round(drawn.w * largest.scale)}×${round(drawn.h * largest.scale)} device px at ${largest.v[0]}×${largest.v[1]}: ` +
        `scaled up at ${where}`,
        `Export "${name}" at ${need.w}×${need.h} px or more (its drawn size at the largest declared viewport, ${largest.v[0]}×${largest.v[1]}) ` +
        (e.tag === "img"
          ? `and keep the <img>'s width and height in CSS`
          : `and draw it with a background-size (${round(css.w)}px ${round(css.h)}px here) rather than its natural size`) +
        `: Unity and the browser resample a picture drawn larger than its pixels differently.`));
    }
    return out;
  },
};
