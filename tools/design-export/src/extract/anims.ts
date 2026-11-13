import type { IrAnim, IrKeyframe } from "../ir/types.js";
import { CSS_WIDE } from "../lint/css-values.js";
import { splitTransform } from "../lint/resolve/transform.js";
import { physicalNames, type DomSnapshot } from "../lint/snapshot.js";
import { fmt } from "./naming.js";
import { listOf, normalizeColor, PSEUDO_STATES, resolveValue, transformValues, type Layers } from "./styles.js";

const COLOR = /^(color|background-color|border-(top|right|bottom|left)-color)$/;
const DIRECTIONS = new Set(["normal", "reverse", "alternate", "alternate-reverse"]);
const FILLS = new Set(["none", "forwards", "backwards", "both"]);

/** Layer → animation trigger: base → show, hover → pseudo:hover, state:/bp:/class: unchanged. */
export function triggerOf(layer: string): string {
  if (layer === "base") return "show";
  return PSEUDO_STATES.has(layer) ? `pseudo:${layer}` : layer;
}

/** CSS time → ms (null for anything else). */
export function timeMs(v: string): number | null {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)$/i.exec(v.trim());
  return m ? Number(fmt(Number(m[1]) * (m[2].toLowerCase() === "s" ? 1000 : 1))) : null;
}

/** Longhands a transition-property entry covers ("all", shorthands, transform → its split). */
function covers(name: string): string[] | "all" {
  const n = name.trim().toLowerCase();
  if (n === "all") return "all";
  if (n === "transform") return ["translate", "rotate", "scale"];
  return physicalNames(n);
}

/** Effective value of a longhand in `layer` (the layer over base), CSS-wide keywords as the fallback. */
function effective(raw: Layers, layer: string, p: string, fallback: string): string {
  const v = raw.get(layer)?.get(p)?.value ?? raw.get("base")?.get(p)?.value;
  return v === undefined || CSS_WIDE.has(v.trim().toLowerCase()) ? fallback : v;
}

function transitionAnims(raw: Layers, layer: string, changed: string[], trigger: string, phase: "enter" | "leave"): IrAnim[] {
  const names = listOf(effective(raw, layer, "transition-property", "all"), "all");
  const durs = listOf(effective(raw, layer, "transition-duration", "0s"), "0s");
  const delays = listOf(effective(raw, layer, "transition-delay", "0s"), "0s");
  const timings = listOf(effective(raw, layer, "transition-timing-function", "ease"), "ease");
  const per = new Map<string, { duration: number; delay: number; timing: string }>();
  names.forEach((n, j) => {
    if (n.trim().toLowerCase() === "none") return;
    const c = covers(n);
    const t = { duration: timeMs(durs[j % durs.length]) ?? 0, delay: timeMs(delays[j % delays.length]) ?? 0, timing: timings[j % timings.length].trim() };
    // CSS: the last entry naming a property wins
    for (const p of c === "all" ? changed : changed.filter((x) => c.includes(x))) per.set(p, t);
  });
  const groups = new Map<string, { t: { duration: number; delay: number; timing: string }; props: string[] }>();
  for (const [p, t] of per) {
    if (t.duration <= 0 && t.delay <= 0) continue;
    const k = `${t.duration}\u0000${t.delay}\u0000${t.timing}`;
    if (!groups.has(k)) groups.set(k, { t, props: [] });
    groups.get(k)!.props.push(p);
  }
  return Array.from(groups.values())
    .map((g) => ({ ...g, props: g.props.sort() }))
    .sort((a, b) => (a.props[0] < b.props[0] ? -1 : 1))
    .map((g) => ({
      kind: "transition", trigger, phase, name: null, properties: g.props, duration: g.t.duration, delay: g.t.delay, timing: g.t.timing,
      iterations: 1, direction: "normal", fillMode: "none", playState: "running", keyframes: [],
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

const ANIMATION = ["animation-name", "animation-duration", "animation-delay", "animation-timing-function", "animation-iteration-count",
  "animation-direction", "animation-fill-mode", "animation-play-state"];

/**
 * Every transition and keyframe animation of element `i` (spec §11, R27/R34). `raw` holds the cascaded layers with
 * transition-* and animation-*; `layers` the IR style layers (what each trigger changes). Transitions: per non-base
 * layer, `enter` with the layer's effective transition and `leave` with the base's (CSS uses the destination style's).
 * Keyframes: base animations start on show, a layer that declares animation-* starts its effective ones.
 */
export function animsOf(s: DomSnapshot, i: number, raw: Layers, layers: Layers, refs: Set<string>): IrAnim[] {
  const out: IrAnim[] = [];
  const names = Array.from(layers.keys()).filter((n) => n !== "base").sort();
  for (const layer of names) {
    const changed = Array.from(layers.get(layer)!.keys()).filter((p) => p !== "display");
    if (!changed.length) continue;
    const trigger = triggerOf(layer);
    out.push(...transitionAnims(raw, layer, changed, trigger, "enter"), ...transitionAnims(raw, "base", changed, trigger, "leave"));
  }
  for (const layer of ["base", ...Array.from(raw.keys()).filter((n) => n !== "base").sort()]) {
    const own = raw.get(layer);
    if (!own || (layer !== "base" && !ANIMATION.some((p) => own.has(p)))) continue;
    const list = (p: string, fb: string) => listOf(effective(raw, layer, p, fb), fb).map((x) => x.trim());
    const anames = list("animation-name", "none"), durs = list("animation-duration", "0s"), delays = list("animation-delay", "0s");
    const timings = list("animation-timing-function", "ease"), counts = list("animation-iteration-count", "1");
    const dirs = list("animation-direction", "normal"), fills = list("animation-fill-mode", "none"), plays = list("animation-play-state", "running");
    anames.forEach((name, j) => {
      if (name === "none") return;
      const frames = framesOf(s, i, name, refs);
      if (!frames) return;
      const at = <T>(a: T[]) => a[j % a.length];
      const count = at(counts);
      const iterations = count === "infinite" ? "infinite" : Number.isFinite(Number(count)) && Number(count) >= 0 ? Number(count) : 1;
      out.push({
        kind: "keyframes", trigger: triggerOf(layer), phase: "enter", name,
        properties: Array.from(new Set(frames.flatMap((f) => Object.keys(f.values)))).sort(),
        duration: timeMs(at(durs)) ?? 0, delay: timeMs(at(delays)) ?? 0, timing: at(timings), iterations,
        direction: (DIRECTIONS.has(at(dirs)) ? at(dirs) : "normal") as IrAnim["direction"],
        fillMode: (FILLS.has(at(fills)) ? at(fills) : "none") as IrAnim["fillMode"],
        playState: at(plays) === "paused" ? "paused" : "running",
        keyframes: frames,
      });
    });
  }
  return out;
}
