/**
 * The fidelity report (spec §15): one HTML file with inline CSS and JS that works offline. Images are referenced by
 * relative paths (goldens in the export folder, Unity captures, difference images), so the report stays small and
 * opens straight from disk. Readable in light and dark mode; the capture list can be narrowed to failures.
 */
import fs from "node:fs";
import path from "node:path";
import type { CaptureVerdict, ElementIssue, ScreenVerdict, Thresholds } from "./compare.js";

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (n: number | null | undefined, d: number) => (n === null || n === undefined || Number.isNaN(n) ? "—" : n.toFixed(d));
const anchor = (i: number) => `cap-${i}`;

/** Relative URL from the report's folder to a file, each segment percent-encoded. */
function rel(fromDir: string, file: string): string {
  return path.relative(fromDir, file).split(path.sep).map(encodeURIComponent).join("/");
}

const STEP_ORDER = ["lint", "export", "import", "compile", "capture", "compare"];
const ms = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

const KIND_LABEL: Record<string, string> = {
  box: "box", missing: "missing", extra: "only in Unity", visibility: "visibility", lines: "line count", baseline: "baseline",
  color: "colour", edge: "edge, border, corner", ssim: "SSIM", ink: "text colour", inkCoverage: "text ink amount", shadow: "shadow band", size: "image size",
};

function thresholdRows(t: Thresholds): string {
  const lo = t.textInkRatio * (1 - t.textInkCoverage), hi = 1 + t.textInkCoverage;
  const rows: [string, string, string][] = [
    ["boxPx", `±${t.boxPx} px`, "every element's border box (x, y, width, height); only the design's elements, anything else Unity shows is an issue"],
    ["baselinePx", `±${t.baselinePx} px`, "same line count; every line's baseline (inputs and selects: lines not compared)"],
    ["deltaE2000", `≤ ${t.deltaE2000}`, "colour samples of painted backgrounds; edge, border and corner samples of elements that carry text; mean colour of each baked shadow's band (each sample against the closest Unity colour within 1 px)"],
    ["ssimNonText", `≥ ${t.ssimNonText}`, "SSIM of the whole capture, text element boxes and external regions copied from the design"],
    ["ssimElement", `≥ ${t.ssimElement}`, "SSIM per visible element of at least 16×16 px over its box joined with its baked shadow (an element that carries text: only its lines copied); when it fails, each block may use the Unity image offset by up to 1 px"],
    ["ssimElementSmall", t.ssimElementSmall.map(([area, v]) => `< ${area} px²: ≥ ${v}`).join(", ") || "—", "element SSIM of a small element whose box, colour, ring, ink and shadow checks all pass (SSIM over a few 8-px blocks is dominated by anti-aliased edges); measured on identical geometry"],
    ["ssimPicture", `≥ ${t.ssimPicture}`, "element SSIM of a raster picture drawn at another size than its own whose other checks all pass (UI Toolkit filters it in linear light, Chromium in sRGB); measured"],
    ["textInkDeltaE", `≤ ${t.textInkDeltaE}`, `text colour per line, from ${t.textInkFullPx} device px font size: median of the 10 % ink pixels most different from the background`],
    ["textInkDeltaESmall", t.textInkDeltaESmall.map(([px, de]) => `≥ ${px} px: ≤ ${de}`).join(", "), `text colour per line below ${t.textInkFullPx} device px, where no stem pixel is fully covered and the two renderers' anti-aliasing differs most; measured limits by font size`],
    ["textInkRatio", `${t.textInkRatio}`, "Unity's text ink amount relative to the design's for correct text (measured with smoothing-off designs)"],
    ["textInkCoverage", `±${Math.round(t.textInkCoverage * 100)} %`, `text ink amount per line: between ${lo.toFixed(2)}× and ${hi.toFixed(2)}× the design's`],
    ["textInkMedianTolerance", `±${Math.round(t.textInkMedianTolerance * 100)} %`, "text ink amount per line against the capture's median ratio of text of the same polarity (light on dark, dark on light), when it has 3 or more such lines"],
  ];
  return rows.map(([k, v, what]) => `<tr><th scope="row"><code>${k}</code></th><td class="num">${esc(v)}</td><td>${esc(what)}</td></tr>`).join("");
}

