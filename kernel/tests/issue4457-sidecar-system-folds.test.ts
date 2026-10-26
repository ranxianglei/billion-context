// #4457: control-plane sidecar system cores (rawAnthropicMessage —
// mid-conversation tool deltas / effort markers) stay OUT of folds: under
// Anthropic's mid-conversation-tool-changes contract the deltas are
// FUNCTIONAL — tools[] stays static for cache stability and the offered
// tool set is controlled by tool_addition/tool_removal (defer_loading
// surfacing, by-value definitions, removals, MCP toolsets) — so folding one
// silently alters the effective tool set. The #4292-family bug was NOT the
// never-fold carve itself but that the carve could ORPHAN these messages:
// a fold covering the assistant that legitimized one leaves it in a wire
// position Anthropic rejects ("role 'system' must precede an 'assistant'
// message or end the array"), 400ing the session forever. This pins both
// halves of the #4457 fix through the real chain: the protection survives,
// AND the position-based backstop (wire/anthropic.ts
// healIllegalSystemPositions) heals the orphan so the session lives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { prune } from "../src/prune.js";
import { anthropicToCore, coreToAnthropic } from "../src/wire/anthropic.js";
import { hasUnrecoverableMediaPayload } from "../src/protected.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type { Config, CoreMessage } from "../src/types.js";

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
  };
}

const TOOL_DELTA_SYSTEM = {
  role: "system",
  content: [
    {
      type: "text",
      text: 'Updated system prompt section "tools":\n<tools>…</tools>',
    },
    { type: "tool_addition", name: "search", input_schema: { type: "object" } },
  ],
};

function baseMessages(): CoreMessage[] {
  return anthropicToCore({
    messages: [
      { role: "user", content: [{ type: "text", text: "q1 " + "x".repeat(400) }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "a1 " + "y".repeat(4000) }],
      },
      TOOL_DELTA_SYSTEM,
      {
        role: "assistant",
        content: [{ type: "text", text: "a2 " + "y".repeat(4000) }],
      },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ],
  } as never).msgs;
}

/** Wire systems violating the Anthropic position rule (run-aware: a run of
 *  consecutive systems is judged by its first non-system follower). */
function orphanSystems(
  messages: Array<{ role: string; content: unknown; output_config?: unknown }>,
): number[] {
  const bad: number[] = [];
  for (let j = 0; j < messages.length; j++) {
    const e = messages[j]!;
    if (e.role !== "system") continue;
    const c = e.content;
    const directiveOnly =
      (typeof c === "string" ? false : Array.isArray(c) && c.length === 0) &&
      e.output_config != null;
    if (directiveOnly) continue;
    let k = j + 1;
    while (k < messages.length && messages[k]!.role === "system") k++;
    const next = messages[k];
    if (!next || next.role === "assistant") continue;
    bad.push(j);
  }
  return bad;
}

test("#4457: tool-carrying sidecar system stays never-fold (functional delta)", () => {
  const msgs = baseMessages();
  const sys = msgs.find((m) => m.role === "system");
  assert.ok(sys);
  assert.ok((sys as { rawAnthropicMessage?: unknown }).rawAnthropicMessage);
  assert.equal(hasUnrecoverableMediaPayload(sys), true);
});

test("#4457: fold around the never-fold system applies clean; backstop heals the orphan", () => {
  const msgs = baseMessages();
  const state = createInitialState();
  state.messageRefs = assignRefs(msgs, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const core = createCore({ countTokens: defaultCountTokens });
  const applied = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00004",
        summary: "covered early turns around the tool-delta system",
      },
    ],
    messages: msgs,
    state,
    config: config(),
  });
  assert.deepEqual(applied.result.errors, []);
  // the never-fold sidecar is excluded from coverage and reported as such
  assert.ok(
    applied.result.warnings.some((w) => w.includes("Excluded")),
    applied.result.warnings.join(" | "),
  );
  const view = prune(msgs, applied.state);
  // the sidecar SURVIVES the fold (excluded), and the anchor landed BEFORE
  // it — the exact #4457 field layout that 400ed on v0.1.205
  const sidecarInView = view.find(
    (m) => (m as { rawAnthropicMessage?: unknown }).rawAnthropicMessage,
  );
  assert.ok(sidecarInView, "the never-fold sidecar must survive the fold");
  const anchorIdx = view.findIndex((m) => m.id.startsWith("acp_summary_"));
  assert.ok(anchorIdx >= 0, "the fold anchor must be present");
  assert.ok(
    anchorIdx < view.findIndex((m) => m.id === sidecarInView!.id),
    "anchor lands before the surviving sidecar (#4457 layout)",
  );
  const out = coreToAnthropic(view);
  assert.deepEqual(orphanSystems(out), [], JSON.stringify(out));
  // the orphan healed to a text-only user entry (tool block stripped)
  const healed = out.find((m) =>
    JSON.stringify(m).includes("Updated system prompt section"),
  );
  assert.ok(healed, "the healed entry must carry the delta's text");
  assert.equal(healed!.role, "user");
  assert.ok(!JSON.stringify(healed).includes("tool_addition"));
  // the fold summary survives into the emission
  assert.ok(JSON.stringify(out).includes("covered early turns"));
});
