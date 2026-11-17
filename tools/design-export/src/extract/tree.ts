/**
 * DOM → IR extraction (spec §7). Reads the lint snapshot (no second CDP walk), plus one page call (child order
 * and rendered text, serialised inline SVGs, image sizes), layer boxes where radii or transforms need them, and CDP
 * attributesStyle for the few elements with presentational attributes.
 *
 * Style layers record what the design specifies, as Chromium expands it into longhands, plus browser defaults that
 * render and presentational attributes (img/svg width and height, hidden):
 * - layer keys are described in layers.ts; each layer holds what wins (CSS cascade with !important and specificity)
 *   when exactly its dimensions hold, and co-active layers that set one property also get their union;
 * - var() is resolved per layer (custom properties redefined in a layer), rem becomes px, colours are #rrggbb or
 *   rgba(), CSS-wide keywords are concrete, url() backgrounds point at assets/<sha256>;
 * - transition-* and animation-* go to `anims` only (the animation player owns them, §11); properties with no effect in UI Toolkit and shorthand
 *   residue at initial values are left out; transform is split into translate/rotate/scale; radii are px per corner for the layer's box
 *   (findings R1, overlapping-curves rule); borders without a style are removed; display is explicit in every base layer; CSS initial values
 *   that render differently in USS are written (O-6);
 * - text nodes carry the inherited text properties and the layers that change them, and the matched kit
 *   text style (§5.3 text styles); tintable SVGs carry `color` the same way.
 */
import path from "node:path";
import type { Page } from "playwright";
import { sharedBakePage } from "../bake/shadow.js";
import { IR_VERSION, type IrAnim, type IrAsset, type IrNode, type IrScreen, type NodeKind } from "../ir/types.js";
import { validateIr } from "../ir/validate.js";
import type { KitConfig } from "../kit.js";
import { kitScales, wholeBorderWidths } from "../lint/rules/U-CSS-040.js";
import { DESIGN_ORIGIN, type LoadedDesign } from "../load.js";
import { firstFamily, px } from "../lint/css-values.js";
import { kitFonts, realFaces } from "../lint/fonts.js";
import { designChildren, describeAt, HIDDEN_ITEM_FIX, hiddenItems, itemChildren, markupHidden, repeatIssues, repeatSamples, repeatTemplate, sampleHidden } from "../lint/repeat.js";
import { nonDesign } from "../lint/rules/util.js";
import { annotateTextStyles, expandShorthands, rendersText, type DomSnapshot } from "../lint/snapshot.js";
import { isRichInline, isTextElement, runPlans, type RunPlan } from "../lint/text-runs.js";
import { readTextStyles } from "../lint/text-styles.js";
import { animsOf, inheritedAnims, mergeAnims } from "./anims.js";
import { backgroundUrl, collectPageData, fileSha, hasPresentational, measureLayerBoxes, pinViewBox, presentationalStyles, readImageUrl, svgSize, writeAsset } from "./assets.js";
import { hasEffects, nodeEffects } from "./effects.js";
import { classifyKind, isScroll } from "./kind.js";
import { dimsOf } from "./layers.js";
import { structuralId, tokenKey, uniqueId } from "./naming.js";
import { normalizeColor, resolveTextShadowColour, StyleExtractor, TEXT_INHERITED, toStyleLayers, type Layers, type StyleContext } from "./styles.js";
import { attrTexts, irText, plainText, sequencesNeeded } from "./text.js";

export { repeatSamples };

/**
 * Sample values of the design (verification only): bind and Smart String argument names → text, an image bind's name
 * → `{ $image }` (ImageSample), repeat name → one object per item. Per item, by template element id: `$classes` the
 * is-* classes that item shows, `$states` its controls' disabled/checked where they differ from the template's (the
 * states that are on), `$hidden` true for an element its own markup hides (hidden attribute, inline display: none) in
 * this item and shows in another: that hiding is sample data, the template compiles shown (`itemVisibility`) and the
 * item view shows or hides it.
 */
