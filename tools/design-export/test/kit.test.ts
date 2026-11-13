import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../src/commands.js";
import { readKit } from "../src/kit.js";
import { renderBaseCss } from "../src/kit/baseCss.js";
import { buildKit } from "../src/kit/build.js";
import { CLAUDE_TOKEN_NAME, validateTokensJson, writeClaudeDesignSystem } from "../src/kit/claudeDesignSystem.js";
import { readKitComponents } from "../src/kit/components.js";
import { renderRules } from "../src/kit/rulesDoc.js";
import { parseTokensCss } from "../src/kit/tokens.js";
import { CSS_SUPPORT_DATA } from "../src/lint/allowed-css.js";
import { RULES } from "../src/lint/index.js";
import { RULE_SUMMARIES } from "../src/lint/rule-table.js";
import { readTextStyles } from "../src/lint/text-styles.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT_DIR = path.resolve(here, "../../../design-kit");
const TEST_FONTS = path.join(here, "fixtures", "lint", "kit", "fonts");

const tmpDirs: string[] = [];
const tmp = (p = "kit-") => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A copy of the repo kit; with `fonts`, the font files a kit sync would write (family "Inter UI", 400 and 700). */
function kitCopy(opts: { fonts?: boolean } = {}): string {
  const dir = tmp();
  fs.cpSync(KIT_DIR, dir, { recursive: true });
  if (opts.fonts && !fs.existsSync(path.join(dir, "fonts", "fonts.css"))) {
    fs.mkdirSync(path.join(dir, "fonts"), { recursive: true });
    for (const f of ["Inter_18pt-Regular.ttf", "Inter_18pt-Bold.ttf", "OFL.txt"]) fs.copyFileSync(path.join(TEST_FONTS, f), path.join(dir, "fonts", f));
    fs.writeFileSync(path.join(dir, "fonts", "fonts.css"),
      '@font-face { font-family: "Inter UI"; font-weight: 400; src: url("Inter_18pt-Regular.ttf") format("truetype"); }\n' +
      '@font-face { font-family: "Inter UI"; font-weight: 700; src: url("Inter_18pt-Bold.ttf") format("truetype"); }\n');
    fs.writeFileSync(path.join(dir, "fonts", "fonts.json"), JSON.stringify({ tr: ["Inter UI"] }));
  }
  return dir;
}

const io = () => { const out: string[] = [], err: string[] = []; return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } }; };

describe("kit tokens (tokens.css)", () => {
  it("reads one token per line with its family from the name prefix and its usage from the trailing comment", () => {
    const t = parseTokensCss(":root {\n  --color-ink: #ffffff; /* Text. */\n  --space-2: 8px; /* Gaps. */\n  --radius-md: 8px; /* Buttons. */\n" +
      "  --shadow-card: 0 8px 24px rgba(0, 0, 0, 0.4); /* Cards. */\n  --font-ui: \"Inter UI\"; /* Kit font. */\n}\n");
    expect(t).toEqual([
      { name: "color-ink", value: "#ffffff", usage: "Text.", family: "color" },
      { name: "space-2", value: "8px", usage: "Gaps.", family: "spacing" },
      { name: "radius-md", value: "8px", usage: "Buttons.", family: "radius" },
      { name: "shadow-card", value: "0 8px 24px rgba(0, 0, 0, 0.4)", usage: "Cards.", family: "shadow" },
      { name: "font-ui", value: "\"Inter UI\"", usage: "Kit font.", family: "font" },
    ]);
  });

  it("refuses unknown prefixes, var(), named colours, missing usage and duplicates", () => {
    expect(() => parseTokensCss(":root { --size-1: 4px; /* x */ }")).toThrow(/size-1.*prefix/);
    expect(() => parseTokensCss(":root { --color-a: var(--color-b); /* x */ }")).toThrow(/var\(\)/);
    expect(() => parseTokensCss(":root { --color-a: white; /* x */ }")).toThrow(/named colour/);
    expect(() => parseTokensCss(":root { --space-1: 4px; }")).toThrow(/usage/);
    expect(() => parseTokensCss(":root { --space-1: 4px; /* a */\n --space-1: 8px; /* b */ }")).toThrow(/twice/);
  });

  it("the repo kit's tokens.css parses", () => {
    const t = parseTokensCss(fs.readFileSync(path.join(KIT_DIR, "tokens.css"), "utf8"));
    expect(t.length).toBeGreaterThan(20);
    expect(new Set(t.map((x) => x.family))).toEqual(new Set(["color", "spacing", "radius", "shadow", "font"]));
  });
});

