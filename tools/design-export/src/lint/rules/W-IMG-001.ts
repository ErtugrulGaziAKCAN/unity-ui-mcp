import { logicalViewport } from "../../viewport.js";
import { px } from "../css-values.js";
import type { SnapElement } from "../snapshot.js";
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
  const bs = (k["background-size"] ?? "auto").split(",")[0].trim();
  if (bs === "cover" || bs === "contain") return fit(natural, area, bs);
  const [a, b = "auto"] = bs.split(/\s+/);
  const w = bgLength(a, area.w), h = bgLength(b, area.h);
  if (w === null && h === null) return natural;
  if (w === null) return { w: (h! * natural.w) / natural.h, h: h! };
  if (h === null) return { w: w, h: (w * natural.h) / natural.w };
  return { w, h };
}

/**
 * A raster image drawn larger than its pixels at a declared viewport: both the browser and Unity scale it up there, and
 * they resample differently (at 3840×2160 a picture drawn at 1.5 times its pixel size measured element SSIM 0.948–0.962
 * against the picture limit 0.985). The design exports every raster image with at least as many pixels as its largest
 * drawn size at the largest declared viewport and gives it its size in CSS (an `<img>` width and height, a
 * background-size), not its natural size.
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
      const drawn = drawnSize(e);
      if (!drawn) continue;
      const need = { w: Math.ceil(drawn.w * largest.scale - 0.5), h: Math.ceil(drawn.h * largest.scale - 0.5) };
      if (e.image.w >= need.w && e.image.h >= need.h) continue;
      const name = decodeURIComponent(e.image.src.replace(/^.*\//, "").replace(/[?#].*$/, ""));
      const where = scales.filter((x) => e.image!.w < drawn.w * x.scale - 0.5 || e.image!.h < drawn.h * x.scale - 0.5)
        .map((x) => `${x.v[0]}×${x.v[1]}`).join(", ");
      out.push(make(rule, e.path,
        `image "${name}" is ${e.image.w}×${e.image.h} px and drawn at ${round(drawn.w)}×${round(drawn.h)} px, ` +
        `${round(drawn.w * largest.scale)}×${round(drawn.h * largest.scale)} device px at ${largest.v[0]}×${largest.v[1]}: ` +
        `scaled up at ${where}`,
        `Export "${name}" at ${need.w}×${need.h} px or more (its drawn size at the largest declared viewport, ${largest.v[0]}×${largest.v[1]}) ` +
        (e.tag === "img"
          ? `and keep the <img>'s width and height in CSS`
          : `and draw it with a background-size (${round(drawn.w)}px ${round(drawn.h)}px here) rather than its natural size`) +
        `: Unity and the browser resample a picture drawn larger than its pixels differently.`));
    }
    return out;
  },
};
