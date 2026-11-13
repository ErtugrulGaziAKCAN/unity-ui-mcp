import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { runCli } from "../src/commands.js";
import { exportScreen, designHash } from "../src/export.js";
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
      for (const k of ["load", "lint", "extract", "bake", "capture", "write"]) expect(typeof t[k], k).toBe("number");
    }
    expect(typeof res.totalMs).toBe("number");
    const rep = readJson(out, "export-report.json");
    expect(typeof rep.totalMs).toBe("number");
    expect(rep.toolSha).toMatch(/^[0-9a-f]{64}$/);
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
    fs.writeFileSync(path.join(out, "export-report.json"), "{}");
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

describe("output folder safety", () => {
  const copyDesign = () => {
    const d = path.join(tmp(), "design");
    fs.cpSync(fx("inbox-mini"), d, { recursive: true });
    fs.writeFileSync(path.join(d, "notes.txt"), "keep me");
    return d;
  };

  it("refuses out == design folder, out == the design file and out == an ancestor, and deletes nothing", async () => {
    const d = copyDesign();
    for (const out of [d, path.join(d, "inbox-mini.html"), path.dirname(d), path.dirname(path.dirname(d)), path.parse(d).root, os.homedir()]) {
      await expect(exportScreen(d, KIT, out, { browser }), out).rejects.toThrow(/refusing to use/);
    }
    expect(fs.readFileSync(path.join(d, "notes.txt"), "utf8")).toBe("keep me");
    expect(fs.existsSync(path.join(d, "inbox-mini.html"))).toBe(true);
    expect(fs.existsSync(path.join(d, "assets", "logo.png"))).toBe(true);
  });

  it("refuses an existing non-empty folder that is not a previous export, and an existing file", async () => {
    const d = copyDesign();
    const other = path.join(tmp(), "documents");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "thesis.txt"), "x");
    await expect(exportScreen(d, KIT, other, { browser })).rejects.toThrow(/not a previous export/);
    expect(fs.readFileSync(path.join(other, "thesis.txt"), "utf8")).toBe("x");
    const file = path.join(tmp(), "f.txt");
    fs.writeFileSync(file, "x");
    await expect(exportScreen(d, KIT, file, { browser })).rejects.toThrow(/not a folder/);
    // an empty folder and a path inside the design folder are fine
    const empty = path.join(tmp(), "empty");
    fs.mkdirSync(empty);
    expect((await exportScreen(d, KIT, empty, { browser })).ok).toBe(true);
    expect((await exportScreen(d, KIT, path.join(d, "out"), { browser })).ok).toBe(true);
  }, 120_000);

  it("cli: out == design exits 2 and keeps the design", async () => {
    const d = copyDesign();
    let err = "";
    const code = await runCli(["export", d, "--kit", KIT, "--out", d], { out: () => {}, err: (s) => { err += s; } });
    expect(code).toBe(2);
    expect(err).toMatch(/refusing/);
    expect(fs.existsSync(path.join(d, "inbox-mini.html"))).toBe(true);
  });
});

