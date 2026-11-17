function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** Sorted keys on one line, without a newline: one record of a JSON Lines file (a capture's line in boxes.jsonl). */
export function stableLine(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Sorted keys, 2-space indent, trailing newline. Deterministic IR and matrix output. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}
