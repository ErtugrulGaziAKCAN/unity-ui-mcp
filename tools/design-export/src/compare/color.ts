/**
 * Colour difference for the fidelity comparison (spec §15): CIEDE2000 on sRGB 8-bit values as they are stored in the
 * PNGs. Both sides are compared without any colour conversion other than sRGB → CIELAB (D65), the route measured in
 * findings §10 (the Unity verifier writes its UNorm readback bytes unchanged). The formula is the one the M0
 * measurements used, checked against Sharma, Wu and Dalal (2005).
 */
export type Rgb = [number, number, number];
export type Lab = [number, number, number];

const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);

/** sRGB (0–255) → CIELAB with the D65 white point. */
export function srgbToLab([r, g, b]: readonly number[]): Lab {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

const RAD = Math.PI / 180;
const hue = (b: number, a: number) => { if (a === 0 && b === 0) return 0; const h = Math.atan2(b, a) / RAD; return h < 0 ? h + 360 : h; };

/** CIEDE2000 between two CIELAB colours (kL = kC = kH = 1). */
export function deltaE2000Lab([L1, a1, b1]: readonly number[], [L2, a2, b2]: readonly number[]): number {
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * RAD) / 2);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hbp += hbp < 360 ? 360 : -360; hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * RAD) + 0.24 * Math.cos(2 * hbp * RAD) + 0.32 * Math.cos((3 * hbp + 6) * RAD) - 0.2 * Math.cos((4 * hbp - 63) * RAD);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/** CIEDE2000 between two sRGB colours (0–255 per channel; fractional means allowed). */
export function deltaE2000(a: readonly [number, number, number] | readonly number[], b: readonly [number, number, number] | readonly number[]): number {
  return deltaE2000Lab(srgbToLab(a), srgbToLab(b));
}

/** `#rrggbb` of a colour (channels rounded). */
export function hex(c: readonly number[]): string {
  return "#" + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a CSS colour value (as the IR stores it: Chromium's specified value with var() resolved) paints nothing:
 * `transparent`, or an rgb()/rgba()/hsl()/hsla()/hex/color() value with alpha 0. Anything else counts as painted.
 */
export function isTransparentColor(value: string | undefined): boolean {
  if (value === undefined) return true;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "transparent" || v === "none") return true;
  const hexM = /^#([0-9a-f]{4}|[0-9a-f]{8})$/.exec(v);
  if (hexM) return hexM[1].length === 4 ? hexM[1][3] === "0" : hexM[1].slice(6) === "00";
  const fn = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((.*)\)$/.exec(v);
  if (!fn) return false;
  const body = fn[1].trim();
  // alpha: after a slash, or the fourth comma-separated argument
  const slash = body.lastIndexOf("/");
  const alpha = slash >= 0 ? body.slice(slash + 1).trim() : body.split(",").length === 4 ? body.split(",")[3].trim() : null;
  if (alpha === null) return false;
  const n = alpha.endsWith("%") ? parseFloat(alpha) / 100 : parseFloat(alpha);
  return Number.isFinite(n) && n <= 0;
}
