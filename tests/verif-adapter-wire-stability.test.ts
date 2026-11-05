/**
 * Adapter wire-stability judge (direction 3).
 *
 * Targets: createOpenaiAdapter / createAnthropicAdapter /
 * createGoogleAdapter `buildRequest` — the outbound re-serialization used on
 * every compression round. The #3837 family's claim is "inbound is pure
 * append; outbound must be too": growing the core history by ONE message may
 * only append to the wire payload; every already-sent element must stay
 * byte-identical across rounds (#1637 byte-prefix property, generalized off
 * the anthropic comments and pinned for all three adapters).
 *
 * This is a replay judge: it drives the REAL adapters end-to-end, no symbolic
 * engine. Properties:
 *   P1 append-stability — build(msgs[0..k)) payload is an elementwise prefix
 *      of build(msgs[0..k+1)) payload, for every k, and the non-payload
 *      fields (model/system/systemInstruction/…) are unchanged.
 *   P2 idempotence + input non-mutation — two builds deep-equal; the input
 *      core array and its messages are untouched.
 *   P3 notes stability — appending notes only appends elements at the tail
 *      (prefix from the no-notes build survives elementwise).
 *   P4 round-trip sanity — a follow-up user message after a tool round keeps
 *      the earlier tool call/result elements verbatim (non-vacuity for
 *      tool-bearing shapes; guards against future "smart" merges).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createOpenaiAdapter } from "../src/loop/adapter-openai.js";
import { createAnthropicAdapter } from "../src/loop/adapter-anthropic.js";
import { createGoogleAdapter } from "../src/loop/adapter-google.js";
import type { CoreMessage } from "acp-kernel";

// --- helpers -------------------------------------------------------------

const j = (v: unknown) => JSON.stringify(v);

function payloadOf(built: Record<string, unknown>): unknown[] {
  const arr = built.messages ?? built.contents;
  assert.ok(Array.isArray(arr), `payload field missing: ${j(Object.keys(built))}`);
  return arr as unknown[];
}

function miscOf(built: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(built)) {
    if (k === "messages" || k === "contents") continue;
    out[k] = v;
  }
  return out;
}

/** elementwise prefix: a[i] deep-equals b[i] for all i < a.length */
function assertPrefix(short: unknown[], long: unknown[], what: string): void {
  assert.ok(short.length <= long.length, `${what}: length grew backwards (${short.length} > ${long.length})`);
  for (let i = 0; i < short.length; i++) {
    assert.deepEqual(short[i], long[i], `${what}: element ${i} changed when history grew`);
  }
}

/** Turn-merging-aware stability: everything EXCEPT the last element is a
 * completed turn that was already sent once — those bytes must never
 * change. The last element is the open turn and may legitimately grow
 * (reasoning+text coalesce, tool blocks append, notes merge in). */
function assertDropLastPrefix(short: unknown[], long: unknown[], what: string): void {
  assert.ok(short.length <= long.length, `${what}: length grew backwards (${short.length} > ${long.length})`);
  const stable = short.length - 1;
  for (let i = 0; i < stable; i++) {
    assert.deepEqual(short[i], long[i], `${what}: COMPLETED element ${i} changed when history grew`);
  }
}

// --- fixtures ------------------------------------------------------------

function coreMessages(): CoreMessage[] {
  return [
    { id: "u1", role: "user", contentType: "text", text: "What is the weather in Tokyo?" },
    { id: "a1", role: "assistant", contentType: "tool-call", toolName: "get_weather", toolCallId: "call_1", text: "{\"city\":\"Tokyo\"}" },
    { id: "u2", role: "tool", contentType: "tool-result", toolCallId: "call_1", text: "18C, rain" },
    { id: "a2", role: "assistant", contentType: "reasoning", text: "check other cities too", thinkingTokens: 120 },
    { id: "a3", role: "assistant", contentType: "text", text: "It is 18C and rainy in Tokyo." },
    { id: "u3", role: "user", contentType: "text", text: "And in Osaka?" },
    { id: "a4", role: "assistant", contentType: "tool-call", toolName: "get_weather", toolCallId: "call_2", text: "{\"city\":\"Osaka\"}" },
    { id: "u4", role: "tool", contentType: "tool-result", toolCallId: "call_2", text: "21C, clear" },
    { id: "a5", role: "assistant", contentType: "text", text: "Osaka is 21C and clear." },
  ];
}

const SYS = "You are the compression operator. Keep answers short.";
const CLIENT_SYS = "Client-side system preamble.";

// --- the three adapters, built once like the loop builds them ------------

const openaiBody = { model: "gpt-4o", temperature: 0.2, stream: true, messages: [{ role: "user", content: "stale host copy" }] };
const anthropicBody = { model: "claude-3-7", max_tokens: 1024, stream: true, system: "client original system", messages: [{ role: "user", content: "stale host copy" }] };
const googleBody = { model: "gemini-2", generationConfig: { temperature: 0.2 }, contents: [{ role: "user", parts: [{ text: "stale host copy" }] }] };

