// Used by setup.sh: adds or replaces the design-ui MCP server in a Codex (toml) or Cursor (json) config file.
// Usage: node client-config.cjs <toml|json> <file> <node> <server.js> <projectDir> <dry 0|1>; prints KEEP, CHANGE <create|update> or FAIL <reason>.
const fs = require("fs");
const path = require("path");
const [kind, file, command, server, project, dry] = process.argv.slice(2);
const args = [server, "--project", project];
const fail = (msg) => { console.log(`FAIL ${msg}`); process.exit(0); };
const exists = fs.existsSync(file);
const before = exists ? fs.readFileSync(file, "utf8") : "";
let after;
if (kind === "toml") {
  const block = `[mcp_servers.design-ui]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`;
  const lines = before.split(/(?<=\n)/); // keep line endings: everything outside the table stays byte for byte
  const header = /^\s*\[\s*mcp_servers\s*\.\s*(?:design-ui|"design-ui"|'design-ui')\s*\]\s*(?:#.*)?$/;
  const anyHeader = /^\s*\[/;
  let inMulti = null, start = -1, end = lines.length, count = 0;
  for (let i = 0; i < lines.length; i++) {
    const body = lines[i].replace(/\r?\n$/, "");
    if (inMulti) { if (body.includes(inMulti)) inMulti = null; continue; }
    if (header.test(body)) { count++; if (start < 0) start = i; continue; }
    if (start >= 0 && end === lines.length && i > start && anyHeader.test(body)) end = i;
    const m = /=\s*("{3}|'{3})/.exec(body);
    if (m && !body.slice(m.index + m[0].length).includes(m[1])) inMulti = m[1];
  }
  if (count > 1) fail(`${file} has ${count} [mcp_servers.design-ui] tables; remove the extra ones by hand`);
  if (start < 0) {
    const sep = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    after = before + sep + block;
  } else {
    let tail = end;
    while (tail > start + 1 && lines[tail - 1].trim() === "") tail--; // blank lines before the next table stay as they are
    after = lines.slice(0, start).join("") + block + lines.slice(tail).join("");
  }
} else {
  let json = {};
  let indent = 2;
  if (before.trim() !== "") {
    try { json = JSON.parse(before); } catch (e) { fail(`${file} is not valid JSON: ${e.message}`); }
    if (typeof json !== "object" || json === null || Array.isArray(json)) fail(`${file} is not a JSON object`);
    const ind = /^\n?([ \t]+)"/m.exec(before);
    if (ind) indent = ind[1].includes("\t") ? "\t" : ind[1].length;
  }
  if (json.mcpServers === undefined) json.mcpServers = {};
  if (typeof json.mcpServers !== "object" || json.mcpServers === null || Array.isArray(json.mcpServers)) fail(`"mcpServers" in ${file} is not an object`);
  const entry = { command, args };
  if (JSON.stringify(json.mcpServers["design-ui"]) === JSON.stringify(entry)) { console.log("KEEP"); process.exit(0); }
  json.mcpServers["design-ui"] = entry;
  after = JSON.stringify(json, null, indent) + "\n";
}
if (after === before) { console.log("KEEP"); process.exit(0); }
if (dry !== "1") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
}
console.log(`CHANGE ${exists ? "update" : "create"}`);
