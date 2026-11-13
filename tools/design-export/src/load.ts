import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import type { KitConfig } from "./kit.js";
import { logicalViewport } from "./viewport.js";

export interface DcDynamic {
  kind: "hole" | "sc-for" | "sc-if" | "dc-import" | "x-import" | "script-ui" | "data-props" | "outside-x-dc" | "no-x-dc";
  detail: string;
}

export interface LoadedDesign {
  browser: Browser;
  page: Page;
  cdp: CDPSession;
  blocked: { url: string; type: string }[];
  /** Design-origin requests that 404ed (missing local assets); lint turns each into an error. */
  missing: string[];
  /** Blob ids the page references that blobs.json does not map (.dc.html input only). */
  unresolvedBlobs: string[];
  /** Dynamic Design Component features found while unwrapping (.dc.html input only). */
  dynamic: DcDynamic[];
  /** Closes the page and its context; closes the browser only when openDesign launched it. */
  close(): Promise<void>;
}

/** Synthetic origin the design is served from; kit files live under KIT_PREFIX. */
export const DESIGN_ORIGIN = "http://design.local";
export const KIT_PREFIX = "/__kit/";
const ORIGIN = DESIGN_ORIGIN;

const decodeEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Static view of a Claude Design Component page (spec 5.5). Dynamic features are reported, never executed. */
export function unwrapDcHtml(source: string, blobs: Record<string, string>): { html: string; dynamic: DcDynamic[]; unresolvedBlobs: string[] } {
  const dynamic: DcDynamic[] = [];
  const unresolved = new Set<string>();

  // the DC script block (data-props + script text)
  const dcScript = /<script\b[^>]*type\s*=\s*["']text\/x-dc["'][^>]*>([\s\S]*?)<\/script>/i.exec(source);
  if (dcScript) {
    const props = /data-props\s*=\s*(?:'([^']*)'|"([^"]*)")/i.exec(dcScript[0]);
    if (props) {
      let parsed: unknown;
      try { parsed = JSON.parse(decodeEntities(props[1] ?? props[2] ?? "")); } catch { parsed = undefined; }
      if (parsed && typeof parsed === "object") {
        for (const key of Object.keys(parsed)) if (key !== "$preview") dynamic.push({ kind: "data-props", detail: key });
      } else dynamic.push({ kind: "data-props", detail: "unparsable data-props" });
    }
    const ui = /createElement|innerHTML|outerHTML|appendChild|insertAdjacentHTML|append\(|prepend\(|document\.write/.exec(dcScript[1]);
    if (ui) dynamic.push({ kind: "script-ui", detail: ui[0] });
  }

  const xdc = /<x-dc\b[^>]*>([\s\S]*)<\/x-dc>/i.exec(source);
  let inner = xdc ? xdc[1] : "";
  let helmet = "";
  inner = inner.replace(/<helmet\b[^>]*>([\s\S]*?)<\/helmet>/gi, (_m, h: string) => { helmet += h; return ""; });

  if (!xdc) dynamic.push({ kind: "no-x-dc", detail: "no <x-dc> element: the artboard would render empty" });
  // content outside <x-dc> is not part of the artboard: report it instead of dropping it silently
  const rest = xdc ? source.replace(xdc[0], "") : source;
  if (/<helmet\b/i.test(rest)) dynamic.push({ kind: "outside-x-dc", detail: "<helmet> outside <x-dc>" });
  const bodyRest = (/<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(rest)?.[1] ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<helmet\b[\s\S]*?<\/helmet>/gi, "").trim();
  if (bodyRest) dynamic.push({ kind: "outside-x-dc", detail: bodyRest.slice(0, 80) });

  const headSrc0 = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(source)?.[1] ?? "";
  for (const m of (inner + helmet + headSrc0).matchAll(/\{\{[^}]*\}\}/g)) dynamic.push({ kind: "hole", detail: m[0] });
  for (const kind of ["sc-for", "sc-if", "dc-import", "x-import"] as const) {
    for (const m of inner.matchAll(new RegExp(`<${kind}\\b[^>]*>`, "gi"))) dynamic.push({ kind, detail: m[0] });
  }

  // original head minus the runtime script
  const headSrc = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(source)?.[1] ?? "";
  const head = headSrc.replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*support\.js["'][^>]*>\s*<\/script>/gi, "");

  // the id may carry an extension (/_blob/abc.png): the mapped file replaces the whole reference
  const rewrite = (s: string) =>
    s.replace(/\/_blob\/([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9]+)?/g, (m, id: string) => {
      if (Object.prototype.hasOwnProperty.call(blobs, id)) return blobs[id].split("/").map(encodeURIComponent).join("/");
      unresolved.add(id);
      return m;
    });
  const html = `<!doctype html><html><head>${rewrite(head)}${rewrite(helmet)}</head><body>${rewrite(inner)}</body></html>`;
  return { html, dynamic, unresolvedBlobs: Array.from(unresolved) };
}

/**
 * Every font family named in the computed font stack of rendered text (elements with direct text, ::before/::after
 * content and input placeholders). Limit: glyph-level fallback is invisible here. A kit family that lacks a glyph
 * silently falls back to a system font, so lint must also check glyph coverage of the kit fonts for the used text.
 */
export async function usedFamilies(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    const add = (stack: string) => {
      for (const f of stack.split(",")) {
        const name = f.trim().replace(/^["']|["']$/g, "");
        if (name) out.add(name);
      }
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body, body *"))) {
      if (Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "")) add(getComputedStyle(el).fontFamily);
      if ((el as HTMLInputElement).placeholder) add(getComputedStyle(el, "::placeholder").fontFamily);
      for (const pseudo of ["::before", "::after"]) {
        const c = getComputedStyle(el, pseudo).content;
        if (c && c !== "none" && c !== "normal" && c !== '""') add(getComputedStyle(el, pseudo).fontFamily);
      }
    }
    return Array.from(out).sort();
  });
}

/** `weight` and `style` are the face descriptors as declared ("" when absent: normal). */
export interface DeclaredFontFace { family: string; src: string | null; sheet: string | null; fromKit: boolean; weight: string; style: string }

/** Every font face the page declares (stylesheet @font-face rules, including @import-ed sheets, and script-added FontFace objects). */
export async function declaredFontFaces(page: Page, kit?: KitConfig): Promise<DeclaredFontFace[]> {
  const kitSheet = `${ORIGIN}${KIT_PREFIX}${kit?.fontsCss ?? "fonts/fonts.css"}`;
  return page.evaluate((kitSheetUrl) => {
    const out: { family: string; src: string | null; sheet: string | null; fromKit: boolean; weight: string; style: string }[] = [];
    const strip = (v: string) => v.trim().replace(/^["']|["']$/g, "");
    const walk = (sheet: CSSStyleSheet) => {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { return; }
      walkRules(rules, sheet);
    };
    const walkRules = (rules: CSSRuleList, sheet: CSSStyleSheet) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSFontFaceRule) {
          out.push({
            family: strip(r.style.getPropertyValue("font-family")), src: r.style.getPropertyValue("src"), sheet: sheet.href, fromKit: sheet.href === kitSheetUrl,
            weight: r.style.getPropertyValue("font-weight"), style: r.style.getPropertyValue("font-style"),
          });
        } else if (r instanceof CSSImportRule) { if (r.styleSheet) walk(r.styleSheet); }
        else if ("cssRules" in r) walkRules((r as CSSGroupingRule).cssRules, sheet); // @media, @supports, @layer
      }
    };
    for (const s of Array.from(document.styleSheets)) walk(s);
    // Faces in document.fonts beyond the @font-face rules of the same family were added by script: report each one
    // (never dedup by name; a script face called like a kit family is still not from the kit).
    const ruleCount = new Map<string, number>();
    for (const o of out) ruleCount.set(o.family, (ruleCount.get(o.family) ?? 0) + 1);
    const docCount = new Map<string, number>();
    for (const f of Array.from(document.fonts)) {
      const fam = strip(f.family);
      const n = (docCount.get(fam) ?? 0) + 1;
      docCount.set(fam, n);
      if (n > (ruleCount.get(fam) ?? 0)) out.push({ family: fam, src: null, sheet: null, fromKit: false, weight: f.weight, style: f.style });
    }
    return out;
  }, kitSheet);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
};

