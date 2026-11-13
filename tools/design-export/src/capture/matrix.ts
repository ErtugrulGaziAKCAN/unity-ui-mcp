/**
 * Capture matrix (spec §7 step 3, §11, §12, §15): every capture the Unity verifier must reproduce.
 *
 * - Every state × every declared viewport (the state baselines).
 * - Every layer key of every IR node, applied as its dimensions say: `state:<n>` is class `state-<n>` on the screen
 *   root; own pseudo-states and `anc(<id>):<pseudo>` apply to that element (hover/active/focus forced through CDP,
 *   disabled/checked set as the control's property); `class:<is-x>` and `anc(<id>):class:<is-x>` add the class. A key without breakpoints is captured at every declared viewport; with
 *   breakpoints at the declared viewports where they hold, else at one added viewport just inside them (`coverage`).
 *   Keys that differ only in state/breakpoint dimensions share the state baselines.
 * - Every animation (§11): one series per change that starts it, sampled at `sampleTimes` with every animation that
 *   the same change starts playing on the same clock (`runs`) and all other animations frozen.
 *
 * Pseudo-states follow a real pointer (findings R6, O-5): hover on an element also hovers its ancestors, active implies
 * hover, so `hover` on an ancestor of the hovered or pressed element is implied and dropped. Captures with the same
 * state, viewport and applied set are one capture.
 */
import type { IrAnim, IrNode, IrScreen } from "../ir/types.js";
import { dimKind, dimsOf } from "../extract/layers.js";
import { logicalViewport } from "../viewport.js";

export type PseudoKind = "hover" | "active" | "focus" | "disabled" | "checked";
const PSEUDO: ReadonlySet<string> = new Set(["hover", "active", "focus", "disabled", "checked"]);

/** One thing applied to one element besides the screen state: a forced pseudo-state or an added is-* class. */
export type CaptureApply =
  | { kind: "pseudo"; pseudo: PseudoKind; elementId: string }
  | { kind: "class"; name: string; elementId: string };

/** A screen condition: state (class `state-<n>` on the root; none for default) plus what is applied. */
export interface ScreenSetup { state: string; apply: CaptureApply[] }

/** An IR animation: `node(elementId).anims[index]`. */
export interface AnimRef { elementId: string; index: number }

export interface CaptureAnimSample {
  /** Animations whose sample series this capture belongs to (same change, same times); the first names the capture. */
  sampled: AnimRef[];
  /** Every animation that plays on the sample clock: all animations the same change starts. All others are frozen as in static captures. */
  runs: AnimRef[];
  /** The screen before the change, which happens at time 0; null: the animations start when the screen opens (time 0 = load). */
  from: ScreenSetup | null;
  /** Sample number (`n` in the capture name). */
  sample: number;
  /** Milliseconds after the change. */
  time: number;
}

export interface CaptureJob {
  /** Screen state at capture time. */
  state: string;
  /** Device pixels. */
  viewport: [number, number];
  /** The forced pseudo-state when the capture applies exactly one pseudo-state and nothing else (spec §7 golden name); else null. */
  pseudo: { kind: PseudoKind; elementId: string } | null;
  /** Everything applied besides the state, canonical order (element id, then name). */
  apply: CaptureApply[];
  /** Breakpoints this added viewport exists for (no declared viewport activates them); null for declared viewports. */
  coverage: string[] | null;
  /** Animation sample (the screen at `time` after the change from `from` to state/apply); null for static captures. */
  anim: CaptureAnimSample | null;
}

/** An animation the matrix does not sample, and why. */
export interface UnsampledAnim extends AnimRef { reason: string }

type Bp = IrScreen["breakpoints"][number];

