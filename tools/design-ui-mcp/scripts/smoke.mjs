#!/usr/bin/env node
// Manual stdio handshake with the built server, without any MCP client library: newline-delimited JSON-RPC.
// Usage: node scripts/smoke.mjs --project <UnityProjectDir> [--call <tool> [--args '<json>']]...
// Prints the server info, the tool names, and a short view of each call's result. Exit 1 if a step fails.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, "../dist/server.js");

const argv = process.argv.slice(2);
let project = null;
const calls = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--project") project = argv[++i];
  else if (argv[i] === "--call") calls.push({ name: argv[++i], args: {} });
  else if (argv[i] === "--args") calls[calls.length - 1].args = JSON.parse(argv[++i]);
  else { console.error(`unknown argument ${argv[i]}`); process.exit(2); }
}
if (!project) { console.error("usage: node scripts/smoke.mjs --project <UnityProjectDir> [--call <tool> [--args '<json>']]..."); process.exit(2); }

const child = spawn(process.execPath, [server, "--project", project], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const waiting = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk;
  for (let nl; (nl = buf.indexOf("\n")) >= 0;) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  }
});
let nextId = 1;
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`${method}: no answer within 60 s`)), 60_000);
  waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

let failed = false;
try {
  const t0 = performance.now();
  const init = await request("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "design-ui-smoke", version: "0.0.0" },
  });
  if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
  console.log(`initialize: ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion} (${Math.round(performance.now() - t0)} ms)`);
  console.log(`instructions: ${init.result.instructions.split("\n").length} lines; first: ${init.result.instructions.split("\n")[0]}`);
  notify("notifications/initialized", {});

  const tools = await request("tools/list", {});
  console.log(`tools/list: ${tools.result.tools.map((t) => t.name).join(", ")}`);
  const resources = await request("resources/list", {});
  console.log(`resources/list: ${resources.result.resources.map((r) => r.uri).join(", ")}`);

  for (const c of calls) {
    const t = performance.now();
    const r = await request("tools/call", { name: c.name, arguments: c.args });
    const ms = Math.round(performance.now() - t);
    if (r.error) { failed = true; console.log(`tools/call ${c.name}: protocol error ${JSON.stringify(r.error)}`); continue; }
    const text = r.result.content.find((x) => x.type === "text")?.text ?? "";
    const lines = text.split("\n");
    console.log(`tools/call ${c.name} ${JSON.stringify(c.args)}: isError=${!!r.result.isError} (${ms} ms), ${text.length} chars, timings ${JSON.stringify(r.result.structuredContent?.timings ?? {})}`);
    for (const l of lines.slice(0, 12)) console.log(`  | ${l}`);
    if (lines.length > 12) console.log(`  | … ${lines.length - 12} more lines`);
  }
} catch (e) {
  failed = true;
  console.error(`smoke failed: ${e.message}`);
} finally {
  child.stdin.end();
}
const code = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
console.log(`server exited with ${code} after stdin closed`);
process.exit(failed || code !== 0 ? 1 : 0);
