// #4818: the position-based backstop healed each illegal system INDEPENDENTLY
// and demoted-in-place — stripping tool_addition/tool_removal blocks per
// WC-022. Tool deltas form an ORDERED CHAIN (add → remove → add …) that
// controls the effective tool set under Anthropic's mid-conversation-tool-
// changes contract, so stripping one link breaks its neighbours: Claude Code
// MCP connect/disconnect flapping produced a stripped tool_addition plus a
// later VERBATIM tool_removal for the same tool → hard 400
// 'tool_reference_unresolved', killing the session (and the model reply);
// an addition-only carrier was spliced out silently, permanently deactivating
// the deferred-load tool with no error and no log (@BBleae field report).
// Fix under test: healIllegalSystemPositions now RELOCATES misplaced
// tool-delta carriers to the earliest forward legal slot (order preserved);
// demotion survives only as the last resort when no forward slot exists, and
// then warns with the dropped tool names. Plain systems keep the owner-
// approved #5438 demote semantics untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, coreToAnthropic } from "../src/wire/anthropic.js";
import type { AnthropicSystemMessage } from "../src/wire/anthropic.js";
import type { BiliMessage } from "../src/wire/bili-message.js";

const T_DOCS = "mcp__claude_ai_Claude_Docs__batch";
const T_SEARCH = "search_docs";

/** Nested definition shape exactly as Claude Code emits it (#4818 repro). */
function addition(name: string): Record<string, unknown> {
  return {
    type: "tool_addition",
    tool: {
      type: "tool_definition",
      definition: { name, description: "", input_schema: { type: "object" } },
    },
  };
}

function removal(name: string): Record<string, unknown> {
  return { type: "tool_removal", tool_reference: name };
}

function sys(blocks: Array<Record<string, unknown>>): AnthropicSystemMessage {
  return { role: "system", content: blocks as never };
}

/** Kernel-rendered fold anchor core (no rawAnthropicMessage sidecar). */
function anchor(id: string, text: string): BiliMessage {
  return { id, role: "system", contentType: "text", text };
}

/** Replay the delta chain in emission order: every tool_removal must
 *  reference a tool an earlier tool_addition put live. Pre-fix, the strip
 *  broke exactly this invariant (removal survived, its addition did not). */
function assertChainResolved(messages: Array<{ role: string; content?: unknown }>) {
  const live = new Set<string>();
  for (const m of messages) {
    if (m.role !== "system" || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<Record<string, any>>) {
      if (b.type === "tool_addition") {
        live.add(b.tool?.definition?.name ?? b.name);
      } else if (b.type === "tool_removal") {
        const ref = b.tool_reference ?? b.tool_name;
        assert.ok(live.has(ref), `unresolved tool_removal for ${ref} (the #4818 400)`);
        live.delete(ref);
      }
    }
  }
}

test("#4818 exact repro: stripped-addition/orphaned-removal pair keeps BOTH links", () => {
  // [user, system(add T), user, system(remove T), assistant] — the fold
  // covered the turns around both deltas; the second one sat in a legal
  // position while the first was orphaned, which is what made the old heal
  // split the pair.
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "summarize docs" }] },
      sys([
        { type: "text", text: "tools just became available" },
        addition(T_DOCS),
      ]),
      { role: "user", content: [{ type: "text", text: "and these again" }] },
      sys([
        { type: "text", text: "tools were removed" },
        removal(T_DOCS),
      ]),
      {
        role: "assistant",
        content: [{ type: "text", text: "done summarizing" }],
      },
    ],
  };
  const rebuilt = coreToAnthropic(anthropicToCore(body as never).msgs as never);
  // Both carriers survive AS SYSTEMS, in their original relative order,
  // relocated contiguously to the earliest legal slot (before the final
  // assistant turn).
  assert.deepEqual(
    rebuilt.map((m) => m.role),
    ["user", "user", "system", "system", "assistant"],
  );
  const joined = JSON.stringify(rebuilt);
  assert.ok(joined.includes('"tool_addition"'), "the addition link survives");
  assert.ok(joined.includes('"tool_removal"'), "the removal link survives");
  assert.ok(joined.indexOf("tool_addition") < joined.indexOf("tool_removal"));
  assertChainResolved(rebuilt);
});