const r6 = (n: number) => { const r = Math.round(n * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r; };
const applyLabel = (a: CaptureApply) => (a.kind === "pseudo" ? a.pseudo : a.name);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortApply = (list: CaptureApply[]) => list.sort((a, b) => cmp(a.elementId, b.elementId) || cmp(applyLabel(a), applyLabel(b)));

/** `<state>@<w>x<h>`, then `.<pseudo|class>.<element id>` per applied item; animation samples `<state>@<w>x<h>.anim.<element id>.<n>`. */
export function captureName(job: CaptureJob): string {
  const base = `${job.state}@${job.viewport[0]}x${job.viewport[1]}`;
  if (job.anim) return `${base}.anim.${job.anim.sampled[0].elementId}.${job.anim.sample}`;
  return base + job.apply.map((a) => `.${applyLabel(a)}.${a.elementId}`).join("");
}

/**
 * Sample times of an animation in ms after its trigger (§11): `delay + {0, ¼, ½, ¾, 1} × duration` within the first
 * iteration, plus 0 when the delay is positive (the delay phase). Negative times clamp to 0; duplicates merge.
 */
export function sampleTimes(a: Pick<IrAnim, "delay" | "duration">): number[] {
  const t = [0, 0.25, 0.5, 0.75, 1].map((k) => a.delay + k * a.duration);
  if (a.delay > 0) t.unshift(0);
  return Array.from(new Set(t.map((x) => r6(Math.max(0, x))))).sort((x, y) => x - y);
}

/** Whether every breakpoint holds at a device viewport (the page's logical size, rounded as the loader renders it). */
export function breakpointsHold(bps: readonly Bp[], viewport: [number, number], ir: Pick<IrScreen, "referenceViewport" | "screenMatch">): boolean {
  const lv = logicalViewport(viewport, ir.referenceViewport, ir.screenMatch);
  const w = Math.round(lv.width), h = Math.round(lv.height);
  return bps.every((b) => (b.minWidth === undefined || w >= b.minWidth) && (b.maxWidth === undefined || w <= b.maxWidth)
    && (b.minAspect === undefined || w / h >= b.minAspect) && (b.maxAspect === undefined || w / h <= b.maxAspect));
}

/**
 * A viewport where every breakpoint holds, close to a declared one. Scale With Screen Size makes the logical size a
 * function of the aspect ratio alone, so a width or aspect breakpoint is reached by changing the aspect: the declared
 * viewport's height is kept and its width moves just inside the range (among the nearest 32 widths, the one whose
 * logical size is closest to whole pixels). The declared viewport needing the smallest relative change wins.
 */
export function coverageViewport(bps: readonly Bp[], ir: Pick<IrScreen, "referenceViewport" | "screenMatch">, declared: readonly [number, number][]): [number, number] | null {
  let best: { vp: [number, number]; rel: number } | null = null;
  for (const [w0, h0] of declared) {
    const inside: { w: number; d: number; err: number }[] = [];
    for (let w = 1; w <= 4 * w0; w++) {
      if (!breakpointsHold(bps, [w, h0], ir)) continue;
      const lv = logicalViewport([w, h0], ir.referenceViewport, ir.screenMatch);
      // the golden must come out at exactly w × h0 device pixels: the rendered logical size times the scale rounds back
      if (Math.round(Math.round(lv.width) * lv.scale) !== w || Math.round(Math.round(lv.height) * lv.scale) !== h0) continue;
      inside.push({ w, d: Math.abs(w - w0), err: Math.abs(lv.width - Math.round(lv.width)) + Math.abs(lv.height - Math.round(lv.height)) });
    }
    if (!inside.length) continue;
    const dmin = Math.min(...inside.map((c) => c.d));
    const pick = inside.filter((c) => c.d <= dmin + 32).sort((a, b) => a.err - b.err || a.d - b.d || a.w - b.w)[0];
    const rel = pick.d / w0;
    if (!best || rel < best.rel) best = { vp: [pick.w, h0], rel };
  }
  return best?.vp ?? null;
}

/** Declared viewports: the IR's, with the reference first when it is missing. */
export function declaredViewports(ir: Pick<IrScreen, "referenceViewport" | "viewports">): [number, number][] {
  const out: [number, number][] = [];
  const add = (v: [number, number]) => { if (!out.some((o) => o[0] === v[0] && o[1] === v[1])) out.push([v[0], v[1]]); };
  if (!ir.viewports.some((v) => v[0] === ir.referenceViewport[0] && v[1] === ir.referenceViewport[1])) add(ir.referenceViewport);
  ir.viewports.forEach(add);
  return out;
}

interface Tree { nodes: Map<string, IrNode>; parent: Map<string, string>; order: string[] }
function treeOf(ir: IrScreen): Tree {
  const nodes = new Map<string, IrNode>(), parent = new Map<string, string>(), order: string[] = [];
  const walk = (n: IrNode, p: string | null) => {
    if (nodes.has(n.id)) throw new Error(`duplicate IR id ${n.id}`);
    nodes.set(n.id, n); order.push(n.id);
    if (p !== null) parent.set(n.id, p);
    n.children.forEach((c) => walk(c, n.id));
  };
  walk(ir.root, null);
  return { nodes, parent, order };
}
const isAncestorOrSelf = (t: Tree, a: string, b: string) => { for (let x: string | undefined = b; x !== undefined; x = t.parent.get(x)) if (x === a) return true; return false; };

/** What a layer key (or trigger) of node `id` means for the whole screen: breakpoints, state, applied items. */
function setupOfKey(t: Tree, ir: IrScreen, id: string, key: string): { bps: string[]; state: string; apply: CaptureApply[] } {
  const bps: string[] = [], apply: CaptureApply[] = [];
  let state = "default";
  const what = (target: string, x: string) => {
    if (!t.nodes.has(target)) throw new Error(`${id}: layer ${key} names ${target}, which is not an IR element`);
    if (x.startsWith("class:")) apply.push({ kind: "class", name: x.slice(6), elementId: target });
    else if (PSEUDO.has(x)) apply.push({ kind: "pseudo", pseudo: x as PseudoKind, elementId: target });
    else throw new Error(`${id}: layer ${key}: cannot apply ${x}`);
  };
  for (const d of dimsOf(key)) {
    const k = dimKind(d);
    if (k === "bp") bps.push(d.slice(3));
    else if (k === "state") state = d.slice(6);
    else if (k === "anc") {
      const m = /^anc\(([^)]+)\):(.+)$/.exec(d);
      if (!m) throw new Error(`${id}: malformed layer ${key}`);
      what(m[1], m[2]);
    } else what(id, d);
  }
  if (!ir.states.includes(state)) throw new Error(`${id}: layer ${key} uses state ${state}, which the IR does not declare`);
  return { bps: bps.sort(), state, apply: normalize(t, apply) };
}

