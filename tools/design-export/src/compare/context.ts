/**
 * What the IR adds to the comparison of one capture: paint order, the baked outer shadow active in the capture (for
 * the element SSIM region and the shadow band, spec §15), and which elements paint a background (colour samples).
 *
 * The IR is read loosely: a node without `shadowLayers`/`backgroundLayers` (IR written before per-layer effects)
 * simply has no layered effect, and a missing or unreadable IR leaves the comparison without these extras (the
 * report says so). Layer resolution follows the IR's StyleLayers rule: a layer holds when every dimension holds, and
 * the holding layer with the most dimensions that sets a value wins (layers that hold together appear as their union).
 */
import type { CaptureBoxes } from "../boxes/types.js";
import { breakpointsHold, type CaptureApply } from "../capture/matrix.js";
import type { BoxRect, IrScreen } from "../ir/types.js";
import { colorAlpha, isTransparentColor } from "./color.js";
import type { Rect } from "./ssim.js";

/** Per-capture facts from the IR; every field is optional (absent: the comparison works from the boxes alone). */
export interface CaptureContext {
  /** Element ids in paint order (IR pre-order: an element paints after its ancestors and earlier subtrees). */
  order?: string[];
  /** The screen root (its region is the whole capture, measured by the whole-capture SSIM). */
  root?: string | null;
  /** Each element's parent id (IR); absent: no element counts as another's descendant. */
  parent?: ReadonlyMap<string, string>;
  /** Outer baked shadow rect per element active in this capture, in device px (element box + IR `shadow.offset` × scale). */
  shadows?: Record<string, Rect>;
  /** Elements that paint a background in this capture (colour, gradient or image); null or absent: every element. */
  backgrounds?: ReadonlySet<string> | null;
  /**
   * Elements that paint anything of their own in this capture (background, border, content image or vector, baked
   * shadow): only these can cover another element's colour samples. Null or absent: every visible element counts.
   */
  painters?: ReadonlySet<string> | null;
  /**
   * Elements whose fill hides what is under it: a background colour of alpha ≥ 0.99 under an opacity (its own times its
   * ancestors') of 0.99 or more. Only these exclude a text's pixels from its ink check, within their painted shape (box and
   * corner radii); a translucent scrim, a border-only box, a picture or a shadow does not. Absent: nothing is excluded.
   */
  opaque?: ReadonlySet<string> | null;
  /** Painted border widths per element in device px (top, right, bottom, left); absent: no border known. */
  borders?: Record<string, [number, number, number, number]>;
  /** Font size of each text element in device px (its `font-size` in this capture times the capture scale). */
  fontPx?: Record<string, number>;
  /** Corner radii per element in device px (top-left, top-right, bottom-right, bottom-left); absent: square corners. */
  radii?: Record<string, [number, number, number, number]>;
  /** Elements that draw a raster picture (IR asset kind `image`) at another size than its own, in device px. */
  pictures?: ReadonlySet<string>;
  /** Text elements whose `text-shadow` in this capture has a blur radius above 0 (a glow around the glyphs). */
  textShadows?: ReadonlySet<string>;
  /**
   * Elements an animation sample shows rotated off the axes: the design's rotation on the screen (golden boxes
   * `rotation`) is not a multiple of 90°. Empty for static captures.
   */
  rotated?: ReadonlySet<string>;
  /** An animation sample (Chromium draws a running animation's element from its composited layer, resampled). */
  anim?: boolean;
  /**
   * In an animation sample, the elements its running animations move and their descendants (they move with them): an
   * animation counts when it changes geometry (GEOMETRY_PROPERTIES: transform and its parts, position and size; not a
   * colour, an opacity, a filter or a shadow; one whose properties the IR does not list counts too). A moved edge Chromium
   * draws from its resampled layer at a fractional device offset (`ssimRoundEdge`); such an element's ring and border
   * centre colours are judged in static captures only. Every other element of a sample gets the static checks (ruling
   * R132). Empty for static captures.
   */
  moving?: ReadonlySet<string>;
  /** Elements that draw a vector picture (IR kind `vector`): their edge band is the picture's drawn edges (`ssimVectorEdge`). */
  vectors?: ReadonlySet<string>;
  /** The capture's viewport class (absent: exact): which elements `ssimRoundEdge` may apply to. */
  viewportClass?: "exact" | "scaled";
  /**
   * The containers of data-u-repeat lists (IR `repeat`): their children are the first item; the boxes' `items` hold the
   * later written-out items' copies, whose edge bands an element around them takes with its own.
   */
  repeats?: ReadonlySet<string>;
}

