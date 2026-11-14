import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/capture-on-copy.sh");

/** A Unity project with a relative file: package and a stub Unity that records what it saw in the copy, then exits `code`. */
function setup(code: number) {
  const root = tempDir("design-ui-capture-test-");
  const project = path.join(root, "Game"), out = path.join(root, "out"), seen = path.join(root, "seen.json");
  fs.mkdirSync(path.join(project, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(project, "Packages"), { recursive: true });
  fs.mkdirSync(path.join(project, "Temp"), { recursive: true });
  fs.mkdirSync(path.join(root, "local-pkg"), { recursive: true });
  const manifest = `{\n  "dependencies": {\n    "com.example.local": "file:../../local-pkg",\n    "com.unity.ugui": "2.0.0"\n  }\n}\n`;
  fs.writeFileSync(path.join(project, "Packages", "manifest.json"), manifest);
  fs.writeFileSync(path.join(project, "Assets", "Scene.unity"), "scene");
  const unity = path.join(root, "Unity");
  fs.writeFileSync(unity, `#!/bin/sh
p=""; while [ $# -gt 0 ]; do [ "$1" = -projectPath ] && p="$2"; shift; done
node -e 'const fs=require("fs"),p=process.argv[1];fs.writeFileSync(process.argv[2],JSON.stringify({copy:p,manifest:JSON.parse(fs.readFileSync(p+"/Packages/manifest.json","utf8")),temp:fs.existsSync(p+"/Temp"),scene:fs.existsSync(p+"/Assets/Scene.unity")}))' "$p" "${seen}"
mkdir -p "$DESIGN_UI_OUT_DIR" && echo '{}' > "$DESIGN_UI_OUT_DIR/capture-done.json"
exit ${code}
`);
  fs.chmodSync(unity, 0o755);
  return { root, project, out, seen, unity, manifest };
}

describe("scripts/capture-on-copy.sh", () => {
  for (const code of [0, 3]) {
    it(`captures on a temporary copy that lists the package's tests, and removes the copy afterwards (Unity exit ${code})`, () => {
      const s = setup(code);
      const r = spawnSync("bash", [SCRIPT, s.project, s.unity], { env: { ...process.env, DESIGN_UI_OUT_DIR: s.out }, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(code);
      const seen = JSON.parse(fs.readFileSync(s.seen, "utf8"));
      // the copy: elsewhere, with the project's files, without Temp, listing the tests, with absolute file: packages
      expect(seen.copy).not.toBe(s.project);
      expect(seen.scene).toBe(true);
      expect(seen.temp).toBe(false);
      expect(seen.manifest.testables).toEqual(["com.ertugrulgaziakcan.design-ui"]);
      expect(seen.manifest.dependencies["com.example.local"]).toBe(`file:${path.join(s.root, "local-pkg")}`);
      // removed, success or failure; the output stays where the server asked; the project is untouched
      expect(fs.existsSync(seen.copy)).toBe(false);
      expect(fs.existsSync(path.join(s.out, "capture-done.json"))).toBe(true);
      expect(fs.readFileSync(path.join(s.project, "Packages", "manifest.json"), "utf8")).toBe(s.manifest);
      expect(fs.readdirSync(s.project).sort()).toEqual(["Assets", "Packages", "Temp"]);
      expect(fs.readdirSync(path.join(s.project, "Assets"))).toEqual(["Scene.unity"]);
    });
  }
});
