import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyClean, FAILED_RUNS_KEPT, isBusy, markBusy, planClean, ScreenBusyError } from "../src/cache.js";
import { readConfig } from "../src/config.js";
import { tempDir } from "./helpers.js";

const KB = 1024;

/** A designRoot with screen folders whose bookkeeping holds fake runs: export, captures, difference images, failed runs. */
function designRoot(): { root: string; screen(folder: string, o?: { importedAt?: string; verifiedAt?: string; exportKB?: number; failed?: number }): string } {
  const root = tempDir("design-ui-cache-");
  return {
    root,
    screen(folder, o = {}) {
      const dir = path.join(root, folder), book = path.join(dir, ".design-ui");
      fs.mkdirSync(path.join(book, "export", "goldens"), { recursive: true });
      fs.writeFileSync(path.join(dir, "index.html"), `<div data-u-screen="${folder}">x</div>`);
      fs.writeFileSync(path.join(book, "export", "screen.ir.json"), "{}");
      fs.writeFileSync(path.join(book, "export", "goldens", "default.png"), Buffer.alloc((o.exportKB ?? 100) * KB));
      fs.writeFileSync(path.join(book, "last-import.json"), JSON.stringify({ screen: folder, importedAt: o.importedAt ?? "2026-11-10T10:00:00.000Z" }));
      if (o.verifiedAt) fs.writeFileSync(path.join(book, "last-verify.json"), JSON.stringify({ screen: folder, verifiedAt: o.verifiedAt }));
      fs.writeFileSync(path.join(book, "lint-report.json"), "{}");
      fs.mkdirSync(path.join(book, "unity"));
      fs.writeFileSync(path.join(book, "unity", "default.png"), Buffer.alloc(50 * KB));
      fs.mkdirSync(path.join(book, "compare", "diff"), { recursive: true });
      fs.writeFileSync(path.join(book, "compare", "diff", "default.png"), Buffer.alloc(20 * KB));
      fs.writeFileSync(path.join(book, "compare", "verdict.json"), "{}");
      fs.mkdirSync(path.join(book, "report"));
      fs.writeFileSync(path.join(book, "report", "default-1-design.png"), Buffer.alloc(2 * KB));
      for (let k = 0; k < (o.failed ?? 0); k++) {
        const f = path.join(book, `failed-2026-11-0${k + 1}T00-00-00-000Z`);
        fs.mkdirSync(f);
        fs.writeFileSync(path.join(f, "unity.log"), "log");
      }
      return dir;
    },
  };
}

const left = (dir: string) => fs.readdirSync(path.join(dir, ".design-ui")).sort();

