import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { runCli } from "../src/commands.js";
import { exportScreen, designHash, MARKER_FILE, toolHashInputs } from "../src/export.js";
import { compareScreen, readThresholds } from "../src/compare/compare.js";
import crypto from "node:crypto";
import { validateBoxes } from "../src/boxes/validate.js";
import { BOXES_FILE, openBoxes } from "../src/boxes/file.js";
import { validateIr } from "../src/ir/validate.js";
import { readKit } from "../src/kit.js";

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
  const logged: string[] = [];
  beforeAll(async () => {
    out = path.join(tmp(), "out");
    res = await exportScreen(fx("inbox-mini"), KIT, out, { browser, log: (l) => logged.push(l) });
  }, 120_000);

  it("writes the five outputs and a valid IR", async () => {
    expect(res.ok).toBe(true);
    expect(res.skipped).toBeFalsy();
    expect(res.outDir).toBe(out);
    for (const f of ["screen.ir.json", "lint-report.json", "export-report.json", "fixtures/sample-data.json", `goldens/${BOXES_FILE}`, "goldens/matrix.json"]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    }
    expect(fs.existsSync(path.join(out, "goldens", "boxes.json"))).toBe(false);
    expect(validateIr(readJson(out, "screen.ir.json"))).toEqual([]);
    const boxes = (await openBoxes(path.join(out, "goldens"), "design"))!;
    for (const n of boxes.names) expect(validateBoxes(await boxes.read(n)), n).toEqual([]);
    const files = tree(out);
    expect(files.filter((f) => f.startsWith("assets/") && f.endsWith(".png"))).toHaveLength(1);
    const matrix = readJson(out, "goldens", "matrix.json");
    expect(boxes.names).toEqual(matrix.captures.map((c: { name: string }) => c.name));
    for (const c of matrix.captures) expect(files, c.name).toContain(path.join("goldens", `${c.name}.png`));
    expect(files.filter((f) => f.startsWith("goldens/") && f.endsWith(".png"))).toHaveLength(matrix.captures.length);
    expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("prints the number of captures and the estimated size of their boxes before capturing, and warns only over 200 MB", () => {
    const matrix = readJson(out, "goldens", "matrix.json");
    expect(logged).toEqual([expect.stringMatching(new RegExp(`^capturing ${matrix.captures.length} captures of \\d+ measured elements each: boxes\\.jsonl about \\d+ KB$`))]);
    expect(res.warnings).toEqual([]);
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
    same(path.join("goldens", BOXES_FILE));
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

  it("exports again when the screen contract changes, and reports the contract it read", async () => {
    const design = path.join(tmp(), "d");
    fs.cpSync(fx("inbox-mini"), design, { recursive: true });
    const o = path.join(tmp(), "out");
    const first = await exportScreen(design, KIT, o, { browser });
    expect(first.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(first.contract.state).toBe("absent");
    expect(readJson(o, "export-report.json").contractSha).toBe("none");
    const contract = {
      contract: 1, screen: "inbox-mini", kind: "new",
      values: [
        { name: "club", source: "the club reader", samples: ["Kartal", "Bursa"], origin: "existing" },
        { name: "subject", repeat: "mails", source: "the inbox reader", samples: ["Hos geldin", "Fikstur"], origin: "existing" },
      ],
      actions: [], states: [],
      repeats: [{ name: "mails", source: "the inbox reader", count: [0, 50], origin: "existing" }],
      texts: [{ key: "inbox.title", en: "Inbox", origin: "existing" }, { key: "inbox.logo", en: "Logo", origin: "existing" }],
    };
    const file = path.join(design, "screen.contract.json");
    fs.writeFileSync(file, JSON.stringify(contract));
    const second = await exportScreen(design, KIT, o, { browser });
    expect(second.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(second.skipped).toBeFalsy();
    expect(second.contract.state).not.toBe("absent");
    const sha = readJson(o, "export-report.json").contractSha;
    expect(sha).toBe((second.contract as { sha: string }).sha);
    expect(sha).not.toBe("none");
    expect((await exportScreen(design, KIT, o, { browser })).skipped).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ ...contract, values: [{ ...contract.values[0], samples: ["Kartal", "Izmir"] }] }));
    expect((await exportScreen(design, KIT, o, { browser })).skipped).toBeFalsy();
  }, 240_000);

  it("reports the jobs the design shows in no context (fresh and unchanged exports, export-report.json, the command line)", async () => {
    const design = path.join(tmp(), "d");
    fs.cpSync(fx("inbox-mini"), design, { recursive: true });
    const html = path.join(design, "inbox-mini.html");
    fs.writeFileSync(html, fs.readFileSync(html, "utf8")
      .replace("</style>", ".ghost{display:none;width:40px;height:40px;flex-shrink:0;background-color:#123c47}.ghost:hover{background-color:#16c2d5}</style>")
      .replace('<div class="card" data-u-id="card"></div>', '<div class="card" data-u-id="card"></div><div class="ghost" data-u-id="ghost"></div>'));
    const o = path.join(tmp(), "out");
    const r = await exportScreen(design, KIT, o, { browser });
    expect(r.ok).toBe(true);
    expect(r.hidden.map((h) => h.name)).toEqual(["default@1280x720.hover.ghost", "default@1920x1080.hover.ghost", "default@2560x1440.hover.ghost"]);
    expect(r.hidden[0].reason).toMatch(/ghost not visible/);
    expect(readJson(o, "export-report.json").hidden).toBe(3);
    const again = await exportScreen(design, KIT, o, { browser });
    expect(again.skipped).toBe(true);
    expect(again.hidden).toEqual(r.hidden);
    const out: string[] = [];
    expect(await runCli(["export", design, "--kit", KIT, "--out", o], { out: (x) => out.push(x), err: () => {} })).toBe(0);
    expect(out.join("")).toContain("hidden in the design (not captured, a verify is incomplete): default@1280x720.hover.ghost");
    // a fresh export prints the captures and their boxes' size before capturing
    out.length = 0;
    expect(await runCli(["export", design, "--kit", KIT, "--out", o, "--force"], { out: (x) => out.push(x), err: () => {} })).toBe(0);
    expect(out[0]).toMatch(/^capturing \d+ captures of \d+ measured elements each: boxes\.jsonl about \d+ KB\n$/);
    expect((await exportScreen(fx("inbox-mini"), KIT, path.join(tmp(), "o"), { browser })).hidden).toEqual([]);
  }, 240_000);

  it("accepts the html file path as input", async () => {
    const o = path.join(tmp(), "out");
    const r = await exportScreen(fx("inbox-mini", "inbox-mini.html"), KIT, o, { browser });
    expect(r.ok).toBe(true);
    expect(readJson(o, "screen.ir.json").screen).toBe("inbox-mini");
  }, 120_000);
});

describe("exportScreen: image binds in repeat items", () => {
  it("writes every written-out item's image to assets/ and references it from the sample data", async () => {
    const out = path.join(tmp(), "out");
    const r = await exportScreen(path.join(here, "fixtures", "extract", "repeat-images.html"), KIT, out, { browser });
    expect(r.ok).toBe(true);
    const sample = readJson(out, "fixtures", "sample-data.json");
    const images: { file: string; sha256: string; width: number; height: number }[] = [];
    let none = 0;
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k !== "$image") walk(x);
          else if (x === null) none++;
          else images.push(x as (typeof images)[number]);
        }
      }
    };
    walk(sample);
    // the screen's logo, five rows' crests and flags (two crests and a flag show none), five badges, three list entries
    expect(images).toHaveLength(1 + 3 + 4 + 5 + 3);
    expect(none).toBe(3);
    for (const i of images) {
      expect(Object.keys(i).sort(), i.file).toEqual(["file", "height", "sha256", "width"]);
      expect(i.file).toBe(`assets/${i.sha256}${path.extname(i.file)}`);
      expect(crypto.createHash("sha256").update(fs.readFileSync(path.join(out, i.file))).digest("hex"), i.file).toBe(i.sha256);
    }
    // seven distinct pictures, all in assets/; the IR's own nodes reference four of them
    const files = Array.from(new Set(images.map((i) => i.file)));
    expect(files).toHaveLength(7);
    expect(tree(out, "assets")).toHaveLength(7);
    const ir = fs.readFileSync(path.join(out, "screen.ir.json"), "utf8");
    expect(files.filter((f) => ir.includes(f))).toHaveLength(4);
  }, 120_000);
});

