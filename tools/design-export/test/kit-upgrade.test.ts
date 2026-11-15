import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../src/commands.js";
import { buildKit } from "../src/kit/build.js";
import { upgradeKit } from "../src/kit/upgrade.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLONE_KIT = path.resolve(here, "../../../design-kit");

const tmpDirs: string[] = [];
const tmp = (p = "kit-upgrade-") => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const io = () => { const out: string[] = [], err: string[] = []; return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } }; };

const LOCALES = ["tr", "en", "fr", "it", "de", "pt", "ru", "zh", "sv", "ja", "ar"];

/**
 * A project kit made from an older clone kit and changed by its project: the text styles before the readable-text floor
 * (caption 12/16, label 16/20) plus a style of its own, three viewports plus one of its own, eleven locales and a key of its
 * own, its font family token, a colour token it changed and one it added (one clone token it never had), its own fonts,
 * an older base stylesheet, RULES.md and component page, and a component note of its own.
 */
function oldProjectKit(): string {
  const dir = path.join(tmp(), "design-kit");
  fs.cpSync(CLONE_KIT, dir, { recursive: true, filter: (src) => !src.startsWith(path.join(CLONE_KIT, "fixtures")) });
  const f = (n: string) => path.join(dir, n);
  const styles = JSON.parse(fs.readFileSync(f("text-styles.json"), "utf8"));
  styles.caption = { fontSize: 12, lineHeight: 16, weight: 400 };
  styles["caption-bold"] = { fontSize: 12, lineHeight: 16, weight: 700 };
  styles.label = { fontSize: 16, lineHeight: 20, weight: 400 };
  styles["label-bold"] = { fontSize: 16, lineHeight: 20, weight: 700 };
  styles.score = { fontSize: 48, lineHeight: 60, weight: 700 };
  fs.writeFileSync(f("text-styles.json"), JSON.stringify(styles, null, 2) + "\n");
  const cfg = JSON.parse(fs.readFileSync(f("kit.config.json"), "utf8"));
  cfg.viewports = [[2560, 1440], [1920, 1080], [1280, 720], [5120, 2880]];
  cfg.locales = LOCALES;
  cfg.notes = "the game's kit";
  fs.writeFileSync(f("kit.config.json"), JSON.stringify(cfg) + "\n");
  let tokens = fs.readFileSync(f("tokens.css"), "utf8");
  tokens = tokens.replace(/--font-ui: "Inter UI";/, '--font-ui: "Inter 18pt";')
    .replace(/--color-accent: #16c2d5;/, "--color-accent: #00ffcc;")
    .replace(/\n\s*--space-12: 48px;[^\n]*/, "")
    .replace(/\n\}/, "\n  --color-event-match: #ff00aa; /* Match events in the calendar. */\n}");
  fs.writeFileSync(f("tokens.css"), tokens);
  fs.writeFileSync(f("fonts/fonts.css"), fs.readFileSync(f("fonts/fonts.css"), "utf8").replace(/"Inter UI"/g, '"Inter 18pt"') +
    '@font-face { font-family: "Inter 18pt"; font-weight: 900; src: url("Inter_18pt-Black.ttf") format("truetype"); }\n');
  fs.copyFileSync(f("fonts/Inter_18pt-Bold.ttf"), f("fonts/Inter_18pt-Black.ttf"));
  fs.writeFileSync(f("fonts/fonts.json"), JSON.stringify(Object.fromEntries(LOCALES.map((l) => [l, ["Inter 18pt"]])), null, 2) + "\n");
  fs.writeFileSync(f("base.css"), "/* an older base stylesheet */\n");
  fs.writeFileSync(f("RULES.md"), "# older rules\n");
  fs.writeFileSync(f("components/button.html"), fs.readFileSync(f("components/button.html"), "utf8").replace("</body>", "<!-- older --></body>"));
  fs.writeFileSync(f("components/club-card.md"), "The game's own component note.\n");
  return dir;
}

