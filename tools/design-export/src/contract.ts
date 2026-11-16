import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ID_PATTERN, KEY_PATTERN } from "./lint/rules/U-MRK-005.js";

/** The screen contract: what the game has for one screen, written beside the design (spec 2026-11-16-screen-contract). */
export const CONTRACT_FILE = "screen.contract.json";

export type ContractKind = "value" | "action" | "state" | "repeat" | "text";
const KINDS: ContractKind[] = ["value", "action", "state", "repeat", "text"];

export interface ContractItem {
  kind: ContractKind;
  /** Bind/arg/action/state/repeat name, or the text key. */
  name: string;
  /** Scope: the enclosing repeat's name (values, actions); a repeat's parent (repeats); null is the screen. Always null for states and texts. */
  repeat: string | null;
  origin: "existing" | "requested";
  /** Values and repeats: source; actions: handler; states: when; texts: null. */
  source: string | null;
  /** Required when origin is "requested". */
  note?: string;
  /** Values only. */
  samples?: string[];
  /** Values only: an image bind (no samples). */
  image?: boolean;
  /** Repeats only. */
  count?: [number, number];
  /** Texts only. */
  en?: string;
  /** Texts only: the reference-locale text as the game has it. */
  ref?: string;
}

export interface RemovedItem { kind: ContractKind; name: string; repeat: string | null; note: string }

export interface ScreenContract {
  contract: 1;
  screen: string;
  kind: "update" | "new";
  replaces: string | null;
  items: ContractItem[];
  removed: RemovedItem[];
}

export type ContractLoad =
  | { state: "absent"; file: string }
  | { state: "invalid"; file: string; problems: string[]; sha: string }
  | { state: "valid"; file: string; contract: ScreenContract; sha: string };

const TOP_KEYS = ["contract", "screen", "kind", "replaces", "values", "actions", "states", "repeats", "texts", "removed"];

