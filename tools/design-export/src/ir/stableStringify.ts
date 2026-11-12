function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** Sorted keys, 2-space indent, trailing newline. Deterministic IR/boxes output. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}
