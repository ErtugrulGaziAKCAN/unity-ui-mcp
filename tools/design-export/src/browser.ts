import { chromium, type Browser, type LaunchOptions } from "playwright";

/**
 * Flags of every Chromium the pipeline starts. One raster tile covers the whole page: Chromium blurs per tile, and tile
 * edges move a large box-shadow by up to 25/255 depending on where the element sits, so goldens and baked shadows
 * would disagree on a quarter of positions.
 */
export const CHROMIUM_ARGS: readonly string[] = ["--default-tile-width=4096", "--default-tile-height=4096"];

/**
 * Network fence flags (design pages are untrusted: their scripts run during lint and export). WebRTC sends no UDP
 * outside a proxy, there is no DNS prefetching and no background networking. They do not change rendering, so they are
 * not part of the export cache key (`CHROMIUM_ARGS` is).
 */
export const FENCE_ARGS: readonly string[] = [
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--dns-prefetch-disable",
  "--disable-background-networking",
];

/** Whether the last Chromium started with its sandbox, and why not when it did not. */
export interface SandboxState { enabled: boolean; reason: string | null }

let sandbox: SandboxState | null = null;
let warned = false;

/** The sandbox state of the last Chromium `launchChromium` started (null before the first). */
export function chromiumSandbox(): SandboxState | null {
  return sandbox;
}

/**
 * Launches the pinned Chromium with CHROMIUM_ARGS and FENCE_ARGS (plus any given), with Chromium's own sandbox: a design
 * page's script runs in a sandboxed renderer. Where the platform has no usable sandbox (a Linux container without user
 * namespaces, for example) it starts without one and says so once on stderr and in `chromiumSandbox()`.
 * `DESIGN_UI_CHROMIUM_SANDBOX=0` starts it without the sandbox on purpose.
 */
export async function launchChromium(opts: LaunchOptions = {}): Promise<Browser> {
  const args = [...CHROMIUM_ARGS, ...FENCE_ARGS, ...(opts.args ?? [])];
  let reason: string;
  if (process.env.DESIGN_UI_CHROMIUM_SANDBOX === "0") reason = "DESIGN_UI_CHROMIUM_SANDBOX=0";
  else {
    try {
      const b = await chromium.launch({ ...opts, chromiumSandbox: true, args });
      sandbox = { enabled: true, reason: null };
      return b;
    } catch (e) {
      reason = (e instanceof Error ? e.message : String(e)).split("\n").map((l) => l.trim()).find((l) => /sandbox/i.test(l)) ??
        (e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  }
  const b = await chromium.launch({ ...opts, chromiumSandbox: false, args });
  sandbox = { enabled: false, reason };
  if (!warned) {
    warned = true;
    process.stderr.write(`design-export: Chromium runs without its sandbox (${reason}); design pages' scripts run unsandboxed\n`);
  }
  return b;
}
