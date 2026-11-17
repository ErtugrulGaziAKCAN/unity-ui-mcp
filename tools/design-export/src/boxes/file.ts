/**
 * The boxes file of a capture folder, the export's goldens and the Unity capture alike: `boxes.jsonl`, one line per
 * capture, the compact JSON of its CaptureBoxes (schema.json, sorted keys) and `\n`, appended when the capture finishes.
 * Nothing builds the whole set as one string: thousands of dense captures are more than a string can hold.
 *
 * A reader streams the lines once and keeps an index (where each capture's line is, its viewport); a capture's line is
 * read and parsed when it is asked for, so the reader holds one capture's data plus the index. A name written again is
 * read from its last line. A last line without its newline that is not JSON (a run stopped while writing it) is left out
 * with a note; the captures before it stay readable. A folder without boxes.jsonl is read from the boxes.json of earlier
 * versions (one JSON object of every capture, by name).
 */
import fs from "node:fs";
import path from "node:path";
import { stableLine } from "../ir/stableStringify.js";
import type { CaptureBoxes } from "./types.js";
import { validateBoxes } from "./validate.js";

export const BOXES_FILE = "boxes.jsonl";
/** The boxes file of earlier versions: one JSON object of every capture by name, read when a folder has no boxes.jsonl. */
export const LEGACY_BOXES_FILE = "boxes.json";

/** A capture's line in boxes.jsonl, with its newline. */
export function boxesLine(boxes: CaptureBoxes): string {
  return `${stableLine(boxes)}\n`;
}

/** Appends a capture's line to `<dir>/boxes.jsonl` (created when missing). */
export function appendBoxes(dir: string, boxes: CaptureBoxes): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, BOXES_FILE), boxesLine(boxes));
}

/** The captures of a boxes file, each read when it is asked for. */
export interface BoxesReader {
  /** The file read: boxes.jsonl, or the boxes.json of an earlier version. */
  readonly file: string;
  /** The capture names in the file's order (a name written again keeps its first place). */
  readonly names: readonly string[];
  /** What the reader left out and why (an incomplete last line). */
  readonly notes: readonly string[];
  has(name: string): boolean;
  /** The capture's viewport, from the index. */
  viewport(name: string): [number, number] | undefined;
  /** The capture's boxes, read and parsed now. */
  read(name: string): Promise<CaptureBoxes>;
}

interface Entry { at: number; bytes: number; viewport: [number, number] }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Every line of a file with its byte offset, streamed; `last`: the final line, which has no newline. */
async function* linesOf(file: string): AsyncGenerator<{ line: Buffer; at: number; last: boolean }> {
  let at = 0;
  let pending: Buffer[] = [];
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let nl = chunk.indexOf(10, from); nl >= 0; nl = chunk.indexOf(10, from)) {
      const line = pending.length ? Buffer.concat([...pending, chunk.subarray(from, nl)]) : chunk.subarray(from, nl);
      pending = [];
      yield { line, at, last: false };
      at += line.length + 1;
      from = nl + 1;
    }
    if (from < chunk.length) pending.push(chunk.subarray(from));
  }
  if (pending.length) yield { line: Buffer.concat(pending), at, last: true };
}

/**
 * The index of a boxes.jsonl: capture name -> its last line. `validate`: each line is checked against the boxes schema
 * (an invalid one is refused, never guessed); without it a line only needs its name and viewport.
 */
async function indexLines(file: string, side: string, validate: boolean): Promise<{ entries: Map<string, Entry>; lines: number; notes: string[] }> {
  const entries = new Map<string, Entry>(), notes: string[] = [];
  let n = 0, lines = 0;
  for await (const { line, at, last } of linesOf(file)) {
    n++;
    const text = line.toString("utf8");
    if (!text.trim()) continue;
    let json: unknown;
    try { json = JSON.parse(text); } catch (e) {
      if (last) {
        notes.push(`${side} ${BOXES_FILE} (${file}): its last line is incomplete (a run stopped while writing it) and was left out; ` +
          `the ${entries.size} capture${entries.size === 1 ? "" : "s"} before it ${entries.size === 1 ? "is" : "are"} read`);
        break;
      }
      throw new Error(`${side} ${BOXES_FILE} (${file}) line ${n} is not JSON: ${(e as Error).message}`);
    }
    const name = isObj(json) && typeof json.capture === "string" ? json.capture : null;
    const errs = validate ? validateBoxes(json) : name !== null && Array.isArray((json as CaptureBoxes).viewport) ? [] : ["no capture name or viewport"];
    if (errs.length) throw new Error(`${side} ${BOXES_FILE} (${file}) line ${n}: capture ${name ?? "(no name)"} is invalid: ${errs.slice(0, 3).join("; ")}`);
    const vp = (json as CaptureBoxes).viewport;
    entries.set(name!, { at, bytes: line.length, viewport: [vp[0], vp[1]] });
    lines++;
  }
  return { entries, lines, notes };
}