describe("bookkeeping cleanup", () => {
  it("keeps a screen's records, export, report pictures and verdict, and removes a finished verify's captures and difference images", () => {
    const d = designRoot();
    const dir = d.screen("inbox", { failed: FAILED_RUNS_KEPT + 2 });
    const plan = planClean(d.root, 2048);
    expect(plan.removals.map((r) => path.relative(dir, r.path)).sort()).toEqual([
      ".design-ui/compare/diff", ".design-ui/failed-2026-11-01T00-00-00-000Z", ".design-ui/failed-2026-11-02T00-00-00-000Z", ".design-ui/unity",
    ]);
    expect(plan.after).toBeLessThan(plan.before);
    applyClean(plan);
    expect(left(dir)).toEqual(["compare", "export", "failed-2026-11-03T00-00-00-000Z", "failed-2026-11-04T00-00-00-000Z", "failed-2026-11-05T00-00-00-000Z",
      "last-import.json", "lint-report.json", "report"]);
    expect(fs.readdirSync(path.join(dir, ".design-ui", "compare"))).toEqual(["verdict.json"]);
    expect(fs.existsSync(path.join(dir, "index.html"))).toBe(true);
    // nothing left to remove
    expect(planClean(d.root, 2048).removals).toEqual([]);
  });

  it("over the budget, removes the exports of the screens least recently imported or verified, oldest first, never a busy one", () => {
    const d = designRoot();
    const old = d.screen("old", { importedAt: "2026-11-01T00:00:00.000Z", exportKB: 400 });
    const mid = d.screen("mid", { importedAt: "2026-11-02T00:00:00.000Z", verifiedAt: "2026-11-09T00:00:00.000Z", exportKB: 400 });
    const busy = d.screen("busy", { importedAt: "2026-10-01T00:00:00.000Z", exportKB: 400 });
    const fresh = d.screen("fresh", { importedAt: "2026-11-05T00:00:00.000Z", exportKB: 400 });
    const done = markBusy(busy, "verify");
    try {
      expect(isBusy(busy)).toBe(true);
      // 4 × ~400 KB of exports, budget 1 MB: the two oldest that are not busy go (old, then fresh: mid was verified later)
      const plan = planClean(d.root, 1);
      const exports = plan.removals.filter((r) => r.path.endsWith(`${path.sep}export`)).map((r) => r.screen);
      expect(exports).toEqual(["old", "fresh"]);
      expect(plan.removals.some((r) => r.screen === "busy")).toBe(false);
      expect(plan.after).toBeLessThanOrEqual(plan.budget);
      applyClean(plan);
      expect(fs.existsSync(path.join(old, ".design-ui", "export"))).toBe(false);
      expect(fs.existsSync(path.join(old, ".design-ui", "last-import.json"))).toBe(true);
      expect(fs.existsSync(path.join(mid, ".design-ui", "export"))).toBe(true);
      expect(fs.existsSync(path.join(busy, ".design-ui", "unity")), "a busy screen keeps what its run writes").toBe(true);
      expect(fs.existsSync(path.join(fresh, ".design-ui", "export"))).toBe(false);
    } finally { done(); }
    expect(isBusy(busy)).toBe(false);
  });

  it("marks the report of a screen whose export the budget removed: its design pictures are gone until the next verify", () => {
    const d = designRoot();
    const old = d.screen("old", { importedAt: "2026-11-01T00:00:00.000Z", exportKB: 400 });
    d.screen("fresh", { importedAt: "2026-11-05T00:00:00.000Z", exportKB: 400 });
    const report = path.join(old, "report.html");
    fs.writeFileSync(report, '<!doctype html><html><head><title>r</title></head><body><h1>old</h1><img src=".design-ui/export/goldens/default.png"></body></html>');
    applyClean(planClean(d.root, 0.5));
    expect(fs.existsSync(path.join(old, ".design-ui", "export"))).toBe(false);
    const html = fs.readFileSync(report, "utf8");
    expect(html).toContain("Export pruned; re-run verify for images");
    expect(html.indexOf("Export pruned")).toBeLessThan(html.indexOf("<h1>old</h1>"));
    // once only
    applyClean({ ...planClean(d.root, 0.5), removals: [{ screen: "old", path: path.join(old, ".design-ui", "export"), bytes: 0, why: "test" }] });
    expect(fs.readFileSync(report, "utf8").split("Export pruned").length).toBe(2);
  });

  it("asked for one screen, lists only its removals; its export goes only when the whole designRoot is over budget", () => {
    const d = designRoot();
    d.screen("a", { importedAt: "2026-11-01T00:00:00.000Z", exportKB: 600 });
    d.screen("b", { importedAt: "2026-11-02T00:00:00.000Z", exportKB: 600 });
    expect(planClean(d.root, 2048, "b").removals.map((r) => path.basename(r.path)).sort()).toEqual(["diff", "unity"]);
    // over 1 MB the oldest (a) goes first, which brings the total under budget: b keeps its export
    expect(planClean(d.root, 1, "b").removals.map((r) => path.basename(r.path)).sort()).toEqual(["diff", "unity"]);
    expect(planClean(d.root, 1, "a").removals.map((r) => path.basename(r.path)).sort()).toEqual(["diff", "export", "unity"]);
  });

  it("captures a verify kept on request: the automatic cleanup keeps them within the budget and removes them first over it; design_ui_clean removes them", () => {
    const d = designRoot();
    const old = d.screen("old", { importedAt: "2026-11-01T00:00:00.000Z", exportKB: 300 });
    const fresh = d.screen("fresh", { importedAt: "2026-11-05T00:00:00.000Z", exportKB: 300 });
    for (const dir of [old, fresh]) {
      fs.mkdirSync(path.join(dir, ".design-ui", "kept-captures"));
      fs.writeFileSync(path.join(dir, ".design-ui", "kept-captures", "default@64x48.png"), Buffer.alloc(300 * KB));
    }
    const names = (plan: { removals: { path: string; screen: string }[] }) => plan.removals.map((r) => `${r.screen}/${path.basename(r.path)}`).sort();
    // within the budget, the automatic cleanup keeps them; the budget counts them
    const auto = planClean(d.root, 2048);
    expect(names(auto)).toEqual(["fresh/diff", "fresh/unity", "old/diff", "old/unity"]);
    expect(auto.before).toBeGreaterThan(1200 * KB);
    // over the budget they go before any export (oldest screen first), and an export only if that is not enough
    expect(names(planClean(d.root, 0.7))).toEqual(["fresh/diff", "fresh/kept-captures", "fresh/unity", "old/diff", "old/kept-captures", "old/unity"]);
    expect(names(planClean(d.root, 0.95))).toEqual(["fresh/diff", "fresh/unity", "old/diff", "old/kept-captures", "old/unity"]);
    // asked for (design_ui_clean), they go whatever the budget
    expect(names(planClean(d.root, 2048, "fresh", { kept: true }))).toEqual(["fresh/diff", "fresh/kept-captures", "fresh/unity"]);
    const done = markBusy(old, "verify");
    try {
      expect(names(planClean(d.root, 2048, undefined, { kept: true })).filter((n) => n.startsWith("old/"))).toEqual([]);
    } finally { done(); }
  });

  it("skips a removal whose screen a run started on after the plan was made", () => {
    const d = designRoot();
    const dir = d.screen("late");
    const plan = planClean(d.root, 2048);
    expect(plan.removals.some((r) => r.screen === "late")).toBe(true);
    const done = markBusy(dir, "verify");
    try {
      const { removed, failed } = applyClean(plan);
      expect(removed.filter((r) => r.screen === "late")).toEqual([]);
      expect(failed.map((f) => f.error)).toEqual(failed.map(() => "an import or verify of the screen started; left for the next cleanup"));
      expect(fs.existsSync(path.join(dir, ".design-ui", "unity"))).toBe(true);
    } finally { done(); }
  });

  it("holds one run per screen folder: a second run is refused while the first holds it; a live process's marker refuses it, a stale or dead one is taken over", () => {
    const d = designRoot();
    const dir = d.screen("one");
    const file = path.join(dir, ".design-ui", "busy.json");
    const done = markBusy(dir, "verify");
    try {
      expect(() => markBusy(dir, "import")).toThrow(ScreenBusyError);
      expect(() => markBusy(dir, "verify")).toThrow("An import or verify of one is running; call it again when it ends.");
      // the first run's marker is untouched, so the cleanup still sees the screen as busy
      expect(isBusy(dir)).toBe(true);
    } finally { done(); }
    expect(isBusy(dir)).toBe(false);
    // a marker another server process (alive) holds
    const other = { what: "verify", pid: process.ppid, since: new Date().toISOString(), token: "other" };
    fs.writeFileSync(file, JSON.stringify(other));
    let refused: unknown;
    try { markBusy(dir, "import"); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(ScreenBusyError);
    expect((refused as ScreenBusyError).run).toMatchObject({ what: "verify", pid: process.ppid });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).token).toBe("other");
    // one set hours ago, or of a process that is gone, is left over: taken over
    for (const left of [{ ...other, since: new Date(Date.now() - 7 * 3600e3).toISOString() }, { ...other, pid: 2 ** 22 + 12345 }]) {
      fs.writeFileSync(file, JSON.stringify(left));
      const mine = markBusy(dir, "verify");
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid, what: "verify" });
      mine();
      expect(fs.existsSync(file)).toBe(false);
    }
    // a marker being written (empty, just made) counts as held; an old unreadable one is left over
    fs.writeFileSync(file, "");
    expect(() => markBusy(dir, "verify")).toThrow(ScreenBusyError);
    const old = new Date(Date.now() - 60e3);
    fs.utimesSync(file, old, old);
    markBusy(dir, "verify")();
  });

  it("treats a run marker of a process that is gone as left over", () => {
    const d = designRoot();
    const dir = d.screen("crashed");
    fs.writeFileSync(path.join(dir, ".design-ui", "busy.json"), JSON.stringify({ what: "verify", pid: 2 ** 22 + 12345, since: new Date().toISOString() }));
    expect(isBusy(dir)).toBe(false);
    expect(planClean(d.root, 2048).removals.some((r) => r.path.endsWith(`${path.sep}unity`))).toBe(true);
  });

  it("reads cacheBudgetMB from design-ui.config.json, 2048 by default, and refuses a value that is not a positive number", () => {
    const dir = tempDir();
    const write = (extra: Record<string, unknown>) =>
      fs.writeFileSync(path.join(dir, "design-ui.config.json"), JSON.stringify({ designRoot: "D", kitDir: "K", profileAsset: "Assets/P.asset", ...extra }));
    write({});
    expect(readConfig(dir).cacheBudgetMB).toBe(2048);
    write({ cacheBudgetMB: 64 });
    expect(readConfig(dir).cacheBudgetMB).toBe(64);
    write({ cacheBudgetMB: 0 });
    expect(() => readConfig(dir)).toThrow(/cacheBudgetMB/);
  });
});
