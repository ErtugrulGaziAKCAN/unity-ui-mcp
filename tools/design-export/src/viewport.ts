const clean = (v: number) => Math.round(v * 1e9) / 1e9;

/**
 * Panel scale for Scale With Screen Size ("match width or height"), as Unity's PanelSettings.ResolveScale computes it
 * (6000.3): a LINEAR lerp of the width and height ratios, scale = lerp(W/refW, H/refH, match), no rounding.
 * It equals the CanvasScaler log formula only at the reference aspect. Returns the logical size the page renders at.
 */
export function logicalViewport(
  viewport: [number, number],
  reference: [number, number],
  match: number,
): { width: number; height: number; scale: number } {
  const [w, h] = viewport;
  const rw = w / reference[0];
  const rh = h / reference[1];
  const scale = clean(rw + (rh - rw) * match);
  return { width: clean(w / scale), height: clean(h / scale), scale };
}

/**
 * A declared viewport's class (kit.config.json `viewports`):
 * - `exact`: every kit value (text sizes, line heights, borders, thin lines) is a whole number of device pixels there; the
 *   kit build, kit sync and lint hold the design to that, and verify holds it to the fidelity thresholds;
 * - `scaled`: supported, laid out and verified, but no design value can be whole there (1366×768 is scale ≈ 0.5335), so
 *   it is exempt from the whole-device-pixel rules; verify allows the rounding such a scale causes (boxes, baselines and
 *   line extents within ±1 device px, as everywhere) and nothing wider.
 */
export type ViewportClass = "exact" | "scaled";
export const VIEWPORT_CLASSES: readonly ViewportClass[] = ["exact", "scaled"];

/** A viewport with its class. */
export interface ClassedViewport { size: [number, number]; class: ViewportClass }

/** A kit.config.json `viewports` entry: `[w, h]` (an exact viewport, the form older kits use) or `{ "size": [w, h], "class": … }`. */
export type ViewportEntry = [number, number] | { size: [number, number]; class: ViewportClass };

const isSize = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0);

/**
 * Reads kit.config.json `viewports`: each entry a positive whole `[w, h]` (exact) or `{ size: [w, h], class: "exact" |
 * "scaled" }`; no viewport twice. Throws naming the entry.
 */
export function parseViewports(raw: unknown, where = "kit.config.json"): ClassedViewport[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${where}: "viewports" must be a non-empty list of [width, height] or { "size": [width, height], "class": "exact" | "scaled" }`);
  const out: ClassedViewport[] = [];
  raw.forEach((e, i) => {
    let v: ClassedViewport;
    if (isSize(e)) v = { size: [e[0], e[1]], class: "exact" };
    else if (e && typeof e === "object" && !Array.isArray(e) && isSize((e as { size?: unknown }).size)
      && VIEWPORT_CLASSES.includes((e as { class?: unknown }).class as ViewportClass)
      && Object.keys(e).every((k) => k === "size" || k === "class")) {
      const o = e as { size: [number, number]; class: ViewportClass };
      v = { size: [o.size[0], o.size[1]], class: o.class };
    } else throw new Error(`${where}: viewports[${i}] ${JSON.stringify(e)} is neither [width, height] nor { "size": [width, height], "class": "exact" | "scaled" } (whole positive pixels)`);
    if (out.some((o) => o.size[0] === v.size[0] && o.size[1] === v.size[1])) throw new Error(`${where}: viewport ${v.size[0]}×${v.size[1]} is listed twice`);
    out.push(v);
  });
  return out;
}

/** The kit.config.json form of classed viewports: exact ones as `[w, h]`, scaled ones as `{ size, class }` (kit sync writes the same). */
export function viewportEntries(list: readonly ClassedViewport[]): ViewportEntry[] {
  return list.map((v) => (v.class === "exact" ? [v.size[0], v.size[1]] as [number, number] : { size: [v.size[0], v.size[1]] as [number, number], class: v.class }));
}

const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];

/** The class of a viewport: `scaled` when `scaled` lists it, else `exact` (a coverage viewport sits on the exact scales' step). */
export function viewportClassOf(scaled: readonly (readonly number[])[] | undefined, viewport: readonly number[]): ViewportClass {
  return (scaled ?? []).some((s) => same(s, viewport)) ? "scaled" : "exact";
}

/** `w×h`, then ` (scaled)` for a scaled viewport. */
export function viewportLabel(viewport: readonly number[], cls: ViewportClass): string {
  return `${viewport[0]}×${viewport[1]}${cls === "scaled" ? " (scaled)" : ""}`;
}
