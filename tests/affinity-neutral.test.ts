import assert from "node:assert";
import test from "node:test";

process.env.NODE_ENV = "test";

import { PrefixAffinityResolver, rawChainFingerprint } from "../src/prefix-affinity.ts";
import { neutralTurns, neutralTurnCanonical } from "../src/affinity-neutral.ts";

/**
 * #2791: wire-neutral affinity hashing. A stateless client (dsh) carries its
 * whole history in every request and re-renders it in its CURRENT provider's
 * wire format — switching openai ↔ anthropic mid-session used to mint a fresh
 * anonymous pfa-* session (raw-wire hashes never matched across protocols),
 * orphaning the fold ledger and paying a full re-fold. The neutral projection
 * (affinity-neutral.ts) maps both renders of the same conversation to the
 * same turns → same chain hashes → same session.
 */

/** One synthetic transcript rendered on BOTH wires. */
const transcript: Array<{ role: "user" | "assistant"; text: string }> = [
    { role: "user", text: "please audit the billing pipeline for service gamma and report the error budget" },
    { role: "assistant", text: "audit 1: the billing pipeline shows a stable error budget with a p99 of 42ms; dead-letter volume under threshold" },
    { role: "user", text: "now check the invoice reconciliation stage too" },
    { role: "assistant", text: "reconciliation 3: invoice matching is healthy; the retry queue drains within one window" },
    { role: "user", text: "what about the refund path latency?" },
    { role: "assistant", text: "refund 5: refund latency tracks the payment gateway with a stable p95 of 88ms" },
    { role: "user", text: "summarize the audit findings" },
    { role: "assistant", text: "summary 7: all three stages are healthy; no intervention is required at this point" },
];

/** openai wire: content STRINGS, tool_calls as {function:{name,arguments:JSON}}. */
function openaiRender(extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [
        { role: "system", content: "You are a helpful coding agent." },
        ...transcript.map((t) => ({ role: t.role, content: t.text })),
        {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "/src/billing.ts" }) } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "export function bill() { return 42; }" },
        ...extra,
    ];
    return msgs;
}

/** anthropic wire: top-level system, content BLOCKS, tool_use/tool_result,
 *  thinking blocks, and a cache_control stamp (Claude Code style). */
function anthropicRender(extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [
        ...transcript.map((t, i) => ({
            role: t.role,
            content: [{ type: "text", text: t.text, ...(i === transcript.length - 1 ? { cache_control: { type: "ephemeral" } } : {}) }],
        })),
        // anthropic may split thinking and tool_use into a separate assistant
        // message before the tool result (openai renders them as one).
        {
            role: "assistant",
            content: [{ type: "thinking", thinking: "the user asked about the billing code; I should read the file", signature: "sig-abc" }],
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "let me read the billing module" }, { type: "tool_use", id: "call_1", name: "read_file", input: { path: "/src/billing.ts" } }],
        },
        {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "export function bill() { return 42; }" }],
        },
        ...extra,
    ];
    return msgs;
}

/** google-generative wire: contents[] with parts[], model role, functionCall/
 *  functionResponse parts (Gemini native shape — commentary and the call
 *  share one parts array; functionResponse rides the following user turn). */
function googleRender(extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    return [
        ...transcript.slice(0, -1).map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
        {
            role: "model",
            parts: [
                { text: transcript[transcript.length - 1]!.text },
                { functionCall: { name: "read_file", args: { path: "/src/billing.ts" } } },
            ],
        },
        {
            role: "user",
            parts: [{ functionResponse: { name: "read_file", response: { output: "export function bill() { return 42; }" } } }],
        },
        ...extra,
    ];
}

/** responses wire: input[] items — message items with input_text/output_text
 *  blocks, function_call / function_call_output as sibling items (codex /
 *  dsh openai-responses shape). */
function responsesRender(extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    return [
        ...transcript.map((t) => ({
            type: "message",
            role: t.role,
            content: [{ type: t.role === "user" ? "input_text" : "output_text", text: t.text }],
        })),
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "/src/billing.ts" }) },
        { type: "function_call_output", call_id: "call_1", output: "export function bill() { return 42; }" },
        ...extra,
    ];
}

