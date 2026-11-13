// Used by setup.sh: adds or updates the design-ui MCP server in a Codex (toml) or Cursor (json) config file.
// Usage: node client-config.cjs <toml|json> <file> <node> <server.js> <projectDir> <dry 0|1>
// Output, first line: KEEP <name> | CHANGE <create|update> <name> | UNCHECKED | FAIL <reason>; for CHANGE the lines after
// it show the entry as it is written. Nothing is written when the result would not parse back to the intended content.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const [kind, file, command, server, project, dry] = process.argv.slice(2);
const out = (s) => { console.log(s); process.exit(0); };
const fail = (msg) => out(`FAIL ${msg}`);
const args = [server, "--project", project];

let toml = null;
try { toml = require("smol-toml"); } catch { /* checked below */ }
if (kind === "toml" && !toml) out(dry === "1" ? "UNCHECKED" : "FAIL the smol-toml package is missing; run npm ci in the unity-ui-mcp clone first");

const exists = fs.existsSync(file);
const before = exists ? fs.readFileSync(file, "utf8") : "";
const eol = before.includes("\r\n") ? "\r\n" : "\n";
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const equalData = (a, b) => same(sortKeys(a), sortKeys(b));

/** Which entry is ours: one that already points at this project, else design-ui, else design-ui-<folder slug>. */
function chooseName(servers) {
  const names = Object.keys(servers).filter((k) => k === "design-ui" || k.startsWith("design-ui-"));
  const mine = names.find((k) => isObj(servers[k]) && Array.isArray(servers[k].args) && servers[k].args.includes(project));
  if (mine) return mine;
  if (!Object.prototype.hasOwnProperty.call(servers, "design-ui")) return "design-ui";
  const slug = (path.basename(project).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "project";
  const base = `design-ui-${slug}`;
  return Object.prototype.hasOwnProperty.call(servers, base)
    ? `${base}-${crypto.createHash("sha1").update(project).digest("hex").slice(0, 6)}`
    : base;
}
const mergeEntry = (old) => ({ ...(isObj(old) ? old : {}), command, args });

function finish(after, name, existed, shown) {
  if (after === before) out(`KEEP ${name}`);
  if (dry !== "1") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (exists && !fs.existsSync(`${file}.design-ui.bak`)) fs.copyFileSync(file, `${file}.design-ui.bak`);
    const tmp = `${file}.design-ui.tmp`;
    fs.writeFileSync(tmp, after, exists ? { mode: fs.statSync(file).mode & 0o777 } : undefined);
    fs.renameSync(tmp, file);
  }
  out(`CHANGE ${existed ? "update" : exists ? "add" : "create"} ${name}\n${shown}`);
}

// ---- JSON (Cursor) ---------------------------------------------------------------------------------------------------
if (kind === "json") {
  let json = {};
  let indent = 2;
  if (before.trim() !== "") {
    try { json = JSON.parse(before); } catch (e) { fail(`${file} is not plain JSON (comments or a BOM are not supported): ${e.message}`); }
    if (!isObj(json)) fail(`${file} is not a JSON object`);
    const ind = /^\n?([ \t]+)"/m.exec(before);
    if (ind) indent = ind[1].includes("\t") ? "\t" : ind[1].length;
  }
  if (json.mcpServers === undefined) json.mcpServers = {};
  if (!isObj(json.mcpServers)) fail(`"mcpServers" in ${file} is not an object`);
  const name = chooseName(json.mcpServers);
  const existed = Object.prototype.hasOwnProperty.call(json.mcpServers, name);
  const entry = mergeEntry(json.mcpServers[name]);
  json.mcpServers[name] = entry;
  const after = JSON.stringify(json, null, indent) + "\n";
  finish(after, name, existed, JSON.stringify({ mcpServers: { [name]: entry } }, null, 2));
}

// ---- TOML (Codex) ----------------------------------------------------------------------------------------------------
let parsed = {};
try { parsed = toml.parse(before); } catch (e) { fail(`${file} is not valid TOML: ${e.message}`); }
if (parsed.mcp_servers !== undefined && !isObj(parsed.mcp_servers)) fail(`"mcp_servers" in ${file} is not a table`);
const servers = parsed.mcp_servers || {};
const name = chooseName(servers);
const existed = Object.prototype.hasOwnProperty.call(servers, name);
const entry = mergeEntry(servers[name]);

/** Splits a TOML dotted key into its parts (bare, "basic" and 'literal' segments). */
function keyParts(text) {
  const parts = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    let seg = "";
    if (text[i] === '"') {
      i++;
      while (i < n && text[i] !== '"') { if (text[i] === "\\" && i + 1 < n) { seg += text[i + 1]; i += 2; } else seg += text[i++]; }
      i++;
    } else if (text[i] === "'") {
      i++;
      while (i < n && text[i] !== "'") seg += text[i++];
      i++;
    } else {
      while (i < n && /[A-Za-z0-9_-]/.test(text[i])) seg += text[i++];
      if (seg === "") return null;
    }
    parts.push(seg);
    while (i < n && /\s/.test(text[i])) i++;
    if (i < n && text[i] === ".") i++; else break;
  }
  return parts;
}

