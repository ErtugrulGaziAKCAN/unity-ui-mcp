import type { ContractItem, ScreenContract } from "./contract.js";
import type { KitConfig } from "./kit.js";

const cell = (s: string | null | undefined) => (s === null || s === undefined || s === "" ? "—" : s.replace(/\|/g, "\\|").replace(/\r?\n/g, " "));
const where = (repeat: string | null) => (repeat === null ? "screen" : `repeat ${repeat}`);

function table(head: string[], rows: (string | null | undefined)[][]): string[] {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

/** Requested items (texts carry their own English, so never texts) the game cannot back yet (no source, handler or condition): "<kind> <name>: <note>". */
export function namedDependencies(c: ScreenContract): string[] {
  return c.items.filter((i) => i.kind !== "text" && i.origin === "requested" && !i.source)
    .map((i) => `${i.kind} ${i.name}${i.repeat === null ? "" : ` (in repeat ${i.repeat})`}: ${i.note ?? ""}`);
}

/** The brief a design tool takes as its prompt: the contract as Markdown, one table per kind. Pure. */
export function contractBrief(c: ScreenContract, kit: Pick<KitConfig, "locales" | "referenceLocale">): string {
  const of = (kind: ContractItem["kind"]) => c.items.filter((i) => i.kind === kind);
  const out: string[] = [
    `# Design brief: ${c.screen}`, "",
    "Draw exactly this inventory: nothing more, nothing less. Lint compares the design with screen.contract.json.",
  ];
  if (c.kind === "update" && c.replaces) out.push("", `Replaces: ${c.replaces}`);
  const section = (title: string, lines: string[]) => { if (lines.length) out.push("", `## ${title}`, "", ...lines); };

  const values = of("value");
  section("Values", values.length ? table(["Name", "In", "Source", "Real samples"],
    values.map((i) => [i.name, where(i.repeat), i.source, i.image ? "image" : (i.samples ?? []).join(" · ")])) : []);
  const actions = of("action");
  section("Actions", actions.length ? table(["Name", "In", "Handler"], actions.map((i) => [i.name, where(i.repeat), i.source])) : []);
  const states = of("state");
  section("States", states.length ? table(["Name", "When"], states.map((i) => [i.name, i.source])) : []);
  const lists = of("repeat");
  section("Lists", lists.length ? table(["Name", "Inside", "Source", "Count"],
    lists.map((i) => [i.name, where(i.repeat), i.source, i.count ? `${i.count[0]}–${i.count[1]}` : null])) : []);
  const texts = of("text");
  if (texts.length) {
    const withRef = texts.some((i) => i.ref !== undefined);
    const refName = kit.referenceLocale ?? kit.locales[0] ?? "reference";
    section("Texts", table(withRef ? ["Key", "English", refName] : ["Key", "English"],
      texts.map((i) => (withRef ? [i.name, i.en, i.ref] : [i.name, i.en]))));
  }
  section("Removed", c.removed.length ? table(["Kind", "Name", "Note"],
    c.removed.map((r) => [r.kind, r.repeat === null ? r.name : `${r.name} (in repeat ${r.repeat})`, r.note])) : []);
  section("Named dependencies", namedDependencies(c).map((d) => `- ${d}`));
  return out.join("\n") + "\n";
}