/** Per JSON array: the item kind, the field that holds its name, the field that holds its source and the word for a missing one. */
const SECTIONS: { key: string; kind: ContractKind; nameField: string; sourceField: string | null; scopeField: string | null; sourceWord: string }[] = [
  { key: "values", kind: "value", nameField: "name", sourceField: "source", scopeField: "repeat", sourceWord: "source" },
  { key: "actions", kind: "action", nameField: "name", sourceField: "handler", scopeField: "repeat", sourceWord: "handler" },
  { key: "states", kind: "state", nameField: "name", sourceField: "when", scopeField: null, sourceWord: "when" },
  { key: "repeats", kind: "repeat", nameField: "name", sourceField: "source", scopeField: "parent", sourceWord: "source" },
  { key: "texts", kind: "text", nameField: "key", sourceField: null, scopeField: null, sourceWord: "source" },
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const filled = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const scopeText = (repeat: string | null) => (repeat === null ? "the screen" : `repeat "${repeat}"`);
const keyOf = (kind: ContractKind, name: string, repeat: string | null) => `${kind}\u0000${name}\u0000${repeat ?? ""}`;

/** Checks a parsed contract file against the format; every problem is reported, each naming its item. Pure. */
export function parseScreenContract(json: unknown): { contract: ScreenContract } | { problems: string[] } {
  const problems: string[] = [];
  if (!isObj(json)) return { problems: ["the contract must be a JSON object"] };
  if (json.contract !== 1) problems.push("contract must be 1");
  for (const k of Object.keys(json)) if (!TOP_KEYS.includes(k)) problems.push(`unknown key "${k}"`);
  if (!filled(json.screen)) problems.push("screen is missing");
  else if (!ID_PATTERN.test(json.screen)) problems.push(`screen "${json.screen}" does not match ${ID_PATTERN.source}`);
  const kind = json.kind;
  if (kind !== "update" && kind !== "new") problems.push('kind must be "update" or "new"');
  const replaces = filled(json.replaces) ? json.replaces : null;
  if (kind === "update" && replaces === null) problems.push('an update contract needs "replaces": what the current UI is, in the project\'s own names');

  const items: ContractItem[] = [];
  const seen = new Set<string>();
  for (const sec of SECTIONS) {
    const list = json[sec.key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { problems.push(`${sec.key} must be a list`); continue; }
    list.forEach((raw, i) => {
      if (!isObj(raw)) { problems.push(`${sec.key}[${i}] must be an object`); return; }
      const name = raw[sec.nameField];
      const word = sec.kind;
      if (typeof name !== "string" || name === "") { problems.push(`${word} at ${sec.key}[${i}] has no ${sec.nameField}`); return; }
      const pattern = sec.kind === "text" ? KEY_PATTERN : ID_PATTERN;
      if (!pattern.test(name)) problems.push(`${word} "${name}" does not match ${pattern.source}`);
      let repeat: string | null = null;
      if (sec.scopeField !== null && raw[sec.scopeField] !== undefined && raw[sec.scopeField] !== null) {
        const r = raw[sec.scopeField];
        if (typeof r === "string" && ID_PATTERN.test(r)) repeat = r;
        else problems.push(`${word} "${name}": ${sec.scopeField} ${JSON.stringify(r)} does not match ${ID_PATTERN.source}`);
      }
      const origin = raw.origin;
      if (origin !== "existing" && origin !== "requested") { problems.push(`${word} "${name}": origin must be "existing" or "requested"`); return; }
      const source = sec.sourceField !== null && filled(raw[sec.sourceField]) ? (raw[sec.sourceField] as string) : null;
      const note = filled(raw.note) ? raw.note : undefined;
      const k = keyOf(sec.kind, name, repeat);
      if (seen.has(k)) problems.push(`duplicate ${word} "${name}" in ${scopeText(repeat)}`);
      seen.add(k);
      if (origin === "existing" && sec.sourceField !== null && source === null) problems.push(`existing ${word} "${name}" has no ${sec.sourceWord}`);
      if (origin === "requested" && note === undefined) problems.push(`requested ${word} "${name}" has no note (who asked, when, what)`);
      const item: ContractItem = { kind: sec.kind, name, repeat, origin, source };
      if (note !== undefined) item.note = note;
      if (sec.kind === "value") {
        const image = raw.image === true;
        if (image) item.image = true;
        if (raw.samples !== undefined) {
          if (!Array.isArray(raw.samples) || !raw.samples.every((s) => typeof s === "string")) problems.push(`value "${name}": samples must be a list of strings`);
          else if (raw.samples.length === 0) problems.push(`value "${name}" has empty samples`);
          else item.samples = raw.samples as string[];
        } else if (origin === "existing" && !image) problems.push(`existing value "${name}" has no samples`);
      } else if (sec.kind === "repeat") {
        const c = raw.count;
        if (!Array.isArray(c) || c.length !== 2 || !c.every((n) => Number.isInteger(n) && n >= 0) || c[0] > c[1])
          problems.push(`repeat "${name}": count must be [min, max] with integers 0 <= min <= max`);
        else item.count = [c[0], c[1]];
      } else if (sec.kind === "text") {
        if (!filled(raw.en)) problems.push(`text "${name}" has no en`);
        else item.en = raw.en;
        if (typeof raw.ref === "string") item.ref = raw.ref;
      }
      items.push(item);
    });
  }

  const removed: RemovedItem[] = [];
  const rem = json.removed;
  if (rem !== undefined && !Array.isArray(rem)) problems.push("removed must be a list");
  else if (Array.isArray(rem)) rem.forEach((raw, i) => {
    if (!isObj(raw)) { problems.push(`removed[${i}] must be an object`); return; }
    const rk = raw.kind as ContractKind;
    const name = raw.name;
    if (!KINDS.includes(rk)) { problems.push(`removed[${i}]: kind must be one of ${KINDS.join(", ")}`); return; }
    if (typeof name !== "string" || !(rk === "text" ? KEY_PATTERN : ID_PATTERN).test(name)) { problems.push(`removed ${rk} ${JSON.stringify(name)} has a bad name`); return; }
    const scope = raw.repeat ?? raw.parent;
    const repeat = typeof scope === "string" && ID_PATTERN.test(scope) ? scope : null;
    if (scope !== undefined && scope !== null && repeat === null) problems.push(`removed ${rk} "${name}": repeat ${JSON.stringify(scope)} does not match ${ID_PATTERN.source}`);
    if (!filled(raw.note)) { problems.push(`removed ${rk} "${name}" has no note`); return; }
    removed.push({ kind: rk, name, repeat, note: raw.note });
  });
  if (kind === "new" && removed.length > 0) problems.push('a "new" contract cannot have removed items');
  for (const r of removed) if (seen.has(keyOf(r.kind, r.name, r.repeat))) problems.push(`${r.kind} "${r.name}" is both listed and removed`);

  if (problems.length > 0) return { problems };
  return { contract: { contract: 1, screen: json.screen as string, kind: kind as "update" | "new", replaces, items, removed } };
}

/** Reads one contract file: absent, invalid (JSON or format problems) or valid; `sha` is the sha256 hex of the file bytes. */
export function readContractFile(file: string): ContractLoad {
  if (!fs.existsSync(file)) return { state: "absent", file };
  const bytes = fs.readFileSync(file);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  let json: unknown;
  try { json = JSON.parse(bytes.toString("utf8")); }
  catch (e) { return { state: "invalid", file, sha, problems: [`${CONTRACT_FILE} is not valid JSON: ${(e as Error).message}`] }; }
  const r = parseScreenContract(json);
  return "problems" in r ? { state: "invalid", file, sha, problems: r.problems } : { state: "valid", file, sha, contract: r.contract };
}

/** The contract that sits beside a design (its screen folder). */
export const readScreenContract = (designDir: string): ContractLoad => readContractFile(path.join(designDir, CONTRACT_FILE));