function timingRows(timings: Record<string, number>): string {
  const keys = [...STEP_ORDER, ...Object.keys(timings).filter((k) => !STEP_ORDER.includes(k)).sort()];
  return keys.map((k) => `<tr><th scope="row">${esc(k)}</th><td class="num">${typeof timings[k] === "number" ? esc(ms(timings[k])) : '<span class="muted" title="not measured in this run">—</span>'}</td></tr>`).join("");
}

function applied(c: CaptureVerdict): string {
  const i = c.info;
  if (!i) return "";
  const parts = [`state <b>${esc(i.state)}</b>`, `${i.viewport[0]}×${i.viewport[1]}`];
  for (const a of i.apply) parts.push(a.kind === "pseudo" ? `:${esc(a.pseudo)} on <code>${esc(a.elementId)}</code>` : `.${esc(a.name)} on <code>${esc(a.elementId)}</code>`);
  if (i.anim) parts.push(`animation of <code>${esc(i.anim.element)}</code> at ${esc(i.anim.time)} ms`);
  return parts.join(" · ");
}

const pct = (r: { x: number; y: number; w: number; h: number }, size: [number, number], pad = 0) =>
  `left:${((r.x - pad) / size[0]) * 100}%;top:${((r.y - pad) / size[1]) * 100}%;width:${((r.w + 2 * pad) / size[0]) * 100}%;height:${((r.h + 2 * pad) / size[1]) * 100}%`;

/** Issue outlines over a capture image (positions in % of the capture size). */
function outlines(issues: ElementIssue[], size: [number, number]): string {
  return issues.filter((i) => i.at).map((i) => `<div class="outline" style="${pct(i.at!, size, 2)}" title="${esc(`${i.id}: ${i.detail}`)}"></div>`).join("");
}

/** The masked regions (text, external) as translucent boxes. */
function maskBoxes(c: CaptureVerdict): string {
  return c.masked.map((r) => `<div class="maskbox" style="${pct(r, c.size)}"></div>`).join("");
}

