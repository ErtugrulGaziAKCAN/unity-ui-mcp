import type { IrAnim, IrKeyframe } from "../ir/types.js";
import { CSS_WIDE, splitTopLevel } from "../lint/css-values.js";
import { splitTransform } from "../lint/resolve/transform.js";
import { physicalNames, type DomSnapshot } from "../lint/snapshot.js";
import { dimsOf, triggerOf } from "./layers.js";
import { fmt } from "./naming.js";
import { normalizeColor, resolveValue, transformValues, type Layers, type StyleExtractor } from "./styles.js";

const COLOR = /^(color|background-color|border-(top|right|bottom|left)-color)$/;
const DIRECTIONS = new Set(["normal", "reverse", "alternate", "alternate-reverse"]);
const FILLS = new Set(["none", "forwards", "backwards", "both"]);
const ANIMATION = ["animation-name", "animation-duration", "animation-delay", "animation-timing-function", "animation-iteration-count",
  "animation-direction", "animation-fill-mode", "animation-play-state"];

export { triggerOf };

/** CSS time → ms (null for anything else). */
export function timeMs(v: string): number | null {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)$/i.exec(v.trim());
  return m ? Number(fmt(Number(m[1]) * (m[2].toLowerCase() === "s" ? 1000 : 1))) : null;
}

/** Longhands a transition-property entry covers ("all", shorthands, transform → its split). */
export function covers(name: string): string[] | "all" {
  const n = name.trim().toLowerCase();
  if (n === "all") return "all";
  if (n === "transform") return ["translate", "rotate", "scale"];
  return physicalNames(n);
}

/** A comma list of a transition-* or animation-* property (CSS-wide keywords and absence: `fallback`). */
export const list = (v: string | undefined, fallback: string) =>
  splitTopLevel(v === undefined || CSS_WIDE.has(v.trim().toLowerCase()) ? fallback : v, ",").map((x) => x.trim());

/**
 * The transition in effect in layer `at` for each of the `changed` properties (CSS: the last entry naming a property
 * wins); properties without one are absent. Zero-length entries are included (callers skip them).
 */
export function transitionsAt(ex: StyleExtractor, i: number, at: string, changed: string[]): Map<string, { duration: number; delay: number; timing: string }> {
  const v = (p: string) => ex.effective(i, dimsOf(at), p)?.entry.value;
  const names = list(v("transition-property"), "all"), durs = list(v("transition-duration"), "0s");
  const delays = list(v("transition-delay"), "0s"), timings = list(v("transition-timing-function"), "ease");
  const per = new Map<string, { duration: number; delay: number; timing: string }>();
  names.forEach((n, j) => {
    if (n.toLowerCase() === "none") return;
    const c = covers(n);
    const t = { duration: timeMs(durs[j % durs.length]) ?? 0, delay: timeMs(delays[j % delays.length]) ?? 0, timing: timings[j % timings.length] };
    for (const p of c === "all" ? changed : changed.filter((x) => c.includes(x))) per.set(p, t);
  });
  return per;
}

function transitionAnims(ex: StyleExtractor, i: number, at: string, changed: string[], trigger: string, phase: "enter" | "leave"): IrAnim[] {
  const per = transitionsAt(ex, i, at, changed);
  const groups = new Map<string, { t: { duration: number; delay: number; timing: string }; props: string[] }>();
  for (const [p, t] of per) {
    // CSS Transitions: a transition starts only when its combined duration (duration + delay) is above 0
    if (t.duration + t.delay <= 0) continue;
    const k = `${t.duration}\u0000${t.delay}\u0000${t.timing}`;
    if (!groups.has(k)) groups.set(k, { t, props: [] });
    groups.get(k)!.props.push(p);
  }
  return Array.from(groups.values())
    .map((g) => ({ ...g, props: g.props.sort() }))
    .sort((a, b) => (a.props[0] < b.props[0] ? -1 : 1))
    .map((g) => ({
      kind: "transition", trigger, phase, name: null, properties: g.props, duration: g.t.duration, delay: g.t.delay, timing: g.t.timing,
      iterations: 1, direction: "normal", fillMode: "none", playState: "running", restart: true, keyframes: [],
    }));
}

