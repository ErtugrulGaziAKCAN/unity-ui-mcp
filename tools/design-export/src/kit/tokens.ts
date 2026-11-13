import fs from "node:fs";
import path from "node:path";
import type { KitConfig } from "../kit.js";
import { CSS_SUPPORT_DATA } from "../lint/allowed-css.js";

/**
 * The kit's tokens (tokens.css): one custom property per line on :root, its usage note as the trailing comment. The
 * name prefix sets the family the Claude Design System lists it under. Values are literals: the same name and value
 * then mean the same thing in the exporter, in Unity (DesignTokens.uss) and in the design system's tokens.json.
 */
export type TokenFamily = "color" | "spacing" | "radius" | "shadow" | "font";
export interface KitToken { name: string; value: string; usage: string; family: TokenFamily }

export const TOKEN_PREFIXES: ReadonlyArray<[string, TokenFamily]> = [
  ["color-", "color"], ["space-", "spacing"], ["radius-", "radius"], ["shadow-", "shadow"], ["font-", "font"],
];

/** Colour keywords lint accepts in designs; a token value must not be one (the design system drops named colours). */
const NAMED = new Set(CSS_SUPPORT_DATA.colors.keywords.map((k) => k.toLowerCase()));

export function parseTokensCss(css: string): KitToken[] {
  const body = /:root\s*\{([\s\S]*)\}/.exec(css)?.[1];
  if (body === undefined) throw new Error("tokens.css: no :root { … } block");
  const out: KitToken[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/--([A-Za-z0-9_-]+)\s*:\s*([^;]*);[ \t]*(?:\/\*\s*([\s\S]*?)\s*\*\/)?/g)) {
    const [, name, raw, usage] = m;
    const value = raw.trim();
    const family = TOKEN_PREFIXES.find(([p]) => name.startsWith(p))?.[1];
    if (!family) throw new Error(`tokens.css: --${name} has no known prefix (${TOKEN_PREFIXES.map(([p]) => p).join(", ")})`);
    if (seen.has(name)) throw new Error(`tokens.css: --${name} is declared twice`);
    seen.add(name);
    if (/var\(/i.test(value)) throw new Error(`tokens.css: --${name} uses var(); write the literal value`);
    if (family === "color" && NAMED.has(value.toLowerCase())) throw new Error(`tokens.css: --${name} is a named colour (${value}); write it as hex or rgb()/rgba()`);
    if (!usage?.trim()) throw new Error(`tokens.css: --${name} needs a usage note as its trailing comment`);
    out.push({ name, value, usage: usage.replace(/\s+/g, " ").trim(), family });
  }
  return out;
}

export const readKitTokens = (kit: KitConfig): KitToken[] => parseTokensCss(fs.readFileSync(path.join(kit.dir, kit.tokensCss), "utf8"));
