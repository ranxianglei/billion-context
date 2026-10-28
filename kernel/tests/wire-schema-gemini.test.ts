import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPRESS_PARAMETERS } from "../src/compress-tools.js";
import { parseCompressArgs } from "../src/parse-compress-input.js";

/**
 * Provider portability contract (#447): Copilot Gemini 400s
 * (`invalid_request_body`) on every request carrying the compress tool when
 * its declared schema uses (a) a union `type` array or (b) an `anyOf`
 * alternative without an explicit `type`. Both existed before the fix
 * (`content.type: ["array","string"]`; required-only bound-spelling fragments
 * under one shared object node). Synthetic differential requests confirm the
 * explicit typed alternatives succeed without an endpoint change. This walks
 * the shared schema (behind all three wire shapes) so a reintroduction fails
 * here instead of in production traffic.
 */

type SchemaNode = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  anyOf?: SchemaNode[];
};

const params = COMPRESS_PARAMETERS as unknown as SchemaNode;

function* walk(
  node: SchemaNode,
  path: string,
): Generator<readonly [string, SchemaNode]> {
  yield [path, node];
  if (node.properties) {
    for (const [k, sub] of Object.entries(node.properties))
      yield* walk(sub, `${path}.properties.${k}`);
  }
  if (node.items) yield* walk(node.items, `${path}.items`);
  if (node.anyOf) {
    for (let i = 0; i < node.anyOf.length; i++) {
      const sub = node.anyOf[i];
      if (sub) yield* walk(sub, `${path}.anyOf[${i}]`);
    }
  }
}

function alt(node: SchemaNode, i: number): SchemaNode {
  const v = node.anyOf?.[i];
  assert.ok(v, `anyOf[${i}] missing`);
  return v;
}

test("no union type arrays anywhere in the shared compress schema (#447)", () => {
  for (const [path, node] of walk(params, "$")) {
    if (node.type === undefined) continue;
    assert.equal(
      typeof node.type,
      "string",
      `${path}: type must be a single string (Copilot Gemini rejects union type arrays), got ${JSON.stringify(node.type)}`,
    );
  }
});

test("no combinators survive the 2026-10-26 single-string narrowing (#447)", () => {
  // The former anyOf alternation (typed array + typed string with
  // self-contained object branches) was the Copilot WC-008 workaround for
  // advertising MULTIPLE forms. The narrowed schema advertises exactly one
  // scalar string branch — no anyOf anywhere — which is trivially legal for
  // every validator the walk emulates.
  let sawAnyOf = false;
  for (const [path, node] of walk(params, "$")) {
    if (node.anyOf) {
      sawAnyOf = true;
      assert.fail(`${path}: unexpected anyOf after narrowing`);
    }
  }
  assert.equal(sawAnyOf, false);
  assert.equal(params.properties?.content?.type, "string");
});

test("top level stays a plain object (Anthropic constraint, bili #1299)", () => {
  const raw = COMPRESS_PARAMETERS as Record<string, unknown>;
  assert.equal(raw.type, "object");
  for (const key of ["oneOf", "allOf", "anyOf", "not"]) {
    assert.equal(raw[key], undefined, `top level must not carry "${key}"`);
  }
});

test("accepted language unchanged: mixed list / stringified JSON / flat form still parse identically", () => {
  assert.equal(
    parseCompressArgs({
      content: [
        "m00150–m00160 A\nfirst",
        { startId: "m00170", endId: "m00220", summary: "second", topic: "B" },
      ],
    }).ranges.length,
    2,
  );
  assert.equal(
    parseCompressArgs({
      content: JSON.stringify([
        { startRef: "m00001", endRef: "m00002", summary: "S" },
      ]),
    }).ranges.length,
    1,
  );
  assert.equal(
    parseCompressArgs({
      topic: "T",
      startId: "m00150",
      endId: "m00220",
      summary: "S",
    }).ranges.length,
    1,
  );
  assert.equal(
    parseCompressArgs({
      content: [{ startRef: "m00150", endRef: "m00220", summary: "S" }],
    }).ranges.length,
    1,
  );
});
