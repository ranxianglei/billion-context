import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPRESS_PARAMETERS,
  COMPRESS_TOOL,
  COMPRESS_TOOL_OPENAI,
  COMPRESS_TOOL_RESPONSES,
} from "../src/compress-tools.js";
import { parseCompressArgs } from "../src/parse-compress-input.js";

/** Minimal JSON-Schema validator covering exactly the subset
 *  COMPRESS_PARAMETERS uses (type / properties / required / anyOf / items).
 *  Stands in for pre-validating hosts (pi-stable-ai typebox Compile +
 *  Value.Errors) that motivated #374: whatever passes here reaches the
 *  kernel; whatever the kernel accepts must not be killed here. */
function typeOk(t: string, v: unknown): boolean {
  if (t === "array") return Array.isArray(v);
  if (t === "object")
    return v !== null && typeof v === "object" && !Array.isArray(v);
  return typeof v === t;
}

function validate(schema: Record<string, unknown>, value: unknown): boolean {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(String(t), value))) return false;
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    if (
      !value.every((item) =>
        validate(schema.items as Record<string, unknown>, item),
      )
    )
      return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (
      Array.isArray(schema.required) &&
      !(schema.required as string[]).every((k) => obj[k] !== undefined)
    ) {
      return false;
    }
    const props = schema.properties as
      Record<string, Record<string, unknown>> | undefined;
    if (props) {
      for (const [k, sub] of Object.entries(props)) {
        if (obj[k] !== undefined && !validate(sub, obj[k])) return false;
      }
    }
  }
  if (Array.isArray(schema.anyOf)) {
    if (
      !(schema.anyOf as Record<string, unknown>[]).some((sub) =>
        validate(sub, value),
      )
    )
      return false;
  }
  return true;
}

/** The contract under test: schema accepts AND the kernel parses N ranges. */
function acceptedByBoth(input: unknown, expectedRanges: number): void {
  assert.ok(
    validate(COMPRESS_PARAMETERS as Record<string, unknown>, input),
    `schema rejected a shape the kernel accepts: ${JSON.stringify(input)}`,
  );
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(
    ranges.length,
    expectedRanges,
    `parser recovered ${ranges.length}, kind=${diagnostics.kind}`,
  );
  assert.ok(diagnostics.ok);
}

/** Structural violations: schema rejects AND the kernel recovers nothing. */
function rejectedByBoth(input: unknown): void {
  assert.equal(
    validate(COMPRESS_PARAMETERS as Record<string, unknown>, input),
    false,
    `schema wrongly accepted: ${JSON.stringify(input)}`,
  );
  assert.equal(parseCompressArgs(input).ranges.length, 0);
}

test("all three wire shapes carry the identical shared parameter schema", () => {
  assert.equal(COMPRESS_TOOL.input_schema, COMPRESS_PARAMETERS);
  assert.equal(COMPRESS_TOOL_OPENAI.function.parameters, COMPRESS_PARAMETERS);
  assert.equal(COMPRESS_TOOL_RESPONSES.parameters, COMPRESS_PARAMETERS);
});

test("issue #374 repro shapes: flat form and string content are accepted by both layers", () => {
  // Repro 1: flat {topic, startId, endId, summary} at top level (no content).
  acceptedByBoth(
    { topic: "T", startId: "m00150", endId: "m00220", summary: "S" },
    1,
  );
  // Repro 2: content as a bare line-form string.
  acceptedByBoth({ content: "m00150–m00220 T\nS body" }, 1);
});

test("every advertised shape passes both layers", () => {
  acceptedByBoth({ content: "m00150–m00220 T\nS body" }, 1);
  acceptedByBoth({ content: "m00150–m00160 A\nfirst\nm00170–m00220 B\nsecond" }, 2);
  acceptedByBoth({ startRef: "m00150", endRef: "m00220", summary: "S" }, 1);
  acceptedByBoth(
    {
      content: JSON.stringify([
        { startId: "m00001", endId: "m00002", summary: "S" },
      ]),
    },
    1,
  );
});

test("structural violations are rejected by both layers", () => {
  rejectedByBoth({ content: 42 });
  rejectedByBoth({ content: [{ startId: "m1" }] });
  rejectedByBoth({ content: [42] });
});

test("empty-ish calls are the parser's job, not the schema's (bili #1299)", () => {
  // The top level must stay a plain object schema: Anthropic 400s any
  // tool input_schema with top-level oneOf/allOf/anyOf, so the
  // content-vs-flat alternation cannot be expressed structurally. With no
  // top-level required either (a strict host must not kill the flat form),
  // these shapes pass the schema by design — parseCompressInput is the
  // enforcement point and recovers zero ranges for them.
  for (const input of [{}, { topic: "x" }, { summary: "s" }]) {
    assert.ok(
      validate(COMPRESS_PARAMETERS as Record<string, unknown>, input),
      `schema must stay permissive at top level: ${JSON.stringify(input)}`,
    );
    assert.equal(
      parseCompressArgs(input).ranges.length,
      0,
      `parser rejected: ${JSON.stringify(input)}`,
    );
  }
});

