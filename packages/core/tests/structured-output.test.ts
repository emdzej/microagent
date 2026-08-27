import { describe, it, expect } from "vitest";
import { extractJson, parseStructured, validateJsonSchema } from "../src/structured-output.js";

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("prefers a fenced block when the model adds prose", () => {
    const text = 'Here you go:\n```json\n{"a":1}\n```\nHope that helps.';
    expect(extractJson(text)).toEqual({ ok: true, value: { a: 1 } });
  });

  it("falls back to the outermost braces", () => {
    expect(extractJson('Sure! {"a":1} done')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("reports failure rather than throwing", () => {
    expect(extractJson("no json here")).toEqual({
      ok: false,
      error: "response is not valid JSON",
    });
  });
});

describe("validateJsonSchema", () => {
  it("accepts a conforming object", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, count: { type: "integer" } },
      required: ["name"],
    };
    expect(validateJsonSchema({ name: "x", count: 2 }, schema)).toEqual([]);
  });

  it("reports a missing required property", () => {
    const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
    expect(validateJsonSchema({}, schema)).toEqual(["$.name: required property missing"]);
  });

  it("reports a wrong type with the path", () => {
    const schema = { type: "object", properties: { count: { type: "integer" } } };
    expect(validateJsonSchema({ count: "two" }, schema)).toEqual([
      "$.count: expected integer, got string",
    ]);
  });

  it("rejects unexpected properties when additionalProperties is false", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    expect(validateJsonSchema({ a: "x", b: 1 }, schema)).toEqual(["$.b: unexpected property"]);
  });

  it("validates array items and enums", () => {
    const schema = {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["low", "high"] },
        tags: { type: "array", items: { type: "string" }, minItems: 1 },
      },
    };
    expect(validateJsonSchema({ severity: "high", tags: ["a"] }, schema)).toEqual([]);
    expect(validateJsonSchema({ severity: "medium", tags: [] }, schema)).toEqual([
      '$.severity: expected one of ["low","high"]',
      "$.tags: expected at least 1 items",
    ]);
  });

  it("resolves a local $ref", () => {
    const schema = {
      type: "object",
      properties: { finding: { $ref: "#/$defs/Finding" } },
      $defs: {
        Finding: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    };
    expect(validateJsonSchema({ finding: { id: "F-1" } }, schema)).toEqual([]);
    expect(validateJsonSchema({ finding: {} }, schema)).toEqual([
      "$.finding.id: required property missing",
    ]);
  });

  it("accepts any branch of an anyOf", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(validateJsonSchema("x", schema)).toEqual([]);
    expect(validateJsonSchema(1, schema)).toEqual([]);
    expect(validateJsonSchema(true, schema)).toEqual([
      "$: does not match any of the permitted schemas",
    ]);
  });

  /**
   * Keywords outside the supported subset are ignored rather than failed —
   * an unsupported keyword must never produce a spurious rejection.
   */
  it("ignores unsupported keywords instead of failing on them", () => {
    const schema = { type: "string", pattern: "^[a-z]+$", minLength: 100 };
    expect(validateJsonSchema("ABC", schema)).toEqual([]);
  });
});

describe("parseStructured", () => {
  it("returns the parsed value on success", () => {
    const outcome = parseStructured('{"ok":true}', {
      type: "json_schema",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
    });
    expect(outcome).toEqual({ ok: true, value: { ok: true } });
  });

  /**
   * A validation failure is a number to count and alert on at the publish
   * boundary, not an exception for someone to swallow — so it comes back as
   * data, carrying the raw text for diagnosis.
   */
  it("returns the failure and the raw text rather than throwing", () => {
    const outcome = parseStructured("I refuse to produce JSON", {
      type: "json_schema",
      schema: { type: "object" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.raw).toBe("I refuse to produce JSON");
      expect(outcome.error).toContain("not valid JSON");
    }
  });
});