/** The screen setup of a capture: state, viewport and what is applied (matrix.json `captures[]`); `anim` for an animation sample. */
export interface CaptureSetup { state: string; viewport: [number, number]; apply: CaptureApply[]; anim?: unknown }

/** A rotation in degrees that leaves a box's edges on the axes (a multiple of 90°, within 1e-3°). */
const axisAligned = (deg: number) => { const r = Math.abs(deg) % 90; return r < 1e-3 || 90 - r < 1e-3; };

interface LooseShadow { offset: BoxRect }
interface LooseNode {
  id: string;
  kind?: string;
  text?: unknown;
  asset?: unknown;
  insetShadow?: unknown;
  insetShadowLayers?: Record<string, unknown>;
  classes?: string[];
  style?: Record<string, Record<string, string>>;
  background?: unknown;
  backgroundLayers?: Record<string, unknown>;
  shadow?: LooseShadow | null;
  shadowLayers?: Record<string, LooseShadow | null>;
  initial?: { disabled?: boolean; checked?: boolean } | null;
  repeat?: unknown;
  /** IR `anims`: only their animated properties are read (whether an animation moves its element). */
  anims?: { properties?: unknown }[];
  children?: LooseNode[];
}

/**
 * The animated properties that move or resize an element's box (ruling R132): the transform and its parts, its position
 * and its size, and the box-model lengths that place or size it. A colour, an opacity, a filter or a shadow does not.
 */
export const GEOMETRY_PROPERTIES: ReadonlySet<string> = new Set([
  "transform", "translate", "rotate", "scale", "transform-origin", "offset-path", "offset-distance", "offset-rotate",
  "left", "top", "right", "bottom", "inset", "inset-block", "inset-inline",
  "width", "height", "min-width", "min-height", "max-width", "max-height", "flex-basis", "flex-grow", "flex-shrink",
  "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "gap", "row-gap", "column-gap",
]);

/** Whether an IR animation changes geometry (GEOMETRY_PROPERTIES); one whose properties are unknown may. */
function movesBox(a: { properties?: unknown } | undefined): boolean {
  if (!a || !Array.isArray(a.properties)) return true;
  return a.properties.some((p) => typeof p === "string" && GEOMETRY_PROPERTIES.has(p));
}

export interface IrIndex {
  screen: string;
  root: string;
  order: string[];
  nodes: Map<string, LooseNode>;
  parent: Map<string, string>;
  view: Pick<IrScreen, "referenceViewport" | "screenMatch">;
  breakpoints: Map<string, IrScreen["breakpoints"][number]>;
  /** The IR's viewports of class scaled (none for an IR without them). */
  scaledViewports: [number, number][];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Indexes an IR (screen.ir.json content). Throws when it is not a screen IR. */
export function indexIr(json: unknown): IrIndex {
  if (!isObj(json) || !isObj(json.root) || typeof json.root.id !== "string") throw new Error("not a screen IR (no root element)");
  const nodes = new Map<string, LooseNode>(), parent = new Map<string, string>(), order: string[] = [];
  const walk = (n: LooseNode, p: string | null) => {
    if (typeof n?.id !== "string" || nodes.has(n.id)) throw new Error(`screen IR: missing or duplicate element id ${String(n?.id)}`);
    nodes.set(n.id, n);
    order.push(n.id);
    if (p !== null) parent.set(n.id, p);
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c, n.id);
  };
  walk(json.root as unknown as LooseNode, null);
  const ref = Array.isArray(json.referenceViewport) ? (json.referenceViewport as [number, number]) : [2560, 1440] as [number, number];
  const bps = Array.isArray(json.breakpoints) ? (json.breakpoints as IrScreen["breakpoints"]) : [];
  return {
    screen: typeof json.screen === "string" ? json.screen : "",
    root: (json.root as { id: string }).id,
    order, nodes, parent,
    view: { referenceViewport: ref, screenMatch: typeof json.screenMatch === "number" ? json.screenMatch : 0.5 },
    breakpoints: new Map(bps.map((b) => [b.name, b])),
    scaledViewports: Array.isArray(json.scaledViewports)
      ? (json.scaledViewports as unknown[]).filter((v): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number"))
      : [],
  };
}

/** Whether one layer dimension holds for element `id` in a capture (pointer semantics as in the capture matrix). */
function dimensionTest(ix: IrIndex, setup: CaptureSetup): (dim: string, id: string) => boolean {
  const ancestorOrSelf = (anc: string, id: string) => { for (let x: string | undefined = id; x !== undefined; x = ix.parent.get(x)) if (x === anc) return true; return false; };
  const applied = (kind: "pseudo" | "class", label: string, id: string) => setup.apply.some((a) => a.elementId === id
    && (a.kind === "pseudo" ? kind === "pseudo" && a.pseudo === label : kind === "class" && a.name === label));
  const pseudo = (p: string, id: string): boolean => {
    // a real pointer hovers the target's ancestors too; pressing implies hovering
    if (p === "hover") return setup.apply.some((a) => a.kind === "pseudo" && (a.pseudo === "hover" || a.pseudo === "active") && ancestorOrSelf(id, a.elementId));
    if (applied("pseudo", p, id)) return true;
    if (p === "disabled" || p === "checked") return ix.nodes.get(id)?.initial?.[p] === true;
    return false;
  };
  const cls = (name: string, id: string) => applied("class", name, id) || (ix.nodes.get(id)?.classes ?? []).includes(name);
  return (dim, id) => {
    if (dim.startsWith("bp:")) {
      const b = ix.breakpoints.get(dim.slice(3));
      return !!b && breakpointsHold([b], setup.viewport, ix.view);
    }
    if (dim.startsWith("state:")) return setup.state === dim.slice(6);
    if (dim.startsWith("class:")) return cls(dim.slice(6), id);
    const m = /^anc\(([^)]+)\):(.+)$/.exec(dim);
    if (m) return m[2].startsWith("class:") ? cls(m[2].slice(6), m[1]) : pseudo(m[2], m[1]);
    return pseudo(dim, id);
  };
}