describe("kit base stylesheet (base.css)", () => {
  it("is generated from the text styles and neutralises the browser defaults lint asks for", () => {
    const kit = readKit(KIT_DIR);
    const css = renderBaseCss(readTextStyles(kit));
    expect(fs.readFileSync(path.join(KIT_DIR, "base.css"), "utf8")).toBe(css);
    for (const s of readTextStyles(kit)) expect(css).toContain(`.text-${s.name} { font-size: ${s.fontSize}px; line-height: ${s.lineHeight}px; font-weight: ${s.weight}; }`);
    for (const decl of ["box-sizing: border-box", "margin: 0", "appearance: none", "text-decoration: none", "list-style: none", "::placeholder"]) expect(css).toContain(decl);
    // grayscale smoothing on the root: macOS browsers then draw stems as thin as UI Toolkit
    expect(css).toContain(":root { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }");
    expect(css.startsWith("/* kit-base: begin")).toBe(true);
    expect(css.trimEnd().endsWith("/* kit-base: end */")).toBe(true);
  });
});

describe("text-style listings come only from text-styles.json", () => {
  it("a changed table reaches base.css, RULES.md, the Claude README and tokens.json on the next build, with no number copied elsewhere", () => {
    const dir = kitCopy({ fonts: true });
    const file = path.join(dir, "text-styles.json");
    const table = JSON.parse(fs.readFileSync(file, "utf8"));
    table.label = { fontSize: 16, lineHeight: 24, weight: 400 };
    table["label-bold"] = { fontSize: 16, lineHeight: 24, weight: 700 };
    fs.writeFileSync(file, JSON.stringify(table, null, 2));
    expect(buildKit(dir).changed).toEqual(expect.arrayContaining(["RULES.md", "base.css", "components/button.html"]));
    expect(fs.readFileSync(path.join(dir, "base.css"), "utf8")).toContain(".text-label { font-size: 16px; line-height: 24px; font-weight: 400; }");
    expect(fs.readFileSync(path.join(dir, "base.css"), "utf8")).toContain("body { font-family: var(--font-ui); font-size: 16px; line-height: 24px;");
    expect(fs.readFileSync(path.join(dir, "RULES.md"), "utf8")).toContain("| label | `.text-label` | 16 | 24 | 400 |");
    const out = tmp("claude-ds-");
    writeClaudeDesignSystem(dir, out, { now: new Date(0) });
    expect(fs.readFileSync(path.join(out, "project", "README.md"), "utf8")).toContain("| label-bold | `.text-label-bold` | 16 | 24 | 700 |");
    const tokens = JSON.parse(fs.readFileSync(path.join(out, "project", "tokens.json"), "utf8"));
    const styles = tokens.type.groups.flatMap((g: { styles: unknown[] }) => g.styles);
    expect(styles).toContainEqual({ name: "label", fontSize: "16px", lineHeight: "24px", fontWeight: 400, usage: "Class .text-label." });
  });

  it("the text-styles fixture shows every style of the table at 1, 2 and 5 lines, through its class", () => {
    const html = fs.readFileSync(path.join(KIT_DIR, "fixtures", "fidelity", "text-styles.html"), "utf8");
    const styles = readTextStyles(readKit(KIT_DIR));
    for (const s of styles) for (const n of [1, 2, 5]) {
      const m = new RegExp(`<p class="sample text-${s.name}" data-u-id="${s.name}-l${n}"[^>]*>([^<]*(?:<br>[^<]*)*)</p>`).exec(html);
      expect(m, `${s.name} at ${n} lines`).not.toBeNull();
      expect(m![1].split("<br>")).toHaveLength(n);
    }
    expect(html.match(/class="sample /g)).toHaveLength(styles.length * 3);
    // outside the base block nothing sets a text metric: only the base stylesheet's classes do
    expect(html.replace(/\/\* kit-base: begin[\s\S]*?\/\* kit-base: end \*\//, "")).not.toMatch(/font-size|line-height|font-weight/);
  });
});

describe("kit build", () => {
  it("the repo kit is current: base.css, RULES.md and the base block of every component and fixture", () => {
    expect(buildKit(KIT_DIR, { check: true }).changed).toEqual([]);
  });

  it("--check reports and the build rewrites a stale RULES.md, base.css and base block", () => {
    const dir = kitCopy();
    fs.writeFileSync(path.join(dir, "RULES.md"), "# Design Kit Rules\n");
    fs.appendFileSync(path.join(dir, "base.css"), "/* hand edit */\n");
    const button = path.join(dir, "components", "button.html");
    fs.writeFileSync(button, fs.readFileSync(button, "utf8").replace("box-sizing: border-box;", "box-sizing: content-box;"));
    expect(buildKit(dir, { check: true }).changed.sort()).toEqual(["RULES.md", "base.css", "components/button.html"]);
    expect(fs.readFileSync(path.join(dir, "RULES.md"), "utf8")).toBe("# Design Kit Rules\n"); // check writes nothing
    expect(buildKit(dir).changed.sort()).toEqual(["RULES.md", "base.css", "components/button.html"]);
    expect(buildKit(dir, { check: true }).changed).toEqual([]);
  });

  it("CLI: kit build --check exits 0 when current and 1 when stale", async () => {
    const ok = io();
    expect(await runCli(["kit", "build", KIT_DIR, "--check"], ok.io)).toBe(0);
    const dir = kitCopy();
    fs.writeFileSync(path.join(dir, "RULES.md"), "stale\n");
    const stale = io();
    expect(await runCli(["kit", "build", dir, "--check"], stale.io)).toBe(1);
    expect(stale.out.join("")).toContain("RULES.md");
  });
});

describe("RULES.md", () => {
  const md = fs.readFileSync(path.join(KIT_DIR, "RULES.md"), "utf8");

  it("lists every lint rule with its summary and fix, and every allowed CSS property from css-support.json", () => {
    for (const r of RULES) {
      expect(md).toContain(`| ${r.id} | ${r.severity} | ${RULE_SUMMARIES[r.id].when} | ${RULE_SUMMARIES[r.id].fix} |`);
    }
    for (const p of Object.keys(CSS_SUPPORT_DATA.properties)) expect(md, p).toContain(`\`${p}\``);
  });

  it("names every text style with its class, every markup attribute, the base stylesheet and the reference artboard", () => {
    for (const s of readTextStyles(readKit(KIT_DIR))) expect(md).toContain(`| ${s.name} | \`.text-${s.name}\` | ${s.fontSize} | ${s.lineHeight} | ${s.weight} |`);
    for (const a of ["data-u-screen", "data-u-id", "data-l10n", "data-en", "data-u-arg", "data-u-bind", "data-u-action", "data-u-repeat", "data-u-repeat-mode", "data-u-state", "data-u-external"]) expect(md).toContain(`\`${a}`);
    expect(md).toContain(fs.readFileSync(path.join(KIT_DIR, "base.css"), "utf8").trim());
    expect(md).toContain("2560×1440");
    expect(md).toContain("grayscale font smoothing on the root");
  });
});

describe("kit components", () => {
  it("lists the nine kit components with a group, a guide whose first sentence is the summary, and an existing file", () => {
    const list = readKitComponents(KIT_DIR);
    expect(list.map((c) => c.name)).toEqual(["Button", "Toggle", "TextField", "Dropdown", "Tabs", "Card", "ListRow", "ScrollArea", "Dialog"]);
    for (const c of list) {
      expect(fs.existsSync(path.join(KIT_DIR, "components", c.file)), c.file).toBe(true);
      expect(c.group.length).toBeGreaterThan(0);
      expect(c.guide.startsWith(c.summary)).toBe(true);
      expect(c.summary).toMatch(/\.$/);
    }
  });
});

describe("Claude design system export (kit claude)", () => {
  const now = new Date("2026-11-13T12:00:00Z");

  it("writes the Design System artifact folder, the index last", () => {
    const kitDir = kitCopy({ fonts: true });
    const out = tmp("claude-ds-");
    const r = writeClaudeDesignSystem(kitDir, out, { now, title: "Unity UI Kit" });
    const p = (f: string) => path.join(out, "project", f);
    expect(r.projectDir).toBe(path.join(out, "project"));
    expect(r.files[r.files.length - 1]).toBe("design-system.json");
    for (const f of ["README.md", "tokens.json", "fonts/Inter_18pt-Regular.ttf", "fonts/Inter_18pt-Bold.ttf", "licenses/OFL.txt", "components/Cover/preview.html", "design-system.json"]) {
      expect(fs.existsSync(p(f)), f).toBe(true);
    }
    // the cover folder is bare: a README beside it would make it an ordinary component
    expect(fs.readdirSync(p("components/Cover"))).toEqual(["preview.html"]);
    expect(fs.readFileSync(p("components/Cover/preview.html"), "utf8").split("\n")[0]).toMatch(/^<!-- @dsCard height=\d+ -->$/);

    for (const c of readKitComponents(kitDir)) {
      const preview = fs.readFileSync(p(`components/${c.name}/preview.html`), "utf8");
      expect(preview.split("\n")[0]).toBe(`<!-- @dsCard group="${c.group}" width=2560 height=1440 subtitle="${c.summary.replace(/"/g, "'")}" -->`);
      expect(preview).toContain("data-u-screen=");
      expect(preview).toContain("--color-accent:"); // tokens inlined, so the preview renders without the frame's sheet too
      expect(preview).not.toMatch(/@font-face/);
      const readme = fs.readFileSync(p(`components/${c.name}/README.md`), "utf8");
      expect(readme.startsWith(c.summary)).toBe(true);
    }

    const index = JSON.parse(fs.readFileSync(p("design-system.json"), "utf8"));
    expect(index).toMatchObject({
      v: 3, layout: "files", createdOnFiles: { v: 1, at: "2026-11-13T12:00:00.000Z" }, title: "Unity UI Kit", namespace: "UnityUiKit",
      libraries: [], sections: {}, groups: [], assetGroups: {}, blobs: {}, docs: { sections: [] },
      lastChange: { by: "design-export", at: "2026-11-13T12:00:00.000Z", via: "design-export kit claude" },
    });
  });

  it("tokens.json has the Design System's list shape: unique names, no var() or named colours, fonts that exist", () => {
    const kitDir = kitCopy({ fonts: true });
    const out = tmp("claude-ds-");
    writeClaudeDesignSystem(kitDir, out, { now });
    const tokens = JSON.parse(fs.readFileSync(path.join(out, "project", "tokens.json"), "utf8"));
    expect(validateTokensJson(tokens)).toEqual([]);
    expect(tokens.color.themes).toHaveLength(1);
    const names = ["color", "spacing", "radius", "shadow"].flatMap((f) => tokens[f].tokens.map((t: { name: string }) => t.name));
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(CLAUDE_TOKEN_NAME);
    expect(JSON.stringify(tokens)).not.toMatch(/var\(/);
    for (const f of tokens.type.fonts) expect(fs.existsSync(path.join(out, "project", f.file)), f.file).toBe(true);
    expect(tokens.type.families).toEqual({ ui: "\"Inter UI\"" });
    const styles = tokens.type.groups.flatMap((g: { styles: { name: string }[] }) => g.styles.map((s) => s.name));
    expect(styles.sort()).toEqual(readTextStyles(readKit(kitDir)).map((s) => s.name).sort());
    // the same names and values as tokens.css, so var(--name) means the same in the kit and in Claude Design
    const css = parseTokensCss(fs.readFileSync(path.join(kitDir, "tokens.css"), "utf8"));
    for (const t of css.filter((x) => x.family === "color")) expect(tokens.color.tokens).toContainEqual({ name: t.name, value: { dark: t.value }, usage: t.usage });
  });

  it("validateTokensJson catches what the Design System page would drop", () => {
    const bad = {
      name: "x", version: 1,
      color: { themes: [{ id: "dark", name: "Dark" }], tokens: [{ name: "a", value: "red", usage: "" }, { name: "b", value: "var(--a)", usage: "" }, { name: "a b", value: "#fff", usage: "" }] },
      type: { fonts: [], families: {}, groups: [] },
      spacing: { tokens: [{ name: "a", value: "4px", usage: "" }] },
      radius: { "radius-md": { $value: "8px" } },
    };
    const errs = validateTokensJson(bad).join("\n");
    expect(errs).toMatch(/color token a: .*red/);
    expect(errs).toMatch(/color token b: .*var\(\)/);
    expect(errs).toMatch(/"a b"/);
    expect(errs).toMatch(/a.*more than once/);
    expect(errs).toMatch(/radius.*tokens/);
  });

  it("README.md is the contract for Claude Design: every rule's fix, the artboard rules and the kit stylesheet", () => {
    const kitDir = kitCopy({ fonts: true });
    const out = tmp("claude-ds-");
    writeClaudeDesignSystem(kitDir, out, { now });
    const md = fs.readFileSync(path.join(out, "project", "README.md"), "utf8");
    for (const r of RULES) {
      expect(md, r.id).toContain(r.id);
      expect(md, r.id).toContain(RULE_SUMMARIES[r.id].fix);
    }
    for (const s of ["2560×1440", "{{", "<sc-for>", "<sc-if>", "<dc-import>", "data-u-repeat", "Inline styles", "<helmet>", "Inter UI",
      "-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale"]) expect(md, s).toContain(s);
    expect(md).toContain(fs.readFileSync(path.join(kitDir, "base.css"), "utf8").trim());
    for (const c of readKitComponents(kitDir)) expect(md).toContain(`components/${c.name}/README.md`);
    expect(md).toBe(renderRules(readKit(kitDir), "claude", { title: "Unity UI Kit" }));
  });

  it("refuses a kit without synced fonts, and an existing project folder unless forced", async () => {
    const noFonts = kitCopy();
    fs.rmSync(path.join(noFonts, "fonts"), { recursive: true, force: true });
    expect(() => writeClaudeDesignSystem(noFonts, tmp("claude-ds-"), { now })).toThrow(/kit sync/);
    const kitDir = kitCopy({ fonts: true });
    const out = tmp("claude-ds-");
    const a = io();
    expect(await runCli(["kit", "claude", kitDir, out], a.io)).toBe(0);
    expect(a.out.join("")).toContain("design-system.json");
    const b = io();
    expect(await runCli(["kit", "claude", kitDir, out], b.io)).toBe(2);
    expect(b.err.join("")).toMatch(/--force/);
    fs.writeFileSync(path.join(out, "project", "stale.md"), "old");
    expect(await runCli(["kit", "claude", kitDir, out, "--force"], io().io)).toBe(0);
    expect(fs.existsSync(path.join(out, "project", "stale.md"))).toBe(false);
  });
});
