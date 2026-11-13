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
/** `tint`: an SVG painted with currentColor, written white; the compiler tints it with the node's `color` in each layer. */
export interface IrAsset { kind: 'image' | 'svg' | 'shadow9'; file: string; sha256: string; width: number; height: number; slice: [number, number, number, number] | null; tint: boolean }
export interface BoxRect { x: number; y: number; w: number; h: number }
/** One keyframe: offset 0..1, the values it sets, and the easing of the segment that starts here (null: the animation's). */
export interface IrKeyframe { offset: number; values: StyleMap; easing: string | null }
/**
 * A transition or a keyframe animation, played by the Unity animation player.
 * - trigger: `show` (the screen opens) or a layer key (see StyleLayers): the animation runs when that layer starts to hold.
 * - phase: `enter` runs when the trigger becomes active, `leave` when it ends (a transition's leave uses the base
 *   layer's transition, as CSS uses the destination style's). Keyframe animations are always `enter`.
 * - Times in ms; `timing` is the CSS timing function as Chromium serialises it (keywords, cubic-bezier(), steps()).
 * - Keyframes: `restart` false when the layer keeps the running animation and only changes its play state or timing.
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
  /** Baked gradient (SVG). */
  background: IrAsset | null;
  /** Baked 9-slice shadow; offset is relative to the element, in device-independent CSS px. */
  shadow: (IrAsset & { offset: BoxRect }) | null;
  /** Text in attributes (placeholder, title, alt, aria-label), each with its own key. */
  attrTexts: Record<string, IrText>;
  /** Form controls: the pseudo-states the markup starts in (disabled/checked attributes); null for other elements. */
  initial: { disabled: boolean; checked: boolean } | null;
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