/** The keyframes of a @keyframes rule as IR values at element `i` (var() and rem resolved, transform split, colours normalised). */
function framesOf(s: DomSnapshot, i: number, name: string, refs: Set<string>): IrKeyframe[] | null {
  const kf = s.keyframes.filter((k) => k.name === name).pop();
  if (!kf) return null;
  const el = s.elements[i];
  const byOffset = new Map<number, { values: Map<string, string>; easing: string | null }>();
  for (const f of kf.frames) {
    const offsets = f.key.split(",").map((k) => k.trim().toLowerCase()).map((k) => (k === "from" ? 0 : k === "to" ? 1 : parseFloat(k) / 100));
    const values = new Map<string, string>();
    let easing: string | null = null;
    for (const d of f.decls) {
      if (d.name.startsWith("--")) continue;
      const en = resolveValue(s, i, d.value);
      en.refs.forEach((r) => refs.add(r));
      if (d.name === "animation-timing-function") { easing = en.value; continue; }
      if (d.name === "transform") {
        const r = splitTransform(en.value, el.size ?? undefined, { rootFontSize: s.rootFontSize });
        if (!r.ok) throw new Error(`${kf.path} ${f.key}: transform: ${en.value}: ${r.reason}`);
        const v = transformValues(r.split);
        const none = v.translate === null && v.rotate === null && v.scale === null;
        for (const k of ["translate", "rotate", "scale"] as const) if (v[k] !== null || none) values.set(k, v[k] ?? "none");
        continue;
      }
      values.set(d.name, COLOR.test(d.name) ? normalizeColor(en.value) : en.value);
    }
    for (const o of offsets) {
      if (!Number.isFinite(o)) continue;
      const cur = byOffset.get(o) ?? { values: new Map(), easing: null };
      for (const [k, v] of values) cur.values.set(k, v);
      if (easing !== null) cur.easing = easing;
      byOffset.set(o, cur);
    }
  }
  return Array.from(byOffset).sort((a, b) => a[0] - b[0])
    .map(([offset, f]) => ({ offset: Number(fmt(offset)), values: Object.fromEntries(f.values), easing: f.easing }));
}

/**
 * Every transition and keyframe animation of element `i` (spec §11), triggered by layer keys (`show` for
 * base). Transitions: per non-base layer, `enter` with the transition in effect in that layer and `leave` with the
 * base's (CSS uses the destination style's). Keyframes: base animations start on show; a layer that declares
 * animation-* starts its animations (`restart`) when it changes animation-name, else it modifies the running ones
 * (play state, timing) without restarting them. A layer whose animation-name is `none` while the element animates
 * elsewhere is a keyframes entry without a name and without keyframes (`animation: none`): the element's animations
 * stop while that layer holds; its properties are those of the element's other keyframe animations.
 */