/** The static-capture freeze rule the loader adds twice (served head and addStyleTag); lint skips these sheets. */
export const STATIC_CSS =
  "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;" +
  "animation-fill-mode:both!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}";
const STATIC_STYLE = `<style>${STATIC_CSS}</style>`;

/** Resolves once the DOM has not changed for 50 ms (at most 2 s). A string, so no transpiler helper reaches the page. */
const QUIET_JS = `new Promise((resolve) => {
  let idle;
  const done = () => { mo.disconnect(); clearTimeout(idle); clearTimeout(cap); resolve(); };
  const mo = new MutationObserver(() => { clearTimeout(idle); idle = setTimeout(done, 50); });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  idle = setTimeout(done, 50);
  const cap = setTimeout(done, 2000);
})`;

function inject(html: string, kit: KitConfig): string {
  const links =
    `<link rel="stylesheet" href="${KIT_PREFIX}${kit.fontsCss}">` +
    `<link rel="stylesheet" href="${KIT_PREFIX}${kit.tokensCss}">`;
  let out: string;
  const head = /<head\b[^>]*>/i.exec(html);
  const root = /<html\b[^>]*>/i.exec(html);
  if (head) out = html.slice(0, head.index + head[0].length) + links + html.slice(head.index + head[0].length);
  else if (root) out = html.slice(0, root.index + root[0].length) + `<head>${links}</head>` + html.slice(root.index + root[0].length);
  else out = `<head>${links}</head>` + html;
  // the no-animation style goes last in head so no design rule can override it
  const close = out.search(/<\/head>/i);
  return close >= 0 ? out.slice(0, close) + STATIC_STYLE + out.slice(close) : out + STATIC_STYLE;
}

