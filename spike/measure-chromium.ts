// M0 spike: measure a fixture in Chromium (Playwright). Usage:
//   npx tsx spike/measure-chromium.ts <fixture.html> <outDir>
//   npx tsx spike/measure-chromium.ts --all <outRoot>
// Outputs per fixture: chromium.png, chromium-boxes.json (+ chromium-hover/active.png and boxes
// when the fixture has [data-force] elements). Viewport 2560x1440, deviceScaleFactor 1.
import { chromium, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const W = 2560, H = 1440;
const here = path.dirname(fileURLToPath(import.meta.url));

interface Rect { x: number; y: number; w: number; h: number }
interface Boxes {
  fixture: string; state: string; viewport: [number, number]; chromium: string;
  elements: Array<{ id: string } & Rect & { text?: { lines: Rect[]; baseline: number | null; lineBoxHeight: number | null; content: string } }>;
}

async function collect(page: Page, fixture: string, state: string): Promise<Boxes> {
  const elements = await page.evaluate(() => {
    const r = (b: DOMRect) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
    const out: any[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[id]'))) {
      const entry: any = { id: el.id, ...r(el.getBoundingClientRect()) };
      const textNodes = Array.from(el.childNodes).filter(n => n.nodeType === 3 && (n.textContent ?? '').trim() !== '') as Text[];
      if (textNodes.length) {
        // line rects: group Range client rects by top (one rect per line fragment)
        const rects: DOMRect[] = [];
        for (const tn of textNodes) { const rg = document.createRange(); rg.selectNodeContents(tn); rects.push(...Array.from(rg.getClientRects())); }
        const lines: any[] = [];
        for (const b of rects.sort((a, c) => a.top - c.top || a.left - c.left)) {
          const last = lines[lines.length - 1];
          if (last && Math.abs(last.y - b.top) < 0.5) { const right = Math.max(last.x + last.w, b.right); last.x = Math.min(last.x, b.left); last.w = right - last.x; last.h = Math.max(last.h, b.height); }
          else lines.push({ x: b.left, y: b.top, w: b.width, h: b.height });
        }
        // baseline of the first line: bottom of a zero-size inline-block probe at the start of the text
        const probe = document.createElement('span');
        probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        el.insertBefore(probe, el.firstChild);
        const baseline = probe.getBoundingClientRect().bottom;
        probe.remove();
        // line box height: distance between consecutive line tops, else element content height
        const cs = getComputedStyle(el);
        const contentH = el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
        const lineBoxHeight = lines.length > 1 ? (lines[lines.length - 1].y - lines[0].y) / (lines.length - 1) : contentH;
        entry.text = { lines, baseline, lineBoxHeight, content: textNodes.map(n => n.textContent).join('') };
      }
      out.push(entry);
    }
    return out;
  });
  return { fixture, state, viewport: [W, H], chromium: await page.evaluate(() => navigator.userAgent), elements };
}

function pngSize(file: string): [number, number] {
  const b = fs.readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

export async function measure(browser: import('playwright').Browser, fixtureFile: string, outDir: string): Promise<string[]> {
  const fixture = path.basename(fixtureFile, '.html');
  fs.mkdirSync(outDir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.addInitScript('window.__name = window.__name || ((f) => f);'); // tsx/esbuild keepNames helper
  const problems: string[] = [];
  // no network: only file:// is allowed
  await page.route(u => !u.toString().startsWith('file://'), r => r.abort());
  await page.goto(pathToFileURL(path.resolve(fixtureFile)).href);
  await page.evaluate(() => document.fonts.ready);
  const fontState = await page.evaluate(() => Array.from(document.fonts).map(f => `${f.family}/${f.weight}:${f.status}`));
  const usedFamilies = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('*')).map(e => getComputedStyle(e).fontFamily))));
  for (const f of fontState) if (f.endsWith(':error')) problems.push(`font failed: ${f}`);
  const hasText = await page.evaluate(() => (document.body.innerText ?? '').trim() !== '');
  if (hasText && !fontState.some(f => f.endsWith(':loaded'))) problems.push(`no font loaded (${fontState.join(', ')}; used ${usedFamilies.join(' | ')})`);

  const dump = async (state: string, png: string, json: string) => {
    await page.screenshot({ path: path.join(outDir, png), fullPage: false });
    fs.writeFileSync(path.join(outDir, json), JSON.stringify(await collect(page, fixture, state), null, 2) + '\n');
    const [w, h] = pngSize(path.join(outDir, png));
    if (w !== W || h !== H) problems.push(`${png} is ${w}x${h}`);
  };
  await dump('default', 'chromium.png', 'chromium-boxes.json');

  if (await page.locator('[data-force]').count() > 0) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-force]' });
    for (const [state, pseudo] of [['hover', ['hover']], ['active', ['hover', 'active']]] as const) {
      for (const nodeId of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [...pseudo] });
      await dump(state, `chromium-${state}.png`, `chromium-${state}-boxes.json`);
      for (const nodeId of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    }
  }

  // every id in the fixture source must appear in every boxes file
  const srcIds = Array.from(fs.readFileSync(fixtureFile, 'utf8').matchAll(/\sid="([^"]+)"/g), m => m[1]);
  for (const f of fs.readdirSync(outDir).filter(n => n.endsWith('-boxes.json'))) {
    const got = new Set((JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')) as Boxes).elements.map(e => e.id));
    const missing = srcIds.filter(i => !got.has(i));
    if (missing.length) problems.push(`${f} missing ids: ${missing.join(', ')}`);
  }
  await ctx.close();
  return problems.map(p => `${fixture}: ${p}`);
}

async function main() {
  const args = process.argv.slice(2);
  const browser = await chromium.launch();
  let problems: string[] = [];
  if (args[0] === '--all') {
    const outRoot = args[1] ?? path.join(here, 'out', 'chromium');
    const dir = path.join(here, 'fixtures');
    const files = fs.readdirSync(dir).filter(n => /^f\d\d-.*\.html$/.test(n)).sort();
    for (const f of files) {
      const p = await measure(browser, path.join(dir, f), path.join(outRoot, path.basename(f, '.html')));
      console.log(`${p.length ? 'FAIL' : 'ok  '} ${f}`);
      problems.push(...p);
    }
    console.log(`${files.length} fixtures, ${problems.length} problems`);
  } else if (args.length === 2) {
    problems = await measure(browser, args[0], args[1]);
  } else {
    console.error('usage: measure-chromium.ts <fixture.html> <outDir> | --all <outRoot>');
    process.exit(2);
  }
  console.log(`Chromium ${browser.version()}`);
  await browser.close();
  for (const p of problems) console.error(p);
  process.exit(problems.length ? 1 : 0);
}
main();
