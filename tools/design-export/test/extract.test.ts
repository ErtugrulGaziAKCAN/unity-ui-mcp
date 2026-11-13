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
      try { expect((await lint(d, kit)).map((x) => `${f} ${x.ruleId} ${x.path}: ${x.detail}`)).toEqual([]); } finally { await d.close(); }
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

  it("records inherited text properties on text nodes, except those an ancestor's pseudo-state changes", () => {
    const t = byId(r.ir.root, "title").style.base;
    expect(t).toMatchObject({ color: "#ffffff", "font-family": '"Inter UI"', "font-weight": "400" });
    expect(t["font-size"]).toMatch(/^16\.51\d*px$/);
    const label = byId(r.ir.root, "play").children[0];
    expect(label.style.base["text-align"]).toBe("center");
    expect(label.style.base.color).toBeUndefined(); // .btn:hover changes it: inherited in USS too
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
    expect(logo.asset).toEqual({ kind: "image", file: `assets/${sha}.png`, sha256: sha, width: 1, height: 1, slice: null });
    expect(fs.readFileSync(path.join(r.outDir, logo.asset!.file))).toEqual(fs.readFileSync(fx("assets/logo.png")));
    expect(logo.style.base).toMatchObject({ width: "64px", height: "32px", "overflow-x": "clip", "overflow-y": "clip" });
    const bg = byId(r.ir.root, "bg");
    expect(bg.kind).toBe("image");
    expect(bg.asset!.file).toBe(`assets/${sha}.png`);
  });

  it("serialises inline svg with currentColor resolved", () => {
    const icon = byId(r.ir.root, "icon");
    expect(icon.kind).toBe("vector");
    expect(icon.children).toEqual([]);
    expect(icon.asset!.kind).toBe("svg");
    expect([icon.asset!.width, icon.asset!.height]).toEqual([24, 24]);
    const svg = fs.readFileSync(path.join(r.outDir, icon.asset!.file), "utf8");
    expect(icon.asset!.file).toBe(`assets/${crypto.createHash("sha256").update(svg).digest("hex")}.svg`);
    expect(svg).not.toMatch(/currentcolor/i);
    expect(svg).toContain("rgb(22, 194, 213)");
    expect(svg).toContain("stroke-width: 2");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
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
    expect(t("pseudo:hover", "enter")).toEqual([["transition", "background-color", 200, 50, "cubic-bezier(0.4, 0, 0.2, 1)"]]);
    expect(t("pseudo:hover", "leave")).toEqual([["transition", "background-color", 200, 50, "cubic-bezier(0.4, 0, 0.2, 1)"]]);
    expect(t("pseudo:active", "enter")).toEqual([["transition", "opacity", 100, 0, "linear"]]);
    expect(t("pseudo:active", "leave")).toEqual([["transition", "opacity", 300, 0, "steps(4)"]]);
    expect(btn.anims.every((a) => a.name === null && a.iterations === 1 && a.keyframes.length === 0)).toBe(true);
  });

  it("records keyframe animations with offsets, segment easing, iterations, direction and fill", () => {
    const spin = byId(r.ir.root, "spin");
    const show = spin.anims.filter((a) => a.trigger === "show");
    expect(show).toEqual([{
      kind: "keyframes", trigger: "show", phase: "enter", name: "spin", properties: ["rotate"], duration: 1000, delay: 200,
      timing: "ease-in", iterations: "infinite", direction: "alternate", fillMode: "both", playState: "running",
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

describe("buildIr: rejections", () => {
  const write = (css: string, body: string) => {
    const dir = tmp();
    const p = path.join(dir, "s.html");
    fs.writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}
      .screen{display:flex;flex-direction:column;width:2560px;height:1440px;font-family:"Inter UI";font-size:16.515625px;line-height:20px;color:#ffffff}
      p{margin:0}${css}</style></head><body><div class="screen" data-u-screen="s">${body}</div></body></html>`);
    return p;
  };
  it("rejects a pseudo-class on an ancestor and combined layers, naming the rule", async () => {
    await expect(build(write(".card:hover .t{color:#16c2d5}", '<div class="card" data-u-id="card"><p class="t" data-l10n="s.t" data-en="T">T</p></div>')))
      .rejects.toThrow(/\.card:hover \.t/);
    await expect(build(write(".state-loading .x:hover{opacity:0.5}", '<div class="x" data-u-id="x"></div>')))
      .rejects.toThrow(/state:loading.*hover|hover.*state:loading/);
  });
});

describe("buildIr: speed (R22)", () => {
  it("extracts a 600-node screen from the lint snapshot quickly", async () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      `<div class="row" data-u-id="row-${i}"><p data-u-id="name-${i}" data-u-bind="name-${i}">Oyuncu ${i}</p>` +
      `<p data-l10n="big.role" data-en="Role">Rol <b>A</b></p><div class="dot"></div></div>`).join("\n");
    const p = path.join(tmp(), "big.html");
    fs.writeFileSync(p, `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}
      .screen{display:flex;flex-direction:column;width:2560px;height:1440px;overflow:hidden;font-family:"Inter UI";font-size:16.515625px;line-height:20px;color:#ffffff;background-color:#0b1f26}
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