function within(root: string, rel: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  const p = path.resolve(root, "." + path.posix.normalize("/" + decoded));
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

export async function openDesign(
  htmlPath: string,
  kit: KitConfig,
  viewport: [number, number],
  existingBrowser?: Browser,
): Promise<LoadedDesign> {
  const file = path.resolve(htmlPath);
  const designDir = path.dirname(file);
  const name = path.basename(file);

  // everything that can fail on disk runs before a browser is launched
  let source = fs.readFileSync(file, "utf8");
  let unresolvedBlobs: string[] = [];
  let dynamic: DcDynamic[] = [];
  if (name.endsWith(".dc.html")) {
    const blobsFile = path.join(designDir, "blobs.json");
    const blobs = fs.existsSync(blobsFile) ? JSON.parse(fs.readFileSync(blobsFile, "utf8")) : {};
    const un = unwrapDcHtml(source, blobs);
    source = un.html;
    unresolvedBlobs = un.unresolvedBlobs;
    dynamic = un.dynamic;
  }
  const pageHtml = inject(source, kit);
  const lv = logicalViewport(viewport, kit.reference, kit.screenMatch);

  const ownBrowser = !existingBrowser;
  const browser = existingBrowser ?? (await chromium.launch());
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      viewport: { width: Math.round(lv.width), height: Math.round(lv.height) },
      deviceScaleFactor: lv.scale,
      serviceWorkers: "block",
      reducedMotion: "reduce",
    });
    const blocked: { url: string; type: string }[] = [];
    const missing: string[] = [];
    const allowedOrigins = new Set(kit.allowedScriptOrigins.map((o) => new URL(o).origin));

    await context.route("**/*", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin === ORIGIN) {
        let decoded: string | null = null;
        try { decoded = decodeURIComponent(url.pathname); } catch { /* malformed escape: 404 */ }
        if (decoded === "/" + name) return route.fulfill({ status: 200, contentType: MIME[".html"], body: pageHtml });
        let target: string | null = null;
        if (decoded !== null) {
          target = url.pathname.startsWith(KIT_PREFIX)
            ? within(kit.dir, url.pathname.slice(KIT_PREFIX.length))
            : within(designDir, url.pathname.slice(1));
        }
        if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
          // cacheable: without it CDP CSS.enable (lint) re-requests every linked stylesheet and stalls 5 s per page
          return route.fulfill({
            status: 200, contentType: MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
            headers: { "cache-control": "max-age=3600" }, body: fs.readFileSync(target),
          });
        }
        if (url.pathname !== "/favicon.ico") missing.push(decoded ?? url.pathname);
        return route.fulfill({ status: 404, body: "not found" });
      }
      if (req.resourceType() === "script" && allowedOrigins.has(url.origin)) {
        // fetched outside the page so the synthetic design origin does not trip CORS/private-network checks;
        // no redirects (they could leave the allowed origin) and only JavaScript is accepted
        try {
          const res = await route.fetch({ maxRedirects: 0 });
          const type = res.headers()["content-type"] ?? "";
          if (res.status() >= 200 && res.status() < 300 && /javascript|ecmascript/i.test(type)) return await route.fulfill({ response: res });
        } catch { /* fall through to blocked */ }
      }
      blocked.push({ url: req.url(), type: req.resourceType() });
      return route.abort();
    });

    // tsx (esbuild keepNames) wraps functions passed to page.evaluate in __name(); give every page a no-op one
    await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto(`${ORIGIN}/${encodeURIComponent(name)}`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    // scripts (e.g. React from an allowed CDN) may still be committing after load: wait until the DOM is quiet
    await page.evaluate(QUIET_JS);
    // static capture: finish anything already running, keep the no-animation style last in head
    await page.addStyleTag({ content: STATIC_CSS });
    await page.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* infinite */ } }));

    const ctx = context;
    return {
      browser, page, cdp, blocked, missing, unresolvedBlobs, dynamic,
      async close() {
        await ctx.close();
        if (ownBrowser) await browser.close();
      },
    };
  } catch (e) {
    await context?.close().catch(() => {});
    if (ownBrowser) await browser.close().catch(() => {});
    throw e;
  }
}
