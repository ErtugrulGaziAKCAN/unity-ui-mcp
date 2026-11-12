import { functionCalls, splitTopLevel } from "../css-values.js";
import { lengthPx, type Box, type LengthContext } from "./radius.js";

/**
 * Splits a CSS `transform` list into the individual `translate`, `rotate` and `scale` properties, which CSS applies
 * as translate · rotate · scale (CSS Transforms 2 §6) and UI Toolkit supports. Shared by lint (U-CSS-025) and the
 * exporter, which writes the split into the IR.
 */

export interface TransformSplit {
  /** [x, y] as CSS lengths ("12px", "50%"), or null when there is no translation. */
  translate: [string, string] | null;
  /** Degrees, or null when there is no rotation. */
  rotate: number | null;
  /** [x, y], or null when there is no scaling. */
  scale: [number, number] | null;
}
export type TransformResult = { ok: true; split: TransformSplit } | { ok: false; reason: string };

const TWO_D = new Set(["translate", "translatex", "translatey", "rotate", "scale", "scalex", "scaley"]);
const ANGLE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i;

function angleDeg(v: string): number | null {
  const m = ANGLE.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] ?? "").toLowerCase()) {
    case "": return n === 0 ? 0 : null;
    case "deg": return n;
    case "rad": return (n * 180) / Math.PI;
    case "grad": return n * 0.9;
    case "turn": return n * 360;
  }
  return null;
}

function factor(v: string): number | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%)?$/.exec(v.trim());
  return m ? Number(m[1]) / (m[2] ? 100 : 1) : null;
}

/** A translation component: px number, or a % kept as text (it needs the box to become px). */
type Len = { px: number; pct: number };
function len(v: string, ctx: LengthContext): Len | null {
  const t = v.trim();
  if (t.endsWith("%")) { const n = Number(t.slice(0, -1)); return Number.isFinite(n) ? { px: 0, pct: n } : null; }
  const p = lengthPx(t, 0, ctx);
  return p === null ? null : { px: p, pct: 0 };
}

interface Op { kind: "t"; x: Len; y: Len }
interface RotOp { kind: "r"; deg: number }
interface ScaleOp { kind: "s"; x: number; y: number }
type AnyOp = Op | RotOp | ScaleOp;

function parseOps(value: string, ctx: LengthContext): AnyOp[] | string {
  const calls = functionCalls(value);
  const rest = calls.reduce((s, c) => s.replace(value.slice(c.start, c.end), ""), value).trim();
  if (rest !== "") return `unexpected "${rest}"`;
  const ops: AnyOp[] = [];
  for (const c of calls) {
    if (!TWO_D.has(c.name)) return `${c.name}() is not a 2D translate/rotate/scale function`;
    const a = splitTopLevel(c.args, ",");
    if (c.name === "rotate") {
      const d = a.length === 1 ? angleDeg(a[0]) : null;
      if (d === null) return `rotate(${c.args}) is not a single angle`;
      ops.push({ kind: "r", deg: d });
    } else if (c.name.startsWith("translate")) {
      const zero: Len = { px: 0, pct: 0 };
      const x = c.name === "translatey" ? zero : len(a[0] ?? "", ctx);
      const y = c.name === "translatex" ? zero : c.name === "translatey" ? len(a[0] ?? "", ctx) : a.length > 1 ? len(a[1], ctx) : zero;
      if (!x || !y || a.length > (c.name === "translate" ? 2 : 1)) return `${c.name}(${c.args}) needs px or % values`;
      ops.push({ kind: "t", x, y });
    } else {
      const x = c.name === "scaley" ? 1 : factor(a[0] ?? "");
      const y = c.name === "scalex" ? 1 : c.name === "scaley" ? factor(a[0] ?? "") : a.length > 1 ? factor(a[1]) : x;
      if (x === null || y === null || a.length > (c.name === "scale" ? 2 : 1)) return `${c.name}(${c.args}) needs numbers`;
      ops.push({ kind: "s", x, y });
    }
  }
  return ops;
}

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);
const lenText = (l: Len): string | null => (l.px !== 0 && l.pct !== 0 ? null : l.pct !== 0 ? `${fmt(l.pct)}%` : `${fmt(l.px)}px`);

