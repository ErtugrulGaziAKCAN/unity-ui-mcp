import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/capture-on-copy.sh");

/** The open Editor's per-process and lock files of a project (relative paths): none may reach a copy Unity starts on. */
const PROCESS_FILES = [
  "Library/ilpp.pid", "Library/EditorInstance.json", "Library/ArtifactDB-lock", "Library/SourceAssetDB-lock",
  "Library/Bee/backend.pid", "Library/Search/assets.index-lock", "Temp/UnityLockfile", "UnityLockfile",
];
/** Files of the same project a copy keeps (the Library's caches, a package's own lock file). */
const KEPT_FILES = ["Library/ScriptAssemblies/Game.dll", "Library/ArtifactDB", "Library/PackageCache/com.example.x/yarn.lock", "Assets/Scene.unity"];

/**
 * A Unity project with a relative file: package, the open Editor's process files and a stub Unity that records what it
 * saw in the copy (and when it ran), waits while `<root>/hold` exists, then exits `code`.
 */
function setup(code: number) {
  const root = tempDir("design-ui-capture-test-");
  const project = path.join(root, "Game"), out = path.join(root, "out"), seen = path.join(root, "seen.json");
  for (const f of [...PROCESS_FILES, ...KEPT_FILES]) {
    fs.mkdirSync(path.dirname(path.join(project, f)), { recursive: true });
    fs.writeFileSync(path.join(project, f), f);
  }
  fs.mkdirSync(path.join(project, "Packages"), { recursive: true });
  fs.mkdirSync(path.join(root, "local-pkg"), { recursive: true });
  const manifest = `{\n  "dependencies": {\n    "com.example.local": "file:../../local-pkg",\n    "com.unity.ugui": "2.0.0"\n  }\n}\n`;
  fs.writeFileSync(path.join(project, "Packages", "manifest.json"), manifest);
  const unity = path.join(root, "Unity");
  fs.writeFileSync(unity, `#!/bin/sh
p=""; while [ $# -gt 0 ]; do [ "$1" = -projectPath ] && p="$2"; shift; done
node -e '
const fs = require("fs"), path = require("path"), p = process.argv[1];
const files = (d, rel = "") => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name), rel + e.name + "/") : [rel + e.name]);
fs.appendFileSync(process.argv[2], JSON.stringify({ copy: p, manifest: JSON.parse(fs.readFileSync(p + "/Packages/manifest.json", "utf8")), files: files(p), start: Date.now() }) + "\\n");
' "$p" "${seen}"
while [ -e "${root}/hold" ]; do sleep 0.05; done
echo "{\\"end\\": $(node -p 'Date.now()')}" >> "${seen}"
mkdir -p "$DESIGN_UI_OUT_DIR" && echo '{}' > "$DESIGN_UI_OUT_DIR/capture-done.json"
exit ${code}
`);
  fs.chmodSync(unity, 0o755);
  const lockDir = path.join(root, "slots");
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env, DESIGN_UI_OUT_DIR: out, CAPTURE_COPY_LOCK_DIR: lockDir, CAPTURE_COPY_POLL_SEC: "0.1", CAPTURE_COPY_MIN_FREE_GB: "0", ...extra,
  });
  const runs = () => fs.existsSync(seen) ? fs.readFileSync(seen, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { root, project, out, seen, unity, manifest, lockDir, env, runs };
}

const modes = process.platform === "darwin" ? ["clone", "rsync"] : ["rsync"];