export function animsOf(ex: StyleExtractor, i: number, raw: Layers, layers: Layers, refs: Set<string>): IrAnim[] {
  const s = ex.s;
  const out: IrAnim[] = [];
  for (const layer of Array.from(layers.keys()).filter((n) => n !== "base").sort()) {
    const changed = Array.from(layers.get(layer)!.keys()).filter((p) => p !== "display");
    if (!changed.length) continue;
    out.push(...transitionAnims(ex, i, layer, changed, triggerOf(layer), "enter"), ...transitionAnims(ex, i, "base", changed, triggerOf(layer), "leave"));
  }
  const baseNames = list(ex.effective(i, [], "animation-name")?.entry.value, "none").join(",");
  const stops: string[] = [];
  for (const layer of ["base", ...Array.from(raw.keys()).filter((n) => n !== "base").sort()]) {
    const own = raw.get(layer);
    if (!own || (layer !== "base" && !ANIMATION.some((p) => own.has(p)))) continue;
    const v = (p: string, fb: string) => list(ex.effective(i, dimsOf(layer), p)?.entry.value, fb);
    const anames = v("animation-name", "none"), durs = v("animation-duration", "0s"), delays = v("animation-delay", "0s");
    const timings = v("animation-timing-function", "ease"), counts = v("animation-iteration-count", "1");
    const dirs = v("animation-direction", "normal"), fills = v("animation-fill-mode", "none"), plays = v("animation-play-state", "running");
    const restart = layer === "base" || anames.join(",") !== baseNames;
    if (layer !== "base" && anames.every((n) => n === "none")) { stops.push(triggerOf(layer)); continue; }
    anames.forEach((name, j) => {
      if (name === "none") return;
      const frames = framesOf(s, i, name, refs);
      if (!frames) return;
      const at = <T>(a: T[]) => a[j % a.length];
      const count = at(counts);
      out.push({
        kind: "keyframes", trigger: triggerOf(layer), phase: "enter", name,
        properties: Array.from(new Set(frames.flatMap((f) => Object.keys(f.values)))).sort(),
        duration: timeMs(at(durs)) ?? 0, delay: timeMs(at(delays)) ?? 0, timing: at(timings),
        iterations: count === "infinite" ? "infinite" : Number.isFinite(Number(count)) && Number(count) >= 0 ? Number(count) : 1,
        direction: (DIRECTIONS.has(at(dirs)) ? at(dirs) : "normal") as IrAnim["direction"],
        fillMode: (FILLS.has(at(fills)) ? at(fills) : "none") as IrAnim["fillMode"],
        playState: at(plays) === "paused" ? "paused" : "running",
        restart,
        keyframes: frames,
      });
    });
  }
  // animation: none in a layer: recorded only when the element has animations it stops
  const animated = Array.from(new Set(out.filter((a) => a.kind === "keyframes").flatMap((a) => a.properties))).sort();
  if (animated.length) for (const trigger of stops) out.push(stopAnim(trigger, animated));
  return out;
}

/** A layer's `animation: none` (IR: a keyframes entry without a name or keyframes) for the given animated properties. */
export function stopAnim(trigger: string, properties: string[]): IrAnim {
  return {
    kind: "keyframes", trigger, phase: "enter", name: null, properties, duration: 0, delay: 0, timing: "ease", iterations: 1,
    direction: "normal", fillMode: "none", playState: "running", restart: true, keyframes: [],
  };
}

/** Whether an IR animation is a layer's `animation: none` (it stops the element's animations, plays nothing). */
export const isStop = (a: IrAnim) => a.kind === "keyframes" && a.name === null;

/** An ancestor's animations of an inherited property, re-triggered by the layer the descendant sees. */
export function inheritedAnims(anims: IrAnim[], prop: string, fromKey: string, key: string): IrAnim[] {
  const out: IrAnim[] = [];
  for (const a of anims) {
    if (a.trigger !== triggerOf(fromKey) || !a.properties.includes(prop)) continue;
    if (a.kind === "transition") { if (fromKey !== "base") out.push({ ...a, trigger: triggerOf(key), properties: [prop] }); continue; }
    if (isStop(a)) { out.push({ ...a, trigger: triggerOf(key), properties: [prop] }); continue; }
    const keyframes = a.keyframes.filter((k) => prop in k.values).map((k) => ({ ...k, values: { [prop]: k.values[prop] } }));
    if (keyframes.length) out.push({ ...a, trigger: triggerOf(key), properties: [prop], keyframes });
  }
  return out;
}

/** Merges animations that differ only in their property lists. */
export function mergeAnims(list: IrAnim[]): IrAnim[] {
  const out = new Map<string, IrAnim>();
  for (const a of list) {
    const k = JSON.stringify({ ...a, properties: [], keyframes: a.kind === "keyframes" ? a.keyframes.map((f) => [f.offset, f.easing]) : [] });
    const prev = out.get(k);
    if (!prev) { out.set(k, { ...a, properties: [...a.properties], keyframes: a.keyframes.map((f) => ({ ...f, values: { ...f.values } })) }); continue; }
    prev.properties = Array.from(new Set([...prev.properties, ...a.properties])).sort();
    a.keyframes.forEach((f, n) => Object.assign(prev.keyframes[n].values, f.values));
  }
  return Array.from(out.values());
}
