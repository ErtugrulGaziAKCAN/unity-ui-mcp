import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv/dist/2020.js";

export function compileSchema(schemaUrl: URL): (json: unknown) => string[] {
  const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ allErrors: true, strict: true });
  const validate = ajv.compile(JSON.parse(readFileSync(schemaUrl, "utf8")));
  return (json) =>
    validate(json) ? [] : (validate.errors ?? []).map((e: ErrorObject) => `${e.instancePath || "/"} ${e.message}${e.params && "additionalProperty" in e.params ? ` (${String(e.params.additionalProperty)})` : ""}${e.keyword === "const" ? ` ${JSON.stringify(e.params.allowedValue)}` : ""}`);
}

const validator = compileSchema(new URL("./schema.json", import.meta.url));

/** ajv messages; [] when valid. */
export function validateIr(json: unknown): string[] {
  return validator(json);
}
