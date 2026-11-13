// Bundles the server into dist/server.js. The exporter's TypeScript modules (tools/design-export/src) are bundled in;
// every npm package stays external and is resolved from node_modules at run time.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const externalPackages = {
  name: "external-packages",
  setup(b) {
    // bare specifiers (no ./, ../ or absolute path) are npm packages or node: builtins
    b.onResolve({ filter: /^[^./]/ }, (args) => ({ path: args.path, external: true }));
  },
};

// Bundled exporter modules that read files next to themselves (e.g. `new URL("./schema.json", import.meta.url)`)
// keep their own location: import.meta.url becomes the source file's URL inside this clone.
const exporterFiles = path.resolve(root, "../design-export/src") + path.sep;
const keepModuleUrl = {
  name: "keep-module-url",
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, async (args) => {
      if (!args.path.startsWith(exporterFiles)) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!source.includes("import.meta.url")) return undefined;
      return { contents: source.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(args.path).href)), loader: "ts" };
    });
  },
};

await build({
  entryPoints: [path.join(root, "src/main.ts")],
  outfile: path.join(root, "dist/server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  plugins: [externalPackages, keepModuleUrl],
  logLevel: "info",
});
