import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Per-step wall-clock times (ms) for a tool result; `total` is added by `done()`. */
export class Timings {
  private readonly t0 = performance.now();
  readonly steps: Record<string, number> = {};

  sync<T>(name: string, fn: () => T): T {
    const t = performance.now();
    try { return fn(); } finally { this.add(name, t); }
  }

  async async<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    try { return await fn(); } finally { this.add(name, t); }
  }

  private add(name: string, t: number) {
    this.steps[name] = (this.steps[name] ?? 0) + Math.round(performance.now() - t);
  }

  done(): Record<string, number> {
    return { ...this.steps, total: Math.round(performance.now() - this.t0) };
  }
}

/** A short text summary, the same data as JSON text (for clients without structured content), and the data itself. */
export function toolResult(summary: string, data: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: summary }, { type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

/** Runs a tool body; any thrown error becomes an isError result with its message and the timings so far. */
export async function guarded(t: Timings, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return toolResult(message, { error: message, timings: t.done() }, true);
  }
}