/** Splits a transform list; `box` lets a % translation that has to move past a rotate/scale be resolved to px. */
export function splitTransform(value: string, box?: Box, ctx: LengthContext = {}): TransformResult {
  if (/^\s*none\s*$/i.test(value)) return { ok: true, split: { translate: null, rotate: null, scale: null } };
  const ops = parseOps(value, ctx);
  if (typeof ops === "string") return { ok: false, reason: ops };
  const order = { t: 0, r: 1, s: 2 };
  const canonical = ops.every((o, i) => i === 0 || order[ops[i - 1].kind] <= order[o.kind]);
  if (canonical) {
    const t = { x: { px: 0, pct: 0 }, y: { px: 0, pct: 0 } };
    let r = 0, sx = 1, sy = 1, hasT = false, hasR = false, hasS = false;
    for (const o of ops) {
      if (o.kind === "t") { hasT = true; t.x.px += o.x.px; t.x.pct += o.x.pct; t.y.px += o.y.px; t.y.pct += o.y.pct; }
      else if (o.kind === "r") { hasR = true; r += o.deg; }
      else { hasS = true; sx *= o.x; sy *= o.y; }
    }
    const tx = lenText(t.x), ty = lenText(t.y);
    if (hasT && (tx === null || ty === null)) return { ok: false, reason: "a translation mixes px and % on one axis" };
    return { ok: true, split: { translate: hasT ? [tx!, ty!] : null, rotate: hasR ? r : null, scale: hasS ? [sx, sy] : null } };
  }
  // any other order: compose the 2D matrix [a c e; b d f] and decompose it as translate · rotate · scale
  let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
  for (const o of ops) {
    let m: [number, number, number, number, number, number];
    if (o.kind === "t") {
      if ((o.x.pct || o.y.pct) && !box) return { ok: false, reason: "a % translation after rotate/scale needs to come first" };
      m = [1, 0, 0, 1, o.x.px + (o.x.pct / 100) * (box?.w ?? 0), o.y.px + (o.y.pct / 100) * (box?.h ?? 0)];
    } else if (o.kind === "r") {
      const rad = (o.deg * Math.PI) / 180;
      m = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
    } else m = [o.x, 0, 0, o.y, 0, 0];
    [a, b, c, d, e, f] = [a * m[0] + c * m[1], b * m[0] + d * m[1], a * m[2] + c * m[3], b * m[2] + d * m[3], a * m[4] + c * m[5] + e, b * m[4] + d * m[5] + f];
  }
  const sx = Math.hypot(a, b);
  const col2 = Math.hypot(c, d);
  if (sx === 0 || col2 === 0) return { ok: false, reason: "the transform collapses the element (scale 0)" };
  if (Math.abs(a * c + b * d) > 1e-6 * sx * col2) return { ok: false, reason: "a non-uniform scale before a rotation skews the element; translate → rotate → scale cannot express it" };
  const sy = (a * d - b * c) / sx;
  const rot = (Math.atan2(b, a) * 180) / Math.PI;
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;
  return {
    ok: true,
    split: {
      translate: near(e, 0) && near(f, 0) ? null : [`${fmt(e)}px`, `${fmt(f)}px`],
      rotate: near(rot, 0) ? null : Math.round(rot * 1e6) / 1e6,
      scale: near(sx, 1) && near(sy, 1) ? null : [Math.round(sx * 1e6) / 1e6, Math.round(sy * 1e6) / 1e6],
    },
  };
}

/** Why an individual `translate` / `rotate` / `scale` value is not 2D, or null when it is. */
export function individualTransformProblem(name: "translate" | "rotate" | "scale", value: string): string | null {
  const v = value.trim();
  if (/^none$/i.test(v)) return null;
  const parts = splitTopLevel(v, " ");
  if (name === "rotate") return parts.length === 1 && angleDeg(parts[0]) !== null ? null : `rotate: ${v} turns around a 3D axis`;
  if (name === "translate") return parts.length <= 2 ? null : `translate: ${v} has a z component`;
  return parts.length <= 2 ? null : `scale: ${v} has a z component`;
}
