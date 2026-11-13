/**
 * DOM → IR extraction (plan Task 8). Reads the lint snapshot (no second CDP walk), plus one page call (child order of
 * text, serialised inline SVGs, image sizes, element sizes per screen state) and CDP attributesStyle for the few
 * elements with presentational attributes.
 *
 * Style layers record what the design specifies, as Chromium expands it into longhands, plus browser defaults that
 * render (R35) and presentational attributes (R36):
 * - a layer (hover…, state:<n>, bp:<n>, class:<is-*>) holds what wins when only it and base apply (CSS cascade with
 *   !important and specificity); var() is resolved, rem becomes px, colours are #rrggbb or rgba();
 * - transition-* and animation-* go to `anims` only (R34); properties with no effect in UI Toolkit and shorthand
 *   residue at initial values are left out; transform is split into translate/rotate/scale (R32); border radii are one
 *   px value per corner for the layer's box (R24/R26); borders without a style are removed; `display` is explicit in
 *   every base layer;
 * - text nodes also carry the inherited text properties (R32) and the matched kit text style (R26).
 */
import path from "node:path";
import type { IrAnim, IrNode, IrScreen, NodeKind } from "../ir/types.js";
import { validateIr } from "../ir/validate.js";
import type { KitConfig } from "../kit.js";
import type { LoadedDesign } from "../load.js";
import { firstFamily } from "../lint/css-values.js";
import { kitFonts, realFaces } from "../lint/fonts.js";
import { nonDesign } from "../lint/rules/util.js";
import { annotateTextStyles, rendersText, type DomSnapshot } from "../lint/snapshot.js";
import { readTextStyles } from "../lint/text-styles.js";
import { animsOf } from "./anims.js";
import { backgroundUrl, collectPageData, fileSha, hasPresentational, presentationalStyles, readImageUrl, svgSize, writeAsset } from "./assets.js";
import { classifyKind, compiledChildren, isRichInline, isScroll, isTextElement } from "./kind.js";
import { structuralId, tokenKey } from "./naming.js";
import { StyleExtractor, toStyleLayers, type Layers, type StyleContext } from "./styles.js";
import { irText, plainText, sequencesNeeded } from "./text.js";

/** Sample values of the design: bind name → text, repeat name → one object per item (verification only). */
export interface SampleData { [name: string]: string | SampleData[] }
export interface IrBuild { ir: IrScreen; fixtures: SampleData; timings: Record<string, number> }

interface Plan { i: number; kind: NodeKind; external: boolean; repeat: IrNode["repeat"]; children: Plan[] }

const LEAF: ReadonlySet<NodeKind> = new Set(["text", "image", "vector", "input", "dropdown", "toggle"]);

/** The written-out items of a repeat: the data-u-repeat element and the following siblings with its tag and class (as U-MRK-002). */
export function repeatSamples(s: DomSnapshot, template: number): number[] {
  const t = s.elements[template];
  const sibs = s.elements[t.parent].children;
  const out = [template];
  for (const k of sibs.slice(sibs.indexOf(template) + 1)) {
    const x = s.elements[k];
    if (x.tag !== t.tag || (x.attrs.class ?? "") !== (t.attrs.class ?? "") || x.attrs["data-u-repeat"] !== undefined) break;
    out.push(k);
  }
  return out;
}

