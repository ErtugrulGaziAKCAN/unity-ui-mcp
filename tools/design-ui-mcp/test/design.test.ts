import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findEntry, openContractFolder, openDesignInput, resolveScreen, sourceSha } from "../src/design.js";
import { extractZip } from "../src/zip.js";
import { FIXTURES, tempDir, writeZip } from "./helpers.js";

const html = fs.readFileSync(path.join(FIXTURES, "designs", "clean-screen", "screen.html"), "utf8");

describe("findEntry", () => {
  it("takes the single HTML file of a screen folder and ignores report.html", () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, "inbox.html"), html);
    fs.writeFileSync(path.join(d, "report.html"), "<p>report</p>");
    expect(findEntry(d)).toBe(path.join(d, "inbox.html"));
  });
  it("prefers index.html, then a single .dc.html, and names the candidates otherwise", () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, "a.html"), html);
    fs.writeFileSync(path.join(d, "b.dc.html"), html);
    expect(findEntry(d)).toBe(path.join(d, "b.dc.html"));
    fs.writeFileSync(path.join(d, "c.dc.html"), html);
    expect(() => findEntry(d)).toThrow(/a\.html.*b\.dc\.html.*c\.dc\.html/);
    fs.writeFileSync(path.join(d, "index.html"), html);
    expect(findEntry(d)).toBe(path.join(d, "index.html"));
  });
  it("explains an empty folder", () => {
    expect(() => findEntry(tempDir())).toThrow(/no \.html/);
  });
  it("lists the candidates as paths under designRoot, ready to pass", () => {
    const root = tempDir();
    const d = path.join(root, "canvas");
    fs.mkdirSync(d);
    for (const n of ["month.dc.html", "empty-day.dc.html"]) fs.writeFileSync(path.join(d, n), html);
    expect(() => findEntry(d, root)).toThrow(/several designs in .*canvas: pass the path of the one to use: canvas\/empty-day\.dc\.html, canvas\/month\.dc\.html$/);
  });
});

describe("resolveScreen", () => {
  it("keeps the page a path names, in its screen folder; a folder names no page", () => {
    const root = tempDir();
    const d = path.join(root, "canvas");
    fs.mkdirSync(d);
    for (const n of ["month.dc.html", "empty-day.dc.html"]) fs.writeFileSync(path.join(d, n), html);
    // the screen is the id the pages name (data-u-screen), not the folder name; the id finds the folder too
    expect(resolveScreen("canvas/empty-day.dc.html", root)).toEqual({ screen: "clean.screen", dir: d, entry: path.join(d, "empty-day.dc.html") });
    expect(resolveScreen(path.join(d, "month.dc.html"), root)).toEqual({ screen: "clean.screen", dir: d, entry: path.join(d, "month.dc.html") });
    expect(resolveScreen("canvas", root)).toEqual({ screen: "clean.screen", dir: d, entry: null });
    expect(resolveScreen("clean.screen", root)).toEqual({ screen: "clean.screen", dir: d, entry: null });
  });
  it("names the screen folder as it is on disk when the argument spells it in another case (a case-insensitive file system)", (ctx) => {
    const root = tempDir();
    const d = path.join(root, "Login");
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "screen.html"), html.replace(/data-u-screen="[^"]+"/, 'data-u-screen="login"'));
    if (!fs.existsSync(path.join(root, "login"))) ctx.skip("this file system tells Login and login apart");
    // the run's lock and the cleanup key on the folder: one folder has one name
    expect(resolveScreen("login", root)).toEqual({ screen: "login", dir: d, entry: null });
    expect(resolveScreen("LOGIN/SCREEN.HTML", root)).toEqual({ screen: "login", dir: d, entry: path.join(d, "screen.html") });
    expect(resolveScreen(path.join(root, "login"), root).dir).toBe(d);
  });
  it("refuses a file that is not a design page", () => {
    const root = tempDir();
    const d = path.join(root, "canvas");
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "canvas.json"), "{}");
    fs.writeFileSync(path.join(d, "report.html"), "<p>report</p>");
    expect(() => resolveScreen("canvas/canvas.json", root)).toThrow(/not a design page/);
    expect(() => resolveScreen("canvas/report.html", root)).toThrow(/not a design page/);
  });
});

