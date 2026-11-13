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
