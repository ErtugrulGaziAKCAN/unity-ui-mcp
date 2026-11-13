import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { readKit, type KitConfig } from "../src/kit.js";
import { openDesign } from "../src/load.js";
import { collectSnapshot, lint, type DomSnapshot } from "../src/lint/index.js";
import { buildIr, type IrBuild } from "../src/extract/tree.js";
import { classifyKind } from "../src/extract/kind.js";
import { pinViewBox } from "../src/extract/assets.js";
import { structuralId } from "../src/extract/naming.js";
import { specifiedLayers } from "../src/extract/styles.js";
import type { IrNode } from "../src/ir/types.js";
import { stableStringify } from "../src/ir/stableStringify.js";
import { validateIr } from "../src/ir/validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => path.join(here, "fixtures", "extract", n);
const kit: KitConfig = readKit(fx("kit"));

let browser: Browser;
const tmpDirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "extract-")); tmpDirs.push(d); return d; };
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => {
  await browser.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function build(file: string, outDir = tmp()): Promise<IrBuild & { outDir: string }> {
  const d = await openDesign(file, kit, [2560, 1440], browser);
  try {
    const s = await collectSnapshot(d.page, d.cdp, kit);
    const r = await buildIr(d, s, kit, outDir, file);
    return { ...r, outDir };
  } finally { await d.close(); }
}

async function snap(file: string): Promise<DomSnapshot> {
  const d = await openDesign(file, kit, [2560, 1440], browser);
  try { return await collectSnapshot(d.page, d.cdp, kit); } finally { await d.close(); }
}

const flat = (n: IrNode): IrNode[] => [n, ...n.children.flatMap(flat)];
const byId = (root: IrNode, id: string): IrNode => {
  const n = flat(root).find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};

describe("fixtures", () => {
  it("lint clean (except the animation fixture, whose easing lint still restricts)", async () => {
    for (const f of ["inbox.html", "assets.html", "repeat.html"]) {
      const d = await openDesign(fx(f), kit, [2560, 1440], browser);
      // inbox keeps CSS's initial content-box on sized elements with padding or border, so the IR records it (below);
      // lint rejects exactly those (U-CSS-036), because the compiler cannot size them
      const expected = f === "inbox.html" ? ["card", "half"].map((id) => `${f} U-CSS-036 [data-u-screen=inbox] > div[data-u-id=${id}]`) : [];
      try { expect((await lint(d, kit)).map((x) => `${f} ${x.ruleId} ${x.path}`)).toEqual(expected); } finally { await d.close(); }
    }
  });
});

describe("buildIr: styles", () => {
  let r: IrBuild;
  beforeAll(async () => { r = await build(fx("inbox.html")); });

  it("is a valid IR for the screen", () => {
    expect(validateIr(r.ir)).toEqual([]);
    expect(r.ir.screen).toBe("inbox");
    expect(r.ir.root.id).toBe("root");
    expect(r.ir.source.path).toBe("inbox.html");
    expect(r.ir.source.sha256).toBe(crypto.createHash("sha256").update(fs.readFileSync(fx("inbox.html"))).digest("hex"));
    expect(r.ir.referenceViewport).toEqual([2560, 1440]);
    expect(r.ir.viewports).toEqual(kit.viewports);
    expect(r.ir.screenMatch).toBe(0.5);
    expect(r.ir.states).toEqual(["default", "loading"]);
  });

  it("keeps % and turns rem into px longhands", () => {
    const half = byId(r.ir.root, "half");
    expect(half.style.base.width).toBe("50%");
    expect(half.style.base["padding-top"]).toBe("24px");
    expect(half.style.base["padding-left"]).toBe("24px");
    expect(half.style.base.padding).toBeUndefined();
  });

  it("resolves var() through tokens and records the tokens used", () => {
    const card = byId(r.ir.root, "card");
    expect(card.style.hover["background-color"]).toBe("#16c2d5");
    expect(card.style.base["background-color"]).toBe("#123c47");
    expect(r.ir.tokens).toEqual({ accent: "#16c2d5", "color-surface": "#0b1f26", "color-text": "#ffffff" });
    expect(r.ir.root.style.base["background-color"]).toBe("#0b1f26");
  });

  it("puts state rules into state layers and records display on every node", () => {
    const sp = byId(r.ir.root, "spinner");
    expect(sp.style.base.display).toBe("none");
    expect(sp.style["state:loading"]).toEqual({ display: "flex" });
    for (const n of flat(r.ir.root)) expect(typeof n.style.base.display, n.id).toBe("string");
    expect(byId(r.ir.root, "title").style.base.display).toBe("block");
    expect(byId(r.ir.root, "half").style.base.display).toBe("flex");
  });

  it("puts @media rules into breakpoint layers and is-* rules into class layers", () => {
    expect(r.ir.breakpoints).toEqual([{ name: "max-width-1919", maxWidth: 1919 }]);
    expect(byId(r.ir.root, "half").style["bp:max-width-1919"]["padding-top"]).toBe("8px");
    expect(byId(r.ir.root, "tab").style["class:is-selected"]).toEqual({ "background-color": "#16c2d5" });
  });

  it("resolves border radii per layer with the overlapping-curves rule", () => {
    // 9999px on the 302×82 border box (300×80 content-box plus a 1px border): a pill of radius 41
    const card = byId(r.ir.root, "card");
    for (const c of ["top-left", "top-right", "bottom-right", "bottom-left"]) expect(card.style.base[`border-${c}-radius`]).toBe("41px");
    // hidden in the default state: resolved against its box in the loading state
    expect(byId(r.ir.root, "spinner").style.base["border-top-left-radius"]).toBe("16px");
  });

  it("splits transform into translate, rotate and scale", () => {
    const b = byId(r.ir.root, "half").style.base;
    expect(b.transform).toBeUndefined();
    expect([b.translate, b.rotate, b.scale]).toEqual(["10px 5px", "45deg", "1.5 1.5"]);
  });

  it("records CSS's initial content-box where it renders differently from USS (sized, with padding or border)", () => {
    expect(byId(r.ir.root, "card").style.base["box-sizing"]).toBe("content-box");
    expect(byId(r.ir.root, "half").style.base["box-sizing"]).toBe("content-box");
    expect(byId(r.ir.root, "plain").style.base["box-sizing"]).toBeUndefined();
    expect(byId(r.ir.root, "list").style.base["box-sizing"]).toBeUndefined();
  });

  it("writes borders as they render", () => {
    expect(byId(r.ir.root, "card").style.base).toMatchObject({ "border-top-width": "1px", "border-top-style": "solid", "border-top-color": "#16c2d5" });
    const plain = byId(r.ir.root, "plain").style.base;
    expect(Object.keys(plain).filter((k) => k.startsWith("border"))).toEqual([]);
  });

  it("names elements without data-u-id structurally", () => {
    expect(structuralId("list", 2)).toBe("list__2");
    expect(byId(r.ir.root, "list").children.map((c) => c.id)).toEqual(["first", "second", "list__2"]);
  });

  it("records text with localization data and the kit text style", () => {
    expect(byId(r.ir.root, "title").text).toEqual({ key: "inbox.title", tr: "Gelen Kutusu", en: "Inbox", args: [], rich: false, style: "label" });
    expect(byId(r.ir.root, "title").kind).toBe("text");
  });

  it("writes inline emphasis as rich text", () => {
    const note = byId(r.ir.root, "note");
    expect(note.text).toMatchObject({ key: "inbox.note", tr: "Yeni <b>posta</b> var", rich: true });
    expect(note.children).toEqual([]);
  });

  it("records inherited text properties on text nodes, with the ancestor layers that change them", () => {
    const t = byId(r.ir.root, "title").style.base;
    expect(t).toMatchObject({ color: "#ffffff", "font-family": '"Inter UI"', "font-weight": "400" });
    expect(t["font-size"]).toBe("16px");
    const label = byId(r.ir.root, "play").children[0];
    expect(label.style.base).toMatchObject({ "text-align": "center", color: "#ffffff" });
    expect(label.style["anc(play):hover"]).toEqual({ color: "#16c2d5" });
    expect(byId(r.ir.root, "play").style.hover).toEqual({ color: "#16c2d5" });
  });

  it("keeps ids, actions and classes", () => {
    const play = byId(r.ir.root, "play");
    expect(play.action).toBe("play");
    expect(play.classes).toEqual(["btn"]);
    expect(r.ir.root.classes).toEqual(["screen"]);
  });

  it("records the kit fonts the text uses", () => {
    expect(r.ir.fonts.map((f) => [f.locale, f.family, f.file, f.weight])).toEqual([
      ["tr", "Inter UI", "fonts/Inter_18pt-Regular.ttf", 400],
      ["tr", "Inter UI", "fonts/Inter_18pt-Bold.ttf", 700],
    ]);
    expect(r.ir.fonts[0].sha256).toBe(crypto.createHash("sha256").update(fs.readFileSync(fx("kit/fonts/Inter_18pt-Regular.ttf"))).digest("hex"));
  });

  it("exports byte-identical IR twice, into any folder", async () => {
    const again = await build(fx("inbox.html"));
    expect(stableStringify(again.ir)).toBe(stableStringify(r.ir));
  });
});

describe("buildIr: kinds, assets and external regions", () => {
  let r: IrBuild & { outDir: string };
  beforeAll(async () => { r = await build(fx("assets.html")); });

  it("copies images by content hash, with presentational sizes and reproduced browser defaults", () => {
    const logo = byId(r.ir.root, "logo");
    const sha = crypto.createHash("sha256").update(fs.readFileSync(fx("assets/logo.png"))).digest("hex");
    expect(logo.kind).toBe("image");
    expect(logo.asset).toEqual({ kind: "image", file: `assets/${sha}.png`, sha256: sha, width: 1, height: 1, slice: null, tint: false, stopGap: null });
    expect(fs.readFileSync(path.join(r.outDir, logo.asset!.file))).toEqual(fs.readFileSync(fx("assets/logo.png")));
    expect(logo.style.base).toMatchObject({ width: "64px", height: "32px", "overflow-x": "clip", "overflow-y": "clip" });
    const bg = byId(r.ir.root, "bg");
    expect(bg.kind).toBe("image");
    expect(bg.asset!.file).toBe(`assets/${sha}.png`);
  });

  it("serialises an inline svg painted with currentColor white and marks it tintable with its colour", () => {
    const icon = byId(r.ir.root, "icon");
    expect(icon.kind).toBe("vector");
    expect(icon.children).toEqual([]);
    expect(icon.asset!.kind).toBe("svg");
    expect(icon.asset!.tint).toBe(true);
    expect([icon.asset!.width, icon.asset!.height]).toEqual([24, 24]);
    const svg = fs.readFileSync(path.join(r.outDir, icon.asset!.file), "utf8");
    expect(icon.asset!.file).toBe(`assets/${crypto.createHash("sha256").update(svg).digest("hex")}.svg`);
    expect(svg).not.toMatch(/currentcolor/i);
    expect(svg).toContain("stroke: rgb(255, 255, 255)");
    expect(svg).toContain("stroke-width: 2");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    // the viewBox is pinned by a transparent rect, so Unity's VectorImage spans it (not just the shapes' bounds)
    expect(svg).toMatch(/^<svg[^>]*><rect x="0" y="0" width="24" height="24" fill="#000000" fill-opacity="0"\/>/);
    expect(icon.style.base.color).toBe("#16c2d5");
  });

  it("pins an svg's viewBox (else its width and height) with a transparent first rect", () => {
    expect(pinViewBox('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 1 20 10"><path d="M0 0"/></svg>'))
      .toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 1 20 10"><rect x="-2" y="1" width="20" height="10" fill="#000000" fill-opacity="0"/><path d="M0 0"/></svg>');
    expect(pinViewBox('<svg width="48px" height="24"><path d="M0 0"/></svg>')).toContain('<svg width="48px" height="24"><rect x="0" y="0" width="48" height="24"');
    expect(pinViewBox("<svg><path/></svg>")).toBe("<svg><path/></svg>");
    expect(pinViewBox("<svg/>")).toBe("<svg/>");
  });

  it("keeps a data-u-external region as one node without children", () => {
    const shell = byId(r.ir.root, "shell");
    expect(shell.external).toBe(true);
    expect(shell.children).toEqual([]);
    expect(shell.style.base.width).toBe("100px");
  });

  it("classifies element kinds", async () => {
    const s = await snap(fx("assets.html"));
    const at = (id: string) => s.elements.find((e) => e.attrs["data-u-id"] === id)!;
    expect(classifyKind(at("logo"), s)).toBe("image");
    expect(classifyKind(at("icon"), s)).toBe("vector");
    expect(classifyKind(at("bg"), s)).toBe("image");
    expect(specifiedLayers(at("bg"), s).base.width).toBe("64px");
  });
});

describe("buildIr: repeats", () => {
  it("keeps the first sample as template, counts the samples and exposes their values", async () => {
    const r = await build(fx("repeat.html"));
    expect(validateIr(r.ir)).toEqual([]);
    const rows = byId(r.ir.root, "rows");
    expect(rows.kind).toBe("list");
    expect(rows.repeat).toEqual({ name: "players", mode: "list", count: 3 });
    expect(rows.children.map((c) => c.id)).toEqual(["row"]);
    const chips = byId(rows, "chips");
    expect(chips.kind).toBe("container");
    expect(chips.repeat).toEqual({ name: "tags", mode: "inline", count: 1 });
    expect(byId(rows, "name").text).toEqual({ key: null, tr: "Ali", en: null, args: [], rich: false, style: "label" });
    expect(byId(rows, "name").bind).toBe("name");
    expect(r.fixtures).toEqual({
      club: "Kartal",
      players: [
        { name: "Ali", age: "21", tags: [{}] },
        { name: "Veli", age: "23", tags: [{}, {}] },
        { name: "Ayşe", age: "25", tags: [{}] },
      ],
    });
  });

  it("rejects samples whose structure differs from the template, naming both", async () => {
    await expect(build(fx("repeat-mismatch.html"))).rejects.toThrow(/players.*row.*row/s);
  });
});

describe("buildIr: animations", () => {
  let r: IrBuild;
  beforeAll(async () => { r = await build(fx("anims.html")); });

  it("records transitions per trigger and keeps them out of the style layers", () => {
    expect(validateIr(r.ir)).toEqual([]);
    const btn = byId(r.ir.root, "btn");
    for (const layer of Object.values(btn.style)) expect(Object.keys(layer).filter((k) => /^(transition|animation)/.test(k))).toEqual([]);
    const t = (trigger: string, phase: string) => btn.anims.filter((a) => a.trigger === trigger && a.phase === phase)
      .map((a) => [a.kind, a.properties.join(","), a.duration, a.delay, a.timing]);
    expect(t("hover", "enter")).toEqual([["transition", "background-color", 200, 50, "cubic-bezier(0.4, 0, 0.2, 1)"]]);
    expect(t("hover", "leave")).toEqual([["transition", "background-color", 200, 50, "cubic-bezier(0.4, 0, 0.2, 1)"]]);
    expect(t("active", "enter")).toEqual([["transition", "opacity", 100, 0, "linear"]]);
    expect(t("active", "leave")).toEqual([["transition", "opacity", 300, 0, "steps(4)"]]);
    expect(btn.anims.every((a) => a.name === null && a.iterations === 1 && a.keyframes.length === 0)).toBe(true);
  });

  it("records keyframe animations with offsets, segment easing, iterations, direction and fill", () => {
    const spin = byId(r.ir.root, "spin");
    const show = spin.anims.filter((a) => a.trigger === "show");
    expect(show).toEqual([{
      kind: "keyframes", trigger: "show", phase: "enter", name: "spin", properties: ["rotate"], duration: 1000, delay: 200,
      timing: "ease-in", iterations: "infinite", direction: "alternate", fillMode: "both", playState: "running", restart: true,
      keyframes: [
        { offset: 0, values: { rotate: "0deg" }, easing: null },
        { offset: 0.5, values: { rotate: "180deg" }, easing: "linear" },
        { offset: 1, values: { rotate: "360deg" }, easing: null },
      ],
    }]);
    expect(spin.anims.filter((a) => a.trigger === "state:loading").map((a) => [a.phase, a.properties, a.duration, a.timing]))
      .toEqual([["enter", ["opacity"], 400, "ease"]]);
    expect(spin.style["state:loading"]).toEqual({ opacity: "0.5" });
  });
});

describe("buildIr: layers, text runs and lossless values", () => {
  const write = (css: string, body: string) => {
    const p = path.join(tmp(), "s.html");
    fs.writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><style>:root{-webkit-font-smoothing:antialiased}body{margin:0}
      .screen{display:flex;flex-direction:column;width:2560px;height:1440px;position:relative;font-family:"Inter UI";font-size:16px;line-height:20px;color:#ffffff;background-color:#0b1f26}
      p{margin:0}${css}</style></head><body><div class="screen" data-u-screen="s">${body}</div></body></html>`);
    return p;
  };
  const lintIds = async (file: string) => {
    const d = await openDesign(file, kit, [2560, 1440], browser);
    try { return Array.from(new Set((await lint(d, kit)).filter((f) => f.severity === "error").map((f) => f.ruleId))).sort(); } finally { await d.close(); }
  };

  it("compound, ancestor and breakpoint layers with unions of co-active layers", async () => {
    const r = await build(fx("compound.html"));
    expect(validateIr(r.ir)).toEqual([]);
    const n = (id: string) => byId(r.ir.root, id);
    expect(n("t").style["anc(card):hover"]).toEqual({ color: "#16c2d5" });
    expect(n("t").anims.map((a) => [a.trigger, a.phase, a.properties, a.duration])).toEqual([["anc(card):hover", "enter", ["color"], 200], ["anc(card):hover", "leave", ["color"], 200]]);
    expect(n("x").style).toEqual({ base: expect.any(Object), "state:loading+hover": { opacity: "0.5" } });
    // hover and state:loading both set the background: their union records the cascade winner (the later rule)
    expect(n("b").style["state:loading+hover"]).toEqual({ "background-color": "#0000ff" });
    expect(n("r").style["bp:max-width-1919+hover"]).toEqual({ opacity: "0.5" });
    expect(n("name").style["anc(row):class:is-selected"]).toEqual({ color: "#16c2d5" });
    expect(r.ir.states).toEqual(["default", "loading"]);
  });

  it("a media query list becomes one breakpoint per query, and lint accepts it", async () => {
    const r = await build(fx("compound.html"));
    expect(r.ir.breakpoints).toEqual([{ name: "max-width-1919", maxWidth: 1919 }, { name: "min-aspect-ratio-3-1", minAspect: 3 }]);
    const st = byId(r.ir.root, "r").style;
    expect(st["bp:max-width-1919"]).toEqual({ "background-color": "#ffffff" });
    expect(st["bp:min-aspect-ratio-3-1"]).toEqual({ "background-color": "#ffffff" });
    expect(await lintIds(write("@media (max-width: 1919px), (min-aspect-ratio: 3/1){.q{opacity:0.5}} .q{width:10px;height:10px;flex-shrink:0}", '<div class="q" data-u-id="q"></div>'))).toEqual([]);
  });

  it("an ancestor state matching several ancestors is rejected by lint and export alike", async () => {
    const p = write(".card{display:flex;flex-direction:column;flex-shrink:0} .card:hover .t{color:#16c2d5}",
      '<div class="card" data-u-id="outer"><div class="card" data-u-id="inner"><p class="t" data-u-id="t" data-l10n="s.t" data-en="T">T</p></div></div>');
    expect(await lintIds(p)).toEqual(["U-CSS-027"]);
    await expect(build(p)).rejects.toThrow(/matches 2 ancestors/);
  });

  it("a state compound with no other selector names the ancestor carrying its class, or is rejected by lint and export alike", async () => {
    const ok = write(".q{width:10px;height:10px;flex-shrink:0} .is-x .q{opacity:0.5} .c{display:flex;flex-shrink:0}",
      '<div class="c is-x" data-u-id="c"><div class="q" data-u-id="q"></div></div>');
    expect(await lintIds(ok)).toEqual([]);
    expect(byId((await build(ok)).ir.root, "q").style["anc(c):class:is-x"]).toEqual({ opacity: "0.5" });
    for (const [css, msg] of [
      [":hover .q{opacity:0.5}", /names a state but not the ancestor/],
      [".is-open .q{opacity:0.5}", /matches no ancestor .* inside the screen/],
      ["body:hover .q{opacity:0.5}", /matches no ancestor .* inside the screen/],
    ] as const) {
      const p = write(`.q{width:10px;height:10px;flex-shrink:0} .c{display:flex;flex-shrink:0} ${css}`, '<div class="c" data-u-id="c"><div class="q" data-u-id="q"></div></div>');
      const d = await openDesign(p, kit, [2560, 1440], browser);
      try {
        const f = (await lint(d, kit)).filter((x) => x.severity === "error");
        expect(f.map((x) => x.ruleId), css).toEqual(["U-CSS-027"]);
        expect(f[0].detail, css).toMatch(msg);
      } finally { await d.close(); }
      await expect(build(p), css).rejects.toThrow(msg);
    }
  });

  it("custom properties redefined in a layer re-resolve shorthand users too", async () => {
    const p = write(`.b{display:flex;flex-direction:column;flex-shrink:0;--c:#00ff00;--p:4px} .b:hover{--c:#ff0000;--p:8px}
      .k{box-sizing:border-box;width:10px;height:10px;flex-shrink:0} .k1{border:1px solid var(--c)} .k2{background:var(--c)} .k3{padding:var(--p)}
      .k4{border-width:1px;border-style:solid;border-color:var(--c)}`,
      '<div class="b" data-u-id="b"><div class="k k1" data-u-id="k1"></div><div class="k k2" data-u-id="k2"></div><div class="k k3" data-u-id="k3"></div><div class="k k4" data-u-id="k4"></div></div>');
    expect(await lintIds(p)).toEqual([]);
    const r = await build(p);
    const hover = (id: string) => byId(r.ir.root, id).style["anc(b):hover"];
    expect(byId(r.ir.root, "k1").style.base["border-top-color"]).toBe("#00ff00");
    expect(hover("k1")).toMatchObject({ "border-top-color": "#ff0000", "border-left-color": "#ff0000" });
    expect(hover("k2")).toMatchObject({ "background-color": "#ff0000" });
    expect(hover("k3")).toMatchObject({ "padding-top": "8px", "padding-left": "8px" });
    expect(hover("k4")).toMatchObject({ "border-top-color": "#ff0000", "border-bottom-color": "#ff0000" });
  });

  it("radii are resolved against the box measured in each layer (state, breakpoint, pseudo, union)", async () => {
    const st = byId((await build(fx("compound.html"))).ir.root, "pill").style;
    expect(st.base["border-top-left-radius"]).toBe("20px");
    expect(st.hover["border-top-left-radius"]).toBe("30px");
    expect(st["bp:max-width-1919"]["border-top-left-radius"]).toBe("10px");
    expect(st["bp:max-width-1919+hover"]["border-top-left-radius"]).toBe("30px");
  });

  it("keyed inline texts become text nodes; a wrapper becomes their container or row", async () => {
    const r = await build(fx("review-text.html"));
    const n = (id: string) => byId(r.ir.root, id);
    expect(n("wrap").kind).toBe("container");
    expect(n("wrap").children.map((c) => [c.kind, c.text?.key, c.text?.style, c.style.base.display])).toEqual([["text", "probe.title", "label", "block"]]);
    expect(n("save").kind).toBe("button");
    expect(n("save").children[0].text?.key).toBe("probe.save");
    expect(n("who").kind).toBe("container");
    expect(n("nm")).toMatchObject({ kind: "text", bind: "player-name", text: { tr: "Ali", key: null } });
    expect(r.fixtures["player-name"]).toBe("Ali");
    expect(n("pair").style.base).toMatchObject({ display: "flex", "flex-direction": "row", "justify-content": "flex-start" });
    expect(n("pair").children.map((c) => c.text?.key)).toEqual(["probe.a", "probe.b"]);
    expect(await lintIds(fx("review-text.html"))).toEqual([]);
  });

  it("keyed texts that a row would not reproduce are rejected by lint and export alike", async () => {
    expect(await lintIds(fx("review-text-two.html"))).toEqual(["U-MRK-009"]);
    await expect(build(fx("review-text-two.html"))).rejects.toThrow(/space between them/);
  });

  it("Smart String arguments are {name} in tr with their sample in fixtures", async () => {
    const r = await build(fx("review-ctl.html"));
    expect(byId(r.ir.root, "greet").text).toEqual({ key: "probe.greet", tr: "Selam {name}", en: "Hi {name}", args: ["name"], rich: false, style: "label" });
    expect(r.fixtures.name).toBe("Ali");
    expect(await lintIds(fx("review-ctl.html"))).toEqual([]);
    expect(await lintIds(write("", '<p data-l10n="s.g" data-en="Hi {name}" data-l10n-args="name">Selam <span data-u-id="nm" data-u-bind="name">Ali</span></p>'))).toEqual(["U-MRK-008", "U-MRK-009"]);
  });

  it("whitespace collapses as rendered across inline tags; pre-line is exact", async () => {
    expect(byId((await build(fx("review-text.html"))).ir.root, "ws").text?.tr).toBe("Merhaba <b>dünya</b>");
    expect(byId((await build(fx("compound.html"))).ir.root, "pl").text?.tr).toBe("a b\nc");
  });

  it("url() backgrounds are assets; size, repeat and position stay in the layers", async () => {
    const r = await build(fx("review-bg.html"));
    const sha = crypto.createHash("sha256").update(fs.readFileSync(fx("assets/logo.png"))).digest("hex");
    const hero = byId(r.ir.root, "hero");
    expect(hero.background).toMatchObject({ kind: "image", file: `assets/${sha}.png`, tint: false });
    expect(hero.style.base["background-image"]).toBe(`url("assets/${sha}.png")`);
    expect(hero.style.hover["background-image"]).toBe(`url("assets/${sha}.png")`);
    expect(byId(r.ir.root, "bg2").style.base).toMatchObject({ "background-size": "cover", "background-repeat": "no-repeat" });
    expect(fs.existsSync(path.join(r.outDir, `assets/${sha}.png`))).toBe(true);
    expect(await lintIds(fx("review-bg.html"))).toEqual([]);
  });

  it("custom properties per layer, tinted icons per layer, concrete initial values", async () => {
    const r = await build(fx("review-style.html"));
    expect(byId(r.ir.root, "panel").style["state:dark"]).toEqual({ "background-color": "#000000" });
    const icon = byId(r.ir.root, "icon");
    expect(icon.asset!.tint).toBe(true);
    expect(icon.style.base.color).toBe("#ffffff");
    expect(icon.style["anc(ib):hover"]).toEqual({ color: "#16c2d5" });
    expect(byId(r.ir.root, "reset").style.base.color).toBe("#000000");
  });

  it("initial disabled/checked and attribute texts", async () => {
    const r = await build(fx("review-ctl.html"));
    expect(byId(r.ir.root, "go").initial).toEqual({ disabled: true, checked: false });
    expect(byId(r.ir.root, "go").style.disabled).toEqual({ "background-color": "#333333" });
    expect(byId(r.ir.root, "chk").initial).toEqual({ disabled: false, checked: true });
    const mail = byId(r.ir.root, "mail");
    expect(mail.kind).toBe("input");
    expect(mail.text).toBeNull();
    expect(mail.attrTexts).toEqual({ placeholder: { key: "probe.mail", tr: "E-posta", en: "Email", args: [], rich: false, style: "label" } });
    // a text field's form: the compiler writes a password field and a multi-line text area; other nodes have none
    expect(mail.field).toEqual({ password: false, multiline: false, placeholderColor: "#8899aa" });
    expect(byId(r.ir.root, "pw").field).toEqual({ password: true, multiline: false, placeholderColor: null });
    expect(byId(r.ir.root, "pw").text).toMatchObject({ tr: "gizli", key: null });
    expect(byId(r.ir.root, "note").field).toEqual({ password: false, multiline: true, placeholderColor: null });
    expect(byId(r.ir.root, "note").kind).toBe("input");
    expect(byId(r.ir.root, "go").field).toBeUndefined();
    expect(validateIr(r.ir)).toEqual([]);
    expect(byId((await build(fx("assets.html"))).ir.root, "logo").attrTexts.alt).toMatchObject({ key: "assets.logo", tr: "Logo", en: "Logo", style: null });
  });

  it("CSS initial values that render differently in USS are explicit", async () => {
    const r = await build(fx("review-init.html"));
    expect(byId(r.ir.root, "f").style.base).toMatchObject({ "flex-direction": "row", "align-content": "stretch" });
    expect(byId(r.ir.root, "off").style.base.position).toBe("static");
  });

  it("is-* classes neither stop sampling nor stay on the template; they become item state", async () => {
    const r = await build(fx("review-ctl.html"));
    const rows = byId(r.ir.root, "rows");
    expect(rows.repeat).toEqual({ name: "items", mode: "inline", count: 3 });
    expect(rows.children[0].classes).toEqual(["row"]);
    expect(r.fixtures.items).toEqual([{ label: "One", $classes: { rows__0: ["is-selected"] } }, { label: "Two" }, { label: "Three", $classes: { rows__0: ["is-selected"] } }]);
  });

  it("an ancestor's transition of an inherited colour is copied to the text", async () => {
    const stl = byId((await build(fx("review-style.html"))).ir.root, "stl");
    expect(stl.style["state:dark"]).toEqual({ color: "#16c2d5" });
    expect(stl.anims.map((a) => [a.trigger, a.phase, a.properties, a.duration, a.timing])).toEqual([["state:dark", "enter", ["color"], 200, "ease"], ["state:dark", "leave", ["color"], 200, "ease"]]);
  });

  it("leaves the page as it was (svg probes, tint, layer boxes: viewport, classes, forced states)", async () => {
    for (const f of ["review-style.html", "compound.html", "review-ctl.html"]) {
      const d = await openDesign(fx(f), kit, [2560, 1440], browser);
      try {
        const html = await d.page.evaluate(() => document.documentElement.outerHTML);
        const vp = d.page.viewportSize();
        const s = await collectSnapshot(d.page, d.cdp, kit);
        await buildIr(d, s, kit, tmp(), fx(f));
        expect(await d.page.evaluate(() => document.documentElement.outerHTML), f).toBe(html);
        expect(d.page.viewportSize()).toEqual(vp);
      } finally { await d.close(); }
    }
  });

  it("revert, per-layer blockification, text inputs, play-state modifiers, id collisions", async () => {
    const r = await build(fx("compound.html"));
    expect(byId(r.ir.root, "rv").style.base["margin-top"]).toBe("16px");
    expect(byId(r.ir.root, "m").style["state:loading"]).toEqual({ display: "flex" });
    expect(byId(r.ir.root, "k").anims.map((a) => [a.trigger, a.restart, a.playState])).toEqual([["show", true, "running"], ["hover", false, "paused"]]);
    expect(byId(r.ir.root, "list").children.map((c) => c.id)).toEqual(["list__0", "list__1", "list__2_1"]);
    const a = byId((await build(fx("review-anim.html"))).ir.root, "a");
    expect(a.anims.filter((x) => x.phase === "enter").map((x) => [x.properties.join(), x.duration, x.timing])).toEqual([["background-color", 100, "linear"], ["scale", 200, "ease"]]);
  });
});

describe("buildIr: speed", () => {
  it("extracts a 600-node screen from the lint snapshot quickly", async () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      `<div class="row" data-u-id="row-${i}"><p data-u-id="name-${i}" data-u-bind="name-${i}">Oyuncu ${i}</p>` +
      `<p data-l10n="big.role" data-en="Role">Rol <b>A</b></p><div class="dot"></div></div>`).join("\n");
    const p = path.join(tmp(), "big.html");
    fs.writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><style>:root{-webkit-font-smoothing:antialiased}body{margin:0} *,*::before,*::after{box-sizing:border-box}
      .screen{display:flex;flex-direction:column;width:2560px;height:1440px;overflow:hidden;font-family:"Inter UI";font-size:16px;line-height:20px;color:#ffffff;background-color:#0b1f26}
      .list{display:flex;flex-direction:column;flex-shrink:0} .row{display:flex;flex-direction:row;height:24px;flex-shrink:0;border-bottom:1px solid #16c2d5;transition:background-color 150ms ease}
      .row:hover{background-color:#123c47} p{margin:0;flex-shrink:0} .dot{width:8px;height:8px;border-radius:4px;background-color:#16c2d5}
      .state-loading .dot{opacity:0.5} @media (max-width: 1919px){.row{height:20px}}</style></head>
      <body><div class="screen" data-u-screen="big"><p data-l10n="big.title" data-en="Players">Oyuncular</p><div class="list" data-u-id="list">${rows}</div></div></body></html>`);
    const d = await openDesign(p, kit, [2560, 1440], browser);
    try {
      const s = await collectSnapshot(d.page, d.cdp, kit);
      expect(await lint(d, kit, s)).toEqual([]);
      const t0 = performance.now();
      const r = await buildIr(d, s, kit, tmp(), p);
      const ms = performance.now() - t0;
      expect(flat(r.ir.root).length).toBeGreaterThanOrEqual(600);
      expect(r.timings.total).toBeGreaterThan(0);
      expect(ms).toBeLessThan(2000);
    } finally { await d.close(); }
  });
});
