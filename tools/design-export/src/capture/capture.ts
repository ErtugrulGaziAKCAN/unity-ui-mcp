/**
 * Golden captures (spec §7 step 3, §11, §15): PNG and device-pixel boxes per capture job.
 *
 * One page per viewport, reused across its jobs: a job moves the page from the previous job's applied set to its own
 * (classes and disabled/checked properties in the page, pseudo-states forced through CDP `CSS.forcePseudoState`), so
 * no reload is needed. Static captures keep the loader's freeze (every animation finished, no transition); the CDP
 * document timeline runs at playback rate 0 for the whole session, so nothing advances between jobs.
 *
 * Animation samples (§11): the animations a job runs get their own timing back as inline `!important` overrides (the
 * freeze stays for everything else), the change is applied, and the started animations (CDP `Animation` events,
 * matched by node and name) are moved with `Animation.seekAnimations`; consecutive samples of one series reuse the
 * change and only seek forward.
 *
 * Boxes (findings R7): border boxes and text lines from `getBoundingClientRect` and text Range client rects, times the
 * panel scale; a line's baseline is its top plus the font's ascent at the rendered size, measured once per font with
 * an inline-block probe (Chromium rounds the ascent). Values are rounded to 1e-6 device px so output is byte-stable.
 */
import fs from "node:fs";
import path from "node:path";
import type { Browser, CDPSession } from "playwright";
import { launchChromium } from "../browser.js";
import type { CaptureBoxes } from "../boxes/types.js";
import type { IrAnim, IrNode, IrScreen } from "../ir/types.js";
import { stableStringify } from "../ir/stableStringify.js";
import type { KitConfig } from "../kit.js";
import { openDesign, type LoadedDesign } from "../load.js";
import { logicalViewport } from "../viewport.js";
import { buildMatrix, captureName, unsampledAnims, type AnimRef, type CaptureJob, type ScreenSetup } from "./matrix.js";

/** IR id → index of its DOM element in `[body, ...body.querySelectorAll("*")]` (from `buildIr`). */
export type ElementMap = Record<string, number>;

export interface MatrixTimings {
  totalMs: number;
  /** Per viewport `<w>x<h>`: page open (load, fonts, quiet DOM) and capture time, job count. */
  viewports: Record<string, { openMs: number; captureMs: number; jobs: number }>;
  /** Per capture name: setup, screenshot, boxes and writes. */
  jobs: Record<string, number>;
}
export interface MatrixResult { jobs: CaptureJob[]; boxes: Record<string, CaptureBoxes>; timings: MatrixTimings }
export interface MatrixOptions {
  /** Browser to open pages in (else one is launched and closed). */
  browser?: Browser;
  /** Jobs to capture (default `buildMatrix(ir)`). */
  jobs?: CaptureJob[];
  /** Pages already open (e.g. the reference page the IR was extracted from); used for the viewport they render, never closed. */
  open?: LoadedDesign[];
  /** Viewports captured at the same time, one page each (default 4); the output does not depend on it. */
  concurrency?: number;
}

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
/** CSS properties a transition of the IR properties runs on: the IR splits transform into translate/rotate/scale, the page may still use transform. */
const domProps = (a: IrAnim) => [...a.properties, ...(a.properties.some((p) => p === "translate" || p === "rotate" || p === "scale") ? ["transform"] : [])];
const vpName = (v: [number, number]) => `${v[0]}x${v[1]}`;

// ---- page functions (run in the page; plain data in and out) -------------------------------------------------------

type Mutation = { add: [number, string][]; remove: [number, string][]; set: [number, "disabled" | "checked", boolean][] };
/**
 * Adds/removes classes and sets disabled/checked. Never throws midway: it reports exactly what it did (classes
 * removed, classes added that were absent before, previous property values) so the caller's record stays exact.
 */
function pageMutate(m: Mutation): { removed: [number, string][]; added: [number, string][]; previous: [number, "disabled" | "checked", boolean][] } {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  const removed: [number, string][] = [], added: [number, string][] = [], previous: [number, "disabled" | "checked", boolean][] = [];
  for (const [i, c] of m.remove) { try { els[i].classList.remove(c); removed.push([i, c]); } catch { /* reported by omission */ } }
  for (const [i, c] of m.add) { try { if (!els[i].classList.contains(c)) { els[i].classList.add(c); added.push([i, c]); } } catch { /* idem */ } }
  for (const [i, p, v] of m.set) {
    try { const el = els[i] as HTMLInputElement; if (p in el) { const before = el[p]; el[p] = v; previous.push([i, p, before]); } } catch { /* idem */ }
  }
  return { removed, added, previous };
}

