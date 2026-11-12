import { test } from "node:test";
import assert from "node:assert/strict";
import {
  responsesToCore,
  injectResponsesDeveloperMessage,
} from "../src/wire/responses.js";
import type {
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesRequestBody,
} from "../src/wire/responses.js";

function body(input: ResponseInputItem[]): ResponsesRequestBody {
  return { model: "test-model", input } as ResponsesRequestBody;
}

function msg(role: "system" | "developer" | "user", text: string): ResponseInputMessage {
  return { type: "message", role, content: text } as ResponseInputMessage;
}

const userMsg = msg("user", "hello");

function injectedRole(
  input: ResponseInputItem[],
  role?: "system" | "developer",
): string {
  const out = injectResponsesDeveloperMessage(
    [userMsg] as ResponseInputItem[],
    "block",
    role ?? "developer",
  );
  assert.equal(out[0].type, "message");
  return (out[0] as { role: string }).role;
}

test("#6063 responsesToCore keeps the client's leading message role", () => {
  const sys = responsesToCore(body([msg("system", "s"), userMsg]));
  assert.equal(sys.headRole, "system");

  const dev = responsesToCore(body([msg("developer", "d"), userMsg]));
  assert.equal(dev.headRole, "developer");

  // Leading run collapses into systemParts in both cases: the block text is
  // unchanged, only the role the host re-injects has to survive.
  assert.deepEqual(sys.systemParts, ["s"]);
  assert.deepEqual(dev.systemParts, ["d"]);
});

test("#6063 a mid-history system message does not become the head role", () => {
  const projection = responsesToCore(
    body([userMsg, msg("system", "mid"), userMsg]),
  );
  assert.equal(projection.headRole, undefined);
  assert.deepEqual(projection.systemParts, []);
});

test("#6063 bodies without a head message keep the developer default", () => {
  const projection = responsesToCore(body([userMsg]));
  assert.equal(projection.headRole, undefined);
  assert.equal(injectedRole([userMsg], projection.headRole), "developer");
});

test("#6063 injection reuses the recorded head role", () => {
  const projection = responsesToCore(body([msg("system", "s"), userMsg]));
  assert.equal(injectedRole([userMsg], projection.headRole), "system");
});

test("#6063 injection still defaults to developer without an explicit role", () => {
  const out = injectResponsesDeveloperMessage([userMsg] as ResponseInputItem[], "block");
  assert.equal((out[0] as { role: string }).role, "developer");
});
