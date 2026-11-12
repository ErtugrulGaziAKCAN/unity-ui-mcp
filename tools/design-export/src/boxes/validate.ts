import { compileSchema } from "../ir/validate.js";

const validator = compileSchema(new URL("./schema.json", import.meta.url));

export function validateBoxes(json: unknown): string[] {
  return validator(json);
}