/** Sets inline `!important` declarations; returns each element's style attribute from before. */
function pageStyle(items: [number, [string, string][]][]): [number, string | null][] {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  return items.map(([i, decls]) => {
    const el = els[i] as HTMLElement;
    const before = el.getAttribute("style");
    for (const [k, v] of decls) el.style.setProperty(k, v, "important");
    return [i, before];
  });
}

/** Keyframe timing overrides aligned with the element's current animation-name list; names not listed stay frozen. */
function pageKeyframes(items: [number, [string, string, string, string, string][]][]): [number, string | null][] {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  return items.map(([i, runs]) => {
    const el = els[i] as HTMLElement;
    const before = el.getAttribute("style");
    const names = getComputedStyle(el).animationName.split(",").map((n) => n.trim());
    const pick = (n: string) => runs.find((r) => r[0] === n);
    const col = (k: number, frozen: string) => names.map((n) => pick(n)?.[k] ?? frozen).join(", ");
    el.style.setProperty("animation-duration", col(1, "0s"), "important");
    el.style.setProperty("animation-delay", col(2, "0s"), "important");
    el.style.setProperty("animation-iteration-count", col(3, "1"), "important");
    el.style.setProperty("animation-fill-mode", col(4, "both"), "important");
    return [i, before];
  });
}

function pageRestoreStyle(items: [number, string | null][]): void {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  for (const [i, s] of items) { if (s === null) els[i].removeAttribute("style"); else els[i].setAttribute("style", s); }
}

