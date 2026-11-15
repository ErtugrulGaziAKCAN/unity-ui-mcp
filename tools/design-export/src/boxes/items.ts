/**
 * The name suffix of an IR element's copy in written-out repeat items `item` (outermost first), as the captures name it
 * (both sides: the Unity capture's DesignUi.Editor.CaptureApply.ItemSuffix): `#k` per repeat, innermost first, for each
 * repeat whose item is a later one or that sits inside a later item of an outer repeat (`day#3`, `day#0#1`, `day#3#1`);
 * empty for the IR's own element. The boxes' `items` are keyed `<id><suffix>`; every lookup of a copy builds its key here.
 */
export function itemSuffix(item: readonly number[]): string {
  let out = "";
  for (let k = item.length - 1; k >= 0; k--) if (item[k] > 0 || item.slice(0, k).some((v) => v > 0)) out += `#${item[k]}`;
  return out;
}