test("#2791: all four wire renders of the same conversation project to IDENTICAL neutral turns", () => {
    const o = neutralTurns(openaiRender());
    const a = neutralTurns(anthropicRender());
    const r = neutralTurns(responsesRender());
    const g = neutralTurns(googleRender());
    assert.equal(o.length, a.length, `openai vs anthropic turn counts (got ${o.length} vs ${a.length})`);
    assert.equal(o.length, r.length, `openai vs responses turn counts (got ${o.length} vs ${r.length})`);
    assert.equal(o.length, g.length, `openai vs google turn counts (got ${o.length} vs ${g.length})`);
    assert.ok(o.length >= 9, "the projection must carry the substance turns");
    for (let i = 0; i < o.length; i++) {
        const oc = neutralTurnCanonical(o[i]!);
        assert.equal(oc, neutralTurnCanonical(a[i]!), `turn ${i} (${o[i]!.kind}) openai vs anthropic`);
        assert.equal(oc, neutralTurnCanonical(r[i]!), `turn ${i} (${o[i]!.kind}) openai vs responses`);
        assert.equal(oc, neutralTurnCanonical(g[i]!), `turn ${i} (${o[i]!.kind}) openai vs google`);
    }
});

test("#2791: a mid-session protocol switch keeps the SAME anonymous session (no pfa-* fork)", () => {
    const r = new PrefixAffinityResolver();
    // openai lane establishes the session...
    const first = r.resolve(openaiRender())!;
    assert.equal(first.via, "new");
    r.note(first.sessionId, first.incomingDepth, first.tailHash, first.itemHashes, false, first.sketches, first.userFlags);

    // ...then the client switches providers: the SAME history arrives
    // re-rendered on the anthropic wire (plus one new user turn).
    const switched = r.resolve(anthropicRender([{ role: "user", content: [{ type: "text", text: "and the dunning letters stage?" }] }]))!;
    assert.equal(switched.via, "prefix", "the cross-wire replay must resolve by exact prefix, not mint");
    assert.equal(switched.sessionId, first.sessionId, "the session must survive the protocol switch");
    assert.ok(switched.incomingDepth > first.incomingDepth);

    // And back: openai render extended past the anthropic turn still matches.
    r.note(switched.sessionId, switched.incomingDepth, switched.tailHash, switched.itemHashes, false, switched.sketches, switched.userFlags);
    const back = r.resolve(openaiRender([
        { role: "user", content: "and the dunning letters stage?" },
        { role: "assistant", content: "dunning 9: letter dispatch latency is stable; queue depth under four" },
    ]))!;
    assert.equal(back.via, "prefix", "switching back must also resolve by exact prefix");
    assert.equal(back.sessionId, first.sessionId);
});

test("#2791: mid-session switch onto the responses and google wires keeps the SAME anonymous session", () => {
    for (const [label, render, extraTurn, extraBack] of [
        ["responses", responsesRender, { type: "message", role: "user", content: [{ type: "input_text", text: "and the dunning letters stage?" }] }, [
            { role: "user", content: "and the dunning letters stage?" },
            { role: "assistant", content: "dunning 9: letter dispatch latency is stable; queue depth under four" },
        ]],
        ["google", googleRender, { role: "user", parts: [{ text: "and the dunning letters stage?" }] }, [
            { role: "user", content: "and the dunning letters stage?" },
            { role: "assistant", content: "dunning 9: letter dispatch latency is stable; queue depth under four" },
        ]],
    ] as const) {
        const r = new PrefixAffinityResolver();
        const first = r.resolve(openaiRender())!;
        assert.equal(first.via, "new");
        r.note(first.sessionId, first.incomingDepth, first.tailHash, first.itemHashes, false, first.sketches, first.userFlags);

        // switch: the SAME history arrives re-rendered on the other wire,
        // plus one new user turn.
        const switched = r.resolve(render([extraTurn as unknown as Record<string, unknown>]))!;
        assert.equal(switched.via, "prefix", `${label}: cross-wire replay must resolve by exact prefix, not mint`);
        assert.equal(switched.sessionId, first.sessionId, `${label}: the session must survive the protocol switch`);
        assert.ok(switched.incomingDepth > first.incomingDepth, `${label}: depth must grow past the switch`);

        // and back to openai: the render extended past the foreign-wire turn
        // still matches (the fold ledger survived the round trip).
        r.note(switched.sessionId, switched.incomingDepth, switched.tailHash, switched.itemHashes, false, switched.sketches, switched.userFlags);
        const back = r.resolve(openaiRender(extraBack as unknown as Array<Record<string, unknown>>))!;
        assert.equal(back.via, "prefix", `${label}: switching back must also resolve by exact prefix`);
        assert.equal(back.sessionId, first.sessionId, `${label}: same session after the round trip`);
    }
});

