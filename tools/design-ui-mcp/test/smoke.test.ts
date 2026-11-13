import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir, tempProject } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const smoke = (project: string) =>
  spawnSync(process.execPath, [path.join(pkg, "scripts", "smoke.mjs"), "--project", project], { encoding: "utf8", timeout: 60_000 });

describe("scripts/smoke.mjs (out-of-band server check over stdio)", () => {
  beforeAll(() => {
    const b = spawnSync(process.execPath, [path.join(pkg, "scripts", "build.mjs")], { encoding: "utf8" });
    expect(b.status, b.stderr).toBe(0);
  });

  it("runs initialize, tools/list and design_ui_list against the built server", () => {
    const p = tempProject({ prefer: "editor" });
    const r = smoke(p.dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^initialize: design-ui /m);
    expect(r.stdout).toContain("tools/list: design_ui_rules, design_ui_list, design_ui_lint, design_ui_import, design_ui_verify, design_ui_status, design_ui_kit_sync");
    expect(r.stdout).toMatch(/tools\/call design_ui_list \{\}: isError=false/);
    expect(r.stdout).toContain("Unity bridge: not-found");
    expect(r.stdout).toContain("server exited with 0");
  });

  it("writes every call's structured result to --out, with a per-request --timeout", () => {
    const p = tempProject({ prefer: "editor" });
    const out = path.join(tempDir(), "calls.json");
    const r = spawnSync(process.execPath, [path.join(pkg, "scripts", "smoke.mjs"), "--project", p.dir, "--timeout", "120",
      "--call", "design_ui_status", "--call", "design_ui_list", "--out", out], { encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(calls.map((c: { name: string }) => c.name)).toEqual(["design_ui_status", "design_ui_list"]);
    expect(calls[0]).toMatchObject({ args: {}, isError: false });
    expect(typeof calls[0].ms).toBe("number");
    expect(calls[1].structuredContent.unity.bridge).toBe("not-found");
  });

  it("fails when the project has no design-ui.config.json", () => {
    const r = smoke(tempDir());
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("design-ui.config.json not found");
  });
});