/** The value of the most specific holding layer that has one (`base` when none holds). */
function resolve<T>(base: T, layers: Record<string, T> | undefined, holds: (key: string) => boolean): T {
  let best = base, dims = 0;
  for (const [key, v] of Object.entries(layers ?? {})) {
    if (key === "base") continue;
    const n = key.split("+").length;
    if (n > dims && holds(key)) { best = v; dims = n; }
  }
  return best;
}

function styleValue(n: LooseNode, prop: string, holds: (key: string) => boolean): string | undefined {
  const layers: Record<string, string> = {};
  for (const [key, m] of Object.entries(n.style ?? {})) if (key !== "base" && m && prop in m) layers[key] = m[prop];
  return resolve(n.style?.base?.[prop], layers, holds);
}

/** The IR facts for one capture: paint order, active outer shadow rects (device px) and painted backgrounds. */
export function captureContext(ix: IrIndex, setup: CaptureSetup, golden: CaptureBoxes): CaptureContext {
  // what a job applies in a later written-out repeat item (`item`) holds there, not on the IR's own elements, whose
  // boxes the captures measure
  const test = dimensionTest(ix, { ...setup, apply: setup.apply.filter((a) => !a.item?.length) });
  const shadows: Record<string, Rect> = {};
  const backgrounds = new Set<string>(), painters = new Set<string>();
  const borders: Record<string, [number, number, number, number]> = {};
  const fontPx: Record<string, number> = {};
  const radii: Record<string, [number, number, number, number]> = {};
  const pictures = new Set<string>(), textShadows = new Set<string>(), rotated = new Set<string>(), opaque = new Set<string>(), vectors = new Set<string>();
  const repeats = new Set<string>();
  const opacity = new Map<string, number>();
  const opacityOf = (id: string, holds: (key: string) => boolean): number => {
    if (opacity.has(id)) return opacity.get(id)!;
    const own = parseFloat(styleValue(ix.nodes.get(id)!, "opacity", holds) ?? "1");
    const up = ix.parent.get(id);
    const v = (Number.isFinite(own) ? own : 1) * (up ? opacityOf(up, holds) : 1);
    opacity.set(id, v);
    return v;
  };
  for (const id of ix.order) {
    const n = ix.nodes.get(id)!;
    const holds = (key: string) => key.split("+").every((d) => test(d, id));
    const color = styleValue(n, "background-color", holds);
    const image = styleValue(n, "background-image", holds);
    const asset = resolve<unknown>(n.background ?? null, n.backgroundLayers, holds);
    if (!isTransparentColor(color) || (image !== undefined && image.trim() !== "none" && image.trim() !== "") || asset) backgrounds.add(id);
    if (colorAlpha(color) >= 0.99 && opacityOf(id, (key) => key.split("+").every((d) => test(d, id))) >= 0.99) opaque.add(id);
    const sh = resolve<LooseShadow | null>(n.shadow ?? null, n.shadowLayers, holds);
    const inset = resolve<unknown>(n.insetShadow ?? null, n.insetShadowLayers, holds);
    const b = golden.elements[id];
    if (sh && isObj(sh.offset) && b) {
      const s = golden.scale, o = sh.offset;
      shadows[id] = { x: b.x + o.x * s, y: b.y + o.y * s, w: b.w + o.w * s, h: b.h + o.h * s };
    }
    const widths = (["top", "right", "bottom", "left"] as const).map((side) => {
      const style = styleValue(n, `border-${side}-style`, holds) ?? "none";
      if (style === "none" || style === "hidden" || isTransparentColor(styleValue(n, `border-${side}-color`, holds) ?? "currentcolor")) return 0;
      const px = parseFloat(styleValue(n, `border-${side}-width`, holds) ?? "0");
      return Number.isFinite(px) ? px * golden.scale : 0;
    }) as [number, number, number, number];
    if (widths.some((x) => x > 0)) borders[id] = widths;
    const corners = (["top-left", "top-right", "bottom-right", "bottom-left"] as const).map((c) => {
      const px = parseFloat(styleValue(n, `border-${c}-radius`, holds) ?? "0");
      return Number.isFinite(px) && px > 0 ? px * golden.scale : 0;
    }) as [number, number, number, number];
    if (corners.some((x) => x > 0)) radii[id] = corners;
    if (n.kind === "text" || n.text) {
      const size = parseFloat(styleValue(n, "font-size", holds) ?? "");
      if (Number.isFinite(size) && size > 0) fontPx[id] = size * golden.scale;
      // offset-x offset-y blur: the third length (the colour may come first or last)
      const lengths = (styleValue(n, "text-shadow", holds) ?? "none").replace(/(rgba?|hsla?)\([^)]*\)|#[0-9a-f]+/gi, " ").match(/-?(?:\d+\.?\d*|\.\d+)(?:px)?(?=\s|$)/g) ?? [];
      if (lengths.length >= 3 && parseFloat(lengths[2]) > 0) textShadows.add(id);
    }
    if (backgrounds.has(id) || borders[id] || sh || inset || n.asset || n.kind === "image" || n.kind === "vector") painters.add(id);
    // a raster picture is resampled unless its element box is its own size in device px
    if (isObj(n.asset) && n.asset.kind === "image" && b && (Math.abs(b.w - Number(n.asset.width)) > 0.5 || Math.abs(b.h - Number(n.asset.height)) > 0.5)) pictures.add(id);
    // so is a url() background image unless it is drawn at its own size (background-size auto or its px size, scale 1)
    if (isObj(n.background) && n.background.kind === "image") {
      const size = (styleValue(n, "background-size", holds) ?? "auto").trim().split(/\s+/);
      const own = size.every((x) => x === "auto") || (size.length === 2 && parseFloat(size[0]) === Number(n.background.width) && parseFloat(size[1]) === Number(n.background.height));
      if (!own || Math.abs(golden.scale - 1) > 1e-9) pictures.add(id);
    }
    if (setup.anim && b && typeof b.rotation === "number" && !axisAligned(b.rotation)) rotated.add(id);
    if (n.kind === "vector") vectors.add(id);
    if (isObj(n.repeat)) repeats.add(id);
  }
  // the elements the sample's running animations move (an animation of geometry), and everything inside them
  const moving = new Set<string>();
  const runs = isObj(setup.anim) && Array.isArray(setup.anim.runs) ? (setup.anim.runs as unknown[]) : [];
  const runIds = new Set(runs.map((r) => {
    if (!isObj(r) || typeof r.elementId !== "string") return null;
    const anims = ix.nodes.get(r.elementId)?.anims;
    return movesBox(Array.isArray(anims) && typeof r.index === "number" ? anims[r.index] : undefined) ? r.elementId : null;
  }).filter((x): x is string => x !== null));
  if (runIds.size) for (const id of ix.order) for (let x: string | undefined = id; x !== undefined; x = ix.parent.get(x)) if (runIds.has(x)) { moving.add(id); break; }
  return { order: ix.order, root: ix.root, parent: ix.parent, anim: !!setup.anim, moving, vectors, repeats, shadows, backgrounds, painters, opaque, borders, fontPx, radii, pictures, textShadows, rotated };
}