test("#2791: dsh model-switch client markers are not user words — a marker turn never anchors identity", () => {
    const base = openaiRender();
    const withMarker = [
        ...base,
        { role: "user", content: "[model changed: assistant turns above this point were generated by glm-5.2; the session continues with qwen3.8]" },
        { role: "assistant", content: "noted; continuing with the audit under the new model" },
    ];
    const o = neutralTurns(base);
    const m = neutralTurns(withMarker);
    // The marker turn is dropped from the projection entirely — the chain
    // through it equals the chain of the conversation without it.
    assert.equal(m.length, o.length + 1, "only the marker itself is dropped, real turns survive");
    const r = new PrefixAffinityResolver();
    const first = r.resolve(base)!;
    r.note(first.sessionId, first.incomingDepth, first.tailHash, first.itemHashes, false, first.sketches, first.userFlags);
    const after = r.resolve(withMarker)!;
    assert.equal(after.via, "prefix", "a model-switch marker must not fork the session");
    assert.equal(after.sessionId, first.sessionId);
});

// #6659: a PARALLEL tool round with no assistant commentary. openai/anthropic
// render it as one assistant turn carrying all calls + one tool turn per
// result; responses renders it as adjacent function_call items with NO
// preceding assistant message; gemini renders it as N functionCall parts in
// one model message + N functionResponse parts in one user message. The
// neutral projection must reduce all four to the same turns — otherwise a
// stateless client's protocol switch forks the anonymous session.
const parallelUser = "audit both ledgers";
const parallelCalls = [
    { name: "read_file", args: { path: "/a" } },
    { name: "read_file", args: { path: "/b" } },
];
const parallelResults = ["ledger A: stable", "ledger B: stable"];

