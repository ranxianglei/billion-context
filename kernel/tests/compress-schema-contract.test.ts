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

test("every shape parseCompressArgs accepts passes the declared schema", () => {
  acceptedByBoth({ content: ["m00150-m00220\nS body"] }, 1);
  acceptedByBoth(
    { content: [{ startId: "m00150", endId: "m00220", summary: "S" }] },
    1,
  );
  acceptedByBoth(
    {
      content: [
        "m00150-m00160 A\nfirst",
        { startId: "m00170", endId: "m00220", summary: "second", topic: "B" },
      ],
    },
    2,
  );
  acceptedByBoth(
    { content: [{ startRef: "m00150", endRef: "m00220", summary: "S" }] },
    1,
  );
  acceptedByBoth({ startRef: "m00150", endRef: "m00220", summary: "S" }, 1);
  acceptedByBoth(
    {
      content: JSON.stringify([
        { startId: "m00001", endId: "m00002", summary: "S" },
      ]),
    },
    1,
  );
  acceptedByBoth(
    { content: "m00150–m00160 A\nfirst\nm00170–m00220 B\nsecond" },
    2,
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

test("empty content array passes the schema; the parser degrades gracefully", () => {
  // Deliberate leniency pin: no minItems. The kernel handles an empty batch
  // with a warning and zero blocks instead of failing the turn.
  assert.ok(
    validate(COMPRESS_PARAMETERS as Record<string, unknown>, { content: [] }),
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

test("typed alternatives preserve the former schema's acceptance set", () => {
  const content = COMPRESS_PARAMETERS.properties.content;
  const entries = content.anyOf[0].items!.anyOf;
  const { required: _required, ...object } = entries[1];
  const former = {
    ...COMPRESS_PARAMETERS,
    properties: {
      ...COMPRESS_PARAMETERS.properties,
      content: {
        type: ["array", "string"],
        items: {
          anyOf: [
            entries[0],
            {
              ...object,
              anyOf: entries.slice(1).map(({ required }) => ({ required })),
            },
          ],
        },
      },
    },
  };
  const values: unknown[] = [
    undefined,
    null,
    false,
    42,
    "s",
    [],
    {},
    ["line"],
    [42],
  ];
  const keys = ["startId", "endId", "startRef", "endRef", "summary", "topic"];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const range = Object.fromEntries(
      keys.filter((_, i) => mask & (1 << i)).map((key) => [key, "s"]),
    );
    values.push([range], ["line", range], [{ ...range, extra: true }]);
    for (const key of keys) values.push([{ ...range, [key]: 42 }]);
  }
  for (const content of values) {
    for (const input of [
      { content },
      { content, startId: "m1", endId: "m2", summary: "s" },
    ]) {
      assert.equal(
        validate(COMPRESS_PARAMETERS, input),
        validate(former, input),
        JSON.stringify(input),
      );
    }
  }
});
