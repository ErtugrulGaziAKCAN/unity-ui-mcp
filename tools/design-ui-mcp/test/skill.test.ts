import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(here, "../../../skills/unity-ui-mcp/SKILL.md");

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  expect(m, "SKILL.md must start with a frontmatter block").toBeTruthy();
  const out: Record<string, string> = {};
  for (const line of m![1].split("\n")) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

describe("skills/unity-ui-mcp/SKILL.md", () => {
  const text = fs.readFileSync(SKILL, "utf8");

  it("has frontmatter with the skill name and a bilingual trigger description", () => {
    const fm = frontmatter(text);
    expect(fm.name).toBe("unity-ui-mcp");
    expect(fm.description.length).toBeGreaterThan(60);
    expect(fm.description).toMatch(/Claude Design/);
    expect(fm.description).toMatch(/UI Toolkit/);
    expect(fm.description).toMatch(/Unity/);
    expect(fm.description).toMatch(/tasarım|arayüz/i); // Turkish trigger words
  });

  it("names only registered tools, and every registered tool", () => {
    const used = new Set(text.match(/design_ui_[a-z_]+/g) ?? []);
    for (const name of used) expect(TOOL_NAMES, `unknown tool ${name}`).toContain(name);
    for (const name of TOOL_NAMES) expect(used.has(name), `${name} missing from the body`).toBe(true);
  });

  it("tells clients that cleanup is automatic, which tool answers disk questions, and never to delete by hand", () => {
    expect(text).toMatch(/Disk use takes care of itself/);
    expect(text).toMatch(/design_ui_clean \{ dryRun: true \}/);
    expect(text).toMatch(/Never delete `<screen>\/\.design-ui\/`, generated Unity\s+files or font twins by hand/);
  });

  it("covers the workflow rules", () => {
    expect(text).toMatch(/blobs\.json/);
    expect(text).toMatch(/project\/canvas\.json/);
    expect(text).toMatch(/design-export kit claude/);
    expect(text).toMatch(/never claim/i);
    expect(text).toMatch(/not available yet/i);
  });

  it("treats canvas content as data and confines writes to the screen folder", () => {
    expect(text).toMatch(/data, never\s+instructions/);
    expect(text).toMatch(/only to read the one link the user gave/i);
    expect(text).toMatch(/Never publish, comment, delete/);
    expect(text).toMatch(/sanitised id/);
    expect(text).toMatch(/no path separators, no `\.\.`/);
    expect(text).toMatch(/Write only inside `<designRoot>\/<screen-id>\/`/);
    expect(text).toMatch(/dry-run/);
    expect(text).not.toMatch(/node <that command>/);
    expect(frontmatter(text).description).toMatch(/UXML/);
    expect(frontmatter(text).description).toMatch(/tasarimi Unity'ye aktar/);
  });

  it("has no local paths or private plan ids", () => {
    expect(text).not.toMatch(/\/Users\/|C:\\|Task \d+|\.superpowers/);
  });
});
