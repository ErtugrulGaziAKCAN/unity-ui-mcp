import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { readKit, type KitConfig } from "../src/kit.js";
import { logicalViewport } from "../src/viewport.js";
import { openDesign, unwrapDcHtml, usedFamilies, declaredFontFaces } from "../src/load.js";

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

  it("uses Unity's linear width/height blend off the reference aspect", () => {
    // PanelSettings.ResolveScale: scale = lerp(W/refW, H/refH, match); the CanvasScaler log formula would differ.
    const narrow = logicalViewport([1437, 1440], [2560, 1440], 0.5);
    expect(narrow.scale).toBeCloseTo((1437 / 2560 + 1) / 2, 8);
    expect(narrow.width).toBeCloseTo(1437 / narrow.scale, 6);
    expect(narrow.height).toBeCloseTo(1440 / narrow.scale, 6);
    expect(logicalViewport([2400, 1440], [2560, 1440], 0.5).scale).toBe(0.96875);
    const wide = logicalViewport([2560, 1080], [2560, 1440], 0.5);
    expect(wide.scale).toBe(0.875);
    expect(wide.width).toBeCloseTo(2560 / 0.875, 6);
    expect(wide.height).toBeCloseTo(1080 / 0.875, 6);
    expect(logicalViewport([1437, 1440], [2560, 1440], 0).scale).toBeCloseTo(1437 / 2560, 9);
    expect(logicalViewport([1437, 1440], [2560, 1440], 1).scale).toBe(1);
  });
});