describe("skip hash", () => {
  it("covers the design file, blobs.json, referenced assets and the kit, and ignores unrelated files", async () => {
    const d = path.join(tmp(), "design");
    fs.cpSync(fx("inbox-mini"), d, { recursive: true });
    const kitCopy = path.join(tmp(), "kit");
    fs.cpSync(KIT, kitCopy, { recursive: true });
    const out = path.join(tmp(), "out");
    await exportScreen(path.join(d, "inbox-mini.html"), kitCopy, out, { browser });
    const again = async () => (await exportScreen(entry, kitCopy, out, { browser })).skipped === true;

    fs.writeFileSync(path.join(d, "unrelated.txt"), "x");
    fs.writeFileSync(path.join(d, "other-screen.html"), "<p>other</p>");
    const entry = path.join(d, "inbox-mini.html");
    fs.mkdirSync(path.join(d, "inbox-mini.html.tmp-abc"));
    expect(await again()).toBe(true);

    // blobs.json next to the design
    fs.writeFileSync(path.join(d, "blobs.json"), "{}");
    expect(await again()).toBe(false);
    expect(await again()).toBe(true);

    // a referenced asset
    fs.appendFileSync(path.join(d, "assets", "logo.png"), Buffer.from([0]));
    expect(await again()).toBe(false);
    expect(await again()).toBe(true);

    // a kit file
    fs.appendFileSync(path.join(kitCopy, "tokens.css"), "\n:root{--x:1px}\n");
    expect(await again()).toBe(false);
    expect(await again()).toBe(true);

    // a changed tool (the recorded hash) is not skipped
    const rep = readJson(out, "export-report.json");
    fs.writeFileSync(path.join(out, "export-report.json"), JSON.stringify({ ...rep, toolSha: "0".repeat(64) }));
    expect(await again()).toBe(false);
  }, 300_000);

  it("a lone html file hashes its references, not the folder; a symlinked asset is followed", () => {
    const d = path.join(tmp(), "design");
    fs.cpSync(fx("inbox-mini"), d, { recursive: true });
    const h = designHash(path.join(d, "inbox-mini.html"));
    fs.writeFileSync(path.join(d, "x.bin"), "1");
    expect(designHash(path.join(d, "inbox-mini.html"))).toBe(h);
    const real = path.join(tmp(), "real.png");
    fs.copyFileSync(path.join(d, "assets", "logo.png"), real);
    fs.rmSync(path.join(d, "assets", "logo.png"));
    fs.symlinkSync(real, path.join(d, "assets", "logo.png"));
    expect(designHash(path.join(d, "inbox-mini.html"))).toBe(h);
    fs.appendFileSync(real, Buffer.from([1]));
    expect(designHash(path.join(d, "inbox-mini.html"))).not.toBe(h);
  });
});

describe("robust replace", () => {
  it("restores an orphaned previous export, sweeps stale temp folders", async () => {
    const out = path.join(tmp(), "out");
    await exportScreen(fx("inbox-mini"), KIT, out, { browser });
    const aside = `${out}.tmp-old-deadbeef`;
    fs.renameSync(out, aside); // crash between the two renames
    fs.mkdirSync(`${out}.tmp-cafe0000`);
    fs.writeFileSync(`${out}.tmp-cafe0000/half.png`, "x");
    const r = await exportScreen(fx("inbox-mini"), KIT, out, { browser });
    expect(r.skipped).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/restored/);
    expect(fs.existsSync(path.join(out, "screen.ir.json"))).toBe(true);
    expect(fs.readdirSync(path.dirname(out)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  }, 120_000);

  it("a second export into the same folder fails clearly while the first runs; a stale lock is taken over", async () => {
    const out = path.join(tmp(), "out");
    fs.writeFileSync(`${out}.lock`, String(process.pid));
    await expect(exportScreen(fx("inbox-mini"), KIT, out, { browser })).rejects.toThrow(/another export.*running/);
    expect(fs.existsSync(`${out}.lock`)).toBe(true);
    fs.writeFileSync(`${out}.lock`, "999999");
    expect((await exportScreen(fx("inbox-mini"), KIT, out, { browser })).ok).toBe(true);
    expect(fs.existsSync(`${out}.lock`)).toBe(false);
  }, 120_000);

  it("with lintReportFile a lint failure keeps the previous export", async () => {
    const out = path.join(tmp(), "out");
    const report = path.join(path.dirname(out), "lint-report.json");
    await exportScreen(fx("inbox-mini"), KIT, out, { browser });
    const r = await exportScreen(fx("lint-error"), KIT, out, { browser, lintReportFile: report });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(out, "screen.ir.json"))).toBe(true);
    expect(readJson(report).findings.some((f: { ruleId: string }) => f.ruleId === "U-CSS-001")).toBe(true);
    const ok = await exportScreen(fx("inbox-mini"), KIT, out, { browser, lintReportFile: report, force: true });
    expect(ok.ok).toBe(true);
    expect(fs.existsSync(report)).toBe(false);
  }, 120_000);
});

describe("cli", () => {
  it("rejects excess arguments", async () => {
    const code = await runCli(["lint", fx("inbox-mini"), "extra", "--kit", KIT], { out: () => {}, err: () => {} });
    expect(code).toBe(2);
  });

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
