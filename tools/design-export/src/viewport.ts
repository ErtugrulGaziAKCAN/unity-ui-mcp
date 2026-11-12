const clean = (v: number) => Math.round(v * 1e9) / 1e9;

/** Panel scale for Scale With Screen Size: 2^lerp(log2(W/refW), log2(H/refH), match). Returns the logical size the page renders at. */
export function logicalViewport(
  viewport: [number, number],
  reference: [number, number],
  match: number,
): { width: number; height: number; scale: number } {
  const [w, h] = viewport;
  const lw = Math.log2(w / reference[0]);
  const lh = Math.log2(h / reference[1]);
  const scale = clean(2 ** (lw + (lh - lw) * match));
  return { width: clean(w / scale), height: clean(h / scale), scale };
}