export interface SampleData { [name: string]: string | ImageSample | SampleData[] | Record<string, string[]> | Record<string, boolean> }
/** An image file of the export (`assets/<sha256>.<ext>`) with the fields of an IR node's asset. */
export interface SampleImage { file: string; sha256: string; width: number; height: number }
/**
 * The sample of an image bind (an `<img data-u-bind>`, or an element painted only by a bound url() image): the image
 * that item shows, written to assets/ like the IR's own; null when it shows none (no source, or hidden by the item's
 * markup). The Unity capture assigns it as the generated view's `Set<Name>(Background)` does; null clears the image.
 */
export interface ImageSample { $image: SampleImage | null }
/** `elements`: IR id → index of its DOM element in document order (`[body, ...body.querySelectorAll("*")]`), for captures. */
export interface IrBuild { ir: IrScreen; fixtures: SampleData; timings: Record<string, number>; elements: Record<string, number> }

interface Plan {
  i: number; kind: NodeKind; external: boolean; repeat: IrNode["repeat"]; children: Plan[];
  id: string; run: RunPlan | null; promoted: boolean; inTemplate: boolean;
}

const LEAF: ReadonlySet<NodeKind> = new Set(["text", "image", "vector", "input", "dropdown", "toggle"]);
const CONTROLS = new Set(["button", "input", "select", "textarea"]);
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
/** Properties that never change an element's box (or its descendants'): a layer of only these keeps the base box. */
const paintOnly = (p: string) => /^(color|opacity|visibility|cursor|pointer-events|z-index|box-shadow|text-shadow|transform|translate|rotate|scale|transform-origin|background-.+|border-.+-(color|radius)|outline-.+|text-decoration-.+|transition-.+|animation-.+|-webkit-.+)$/.test(p);

export interface BuildOptions {
  /** The bake page (openBakePage); default: the design browser's shared bake page, so every screen of a run shares its cache. */
  bakePage?: Page;
}

export async function buildIr(d: LoadedDesign, s: DomSnapshot, kit: KitConfig, outDir: string, htmlPath: string, opts: BuildOptions = {}): Promise<IrBuild> {
  return build(d, s, kit, outDir, htmlPath, async () => opts.bakePage ?? sharedBakePage(d.browser));
}