/** Advances the lexer state over one line: bracket depth of unfinished arrays/inline tables and open multi-line strings. */
function scan(line, st) {
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (st.multi) {
      const at = line.indexOf(st.multi, i);
      if (at < 0) return;
      // a basic multi-line string can hold escaped quotes; count preceding backslashes
      let bs = 0;
      for (let k = at - 1; k >= 0 && line[k] === "\\" && st.multi === '"""'; k--) bs++;
      if (bs % 2 === 1) { i = at + 1; continue; }
      i = at + 3;
      st.multi = null;
      continue;
    }
    const c = line[i];
    if (c === "#") return;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) { st.multi = line.slice(i, i + 3); i += 3; continue; }
    if (c === '"') { i++; while (i < n && line[i] !== '"') i += line[i] === "\\" ? 2 : 1; i++; continue; }
    if (c === "'") { i++; while (i < n && line[i] !== "'") i++; i++; continue; }
    if (c === "[" || c === "{") st.depth++;
    else if (c === "]" || c === "}") st.depth--;
    i++;
  }
}

const lines = before.split(/(?<=\n)/);
const stmts = []; // { start, end (exclusive), table: path of the current table, key: path of the key or null, header: bool }
{
  const st = { depth: 0, multi: null };
  let table = [];
  for (let i = 0; i < lines.length; i++) {
    const body = lines[i].replace(/\r?\n$/, "");
    if (st.depth === 0 && !st.multi) {
      const trimmed = body.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const stmt = { start: i, end: i + 1, table, key: null, header: false };
      const h = /^\s*(\[\[?)\s*(.*?)\s*\]\]?\s*(?:#.*)?$/.exec(body);
      if (h && trimmed.startsWith("[")) {
        const kp = keyParts(h[2]);
        if (!kp) fail(`could not read the table header in ${file}, line ${i + 1}`);
        stmt.header = true; stmt.key = kp; stmt.table = kp; table = kp;
      } else {
        const eq = /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=/.exec(body);
        if (!eq) fail(`could not read ${file}, line ${i + 1}`);
        stmt.key = keyParts(eq[1]);
      }
      stmts.push(stmt);
      scan(body, st);
      stmt.end = i + 1;
      continue;
    }
    scan(body, st);
    stmts[stmts.length - 1].end = i + 1;
  }
}
const fullPath = (s) => (s.header ? s.key : [...s.table, ...(s.key || [])]);
const mine = stmts.filter((s) => {
  const p = fullPath(s);
  return p[0] === "mcp_servers" && p[1] === name;
});
if (isObj(parsed) && stmts.some((s) => { const p = fullPath(s); return s.key && p.length === 1 && p[0] === "mcp_servers" && !s.header; })) {
  fail(`${file} defines mcp_servers as an inline value; add the server by hand: ${JSON.stringify(name)} with command ${JSON.stringify(command)} and args ${JSON.stringify(args)}`);
}

const block = toml.stringify({ mcp_servers: { [name]: entry } }).replace(/\n/g, eol);
let after;
if (mine.length === 0) {
  const sep = before === "" || /(\r?\n){2}$/.test(before) ? "" : before.endsWith("\n") ? eol : eol + eol;
  after = before + sep + block;
} else {
  // drop every statement of the entry (header, keys, subtables) and the blank/comment lines between two of them
  const drop = new Set();
  const first = mine[0];
  for (const s of mine) for (let i = s.start; i < s.end; i++) drop.add(i);
  const sorted = [...mine].sort((a, b) => a.start - b.start);
  for (let k = 0; k + 1 < sorted.length; k++) {
    const gapOnly = stmts.every((s) => s.end <= sorted[k].end || s.start >= sorted[k + 1].start || mine.includes(s));
    if (gapOnly) for (let i = sorted[k].end; i < sorted[k + 1].start; i++) drop.add(i);
  }
  const kept = lines.map((l, i) => (drop.has(i) ? null : l));
  // a table that starts with its own header can be rewritten where it was; anything else goes to the end of the file
  const inPlace = first.header && sorted.every((s) => s.header || s.start > first.start);
  if (inPlace) {
    const out2 = [];
    for (let i = 0; i < lines.length; i++) { if (i === first.start) out2.push(block); if (kept[i] !== null) out2.push(kept[i]); }
    let text = out2.join("");
    // keep one blank line between the new table and the next statement
    const at = text.indexOf(block) + block.length;
    if (at < text.length && !/^\s*\r?\n/.test(text.slice(at))) text = text.slice(0, at) + eol + text.slice(at);
    after = text;
  } else {
    const text = kept.filter((l) => l !== null).join("");
    const sep = text === "" || /(\r?\n){2}$/.test(text) ? "" : text.endsWith("\n") ? eol : eol + eol;
    after = text + sep + block;
  }
}

// the result must parse, hold the intended entry, and leave everything else exactly as parsed before
let reparsed;
try { reparsed = toml.parse(after); } catch (e) { fail(`internal check failed (the edited file would not parse: ${e.message}); ${file} was not changed`); }
const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); if (isObj(c.mcp_servers)) { delete c.mcp_servers[name]; if (Object.keys(c.mcp_servers).length === 0) delete c.mcp_servers; } return c; };
if (!reparsed.mcp_servers || !equalData(reparsed.mcp_servers[name], entry) || !equalData(strip(reparsed), strip(parsed))) {
  fail(`internal check failed (the edit would change other settings); ${file} was not changed; add this by hand:\n${block}`);
}
finish(after, name, existed, block.trimEnd());