function captureSection(c: CaptureVerdict, i: number, img: { golden: string; unity: string; diff: string | null }): string {
  const badge = c.pass ? '<span class="badge pass">PASS</span>' : '<span class="badge fail">FAIL</span>';
  const issues = c.issues.length
    ? `<table class="issues"><thead><tr><th>Element</th><th>Check</th><th>Detail</th></tr></thead><tbody>${c.issues.map((x) =>
      `<tr><td><code>${x.id === "*" ? "whole capture" : esc(x.id)}</code></td><td>${esc(KIND_LABEL[x.kind] ?? x.kind)}</td><td>${esc(x.detail)}</td></tr>`).join("")}</tbody></table>`
    : '<p class="muted">No issues.</p>';
  const rows = c.elements.map((r) => `<tr class="st-${r.status}"><td><code>${esc(r.id)}</code></td><td>${esc(r.status)}</td>` +
    `<td class="num">${r.box ? r.box.map((d) => (d >= 0 ? "+" : "") + d.toFixed(2)).join(" ") : "—"}</td>` +
    `<td class="num">${num(r.ssim, 5)}</td><td class="num">${num(r.ssimShifted, 5)}${r.ssimLimit !== null && r.ssimLimit !== undefined ? ` <span class="muted">(≥ ${r.ssimLimit})</span>` : ""}</td>` +
    `<td class="num">${r.samples === 0 ? '<span class="warn-text">not sampled</span>' : `${num(r.deltaE, 2)}${r.samples ? ` <span class="muted">(${r.samples})</span>` : ""}`}</td>` +
    `<td class="num">${num(r.edge, 2)}</td><td class="num">${num(r.band, 2)}</td><td class="num">${num(r.ink, 2)}</td><td class="num">${r.inkRatio === null ? "—" : `${r.inkRatio.toFixed(2)}×`}</td>` +
    `<td>${esc(r.lines ?? "—")}</td></tr>`).join("");
  const name = `v-${i}`;
  const views = [
    `<input type="radio" name="${name}" id="${name}-s" value="side" checked><label for="${name}-s">Side by side</label>`,
    `<input type="radio" name="${name}" id="${name}-o" value="overlay"><label for="${name}-o">Overlay</label>`,
    `<input type="radio" name="${name}" id="${name}-d" value="diff"><label for="${name}-d">Difference</label>`,
  ].join("");
  const none = c.pixelsOff === 0 ? "No pixel outside the masked regions differs by more than 3." : img.diff ? "" : "No difference image was written for this run.";
  const diffView = `<div class="stack"><img class="under" src="${esc(img.golden)}" alt="Design" loading="lazy">${maskBoxes(c)}` +
    `${img.diff ? `<img class="over heat" src="${esc(img.diff)}" alt="Difference" loading="lazy">` : ""}${outlines(c.issues, c.size)}</div>
       <p class="legend"><span class="sw hot"></span>pixels off by more than 3 (yellow to red with the difference) <span class="sw mask"></span>copied from the design before SSIM (text boxes, external) <span class="sw box"></span>elements with an issue${none ? ` · ${esc(none)}` : ""}</p>`;
  return `
<details class="capture" id="${anchor(i)}" data-pass="${c.pass}" data-name="${esc(c.capture)}"${c.pass ? "" : " open"}>
  <summary>${badge}<span class="cname">${esc(c.capture)}</span><span class="cmeta">SSIM ${num(c.ssim, 5)} · ${c.issues.length} issue${c.issues.length === 1 ? "" : "s"}</span></summary>
  <div class="cbody">
    <p class="setup">${applied(c)}</p>
    <div class="views">${views}
      <div class="view view-side"><figure><figcaption>Design</figcaption><img src="${esc(img.golden)}" alt="Design capture" loading="lazy"></figure><figure><figcaption>Unity</figcaption><img src="${esc(img.unity)}" alt="Unity capture" loading="lazy"></figure></div>
      <div class="view view-overlay"><div class="stack"><img class="under" src="${esc(img.golden)}" alt="Design" loading="lazy"><img class="over" src="${esc(img.unity)}" alt="Unity" loading="lazy" style="opacity:0.5"></div>
        <label class="slider">Design <input type="range" min="0" max="100" value="50" data-overlay> Unity</label></div>
      <div class="view view-diff">${diffView}</div>
    </div>
    <dl class="measures">
      <div><dt>Whole SSIM</dt><dd>${num(c.ssim, 5)}</dd></div>
      <div><dt>Worst element SSIM</dt><dd>${c.worstElement ? `${num(c.worstElement.ssim, 5)} <code>${esc(c.worstElement.id)}</code>` : "—"}</dd></div>
      <div><dt>Largest box Δ</dt><dd>${c.maxBoxDelta ? `${num(c.maxBoxDelta.px, 2)} px <code>${esc(c.maxBoxDelta.id)}</code>` : "—"}</dd></div>
      <div><dt>Largest ΔE2000</dt><dd>${c.maxDeltaE ? `${num(c.maxDeltaE.deltaE, 2)} <code>${esc(c.maxDeltaE.id)}</code>` : "—"}</dd></div>
      <div><dt>Pixels off &gt; 3</dt><dd>${c.pixelsOff === null ? "—" : `${(c.pixelsOff * 100).toFixed(3)} %`}</dd></div>
      <div><dt>Compare wall time</dt><dd>${typeof c.ms === "number" ? esc(ms(c.ms)) : "—"}</dd></div>
    </dl>
    ${issues}
    ${c.linesNotCompared.length ? `<p class="muted">Lines not compared (text not in DOM text): ${c.linesNotCompared.map((x) => `<code>${esc(x)}</code>`).join(", ")}</p>` : ""}
    ${c.notSampled.length ? `<p class="warn-text">Background not sampled (every sample point covered or on text): ${c.notSampled.map((x) => `<code>${esc(x)}</code>`).join(", ")}</p>` : ""}
    ${c.translucent ? `<p class="muted">${c.translucent} Unity pixels are translucent; colours were compared premultiplied.</p>` : ""}
    <details class="elements"><summary>Per-element measures (${c.elements.length})</summary>
      <table><thead><tr><th>Element</th><th>Status</th><th>Box Δ x y w h (px)</th><th>SSIM</th><th>SSIM ≤ 1 px</th><th>Background ΔE (samples)</th><th>Edge ΔE</th><th>Shadow band ΔE</th><th>Text colour ΔE</th><th>Text ink</th><th>Lines design/Unity</th></tr></thead><tbody>${rows}</tbody></table>
    </details>
  </div>
</details>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#15181d;--muted:#5d6672;--card:#fff;--border:#d9dde3;--pass:#147a3d;--pass-bg:#e3f4e9;--fail:#b3261e;--fail-bg:#fbe5e3;--warn:#8a5a00;--warn-bg:#fdf1d6;--accent:#2457c5;--code:#eef1f5}
@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--bg:#111418;--fg:#e6e9ee;--muted:#9aa3ae;--card:#1a1e24;--border:#2d333c;--pass:#5fd08a;--pass-bg:#173524;--fail:#ff8a80;--fail-bg:#3d1c1a;--warn:#f0c060;--warn-bg:#3a2e12;--accent:#8fb3ff;--code:#232831}}
:root[data-theme=dark]{--bg:#111418;--fg:#e6e9ee;--muted:#9aa3ae;--card:#1a1e24;--border:#2d333c;--pass:#5fd08a;--pass-bg:#173524;--fail:#ff8a80;--fail-bg:#3d1c1a;--warn:#f0c060;--warn-bg:#3a2e12;--accent:#8fb3ff;--code:#232831}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1600px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin:28px 0 10px}
a{color:var(--accent)}code{font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 4px;border-radius:4px}
.muted{color:var(--muted)}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
header{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;margin-bottom:8px}
.badge{display:inline-block;font-weight:700;font-size:12px;letter-spacing:.04em;padding:2px 8px;border-radius:999px}
.badge.pass{color:var(--pass);background:var(--pass-bg)}.badge.fail{color:var(--fail);background:var(--fail-bg)}.badge.notrun{color:var(--warn);background:var(--warn-bg)}
.verdict{font-size:18px;padding:4px 14px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px 14px}
.card .v{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}.card .k{color:var(--muted);font-size:12px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:hidden}
th,td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
thead th{font-size:12px;color:var(--muted);font-weight:600}
tr:last-child td,tr:last-child th{border-bottom:0}
.toolbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--border)}
.toolbar input[type=search]{flex:1 1 220px;max-width:420px;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--card);color:var(--fg)}
.toolbar button{padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--card);color:var(--fg);cursor:pointer}
details.capture{background:var(--card);border:1px solid var(--border);border-radius:10px;margin:10px 0}
details.capture[data-pass=false]{border-color:color-mix(in srgb,var(--fail) 45%,var(--border))}
details.capture>summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;padding:10px 14px}
.cname{font-weight:600;word-break:break-all}.cmeta{color:var(--muted);margin-left:auto}
.cbody{padding:0 14px 14px}.setup{margin:0 0 10px;color:var(--muted)}
.views>input{position:absolute;opacity:0;pointer-events:none}
.views>label{display:inline-block;padding:4px 10px;border:1px solid var(--border);border-radius:6px;margin:0 4px 10px 0;cursor:pointer;user-select:none}
.views>input:checked+label{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.views>input:focus-visible+label{outline:2px solid var(--accent);outline-offset:2px}
.view{display:none}
.views>input[value=side]:checked~.view-side{display:grid}.views>input[value=overlay]:checked~.view-overlay{display:block}.views>input[value=diff]:checked~.view-diff{display:block}
.view-side{grid-template-columns:1fr 1fr;gap:10px}
@media (max-width:700px){.view-side{grid-template-columns:1fr}}
figure{margin:0}figcaption{font-size:12px;color:var(--muted);margin-bottom:4px}
img{display:block;width:100%;height:auto;border:1px solid var(--border);border-radius:4px;background:repeating-conic-gradient(#8882 0 25%,transparent 0 50%) 0 0/16px 16px}
.stack{position:relative}.stack img.over{position:absolute;left:0;top:0;border-color:transparent;background:none}
.view-diff img.under{filter:grayscale(1);opacity:.35}
.outline{position:absolute;border:2px solid #ff3df5;border-radius:2px;pointer-events:auto}
.maskbox{position:absolute;background:rgba(70,130,255,.28);pointer-events:none}
.slider{display:flex;gap:8px;align-items:center;margin-top:8px;color:var(--muted)}.slider input{flex:0 1 320px}
.legend{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
.warning{border:1px solid var(--warn);background:var(--warn-bg);color:var(--fg);border-radius:8px;padding:10px 14px;margin:12px 0}
.warning strong{color:var(--warn)}.warn-text{color:var(--warn)}
.sw{display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:-2px}.sw.hot{background:linear-gradient(90deg,#ffdc00,#ff0000)}.sw.mask{background:rgba(70,130,255,.45)}.sw.box{border:2px solid #ff3df5}
.measures{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin:12px 0}
.measures div{border:1px solid var(--border);border-radius:8px;padding:6px 10px}.measures dt{font-size:12px;color:var(--muted)}.measures dd{margin:0;font-variant-numeric:tabular-nums}
.issues td:first-child{white-space:nowrap}
details.elements{margin-top:10px}details.elements>summary{cursor:pointer;color:var(--muted)}
tr.st-fail td,tr.st-missing td{color:var(--fail)}tr.st-hidden td,tr.st-removed td{color:var(--muted)}
.strip{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px}
.frame{flex:0 0 180px;border:1px solid var(--border);border-radius:8px;padding:6px;background:var(--card);text-decoration:none;color:inherit}
.frame.fail{border-color:var(--fail)}.frame.notrun{border-color:var(--warn)}
.frame .t{font-size:12px;display:flex;justify-content:space-between;margin-bottom:4px}
.frame img{margin-top:4px}.frame .lbl{font-size:11px;color:var(--muted)}
.idx td:nth-child(2){word-break:break-all}
.hidden{display:none!important}
`;

const SCRIPT = `
(function(){
  var root=document.documentElement,btn=document.getElementById('theme'),themes=['auto','light','dark'];
  function setTheme(t){if(t==='auto')root.removeAttribute('data-theme');else root.setAttribute('data-theme',t);btn.textContent='Theme: '+t;try{localStorage.setItem('fidelity-theme',t)}catch(e){}}
  var saved='auto';try{saved=localStorage.getItem('fidelity-theme')||'auto'}catch(e){}
  setTheme(themes.indexOf(saved)>=0?saved:'auto');
  btn.addEventListener('click',function(){var t=root.getAttribute('data-theme')||'auto';setTheme(themes[(themes.indexOf(t)+1)%3])});
  var only=document.getElementById('failures'),q=document.getElementById('q');
  function apply(){var f=only.checked,s=q.value.trim().toLowerCase();
    document.querySelectorAll('[data-name]').forEach(function(el){var hide=(f&&el.getAttribute('data-pass')==='true')||(s&&el.getAttribute('data-name').toLowerCase().indexOf(s)<0);el.classList.toggle('hidden',!!hide)})}
  only.addEventListener('change',apply);q.addEventListener('input',apply);apply();
  document.addEventListener('input',function(e){var t=e.target;if(t&&t.hasAttribute&&t.hasAttribute('data-overlay')){var img=t.closest('.view-overlay').querySelector('img.over');img.style.opacity=String(t.value/100)}});
})();
`;

/** Writes the HTML report for a screen verdict. Image paths are relative to `outFile`'s folder. */
export function writeReport(v: ScreenVerdict, exportDir: string, unityDir: string, outFile: string): void {
  const dir = path.dirname(path.resolve(outFile));
  const golden = (n: string) => rel(dir, path.join(path.resolve(exportDir), "goldens", `${n}.png`));
  const unity = (n: string) => rel(dir, path.join(path.resolve(unityDir), `${n}.png`));
  const passed = v.captures.filter((c) => c.pass).length, failed = v.captures.length - passed;
  const verdict = v.pass ? '<span class="badge pass verdict">PASS</span>'
    : v.captures.length === 0 ? '<span class="badge notrun verdict">NOT RUN</span>' : '<span class="badge fail verdict">FAIL</span>';
  const index = new Map(v.captures.map((c, i) => [c.capture, i]));
  const worstWhole = v.captures.filter((c) => c.ssim !== null).sort((a, b) => a.ssim! - b.ssim!)[0];
  const worstEl = v.captures.filter((c) => c.worstElement).sort((a, b) => a.worstElement!.ssim - b.worstElement!.ssim)[0];
  const worstBox = v.captures.filter((c) => c.maxBoxDelta).sort((a, b) => b.maxBoxDelta!.px - a.maxBoxDelta!.px)[0];
  const worstDE = v.captures.filter((c) => c.maxDeltaE).sort((a, b) => b.maxDeltaE!.deltaE - a.maxDeltaE!.deltaE)[0];
  const linesNot = Array.from(new Set(v.captures.flatMap((c) => c.linesNotCompared))).sort();
  const extraEls = v.captures.reduce((a, c) => a + c.issues.filter((i) => i.kind === "extra").length, 0);
  const notSampled = v.captures.reduce((a, c) => a + c.notSampled.length, 0);
  const link = (c: CaptureVerdict | undefined, text: string) => (c ? `<a href="#${anchor(index.get(c.capture)!)}">${text}</a>` : "—");

  const indexRows = [
    ...v.captures.map((c, i) => `<tr data-name="${esc(c.capture)}" data-pass="${c.pass}"><td>${c.pass ? '<span class="badge pass">PASS</span>' : '<span class="badge fail">FAIL</span>'}</td>` +
      `<td><a href="#${anchor(i)}">${esc(c.capture)}</a></td><td class="num">${num(c.ssim, 5)}</td>` +
      `<td>${c.worstElement ? `${num(c.worstElement.ssim, 5)} <code>${esc(c.worstElement.id)}</code>` : "—"}</td><td class="num">${c.issues.length}</td></tr>`),
    ...v.notRun.map((n) => `<tr data-name="${esc(n)}" data-pass="false"><td><span class="badge notrun">NOT RUN</span></td><td>${esc(n)}</td><td class="num">—</td><td class="muted">${esc(v.notRunReasons[n] ?? "")}</td><td class="num">—</td></tr>`),
  ].join("");

  const strips = v.animations.map((s) => `
<section class="anim"><h3>${esc(s.element)}${s.sampled.length > 1 ? ` (with ${s.sampled.slice(1).map(esc).join(", ")})` : ""} · ${s.viewport[0]}×${s.viewport[1]}</h3>
<div class="strip">${s.frames.map((f) => {
    const i = index.get(f.capture), c = i === undefined ? undefined : v.captures[i];
    const cls = c ? (c.pass ? "" : " fail") : " notrun";
    const state = c ? (c.pass ? '<span class="badge pass">PASS</span>' : '<span class="badge fail">FAIL</span>') : '<span class="badge notrun">NOT RUN</span>';
    return `<a class="frame${cls}" data-name="${esc(f.capture)}" data-pass="${!!c?.pass}" href="${i === undefined ? "#not-run" : `#${anchor(i)}`}"><div class="t"><span>${esc(f.time)} ms</span>${state}</div>` +
      `<span class="lbl">Design</span><img src="${esc(golden(f.capture))}" alt="Design at ${esc(f.time)} ms" loading="lazy">` +
      (c ? `<span class="lbl">Unity</span><img src="${esc(unity(f.capture))}" alt="Unity at ${esc(f.time)} ms" loading="lazy">` : "") + `</a>`;
  }).join("")}</div></section>`).join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fidelity report: ${esc(v.screen)}</title><style>${STYLE}</style></head>
<body><main>
<header><h1>Fidelity report: ${esc(v.screen)}</h1>${verdict}<span class="muted">${esc(new Date().toISOString().replace("T", " ").slice(0, 19))} UTC</span></header>
<p class="muted">Unity captures compared with the design's goldens, capture by capture (states, pseudo-states, viewports, animation samples). The screen passes only when every capture runs and passes.</p>
${v.warnings.length ? `<div class="warning" role="alert"><strong>Checks skipped for this screen</strong><ul>${v.warnings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
<p class="muted">Effective tolerance: boxes ±${v.thresholds.boxPx} px. Element SSIM and every colour sample use the Unity image offset by up to 1 px where that matches better, so a move or size change within the box allowance cannot fail them; a 2-px displacement, another shape, a missing shadow or a wrong colour still does. Images are linked, not embedded: keep this report next to the design captures (${esc(path.relative(dir, path.join(path.resolve(exportDir), "goldens")) || ".")}), the Unity captures (${esc(path.relative(dir, path.resolve(unityDir)) || ".")}) and the difference images.</p>
<div class="cards">
  <div class="card"><div class="v">${v.captures.length + v.notRun.length}</div><div class="k">captures in the design</div></div>
  <div class="card"><div class="v" style="color:var(--pass)">${passed}</div><div class="k">pass</div></div>
  <div class="card"><div class="v" style="color:var(--fail)">${failed}</div><div class="k">fail</div></div>
  <div class="card"><div class="v" style="color:var(--warn)">${v.notRun.length}</div><div class="k">not run</div></div>
  <div class="card"><div class="v">${v.extra.length}</div><div class="k">extra Unity captures</div></div>
  <div class="card"><div class="v">${extraEls}</div><div class="k">elements only in Unity</div></div>
  <div class="card"><div class="v"${notSampled ? ' style="color:var(--warn)"' : ""}>${notSampled}</div><div class="k">backgrounds not sampled</div></div>
</div>
<div class="cards">
  <div class="card"><div class="v">${worstWhole ? num(worstWhole.ssim, 5) : "—"}</div><div class="k">lowest whole SSIM ${link(worstWhole, worstWhole ? esc(worstWhole.capture) : "")}</div></div>
  <div class="card"><div class="v">${worstEl ? num(worstEl.worstElement!.ssim, 5) : "—"}</div><div class="k">lowest element SSIM ${worstEl ? `<code>${esc(worstEl.worstElement!.id)}</code> ` : ""}${link(worstEl, worstEl ? esc(worstEl.capture) : "")}</div></div>
  <div class="card"><div class="v">${worstBox ? `${num(worstBox.maxBoxDelta!.px, 2)} px` : "—"}</div><div class="k">largest box Δ ${worstBox ? `<code>${esc(worstBox.maxBoxDelta!.id)}</code> ` : ""}${link(worstBox, worstBox ? esc(worstBox.capture) : "")}</div></div>
  <div class="card"><div class="v">${worstDE ? num(worstDE.maxDeltaE!.deltaE, 2) : "—"}</div><div class="k">largest ΔE2000 ${worstDE ? `<code>${esc(worstDE.maxDeltaE!.id)}</code> ` : ""}${link(worstDE, worstDE ? esc(worstDE.capture) : "")}</div></div>
</div>
<div class="grid2">
  <section><h2>Timings</h2><table><tbody>${timingRows(v.timings)}</tbody></table></section>
  <section><h2>Thresholds</h2><table><tbody>${thresholdRows(v.thresholds)}</tbody></table></section>
</div>
<section><h2>Notes</h2><ul>
  <li>Goldens: ${v.platform ? `Chromium ${esc(v.platform.chromium)} on ${esc(v.platform.platform)}` : "platform not recorded"}; compare with captures of the same platform (goldens are platform-specific).</li>
  <li>Before the whole-capture SSIM, the boxes of text elements and external regions (inflated by 2 px) are copied from the design. An element that carries text is measured with only its lines copied, plus samples of its background, border and corners; its text is checked by line count, baselines, ink colour and ink amount (line widths are not compared).</li>
  ${linesNot.length ? `<li>Lines not compared (text not in DOM text): ${linesNot.map((x) => `<code>${esc(x)}</code>`).join(", ")}</li>` : ""}
  ${v.removed.length ? `<li>Removed by the compiler (no Unity box by design): ${v.removed.map((x) => `<code>${esc(x)}</code>`).join(", ")}</li>` : ""}
  ${v.notes.map((n) => `<li>${esc(n)}</li>`).join("")}
</ul></section>
<div class="toolbar"><label><input type="checkbox" id="failures"> Failures only</label><input type="search" id="q" placeholder="Filter captures by name" aria-label="Filter captures by name"><button type="button" id="theme">Theme: auto</button></div>
<section><h2>Captures</h2><table class="idx"><thead><tr><th>Verdict</th><th>Capture</th><th>SSIM</th><th>Worst element</th><th>Issues</th></tr></thead><tbody>${indexRows || '<tr><td colspan="5" class="muted">No captures.</td></tr>'}</tbody></table></section>
${v.notRun.length ? `<section id="not-run"><h2>Not run</h2><table><tbody>${v.notRun.map((n) => `<tr data-name="${esc(n)}" data-pass="false"><th scope="row"><span class="badge notrun">NOT RUN</span> ${esc(n)}</th><td>${esc(v.notRunReasons[n] ?? "")}</td></tr>`).join("")}</tbody></table></section>` : ""}
${v.extra.length ? `<section><h2>Extra Unity captures</h2><p class="muted">Captures in the Unity folder without a design golden (not compared, not failures): ${v.extra.map((n) => `<code>${esc(n)}</code>`).join(", ")}</p></section>` : ""}
${v.animations.length ? `<section><h2>Animations</h2><p class="muted">Each animation's samples in time order: design frame above, Unity frame below.</p>${strips}</section>` : ""}
<section><h2>Capture details</h2>${v.captures.map((c, i) => captureSection(c, i, {
    golden: golden(c.capture), unity: unity(c.capture), diff: c.diff ? rel(dir, path.resolve(c.diff)) : null,
  })).join("")}</section>
</main><script>${SCRIPT}</script></body></html>
`;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${outFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, outFile);
}

/** Writes the verdict as JSON (the machine-readable result next to the report). */
export function writeVerdict(v: ScreenVerdict, file: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
