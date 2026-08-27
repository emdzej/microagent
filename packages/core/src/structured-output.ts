import type { ResponseFormat, StructuredOutcome } from "./types.js";

/**
 * Validation of model output against a requested schema.
 *
 * The whole point is that a failure is *returned*, not thrown: schema
 * validation at the publish boundary is what makes an off-task answer
 * unpublishable, and a validation failure is a number to count and alert on.
 * Throwing turns it into an exception someone swallows.
 */

/** Pull a JSON value out of model text, tolerating a fenced code block. */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();

  const candidates: string[] = [];
  // A fenced block wins when present — models add prose around JSON even when
  // asked not to, and the fence is the model telling us where the value is.
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(trimmed);
  if (fence) candidates.push(fence[1].trim());
  candidates.push(trimmed);

  // Last resort: the outermost brace/bracket pair.
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace >= 0) {
    const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      continue;
    }
  }
  return { ok: false, error: "response is not valid JSON" };
}

/**
 * Validate a value against the JSON Schema subset providers actually support.
 *
 * Deliberately not a complete JSON Schema implementation. It covers the subset
 * structured-output APIs accept — types, `properties`, `required`, `enum`,
 * `const`, `items`, `anyOf`/`allOf`, `additionalProperties: false`, and local
 * `$ref` into `$defs` — and reports what it could not satisfy. Constructs
 * outside that subset are ignored rather than failed, so an unsupported keyword
 * never produces a spurious rejection.
 *
 * @returns a list of human-readable errors; empty means valid.
 */
export function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = "$",
  root?: Record<string, unknown>
): string[] {
  const rootSchema = root ?? schema;
  const errors: string[] = [];

  // Local $ref resolution ($defs / definitions only — remote refs are not
  // fetched, by design: validation must not make network calls.)
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const resolved = resolveRef(ref, rootSchema);
    if (!resolved) return [`${path}: cannot resolve $ref ${ref}`];
    return validateJsonSchema(value, resolved, path, rootSchema);
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as Record<string, unknown>[]) {
      errors.push(...validateJsonSchema(value, sub, path, rootSchema));
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as Record<string, unknown>[];
    const matched = branches.some((sub) => validateJsonSchema(value, sub, path, rootSchema).length === 0);
    if (!matched) errors.push(`${path}: does not match any of the permitted schemas`);
  }

  if ("const" in schema) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
    }
  }

  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((a) => JSON.stringify(a) === JSON.stringify(value))) {
      errors.push(`${path}: expected one of ${JSON.stringify(allowed)}`);
    }
  }

  const declared = schema.type;
  const types = typeof declared === "string" ? [declared] : Array.isArray(declared) ? (declared as string[]) : [];
  if (types.length && !types.some((t) => matchesType(value, t))) {
    errors.push(`${path}: expected ${types.join(" or ")}, got ${describe(value)}`);
    // Once the type is wrong, per-type checks below would only add noise.
    return errors;
  }

  if (types.includes("object") || (!types.length && isPlainObject(value) && schema.properties)) {
    if (isPlainObject(value)) {
      const properties = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
      const required = (schema.required as string[]) ?? [];
      for (const key of required) {
        if (!(key in value)) errors.push(`${path}.${key}: required property missing`);
      }
      for (const [key, sub] of Object.entries(properties)) {
        if (key in value) {
          errors.push(...validateJsonSchema(value[key], sub, `${path}.${key}`, rootSchema));
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) errors.push(`${path}.${key}: unexpected property`);
        }
      }
    }
  }

  if (types.includes("array") && Array.isArray(value)) {
    const items = schema.items;
    if (isPlainObject(items)) {
      value.forEach((entry, i) => {
        errors.push(...validateJsonSchema(entry, items as Record<string, unknown>, `${path}[${i}]`, rootSchema));
      });
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: expected at most ${schema.maxItems} items`);
    }
  }

  return errors;
}

function resolveRef(ref: string, root: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isPlainObject(node)) return undefined;
    node = node[decodeURIComponent(segment.replace(/~1/g, "/").replace(/~0/g, "~"))];
  }
  return isPlainObject(node) ? node : undefined;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      // Unknown type keyword: do not invent a failure.
      return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Parse and validate a model response against a requested format.
 *
 * Never throws. A failure carries the raw text so a caller can log what the
 * model actually produced.
 */
export function parseStructured(text: string, format: ResponseFormat): StructuredOutcome {
  const parsed = extractJson(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, raw: text };

  const errors = validateJsonSchema(parsed.value, format.schema);
  if (errors.length) {
    return { ok: false, error: errors.slice(0, 10).join("; "), raw: text };
  }
  return { ok: true, value: parsed.value };
}
