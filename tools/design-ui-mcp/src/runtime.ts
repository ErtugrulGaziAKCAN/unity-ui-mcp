import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { sha256 } from "./design.js";
import { readKit, type KitConfig } from "./exporter.js";

interface CachedKit { stamp: string; kit: KitConfig; sha: string }

/** Kit files as `relative path → absolute path` (dotfiles skipped). */
function kitFiles(dir: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (abs: string, rel: string) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.name.startsWith(".")) continue;
      const p = path.join(abs, d.name), r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(p, r);
      else if (d.isFile()) out.push([r, p]);
    }
  };
  walk(dir, "");
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * State kept for the server's lifetime: one Chromium (started on first use, reused by lint and export, closed on
 * exit) and the parsed kit with its content hash (re-read only when a kit file's size or mtime changes).
 */
export class Runtime {
  /** How many times Chromium was launched (tests check reuse). */
  browserLaunches = 0;
  private browserPromise: Promise<Browser> | null = null;
  private kits = new Map<string, CachedKit>();
  private closed = false;

  get browserWarm(): boolean {
    return this.browserPromise !== null;
  }

  async browser(): Promise<Browser> {
    if (this.closed) throw new Error("server is shutting down");
    if (!this.browserPromise) {
      this.browserLaunches++;
      const p = chromium.launch().then((b) => {
        b.on("disconnected", () => { if (this.browserPromise === p) this.browserPromise = null; });
        return b;
      }, (e: Error) => {
        this.browserPromise = null;
        const hint = /Executable doesn't exist|playwright install/i.test(e.message)
          ? " Chromium for Playwright is not installed: run `npx playwright install chromium` in the unity-ui-mcp folder."
          : "";
        throw new Error(`could not start Chromium: ${e.message.split("\n")[0]}${hint}`);
      });
      this.browserPromise = p;
    }
    return this.browserPromise;
  }

  /** The kit at `kitDir` and a hash of all its files; cached until a file changes. */
  kit(kitDir: string): { kit: KitConfig; sha: string } {
    if (!fs.existsSync(path.join(kitDir, "kit.config.json"))) {
      throw new Error(`design kit not found: ${path.join(kitDir, "kit.config.json")} is missing (check "kitDir" in design-ui.config.json)`);
    }
    const files = kitFiles(kitDir);
    const stamp = files.map(([r, p]) => { const s = fs.statSync(p); return `${r}:${s.size}:${s.mtimeMs}`; }).join("\n");
    const hit = this.kits.get(kitDir);
    if (hit && hit.stamp === stamp) return hit;
    const kit = readKit(kitDir);
    const sha = sha256(files.map(([r, p]) => `${r}\0${sha256(fs.readFileSync(p))}`).join("\n"));
    const entry = { stamp, kit, sha };
    this.kits.set(kitDir, entry);
    return entry;
  }

  invalidateKits(): void {
    this.kits.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    const p = this.browserPromise;
    this.browserPromise = null;
    if (p) await p.then((b) => b.close()).catch(() => {});
  }
}
