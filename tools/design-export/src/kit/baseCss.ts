import type { TextStyle } from "../lint/text-styles.js";

/**
 * The kit base stylesheet (design-kit/base.css): copied unchanged to the top of every screen's style, so a design starts
 * from what the compiler and UI Toolkit start from. It writes out every browser default the lint's U-CSS-026 would
 * report (margins, paddings and borders of body, headings, lists and controls, link colour and underline, native
 * control look, the placeholder colour), sizes boxes as UI Toolkit does (border-box), sets the kit font and the label
 * text style as the page default, and gives each kit text style a class (`.text-<style>`). Grayscale font smoothing
 * on the root keeps macOS browsers from thickening glyph stems, which UI Toolkit does not do either.
 *
 * Its first and last lines are markers: kit build keeps the block identical in every kit component and fixture.
 */
export const KIT_BASE_BEGIN = "/* kit-base: begin";
export const KIT_BASE_END = "/* kit-base: end */";

/** Elements whose browser margins, paddings or borders the reset clears (the allowed HTML elements that have any). */
const BOX_RESET = ["body", "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "label", "section", "header",
  "footer", "nav", "main", "aside", "article", "button", "input", "textarea", "select", "img", "svg"];

export function renderBaseCss(styles: readonly TextStyle[]): string {
  const page = styles.find((s) => s.name === "label") ?? styles.find((s) => s.weight === 400) ?? styles[0];
  if (!page) throw new Error("text-styles.json has no text style");
  const lines = [
    `${KIT_BASE_BEGIN} (design kit base stylesheet; copy it unchanged to the top of every screen's style) */`,
    ":root { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }",
    "*, *::before, *::after { box-sizing: border-box; }",
    "body { margin: 0; }",
    `${BOX_RESET.join(", ")} { margin: 0; padding: 0; border: 0; }`,
    `body { font-family: var(--font-ui); font-size: ${page.fontSize}px; line-height: ${page.lineHeight}px; font-weight: ${page.weight}; color: var(--color-text-primary); }`,
    "h1, h2, h3, h4, h5, h6 { font-size: inherit; line-height: inherit; font-weight: inherit; }",
    "b, strong { font-weight: 700; }",
    "ul, ol { list-style: none; }",
    "a { color: inherit; text-decoration: none; }",
    "button, input, textarea, select { appearance: none; background-color: transparent; color: inherit; font-family: inherit; font-size: inherit; line-height: inherit; font-weight: inherit; letter-spacing: inherit; word-spacing: inherit; text-align: inherit; }",
    "textarea { resize: none; }",
    "::placeholder { color: var(--color-text-muted); }",
    ...styles.map((s) => `.text-${s.name} { font-size: ${s.fontSize}px; line-height: ${s.lineHeight}px; font-weight: ${s.weight}; }`),
    KIT_BASE_END,
  ];
  return lines.join("\n") + "\n";
}

/** The page with its kit base block replaced by `base` (trimmed); null when the page has no block. */
export function withBaseBlock(html: string, base: string): string | null {
  const start = html.indexOf(KIT_BASE_BEGIN);
  const end = html.indexOf(KIT_BASE_END, start);
  if (start < 0 || end < 0) return null;
  return html.slice(0, start) + base.trim() + html.slice(end + KIT_BASE_END.length);
}
