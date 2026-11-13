/**
 * Sibling paint order, as the Unity compiler orders siblings (Lowering.PaintOrder) and as CSS paints them. UI Toolkit
 * paints siblings in hierarchy order; the compiler keeps in-flow siblings in layout order and moves only absolute
 * siblings, each into the one gap between in-flow siblings that gives it its CSS stacking level (CSS 2.1 appendix E):
 * positioned z < 0, in-flow non-positioned, positioned z auto/0, positioned z > 0. A flex item with a z-index other
 * than auto stacks as if it were relative. Lint (U-CSS-004, U-CSS-032) runs the same algorithm so it rejects exactly
 * what the compiler rejects, and finds overlapping siblings whose order still differs from CSS.
 */

export interface PaintSibling {
  /** Element index (for messages and the returned order). */
  index: number;
  name: string;
  position: "static" | "relative" | "absolute";
  /** Base z-index; null for auto. */
  z: number | null;
  /** Non-positioned stacking context in CSS (opacity < 1, a transform): paints like positioned z 0. */
  isolates?: boolean;
}

export type PaintOrder = { ok: true; order: number[] } | { ok: false; problem: string; elements: number[] };

type Key = [number, number, number];
const cmpKey = (a: Key, b: Key) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The compiler's sibling order (child indices), or the problem it rejects the siblings with. */
export function unityPaintOrder(sibs: PaintSibling[], flexContainer: boolean): PaintOrder {
  const key = new Map<PaintSibling, Key>();
  const explicitZ = new Set<PaintSibling>();
  for (let i = 0; i < sibs.length; i++) {
    const c = sibs[i];
    const z = c.z ?? 0, hasZ = c.z !== null;
    const absolute = c.position === "absolute";
    const stacks = absolute || c.position === "relative" || (flexContainer && !absolute && hasZ);
    if (!stacks && z !== 0) {
      return { ok: false, elements: [c.index], problem: `z-index ${z} on ${c.name} has no effect in CSS: it is static and not a flex item` };
    }
    if (stacks && z !== 0) explicitZ.add(c);
    key.set(c, [!stacks ? 1 : z < 0 ? 0 : z === 0 ? 2 : 3, stacks ? z : 0, i]);
  }
  const k = (c: PaintSibling) => key.get(c)!;
  const inflow = sibs.filter((c) => c.position !== "absolute");
  const abs = sibs.filter((c) => c.position === "absolute").sort((a, b) => cmpKey(k(a), k(b)));
  for (let i = 0; i < inflow.length; i++) for (let j = i + 1; j < inflow.length; j++) {
    if (cmpKey(k(inflow[j]), k(inflow[i])) < 0 && (explicitZ.has(inflow[i]) || explicitZ.has(inflow[j]))) {
      return { ok: false, elements: [inflow[j].index, inflow[i].index],
        problem: `${inflow[j].name} paints below ${inflow[i].name} in CSS (z-index) but follows it in the layout order` };
    }
  }
  const gap = new Map<PaintSibling, number>();
  let previous: PaintSibling | null = null;
  for (const a of abs) {
    let lo = 0, hi = inflow.length;
    for (let j = 0; j < inflow.length; j++) {
      if (cmpKey(k(inflow[j]), k(a)) < 0) lo = Math.max(lo, j + 1);
      else hi = Math.min(hi, j);
    }
    if (lo > hi) {
      return { ok: false, elements: [a.index, inflow[lo - 1].index, inflow[hi].index],
        problem: `absolute ${a.name} paints above ${inflow[lo - 1].name} and below ${inflow[hi].name} in CSS, but ${inflow[hi].name} comes first in the layout order` };
    }
    const g: number = previous === null ? lo : Math.max(lo, gap.get(previous)!);
    if (g > hi) {
      return { ok: false, elements: [a.index, previous!.index, inflow[hi].index],
        problem: `absolute ${a.name} paints above ${previous!.name} and below ${inflow[hi].name} in CSS, but ${previous!.name} has to follow ${inflow[g - 1].name}` };
    }
    gap.set(a, g);
    previous = a;
  }
  const order: number[] = [];
  for (let g = 0; g <= inflow.length; g++) {
    for (const a of abs) if (gap.get(a) === g) order.push(a.index);
    if (g < inflow.length) order.push(inflow[g].index);
  }
  return { ok: true, order };
}

/** CSS paint order of siblings (element indices): stacking level, then z, then tree order. */
export function cssPaintOrder(sibs: PaintSibling[], flexContainer: boolean): number[] {
  const keyed = sibs.map((c, i): [PaintSibling, Key] => {
    const absolute = c.position === "absolute";
    const positioned = absolute || c.position === "relative" || (flexContainer && !absolute && c.z !== null);
    const z = positioned ? c.z ?? 0 : 0;
    const level = positioned ? (z < 0 ? 0 : z === 0 ? 2 : 3) : c.isolates ? 2 : 1;
    return [c, [level, z, i]];
  });
  return keyed.sort((a, b) => cmpKey(a[1], b[1])).map(([c]) => c.index);
}
