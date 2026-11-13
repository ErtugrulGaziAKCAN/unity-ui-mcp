import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

export interface Extracted { dir: string; cleanup(): void }

export interface ZipLimits { maxEntries: number; maxBytes: number }
const DEFAULT_LIMITS: ZipLimits = { maxEntries: 10_000, maxBytes: 512 * 1024 * 1024 };

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function unsafeName(name: string): string | null {
  if (name.includes("\0")) return "NUL in the name";
  if (/^[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) return "absolute path";
  if (name.split(/[\\/]/).includes("..")) return "path leaves the archive folder";
  return null;
}

const open = (file: string) => new Promise<yauzl.ZipFile>((resolve, reject) =>
  yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true }, (err, zf) => (err ? reject(err) : resolve(zf!))));

/**
 * Extracts a ZIP into a new empty temp folder. Entries that would leave the folder (`..`, absolute paths) and symbolic
 * links are rejected before anything is written; entry count and total size are limited.
 */
export async function extractZip(zipPath: string, limits: ZipLimits = DEFAULT_LIMITS): Promise<Extracted> {
  const reject = (why: string): never => { throw new Error(`ZIP rejected (${path.basename(zipPath)}): ${why}`); };
  let zf: yauzl.ZipFile;
  try { zf = await open(zipPath); } catch (e) { return reject((e as Error).message); }

  try {
    // pass 1: read and check the whole central directory before writing anything
    const entries = await new Promise<yauzl.Entry[]>((resolve, rej) => {
      const out: yauzl.Entry[] = [];
      zf.on("entry", (e: yauzl.Entry) => { out.push(e); zf.readEntry(); });
      zf.on("end", () => resolve(out));
      zf.on("error", rej); // yauzl's own name checks (e.g. "invalid relative path: ../evil.html") arrive here
      zf.readEntry();
    }).catch((e: Error) => reject(`unsafe entry: ${e.message}`));
    if (entries.length > limits.maxEntries) reject(`more than ${limits.maxEntries} entries`);
    let total = 0;
    for (const e of entries) {
      const why = unsafeName(e.fileName);
      if (why) reject(`unsafe entry ${e.fileName}: ${why}`);
      if (((e.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) reject(`entry ${e.fileName} is a symbolic link`);
      total += e.uncompressedSize;
      if (total > limits.maxBytes) reject(`uncompressed size exceeds ${Math.round(limits.maxBytes / 1048576)} MB`);
    }

    // pass 2: write into a new empty folder; 'wx' never overwrites or follows an existing path
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "design-ui-zip-")));
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
      for (const e of entries) {
        const target = path.resolve(dir, e.fileName);
        if (target !== dir && !target.startsWith(dir + path.sep)) reject(`unsafe entry ${e.fileName}: path leaves the archive folder`);
        if (e.fileName.endsWith("/")) { fs.mkdirSync(target, { recursive: true }); continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((resolve, rej) =>
          zf.openReadStream(e, (err, s) => (err ? rej(err) : resolve(s!))));
        await pipeline(stream, fs.createWriteStream(target, { flags: "wx" }));
      }
    } catch (e) {
      cleanup();
      throw (e as Error).message.startsWith("ZIP rejected") ? e : new Error(`ZIP rejected (${path.basename(zipPath)}): ${(e as Error).message}`);
    }
    return { dir, cleanup };
  } finally {
    zf.close();
  }
}