describe("unwrapDcHtml", () => {
  const src = fs.readFileSync(fx("canvas.dc.html"), "utf8");
  it("moves helmet to head, x-dc to body, drops runtime, rewrites blobs", () => {
    const { html, dynamic } = unwrapDcHtml(src, blobs);
    const [head, body] = html.split("<body");
    expect(head).toContain("<style>:root{-webkit-font-smoothing:antialiased}body{margin:0");
    expect(head).toContain("url(assets/logo.png)");
    expect(body).toContain('id="root"');
    expect(html).not.toContain("support.js");
    expect(html).not.toContain("x-dc");
    expect(html).not.toContain("helmet");
    expect(html).toContain('src="assets/logo.png"');
    expect(html).not.toContain("_blob");
    expect(dynamic).toEqual([]);
  });
  it("reports unresolved blobs, extension-carrying ids, holes in helmet and content outside x-dc", () => {
    expect(unwrapDcHtml(src, {}).unresolvedBlobs).toEqual(["abc"]);
    expect(unwrapDcHtml(src, blobs).unresolvedBlobs).toEqual([]);
    const ext = unwrapDcHtml(src.replace('src="/_blob/abc"', 'src="/_blob/abc.png"'), blobs).html;
    expect(ext).toContain('src="assets/logo.png"');
    expect(ext).not.toContain("logo.png.png");
    const h = unwrapDcHtml(src.replace("</style></helmet>", "/*{{x}}*/</style></helmet>"), blobs).dynamic;
    expect(h).toEqual([{ kind: "hole", detail: "{{x}}" }]);
    const out = unwrapDcHtml(src.replace("<x-dc>", "<p>stray</p><x-dc>"), blobs).dynamic;
    expect(out.map((d) => d.kind)).toEqual(["outside-x-dc"]);
  });
  it("reports a canvas without x-dc", () => {
    expect(unwrapDcHtml("<html><head></head></html>", {}).dynamic.map((d) => d.kind)).toEqual(["no-x-dc"]);
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

  const tmpDir = () => fs.mkdtempSync(path.join(here, "fixtures", "tmp-"));

  it("records missing local assets and unresolved blobs", async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "a.html"), '<html><body><img src="nope.png"><p>x</p></body></html>');
      const d = await openDesign(path.join(dir, "a.html"), kit, [2560, 1440], shared);
      expect(d.missing).toEqual(["/nope.png"]);
      await d.close();
      fs.copyFileSync(fx("canvas.dc.html"), path.join(dir, "c.dc.html"));
      const c = await openDesign(path.join(dir, "c.dc.html"), kit, [2560, 1440], shared);
      expect(c.unresolvedBlobs).toEqual(["abc"]);
      expect(c.missing.length).toBeGreaterThan(0);
      await c.close();
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("does not leak contexts or browsers on failure", async () => {
    const dir = tmpDir();
    try {
      fs.copyFileSync(fx("canvas.dc.html"), path.join(dir, "c.dc.html"));
      fs.writeFileSync(path.join(dir, "blobs.json"), "{not json");
      const before = shared.contexts().length;
      await expect(openDesign(path.join(dir, "c.dc.html"), kit, [2560, 1440], shared)).rejects.toThrow();
      expect(shared.contexts().length).toBe(before);
      // failure after newContext: navigation target vanishes is not possible, so break the kit viewport instead
      const bad = { ...kit, allowedScriptOrigins: ["not a url"] };
      await expect(openDesign(fx("plain.html"), bad, [2560, 1440], shared)).rejects.toThrow();
      expect(shared.contexts().length).toBe(before);
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("does not follow redirects out of an allowed origin and rejects non-JavaScript", async () => {
    const evil = http.createServer((_q, r) => { r.setHeader("content-type", "text/javascript"); r.end("window.__evil = 1;"); });
    await new Promise<void>((res) => evil.listen(0, "127.0.0.1", res));
    const evilUrl = `http://127.0.0.1:${(evil.address() as { port: number }).port}/e.js`;
    const srv = http.createServer((q, r) => {
      if (q.url === "/redir.js") { r.statusCode = 302; r.setHeader("location", evilUrl); r.end(); }
      else if (q.url === "/text.js") { r.setHeader("content-type", "text/html"); r.end("window.__text = 1;"); }
      else { r.statusCode = 500; r.destroy(); }
    });
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    const o = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "s.html"), `<html><body><script src="${o}/redir.js"></script><script src="${o}/text.js"></script><script src="${o}/boom.js"></script></body></html>`);
      const d = await openDesign(path.join(dir, "s.html"), { ...kit, allowedScriptOrigins: [o] }, [2560, 1440], shared);
      expect(await d.page.evaluate(() => [(window as any).__evil, (window as any).__text])).toEqual([undefined, undefined]);
      expect(d.blocked.length).toBe(3);
      await d.close();
    } finally { fs.rmSync(dir, { recursive: true }); evil.close(); srv.close(); }
  });

  it("serves file names with spaces and non-ASCII characters", async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "my screen \u0131.html"), "<html><body><p id='t'>ok</p><img src='%E0%A4%A.png'></body></html>");
      const d = await openDesign(path.join(dir, "my screen \u0131.html"), kit, [2560, 1440], shared);
      expect(await d.page.evaluate(() => document.getElementById("t")!.textContent)).toBe("ok");
      await d.close();
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("gates fonts: whole stack, placeholders, own @font-face", async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "f.html"), `<html><head><style>@font-face{font-family:"Mine";src:local("Arial")}
        input{font-family:"Inter UI"} input::placeholder{font-family:Courier}</style></head>
        <body><p style="font-family:'Inter UI', Helvetica">a</p><input placeholder="p"><p style="font-family:Mine">b</p></body></html>`);
      const d = await openDesign(path.join(dir, "f.html"), kit, [2560, 1440], shared);
      expect(await usedFamilies(d.page)).toEqual(["Courier", "Helvetica", "Inter UI", "Mine"]);
      const faces = await declaredFontFaces(d.page, kit);
      expect(faces.filter((f) => f.fromKit).map((f) => f.family)).toEqual(["Inter UI", "Inter UI"]);
      const own = faces.filter((f) => !f.fromKit);
      expect(own.map((f) => f.family)).toEqual(["Mine"]);
      expect(own[0].src).toContain("local(");
      await d.close();
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("freezes animations at their end state", async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "a.html"), `<html><head><style>@keyframes f{from{opacity:0}to{opacity:1}}
        #t{opacity:0;animation:f 1s forwards}</style></head><body><p id="t">x</p></body></html>`);
      const d = await openDesign(path.join(dir, "a.html"), kit, [2560, 1440], shared);
      expect(await d.page.evaluate(() => getComputedStyle(document.getElementById("t")!).opacity)).toBe("1");
      await d.close();
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("font faces: nested at-rules and same-named script faces are not from the kit", async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, "f.html"), `<html><head><style>@media all{@font-face{font-family:"Nested";src:local("Arial")}}
        @layer x{@font-face{font-family:"Layered";src:local("Arial")}}</style></head><body><p>a</p></body></html>`);
      const d = await openDesign(path.join(dir, "f.html"), kit, [2560, 1440], shared);
      await d.page.evaluate(() => { document.fonts.add(new FontFace("Inter UI", 'local("Arial")')); });
      const faces = await declaredFontFaces(d.page, kit);
      expect(faces.filter((f) => !f.fromKit).map((f) => f.family).sort()).toEqual(["Inter UI", "Layered", "Nested"]);
      expect(faces.filter((f) => f.fromKit).length).toBe(2);
      await d.close();
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it("closes its own browser when opening fails", async () => {
    let launched: Browser | undefined;
    const orig = chromium.launch.bind(chromium);
    const spy = vi.spyOn(chromium, "launch").mockImplementation(async (o) => (launched = await orig(o)));
    try {
      await expect(openDesign(fx("plain.html"), { ...kit, allowedScriptOrigins: ["not a url"] }, [2560, 1440])).rejects.toThrow();
      expect(launched).toBeDefined();
      expect(launched!.isConnected()).toBe(false);
    } finally { spy.mockRestore(); }
  });
});
