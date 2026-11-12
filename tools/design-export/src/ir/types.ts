export type NodeKind = 'container' | 'text' | 'image' | 'vector' | 'button' | 'toggle' | 'input' | 'dropdown' | 'scroll' | 'list';
/** CSS property -> specified value (var() and rem resolved). */
export type StyleMap = Record<string, string>;
/** Keys: base|hover|active|focus|disabled|checked|bp:<n>|state:<n>. */
export type StyleLayers = Record<string, StyleMap>;
export interface IrText { key: string | null; tr: string; en: string | null; args: string[]; rich: boolean }
export interface IrAsset { kind: 'image' | 'svg' | 'shadow9'; file: string; sha256: string; width: number; height: number; slice: [number, number, number, number] | null }
export interface BoxRect { x: number; y: number; w: number; h: number }
export interface IrNode {
  id: string; kind: NodeKind; external: boolean; classes: string[]; style: StyleLayers;
  text: IrText | null;
  /** Content image or svg. */
  asset: IrAsset | null;
  /** Baked gradient (SVG). */
  background: IrAsset | null;
  /** Baked 9-slice shadow; offset is relative to the element, in device-independent CSS px. */
  shadow: (IrAsset & { offset: BoxRect }) | null;
  bind: string | null; action: string | null;
  repeat: { name: string; mode: 'list' | 'inline' } | null;
  anims: unknown[]; children: IrNode[];
}
export interface IrScreen {
  irVersion: 1; screen: string; source: { path: string; sha256: string };
  referenceViewport: [number, number]; viewports: [number, number][]; screenMatch: number; states: string[];
  breakpoints: { name: string; minWidth?: number; maxWidth?: number; minAspect?: number; maxAspect?: number }[];
  tokens: Record<string, string>;
  fonts: { locale: string; family: string; file: string; sha256: string; weight: number }[];
  root: IrNode;
}