export async function buildIr(d: LoadedDesign, s: DomSnapshot, kit: KitConfig, outDir: string, htmlPath: string): Promise<IrBuild> {
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  let t = t0;
  const lap = (k: string) => { const n = performance.now(); timings[k] = Math.round((n - t) * 10) / 10; t = n; };

  if (!s.elements.some((e) => e.textStyle !== undefined) && s.elements.some(rendersText)) annotateTextStyles(s, kit);
  const root = s.elements.findIndex((e) => e.attrs["data-u-screen"] !== undefined);
  if (root < 0) throw new Error("no element with data-u-screen");
  const el = (i: number) => s.elements[i];

  // positional path: data-u-id paths repeat across written-out items
  const posPath = (i: number): string => (i === root || el(i).parent < 0 ? el(i).path : `${posPath(el(i).parent)} > ${el(i).tag.toLowerCase()}:${el(el(i).parent).children.indexOf(i)}`);
  const describe = (i: number) => `${el(i).path} (${posPath(i)})`;

  // ---- 1. tree plan: kinds, repeats (template only), structure checks ------------------------------------
  const itemChildren = (i: number): number[] => {
    const kids = compiledChildren(s, el(i));
    const tpl = kids.find((k) => el(k).attrs["data-u-repeat"] !== undefined);
    if (tpl === undefined) return kids;
    const samples = new Set(repeatSamples(s, tpl).slice(1));
    return kids.filter((k) => !samples.has(k));
  };
  const IDENTITY = ["data-u-id", "data-u-bind", "data-u-action", "data-l10n", "data-u-repeat", "data-u-repeat-mode", "data-u-external"];
  const cls = (i: number) => (el(i).attrs.class ?? "").split(/\s+/).filter((c) => c && !/^is-/.test(c)).sort().join(" ");
  const diff = (a: number, b: number, item = false): string | null => {
    const x = el(a), y = el(b);
    if (x.tag !== y.tag || x.ns !== y.ns) return `<${x.tag}> at ${posPath(a)} vs <${y.tag}> at ${posPath(b)}`;
    if (cls(a) !== cls(b)) return `class "${cls(a)}" at ${posPath(a)} vs "${cls(b)}" at ${posPath(b)}`;
    // the items themselves differ by the template's data-u-repeat attributes only
    for (const k of IDENTITY) if (!(item && k.startsWith("data-u-repeat")) && x.attrs[k] !== y.attrs[k]) return `${k} "${x.attrs[k] ?? ""}" at ${posPath(a)} vs "${y.attrs[k] ?? ""}" at ${posPath(b)}`;
    if ((x.texts.length > 0) !== (y.texts.length > 0)) return `text at ${posPath(x.texts.length ? a : b)} only`;
    const ka = itemChildren(a), kb = itemChildren(b);
    if (ka.length !== kb.length) return `${ka.length} child elements at ${posPath(a)} vs ${kb.length} at ${posPath(b)}`;
    for (let j = 0; j < ka.length; j++) { const r = diff(ka[j], kb[j]); if (r) return r; }
    return null;
  };
  const plan = (i: number, inScroll: boolean): Plan => {
    const e = el(i);
    const external = e.attrs["data-u-external"] !== undefined;
    const p: Plan = { i, kind: external ? "container" : classifyKind(e, s), external, repeat: null, children: [] };
    if (external || LEAF.has(p.kind) || (p.kind === "button" && isTextElement(s, e))) return p;
    let kids = compiledChildren(s, e);
    const tpl = kids.find((k) => el(k).attrs["data-u-repeat"] !== undefined);
    if (tpl !== undefined) {
      const name = el(tpl).attrs["data-u-repeat"];
      const samples = repeatSamples(s, tpl);
      const others = kids.filter((k) => !samples.includes(k));
      if (others.length) {
        throw new Error(`data-u-repeat "${name}" in ${describe(i)}: ${others.map(describe).join(", ")} is not one of its items; a repeat container holds only its items (the data-u-repeat element and the following siblings with the same tag and class)`);
      }
      samples.slice(1).forEach((x, k) => {
        const why = diff(tpl, x, true);
        if (why) throw new Error(`data-u-repeat "${name}": item ${k + 2} ${describe(x)} does not share the structure of the template ${describe(tpl)}: ${why}`);
      });
      const m = el(tpl).attrs["data-u-repeat-mode"];
      if (m !== undefined && m !== "list" && m !== "inline") throw new Error(`${describe(tpl)}: data-u-repeat-mode "${m}" is not list or inline`);
      const mode = (m ?? (inScroll || isScroll(e) ? "list" : "inline")) as "list" | "inline";
      p.repeat = { name, mode, count: samples.length };
      if (mode === "list") p.kind = "list";
      kids = [tpl];
    }
    const scroll = inScroll || isScroll(e);
    p.children = kids.map((k) => plan(k, scroll));
    return p;
  };
  const tree = plan(root, false);
  const plans: Plan[] = [];
  const walk = (p: Plan) => { plans.push(p); p.children.forEach(walk); };
  walk(tree);
  const textual = (p: Plan) => p.kind === "text" || p.kind === "input" || p.kind === "dropdown" || (p.kind === "button" && isTextElement(s, el(p.i)));
  lap("plan");

  // ---- 2. presentational attributes (CDP, only where present), cascade --------------------------------------
  const ctx: StyleContext = {};
  ctx.presentational = await presentationalStyles(d.cdp, s, plans.filter((p) => hasPresentational(el(p.i).attrs)).map((p) => p.i));
  lap("cdp");
  const ex = new StyleExtractor(s, ctx);
  for (const p of plans) ex.raw(p.i);
  const states = new Set(ex.states);
  for (const p of plans) { const st = el(p.i).attrs["data-u-state"]; if (st) states.add(st); }
  states.delete("default");
  const stateList = Array.from(states).sort();
  lap("cascade");

  // ---- 3. one page call: text order, SVGs, images, per-state boxes for radii ---------------------------------
  const binds: number[] = [];
  for (let i = root; i < s.elements.length; i++) if (el(i).attrs["data-u-bind"] !== undefined) binds.push(i);
  const images = plans.filter((p) => p.kind === "image");
  const bgUrl = (i: number) => backgroundUrl(el(i).computed["background-image"]);
  const page = await collectPageData(d.page, {
    seqs: sequencesNeeded(s, [...plans.filter(textual).map((p) => p.i), ...binds]),
    svgs: plans.filter((p) => p.kind === "vector").map((p) => p.i),
    imgs: images.filter((p) => el(p.i).tag === "img").map((p) => p.i),
    bgUrls: Array.from(new Set(images.filter((p) => el(p.i).tag !== "img").map((p) => bgUrl(p.i)).filter((u): u is string => !!u))),
    root, states: stateList, boxes: plans.filter((p) => ex.hasRadius(p.i)).map((p) => p.i),
  });
  ctx.stateBoxes = page.stateBoxes;
  lap("page");

  // ---- 4. nodes ---------------------------------------------------------------------------------------------
  const styles = readTextStyles(kit);
  const refs = new Set<string>();
  const designDir = path.dirname(path.resolve(htmlPath));
  const clone = (l: Layers): Layers => new Map(Array.from(l, ([k, m]) => [k, new Map(m)]));
  const assetOf = (p: Plan): IrNode["asset"] => {
    const e = el(p.i);
    if (p.kind === "vector") {
      const xml = page.svgs.get(p.i)!;
      const sz = svgSize(xml, e.size);
      return writeAsset(outDir, Buffer.from(xml, "utf8"), "svg", "svg", sz.w, sz.h);
    }
    if (p.kind !== "image") return null;
    const img = e.tag === "img" ? page.imgs.get(p.i) : null;
    const url = img ? img.src : bgUrl(p.i);
    if (!url) throw new Error(`${e.path}: image without a source`);
    const { bytes, ext } = readImageUrl(url, designDir, kit);
    const size = img ? { w: img.w, h: img.h } : page.bgs.get(url) ?? e.size ?? { w: 1, h: 1 };
    return writeAsset(outDir, bytes, ext, ext === "svg" ? "svg" : "image", size.w, size.h);
  };
  const node = (p: Plan, id: string): IrNode => {
    const e = el(p.i);
    const layers = clone(ex.layers(p.i));
    const text = textual(p) ? irText(s, p.i, page.seqs, styles) : null;
    if (text) ex.addInheritedText(p.i, layers);
    for (const m of layers.values()) for (const en of m.values()) en.refs.forEach((r) => refs.add(r));
    const anims: IrAnim[] = animsOf(s, p.i, ex.raw(p.i), layers, refs);
    const classes = Array.from(new Set((e.attrs.class ?? "").split(/\s+/).filter((c) => c && !/^state-/.test(c))));
    return {
      id, kind: p.kind, external: p.external, classes, style: toStyleLayers(layers), text, asset: assetOf(p), background: null, shadow: null,
      bind: e.attrs["data-u-bind"] ?? null, action: e.attrs["data-u-action"] ?? null, repeat: p.repeat, anims,
      children: p.children.map((c, k) => node(c, el(c.i).attrs["data-u-id"] ?? structuralId(id, k))),
    };
  };
  const rootNode = node(tree, el(root).attrs["data-u-id"] ?? "root");
  lap("nodes");

  // ---- 5. fixtures, fonts, tokens -----------------------------------------------------------------------------
  const fixtures: SampleData = {};
  const collect = (i: number, out: SampleData) => {
    if (nonDesign(s)[i]) return;
    const e = el(i);
    const b = e.attrs["data-u-bind"];
    if (b !== undefined && !(b in out)) out[b] = irTextPlain(i);
    if (e.attrs["data-u-external"] !== undefined) return;
    for (let k = 0; k < e.children.length; k++) {
      const c = e.children[k];
      const name = el(c).attrs["data-u-repeat"];
      if (name === undefined) { collect(c, out); continue; }
      const samples = repeatSamples(s, c);
      out[name] = samples.map((x) => { const o: SampleData = {}; collect(x, o); return o; });
      k += samples.length - 1;
    }
  };
  const irTextPlain = (i: number) => (el(i).tag === "select" ? irText(s, i, page.seqs, styles)?.tr ?? "" : plainText(s, i, page.seqs));
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
  const textEls = new Set<number>();
  const richWalk = (i: number) => { textEls.add(i); for (const c of el(i).children) if (isRichInline(s, el(c))) richWalk(c); };
  for (const p of plans) if (textual(p)) richWalk(p.i);
  for (const i of textEls) {
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
    irVersion: 1,
    screen: el(root).attrs["data-u-screen"],
    source: { path: path.basename(htmlPath), sha256: fileSha(htmlPath) },
    referenceViewport: [kit.reference[0], kit.reference[1]],
    viewports: kit.viewports.map((v) => [v[0], v[1]] as [number, number]),
    screenMatch: kit.screenMatch,
    states: ["default", ...stateList],
    breakpoints: Array.from(ex.breakpoints.values()).sort((a, b) => (a.name < b.name ? -1 : 1)),
    tokens,
    fonts: fontList,
    root: rootNode,
  };
  const errors = validateIr(ir);
  if (errors.length) throw new Error(`extracted IR does not match the IR schema: ${errors.join("; ")}`);
  lap("finish");
  timings.total = Math.round((performance.now() - t0) * 10) / 10;
  return { ir, fixtures, timings };
}