test("an object under content: schema stays strict, the parser salvages (#470)", () => {
  // The trap shape: {content: {startId,endId,summary}} looks like a natural
  // single-range call. The schema cannot widen to accept it (top-level
  // alternations are off-limits — see the empty-ish-calls test above), so
  // structural rejection at the schema layer stands. #470 removed the old
  // hard content-not-array wall in the parser: the object is wrapped into a
  // one-element array and validated like any other entry, so a well-formed
  // one now recovers instead of dying.
  const trap = {
    content: { startId: "m00150", endId: "m00220", summary: "S" },
  };
  assert.equal(
    validate(COMPRESS_PARAMETERS as Record<string, unknown>, trap),
    false,
    "schema must stay strict: object under content",
  );
  const { ranges, diagnostics } = parseCompressArgs(trap);
  assert.equal(ranges.length, 1);
  assert.ok(diagnostics.ok);
  assert.equal(diagnostics.contentSalvage, true);
});

test("empty content array: schema rejects, the parser degrades gracefully", () => {
  // 2026-10-26 narrowing: array content is no longer advertised, so the
  // schema layer rejects it. The kernel still honors it with zero blocks
  // (no minItems leniency moved, only where it lives).
  assert.equal(
    validate(COMPRESS_PARAMETERS as Record<string, unknown>, { content: [] }),
    false,
  );
  assert.equal(parseCompressArgs({ content: [] }).ranges.length, 0);
});

test("the content description still teaches the line form and the string form", () => {
  const desc =
    (COMPRESS_PARAMETERS.properties as Record<string, { description?: string }>)
      .content.description ?? "";
  assert.ok(desc.includes("m00150–m00220"), "line-form header example kept");
  assert.ok(
    desc.includes("JSON-encoded array"),
    "stringified-array form documented",
  );
});

test("advertised schema admits exactly the string form (2026-10-26 narrowing)", () => {
  // The former test compared acceptance against the pre-narrowing schema
  // (anyOf array/string with object entries). #4252's intent is now
  // structural: content is declared as ONE string branch, no anyOf
  // anywhere, no top-level topic. Legacy array/object calls stay
  // parser-honored (kernel leniency unchanged) but are deliberately no
  // longer schema-valid — the acceptance-set reduction that closes the
  // guided-decoding blend hole (gate 2026-10-26, qwen3.8 content arrays).
  const content = (
    COMPRESS_PARAMETERS.properties as Record<string, unknown>
  ).content as Record<string, unknown>;
  assert.equal(content.type, "string");
  assert.equal(content.anyOf, undefined);
  assert.equal(
    (COMPRESS_PARAMETERS.properties as Record<string, unknown>).topic,
    undefined,
  );
  const json = JSON.stringify(COMPRESS_PARAMETERS);
  assert.ok(!json.includes("anyOf"), "no combinator may reappear anywhere");
  assert.ok(json.includes("m00150–m00220"), "line-form example kept");

  // Open shell preserved (#374): undeclared props and flat calls validate.
  for (const input of [
    { topic: "x" },
    { startId: "m1", endId: "m2", summary: "s" },
    { content: "m00150–m00220 t\ns", extra: 1 },
  ]) {
    assert.ok(
      validate(COMPRESS_PARAMETERS as Record<string, unknown>, input),
      `open shell must keep validating: ${JSON.stringify(input)}`,
    );
  }
});

test("legacy array content: parser honors, schema no longer advertises", () => {
  // The narrowing is advertise-side ONLY. The parser keeps recovering
  // every legacy shape below; a strict pre-validating host would now
  // reject them, which is the accepted trade (no known upstream validates
  // outgoing tool args against input_schema; Anthropic/OpenAI do not).
  const legacy: Array<[unknown, number]> = [
    [{ content: ["m00150-m00220\nS body"] }, 1],
    [{ content: [{ startId: "m00150", endId: "m00220", summary: "S" }] }, 1],
    [
      {
        content: [
          "m00150-m00160 A\nfirst",
          { startId: "m00170", endId: "m00220", summary: "second", topic: "B" },
        ],
      },
      2,
    ],
    [{ content: [{ startRef: "m00150", endRef: "m00220", summary: "S" }] }, 1],
  ];
  for (const [input, expected] of legacy) {
    assert.equal(
      validate(COMPRESS_PARAMETERS as Record<string, unknown>, input),
      false,
      `schema must not advertise array content: ${JSON.stringify(input)}`,
    );
    assert.equal(
      parseCompressArgs(input).ranges.length,
      expected,
      `parser must keep honoring legacy shapes: ${JSON.stringify(input)}`,
    );
  }
});
