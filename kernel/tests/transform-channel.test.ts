import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTransformChannel } from "../src/transform-channel.js";

test("an explicit channel always wins", () => {
  assert.equal(resolveTransformChannel("wire", false), "wire");
  assert.equal(resolveTransformChannel("message", true), "message");
});

test("the default channel follows wire viability", () => {
  assert.equal(resolveTransformChannel(undefined, true), "wire");
  assert.equal(resolveTransformChannel(undefined, false), "message");
});
