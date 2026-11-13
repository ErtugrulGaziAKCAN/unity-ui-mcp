import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";
import { KIT_DIR, tempDir, tempProject } from "./helpers.js";

const write = (dir: string, obj: unknown) => fs.writeFileSync(path.join(dir, "design-ui.config.json"), JSON.stringify(obj));

describe("readConfig", () => {
  it("resolves designRoot and kitDir against the project and keeps the runner templates", () => {
    const p = tempProject();
    const cfg = readConfig(p.dir);
    expect(cfg.projectDir).toBe(p.dir);
    expect(cfg.designRoot).toBe(path.join(p.dir, "Designs"));
    expect(cfg.kitDir).toBe(KIT_DIR);
    expect(cfg.profileAsset).toBe("Assets/DesignUi/DesignUiProfile.asset");
    expect(cfg.unityRunner.prefer).toBe("command");
    expect(cfg.unityRunner.captureVia).toBe("command");
    expect(cfg.unityRunner.command.import).toContain("{exportDir}");
  });

  it("throws an error naming designRoot when it is missing", () => {
    const dir = tempDir();
    write(dir, { kitDir: "kit", profileAsset: "Assets/p.asset" });
    expect(() => readConfig(dir)).toThrow(/designRoot/);
  });

  it("names each missing or mistyped key", () => {
    const dir = tempDir();
    write(dir, { designRoot: "d", profileAsset: "Assets/p.asset" });
    expect(() => readConfig(dir)).toThrow(/kitDir/);
    write(dir, { designRoot: "d", kitDir: "k" });
    expect(() => readConfig(dir)).toThrow(/profileAsset/);
    write(dir, { designRoot: "d", kitDir: "k", profileAsset: "p", unityRunner: { prefer: "batch" } });
    expect(() => readConfig(dir)).toThrow(/unityRunner\.prefer/);
    write(dir, { designRoot: "d", kitDir: "k", profileAsset: "p", unityRunner: { command: { import: "unity -batchmode" } } });
    expect(() => readConfig(dir)).toThrow(/unityRunner\.command\.import/);
  });

  it("defaults the runner to the editor bridge with empty command templates", () => {
    const dir = tempDir();
    write(dir, { designRoot: "d", kitDir: "k", profileAsset: "p" });
    const cfg = readConfig(dir);
    expect(cfg.unityRunner).toMatchObject({ prefer: "editor", captureVia: "command", command: { import: [], capture: [], kitSync: [] } });
  });

  it("explains a missing config file and invalid JSON", () => {
    const dir = tempDir();
    expect(() => readConfig(dir)).toThrow(/design-ui\.config\.json not found/);
    fs.writeFileSync(path.join(dir, "design-ui.config.json"), "{ nope");
    expect(() => readConfig(dir)).toThrow(/not valid JSON/);
  });
});
