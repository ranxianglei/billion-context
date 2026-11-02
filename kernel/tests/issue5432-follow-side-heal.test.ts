// #5438 (approval owner decision 2026-11-02, closing half of #5432's
// remaining exposure): Anthropic's mid-conversation system rule is TWO-sided
// and healIllegalSystemPositions enforced only one half. A mid-conversation
// system must FOLLOW a user message (or an assistant ending in a server
// tool_result) AND PRECEDE an assistant or end the array. The precede half
// (#4457: fold covers the legitimizing ASSISTANT) was healed; the follow half
// (#5438/#5432 case-1: fold covers the preceding USER turn, or positionally
// illegal client input) sailed through the backstop and 400ed the whole
// request: 'messages.N: role 'system' must follow a 'user' message',
// permanently — until the client self-clears its mid-conversation systems.
// Field repro: claude-code v2.1.316 + mid-conversation-tool-changes
// contract, bili v0.1.210 / acp-kernel 0.0.175 era. This pins both halves of
// the fix through the real chain: the position-based backstop now heals
// follow-side orphans too (same demotion semantics: re-voice to user, strip
// tool_addition/tool_removal per WC-022, drop when nothing remains), while
// every LEGAL shape round-trips byte-identical (prefix-cache stability,
// negative-test discipline per #3617). Also pins the new single-source
// insertion helper insertBeforeTrailingSystemRun that the host's ephemeral
// tail injection routes through once #5441 lands (host copy deletion is the
// small follow-up PR after both merge).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { prune } from "../src/prune.js";
import {
  anthropicToCore,
  coreToAnthropic,
  insertBeforeTrailingSystemRun,
} from "../src/wire/anthropic.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type {
  AnthropicSystemMessage,
  AnthropicWireMessage,
} from "../src/wire/anthropic.js";
import type { BiliMessage } from "../src/wire/bili-message.js";
import type { Config } from "../src/types.js";

function config(): Config {
  return {
    tiers: { enabled: false },
    nudge: {
      maxContextLimitPct: 0.55, minContextLimitPct: 0.45, frequency: 5,
      iterationThreshold: 15, force: "soft", growthRatio: 0.05,
      growthFloor: 6000, growthCap: 50000, minGrowthFloor: 5000,
      minGrowthRatio: 0.45, emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 1 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
  } as Config;
}

const TOOL_DELTA_SYSTEM: AnthropicSystemMessage = {
  role: "system",
  content: [
    {
      type: "text",
      text: 'Updated system prompt section "tools":\n<tools>…</tools>',
    },
    { type: "tool_addition", name: "search" } as never,
  ],
};

function sys(content: AnthropicSystemMessage["content"]): AnthropicSystemMessage {
  return { role: "system", content };
}

function u(id: string, text: string): BiliMessage {
  return { id, role: "user", contentType: "text", text };
}

function a(id: string, text: string): BiliMessage {
  return { id, role: "assistant", contentType: "text", text };
}

/** Two-sided legality checker mirroring what healIllegalSystemPositions now
 *  enforces (follow side: nearest non-system predecessor must be a user or a
 *  server-tool-result-terminated assistant; no predecessor at array start is
 *  legal by contract. Precede side: run's first non-system follower must be
 *  an assistant or the array end). Directive-only exempt anywhere. */
function orphanSystems(messages: AnthropicWireMessage[]): number[] {
  const bad: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "system") continue;
    if (
      Array.isArray(m.content) &&
      m.content.length === 0 &&
      (m as { output_config?: unknown }).output_config != null
    )
      continue;
    let k = i + 1;
    while (k < messages.length && messages[k]!.role === "system") k++;
    const next = messages[k];
    let p = i - 1;
    while (p >= 0 && messages[p]!.role === "system") p--;
    const pred = p >= 0 ? messages[p] : undefined;
    const pc = pred ? (pred as { content?: unknown }).content : undefined;
    const predOk =
      !pred ||
      pred.role === "user" ||
      (pred.role === "assistant" &&
        Array.isArray(pc) &&
        pc.length > 0 &&
        (pc[pc.length - 1] as { type?: string } | undefined)?.type ===
          "tool_result");
    const nextOk = !next || next.role === "assistant";
    if (!predOk || !nextOk) bad.push(i);
  }
  return bad;
}

// --- the fold-driven field regression (#5438 case-1) -----------------------