test("flap sequence: add/remove/add across folds relocates the whole set in order", () => {
  // Pre-fold: three MCP flaps interleaved with normal turns. Two folds cover
  // the turns BETWEEN each pair of deltas, orphaning all three carriers.
  const full = anthropicToCore({
    messages: [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      sys([{ type: "text", text: "added" }, addition(T_DOCS)]),
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
      sys([{ type: "text", text: "removed" }, removal(T_DOCS)]),
      { role: "assistant", content: [{ type: "text", text: "a3" }] },
      { role: "user", content: [{ type: "text", text: "q3" }] },
      sys([{ type: "text", text: "re-added" }, addition(T_SEARCH)]),
      { role: "assistant", content: [{ type: "text", text: "a4" }] },
      { role: "user", content: [{ type: "text", text: "q4" }] },
    ],
  } as never).msgs;
  // Folds covered a1+q2 and a3+q3: anchors take the earliest covered slots.
  const cores: BiliMessage[] = [
    full[0] as BiliMessage,
    full[1] as BiliMessage,
    anchor("fa", "[Compressed conversation section] t1"),
    full[4] as BiliMessage,
    anchor("fb", "[Compressed conversation section] t2"),
    full[7] as BiliMessage,
    full[9] as BiliMessage,
  ];
  const rebuilt = coreToAnthropic(cores as never);
  // Every carrier survives; the relocated group keeps its original order
  // (add T_DOCS → remove T_DOCS → add T_SEARCH) and the chain resolves.
  const deltas = rebuilt.filter(
    (m) =>
      m.role === "system" &&
      Array.isArray(m.content) &&
      (m.content as Array<{ type?: string }>).some(
        (b) => b.type === "tool_addition" || b.type === "tool_removal",
      ),
  );
  assert.equal(deltas.length, 3, "no delta carrier may be lost");
  const types = deltas.flatMap((m) =>
    (m.content as Array<{ type?: string }>)
      .map((b) => b.type)
      .filter((t): t is "tool_addition" | "tool_removal" =>
        t === "tool_addition" || t === "tool_removal",
      ),
  );
  assert.deepEqual(types, ["tool_addition", "tool_removal", "tool_addition"]);
  assertChainResolved(rebuilt);
});

/** Capture console.warn calls for the duration of fn (deterministic, no
 *  test-mock API surface). */
function captureWarn(fn: () => void): string[] {
  const original = console.warn;
  const calls: string[] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args.join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return calls;
}

test("fallback: no forward legal slot demotes (owner-approved #5438 path) and WARNs the dropped tools", () => {
  // Trailing delta carrier behind a plain assistant-text turn: nothing after
  // it can host the relocation, so the #5438 demote applies — but now with a
  // diagnostic naming the lost tool (silent tool loss must be diagnosable).
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      sys([{ type: "text", text: "tools updated" }, addition(T_SEARCH)]),
    ],
  };
  const calls = captureWarn(() => {
    const rebuilt = coreToAnthropic(
      anthropicToCore(body as never).msgs as never,
    );
    assert.deepEqual(
      rebuilt.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    assert.ok(!JSON.stringify(rebuilt).includes("tool_addition"));
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /\[acp-kernel\]/);
  assert.match(calls[0]!, new RegExp(T_SEARCH));
});

test("fallback: block-only trailing carriers are all dropped, one warn names every lost tool", () => {
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      sys([addition(T_DOCS)]),
      sys([addition(T_SEARCH)]),
    ],
  };
  const calls = captureWarn(() => {
    const rebuilt = coreToAnthropic(
      anthropicToCore(body as never).msgs as never,
    );
    assert.deepEqual(rebuilt.map((m) => m.role), ["assistant"]);
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, new RegExp(T_DOCS));
  assert.match(calls[0]!, new RegExp(T_SEARCH));
});

test("gate (negative direction): legal delta layouts stay byte-identical", () => {
  // Mid-conversation legal position and the Pi trailing run: the settle pass
  // must be a cache-safe no-op — zero movement, zero re-allocation churn.
  const mid = {
    messages: [
      { role: "user", content: [{ type: "text", text: "a" }] },
      sys([{ type: "text", text: "delta" }, addition(T_SEARCH)]),
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
  };
  assert.deepEqual(
    coreToAnthropic(anthropicToCore(mid as never).msgs as never),
    mid.messages,
  );
  const trailing = {
    messages: [
      { role: "user", content: [{ type: "text", text: "a" }] },
      sys([{ type: "text", text: "delta" }, addition(T_SEARCH)]),
      { role: "system", content: [], output_config: { effort: "high" } },
    ],
  };
  assert.deepEqual(
    coreToAnthropic(anthropicToCore(trailing as never).msgs as never),
    trailing.messages,
  );
});

test("fallback warn names the tool for the REAL nested tool_removal wire shape", () => {
  // Production Claude Code emits tool_removal as { tool: { type: tool_reference,
  // name } }; the diagnostic must name THAT tool, not print "unknown".
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      sys([
        { type: "text", text: "tools removed" },
        { type: "tool_removal", tool: { type: "tool_reference", name: T_DOCS } },
      ]),
    ],
  };
  const calls = captureWarn(() => {
    const rebuilt = coreToAnthropic(anthropicToCore(body as never).msgs as never);
    assert.deepEqual(rebuilt.map((m) => m.role), ["assistant", "user"]);
    assert.ok(!JSON.stringify(rebuilt).includes("tool_removal"));
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /\[acp-kernel\]/);
  assert.match(calls[0]!, new RegExp(T_DOCS));
});