describe("sourceSha", () => {
  it("changes with any source file and ignores bookkeeping and the report", () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, "screen.html"), html);
    fs.mkdirSync(path.join(d, "assets"));
    fs.writeFileSync(path.join(d, "assets", "logo.png"), "png");
    const a = sourceSha(d);
    fs.mkdirSync(path.join(d, ".design-ui"));
    fs.writeFileSync(path.join(d, ".design-ui", "last-import.json"), "{}");
    fs.writeFileSync(path.join(d, "report.html"), "r");
    fs.writeFileSync(path.join(d, ".DS_Store"), "x");
    expect(sourceSha(d)).toBe(a);
    fs.writeFileSync(path.join(d, "assets", "logo.png"), "png2");
    expect(sourceSha(d)).not.toBe(a);
  });
});

describe("extractZip", () => {
  it("rejects an entry that leaves the folder (../evil.html) and writes nothing outside", async () => {
    const d = tempDir();
    const zip = path.join(d, "design.zip");
    writeZip(zip, [{ name: "screen.html", data: html }, { name: "../evil.html", data: "x" }]);
    await expect(extractZip(zip)).rejects.toThrow(/\.\.\/evil\.html/);
    expect(fs.existsSync(path.join(d, "..", "evil.html"))).toBe(false);
  });
  it("rejects absolute paths and symlink entries", async () => {
    const d = tempDir();
    const abs = path.join(d, "abs.zip");
    writeZip(abs, [{ name: "/tmp/evil.html", data: "x" }]);
    await expect(extractZip(abs)).rejects.toThrow(/evil\.html/);
    const link = path.join(d, "link.zip");
    writeZip(link, [{ name: "screen.html", data: html }, { name: "assets", data: "/etc", mode: 0o120777 }]);
    await expect(extractZip(link)).rejects.toThrow(/symbolic link/);
  });
  it("extracts into a new empty temp folder and cleans up", async () => {
    const d = tempDir();
    const zip = path.join(d, "design.zip");
    writeZip(zip, [{ name: "inbox/screen.html", data: html }, { name: "inbox/assets/logo.png", data: "png" }]);
    const x = await extractZip(zip);
    expect(fs.readFileSync(path.join(x.dir, "inbox", "screen.html"), "utf8")).toBe(html);
    expect(fs.readFileSync(path.join(x.dir, "inbox", "assets", "logo.png"), "utf8")).toBe("png");
    x.cleanup();
    expect(fs.existsSync(x.dir)).toBe(false);
  });
});

describe("openDesignInput", () => {
  it("resolves a screen id, a folder, a file and a ZIP with one top folder", async () => {
    const root = tempDir();
    const screen = path.join(root, "inbox");
    fs.mkdirSync(screen);
    fs.writeFileSync(path.join(screen, "screen.html"), html);
    for (const input of ["inbox", screen, path.join(screen, "screen.html")]) {
      const r = await openDesignInput(input, root);
      expect(r.entry).toBe(path.join(screen, "screen.html"));
      r.cleanup();
    }
    const zip = path.join(root, "inbox.zip");
    writeZip(zip, [{ name: "inbox/screen.html", data: html }]);
    const z = await openDesignInput("inbox.zip", root);
    expect(path.basename(z.entry)).toBe("screen.html");
    expect(z.zip).toBe(zip);
    z.cleanup();
    expect(fs.existsSync(z.entry)).toBe(false);
  });
  it("names a path that does not exist", async () => {
    await expect(openDesignInput("missing", tempDir())).rejects.toThrow(/not found/);
  });
});

describe("openContractFolder", () => {
  it("takes a folder as it is (no page needed), a page's folder, and a ZIP's page folder", async () => {
    const root = tempDir();
    const screen = path.join(root, "inbox");
    fs.mkdirSync(screen);
    // only the contract: nothing is designed yet
    for (const input of ["inbox", screen]) expect((await openContractFolder(input, root)).dir).toBe(screen);
    for (const n of ["a.dc.html", "b.dc.html"]) fs.writeFileSync(path.join(screen, n), html);
    for (const input of ["inbox", "inbox/a.dc.html", path.join(screen, "b.dc.html")]) expect((await openContractFolder(input, root)).dir).toBe(screen);
    writeZip(path.join(root, "inbox.zip"), [{ name: "inbox/screen.html", data: html }, { name: "inbox/screen.contract.json", data: "{}" }]);
    const z = await openContractFolder("inbox.zip", root);
    expect(fs.existsSync(path.join(z.dir, "screen.contract.json"))).toBe(true);
    z.cleanup();
    expect(fs.existsSync(z.dir)).toBe(false);
    await expect(openContractFolder("missing", root)).rejects.toThrow(/design not found: missing/);
    fs.writeFileSync(path.join(screen, "notes.txt"), "x");
    await expect(openContractFolder("inbox/notes.txt", root)).rejects.toThrow(/not a screen folder or a design page/);
  });
});