/** Animations on the given elements that the runs cover: [element index, CSS transition property or animation name]. */
function pageRunAnims(items: [number, string[], string[]][]): [number, string][] {
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  const out: [number, string][] = [];
  for (const [i, props, names] of items) {
    for (const a of els[i].getAnimations()) {
      const x = a as Animation & { transitionProperty?: string; animationName?: string };
      if (x.transitionProperty !== undefined && props.includes(x.transitionProperty)) out.push([i, x.transitionProperty]);
      else if (x.animationName !== undefined && names.includes(x.animationName)) out.push([i, x.animationName]);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/** Resolves style and layout now, so the next change starts transitions from this style (CSS before-change style). */
function pageFlush(): void {
  document.documentElement.getBoundingClientRect();
}

/** Lays out the current state and waits for any font face it started loading (e.g. a unicode-range subset a state shows). */
async function pageSettle(): Promise<boolean> {
  document.documentElement.getBoundingClientRect();
  await document.fonts.ready;
  return true;
}

/** Every animation jumps to its end (frozen ones are finite); infinite ones are left as they are. */
function pageFinishAll(): void {
  for (const a of document.getAnimations()) { try { a.finish(); } catch { /* infinite */ } }
}

type LineBox = { x: number; y: number; w: number; h: number; baseline: number };
type ElBox = { x: number; y: number; w: number; h: number; visible: boolean; text: boolean; lines: LineBox[] };
/**
 * Boxes of the IR elements in device px: border box, visibility, text lines with baselines (see the boxes schema for
 * the rules). Ascents are cached per font and per state of the page's font set (faces added or loaded since).
 */
async function pageBoxes(arg: { items: [string, number, boolean][]; ir: number[]; scale: number }): Promise<[string, ElBox][]> {
  await document.fonts.ready;
  const els: Element[] = [document.body, ...Array.from(document.body.querySelectorAll("*"))];
  const irEls = new Set(arg.ir.map((i) => els[i]));
  const dev = (v: number) => { const r = Math.round(v * arg.scale * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r; };
  const w = window as unknown as { __designUiAscent?: Map<string, number> };
  const ascents = (w.__designUiAscent ??= new Map<string, number>());
  const faces = Array.from(document.fonts);
  const fontSet = `${document.fonts.size}/${faces.filter((f) => f.status === "loaded").length}`;
  const ascent = (cs: CSSStyleDeclaration) => {
    const key = [fontSet, cs.fontFamily, cs.fontSize, cs.fontWeight, cs.fontStyle, cs.fontStretch, cs.fontVariationSettings, cs.fontSynthesis].join("|");
    let a = ascents.get(key);
    if (a === undefined) {
      // a zero-size inline-block sits on the baseline: its bottom minus the text box top is the rendered ascent
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;line-height:normal;margin:0;padding:0;border:0";
      for (const p of ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variation-settings", "font-synthesis"]) probe.style.setProperty(p, cs.getPropertyValue(p));
      const span = document.createElement("span");
      span.textContent = "x";
      const mark = document.createElement("span");
      mark.style.cssText = "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
      span.appendChild(mark);
      probe.appendChild(span);
      document.documentElement.appendChild(probe);
      a = mark.getBoundingClientRect().bottom - span.getBoundingClientRect().top;
      probe.remove();
      ascents.set(key, a);
    }
    return a;
  };
  const hiddenByOpacity = new Map<Element, boolean>();
  const transparent = (e: Element | null): boolean => {
    if (!e) return false;
    const hit = hiddenByOpacity.get(e);
    if (hit !== undefined) return hit;
    const v = parseFloat(getComputedStyle(e).opacity) === 0 || transparent(e.parentElement);
    hiddenByOpacity.set(e, v);
    return v;
  };
  const out: [string, ElBox][] = [];
  for (const [id, i, isText] of arg.items) {
    const el = els[i];
    const rendered = el.getClientRects().length > 0;
    const box: ElBox = { x: 0, y: 0, w: 0, h: 0, visible: false, text: isText, lines: [] };
    if (rendered) {
      const b = el.getBoundingClientRect();
      Object.assign(box, { x: dev(b.x), y: dev(b.y), w: dev(b.width), h: dev(b.height) });
      box.visible = getComputedStyle(el).visibility === "visible" && !transparent(el);
    }
    if (isText && rendered) {
      type Frag = { l: number; t: number; r: number; b: number; base: number };
      const frags: Frag[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          for (let p = n.parentElement; p && p !== el; p = p.parentElement) if (irEls.has(p)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(n);
        const a = ascent(getComputedStyle(n.parentElement!));
        for (const r of Array.from(range.getClientRects())) if (r.width > 0 && r.height > 0) frags.push({ l: r.left, t: r.top, r: r.right, b: r.bottom, base: r.top + a });
      }
      // fragments on one line share its baseline (to half a device pixel); with a line height below the ascent,
      // neighbouring lines' text boxes overlap, so overlap cannot be the test
      const tol = 0.5 / arg.scale;
      const lines: Frag[] = [];
      for (const f of frags.sort((p, q) => p.base - q.base || p.l - q.l)) {
        const line = lines.find((x) => Math.abs(f.base - x.base) <= tol);
        if (line) { line.l = Math.min(line.l, f.l); line.r = Math.max(line.r, f.r); line.t = Math.min(line.t, f.t); line.b = Math.max(line.b, f.b); }
        else lines.push({ ...f });
      }
      box.lines = lines.sort((p, q) => p.base - q.base).map((x) => ({ x: dev(x.l), y: dev(x.t), w: dev(x.r - x.l), h: dev(x.b - x.t), baseline: dev(x.base) }));
    }
    out.push([id, box]);
  }
  return out;
}

// ---- session -----------------------------------------------------------------------------------------------------

interface CdpNode { nodeId: number; backendNodeId: number; nodeType: number; nodeName: string; attributes?: string[]; children?: CdpNode[] }
interface DomEl { nodeId: number; backendNodeId: number; parent: number; attrs: Map<string, string> }
interface Desired { classes: Map<string, [number, string]>; props: Map<string, [number, "disabled" | "checked"]>; forced: Map<number, string[]> }
const emptyDesired = (): Desired => ({ classes: new Map(), props: new Map(), forced: new Map() });

/**
 * One page at one viewport, reused across jobs. It works through its own CDP session, so its DOM node ids, forced
 * pseudo-states and agents never touch the caller's session; close it to give the page back as it was.
 */
export class CaptureSession {
  private cdp: CDPSession | null = null;
  private dom: DomEl[] = [];
  private nodes = new Map<string, IrNode>();
  private items: [string, number, boolean][] = [];
  private irIndices: number[] = [];
  private external: string[] = [];
  private current: Desired = emptyDesired();
  /** Classes the session added (absent in the markup), by `i|class`. */
  private added = new Set<string>();
  /** disabled/checked values before the session changed them, by `i|prop`. */
  private originals = new Map<string, boolean>();
  /** Style attributes before animation overrides. */
  private savedStyles = new Map<number, string | null>();
  /** CDP animations by `backendNodeId|name` (transition property or animation name): latest id and its arrival order. */
  private registry = new Map<string, { id: string; seq: number }>();
  private seq = 0;
  private series: { key: string; ids: string[]; time: number } | null = null;
  private readonly onStarted = (e: { animation: { id: string; name: string; source?: { backendNodeId?: number } } }) => {
    const b = e.animation.source?.backendNodeId;
    if (b !== undefined) this.registry.set(`${b}|${e.animation.name}`, { id: e.animation.id, seq: ++this.seq });
  };
  readonly scale: number;

  private constructor(readonly d: LoadedDesign, readonly ir: IrScreen, readonly elements: ElementMap, readonly viewport: [number, number]) {
    this.scale = logicalViewport(viewport, ir.referenceViewport, ir.screenMatch).scale;
  }

  /** Checks the page renders `viewport` and that the element map fits its DOM, then freezes the animation timeline. */
  static async open(d: LoadedDesign, ir: IrScreen, elements: ElementMap, viewport: [number, number]): Promise<CaptureSession> {
    const s = new CaptureSession(d, ir, elements, viewport);
    try { await s.init(); } catch (e) { await s.close().catch(() => {}); throw e; }
    return s;
  }

  private send<T = unknown>(method: string, params?: object): Promise<T> {
    if (!this.cdp) throw new Error("the capture session is closed");
    return (this.cdp.send as unknown as (m: string, p?: object) => Promise<T>)(method, params);
  }

  private async init(): Promise<void> {
    const { d, ir, elements, viewport } = this;
    const lv = logicalViewport(viewport, ir.referenceViewport, ir.screenMatch);
    const size = d.page.viewportSize();
    const dpr = await d.page.evaluate(() => devicePixelRatio);
    if (!size || size.width !== Math.round(lv.width) || size.height !== Math.round(lv.height) || Math.abs(dpr - lv.scale) > 1e-6) {
      throw new Error(`the page renders ${size?.width}x${size?.height} at scale ${dpr}, not viewport ${vpName(viewport)} (${Math.round(lv.width)}x${Math.round(lv.height)} at ${lv.scale})`);
    }
    const walk = (n: IrNode) => { this.nodes.set(n.id, n); n.children.forEach(walk); };
    walk(ir.root);

    // DOM elements in document order with CDP ids (one call), checked against the element map
    this.cdp = await d.page.context().newCDPSession(d.page);
    this.cdp.on("Animation.animationStarted", this.onStarted);
    await this.send("DOM.enable");
    await this.send("CSS.enable");
    const { root } = await this.send<{ root: CdpNode }>("DOM.getDocument", { depth: -1 });
    const html = root.children?.find((c) => c.nodeType === 1);
    const body = html?.children?.find((c) => c.nodeType === 1 && c.nodeName === "BODY");
    if (!body) throw new Error("the page has no body");
    const add = (n: CdpNode, parent: number) => {
      const attrs = new Map<string, string>();
      for (let k = 0; k + 1 < (n.attributes?.length ?? 0); k += 2) attrs.set(n.attributes![k], n.attributes![k + 1]);
      const i = this.dom.length;
      this.dom.push({ nodeId: n.nodeId, backendNodeId: n.backendNodeId, parent, attrs });
      for (const c of n.children ?? []) if (c.nodeType === 1) add(c, i);
    };
    add(body, -1);
    const count = await d.page.evaluate(() => document.body.querySelectorAll("*").length + 1);
    if (count !== this.dom.length) throw new Error(`the page has ${count} elements but CDP reports ${this.dom.length}`);
    for (const id of this.nodes.keys()) {
      const i = elements[id];
      if (i === undefined || !this.dom[i]) throw new Error(`element map: no DOM element for IR id ${id}`);
      const uid = this.dom[i].attrs.get("data-u-id");
      if (uid !== undefined && uid !== id) throw new Error(`element map: ${id} points at an element whose data-u-id is ${uid}`);
    }
    if (!this.dom[elements[ir.root.id]].attrs.has("data-u-screen")) throw new Error(`element map: the root ${ir.root.id} is not the data-u-screen element`);
    for (const [id, n] of this.nodes) {
      this.items.push([id, elements[id], n.text !== null]);
      this.irIndices.push(elements[id]);
      if (n.external) this.external.push(id);
    }
    this.external.sort();

    await this.send("Animation.enable");
    await this.send("Animation.setPlaybackRate", { playbackRate: 0 });
  }

  private index(id: string): number {
    const i = this.elements[id];
    if (i === undefined || !this.nodes.has(id)) throw new Error(`unknown IR element ${id}`);
    return i;
  }

  /** Element and its DOM ancestors up to the screen root. */
  private chain(i: number): number[] {
    const out: number[] = [];
    const stop = this.elements[this.ir.root.id];
    for (let x = i; x >= 0; x = this.dom[x].parent) { out.push(x); if (x === stop) break; }
    return out;
  }

  private desiredOf(setup: ScreenSetup | null): Desired {
    const want = emptyDesired();
    if (!setup) return want;
    const root = this.elements[this.ir.root.id];
    if (setup.state !== "default") want.classes.set(`${root}|state-${setup.state}`, [root, `state-${setup.state}`]);
    const force = (i: number, p: string) => { const l = want.forced.get(i) ?? []; if (!l.includes(p)) l.push(p); want.forced.set(i, l); };
    for (const a of setup.apply) {
      const i = this.index(a.elementId);
      if (a.kind === "class") { want.classes.set(`${i}|${a.name}`, [i, a.name]); continue; }
      if (a.pseudo === "disabled" || a.pseudo === "checked") want.props.set(`${i}|${a.pseudo}`, [i, a.pseudo]);
      else if (a.pseudo === "focus") force(i, "focus");
      else {
        // a real pointer: the element and its ancestors are hovered; active only on the pressed element
        for (const x of this.chain(i)) force(x, "hover");
        if (a.pseudo === "active") force(i, "active");
      }
    }
    for (const l of want.forced.values()) l.sort();
    return want;
  }

  /**
   * Moves the page from the current applied set to `setup` (null: nothing applied). The record is updated step by
   * step with what the page reports, so after a failure midway `close()` still undoes exactly what was applied.
   */
  private async goTo(setup: ScreenSetup | null): Promise<void> {
    const want = this.desiredOf(setup), cur = this.current;
    const m: Mutation = { add: [], remove: [], set: [] };
    for (const [k, v] of cur.classes) if (!want.classes.has(k)) { if (this.added.has(k)) m.remove.push(v); else cur.classes.delete(k); }
    for (const [k, v] of want.classes) if (!cur.classes.has(k)) m.add.push(v);
    for (const [k, [i, p]] of cur.props) if (!want.props.has(k)) m.set.push([i, p, this.originals.get(k) ?? false]);
    for (const [k, [i, p]] of want.props) if (!cur.props.has(k)) m.set.push([i, p, true]);
    if (m.add.length || m.remove.length || m.set.length) {
      const r = await this.d.page.evaluate(pageMutate, m);
      for (const [i, c] of r.removed) { const k = `${i}|${c}`; this.added.delete(k); cur.classes.delete(k); }
      for (const [i, c] of m.add) { const k = `${i}|${c}`; if (r.added.some(([x, y]) => x === i && y === c)) this.added.add(k); cur.classes.set(k, [i, c]); }
      for (const [i, p, v] of r.previous) {
        const k = `${i}|${p}`;
        if (want.props.has(k)) { if (!this.originals.has(k)) this.originals.set(k, v); cur.props.set(k, [i, p]); }
        else { this.originals.delete(k); cur.props.delete(k); }
      }
      // properties the element does not have (no effect) are dropped from the record either way
      for (const [i, p] of m.set.map(([i, p]) => [i, p] as const)) { const k = `${i}|${p}`; if (!r.previous.some(([x, y]) => x === i && y === p)) { cur.props.delete(k); this.originals.delete(k); } }
    }
    const targets = new Set([...cur.forced.keys(), ...want.forced.keys()]);
    for (const i of Array.from(targets).sort((a, b) => a - b)) {
      const after = want.forced.get(i) ?? [];
      if ((cur.forced.get(i) ?? []).join() === after.join()) continue;
      await this.send("CSS.forcePseudoState", { nodeId: this.dom[i].nodeId, forcedPseudoClasses: after });
      if (after.length) cur.forced.set(i, after); else cur.forced.delete(i);
    }
  }

  private anim(ref: AnimRef): IrAnim {
    const a = this.nodes.get(ref.elementId)?.anims[ref.index];
    if (!a) throw new Error(`no animation ${ref.index} on ${ref.elementId}`);
    return a;
  }

  /** Applies the change of an animation series with the runs' own timing and returns the CDP ids of the started animations. */
  private async startSeries(job: CaptureJob): Promise<string[]> {
    const a = job.anim!;
    const transitions = new Map<number, IrAnim[]>(), keyframes = new Map<number, IrAnim[]>();
    for (const r of a.runs) {
      const x = this.anim(r), i = this.index(r.elementId), m = x.kind === "transition" ? transitions : keyframes;
      m.set(i, [...(m.get(i) ?? []), x]);
    }
    const save = (list: [number, string | null][]) => { for (const [i, s] of list) if (!this.savedStyles.has(i)) this.savedStyles.set(i, s); };
    const to: ScreenSetup = { state: job.state, apply: job.apply };
    if (a.from) await this.goTo(a.from);
    await this.d.page.evaluate(pageFlush);
    // transitions take the timing in effect when the change happens: set it first
    const tItems: [number, [string, string][]][] = Array.from(transitions).map(([i, list]) => {
      const props: string[] = [], durs: string[] = [], delays: string[] = [], timings: string[] = [];
      for (const x of list) {
        for (const p of domProps(x)) { props.push(p); durs.push(`${x.duration}ms`); delays.push(`${x.delay}ms`); timings.push(x.timing); }
      }
      return [i, [["transition-property", props.join(", ")], ["transition-duration", durs.join(", ")], ["transition-delay", delays.join(", ")], ["transition-timing-function", timings.join(", ")]]];
    });
    if (tItems.length) save(await this.d.page.evaluate(pageStyle, tItems));
    const marker = this.seq;
    await this.goTo(to);
    await this.d.page.evaluate(pageFlush);
    // keyframe animations exist once the change applied (frozen); their own timing is set in place
    const kItems: [number, [string, string, string, string, string][]][] = Array.from(keyframes).map(([i, list]) =>
      [i, list.map((x) => [x.name ?? "", `${x.duration}ms`, `${x.delay}ms`, String(x.iterations), x.fillMode] as [string, string, string, string, string])]);
    if (kItems.length) save(await this.d.page.evaluate(pageKeyframes, kItems));
    // the animations the runs cover, as the page has them, then their CDP ids (started events arrive asynchronously)
    const query: [number, string[], string[]][] = Array.from(new Set([...transitions.keys(), ...keyframes.keys()])).sort((x, y) => x - y).map((i) => [i,
      (transitions.get(i) ?? []).flatMap(domProps),
      (keyframes.get(i) ?? []).map((x) => x.name ?? "")]);
    const live = await this.d.page.evaluate(pageRunAnims, query);
    const fresh = a.from !== null;
    const deadline = performance.now() + 5000;
    for (;;) {
      const ids = live.map(([i, name]) => this.registry.get(`${this.dom[i].backendNodeId}|${name}`)).map((r) => (r && (!fresh || r.seq > marker) ? r.id : null));
      if (ids.every((x) => x !== null)) return ids as string[];
      if (performance.now() > deadline) throw new Error(`${captureName(job)}: the animations did not start: ${live.filter((_, k) => ids[k] === null).map(([i, n]) => `${i}:${n}`).join(", ")}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  /** Ends an animation series: overrides removed, every animation at its end, nothing applied. */
  private async endSeries(): Promise<void> {
    if (!this.series && !this.savedStyles.size) return;
    if (this.savedStyles.size) await this.d.page.evaluate(pageRestoreStyle, Array.from(this.savedStyles));
    this.savedStyles.clear();
    await this.d.page.evaluate(pageFinishAll);
    await this.goTo(null);
    await this.d.page.evaluate(pageFinishAll);
    this.series = null;
  }

  /** Captures one job: writes `<goldensDir>/<name>.png` and returns its boxes. */
  async capture(job: CaptureJob, goldensDir: string): Promise<CaptureBoxes> {
    if (job.viewport[0] !== this.viewport[0] || job.viewport[1] !== this.viewport[1]) throw new Error(`${captureName(job)}: this page renders viewport ${vpName(this.viewport)}`);
    const name = captureName(job);
    if (job.anim) {
      const key = JSON.stringify({ from: job.anim.from, state: job.state, apply: job.apply, runs: job.anim.runs });
      if (!this.series || this.series.key !== key || this.series.time > job.anim.time) {
        await this.endSeries();
        this.series = { key, ids: await this.startSeries(job), time: 0 };
      }
      if (this.series.ids.length) await this.send("Animation.seekAnimations", { animations: this.series.ids, currentTime: job.anim.time });
      this.series.time = job.anim.time;
    } else {
      await this.endSeries();
      await this.goTo({ state: job.state, apply: job.apply });
    }
    await this.d.page.evaluate(pageSettle);
    // caret "initial": the loader's freeze rule already hides carets; Playwright's own hiding leaves style="" on inputs
    const png = await this.d.page.screenshot({ type: "png", caret: "initial" });
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    if (w !== job.viewport[0] || h !== job.viewport[1]) throw new Error(`${name}: the capture is ${w}x${h}, not ${vpName(job.viewport)}`);
    const els = await this.d.page.evaluate(pageBoxes, { items: this.items, ir: this.irIndices, scale: this.scale });
    fs.mkdirSync(goldensDir, { recursive: true });
    fs.writeFileSync(path.join(goldensDir, `${name}.png`), png);
    return { capture: name, viewport: [job.viewport[0], job.viewport[1]], scale: this.scale, elements: Object.fromEntries(els), external: [...this.external] };
  }

  /**
   * Gives the page back, also after a failure midway: overrides removed, every class it added removed, disabled/checked
   * restored, animations finished, forced pseudo-states cleared, the timeline running, its window global deleted and
   * its CDP agents disabled (its own CDP session detached).
   */
  async close(): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (f: () => Promise<unknown>) => { try { await f(); } catch (e) { errors.push(e); } };
    if (this.savedStyles.size) await attempt(() => this.d.page.evaluate(pageRestoreStyle, Array.from(this.savedStyles)));
    this.savedStyles.clear();
    this.series = null;
    const m: Mutation = {
      add: [], remove: Array.from(this.added, (k) => this.current.classes.get(k) ?? (k.split("|").map((x, n) => (n ? x : Number(x))) as [number, string])),
      set: Array.from(this.originals, ([k, v]) => { const [i, p] = k.split("|"); return [Number(i), p as "disabled" | "checked", v]; }),
    };
    if (m.remove.length || m.set.length) await attempt(() => this.d.page.evaluate(pageMutate, m));
    this.added.clear(); this.originals.clear();
    if (this.cdp) for (const i of this.current.forced.keys()) await attempt(() => this.send("CSS.forcePseudoState", { nodeId: this.dom[i].nodeId, forcedPseudoClasses: [] }));
    await attempt(() => this.d.page.evaluate(pageFinishAll));
    await attempt(() => this.d.page.evaluate(() => { delete (window as unknown as { __designUiAscent?: unknown }).__designUiAscent; }));
    if (this.cdp) {
      await attempt(() => this.send("Animation.setPlaybackRate", { playbackRate: 1 }));
      for (const agent of ["Animation", "CSS", "DOM"]) await attempt(() => this.send(`${agent}.disable`));
      this.cdp.off("Animation.animationStarted", this.onStarted);
      await attempt(() => this.cdp!.detach());
      this.cdp = null;
    }
    this.current = emptyDesired();
    if (errors.length) throw errors[0];
  }
}

function writeBoxes(goldensDir: string, boxes: Record<string, CaptureBoxes>): void {
  fs.mkdirSync(goldensDir, { recursive: true });
  fs.writeFileSync(path.join(goldensDir, "boxes.json"), stableStringify(boxes));
}

/**
 * Captures one job on an open page (rendering the job's viewport): writes `<goldensDir>/<name>.png` and merges its
 * boxes into `<goldensDir>/boxes.json`. `elements` comes from `buildIr` (the DOM element of every IR id).
 */
export async function runCapture(d: LoadedDesign, ir: IrScreen, job: CaptureJob, goldensDir: string, elements: ElementMap): Promise<CaptureBoxes> {
  const s = await CaptureSession.open(d, ir, elements, job.viewport);
  let boxes: CaptureBoxes;
  try { boxes = await s.capture(job, goldensDir); } finally { await s.close(); }
  const file = path.join(goldensDir, "boxes.json");
  const all: Record<string, CaptureBoxes> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  all[boxes.capture] = boxes;
  writeBoxes(goldensDir, all);
  return boxes;
}

/**
 * Captures the whole matrix: one page per viewport (opened from `htmlPath`, or taken from `opts.open`), its jobs in
 * order on that page. Writes every PNG, `boxes.json` (all captures) and `matrix.json` (the jobs with their names,
 * sample times and coverage marks, the animations not sampled, the Chromium build and platform, findings O-14).
 */
export async function captureMatrix(htmlPath: string, kit: KitConfig, ir: IrScreen, elements: ElementMap, goldensDir: string, opts: MatrixOptions = {}): Promise<MatrixResult> {
  const t0 = performance.now();
  if (kit.reference[0] !== ir.referenceViewport[0] || kit.reference[1] !== ir.referenceViewport[1] || kit.screenMatch !== ir.screenMatch) {
    throw new Error("the kit's reference viewport or screen match differs from the IR's");
  }
  const jobs = opts.jobs ?? buildMatrix(ir);
  const groups = new Map<string, CaptureJob[]>();
  for (const j of jobs) { const k = vpName(j.viewport); groups.set(k, [...(groups.get(k) ?? []), j]); }
  const browser = opts.browser ?? opts.open?.[0]?.browser ?? (await launchChromium());
  const ownBrowser = !opts.browser && !opts.open?.length;
  const timings: MatrixTimings = { totalMs: 0, viewports: {}, jobs: {} };
  const boxes: Record<string, CaptureBoxes> = {};
  const reusable = async (vp: [number, number]): Promise<LoadedDesign | undefined> => {
    const lv = logicalViewport(vp, ir.referenceViewport, ir.screenMatch);
    for (const d of opts.open ?? []) {
      const size = d.page.viewportSize();
      if (!size || size.width !== Math.round(lv.width) || size.height !== Math.round(lv.height)) continue;
      if (Math.abs((await d.page.evaluate(() => devicePixelRatio)) - lv.scale) <= 1e-6) return d;
    }
    return undefined;
  };
  /** The first error of any viewport; the others stop at their next job. */
  let failure: { error: unknown } | null = null;
  const runGroup = async (key: string, list: CaptureJob[]) => {
    const t1 = performance.now();
    const vp = list[0].viewport;
    const given = await reusable(vp);
    const d = given ?? (await openDesign(htmlPath, kit, vp, browser));
    const openMs = ms(t1);
    try {
      const t2 = performance.now();
      const s = await CaptureSession.open(d, ir, elements, vp);
      try {
        for (const j of list) {
          if (failure) return;
          const t3 = performance.now();
          const b = await s.capture(j, goldensDir);
          boxes[b.capture] = b;
          timings.jobs[b.capture] = ms(t3);
        }
      } finally { await s.close(); }
      timings.viewports[key] = { openMs, captureMs: ms(t2), jobs: list.length };
    } finally { if (!given) await d.close(); }
  };
  try {
    // every worker ends (and closes its page) before the first error is rethrown, so no capture runs on a closed
    // browser and no rejection is left unhandled
    const queue = Array.from(groups.entries());
    const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, queue.length)) }, async () => {
      for (let next = queue.shift(); next && !failure; next = queue.shift()) {
        try { await runGroup(next[0], next[1]); } catch (e) { failure ??= { error: e }; }
      }
    });
    await Promise.allSettled(workers);
    if (failure) throw (failure as { error: unknown }).error;
    writeBoxes(goldensDir, boxes);
    fs.writeFileSync(path.join(goldensDir, "matrix.json"), stableStringify({
      chromium: browser.version(),
      platform: `${process.platform}-${process.arch}`,
      captures: jobs.map((j) => ({ name: captureName(j), ...j })),
      unsampled: unsampledAnims(ir),
    }));
  } finally { if (ownBrowser) await browser.close(); }
  timings.totalMs = ms(t0);
  return { jobs, boxes, timings };
}