/** Real-pointer semantics: active implies hover on the same element; hover is implied on ancestors of a hovered or pressed element. */
function normalize(t: Tree, list: CaptureApply[]): CaptureApply[] {
  const seen = new Set<string>(), out: CaptureApply[] = [];
  for (const a of list) { const k = `${a.kind} ${applyLabel(a)} ${a.elementId}`; if (!seen.has(k)) { seen.add(k); out.push(a); } }
  const pointer = out.filter((a) => a.kind === "pseudo" && (a.pseudo === "hover" || a.pseudo === "active"));
  return sortApply(out.filter((a) => !(a.kind === "pseudo" && a.pseudo === "hover"
    && pointer.some((b) => b !== a && isAncestorOrSelf(t, a.elementId, b.elementId)))));
}

const setupKey = (s: ScreenSetup) => `${s.state}${s.apply.map((a) => `.${a.kind}.${applyLabel(a)}.${a.elementId}`).join("")}`;

/**
 * The first state (IR order) in which the node and its ancestors are displayed (base display, or the state layer's).
 * CSS starts an animation when its element gets a box, so a `show` animation of an element hidden by default starts
 * when that state applies.
 */
function shownState(t: Tree, ir: IrScreen, id: string): string {
  const path: IrNode[] = [];
  for (let x: string | undefined = id; x !== undefined; x = t.parent.get(x)) path.push(t.nodes.get(x)!);
  for (const st of ir.states) {
    const shown = path.every((n) => (n.style[`state:${st}`]?.display ?? n.style.base?.display) !== "none");
    if (shown) return st;
  }
  return "default";
}

/** Animations the matrix does not sample: keyframe modifiers of a running animation (no own timeline), paused or iteration-less animations. */
export function unsampledAnims(ir: IrScreen): UnsampledAnim[] {
  const out: UnsampledAnim[] = [];
  const t = treeOf(ir);
  for (const id of t.order) t.nodes.get(id)!.anims.forEach((a, index) => { const r = unsampledReason(a); if (r) out.push({ elementId: id, index, reason: r }); });
  return out;
}
function unsampledReason(a: IrAnim): string | null {
  if (a.kind === "keyframes" && !a.restart) return "modifies a running animation (play state or timing) without its own timeline";
  if (a.playState === "paused") return "paused: it never advances";
  if (a.iterations === 0) return "zero iterations";
  return null;
}

/**
 * Every capture of the screen, in a stable order: per viewport (declared order, then added ones), the state baselines,
 * then layer captures by name, then animation samples by series and time. Throws when a layer cannot be captured
 * (unknown state or element, a breakpoint no viewport can reach) or two different captures would share a name.
 */
