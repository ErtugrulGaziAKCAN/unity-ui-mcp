import { px } from "../css-values.js";
import { describeStyle, matchRichStyle } from "../text-styles.js";
import type { Rule } from "../types.js";
import { make, textElements } from "./util.js";

/** Text smaller than this many device px at the kit's smallest viewport is hard to read and is only approximated by the renderers. */
export const MIN_READABLE_DEVICE_PX = 10;

export const rule: Rule = {
  id: "W-TXT-001", severity: "warning",
  check(s, kit, _b, ctx) {
    const scale = Math.min(...kit.viewports.map(([w]) => w / kit.reference[0]));
    const small = kit.viewports.find(([w]) => w / kit.reference[0] === scale)!;
    const users = new Map<number, string[]>();
    for (const e of textElements(s)) {
      if (e.tag === "option") continue;
      const size = px(e.computed["font-size"]);
      if (size === null || size * scale >= MIN_READABLE_DEVICE_PX - 1e-9) continue;
      users.set(size, [...(users.get(size) ?? []), e.path]);
    }
    return Array.from(users, ([size, paths]) => {
      const style = matchRichStyle(ctx.textStyles, size, 400) ?? matchRichStyle(ctx.textStyles, size, 700);
      const larger = ctx.textStyles.filter((t) => t.fontSize * scale >= MIN_READABLE_DEVICE_PX - 1e-9).sort((a, b) => a.fontSize - b.fontSize)[0];
      return make(rule, paths[0],
        `${paths.length === 1 ? "this text is" : `${paths.length} text elements are`} ${size}px${style ? ` (${style.name})` : ""}: ${Number((size * scale).toFixed(2))} device px at ${small[0]}×${small[1]}, under ${MIN_READABLE_DEVICE_PX}`,
        `Use a kit text style of at least ${MIN_READABLE_DEVICE_PX} device px at the smallest viewport${larger ? ` (${describeStyle(larger)} or larger)` : ""}, or accept it for secondary text: it stays hard to read and the renderers differ most there.`);
    });
  },
};