describe("scripts/capture-on-copy.sh", () => {
  for (const code of [0, 3]) {
    it(`captures on a temporary copy that lists the package's tests, and removes the copy afterwards (Unity exit ${code})`, () => {
      const s = setup(code);
      const r = spawnSync("bash", [SCRIPT, s.project, s.unity], { env: s.env(), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(code);
      const [seen] = s.runs();
      // the copy: elsewhere, with the project's files, without Temp, listing the tests, with absolute file: packages
      expect(seen.copy).not.toBe(s.project);
      expect(seen.files).toContain("Assets/Scene.unity");
      expect(seen.files.some((f: string) => f.startsWith("Temp/"))).toBe(false);
      expect(seen.manifest.testables).toEqual(["com.ertugrulgaziakcan.design-ui"]);
      expect(seen.manifest.dependencies["com.example.local"]).toBe(`file:${path.join(s.root, "local-pkg")}`);
      // removed, success or failure; the output stays where the server asked; the project is untouched; the slot is free
      expect(fs.existsSync(seen.copy)).toBe(false);
      expect(fs.existsSync(path.join(s.out, "capture-done.json"))).toBe(true);
      expect(fs.readFileSync(path.join(s.project, "Packages", "manifest.json"), "utf8")).toBe(s.manifest);
      for (const f of [...PROCESS_FILES, ...KEPT_FILES]) expect(fs.existsSync(path.join(s.project, f)), f).toBe(true);
      expect(fs.readdirSync(s.lockDir).filter((f) => f.startsWith("slot."))).toEqual([]);
    });
  }

  for (const mode of modes) {
    it(`deletes the open Editor's process and lock files from the copy before Unity starts (${mode})`, () => {
      const s = setup(0);
      const r = spawnSync("bash", [SCRIPT, s.project, s.unity], { env: s.env({ CAPTURE_COPY_MODE: mode }), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const [seen] = s.runs();
      for (const f of PROCESS_FILES) expect(seen.files, `${f} reached the copy`).not.toContain(f);
      for (const f of KEPT_FILES) expect(seen.files, `${f} is missing in the copy`).toContain(f);
    });
  }

  it("runs one capture at a time by default: a second one waits for the first one's slot, --slots 2 runs both", async () => {
    const s = setup(0);
    const start = (extra: string[] = []) => {
      const child = spawn("bash", [SCRIPT, s.project, s.unity, ...extra], { env: s.env() });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const done = new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
      return { done, out: () => out };
    };
    const until = async (what: () => boolean, ms = 20000) => {
      const t0 = Date.now();
      while (!what()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); }
    };
    fs.writeFileSync(path.join(s.root, "hold"), "");
    const first = start();
    await until(() => s.runs().length === 1);
    const second = start();
    await until(() => second.out().includes("waiting for a capture slot (1 of 1 in use"));
    await new Promise((r) => setTimeout(r, 400));
    expect(s.runs().length, "the second capture's Unity has not started").toBe(1);
    fs.rmSync(path.join(s.root, "hold"));
    expect(await first.done).toBe(0);
    expect(await second.done).toBe(0);
    const [a, aEnd, b] = s.runs();
    expect(b.start).toBeGreaterThanOrEqual(aEnd.end);
    expect(a.copy).not.toBe(b.copy);

    // two slots: both Unity runs overlap
    fs.rmSync(s.seen);
    fs.writeFileSync(path.join(s.root, "hold"), "");
    const c = start(["--slots", "2"]), d = start(["--slots", "2"]);
    await until(() => s.runs().length === 2);
    fs.rmSync(path.join(s.root, "hold"));
    expect([await c.done, await d.done]).toEqual([0, 0]);
    expect(c.out() + d.out()).not.toContain("waiting");
  }, 60000);

  it("takes over a slot whose holder is gone (killed, or its pid reused by another program)", () => {
    const s = setup(0);
    fs.mkdirSync(s.lockDir, { recursive: true });
    const dead = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(s.lockDir, `slot.${dead}`), dead);
    fs.writeFileSync(path.join(s.lockDir, `slot.${process.pid}`), String(process.pid)); // alive, but not a capture
    const r = spawnSync("bash", [SCRIPT, s.project, s.unity], { env: s.env(), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("waiting");
    expect(fs.readdirSync(s.lockDir).filter((f) => f.startsWith("slot."))).toEqual([]);
  });

  it("stops before copying when the disk has less free space than --min-free-gb, and says so", () => {
    const s = setup(0);
    const tmp = path.join(s.root, "tmp");
    fs.mkdirSync(tmp);
    const r = spawnSync("bash", [SCRIPT, s.project, s.unity, "--min-free-gb", "999999"], { env: s.env({ TMPDIR: tmp }), encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/capture-on-copy: only \d+ GB free on the disk of .*; the capture copy needs .*999999 GB \(--min-free-gb\)\. .*Nothing was copied\./);
    expect(s.runs()).toEqual([]);
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(fs.readdirSync(s.lockDir).filter((f) => f.startsWith("slot."))).toEqual([]);
  });

  it("rejects a slot count that is not a positive whole number", () => {
    const s = setup(0);
    const r = spawnSync("bash", [SCRIPT, s.project, s.unity, "--slots", "0"], { env: s.env(), encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--slots must be a whole number of at least 1");
  });
});
