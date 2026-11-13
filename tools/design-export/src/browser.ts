import { chromium, type Browser, type LaunchOptions } from "playwright";

/**
 * Flags of every Chromium the pipeline starts. One raster tile covers the whole page: Chromium blurs per tile, and tile
 * edges move a large box-shadow by up to 25/255 depending on where the element sits, so goldens and baked shadows
 * would disagree on a quarter of positions.
 */
export const CHROMIUM_ARGS: readonly string[] = ["--default-tile-width=4096", "--default-tile-height=4096"];

/** Launches the pinned Chromium with CHROMIUM_ARGS (plus any given). */
export function launchChromium(opts: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({ ...opts, args: [...CHROMIUM_ARGS, ...(opts.args ?? [])] });
}