test("#5438: fold covering the turns AFTER a sidecar leaves it following an assistant — healed, session lives", () => {
  // [q1, a1, SIDE(car), a2, q2]; the fold covers a2+q2 (m00004..m00005).
  // The sidecar (never-fold carve) survives IN PLACE, right behind the
  // exposed assistant a1 — its follow side is now violated ('must follow a
  // user'), and its precede side is violated too (anchor renders as user).
  const msgs = anthropicToCore({
    messages: [
      { role: "user", content: "q1 " + "x".repeat(400) },
      {
        role: "assistant",
        content: [{ type: "text", text: "a1 " + "y".repeat(4000) }],
      },
      TOOL_DELTA_SYSTEM,
      {
        role: "assistant",
        content: [{ type: "text", text: "a2 " + "y".repeat(4000) }],
      },
      { role: "user", content: "q2" },
    ],
  } as never).msgs;
  const state = createInitialState();
  state.messageRefs = assignRefs(msgs, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const core = createCore({ countTokens: defaultCountTokens });
  const applied = core.applyCompression({
    ranges: [{ startRef: "m00004", endRef: "m00005", summary: "covered late turns" }],
    messages: msgs,
    state,
    config: config(),
  });
  assert.deepEqual(applied.result.errors, []);
  const view = prune(msgs, applied.state);
  // Precondition pin: the surviving sidecar sits directly behind an exposed
  // assistant in the post-fold view — the exact shape that 400ed.
  const side = view.findIndex(
    (m) => (m as { rawAnthropicMessage?: unknown }).rawAnthropicMessage,
  );
  assert.ok(side >= 0, "the never-fold sidecar must survive the fold");
  assert.equal(view[side - 1]!.role, "assistant", "case-1: sidecar follows an exposed assistant");
  const anchorIdx = view.findIndex((m) => m.id.startsWith("acp_summary_"));
  assert.ok(anchorIdx > side, "anchor lands AFTER the surviving sidecar here");
  const out = coreToAnthropic(view as BiliMessage[]);
  assert.deepEqual(orphanSystems(out), [], JSON.stringify(out));
  // The sidecar's delta TEXT survives the demotion as plain user content;
  // the tool_addition control block never leaks outside a system (WC-022).
  assert.equal(out[side]!.role, "user");
  assert.deepEqual(
    out[side]!.content,
    [{ type: "text", text: 'Updated system prompt section "tools":\n<tools>…</tools>' }],
  );
  assert.ok(!JSON.stringify(out).includes("tool_addition"));
});

// --- client-side case-1 shapes (no fold involved) ---------------------------

test("#5438: trailing sidecar directly behind an assistant (array end) is healed", () => {
  const rebuilt = coreToAnthropic(anthropicToCore({
    messages: [
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      TOOL_DELTA_SYSTEM,
    ],
  } as never).msgs as never);
  assert.deepEqual(orphanSystems(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  assert.deepEqual(
    rebuilt[1]!.content,
    [{ type: "text", text: 'Updated system prompt section "tools":\n<tools>…</tools>' }],
  );
});

test("#5438: mid-array sidecar between two assistants is healed", () => {
  const rebuilt = coreToAnthropic(anthropicToCore({
    messages: [
      { role: "assistant", content: [{ type: "text", text: "before" }] },
      sys([{ type: "text", text: "delta" }]),
      { role: "assistant", content: [{ type: "text", text: "after" }] },
    ],
  } as never).msgs as never);
  assert.deepEqual(orphanSystems(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  assert.deepEqual(rebuilt[1]!.content, [{ type: "text", text: "delta" }]);
});

// --- negative guards: legal shapes stay byte-identical ----------------------

test("legal shapes emit verbatim: [user, system, assistant]", () => {
  const input: AnthropicWireMessage[] = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    sys([{ type: "text", text: "policy update" }]),
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ];
  const rebuilt = coreToAnthropic(anthropicToCore({
    messages: [
      { role: "user", content: "a" },
      sys([{ type: "text", text: "policy update" }]),
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
  } as never).msgs as never);
  assert.deepEqual(rebuilt, input);
});

test("server-tool-result-terminated assistant legitimizes the follow side (verbatim)", () => {
  // Assistant-side tool_result (SERVER tools: web_search & co.) merges with
  // the preceding assistant core into ONE wire message whose LAST block is a
  // tool_result — the other legal follow position for a mid-conversation
  // system. Everything must pass through untouched (cache stability).
  const sidecarCore: BiliMessage = {
    id: "s1",
    role: "system",
    contentType: "text",
    text: 'Updated system prompt section "tools":\n<tools>…</tools>',
    rawAnthropicMessage: TOOL_DELTA_SYSTEM,
  };
  const rebuilt = coreToAnthropic([
    a("a1", "calling the web"),
    {
      id: "a2",
      role: "assistant",
      contentType: "tool-result",
      text: "search hits",
      toolCallId: "srv_1",
    } as BiliMessage,
    sidecarCore,
    a("a3", "here is what I found"),
  ] as never);
  assert.deepEqual(orphanSystems(rebuilt), []);
  // a1+a2 merged into one assistant ending in tool_result; sidecar verbatim
  // (control blocks intact — this IS the mid-conversation-tool-changes
  // contract working as designed).
  assert.equal(rebuilt[0]!.role, "assistant");
  assert.equal(
    (rebuilt[0]!.content as Array<{ type?: string }>)[rebuilt[0]!.content.length - 1]!.type,
    "tool_result",
  );
  assert.equal(rebuilt[1]!.role, "system");
  assert.ok(JSON.stringify(rebuilt[1]).includes("tool_addition"));
});

test("directive-only system behind an assistant stays system (exempt at any position)", () => {
  const dir = {
    role: "system",
    content: [],
    output_config: { effort: "high" },
  } as unknown as AnthropicSystemMessage;
  const rebuilt = coreToAnthropic([
    a("a1", "done"),
    { id: "s1", role: "system", contentType: "text", text: "[effort]", rawAnthropicMessage: dir } as BiliMessage,
  ] as never);
  assert.equal(rebuilt[1]!.role, "system");
  assert.deepEqual(rebuilt[1]!.content, []);
});

test("chain of two sidecars: earliest demotion re-legitimizes the rest (minimal repair)", () => {
  // [assistant, S1, S2] at array end: S1 violates BOTH sides → demoted to
  // user; S2 then FOLLOWS that user and ENDS the array → fully legal, kept
  // verbatim. Left-to-right healing yields the smallest repair that satisfies
  // the API; pinning it makes any future coarsening deliberate.
  const S1 = sys([{ type: "text", text: "first" }]);
  const S2 = sys([{ type: "text", text: "second" }]);
  const rebuilt = coreToAnthropic([
    a("a1", "reply"),
    { id: "s1", role: "system", contentType: "text", text: "first", rawAnthropicMessage: S1 } as BiliMessage,
    { id: "s2", role: "system", contentType: "text", text: "second", rawAnthropicMessage: S2 } as BiliMessage,
  ] as never);
  assert.deepEqual(orphanSystems(rebuilt), []);
  assert.equal(rebuilt[1]!.role, "user");
  assert.deepEqual(rebuilt[1]!.content, [{ type: "text", text: "first" }]);
  assert.equal(rebuilt[2]!.role, "system");
  assert.deepEqual(rebuilt[2]!.content, [{ type: "text", text: "second" }]);
});

// --- insertBeforeTrailingSystemRun (single source of truth for the rule) ----

function wUser(text: string): AnthropicWireMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function wAssist(text: string): AnthropicWireMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

test("insertBeforeTrailingSystemRun: inserts before the trailing system run", () => {
  const base: AnthropicWireMessage[] = [
    wUser("u"),
    wAssist("a"),
    sys([{ type: "text", text: "env" }]),
    sys([{ type: "text", text: "nudge" }]),
  ];
  const added = wUser("ephemeral tail");
  assert.deepEqual(insertBeforeTrailingSystemRun(base, [added]), [
    wUser("u"),
    wAssist("a"),
    added,
    sys([{ type: "text", text: "env" }]),
    sys([{ type: "text", text: "nudge" }]),
  ]);
});

test("insertBeforeTrailingSystemRun: no trailing run → plain append (byte-identical-tail guard)", () => {
  const base: AnthropicWireMessage[] = [wUser("u"), wAssist("a")];
  const added = wUser("tail");
  assert.deepEqual(insertBeforeTrailingSystemRun(base, [added]), [
    wUser("u"),
    wAssist("a"),
    added,
  ]);
});

test("insertBeforeTrailingSystemRun: empty additions return the SAME array reference", () => {
  const base: AnthropicWireMessage[] = [wUser("u"), sys([{ type: "text", text: "e" }])];
  assert.equal(insertBeforeTrailingSystemRun(base, []), base);
});

test("insertBeforeTrailingSystemRun: all-system input inserts at the front (also legitimizes the run's follow side)", () => {
  const base: AnthropicWireMessage[] = [sys(["one"]), sys(["two"])];
  const added = wUser("first turn");
  assert.deepEqual(insertBeforeTrailingSystemRun(base, [added]), [
    added,
    sys(["one"]),
    sys(["two"]),
  ]);
});