async function build(d: LoadedDesign, s: DomSnapshot, kit: KitConfig, outDir: string, htmlPath: string, bakePage: () => Promise<Page>): Promise<IrBuild> {
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  let t = t0;
  const lap = (k: string) => { const n = performance.now(); timings[k] = Math.round((n - t) * 10) / 10; t = n; };

  if (!s.elements.some((e) => e.textStyle !== undefined) && s.elements.some(rendersText)) annotateTextStyles(s, kit);
  // outer shadow images reach out from their box by multiples of the step that is whole at every viewport scale
  const grid = wholeBorderWidths(kitScales(kit).map((x) => x.scale), 1)[0] ?? 1;
  const root = s.elements.findIndex((e) => e.attrs["data-u-screen"] !== undefined);
  if (root < 0) throw new Error("no element with data-u-screen");
  const el = (i: number) => s.elements[i];
  // a written-out item its own markup hides: the repeat alone shows and hides its items (lint U-MRK-013)
  const hidden = hiddenItems(s);
  if (hidden.length) throw new Error(`${hidden.map((h) => h.detail).join("; ")}: ${HIDDEN_ITEM_FIX}`);

  // ---- 1. tree plan: kinds, keyed text runs, repeats (template only), ids ------------------------------------
  const plan = (i: number, inScroll: boolean, inTemplate: boolean, promoted: boolean): Plan => {
    const e = el(i);
    const external = e.attrs["data-u-external"] !== undefined;
    const run = external ? null : runPlans(s).get(i) ?? null;
    if (run?.kind === "error") throw new Error(`${describeAt(s, i)}: ${run.detail}`);
    const kind: NodeKind = external ? "container" : run ? (e.ns === "html" && e.tag === "button" ? "button" : "container") : classifyKind(e, s);
    const p: Plan = { i, kind, external, repeat: null, children: [], id: "", run, promoted, inTemplate };
    const scroll = inScroll || isScroll(e);
    if (external) return p;
    if (run) {
      p.children = (run.kind === "single" ? [run.child] : run.children).map((k) => plan(k, scroll, inTemplate, true));
      return p;
    }
    if (LEAF.has(kind) || (kind === "button" && isTextElement(s, e))) return p;
    const tpl = repeatTemplate(s, e);
    if (tpl === undefined) { p.children = designChildren(s, e).map((k) => plan(k, scroll, inTemplate, false)); return p; }
    const issues = repeatIssues(s, i);
    if (issues.length) throw new Error(issues.join("; "));
    const m = el(tpl).attrs["data-u-repeat-mode"] as "list" | "inline" | undefined;
    const mode = m ?? (scroll ? "list" : "inline");
    p.repeat = { name: el(tpl).attrs["data-u-repeat"], mode, count: repeatSamples(s, tpl).length };
    if (mode === "list") p.kind = "list";
    p.children = [plan(tpl, scroll, true, false)];
    return p;
  };
  const tree = plan(root, false, false, false);
  const plans: Plan[] = [];
  const walk = (p: Plan) => { plans.push(p); p.children.forEach(walk); };
  walk(tree);
  // ids: authored data-u-id, else structural (a collision with an authored id gets a suffix)
  const taken = new Set(plans.map((p) => el(p.i).attrs["data-u-id"]).filter((x): x is string => !!x));
  const ids = new Map<number, string>();
  const assign = (p: Plan, id: string) => {
    p.id = id; ids.set(p.i, id); taken.add(id);
    p.children.forEach((c, k) => assign(c, el(c.i).attrs["data-u-id"] ?? uniqueId(structuralId(id, k), taken)));
  };
  assign(tree, el(root).attrs["data-u-id"] ?? "root");
  const indexOfId = new Map<string, number>();
  for (const p of plans) if (!indexOfId.has(p.id)) indexOfId.set(p.id, p.i);
  const textual = (p: Plan) => p.kind === "text" || p.kind === "input" || p.kind === "dropdown" || (p.kind === "button" && !p.run && isTextElement(s, el(p.i)));
  // markup hiding that varies across a repeat's written-out items is sample data: the template compiles shown, with the
  // box of a copy that shows it standing in where its markup hides it (the template element and its descendants)
  const sampled = sampleHidden(s);
  const markupSample = new Set(sampled.values());
  const shownCopies = new Map<number, number>();
  const pairCopies = (t: number, x: number) => {
    shownCopies.set(t, x);
    const kt = itemChildren(s, el(t)), kx = itemChildren(s, el(x));
    kt.forEach((k, n) => { if (kx[n] !== undefined) pairCopies(k, kx[n]); });
  };
  for (const [x, t] of sampled) if (!shownCopies.has(t) && markupHidden(s, t) && el(x).rendered && el(x).size) pairCopies(t, x);
  lap("plan");

  // ---- 2. presentational attributes (CDP, only where present), cascade --------------------------------------
  const docUrl = `${DESIGN_ORIGIN}/${encodeURIComponent(path.basename(htmlPath))}`;
  const ctx: StyleContext = { ids, docUrl, markupSample, shownCopies };
  ctx.presentational = await presentationalStyles(d.cdp, s, plans.filter((p) => hasPresentational(el(p.i).attrs)).map((p) => p.i));
  lap("cdp");
  let ex = new StyleExtractor(s, ctx);
  for (const p of plans) ex.raw(p.i);
  // shorthands that use custom properties redefined in a layer: Chromium expands them with the layer's values,
  // then the cascade runs again with those longhands (a nested variable can ask for one more round)
  for (let round = 0; ex.missingExpansions.size && round < 4; round++) {
    const items = Array.from(ex.missingExpansions.values());
    const got = await expandShorthands(d.page, items);
    ctx.expansions = new Map([...(ctx.expansions ?? []), ...items.map((x, k) => [`${x.name}\u0000${x.value}`, got[k]] as const)]);
    ex = new StyleExtractor(s, ctx);
    for (const p of plans) ex.raw(p.i);
  }
  const states = new Set(ex.states);
  for (const p of plans) { const st = el(p.i).attrs["data-u-state"]; if (st) states.add(st); }
  states.delete("default");
  const stateList = Array.from(states).sort();
  lap("cascade");

  // ---- 3. layer boxes for radii and transforms -------------------------------------------------------------------
  const requests = new Map<string, number[]>();
  const ask = (key: string, i: number) => requests.set(key, [...(requests.get(key) ?? []), i]);
  // a layer made only of the element's own (or a named ancestor's) pseudo-states and classes changes the box only when
  // those layers set something other than paint
  const changesBox = (i: number, key: string) => {
    const dims = dimsOf(key);
    if (dims.some((x) => x.startsWith("state:") || x.startsWith("bp:"))) return true;
    const props = (j: number, within: string[]) => Array.from(ex.raw(j)).filter(([k]) => k !== "base" && dimsOf(k).every((x) => within.includes(x))).flatMap(([, m]) => Array.from(m.keys()));
    if (props(i, dims).some((q) => !paintOnly(q))) return true;
    for (const x of dims.filter((d) => d.startsWith("anc("))) {
      const m = /^anc\(([^)]+)\):(.+)$/.exec(x)!;
      const a = indexOfId.get(m[1]);
      if (a === undefined || props(a, [m[2]]).some((q) => !paintOnly(q))) return true;
    }
    return false;
  };
  for (const p of plans) {
    if (!ex.needsBoxes(p.i) && !hasEffects(ex, p.i)) continue;
    for (const key of ex.raw(p.i).keys()) if (key !== "base" && changesBox(p.i, key)) ask(key, p.i);
    if (!el(p.i).size) for (const st of stateList) if (!requests.get(`state:${st}`)?.includes(p.i)) ask(`state:${st}`, p.i);
  }
  ctx.boxes = await measureLayerBoxes(d, s, root, requests, indexOfId, ex.breakpoints);
  lap("boxes");

  // ---- 4. one page call: text order and rendering, SVGs, images ---------------------------------------------
  const valueEls: number[] = [];
  for (let i = root; i < s.elements.length; i++) {
    const a = el(i).attrs;
    if (a["data-u-bind"] !== undefined || a["data-u-arg"] !== undefined) valueEls.push(i);
  }
  const textEls = plans.filter(textual).map((p) => p.i);
  // the IR's template of each repeat (the first item of its first container): every written-out item, in whichever
  // container, is recorded by the ids of the template element at the same place (a nested repeat's later containers
  // hold items that are not in the IR)
  const irTemplate = new Map<string, number>();
  for (const p of plans) { const name = el(p.i).attrs["data-u-repeat"]; if (name !== undefined && !irTemplate.has(name)) irTemplate.set(name, p.i); }
  // image binds: a bound element whose IR element (itself, or the one at its place in its repeat's template item) is an
  // image; every written-out item's image is sample data, read from the page like the IR's own
  const irElementOf = new Map<number, number>();
  const pairItem = (x: number, t: number) => {
    irElementOf.set(x, t);
    const kx = itemChildren(s, el(x)), kt = itemChildren(s, el(t));
    kx.forEach((k, n) => { if (kt[n] !== undefined && el(k).attrs["data-u-repeat"] === undefined) pairItem(k, kt[n]); });
  };
  for (const e of s.elements) {
    const name = e.attrs["data-u-repeat"];
    const t = name === undefined || nonDesign(s)[e.index] ? undefined : irTemplate.get(name);
    if (t !== undefined) for (const x of repeatSamples(s, e.index)) pairItem(x, t);
  }
  const kindOf = new Map(plans.map((p) => [p.i, p.kind] as const));
  const imageBinds = new Set(valueEls.filter((i) => el(i).attrs["data-u-bind"] !== undefined && kindOf.get(irElementOf.get(i) ?? i) === "image"));
  const vectors = plans.filter((p) => p.kind === "vector");
  for (const p of vectors) if (el(p.i).svgPaint === "mixed") throw new Error(`${describeAt(s, p.i)}: the inline SVG paints some shapes with currentColor and others with fixed colours`);
  const urlsOf = (value: string, base: string | undefined) => Array.from(value.matchAll(URL_RE), (m) => new URL((m[1] ?? m[2] ?? m[3]).trim(), base ?? docUrl).href);
  const bgUrls = new Set<string>();
  for (const p of plans) {
    for (const layer of ex.raw(p.i).values()) { const en = layer.get("background-image"); if (en) urlsOf(en.value, en.base).forEach((u) => bgUrls.add(u)); }
    if (p.kind === "image" && el(p.i).tag !== "img") { const u = backgroundUrl(el(p.i).computed["background-image"]); if (u) bgUrls.add(u); }
  }
  for (const i of imageBinds) if (el(i).tag !== "img") { const u = backgroundUrl(el(i).computed["background-image"]); if (u) bgUrls.add(u); }
  const imgs = new Set([...plans.filter((p) => p.kind === "image" && el(p.i).tag === "img").map((p) => p.i), ...Array.from(imageBinds).filter((i) => el(i).tag === "img")]);
  const page = await collectPageData(d.page, {
    seqs: sequencesNeeded(s, [...textEls, ...valueEls]),
    texts: Array.from(new Set([...textEls, ...valueEls])).sort((a, b) => a - b),
    svgs: vectors.map((p) => ({ i: p.i, tint: el(p.i).svgPaint === "current" })),
    imgs: Array.from(imgs).sort((a, b) => a - b),
    bgUrls: Array.from(bgUrls).sort(), root, states: stateList,
  });
  lap("page");

  // ---- 5. nodes ---------------------------------------------------------------------------------------------
  const styles = readTextStyles(kit);
  const refs = new Set<string>();
  const designDir = path.dirname(path.resolve(htmlPath));
  const clone = (l: Layers): Layers => new Map(Array.from(l, ([k, m]) => [k, new Map(m)]));
  const urlAsset = (abs: string): IrAsset => {
    const { bytes, ext } = readImageUrl(abs, designDir, kit);
    const size = page.bgs.get(abs) ?? { w: 1, h: 1 };
    return ext === "svg" ? writeAsset(outDir, Buffer.from(pinViewBox(bytes.toString("utf8")), "utf8"), ext, "svg", size.w, size.h)
      : writeAsset(outDir, bytes, ext, "image", size.w, size.h);
  };
  /** The image an element draws (an `<img>`'s source, else its url() background image), written to assets/; null without one. */
  const imageAsset = (i: number): IrAsset | null => {
    const e = el(i);
    if (e.tag !== "img") { const u = backgroundUrl(e.computed["background-image"]); return u ? urlAsset(u) : null; }
    const img = page.imgs.get(i);
    if (!img?.src) return null;
    const { bytes, ext } = readImageUrl(img.src, designDir, kit);
    return ext === "svg" ? writeAsset(outDir, Buffer.from(pinViewBox(bytes.toString("utf8")), "utf8"), ext, "svg", img.w, img.h)
      : writeAsset(outDir, bytes, ext, "image", img.w, img.h);
  };
  const assetOf = (p: Plan): IrNode["asset"] => {
    const e = el(p.i);
    if (p.kind === "vector") {
      const xml = page.svgs.get(p.i)!;
      const sz = svgSize(xml, e.size);
      return writeAsset(outDir, Buffer.from(pinViewBox(xml), "utf8"), "svg", "svg", sz.w, sz.h, e.svgPaint === "current");
    }
    if (p.kind !== "image") return null;
    const asset = imageAsset(p.i);
    if (!asset) throw new Error(`${e.path}: image without a source${p.inTemplate ? " (the first written-out item of a repeat is its template and needs one; a later item may show none)" : ""}`);
    return asset;
  };
  const nodeAnims = new Map<number, IrAnim[]>();
  let bakeMs = 0;
  const node = async (p: Plan): Promise<IrNode> => {
    const e = el(p.i);
    const layers = clone(ex.layers(p.i));
    const base = layers.get("base")!;
    if (p.run?.kind === "row") {
      for (const [k, v] of [["display", "flex"], ["flex-direction", "row"], ["justify-content", p.run.justify], ["align-items", "flex-start"]]) base.set(k, { value: v, refs: [] });
    }
    // a keyed run in a row is a flex item; one alone in its paragraph becomes a block only where that renders the same
    if (p.promoted && (runPlans(s).get(e.parent)?.kind === "row" || ex.promotesToBlock(p.i))) base.set("display", { value: "block", refs: [] });
    const text = textual(p) ? irText(s, p.i, page.seqs, styles, page.rendered) : null;
    const tint = p.kind === "vector" && e.svgPaint === "current";
    const copies = text ? ex.addInherited(p.i, layers, TEXT_INHERITED) : tint ? ex.addInherited(p.i, layers, ["color"]) : [];
    resolveTextShadowColour(layers, normalizeColor(e.computed.color ?? "#000000"));
    // url() backgrounds → assets (the layers keep them, with their size, repeat and position)
    for (const layer of layers.values()) {
      const en = layer.get("background-image");
      if (!en || !/url\(/i.test(en.value)) continue;
      layer.set("background-image", { ...en, value: en.value.replace(URL_RE, (m, a?: string, b?: string, c?: string) => `url("${urlAsset(new URL((a ?? b ?? c ?? "").trim(), en.base ?? docUrl).href).file}")`) });
    }
    // shadows and background images per layer: baked shadows and gradients, url() assets; box-shadow and gradients
    // leave the style layers (a background-image of only url() and none stays for the compiler's background geometry)
    const tb = performance.now();
    const fx = await nodeEffects(p.i, {
      ex, page: bakePage, outDir, boxes: ctx.boxes, urlAsset, urls: urlsOf, computedColor: e.computed.color ?? "#000000",
      fontSize: px(e.computed["font-size"]) ?? undefined, rootFontSize: s.rootFontSize, grid,
    }, describeAt(s, p.i));
    bakeMs += performance.now() - tb;
    // an element painted only by a url() image: that image is its content asset (an <img> keeps its background)
    if (p.kind === "image" && e.tag !== "img") { fx.background = null; fx.backgroundLayers = {}; }
    // with a gradient, the layers' images are the baked effect layers; a url() image stays in its style layer, so the
    // compiler sees (and rejects, like lint U-CSS-037) a url() image combined with a gradient
    const gradient = Array.from(layers.values()).some((m) => /gradient\(/i.test(m.get("background-image")?.value ?? ""));
    for (const [key, m] of layers) {
      m.delete("box-shadow");
      if (gradient && !/^url\(/i.test(m.get("background-image")?.value.trim() ?? "")) m.delete("background-image");
      if (key !== "base" && m.size === 0) layers.delete(key);
    }
    for (const m of layers.values()) for (const en of m.values()) en.refs.forEach((r) => refs.add(r));
    let anims = animsOf(ex, p.i, ex.raw(p.i), layers, refs);
    for (const c of copies) anims.push(...inheritedAnims(nodeAnims.get(c.from) ?? [], c.prop, c.fromKey, c.key));
    anims = mergeAnims(anims);
    nodeAnims.set(p.i, anims);
    const classes = Array.from(new Set((e.attrs.class ?? "").split(/\s+/).filter((c) => c && !/^state-/.test(c) && !(p.inTemplate && /^is-/.test(c)))));
    const control = e.ns === "html" && CONTROLS.has(e.tag);
    const toggle = e.tag === "input" && /^(checkbox|radio)$/i.test(e.attrs.type ?? "");
    return {
      id: p.id, kind: p.kind, external: p.external, classes, style: toStyleLayers(layers), text, attrTexts: attrTexts(e),
      initial: control ? { disabled: e.attrs.disabled !== undefined, checked: toggle && e.attrs.checked !== undefined } : null,
      ...(markupSample.has(p.i) ? { itemVisibility: true } : {}),
      ...(p.kind === "input" ? { field: {
        password: e.tag === "input" && (e.attrs.type ?? "").toLowerCase() === "password", multiline: e.tag === "textarea",
        placeholderColor: e.pseudo.placeholder?.color ? normalizeColor(e.pseudo.placeholder.color) : null,
      } } : {}),
      asset: assetOf(p), ...fx,
      bind: e.attrs["data-u-bind"] ?? null, action: e.attrs["data-u-action"] ?? null, repeat: p.repeat, anims,
      children: await sequential(p.children, node),
    };
  };
  const rootNode = await node(tree);
  lap("nodes");
  timings.bake = Math.round(bakeMs * 10) / 10;

  // ---- 6. fixtures, fonts, tokens -----------------------------------------------------------------------------
  const sample = (i: number) => (el(i).tag === "select" ? irText(s, i, page.seqs, styles, page.rendered)?.ref ?? "" : plainText(s, i, page.seqs, page.rendered));
  // an image bind's sample: the image its item shows; none when it has no source or the item's markup hides it (or an
  // element around it) as sample data
  const hiddenInItem = (i: number) => {
    for (let a = i; a >= 0; a = el(a).parent) if (sampled.has(a) && markupHidden(s, a)) return true;
    return false;
  };
  const imageSample = (i: number): ImageSample => {
    const a = hiddenInItem(i) ? null : imageAsset(i);
    return { $image: a && { file: a.file, sha256: a.sha256, width: a.width, height: a.height } };
  };
  const isClasses = (i: number) => (el(i).attrs.class ?? "").split(/\s+/).filter((c) => /^is-./.test(c));
  // what an item's own markup sets on a control: disabled and checked (an IR node's `initial` holds the template's)
  const controlStates = (i: number): string[] | null => {
    const e = el(i);
    if (e.ns !== "html" || !CONTROLS.has(e.tag)) return null;
    const toggle = e.tag === "input" && /^(checkbox|radio)$/i.test(e.attrs.type ?? "");
    return [...(e.attrs.disabled !== undefined ? ["disabled"] : []), ...(toggle && e.attrs.checked !== undefined ? ["checked"] : [])];
  };
  interface ItemState { classes: Record<string, string[]>; states: Record<string, string[]>; hidden: Record<string, boolean>; empty: string[] }
  // a sample's is-* classes, control states and markup hiding, by the id of the template element at the same place;
  // states only where they differ from the template's (its own markup is the IR's); hiding where it is sample data and
  // this item's markup hides the element (the template compiles shown)
  const itemState = (x: number, tpl: number, out: ItemState) => {
    const id = ids.get(tpl);
    const cls = isClasses(x);
    if (id && cls.length) out.classes[id] = cls;
    const sx = controlStates(x), st = controlStates(tpl);
    if (id && sx && st && sx.join() !== st.join()) out.states[id] = sx;
    if (id && sampled.has(x) && markupHidden(s, x)) out.hidden[id] = true;
    // a nested repeat this later item writes out no item of (lint U-MRK-010 accepts it): its sample data holds none
    const nested = repeatTemplate(s, el(tpl));
    if (nested !== undefined && x !== tpl && designChildren(s, el(x)).length === 0) out.empty.push(el(nested).attrs["data-u-repeat"]);
    const kx = itemChildren(s, el(x)), kt = itemChildren(s, el(tpl));
    kx.forEach((k, n) => { if (kt[n] !== undefined && el(k).attrs["data-u-repeat"] === undefined) itemState(k, kt[n], out); });
  };
  const fixtures: SampleData = {};
  const collect = (i: number, out: SampleData) => {
    if (nonDesign(s)[i]) return;
    const e = el(i);
    for (const a of ["data-u-bind", "data-u-arg"]) {
      const name = e.attrs[a];
      if (name !== undefined && !(name in out)) out[name] = a === "data-u-bind" && imageBinds.has(i) ? imageSample(i) : sample(i);
    }
    if (e.attrs["data-u-external"] !== undefined) return;
    for (let k = 0; k < e.children.length; k++) {
      const c = e.children[k];
      const name = el(c).attrs["data-u-repeat"];
      if (name === undefined) { collect(c, out); continue; }
      const samples = repeatSamples(s, c);
      const tpl = irTemplate.get(name) ?? c;
      out[name] = samples.map((x) => {
        const o: SampleData = {};
        collect(x, o);
        const st: ItemState = { classes: {}, states: {}, hidden: {}, empty: [] };
        itemState(x, tpl, st);
        for (const name of st.empty) o[name] = [];
        if (Object.keys(st.classes).length) o.$classes = st.classes;
        if (Object.keys(st.states).length) o.$states = st.states;
        if (Object.keys(st.hidden).length) o.$hidden = st.hidden;
        return o;
      });
      k += samples.length - 1;
    }
  };
  collect(root, fixtures);

  const kf = kitFonts(kit, s.fontFaces);
  const fonts = new Map<string, IrScreen["fonts"][number]>();
  const shaCache = new Map<string, string>();
  const addFace = (locale: string, familyLower: string, weight: number, italic: boolean) => {
    for (const f of realFaces(kf.faces.get(familyLower), weight, italic)) {
      if (!f.file) continue;
      const file = path.relative(kit.dir, f.file).split(path.sep).join("/");
      if (!shaCache.has(f.file)) shaCache.set(f.file, fileSha(f.file));
      fonts.set(`${locale}\u0000${f.family}\u0000${weight}\u0000${file}`, { locale, family: f.family, file, sha256: shaCache.get(f.file)!, weight });
    }
  };
  const fontEls = new Set<number>();
  const richWalk = (i: number) => { fontEls.add(i); for (const c of el(i).children) if (isRichInline(s, el(c))) richWalk(c); };
  for (const p of plans) if (textual(p)) richWalk(p.i);
  for (const i of fontEls) {
    const e = el(i);
    const fam = firstFamily(e.computed["font-family"] ?? "").toLowerCase();
    const weight = Number(e.computed["font-weight"]) || 400, italic = /italic|oblique/.test(e.computed["font-style"] ?? "");
    if (!kf.faces.has(fam)) continue;
    addFace(kf.referenceLocale, fam, weight, italic);
    for (const o of kf.otherLocales) if (o.families[0]) addFace(o.locale, o.families[0], weight, italic);
  }
  const fontList = Array.from(fonts.values()).sort((a, b) =>
    a.locale.localeCompare(b.locale, "en") || a.family.localeCompare(b.family, "en") || a.weight - b.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const kitTokens = new Set(s.rules.filter((r) => r.kit).flatMap((r) => r.decls.filter((x) => x.name.startsWith("--")).map((x) => x.name)));
  const tokens: Record<string, string> = {};
  for (const r of Array.from(refs).sort()) {
    const v = (s.rootVars[r] ?? "").trim();
    if (kitTokens.has(r) && v) tokens[tokenKey(r)] = v;
  }

  const ir: IrScreen = {
    irVersion: IR_VERSION,
    screen: el(root).attrs["data-u-screen"],
    source: { path: path.basename(htmlPath), sha256: fileSha(htmlPath) },
    referenceViewport: [kit.reference[0], kit.reference[1]],
    viewports: kit.viewports.map((v) => [v[0], v[1]] as [number, number]),
    ...(kit.scaledViewports?.length ? { scaledViewports: kit.scaledViewports.map((v) => [v[0], v[1]] as [number, number]) } : {}),
    screenMatch: kit.screenMatch,
    states: ["default", ...stateList],
    breakpoints: Array.from(ex.breakpoints.values()).filter((b) => plans.some((p) => Array.from(ex.raw(p.i).keys()).some((k) => k.split("+").includes(`bp:${b.name}`))))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
    tokens,
    fonts: fontList,
    root: rootNode,
  };
  const errors = validateIr(ir);
  if (errors.length) throw new Error(`extracted IR does not match the IR schema: ${errors.join("; ")}`);
  lap("finish");
  timings.total = Math.round((performance.now() - t0) * 10) / 10;
  const elements: Record<string, number> = {};
  for (const p of plans) elements[p.id] = p.i;
  return { ir, fixtures, timings, elements };
}

/** Maps in order, one at a time (bakes share one page; asset writes stay in document order). */
async function sequential<T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const x of items) out.push(await fn(x));
  return out;
}
