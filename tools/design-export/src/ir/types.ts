export type NodeKind = 'container' | 'text' | 'image' | 'vector' | 'button' | 'toggle' | 'input' | 'dropdown' | 'scroll' | 'list';
/** CSS property -> specified value (var() and rem resolved, CSS-wide keywords concrete). Longhands as Chromium expands them; never transition-* or animation-*. */
export type StyleMap = Record<string, string>;
/**
 * Layer key → style. A key is `base` or dimensions joined with `+` in canonical order bp → state → class → anc → own
 * pseudo-state: `bp:<n>`, `state:<n>`, `class:<is-x>`, `anc(<ancestor id>):<pseudo|class:is-x>`,
 * `hover|active|focus|disabled|checked`; e.g. `state:loading+hover`, `anc(card):hover`. A layer holds what wins when
 * exactly its dimensions hold; layers that hold together and set one property also appear as their union.
 */
export type StyleLayers = Record<string, StyleMap>;
/** `style`: the kit text style the text matches (text-styles.json name), or null. */
export interface IrText { key: string | null; tr: string; en: string | null; args: string[]; rich: boolean; style: string | null }
/**
 * `tint`: an SVG painted with currentColor, written white; the compiler tints it with the node's `color` in each layer.
 * `slice`: 9-slice insets in image pixels, CSS box order top, right, bottom, left (shadows), else null.
 * `stopGap`: a baked gradient (SVG of CSS gradients): the smallest distance between two consecutive colour stops of
 * different colours, as a fraction of the gradient line (U-CSS-022 needs ≥ 1/64 for the importer's 64-step ramp); null
 * for every other asset and for gradients without a colour change.
 */
export interface IrAsset { kind: 'image' | 'svg' | 'shadow9'; file: string; sha256: string; width: number; height: number; slice: [number, number, number, number] | null; tint: boolean; stopGap: number | null }
export interface BoxRect { x: number; y: number; w: number; h: number }
/**
 * A baked box-shadow: a 9-slice PNG (`slice` always set) drawn into the rect (x + offset.x, y + offset.y, w + offset.w,
 * h + offset.h) of the element's border box (x, y, w, h), in CSS px — the drawn rect, which is often larger than the PNG.
 * Outer shadows are drawn behind the element and are transparent under its border box (CSS clips them there; 1px inside
 * it under an opaque background colour). Inset shadows cover the padding box: drawn as the element's first child they
 * come after its background and border (CSS paints the border after them; the two differ only on the anti-aliased inner
 * edge of a curved border) and before its content.
 */
export type IrShadow = IrAsset & { offset: BoxRect };
/** One keyframe: offset 0..1, the values it sets, and the easing of the segment that starts here (null: the animation's). */
export interface IrKeyframe { offset: number; values: StyleMap; easing: string | null }
/**
 * A transition or a keyframe animation, played by the Unity animation player.
 * - trigger: `show` (the screen opens) or a layer key (see StyleLayers): the animation runs when that layer starts to hold.
 * - phase: `enter` runs when the trigger becomes active, `leave` when it ends (a transition's leave uses the base
 *   layer's transition, as CSS uses the destination style's). Keyframe animations are always `enter`.
 * - Times in ms; `timing` is the CSS timing function as Chromium serialises it (keywords, cubic-bezier(), steps()).
 * - Keyframes: `restart` false when the layer keeps the running animation and only changes its play state or timing.
 *   `name` null with no keyframes: the trigger layer sets `animation-name: none`, so the element's animations (of
 *   `properties`) stop while it holds and start again when it stops holding.
 * - Transitions: `name` null, `iterations` 1, `direction` normal, `fillMode` none, `playState` running, `restart` true, no keyframes.
 */
export interface IrAnim {
  kind: 'transition' | 'keyframes';
  trigger: string;
  phase: 'enter' | 'leave';
  name: string | null;
  properties: string[];
  duration: number;
  delay: number;
  timing: string;
  iterations: number | 'infinite';
  direction: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
  fillMode: 'none' | 'forwards' | 'backwards' | 'both';
  playState: 'running' | 'paused';
  restart: boolean;
  keyframes: IrKeyframe[];
}
export interface IrNode {
  id: string; kind: NodeKind; external: boolean; classes: string[]; style: StyleLayers;
  text: IrText | null;
  /** Content image or svg. */
  asset: IrAsset | null;
  /**
   * The base layer's background image: a url() image or the baked SVG of its CSS gradients (several gradients are
   * one SVG, painted in CSS order; its size is the element's border box at the reference viewport, the gradient laid
   * out for the padding box). `background-image` stays in the style layers only for url() images and none (their
   * size, repeat and position stay there too); gradients appear only here.
   */
  background: IrAsset | null;
  /**
   * Layer key (as in `style`) → the background image while exactly that layer holds, when it differs from what the
   * layers inside it give (another gradient or image, a gradient re-baked for the layer's box); null: no image.
   */
  backgroundLayers: Record<string, IrAsset | null>;
  /** The base layer's outer box-shadows, all baked into one 9-slice image; `box-shadow` never appears in `style`. */
  shadow: IrShadow | null;
  /** Layer key → the outer shadow while exactly that layer holds, when it differs (e.g. a hover lift); null: none. */
  shadowLayers: Record<string, IrShadow | null>;
  /** The base layer's inset box-shadows, baked into one 9-slice image for the padding box. */
  insetShadow: IrShadow | null;
  /** Layer key → the inset shadow while exactly that layer holds, when it differs; null: none. */
  insetShadowLayers: Record<string, IrShadow | null>;
  /** Text in attributes (placeholder, title, alt, aria-label), each with its own key. */
  attrTexts: Record<string, IrText>;
  /** Form controls: the pseudo-states the markup starts in (disabled/checked attributes); null for other elements. */
  initial: { disabled: boolean; checked: boolean } | null;
  /**
   * Input nodes only (absent elsewhere): the text field's form, a password field (masked value) or a text area (several
   * lines), and its ::placeholder colour (null without a placeholder attribute).
   */
  field?: { password: boolean; multiline: boolean; placeholderColor: string | null };
  bind: string | null; action: string | null;
  /** On the container of a data-u-repeat list: its only child is the template (the first sample); `count` = items in the design. */
  repeat: { name: string; mode: 'list' | 'inline'; count: number } | null;
  anims: IrAnim[]; children: IrNode[];
}
export interface IrScreen {
  irVersion: 1; screen: string; source: { path: string; sha256: string };
  referenceViewport: [number, number]; viewports: [number, number][]; screenMatch: number; states: string[];
  breakpoints: { name: string; minWidth?: number; maxWidth?: number; minAspect?: number; maxAspect?: number }[];
  tokens: Record<string, string>;
  fonts: { locale: string; family: string; file: string; sha256: string; weight: number }[];
  root: IrNode;
}