/** The line of `bytes` bytes at `at` of an open file, with its newline. */
function lineAt(fd: number, bytes: number, at: number): Buffer {
  const buf = Buffer.alloc(bytes + 1);
  for (let got = 0; got < bytes;) {
    const k = fs.readSync(fd, buf, got, bytes - got, at + got);
    if (k === 0) throw new Error("the file ended early");
    got += k;
  }
  buf[bytes] = 10;
  return buf;
}

function writeAll(fd: number, buf: Buffer): void {
  for (let done = 0; done < buf.length;) done += fs.writeSync(fd, buf, done, buf.length - done);
}

function linesReader(file: string, side: string, entries: Map<string, Entry>, notes: string[]): BoxesReader {
  return {
    file, names: [...entries.keys()], notes,
    has: (name) => entries.has(name),
    viewport: (name) => entries.get(name)?.viewport,
    read: async (name) => {
      const e = entries.get(name);
      if (!e) throw new Error(`${side} ${BOXES_FILE} (${file}) has no capture ${name}`);
      const fh = await fs.promises.open(file, "r");
      let text: string;
      try {
        const buf = Buffer.alloc(e.bytes);
        for (let got = 0; got < e.bytes;) {
          const { bytesRead } = await fh.read(buf, got, e.bytes - got, e.at + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        text = buf.toString("utf8");
      } finally { await fh.close(); }
      let b: CaptureBoxes | null = null;
      try { b = JSON.parse(text) as CaptureBoxes; } catch { /* reported below */ }
      if (!b || b.capture !== name) throw new Error(`${side} ${BOXES_FILE} (${file}) changed while it was read (capture ${name})`);
      return b;
    },
  };
}

function legacyReader(file: string, side: string): BoxesReader {
  let json: unknown;
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`${side} ${LEGACY_BOXES_FILE} (${file}) cannot be read: ${(e as Error).message}`); }
  if (!isObj(json)) throw new Error(`${side} ${LEGACY_BOXES_FILE} (${file}) is not an object of captures`);
  for (const [name, b] of Object.entries(json)) {
    const errs = validateBoxes(b);
    if (errs.length) throw new Error(`${side} ${LEGACY_BOXES_FILE} (${file}): capture ${name} is invalid: ${errs.slice(0, 3).join("; ")}`);
  }
  const all = json as Record<string, CaptureBoxes>;
  const has = (name: string) => Object.hasOwn(all, name);
  return {
    file, names: Object.keys(all), notes: [], has,
    viewport: (name) => (has(name) ? all[name].viewport : undefined),
    read: async (name) => {
      if (!has(name)) throw new Error(`${side} ${LEGACY_BOXES_FILE} (${file}) has no capture ${name}`);
      return all[name];
    },
  };
}

/**
 * The boxes of a capture folder (`side` names it in errors and notes: "design", "Unity"): `<dir>/boxes.jsonl`, else the
 * boxes.json of an earlier version, else null. Every capture is checked against the boxes schema while the file is
 * indexed: an invalid one is refused.
 */
export async function openBoxes(dir: string, side: string): Promise<BoxesReader | null> {
  const file = path.join(dir, BOXES_FILE);
  if (fs.existsSync(file)) {
    const { entries, notes } = await indexLines(file, side, true);
    return linesReader(file, side, entries, notes);
  }
  const legacy = path.join(dir, LEGACY_BOXES_FILE);
  return fs.existsSync(legacy) ? legacyReader(legacy, side) : null;
}

/**
 * Rewrites `<dir>/boxes.jsonl` with its captures in `order` (then any it does not name, in the file's order), each from
 * its last line, one line at a time through a temporary file; a file already in that order is left as it is. Captures
 * appended as they finished, viewports in parallel, end up in one order, whatever order they finished in.
 */
export async function orderBoxes(dir: string, order: readonly string[]): Promise<void> {
  const file = path.join(dir, BOXES_FILE), tmp = `${file}.tmp`;
  const { entries, lines } = await indexLines(file, "design", false);
  const named = new Set(order);
  const names = [...order.filter((n) => entries.has(n)), ...[...entries.keys()].filter((n) => !named.has(n))];
  const current = [...entries.keys()];
  if (lines === entries.size && names.every((n, k) => current[k] === n)) return;
  const fd = fs.openSync(file, "r");
  try {
    const out = fs.openSync(tmp, "w");
    try {
      for (const n of names) {
        const e = entries.get(n)!;
        writeAll(out, lineAt(fd, e.bytes, e.at));
      }
    } finally { fs.closeSync(out); }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
