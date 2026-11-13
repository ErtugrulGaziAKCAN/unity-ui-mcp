import { fileURLToPath } from "node:url";

// This module and the bundled dist/server.js both sit two folders below tools/, so the same relative URL works.
/** The repository's own design kit (RULES.md, kit.config.json, text styles), used when no project kit is configured. */
export const REPO_KIT_DIR = fileURLToPath(new URL("../../../design-kit", import.meta.url));
