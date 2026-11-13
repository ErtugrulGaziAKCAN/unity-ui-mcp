import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { runCli } from "../src/commands.js";
import { exportScreen } from "../src/export.js";
import { validateBoxes } from "../src/boxes/validate.js";
import { validateIr } from "../src/ir/validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (...n: string[]) => path.join(here, "fixtures", "export", ...n);
const KIT = path.join(here, "fixtures", "extract", "kit");

let browser: Browser;
const tmpDirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "export-")); tmpDirs.push(d); return d; };
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => {
  await browser.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const readJson = (...p: string[]) => JSON.parse(fs.readFileSync(path.join(...p), "utf8"));
const tree = (dir: string, rel = ""): string[] =>
  fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((d) => d.isDirectory() ? tree(dir, path.join(rel, d.name)) : [path.join(rel, d.name)]).sort();

describe("exportScreen: inbox-mini", () => {
  let out: string;
  let res: Awaited<ReturnType<typeof exportScreen>>;
  beforeAll(async () => {
    out = path.join(tmp(), "out");
    res = await exportScreen(fx("inbox-mini"), KIT, out, { browser });
  }, 120_000);

  it("writes the five outputs and a valid IR", () => {
    expect(res.ok).toBe(true);
    expect(res.skipped).toBeFalsy();
    expect(res.outDir).toBe(out);
    for (const f of ["screen.ir.json", "lint-report.json", "export-report.json", "fixtures/sample-data.json", "goldens/boxes.json", "goldens/matrix.json"]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    }
    expect(validateIr(readJson(out, "screen.ir.json"))).toEqual([]);
    for (const b of Object.values(readJson(out, "goldens", "boxes.json"))) expect(validateBoxes(b)).toEqual([]);
    const files = tree(out);
    expect(files.filter((f) => f.startsWith("assets/") && f.endsWith(".png"))).toHaveLength(1);
    const matrix = readJson(out, "goldens", "matrix.json");
    for (const c of matrix.captures) expect(files, c.name).toContain(path.join("goldens", `${c.name}.png`));
    expect(files.filter((f) => f.startsWith("goldens/") && f.endsWith(".png"))).toHaveLength(matrix.captures.length);
    expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("writes sample data for binds and repeats", () => {
    const sample = readJson(out, "fixtures", "sample-data.json");
    expect(sample.club).toBe("Kartal");
    expect(sample.mails).toHaveLength(2);
    expect(sample.mails[0].subject).toBe("Hos geldin");
    expect(sample.mails[0].$classes).toBeDefined();
  });

  it("reports per-step timings in the result and in export-report.json", () => {
    for (const t of [res.timings, readJson(out, "export-report.json").timings]) {
      for (const k of ["load", "lint", "extract", "bake", "capture", "write", "total"]) expect(typeof t[k], k).toBe("number");
    }
    const rep = readJson(out, "export-report.json");
    expect(rep.sourceSha).toMatch(/^[0-9a-f]{64}$/);
    expect(rep.kitSha).toMatch(/^[0-9a-f]{64}$/);
    expect(rep.ok).toBe(true);
  });

  it("does not close a browser it was given", () => {
    expect(browser.isConnected()).toBe(true);
  });

  it("is deterministic: two exports give identical IR, boxes and assets", async () => {
    const other = path.join(tmp(), "out");
    const r2 = await exportScreen(fx("inbox-mini"), KIT, other, { browser });
    expect(r2.ok).toBe(true);
    const same = (f: string) => expect(fs.readFileSync(path.join(other, f), "utf8")).toBe(fs.readFileSync(path.join(out, f), "utf8"));
    same("screen.ir.json");
    same(path.join("goldens", "boxes.json"));
    same(path.join("fixtures", "sample-data.json"));
    expect(tree(other, "assets")).toEqual(tree(out, "assets"));
  }, 120_000);

  it("skips when the design and the kit are unchanged, and re-exports when either changes", async () => {
    const mtime = fs.statSync(path.join(out, "screen.ir.json")).mtimeMs;
    const again = await exportScreen(fx("inbox-mini"), KIT, out, { browser });
    expect(again).toMatchObject({ ok: true, skipped: true });
    expect(fs.statSync(path.join(out, "screen.ir.json")).mtimeMs).toBe(mtime);
    const forced = await exportScreen(fx("inbox-mini"), KIT, out, { browser, force: true });
    expect(forced.skipped).toBeFalsy();

    const design = path.join(tmp(), "d");
    fs.cpSync(fx("inbox-mini"), design, { recursive: true });
    const o2 = path.join(tmp(), "out");
    await exportScreen(design, KIT, o2, { browser });
    fs.appendFileSync(path.join(design, "inbox-mini.html"), "\n<!-- edit -->\n");
    expect((await exportScreen(design, KIT, o2, { browser })).skipped).toBeFalsy();
    expect((await exportScreen(design, KIT, o2, { browser })).skipped).toBe(true);
  }, 240_000);

  it("accepts the html file path as input", async () => {
    const o = path.join(tmp(), "out");
    const r = await exportScreen(fx("inbox-mini", "inbox-mini.html"), KIT, o, { browser });
    expect(r.ok).toBe(true);
    expect(readJson(o, "screen.ir.json").screen).toBe("inbox-mini");
  }, 120_000);
});

describe("exportScreen: failures", () => {
  it("lint errors write only lint-report.json, replacing an earlier export", async () => {
    const out = path.join(tmp(), "out");
    fs.mkdirSync(path.join(out, "goldens"), { recursive: true });
    fs.writeFileSync(path.join(out, "goldens", "stale.png"), "x");
    fs.writeFileSync(path.join(out, "screen.ir.json"), "{}");
    const r = await exportScreen(fx("lint-error"), KIT, out, { browser });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.ruleId === "U-CSS-001" && f.severity === "error")).toBe(true);
    expect(tree(out)).toEqual(["lint-report.json"]);
    expect(readJson(out, "lint-report.json").findings.some((f: { ruleId: string }) => f.ruleId === "U-CSS-001")).toBe(true);
    expect(fs.readdirSync(path.dirname(out)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  }, 120_000);

  it("an internal error leaves the previous export intact and no temp folder", async () => {
    const out = path.join(tmp(), "out");
    const empty = tmp();
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "keep.txt"), "previous");
    await expect(exportScreen(empty, KIT, out, { browser })).rejects.toThrow();
    expect(fs.readFileSync(path.join(out, "keep.txt"), "utf8")).toBe("previous");
    expect(fs.readdirSync(path.dirname(out)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  }, 120_000);

  it("reports a missing design or kit as an error", async () => {
    await expect(exportScreen(path.join(tmp(), "nope"), KIT, path.join(tmp(), "o"), { browser })).rejects.toThrow(/not found|no such/i);
    await expect(exportScreen(fx("inbox-mini"), path.join(tmp(), "nokit"), path.join(tmp(), "o"), { browser })).rejects.toThrow();
  });
});

describe("cli", () => {
  const run = async (...argv: string[]) => {
    let stdout = "", stderr = "";
    const code = await runCli(argv, { out: (s) => { stdout += s; }, err: (s) => { stderr += s; } });
    return { code, stdout, stderr };
  };

  it("lint: exit 0 for a clean design, 1 with findings printed for errors", async () => {
    const ok = await run("lint", fx("inbox-mini"), "--kit", KIT);
    expect(ok.code).toBe(0);
    const bad = await run("lint", fx("lint-error"), "--kit", KIT);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("U-CSS-001");
  }, 120_000);

  it("export: exit 0 and the layout, exit 1 on lint errors", async () => {
    const out = path.join(tmp(), "out");
    const ok = await run("export", fx("inbox-mini"), "--kit", KIT, "--out", out);
    expect(ok.code).toBe(0);
    expect(fs.existsSync(path.join(out, "screen.ir.json"))).toBe(true);
    const out2 = path.join(tmp(), "out");
    const bad = await run("export", fx("lint-error"), "--kit", KIT, "--out", out2);
    expect(bad.code).toBe(1);
    expect(tree(out2)).toEqual(["lint-report.json"]);
  }, 240_000);

  it("exit 2 for usage and internal errors", async () => {
    expect((await run()).code).toBe(2);
    expect((await run("export", fx("inbox-mini"))).code).toBe(2);
    expect((await run("frobnicate")).code).toBe(2);
    expect((await run("export", tmp(), "--kit", KIT, "--out", path.join(tmp(), "o"))).code).toBe(2);
    expect((await run("--help")).code).toBe(0);
  }, 120_000);
});