describe("exportScreen: failures", () => {
  it("lint errors write only lint-report.json, replacing an earlier export", async () => {
    const out = path.join(tmp(), "out");
    fs.mkdirSync(path.join(out, "goldens"), { recursive: true });
    fs.writeFileSync(path.join(out, "goldens", "stale.png"), "x");
    fs.writeFileSync(path.join(out, "screen.ir.json"), "{}");
    fs.writeFileSync(path.join(out, MARKER_FILE), JSON.stringify({ generator: "design-export", format: 1 }));
    const r = await exportScreen(fx("lint-error"), KIT, out, { browser });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.ruleId === "U-CSS-001" && f.severity === "error")).toBe(true);
    expect(tree(out)).toEqual([MARKER_FILE, "lint-report.json"]);
    expect(readJson(out, "lint-report.json").findings.some((f: { ruleId: string }) => f.ruleId === "U-CSS-001")).toBe(true);
    expect(fs.readdirSync(path.dirname(out)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  }, 120_000);

  it("a kit that requires a screen contract stops the export of a design without one", async () => {
    // the import exports first, so it refuses such a design too
    const out = path.join(tmp(), "out");
    const r = await exportScreen(fx("inbox-mini"), { ...readKit(KIT), screenContract: "required" }, out, { browser });
    expect(r.ok).toBe(false);
    expect(r.contract.state).toBe("absent");
    expect(r.findings.filter((f) => f.severity === "error").map((f) => `${f.ruleId}: ${f.detail}`))
      .toEqual(["U-CON-001: no screen.contract.json beside the design, and the kit requires one (screenContract: required)"]);
    expect(fs.existsSync(path.join(out, "export-report.json"))).toBe(false);
    expect(tree(out)).toEqual([MARKER_FILE, "lint-report.json"]);
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

  it("keeps the captures finished before a capture failure in <out>.failed; a newer failure replaces it, a successful export removes it", async () => {
    // a browser whose new pages fail once the capture has started: the reference viewport (the export's own page) is
    // captured, the next viewport cannot open
    let started = false;
    const failing = new Proxy(browser, {
      get(t, p) {
        if (p === "newContext") return (...a: Parameters<Browser["newContext"]>) => (started ? Promise.reject(new Error("the browser is gone")) : t.newContext(...a));
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const opts = { browser: failing, concurrency: 1, log: () => { started = true; } };
    const out = path.join(tmp(), "out"), failed = `${out}.failed`;
    const fail = async () => {
      started = false;
      const e = await exportScreen(fx("inbox-mini"), KIT, out, opts).then(() => null, (x: Error) => x);
      expect(e?.message).toMatch(new RegExp(`^capture failed while opening viewport \\d+x\\d+, after (\\d+) of 9 captures were finished: the browser is gone; ` +
        `the finished captures are kept in ${failed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      return Number(/after (\d+) of/.exec(e!.message)![1]);
    };
    const finished = await fail();
    expect(finished).toBeGreaterThan(0);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(path.dirname(out)).filter((n) => n.includes(".tmp-"))).toEqual([]);
    // the folder holds the IR, the N finished captures (PNG and boxes line each) and why it failed; it is no export
    expect(readJson(failed, "export-failure.json")).toEqual({ ok: false, stage: "capture", doing: expect.stringMatching(/^opening viewport /), finished, captures: 9,
      error: expect.stringMatching(/^capture failed while opening viewport .*: the browser is gone$/) });
    expect(fs.existsSync(path.join(failed, "screen.ir.json"))).toBe(true);
    expect(fs.existsSync(path.join(failed, "export-report.json"))).toBe(false);
    const boxes = (await openBoxes(path.join(failed, "goldens"), "design"))!;
    expect(boxes.names).toHaveLength(finished);
    for (const n of boxes.names) {
      expect(validateBoxes(await boxes.read(n)), n).toEqual([]);
      expect(fs.existsSync(path.join(failed, "goldens", `${n}.png`)), n).toBe(true);
    }
    expect(fs.readdirSync(path.join(failed, "goldens")).filter((f) => f.endsWith(".png"))).toHaveLength(finished);
    await expect(compareScreen(failed, failed, readThresholds())).rejects.toThrow(/is the folder of an export whose capture failed/);
    // a newer failure replaces it
    fs.writeFileSync(path.join(failed, "planted.txt"), "from the first failure");
    expect(await fail()).toBe(finished);
    expect(fs.existsSync(path.join(failed, "planted.txt"))).toBe(false);
    expect(fs.existsSync(path.join(failed, "export-failure.json"))).toBe(true);
    // the sweep of a crashed run's temp folders leaves it (a lint failure keeps the previous export and sweeps)
    const crashed = `${out}.tmp-0123abcd`;
    fs.mkdirSync(crashed);
    const lint = await exportScreen(fx("lint-error"), KIT, out, { browser, lintReportFile: path.join(tmp(), "lint-report.json") });
    expect(lint.ok).toBe(false);
    expect(fs.existsSync(crashed)).toBe(false);
    expect(fs.existsSync(path.join(failed, "export-failure.json"))).toBe(true);
    // a successful export removes it
    const ok = await exportScreen(fx("inbox-mini"), KIT, out, { browser, concurrency: 1 });
    expect(ok.ok).toBe(true);
    expect(fs.existsSync(failed)).toBe(false);
    expect(fs.existsSync(path.join(out, "export-report.json"))).toBe(true);
  }, 240_000);

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

  it("refuses a foreign folder with a stray lint-report.json or export-report.json", async () => {
    const d = copyDesign();
    const other = path.join(tmp(), "reports");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "a.txt"), "x");
    fs.writeFileSync(path.join(other, "lint-report.json"), "{}");
    fs.writeFileSync(path.join(other, "export-report.json"), "{}");
    await expect(exportScreen(d, KIT, other, { browser })).rejects.toThrow(/not a previous export/);
    fs.writeFileSync(path.join(other, MARKER_FILE), JSON.stringify({ generator: "something-else", format: 1 }));
    await expect(exportScreen(d, KIT, other, { browser })).rejects.toThrow(/not a previous export/);
    expect(fs.readFileSync(path.join(other, "a.txt"), "utf8")).toBe("x");
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

  it("the tool hash covers what the goldens record: their schema and the extraction revision (an older export is made again)", () => {
    // an export of an extractor whose goldens lack a record (the ellipsis cut of decisions D-146/D-147, added to the boxes after
    // revision 2) must not be reused: the comparison cannot apply what the record decides
    const schema = fs.readFileSync(path.join(here, "..", "src", "boxes", "schema.json"));
    const inputs = toolHashInputs();
    expect(inputs).toContain(`boxes ${crypto.createHash("sha256").update(schema).digest("hex")}`);
    expect(inputs).toContain("extract 4");
  });

  it("an export of IR version 1 is made again: its tool hash names the version-1 schema, and its IR's version is read too", async () => {
    const out = path.join(tmp(), "out");
    await exportScreen(fx("inbox-mini"), KIT, out, { browser });
    const irFile = path.join(out, "screen.ir.json"), repFile = path.join(out, "export-report.json");
    const rep = readJson(repFile);
    // what an exporter of IR version 1 recorded: the schema with irVersion 1 in its tool hash, texts under "tr"
    const schemaFile = path.join(here, "..", "src", "ir", "schema.json");
    const schema = fs.readFileSync(schemaFile, "utf8");
    const v1Schema = schema.replace(/("irVersion": \{\s*"const": )2/, "$11");
    expect(v1Schema).not.toBe(schema);
    const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
    const inputs = toolHashInputs();
    expect(inputs).toContain(sha(schema));
    const v1Tool = sha(inputs.map((i) => (i === sha(schema) ? sha(v1Schema) : i)).join("\n"));
    expect(v1Tool).not.toBe(rep.toolSha);
    const asV1 = (toolSha: string) => {
      fs.writeFileSync(irFile, fs.readFileSync(irFile, "utf8").replace(/"irVersion": 2/, '"irVersion": 1').replace(/"ref":/g, '"tr":'));
      fs.writeFileSync(repFile, JSON.stringify({ ...rep, toolSha }));
    };
    const again = async () => {
      const r = await exportScreen(fx("inbox-mini"), KIT, out, { browser });
      const ir = readJson(irFile);
      return { skipped: !!r.skipped, irVersion: ir.irVersion, valid: validateIr(ir) };
    };

    asV1(v1Tool);
    expect(await again()).toEqual({ skipped: false, irVersion: 2, valid: [] });
    // the same IR recorded with this tool's hash (a server process older than its clone's schema file wrote it): made again
    asV1(rep.toolSha);
    expect(await again()).toEqual({ skipped: false, irVersion: 2, valid: [] });
    expect(await again()).toEqual({ skipped: true, irVersion: 2, valid: [] });
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
    fs.copyFileSync(path.join(aside, MARKER_FILE), path.join(`${out}.tmp-cafe0000`, MARKER_FILE));
    // never ours: wrong name shape, or no marker
    fs.mkdirSync(`${out}.tmp-notes`);
    fs.writeFileSync(`${out}.tmp-notes/keep.txt`, "k");
    fs.mkdirSync(`${out}.tmp-beef0000`);
    fs.writeFileSync(`${out}.tmp-beef0000/keep.txt`, "k");
    const r = await exportScreen(fx("inbox-mini"), KIT, out, { browser });
    expect(r.skipped).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/restored/);
    expect(fs.existsSync(path.join(out, "screen.ir.json"))).toBe(true);
    expect(fs.readdirSync(path.dirname(out)).filter((n) => n.includes(".tmp-")).sort()).toEqual([`${path.basename(out)}.tmp-beef0000`, `${path.basename(out)}.tmp-notes`]);
    expect(fs.readFileSync(`${out}.tmp-notes/keep.txt`, "utf8")).toBe("k");
    expect(fs.readFileSync(`${out}.tmp-beef0000/keep.txt`, "utf8")).toBe("k");
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

  it("lint: a design folder without a contract prints one note", async () => {
    const r = await run("lint", fx("inbox-mini"), "--kit", KIT);
    expect(r.stdout).toMatch(/^0 errors, 0 warnings, 1 note$/m);
  }, 120_000);

  it("export: exit 0 and the layout, exit 1 on lint errors", async () => {
    const out = path.join(tmp(), "out");
    const ok = await run("export", fx("inbox-mini"), "--kit", KIT, "--out", out);
    expect(ok.code).toBe(0);
    expect(fs.existsSync(path.join(out, "screen.ir.json"))).toBe(true);
    const out2 = path.join(tmp(), "out");
    const bad = await run("export", fx("lint-error"), "--kit", KIT, "--out", out2);
    expect(bad.code).toBe(1);
    expect(tree(out2)).toEqual([MARKER_FILE, "lint-report.json"]);
  }, 240_000);

  it("exit 2 for usage and internal errors", async () => {
    expect((await run()).code).toBe(2);
    expect((await run("export", fx("inbox-mini"))).code).toBe(2);
    expect((await run("frobnicate")).code).toBe(2);
    expect((await run("export", tmp(), "--kit", KIT, "--out", path.join(tmp(), "o"))).code).toBe(2);
    expect((await run("--help")).code).toBe(0);
  }, 120_000);
});
