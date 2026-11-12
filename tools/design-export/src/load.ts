import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import type { KitConfig } from "./kit.js";
import { logicalViewport } from "./viewport.js";

export interface DcDynamic {
  kind: "hole" | "sc-for" | "sc-if" | "dc-import" | "x-import" | "script-ui" | "data-props";
  detail: string;
}

export interface LoadedDesign {
  browser: Browser;
  page: Page;
  cdp: CDPSession;
  blocked: { url: string; type: string }[];
  /** Closes the page and its context; closes the browser only when openDesign launched it. */
  close(): Promise<void>;
}

const ORIGIN = "http://design.local";
const KIT_PREFIX = "/__kit/";

const decodeEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Static view of a Claude Design Component page (spec 5.5). Dynamic features are reported, never executed. */
export function unwrapDcHtml(source: string, blobs: Record<string, string>): { html: string; dynamic: DcDynamic[] } {
  const dynamic: DcDynamic[] = [];

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

  for (const m of inner.matchAll(/\{\{[^}]*\}\}/g)) dynamic.push({ kind: "hole", detail: m[0] });
  for (const kind of ["sc-for", "sc-if", "dc-import", "x-import"] as const) {
    for (const m of inner.matchAll(new RegExp(`<${kind}\\b[^>]*>`, "gi"))) dynamic.push({ kind, detail: m[0] });
  }

  // original head minus the runtime script
  const headSrc = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(source)?.[1] ?? "";
  const head = headSrc.replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*support\.js["'][^>]*>\s*<\/script>/gi, "");

  const rewrite = (s: string) => s.replace(/\/_blob\/([A-Za-z0-9_-]+)/g, (m, id: string) => blobs[id] ?? m);
  const html = `<!doctype html><html><head>${rewrite(head)}${rewrite(helmet)}</head><body>${rewrite(inner)}</body></html>`;
  return { html, dynamic };
}

/** Font families actually requested by rendered text (first family of each computed font-family). */
export async function usedFamilies(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body, body *"))) {
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
      if (!hasText) continue;
      const first = getComputedStyle(el).fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
      out.add(first);
    }
    return Array.from(out).sort();
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
};

const STATIC_STYLE =
  "<style>*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important}</style>";

function inject(html: string, kit: KitConfig): string {
  const links =
    `<link rel="stylesheet" href="${KIT_PREFIX}${kit.fontsCss}">` +
    `<link rel="stylesheet" href="${KIT_PREFIX}${kit.tokensCss}">`;
  const block = links + STATIC_STYLE;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + block + html.slice(head.index + head[0].length);
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + `<head>${block}</head>` + html.slice(root.index + root[0].length);
  return block + html;
}

function within(root: string, rel: string): string | null {
  const p = path.resolve(root, "." + path.posix.normalize("/" + decodeURIComponent(rel)));
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
  const ownBrowser = !existingBrowser;
  const browser = existingBrowser ?? (await chromium.launch());

  let source = fs.readFileSync(file, "utf8");
  if (name.endsWith(".dc.html")) {
    const blobsFile = path.join(designDir, "blobs.json");
    const blobs = fs.existsSync(blobsFile) ? JSON.parse(fs.readFileSync(blobsFile, "utf8")) : {};
    source = unwrapDcHtml(source, blobs).html;
  }
  const pageHtml = inject(source, kit);

  const lv = logicalViewport(viewport, kit.reference, kit.screenMatch);
  const context: BrowserContext = await browser.newContext({
    viewport: { width: Math.round(lv.width), height: Math.round(lv.height) },
    deviceScaleFactor: lv.scale,
  });
  const blocked: { url: string; type: string }[] = [];
  const allowedOrigins = new Set(kit.allowedScriptOrigins.map((o) => new URL(o).origin));

  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === ORIGIN) {
      let target: string | null;
      if (url.pathname === "/" + name) return route.fulfill({ status: 200, contentType: MIME[".html"], body: pageHtml });
      if (url.pathname.startsWith(KIT_PREFIX)) target = within(kit.dir, url.pathname.slice(KIT_PREFIX.length));
      else target = within(designDir, url.pathname.slice(1));
      if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
        return route.fulfill({ status: 200, contentType: MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream", body: fs.readFileSync(target) });
      }
      return route.fulfill({ status: 404, body: "not found" });
    }
    if (req.resourceType() === "script" && allowedOrigins.has(url.origin)) {
      // fetched outside the page so the synthetic design origin does not trip CORS/private-network checks
      return route.fulfill({ response: await route.fetch() });
    }
    blocked.push({ url: req.url(), type: req.resourceType() });
    return route.abort();
  });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(`${ORIGIN}/${encodeURIComponent(name)}`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  return {
    browser,
    page,
    cdp,
    blocked,
    async close() {
      await context.close();
      if (ownBrowser) await browser.close();
    },
  };
}
