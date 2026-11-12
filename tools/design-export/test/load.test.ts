import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { readKit, type KitConfig } from "../src/kit.js";
import { logicalViewport } from "../src/viewport.js";
import { openDesign, unwrapDcHtml, usedFamilies } from "../src/load.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => path.join(here, "fixtures", "load", n);
const kit: KitConfig = readKit(fx("kit"));
const blobs = { abc: "assets/logo.png" };

describe("readKit", () => {
  it("reads kit.config.json", () => {
    expect(kit.reference).toEqual([2560, 1440]);
    expect(kit.dir).toBe(fx("kit"));
    expect(kit.allowedScriptOrigins).toContain("https://unpkg.com");
  });
});

describe("logicalViewport", () => {
  it("scales like the Unity panel", () => {
    expect(logicalViewport([2560, 1440], [2560, 1440], 0.5)).toEqual({ width: 2560, height: 1440, scale: 1 });
    expect(logicalViewport([1920, 1080], [2560, 1440], 0.5)).toEqual({ width: 2560, height: 1440, scale: 0.75 });
    expect(logicalViewport([1280, 720], [2560, 1440], 0.5)).toEqual({ width: 2560, height: 1440, scale: 0.5 });
  });
});

describe("unwrapDcHtml", () => {
  const src = fs.readFileSync(fx("canvas.dc.html"), "utf8");
  it("moves helmet to head, x-dc to body, drops runtime, rewrites blobs", () => {
    const { html, dynamic } = unwrapDcHtml(src, blobs);
    const [head, body] = html.split("<body");
    expect(head).toContain("<style>body{margin:0");
    expect(head).toContain("url(assets/logo.png)");
    expect(body).toContain('id="root"');
    expect(html).not.toContain("support.js");
    expect(html).not.toContain("x-dc");
    expect(html).not.toContain("helmet");
    expect(html).toContain('src="assets/logo.png"');
    expect(html).not.toContain("_blob");
    expect(dynamic).toEqual([]);
  });
  const wrap = (inner: string, props = '{"$preview":{"width":1,"height":1}}', script = "class Component extends DCLogic{}") =>
    `<html><head></head><body><x-dc><helmet><style></style></helmet>${inner}</x-dc><script type="text/x-dc" data-dc-script data-props='${props}'>${script}</script></body></html>`;
  it("reports dynamic features", () => {
    expect(unwrapDcHtml(wrap("<p>{{title}}</p>"), {}).dynamic).toEqual([{ kind: "hole", detail: "{{title}}" }]);
    expect(unwrapDcHtml(wrap('<sc-for each="x"><i></i></sc-for>'), {}).dynamic.map((d) => d.kind)).toEqual(["sc-for"]);
    expect(unwrapDcHtml(wrap("<sc-if cond=\"a\"><i></i></sc-if>"), {}).dynamic.map((d) => d.kind)).toEqual(["sc-if"]);
    expect(unwrapDcHtml(wrap('<dc-import src="a"></dc-import>'), {}).dynamic.map((d) => d.kind)).toEqual(["dc-import"]);
    expect(unwrapDcHtml(wrap('<x-import src="a"></x-import>'), {}).dynamic.map((d) => d.kind)).toEqual(["x-import"]);
    expect(unwrapDcHtml(wrap("<i></i>", '{"$preview":{"width":1},"accent":"red"}'), {}).dynamic).toEqual([
      { kind: "data-props", detail: "accent" },
    ]);
    expect(unwrapDcHtml(wrap("<i></i>", undefined, "document.body.innerHTML='x'"), {}).dynamic.map((d) => d.kind)).toEqual(["script-ui"]);
  });
});

describe("openDesign", () => {
  let shared: Browser;
  let server: http.Server;
  let origin = "";
  beforeAll(async () => {
    shared = await chromium.launch();
    server = http.createServer((_q, r) => { r.setHeader("content-type", "text/javascript"); r.end("window.__ext = 1;"); });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await shared.close(); server.close(); });

  it("blocks remote stylesheets and records them", async () => {
    const d = await openDesign(fx("remote-font.html"), kit, [2560, 1440], shared);
    expect(d.blocked[0].url.startsWith("https://fonts.googleapis.com")).toBe(true);
    await d.close();
  });

  it("allows scripts from allowed origins only", async () => {
    const k = { ...kit, allowedScriptOrigins: [origin] };
    const p = fx("script.html");
    fs.writeFileSync(p, `<!doctype html><html><body><script src="${origin}/a.js"></script><script src="https://evil.example/b.js"></script></body></html>`);
    try {
      const d = await openDesign(p, k, [2560, 1440], shared);
      expect(await d.page.evaluate(() => (window as any).__ext)).toBe(1);
      expect(d.blocked.map((b) => new URL(b.url).host)).toEqual(["evil.example"]);
      await d.close();
    } finally { fs.rmSync(p); }
  });

  it("uses only kit font families", async () => {
    const ok = await openDesign(fx("compliant.html"), kit, [2560, 1440], shared);
    expect(await usedFamilies(ok.page)).toEqual(["Inter UI"]);
    expect(await ok.page.evaluate(() => Array.from(document.fonts).filter((f) => f.status === "loaded").length)).toBeGreaterThan(0);
    await ok.close();
    const bad = await openDesign(fx("arial.html"), kit, [2560, 1440], shared);
    expect(await usedFamilies(bad.page)).toEqual(["Arial"]);
    await bad.close();
  });

  it("scales the page like the Unity panel", async () => {
    const d = await openDesign(fx("plain.html"), kit, [1920, 1080], shared);
    expect(await d.page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])).toEqual([2560, 1440, 0.75]);
    await d.close();
  });

  it("disables animations", async () => {
    const d = await openDesign(fx("plain.html"), kit, [2560, 1440], shared);
    expect(await d.page.evaluate(() => getComputedStyle(document.getElementById("t")!).transitionDuration)).toBe("0s");
    await d.close();
  });

  it("renders a .dc.html like its plain twin", async () => {
    const boxes = async (f: string) => {
      const d = await openDesign(fx(f), kit, [2560, 1440], shared);
      const r = await d.page.evaluate(() => Array.from(document.querySelectorAll("[id]")).map((e) => { const b = e.getBoundingClientRect(); return [e.id, b.x, b.y, b.width, b.height]; }));
      const loaded = await d.page.evaluate(() => (document.getElementById("i") as HTMLImageElement).naturalWidth);
      await d.close();
      return { r, loaded };
    };
    const a = await boxes("plain.html"), b = await boxes("canvas.dc.html");
    expect(b.r).toEqual(a.r);
    expect(b.loaded).toBe(1);
  });

  it("two designs share one browser, which stays open", async () => {
    const d1 = await openDesign(fx("plain.html"), kit, [2560, 1440], shared);
    const d2 = await openDesign(fx("canvas.dc.html"), kit, [1920, 1080], shared);
    expect(d1.browser).toBe(shared);
    await d1.close();
    expect(await d2.page.evaluate(() => document.getElementById("t")!.textContent)).toBe("Hello");
    await d2.close();
    expect(shared.isConnected()).toBe(true);
  });

  it("launches and closes its own browser when none is given", async () => {
    const d = await openDesign(fx("plain.html"), kit, [2560, 1440]);
    const b = d.browser;
    await d.close();
    expect(b.isConnected()).toBe(false);
  });
});