/** Every file under a folder (relative path → sha256), the backup folder left out. */
function tree(dir: string, skip = ".backup"): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (rel === "" && d.name === skip) continue;
      const p = path.join(abs, d.name), r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(p, r);
      else out[r] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

describe("kit upgrade", () => {
  it("brings an old project kit to the clone's text styles and six viewports and keeps the project's own parts", async () => {
    const kit = oldProjectKit();
    const fontsBefore = Object.fromEntries(Object.entries(tree(kit)).filter(([k]) => k.startsWith("fonts/")));
    const staging = tmp("kit-upgrade-staging-");
    const r = upgradeKit(kit, { from: CLONE_KIT, now: new Date("2026-11-15T10:00:00Z"), tmpRoot: staging });
    expect(r.ok, r.errors.join("\n")).toBe(true);

    const styles = JSON.parse(fs.readFileSync(path.join(kit, "text-styles.json"), "utf8"));
    expect(styles.caption).toEqual({ fontSize: 20, lineHeight: 28, weight: 400 });
    expect(styles.label).toEqual({ fontSize: 20, lineHeight: 24, weight: 400 });
    expect(styles.score).toEqual({ fontSize: 48, lineHeight: 60, weight: 700 });
    const cfg = JSON.parse(fs.readFileSync(path.join(kit, "kit.config.json"), "utf8"));
    const clone = JSON.parse(fs.readFileSync(path.join(CLONE_KIT, "kit.config.json"), "utf8"));
    expect(cfg.viewports).toEqual([...clone.viewports, [5120, 2880]]);
    expect(cfg.locales).toEqual(LOCALES);
    expect(cfg.notes).toBe("the game's kit");
    expect(cfg.filterFunctions).toEqual(clone.filterFunctions);
    const tokens = fs.readFileSync(path.join(kit, "tokens.css"), "utf8");
    expect(tokens).toContain('--font-ui: "Inter 18pt";');
    expect(tokens).toContain("--color-accent: #00ffcc;");
    expect(tokens).toContain("--color-event-match: #ff00aa; /* Match events in the calendar. */");
    expect(tokens).toContain("--space-12: 48px;");
    expect(Object.fromEntries(Object.entries(tree(kit)).filter(([k]) => k.startsWith("fonts/")))).toEqual(fontsBefore);
    expect(fs.readFileSync(path.join(kit, "components/club-card.md"), "utf8")).toBe("The game's own component note.\n");
    expect(fs.readFileSync(path.join(kit, "components/button.html"), "utf8")).not.toContain("<!-- older -->");
    expect(fs.readFileSync(path.join(kit, "RULES.md"), "utf8")).not.toBe("# older rules\n");
    // kit build ran: the kit is current
    expect(buildKit(kit, { check: true })).toMatchObject({ changed: [], errors: [] });

    // the old files are backed up under the kit's own .backup/, and the run says what it kept, replaced and backed up
    expect(r.backup).toBe(path.join(kit, ".backup", "2026-11-15T10-00-00Z"));
    expect(fs.readFileSync(path.join(r.backup!, "RULES.md"), "utf8")).toBe("# older rules\n");
    expect(JSON.parse(fs.readFileSync(path.join(r.backup!, "text-styles.json"), "utf8")).caption.fontSize).toBe(12);
    expect(r.replaced).toEqual(expect.arrayContaining(["RULES.md", "base.css", "components/button.html", "text-styles.json"]));
    expect(r.kept.join("\n")).toMatch(/fonts\//);
    expect(r.kept.join("\n")).toMatch(/--font-ui/);
    expect(r.kept.join("\n")).toMatch(/--color-event-match/);
    expect(r.kept.join("\n")).toMatch(/locales/);
    expect(r.kept.join("\n")).toMatch(/5120×2880/);
    expect(r.kept.join("\n")).toMatch(/text style score/);
    expect(fs.readdirSync(staging)).toEqual([]); // the staging copy is gone
  });

  it("--dry-run prints the plan and writes nothing: no file changes, no backup, no staging copy left", async () => {
    const kit = oldProjectKit();
    const before = tree(kit, "");
    const staging = tmp("kit-upgrade-staging-");
    const r = upgradeKit(kit, { from: CLONE_KIT, dryRun: true, tmpRoot: staging });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.replaced.length).toBeGreaterThan(0);
    expect(r.backup).toBeNull();
    expect(tree(kit, "")).toEqual(before);
    expect(fs.existsSync(path.join(kit, ".backup"))).toBe(false);
    expect(fs.readdirSync(staging)).toEqual([]);

    const a = io();
    expect(await runCli(["kit", "upgrade", kit, "--from", CLONE_KIT, "--dry-run"], a.io)).toBe(0);
    const text = a.out.join("");
    expect(text).toMatch(/dry run/i);
    expect(text).toMatch(/would replace: .*text-styles\.json/);
    expect(text).toMatch(/would keep: .*--font-ui/);
    expect(tree(kit, "")).toEqual(before);
  });

  it("an upgraded kit upgrades to nothing; at most three backups are kept, older ones are removed and named", () => {
    const kit = oldProjectKit();
    const staging = tmp("kit-upgrade-staging-");
    expect(upgradeKit(kit, { from: CLONE_KIT, now: new Date("2026-11-15T10:00:00Z"), tmpRoot: staging }).ok).toBe(true);
    const again = upgradeKit(kit, { from: CLONE_KIT, now: new Date("2026-11-15T11:00:00Z"), tmpRoot: staging });
    expect(again.ok).toBe(true);
    expect(again.replaced).toEqual([]);
    expect(again.backup).toBeNull(); // nothing changed, nothing backed up
    for (const [h, n] of [[12, 0], [13, 1], [14, 2]]) {
      fs.writeFileSync(path.join(kit, "RULES.md"), `# stale ${n}\n`);
      expect(upgradeKit(kit, { from: CLONE_KIT, now: new Date(`2026-11-15T${h}:00:00Z`), tmpRoot: staging }).ok).toBe(true);
    }
    fs.writeFileSync(path.join(kit, "RULES.md"), "# stale 3\n");
    const r = upgradeKit(kit, { from: CLONE_KIT, now: new Date("2026-11-15T15:00:00Z"), tmpRoot: staging });
    expect(fs.readdirSync(path.join(kit, ".backup")).sort()).toEqual(["2026-11-15T13-00-00Z", "2026-11-15T14-00-00Z", "2026-11-15T15-00-00Z"]);
    expect(r.pruned).toEqual([path.join(kit, ".backup", "2026-11-15T12-00-00Z")]); // 10:00 went with the 14:00 run
  });

  it("refuses the clone's own kit, and a kit whose merged result does not build (nothing written)", async () => {
    const e = io();
    expect(await runCli(["kit", "upgrade", CLONE_KIT, "--from", CLONE_KIT], e.io)).toBe(2);
    expect(e.err.join("")).toMatch(/clone's own kit/);

    const kit = oldProjectKit();
    const styles = JSON.parse(fs.readFileSync(path.join(kit, "text-styles.json"), "utf8"));
    styles.tiny = { fontSize: 16, lineHeight: 20, weight: 400 }; // a project style below the readable-text floor (8 device px at 1280×720)
    fs.writeFileSync(path.join(kit, "text-styles.json"), JSON.stringify(styles, null, 2) + "\n");
    const before = tree(kit, "");
    const r = upgradeKit(kit, { from: CLONE_KIT, tmpRoot: tmp("kit-upgrade-staging-") });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/readable-text floor/);
    expect(tree(kit, "")).toEqual(before);
    const c = io();
    expect(await runCli(["kit", "upgrade", kit, "--from", CLONE_KIT], c.io)).toBe(1);
    expect(c.out.join("") + c.err.join("")).toMatch(/nothing was written/i);
  });
});