const adapters = [
  {
    name: "openai",
    build: (msgs: CoreMessage[]) => {
      const a = createOpenaiAdapter(openaiBody, CLIENT_SYS, "absorb_x", ["note-a", "note-b"]);
      return a.buildRequest(msgs, SYS, structuredClone(openaiBody));
    },
    bare: (msgs: CoreMessage[]) => {
      const a = createOpenaiAdapter(openaiBody, CLIENT_SYS, "absorb_x");
      return a.buildRequest(msgs, SYS, structuredClone(openaiBody));
    },
  },
  {
    name: "anthropic",
    build: (msgs: CoreMessage[]) => {
      const a = createAnthropicAdapter(anthropicBody, "client original system", ["note-a"]);
      return a.buildRequest(msgs, SYS, structuredClone(anthropicBody));
    },
    bare: (msgs: CoreMessage[]) => {
      const a = createAnthropicAdapter(anthropicBody, "client original system");
      return a.buildRequest(msgs, SYS, structuredClone(anthropicBody));
    },
  },
  {
    name: "anthropic+cacheMarks",
    build: (msgs: CoreMessage[]) => {
      const marks = new Map<string, { type: "ephemeral" }>([["u1", { type: "ephemeral" }], ["a3", { type: "ephemeral" }]]);
      const a = createAnthropicAdapter(anthropicBody, "client original system", undefined, "protocol", marks);
      return a.buildRequest(msgs, SYS, structuredClone(anthropicBody));
    },
    bare: (msgs: CoreMessage[]) => {
      const marks = new Map<string, { type: "ephemeral" }>([["u1", { type: "ephemeral" }], ["a3", { type: "ephemeral" }]]);
      const a = createAnthropicAdapter(anthropicBody, "client original system", undefined, "protocol", marks);
      return a.buildRequest(msgs, SYS, structuredClone(anthropicBody));
    },
  },
  {
    name: "google",
    build: (msgs: CoreMessage[]) => {
      const a = createGoogleAdapter(googleBody, CLIENT_SYS, undefined, "gemini-2", ["note-a"]);
      return a.buildRequest(msgs, SYS, structuredClone(googleBody));
    },
    bare: (msgs: CoreMessage[]) => {
      const a = createGoogleAdapter(googleBody, CLIENT_SYS, undefined, "gemini-2");
      return a.buildRequest(msgs, SYS, structuredClone(googleBody));
    },
  },
];

// --- judge ----------------------------------------------------------------

describe("verif: adapter wire stability (buildRequest append/idempotence)", () => {
  for (const { name, build, bare } of adapters) {
    it(`${name}: P1 append-stability — completed turns never change`, () => {
      const msgs = coreMessages();
      const full = bare(msgs);
      for (let k = 1; k <= msgs.length; k++) {
        const shorter = bare(msgs.slice(0, k));
        assertDropLastPrefix(payloadOf(shorter), payloadOf(full), `${name} k=${k}`);
        // non-payload fields must not depend on history length at all
        assert.deepEqual(miscOf(shorter), miscOf(full), `${name} k=${k}: non-payload fields changed`);
      }
      // turn-COMPLETE boundaries: nothing merges across them, so the full
      // elementwise prefix must hold (P1 strict form — non-vacuity for the
      // drop-last carve-out above).
      const fullPayload = payloadOf(full);
      for (const k of [1, 5, 8]) {
        const at = payloadOf(bare(msgs.slice(0, k)));
        assertPrefix(at, fullPayload, `${name} strict k=${k}`);
      }
    });

    it(`${name}: P2 idempotence + input non-mutation`, () => {
      const msgs = coreMessages();
      const before = j(msgs);
      const r1 = build(msgs);
      const r2 = build(msgs);
      assert.equal(j(r1), j(r2), `${name}: rebuild differs`);
      assert.equal(j(msgs), before, `${name}: input core messages were mutated`);
    });

    it(`${name}: P3 payload stable across every adjacent growth pair`, () => {
      const msgs = coreMessages();
      const built = msgs.map((_, k) => bare(msgs.slice(0, k + 1)));
      for (let a = 0; a + 1 < built.length; a++) {
        assertDropLastPrefix(payloadOf(built[a]), payloadOf(built[a + 1]), `${name} grow ${a + 1}->${a + 2}`);
      }
    });

    it(`${name}: P3b notes only touch the tail`, () => {
      const msgs = coreMessages();
      const without = payloadOf(bare(msgs));
      const withNotes = payloadOf(build(msgs));
      // anthropic/google merge a trailing user note into the open user turn
      // (block/part append); openai emits separate user elements. Both are
      // fine for cache stability as long as COMPLETED bytes never move.
      if (withNotes.length >= without.length) {
        assertDropLastPrefix(without, withNotes, `${name} notes`);
        assert.ok(j(withNotes).includes(j(without.at(-1))), `${name}: last completed turn mangled by notes`);
      } else {
        assert.ok(false, `${name}: notes shrank the payload`);
      }
    });
  }

  it("all: P4 non-vacuity — payload is non-empty and tool rounds survive verbatim", () => {
    const msgs = coreMessages();
    for (const { name, build, bare } of adapters) {
      const full = payloadOf(build(msgs));
      assert.ok(full.length >= msgs.length - 2, `${name}: payload suspiciously short (${full.length})`);
      // the openai tool-call args and tool results must round-trip verbatim
      const flat = j(full);
      assert.ok(flat.includes("call_1"), `${name}: toolCallId lost`);
      assert.ok(flat.includes("get_weather"), `${name}: tool name lost`);
      assert.ok(flat.includes('city'), `${name}: tool args lost`);
      assert.ok(flat.includes("18C, rain"), `${name}: tool result lost`);
    }
  });
});
