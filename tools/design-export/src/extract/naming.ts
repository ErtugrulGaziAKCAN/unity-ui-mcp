/** Name of an element without data-u-id: its parent's id and its position among the parent's IR children. */
export function structuralId(parentId: string, index: number): string {
  return `${parentId}__${index}`;
}

/** A structural id that collides with an authored or already assigned id gets the first free `_<n>` suffix. */
export function uniqueId(candidate: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let n = 1; ; n++) if (!taken.has(`${candidate}_${n}`)) return `${candidate}_${n}`;
}

/** IR token key of a custom property: the name without its leading `--` (`--color-surface` → `color-surface`). */
export const tokenKey = (customProperty: string): string => customProperty.replace(/^--/, "");

/** Number text with at most 6 decimals, no trailing zeros, no -0. */
export function fmt(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}
