import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { readKit, type KitConfig } from "../src/kit.js";
import { openDesign } from "../src/load.js";
import { collectSnapshot, lint } from "../src/lint/index.js";
import { physicalNames } from "../src/lint/snapshot.js";
import { buildIr } from "../src/extract/tree.js";
import type { IrNode, IrScreen } from "../src/ir/types.js";
import { stableStringify } from "../src/ir/stableStringify.js";

/**
 * contracts/css-support-cases.json: one probe page per case, linted and exported for real. The hand-written lint
 * verdicts must hold; `export`, `ir` and `unity` are what the Unity side's agreement test reads, regenerated with
 * UPDATE_CONTRACTS=1 (and otherwise compared, so an exporter or lint change cannot drift from the contract silently).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, "../../../contracts/css-support-cases.json");
const kit: KitConfig = readKit(path.join(here, "fixtures", "extract", "kit"));
const UPDATE = process.env.UPDATE_CONTRACTS === "1";

interface Context { description: string; css: string; html: string }
interface Case {
  id: string; context: string; property: string; value: string; lint: string[]; notes?: string[];
  export?: "ok" | "error"; exportError?: string; unity?: "compile" | "reject" | null; ir?: IrScreen | null;
}
interface CasesFile { version: number; note: string[]; kitRules: Record<string, string>; lintOnlyRules: Record<string, string>; contexts: Record<string, Context>; cases: Case[] }

const contract: CasesFile = JSON.parse(fs.readFileSync(FILE, "utf8"));

const page = (cx: Context, decl: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
:root{-webkit-font-smoothing:antialiased}
*,*::before,*::after{box-sizing:border-box} body{margin:0}
.screen{display:flex;flex-direction:column;width:2560px;height:1440px;position:relative;font-family:"Inter UI";font-size:16px;line-height:20px;color:#ffffff;background-color:#0b1f26}
p{margin:0}
${cx.css.replaceAll("{decl}", decl)}
</style></head><body><div class="screen" data-u-screen="cases">${cx.html}</div></body></html>
`;

interface Result { lint: string[]; notes: string[]; export: "ok" | "error"; exportError?: string; ir: IrScreen | null; unity: "compile" | "reject" | null }

const flat = (n: IrNode): IrNode[] => [n, ...n.children.flatMap(flat)];
const masked = (ir: unknown): unknown => JSON.parse(JSON.stringify(ir), (k, v) => (k === "sha256" || k === "file" ? "<asset>" : v));

/** The IR still holds the case's declaration (or one of its longhands) somewhere: the compiler can see it. */
function carries(ir: IrScreen, c: Case): boolean {
  const decls = `${c.property}: ${c.value}`.split(";").map((d) => d.split(":")[0].trim());
  const names = new Set(decls.flatMap((d) => [d, ...physicalNames(d)]));
  // baked effects leave the style layers for the node's effect fields
  const effects = (n: IrNode) => [
    ...(names.has("box-shadow") ? [n.shadow, n.insetShadow, ...Object.keys(n.shadowLayers), ...Object.keys(n.insetShadowLayers)] : []),
    ...(names.has("background-image") ? [n.background, ...Object.keys(n.backgroundLayers)] : []),
  ].some((x) => x);
  return flat(ir.root).some((n) => effects(n) || Object.values(n.style).some((layer) => Object.keys(layer).some((p) => names.has(p))));
}

let browser: Browser;
let tmp: string;
const results = new Map<string, Result>();

async function run(c: Case): Promise<Result> {
  const dir = path.join(tmp, c.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${c.id}.html`);
  fs.writeFileSync(file, page(contract.contexts[c.context], `${c.property}: ${c.value}`));
  const d = await openDesign(file, kit, [2560, 1440], browser);
  try {
    const s = await collectSnapshot(d.page, d.cdp, kit);
    const findings = await lint(d, kit, s);
    const ids = (sev: (x: string) => boolean) => Array.from(new Set(findings.filter((f) => sev(f.severity)).map((f) => f.ruleId))).sort();
    const r: Result = { lint: ids((x) => x === "error"), notes: ids((x) => x !== "error"), export: "ok", ir: null, unity: null };
    try {
      r.ir = (await buildIr(d, s, kit, path.join(dir, "out"), file)).ir;
    } catch (e) {
      r.export = "error";
      r.exportError = (e as Error).message.split("\n")[0].replaceAll(tmp, "<tmp>");
    }
    if (r.ir) {
      const onlyLintOnly = r.lint.every((id) => id in contract.lintOnlyRules);
      r.unity = onlyLintOnly ? "compile" : carries(r.ir, c) ? "reject" : null;
    }
    return r;
  } finally { await d.close(); }
}

beforeAll(async () => {
  browser = await chromium.launch();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "css-cases-"));
  const queue = [...contract.cases];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) results.set(c.id, await run(c));
  }));
  if (UPDATE) {
    const cases = contract.cases.map((c) => {
      const r = results.get(c.id)!;
      const { export: _e, exportError: _x, unity: _u, ir: _i, ...rest } = c;
      return { ...rest, export: r.export, ...(r.exportError ? { exportError: r.exportError } : {}), unity: r.unity, ir: r.ir };
    });
    fs.writeFileSync(FILE, stableStringify({ ...contract, cases }));
  }
}, 180000);
afterAll(async () => {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("contracts/css-support-cases.json", () => {
  it("has unique ids, known contexts and a {decl} slot in every context", () => {
    expect(new Set(contract.cases.map((c) => c.id)).size).toBe(contract.cases.length);
    for (const c of contract.cases) expect(contract.contexts[c.context], c.id).toBeDefined();
    for (const [n, cx] of Object.entries(contract.contexts)) expect(cx.css.includes("{decl}"), n).toBe(true);
    expect(fs.readFileSync(FILE, "utf8")).toBe(stableStringify(JSON.parse(fs.readFileSync(FILE, "utf8"))));
  });

  for (const c of contract.cases) {
    it(`${c.id}: ${c.lint.length ? c.lint.join(", ") : "accepted"}`, () => {
      const r = results.get(c.id)!;
      expect({ lint: r.lint, notes: r.notes }).toEqual({ lint: c.lint, notes: c.notes ?? [] });
      // whatever lint accepts, the exporter builds and the compiler must compile
      if (!c.lint.length) expect(r.export, r.exportError).toBe("ok");
      if (!c.lint.length) expect(r.unity).toBe("compile");
      expect({ export: r.export, exportError: r.exportError, unity: r.unity }).toEqual({ export: c.export, exportError: c.exportError, unity: c.unity });
      // baked images are Chromium rasters: their bytes (and so their names) may differ between machines
      expect(stableStringify(masked(r.ir))).toBe(stableStringify(masked(c.ir ?? null)));
    });
  }
});
