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
import { isTransparentColor } from "./color.js";
import type { Rect } from "./ssim.js";

/** Per-capture facts from the IR; every field is optional (absent: the comparison works from the boxes alone). */
export interface CaptureContext {
  /** Element ids in paint order (IR pre-order: an element paints after its ancestors and earlier subtrees). */
  order?: string[];
  /** The screen root (its region is the whole capture, measured by the whole-capture SSIM). */
  root?: string | null;
  /** Outer baked shadow rect per element active in this capture, in device px (element box + IR `shadow.offset` × scale). */
  shadows?: Record<string, Rect>;
  /** Elements that paint a background in this capture (colour, gradient or image); null or absent: every element. */
  backgrounds?: ReadonlySet<string> | null;
}

/** The screen setup of a capture: state, viewport and what is applied (matrix.json `captures[]`). */
export interface CaptureSetup { state: string; viewport: [number, number]; apply: CaptureApply[] }

interface LooseShadow { offset: BoxRect }
interface LooseNode {
  id: string;
  kind?: string;
  classes?: string[];
  style?: Record<string, Record<string, string>>;
  background?: unknown;
  backgroundLayers?: Record<string, unknown>;
  shadow?: LooseShadow | null;
  shadowLayers?: Record<string, LooseShadow | null>;
  initial?: { disabled?: boolean; checked?: boolean } | null;
  children?: LooseNode[];
}

export interface IrIndex {
  screen: string;
  root: string;
  order: string[];
  nodes: Map<string, LooseNode>;
  parent: Map<string, string>;
  view: Pick<IrScreen, "referenceViewport" | "screenMatch">;
  breakpoints: Map<string, IrScreen["breakpoints"][number]>;
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
  const test = dimensionTest(ix, setup);
  const shadows: Record<string, Rect> = {};
  const backgrounds = new Set<string>();
  for (const id of ix.order) {
    const n = ix.nodes.get(id)!;
    const holds = (key: string) => key.split("+").every((d) => test(d, id));
    const color = styleValue(n, "background-color", holds);
    const image = styleValue(n, "background-image", holds);
    const asset = resolve<unknown>(n.background ?? null, n.backgroundLayers, holds);
    if (!isTransparentColor(color) || (image !== undefined && image.trim() !== "none" && image.trim() !== "") || asset) backgrounds.add(id);
    const sh = resolve<LooseShadow | null>(n.shadow ?? null, n.shadowLayers, holds);
    const b = golden.elements[id];
    if (sh && isObj(sh.offset) && b) {
      const s = golden.scale, o = sh.offset;
      shadows[id] = { x: b.x + o.x * s, y: b.y + o.y * s, w: b.w + o.w * s, h: b.h + o.h * s };
    }
  }
  return { order: ix.order, root: ix.root, shadows, backgrounds };
}
