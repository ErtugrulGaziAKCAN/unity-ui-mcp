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

/** What a tool handler gets besides its arguments (the MCP SDK's request extra), as far as progress needs it. */
export interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
}

/**
 * The runner's progress callback for one tool call: each line becomes an MCP progress notification when the client
 * asked for progress (a progressToken), so a client that resets its request timeout on progress waits for a long Unity
 * step; undefined otherwise.
 */
export function progressOf(extra: ProgressExtra | undefined): ((message: string) => void) | undefined {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return undefined;
  let n = 0;
  return (message) => {
    n++;
    send({ method: "notifications/progress", params: { progressToken: token, progress: n, message } }).catch(() => { /* the client went away */ });
  };
}