export function buildMatrix(ir: IrScreen): CaptureJob[] {
  const t = treeOf(ir);
  const declared = declaredViewports(ir);
  const bpByName = new Map(ir.breakpoints.map((b) => [b.name, b]));
  const added: { vp: [number, number]; bps: Set<string> }[] = [];
  const vpKey = (v: [number, number]) => `${v[0]}x${v[1]}`;

  /** Viewports at which a set of breakpoints holds (declared, else one added just inside them). */
  const memo = new Map<string, [number, number][]>();
  const viewportsFor = (names: string[], what: string): [number, number][] => {
    const key = names.join(",");
    const hit = memo.get(key);
    if (hit) return hit;
    const bps = names.map((n) => { const b = bpByName.get(n); if (!b) throw new Error(`${what}: breakpoint ${n} is not declared in the IR`); return b; });
    let vps = names.length ? declared.filter((v) => breakpointsHold(bps, v, ir)) : declared;
    if (!vps.length) {
      const reuse = added.find((a) => breakpointsHold(bps, a.vp, ir));
      const vp = reuse?.vp ?? coverageViewport(bps, ir, declared);
      if (!vp) throw new Error(`${what}: no viewport activates breakpoint(s) ${names.join(", ")} (with Scale With Screen Size at match ${ir.screenMatch}, the logical size depends on the aspect ratio only)`);
      const entry = reuse ?? { vp, bps: new Set<string>() };
      if (!reuse) added.push(entry);
      names.forEach((n) => entry.bps.add(n));
      vps = [vp];
    }
    memo.set(key, vps);
    return vps;
  };

  const jobs = new Map<string, CaptureJob>();
  const addJob = (j: CaptureJob) => {
    const name = captureName(j);
    const prev = jobs.get(name);
    if (!prev) { jobs.set(name, j); return; }
    if (JSON.stringify(prev) !== JSON.stringify(j)) throw new Error(`two different captures would both be named ${name}`);
  };
  const job = (state: string, vp: [number, number], apply: CaptureApply[], anim: CaptureAnimSample | null = null): CaptureJob => ({
    state, viewport: [vp[0], vp[1]], apply,
    pseudo: apply.length === 1 && apply[0].kind === "pseudo" ? { kind: apply[0].pseudo, elementId: apply[0].elementId } : null,
    coverage: null, anim,
  });

  // state baselines at every declared viewport
  for (const vp of declared) for (const st of ir.states) addJob(job(st, vp, []));

  // every layer key
  for (const id of t.order) {
    for (const key of Object.keys(t.nodes.get(id)!.style).sort()) {
      if (key === "base") continue;
      const s = setupOfKey(t, ir, id, key);
      for (const vp of viewportsFor(s.bps, `${id}: layer ${key}`)) addJob(job(s.state, vp, s.apply));
    }
  }

  // animations: one series per (change, viewport); identical series (same change and times) merge
  interface Series { from: ScreenSetup | null; to: ScreenSetup; vp: [number, number]; times: number[]; sampled: AnimRef[]; change: string }
  const series = new Map<string, Series>();
  const runsByChange = new Map<string, AnimRef[]>();
  for (const id of t.order) {
    t.nodes.get(id)!.anims.forEach((a, index) => {
      if (unsampledReason(a)) return;
      let from: ScreenSetup | null, to: ScreenSetup, bps: string[] = [];
      if (a.trigger === "show") {
        const st = shownState(t, ir, id);
        to = { state: st, apply: [] };
        from = st === "default" ? null : { state: "default", apply: [] };
      } else {
        const s = setupOfKey(t, ir, id, a.trigger);
        bps = s.bps;
        // state and breakpoints are the context; the rest of the trigger is the change (a state-only trigger changes the state)
        const on: ScreenSetup = { state: s.state, apply: s.apply };
        const off: ScreenSetup = s.apply.length ? { state: s.state, apply: [] } : { state: "default", apply: [] };
        [from, to] = a.phase === "enter" ? [off, on] : [on, off];
      }
      const times = sampleTimes(a);
      const ref = { elementId: id, index };
      for (const vp of viewportsFor(bps, `${id}: animation ${index} (${a.trigger})`)) {
        const change = `${vpKey(vp)}|${from ? setupKey(from) : "load"}>${setupKey(to)}`;
        runsByChange.set(change, [...(runsByChange.get(change) ?? []), ref]);
        const k = `${change}|${times.join(",")}`;
        const prev = series.get(k);
        if (prev) prev.sampled.push(ref);
        else series.set(k, { from, to, vp, times, sampled: [ref], change });
      }
    });
  }
  const counters = new Map<string, number>();
  for (const s of series.values()) {
    const ckey = `${s.to.state}@${vpKey(s.vp)}.${s.sampled[0].elementId}`;
    let n = counters.get(ckey) ?? 0;
    for (const time of s.times) {
      addJob(job(s.to.state, s.vp, s.to.apply, { sampled: s.sampled, runs: runsByChange.get(s.change)!, from: s.from, sample: n++, time }));
    }
    counters.set(ckey, n);
  }

  // coverage marks and stable order
  const coverage = new Map(added.map((a) => [vpKey(a.vp), Array.from(a.bps).sort()]));
  const vpOrder = [...declared, ...added.map((a) => a.vp)].map(vpKey);
  const stateOrder = new Map(ir.states.map((s, i) => [s, i]));
  const list = Array.from(jobs.entries()).map(([name, j]) => ({ name, j: { ...j, coverage: coverage.get(vpKey(j.viewport)) ?? null } }));
  const kind = (j: CaptureJob) => (j.anim ? 2 : j.apply.length ? 1 : 0);
  list.sort((a, b) => vpOrder.indexOf(vpKey(a.j.viewport)) - vpOrder.indexOf(vpKey(b.j.viewport)) || kind(a.j) - kind(b.j)
    || (kind(a.j) === 0 ? stateOrder.get(a.j.state)! - stateOrder.get(b.j.state)! : 0)
    || (kind(a.j) === 2 ? 0 : cmp(a.name, b.name)));
  return list.map((x) => x.j);
}
