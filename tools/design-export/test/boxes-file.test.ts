import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendBoxes, BOXES_FILE, boxesLine, LEGACY_BOXES_FILE, openBoxes, orderBoxes } from "../src/boxes/file.js";
import type { CaptureBoxes } from "../src/boxes/types.js";
import { validateBoxes } from "../src/boxes/validate.js";

const tmpDirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "boxes-file-")); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const el = (x: number, w = 10) => ({ x, y: 2.5, w, h: 4, visible: true, text: false, lines: [] });
/** A small valid capture; `copies` written-out repeat items make its line longer. */
const capture = (name: string, x = 0, copies = 0): CaptureBoxes => {
  const b: CaptureBoxes = { capture: name, viewport: [320, 180], scale: 0.125, external: [], elements: { root: el(x, 320), title: { ...el(x + 1), text: true, lines: [{ x: x + 1, y: 3, w: 9, h: 3, baseline: 5.25 }] } } };
  if (copies) b.items = Object.fromEntries(Array.from({ length: copies }, (_, k) => [`row#${k + 1}`, el(k)]));
  return b;
};
const lines = (dir: string) => fs.readFileSync(path.join(dir, BOXES_FILE), "utf8").split("\n");

describe("boxes.jsonl", () => {
  it("round-trips: one compact line per capture with sorted keys, read back as written, in the order written", async () => {
    const dir = tmp();
    const written = [capture("default@320x180", 1), capture("hover@320x180.hover.btn", 2, 3), capture("default@320x180.is-ünïcode.Ω", 3)];
    for (const b of written) appendBoxes(dir, b);
    const text = lines(dir);
    expect(text).toHaveLength(written.length + 1);
    expect(text.at(-1)).toBe("");
    for (const [k, l] of text.slice(0, -1).entries()) {
      expect(l).toBe(boxesLine(written[k]).trimEnd());
      expect(l.startsWith(`{"capture":${JSON.stringify(written[k].capture)},"elements":{"root":{"h":4,"lines":[],"text":false,"visible":true,"w":320,"x":`)).toBe(true);
    }
    const r = (await openBoxes(dir, "design"))!;
    expect(r.file).toBe(path.join(dir, BOXES_FILE));
    expect(r.names).toEqual(written.map((b) => b.capture));
    expect(r.notes).toEqual([]);
    for (const b of written) {
      expect(r.has(b.capture)).toBe(true);
      expect(r.viewport(b.capture)).toEqual([320, 180]);
      expect(await r.read(b.capture)).toEqual(b);
    }
    expect(r.has("toString")).toBe(false);
    expect(r.viewport("missing@1x1")).toBeUndefined();
    await expect(r.read("missing@1x1")).rejects.toThrow(/has no capture missing@1x1/);
  });

  it("reads the line the Unity capture writes (BoxesWriterTests pins it: whole numbers as 1.0)", async () => {
    const dir = tmp();
    const unity = '{"capture":"b@10x10","elements":{"root":{"h":10.0,"lines":[],"text":false,"visible":true,"w":10.0,"x":3.0,"y":0.0}},"external":[],"scale":1.0,"viewport":[10,10]}';
    fs.writeFileSync(path.join(dir, BOXES_FILE), `${unity}\n`);
    const r = (await openBoxes(dir, "Unity"))!;
    expect(await r.read("b@10x10")).toEqual({ capture: "b@10x10", viewport: [10, 10], scale: 1, external: [], elements: { root: { x: 3, y: 0, w: 10, h: 10, visible: true, text: false, lines: [] } } });
  });

  it("reads a capture written again from its last line, in its first place", async () => {
    const dir = tmp();
    appendBoxes(dir, capture("a@320x180", 1));
    appendBoxes(dir, capture("b@320x180", 2));
    appendBoxes(dir, capture("a@320x180", 9));
    const r = (await openBoxes(dir, "Unity"))!;
    expect(r.names).toEqual(["a@320x180", "b@320x180"]);
    expect((await r.read("a@320x180")).elements.root.x).toBe(9);
  });

  it("reads 5,000 small captures line by line, and a line longer than a read chunk", async () => {
    const dir = tmp();
    const names = Array.from({ length: 5000 }, (_, k) => `default@320x180.n${k}`);
    // one write of every line (fast); a long capture in the middle crosses several 1 MiB read chunks
    const long = capture("long@320x180", 7, 30000);
    fs.writeFileSync(path.join(dir, BOXES_FILE), [...names.slice(0, 2500).map((n, k) => boxesLine(capture(n, k))), boxesLine(long), ...names.slice(2500).map((n, k) => boxesLine(capture(n, 2500 + k)))].join(""));
    expect(boxesLine(long).length).toBeGreaterThan(2 * (1 << 20));
    const r = (await openBoxes(dir, "design"))!;
    expect(r.names).toHaveLength(5001);
    expect(r.names[2500]).toBe("long@320x180");
    for (const k of [0, 1, 2499, 2500, 4998, 4999]) expect(await r.read(names[k])).toEqual(capture(names[k], k));
    expect(await r.read("long@320x180")).toEqual(long);
  }, 30000);

  it("a run stopped after N captures, midway through the next line, leaves N readable captures and a note", async () => {
    const dir = tmp();
    for (let k = 0; k < 7; k++) appendBoxes(dir, capture(`c@320x180.n${k}`, k));
    const next = boxesLine(capture("c@320x180.n7", 7));
    fs.appendFileSync(path.join(dir, BOXES_FILE), next.slice(0, next.length >> 1));
    const r = (await openBoxes(dir, "Unity"))!;
    expect(r.names).toEqual(Array.from({ length: 7 }, (_, k) => `c@320x180.n${k}`));
    for (const n of r.names) expect(validateBoxes(await r.read(n))).toEqual([]);
    expect(r.notes).toEqual([`Unity ${BOXES_FILE} (${r.file}): its last line is incomplete (a run stopped while writing it) and was left out; the 7 captures before it are read`]);
    // a whole last line without its newline is read
    fs.writeFileSync(path.join(dir, BOXES_FILE), boxesLine(capture("a@320x180")) + boxesLine(capture("b@320x180")).trimEnd());
    const whole = (await openBoxes(dir, "Unity"))!;
    expect(whole.names).toEqual(["a@320x180", "b@320x180"]);
    expect(whole.notes).toEqual([]);
  });

  it("refuses a broken line before the last and an invalid capture, naming the line", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, BOXES_FILE), boxesLine(capture("a@320x180")) + "{\"capture\":\"b@3\n" + boxesLine(capture("c@320x180")));
    await expect(openBoxes(dir, "Unity")).rejects.toThrow(/^Unity boxes\.jsonl \(.*\) line 2 is not JSON/);
    fs.writeFileSync(path.join(dir, BOXES_FILE), boxesLine(capture("a@320x180")) + JSON.stringify({ capture: "b@320x180" }) + "\n");
    await expect(openBoxes(dir, "Unity")).rejects.toThrow(/^Unity boxes\.jsonl \(.*\) line 2: capture b@320x180 is invalid/);
  });

  it("reads the boxes.json of an earlier version when there is no boxes.jsonl, and nothing when neither exists", async () => {
    const dir = tmp();
    expect(await openBoxes(dir, "design")).toBeNull();
    const old = { "b@320x180": capture("b@320x180", 2), "a@320x180": capture("a@320x180", 1) };
    fs.writeFileSync(path.join(dir, LEGACY_BOXES_FILE), JSON.stringify(old));
    const r = (await openBoxes(dir, "design"))!;
    expect(r.file).toBe(path.join(dir, LEGACY_BOXES_FILE));
    expect(r.names).toEqual(["b@320x180", "a@320x180"]);
    expect(r.viewport("a@320x180")).toEqual([320, 180]);
    expect(await r.read("a@320x180")).toEqual(old["a@320x180"]);
    expect(r.has("constructor")).toBe(false);
    fs.writeFileSync(path.join(dir, LEGACY_BOXES_FILE), JSON.stringify({ "a@320x180": { capture: "x" } }));
    await expect(openBoxes(dir, "Unity")).rejects.toThrow(/^Unity boxes\.json \(.*\): capture a@320x180 is invalid/);
    // boxes.jsonl wins over a boxes.json next to it
    appendBoxes(dir, capture("new@320x180"));
    expect((await openBoxes(dir, "Unity"))!.names).toEqual(["new@320x180"]);
  });

  it("orders captures appended in any order into the given one, each once from its last line", async () => {
    const dir = tmp(), inOrder = tmp();
    const order = ["d@1x1", "c@1x1", "b@1x1", "a@1x1"].map((n) => n.replace("1x1", "320x180"));
    for (const n of order) appendBoxes(inOrder, capture(n, 5));
    for (const [n, x] of [[order[2], 0], [order[0], 5], [order[3], 5], [order[2], 5], [order[1], 5]] as const) appendBoxes(dir, capture(n, x));
    await orderBoxes(dir, order);
    expect(fs.readFileSync(path.join(dir, BOXES_FILE), "utf8")).toBe(fs.readFileSync(path.join(inOrder, BOXES_FILE), "utf8"));
    expect(fs.existsSync(path.join(dir, `${BOXES_FILE}.tmp`))).toBe(false);
    // names the order leaves out follow in the file's order; a file already in order is left alone
    appendBoxes(dir, capture("extra@320x180"));
    await orderBoxes(dir, order.slice(1));
    expect((await openBoxes(dir, "design"))!.names).toEqual([...order.slice(1), order[0], "extra@320x180"]);
    const before = fs.statSync(path.join(dir, BOXES_FILE)).mtimeMs;
    await orderBoxes(dir, [...order.slice(1), order[0], "extra@320x180"]);
    expect(fs.statSync(path.join(dir, BOXES_FILE)).mtimeMs).toBe(before);
  });
});