function parallelOpenai(): Array<Record<string, unknown>> {
    return [
        { role: "user", content: parallelUser },
        {
            role: "assistant",
            content: null,
            tool_calls: parallelCalls.map((c, i) => ({ id: `call_${i + 1}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
        },
        ...parallelResults.map((r, i) => ({ role: "tool", tool_call_id: `call_${i + 1}`, content: r })),
        { role: "user", content: "now summarize" },
    ];
}

function parallelAnthropic(): Array<Record<string, unknown>> {
    return [
        { role: "user", content: [{ type: "text", text: parallelUser }] },
        {
            role: "assistant",
            content: parallelCalls.map((c, i) => ({ type: "tool_use", id: `call_${i + 1}`, name: c.name, input: c.args })),
        },
        {
            role: "user",
            content: parallelResults.map((r, i) => ({ type: "tool_result", tool_use_id: `call_${i + 1}`, content: r })),
        },
        { role: "user", content: [{ type: "text", text: "now summarize" }] },
    ];
}

function parallelResponses(): Array<Record<string, unknown>> {
    return [
        { type: "message", role: "user", content: [{ type: "input_text", text: parallelUser }] },
        ...parallelCalls.map((c, i) => ({ type: "function_call", call_id: `call_${i + 1}`, name: c.name, arguments: JSON.stringify(c.args) })),
        ...parallelResults.map((r, i) => ({ type: "function_call_output", call_id: `call_${i + 1}`, output: r })),
        { type: "message", role: "user", content: [{ type: "input_text", text: "now summarize" }] },
    ];
}

function parallelGoogle(): Array<Record<string, unknown>> {
    return [
        { role: "user", parts: [{ text: parallelUser }] },
        { role: "model", parts: parallelCalls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) },
        { role: "user", parts: parallelResults.map((r, i) => ({ functionResponse: { name: parallelCalls[i]!.name, response: { output: r } } })) },
        { role: "user", parts: [{ text: "now summarize" }] },
    ];
}

test("#6659: a parallel tool round with no commentary projects to IDENTICAL turns on all four wires", () => {
    const o = neutralTurns(parallelOpenai());
    const a = neutralTurns(parallelAnthropic());
    const r = neutralTurns(parallelResponses());
    const g = neutralTurns(parallelGoogle());
    assert.equal(o.length, a.length, `openai vs anthropic turn counts (got ${o.length} vs ${a.length})`);
    assert.equal(o.length, r.length, `openai vs responses turn counts (got ${o.length} vs ${r.length})`);
    assert.equal(o.length, g.length, `openai vs google turn counts (got ${o.length} vs ${g.length})`);
    for (let i = 0; i < o.length; i++) {
        const oc = neutralTurnCanonical(o[i]!);
        assert.equal(oc, neutralTurnCanonical(a[i]!), `turn ${i} (${o[i]!.kind}) openai vs anthropic`);
        assert.equal(oc, neutralTurnCanonical(r[i]!), `turn ${i} (${o[i]!.kind}) openai vs responses`);
        assert.equal(oc, neutralTurnCanonical(g[i]!), `turn ${i} (${o[i]!.kind}) openai vs google`);
    }
    // The round must reduce to ONE assistant turn carrying BOTH calls, and
    // BOTH tool results must survive (neither dropped nor last-only).
    const callsTurn = o.find((t) => t.kind === "assistant" && t.calls !== undefined);
    assert.ok(callsTurn, "the parallel round must project to an assistant calls turn");
    assert.equal(callsTurn!.calls!.length, 2, "both parallel calls must land in the one turn");
    assert.equal(o.filter((t) => t.kind === "tool").length, 2, "both tool results must survive the projection");
});

test("#6659: a parallel round keeps the SAME anonymous session across the responses and google switches", () => {
    for (const [label, switched] of [
        ["responses", parallelResponses()],
        ["google", parallelGoogle()],
    ] as const) {
        const r = new PrefixAffinityResolver();
        const first = r.resolve(parallelOpenai())!;
        assert.equal(first.via, "new", `${label}: the openai lane establishes the session`);
        r.note(first.sessionId, first.incomingDepth, first.tailHash, first.itemHashes, false, first.sketches, first.userFlags);
        const sw = r.resolve(switched)!;
        assert.equal(sw.via, "prefix", `${label}: the parallel round must resolve by exact prefix, not mint`);
        assert.equal(sw.sessionId, first.sessionId, `${label}: the session must survive the protocol switch`);
    }
});

test("#6659: SEQUENTIAL single-call rounds stay separate turns (the merge must not over-reach)", () => {
    const seqOpenai: Array<Record<string, unknown>> = [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "r1" },
        { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "g", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c2", content: "r2" },
    ];
    const seqResponses: Array<Record<string, unknown>> = [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "r1" },
        { type: "function_call", call_id: "c2", name: "g", arguments: "{}" },
        { type: "function_call_output", call_id: "c2", output: "r2" },
    ];
    const seqGoogle: Array<Record<string, unknown>> = [
        { role: "user", parts: [{ text: "go" }] },
        { role: "model", parts: [{ functionCall: { name: "f", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "f", response: { output: "r1" } } }] },
        { role: "model", parts: [{ functionCall: { name: "g", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "g", response: { output: "r2" } } }] },
    ];
    const o = neutralTurns(seqOpenai).map(neutralTurnCanonical);
    const r = neutralTurns(seqResponses).map(neutralTurnCanonical);
    const g = neutralTurns(seqGoogle).map(neutralTurnCanonical);
    assert.equal(o.length, 5, "two sequential rounds must stay two assistant turns");
    assert.equal(r.length, o.length, `responses sequential turn count (got ${r.length} vs ${o.length})`);
    assert.equal(g.length, o.length, `google sequential turn count (got ${g.length} vs ${o.length})`);
    for (let i = 0; i < o.length; i++) {
        assert.equal(r[i], o[i], `turn ${i} openai vs responses sequential`);
        assert.equal(g[i], o[i], `turn ${i} openai vs google sequential`);
    }
});

test("#2791: pre-upgrade (raw-hash) entries still match through the v1 fallback rung and upgrade on re-note", () => {
    const openai = openaiRender();
    // A TRUE pre-upgrade entry: the raw-wire (v1) products a pre-#2791
    // process would have noted, no sketches, no hv marker in the snapshot.
    const raw = rawChainFingerprint(openai)!;
    const legacySnapshot = [{
        sessionId: "pfa-legacy000000001",
        depth: raw.depth,
        tailHash: raw.tailHash,
        itemHashes: raw.itemHashes,
        lastSeen: Date.now(),
    }];
    const legacy = new PrefixAffinityResolver();
    assert.equal(legacy.importSnapshot(legacySnapshot), 1);
    // The SAME wire (openai) still resolves — via the v1 fallback pass...
    const same = legacy.resolve(openai)!;
    assert.equal(same.sessionId, "pfa-legacy000000001", "a raw-noted entry must still match its own wire");
    assert.equal(same.via, "prefix");
    legacy.note(same.sessionId, same.incomingDepth, same.tailHash, same.itemHashes, false, same.sketches, same.userFlags);
    // ...and once re-noted (hv2), the CROSS-wire render resolves too.
    const crossed = legacy.resolve(anthropicRender([{ role: "user", content: [{ type: "text", text: "cross-wire after upgrade?" }] }]))!;
    assert.equal(crossed.via, "prefix", "re-noted entry must now match across wires");
    assert.equal(crossed.sessionId, "pfa-legacy000000001");
});
