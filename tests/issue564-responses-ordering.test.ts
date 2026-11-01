import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap, refForRaw } from "acp-kernel";
import { responsesToCore, coreToResponses, type ResponsesProjection, type BiliMessage, type ResponsesRequestBody } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { stripKernelSummaries } from "../src/server.ts";
import { repairResponsesAssistantOrdering, collectSeparatorManifest, separatorCoreProvenance, separatorProvenanceSet, isSeparatorCarrier, RESPONSES_TURN_SEPARATOR } from "../src/server/responses-ordering.ts";
import { patchResponsesInputWithToolImages as patchResponsesInput } from "../src/responses-tool-output.ts";
import { RESPONSES_TURN_SEPARATOR_ID_PREFIX } from "../src/turn-separator.ts";
import { _setInvariantJudgeForTest, maybeRunInvariantJudge } from "../src/invariant-judge.ts";

// #564 regression: after a successful compress, upstream must still receive a
// valid Responses assistant history. Within one assistant run the order is
// reasoning* -> message* -> function_call* with at most one reasoning item; a
// non-assistant item breaks a run. Folding + stripKernelSummaries can merge two
// runs into one, so these pin the repaired FINAL view, not the pre-dedup fold.

type Item = Record<string, unknown>;

function makeSession(): Session {
    return {
        id: "issue564-test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100, contextTokens: 100, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0,         rangeRestores: 0 },
        pendingRetrievals: [],
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

const COMPLETED = sse("response.completed", { response: { id: "resp_done", status: "completed", output: [] } });
const SYS_PROMPT = buildCompressSystemPrompt();

function reFetchProbe(respond: (n: number) => Response): { calls: () => number; bodies: () => string[]; restore: () => void } {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return respond(n);
    }) as typeof fetch;
    return { calls: () => n, bodies: () => bodies, restore: () => { globalThis.fetch = orig; } };
}

function describe(it: Item, i: number): string {
    const t = String(it.type ?? "?");
    const role = typeof it.role === "string" ? `/${it.role}` : "";
    let extra = "";
    if (it.type === "message") {
        const c = it.content;
        extra = typeof c === "string" ? `:"${c.slice(0, 28)}"` : Array.isArray(c) ? `:${JSON.stringify(c).slice(0, 34)}` : "";
    } else if (it.type === "reasoning") {
        extra = typeof it.encrypted_content === "string" ? `:enc=${it.encrypted_content}` : "";
    } else if (typeof it.call_id === "string") {
        extra = `:${it.call_id}`;
    }
    return `${i}:${t}${role}${extra}`;
}

function assertValidAssistantOrdering(items: Item[], label: string): void {
    let phase = -1; // -1 none, 0 reasoning, 1 message, 2 function_call within current run
    let seenReasoning = false;
    const dump = () => items.map((x, j) => describe(x, j)).join("\n  ");
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const t = it.type;
        const inAssistantRun =
            t === "reasoning" ||
            (t === "message" && it.role === "assistant") ||
            t === "function_call" ||
            t === "custom_tool_call";
        if (!inAssistantRun) { phase = -1; seenReasoning = false; continue; }
        if (t === "reasoning") {
            if (seenReasoning) throw new Error(`${label}: item ${i} reasoning follows another reasoning Item\n  ${dump()}`);
            if (phase > 0) throw new Error(`${label}: item ${i} reasoning follows assistant content (phase=${phase})\n  ${dump()}`);
            seenReasoning = true;
            phase = Math.max(phase, 0);
        } else if (t === "message") {
            if (phase === 2) throw new Error(`${label}: item ${i} message follows function_call\n  ${dump()}`);
            phase = Math.max(phase, 1);
        } else {
            phase = Math.max(phase, 2);
        }
    }
}

function twoTurnBody(): Record<string, unknown> {
    return {
        model: "gpt-4o",
        stream: true,
        input: [
            { type: "message", role: "user", content: "inspect files A and B" },
            { type: "reasoning", id: "rs_a", summary: [{ type: "summary_text", text: "REASONING-A" }], encrypted_content: "ENC_A" },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "TEXT-A" }] },
            { type: "function_call", id: "fc_a", call_id: "ca", name: "bash", arguments: "{\"cmd\":\"ls A\"}" },
            { type: "function_call_output", call_id: "ca", output: "A listed" },
            { type: "reasoning", id: "rs_b", summary: [{ type: "summary_text", text: "REASONING-B" }], encrypted_content: "ENC_B" },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "TEXT-B" }] },
            { type: "function_call", id: "fc_b", call_id: "cb", name: "bash", arguments: "{\"cmd\":\"ls B\"}" },
            { type: "function_call_output", call_id: "cb", output: "B listed" },
        ],
    };
}

const userMsg = (id: string, text: string): CoreMessage => ({ id, role: "user", contentType: "text", text });
const asstMsg = (id: string, text: string): CoreMessage => ({ id, role: "assistant", contentType: "text", text });
const reasoningMsg = (id: string, enc: string): CoreMessage & { rawResponsesItem: Record<string, unknown> } => ({ id, role: "assistant", contentType: "reasoning", text: id, rawResponsesItem: { type: "reasoning", id, encrypted_content: enc, summary: [] } });
const toolCall = (id: string, callId: string, name: string, args: string): CoreMessage => ({ id, role: "assistant", contentType: "tool-call", toolCallId: callId, toolName: name, text: args });
const toolResult = (id: string, callId: string, out: string): CoreMessage => ({ id, role: "tool", contentType: "tool-result", toolCallId: callId, text: out });

function wireItems(core: CoreMessage[]): Item[] {
    return coreToResponses(core) as Item[];
}

test("#564 path 2: compress re-request keeps Responses assistant run ordering valid after summary dedup", async () => {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000, {
        compress: { minCompressRange: 0, minSummaryLength: 0, maxSummaryLength: 20000 },
        preserveRecentMessages: 4,
        preserveRecentTokens: 0,
    });
    const projection = responsesToCore(twoTurnBody() as ResponsesRequestBody);
    const original = projection.msgs;
    const prepTurn = core.processTurn({ messages: original, state: session.state, config, tokenCount: 100, renderTags: "text-only" });
    session.state = prepTurn.state;
    const processed = stripKernelSummaries(prepTurn.messages as BiliMessage[], prepTurn.state) as CoreMessage[];
    session.state.messageRefs = assignRefs(processed, { existing: emptyRefMap(), nextIndex: 0 }).map;

    const refOf = (m: CoreMessage): string | null => refForRaw(session.state.messageRefs, m.id);
    const fcA = processed.find((m) => m.contentType === "tool-call" && m.toolCallId === "ca");
    const fcoA = processed.find((m) => m.contentType === "tool-result" && m.toolCallId === "ca");
    assert.ok(fcA && fcoA, "bash_a call+result present in prepared view");
    const startRef = refOf(fcA!);
    const endRef = refOf(fcoA!);
    assert.ok(startRef && endRef, "refs resolved for the bash_a interaction");

    const args = JSON.stringify({ content: [{ startId: startRef!, endId: endRef!, summary: "Inspected files A and B." }] });
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", args),
        COMPLETED,
    ].join("");

    const probe = reFetchProbe(() => new Response(COMPLETED, { status: 200, headers: { "content-type": "text/event-stream" } }));
    let refreshCalls = 0;
    const refreshFolded = (current: CoreMessage[]): CoreMessage[] => {
        refreshCalls++;
        const t = core.processTurn({ messages: original, state: session.state, config, tokenCount: 100, renderTags: "text-only" });
        session.state = t.state;
        const records = current.filter((m) => typeof m.id === "string" && m.id.startsWith("acp_loop_"));
        return repairResponsesAssistantOrdering(stripKernelSummaries([...t.messages, ...records] as BiliMessage[], t.state), original).messages;
    };
    const ctx = {
        core, config,
        messages: processed.length > 0 ? processed : original,
        compressMessages: original,
        session, log: () => {}, protocol: "responses" as const,
        refreshFolded,
    };
    try {
        const adapter = createResponsesAdapter(false, projection);
        const out: Buffer[] = [];
        for await (const c of runCompressLoop(new Response(round1, { status: 200 }).body!, ctx, body(), { url: "http://mock", headers: {} }, adapter, SYS_PROMPT)) {
            out.push(c);
        }
        void Buffer.concat(out);
    } finally {
        probe.restore();
    }

    function body(): Record<string, unknown> { return twoTurnBody(); }

    assert.ok(probe.calls() >= 1, "re-request must fire after compress");
    assert.equal(refreshCalls, 1, "refreshFolded ran (otherwise the post-compress view is untested)");
    const rb = JSON.parse(probe.bodies()[0]) as { input: unknown };
    assert.ok(Array.isArray(rb.input), "re-request input is an array");
    const input = rb.input as Item[];

    assertValidAssistantOrdering(input, "#564 re-request");

    const encs = input.filter((i) => i.type === "reasoning").map((i) => i.encrypted_content);
    assert.ok(encs.includes("ENC_A"), `reasoning A encrypted_content preserved verbatim; got ${JSON.stringify(encs)}`);
    assert.ok(encs.includes("ENC_B"), `reasoning B encrypted_content preserved verbatim; got ${JSON.stringify(encs)}`);
    const all = JSON.stringify(input);
    assert.ok(all.includes("TEXT-A"), "turn A assistant text preserved");
    assert.ok(all.includes("TEXT-B"), "turn B assistant text preserved");
});

test("#564 path 1: reasoning whose whole turn body was folded away is dropped", () => {
    const original: CoreMessage[] = [
        userMsg("u1", "q"),
        reasoningMsg("rsX", "ENC_X"), asstMsg("txX", "BODY-X"), toolCall("fcx", "cx", "bash", "{}"), toolResult("fcox", "cx", "done"),
        reasoningMsg("rsY", "ENC_Y"), asstMsg("txY", "BODY-Y"),
    ];
    const folded: CoreMessage[] = [
        userMsg("u1", "q"),
        reasoningMsg("rsX", "ENC_X"),
        reasoningMsg("rsY", "ENC_Y"), asstMsg("txY", "BODY-Y"),
    ];
    const out = repairResponsesAssistantOrdering(folded, original).messages;
    const ids = out.map((m) => m.id);
    assert.ok(!ids.includes("rsX"), "orphaned reasoning rsX dropped (its body was compressed into the block)");
    assert.ok(ids.includes("rsY") && ids.includes("txY"), "turn Y reasoning+body retained");
    assertValidAssistantOrdering(wireItems(out), "path1-drop");
});

test("#564 path 1b: originally-reasoning-only turn keeps its reasoning, runs stay separated", () => {
    const original: CoreMessage[] = [
        userMsg("u1", "q"),
        reasoningMsg("rsZ", "ENC_Z"), toolResult("sepc", "sc", "sep"),
        reasoningMsg("rsY", "ENC_Y"), asstMsg("txY", "BODY-Y"),
    ];
    const folded: CoreMessage[] = [
        userMsg("u1", "q"),
        reasoningMsg("rsZ", "ENC_Z"),
        reasoningMsg("rsY", "ENC_Y"), asstMsg("txY", "BODY-Y"),
    ];
    const out = repairResponsesAssistantOrdering(folded, original).messages;
    const ids = out.map((m) => m.id);
    assert.ok(ids.includes("rsZ"), "reasoning-only turn's reasoning is NOT dropped");
    assert.ok(ids.some((id) => id.startsWith("acp_turn_sep_")), "a separator was inserted between the two runs");
    assertValidAssistantOrdering(wireItems(out), "path1b-kept");
});

test("#564: a surviving acp_summary carrier is untouched (no spurious separator)", () => {
    const original: CoreMessage[] = [
        userMsg("u1", "q"),
        reasoningMsg("rsA", "ENC_A"), asstMsg("txA", "TEXT-A"),
        reasoningMsg("rsB", "ENC_B"), asstMsg("txB", "TEXT-B"),
    ];
    const carrier = userMsg("acp_summary_b1", "Inspected files A and B.");
    const folded: CoreMessage[] = [userMsg("u1", "q"), reasoningMsg("rsA", "ENC_A"), asstMsg("txA", "TEXT-A"), carrier, reasoningMsg("rsB", "ENC_B"), asstMsg("txB", "TEXT-B")];
    const out = repairResponsesAssistantOrdering(folded, original).messages;
    assert.equal(out.length, folded.length, "nothing added or dropped when a non-assistant carrier already separates the runs");
    assert.ok(out.map((m) => m.id).includes("acp_summary_b1"), "summary carrier preserved");
    assert.ok(!out.some((m) => (m.text ?? "").includes("compressed")), "no synthetic separator injected");
    assertValidAssistantOrdering(wireItems(out), "carrier");
});

// --- #564/#2627 producer-owned provenance -------------------------------
// A separator is outbound-only and, on the wire, byte-identical to a client
// user message carrying the same text (coreToResponses emits
// {type:"message",role:"user",content:<text>} and responsesToCore re-derives the
// core id from text alone). Provenance is therefore OBJECT IDENTITY: the producer
// mints the canonical carrier on the marker core's `rawResponsesItem` sidecar,
// the real codec emits that very object, and the claim is the index where that
// object is found in the FINAL array.

const SEPARATOR_ORIGINAL: CoreMessage[] = [
    userMsg("u1", "q"),
    reasoningMsg("rsA", "ENC_A"), asstMsg("txA", "TEXT-A"),
    reasoningMsg("rsB", "ENC_B"), asstMsg("txB", "TEXT-B"),
];

const SEPARATOR_FOLDED: CoreMessage[] = [
    userMsg("u1", "q"),
    reasoningMsg("rsA", "ENC_A"), asstMsg("txA", "TEXT-A"),
    reasoningMsg("rsB", "ENC_B"), asstMsg("txB", "TEXT-B"),
];


test("#2627 provenance: identical CLIENT prose is never claimed", () => {
    const ordered = repairResponsesAssistantOrdering(SEPARATOR_FOLDED, SEPARATOR_ORIGINAL);
    // The client added its own user message carrying the separator's exact text,
    // and even a core whose id looks like a producer marker.
    const prose: CoreMessage = { id: `${RESPONSES_TURN_SEPARATOR_ID_PREFIX}99`, role: "user", contentType: "text", text: RESPONSES_TURN_SEPARATOR };
    const withProse: CoreMessage[] = [...ordered.messages.slice(0, 1), prose, ...ordered.messages.slice(1)];
    const wire = coreToResponses(withProse) as unknown[];
    const body = JSON.stringify({ input: wire });
    const manifest = collectSeparatorManifest(wire, ordered.slots, body);
    assert.ok(manifest, "the producer's real marker is still claimed");
    assert.equal(manifest.claims.length, 1, "the client's look-alike id and text add no claim");
    assert.equal(manifest.claims[0]!.id, ordered.slots[0]!.id, "only the producer's own marker id is claimed");
    assert.equal(wire[manifest.claims[0]!.index], ordered.slots[0]!.carrier, "the claimed index is the producer's carrier object");
    // The look-alike sits somewhere else in the array and stays judgeable.
    const clientIndex = wire.findIndex((item) => (item as Item)["content"] === RESPONSES_TURN_SEPARATOR && item !== ordered.slots[0]!.carrier);
    assert.equal(separatorProvenanceSet(manifest, wire, body).has(clientIndex), false);
});

test("#2627 provenance: a dropped carrier claims nothing", () => {
    const ordered = repairResponsesAssistantOrdering(SEPARATOR_FOLDED, SEPARATOR_ORIGINAL);
    const wire = coreToResponses(ordered.messages) as Item[];
    // Simulate a rewrite that replaces the carrier with a fresh look-alike object.
    const replaced = wire.map((item) => (item === ordered.slots[0]!.carrier ? { type: "message", role: "user", content: RESPONSES_TURN_SEPARATOR } : item));
    assert.equal(collectSeparatorManifest(replaced, ordered.slots, JSON.stringify({ input: replaced })), undefined, "a substituted object is not the producer's carrier");
    // And a rewrite that removes it entirely.
    const removed = wire.filter((item) => item !== ordered.slots[0]!.carrier);
    assert.equal(collectSeparatorManifest(removed, ordered.slots, JSON.stringify({ input: removed })), undefined, "a dropped carrier yields no claims");
});

test("#2627 provenance: an inserted item re-anchors the carrier to its new index", () => {
    const ordered = repairResponsesAssistantOrdering(SEPARATOR_FOLDED, SEPARATOR_ORIGINAL);
    const wire = coreToResponses(ordered.messages) as Item[];
    const before = collectSeparatorManifest(wire, ordered.slots, JSON.stringify({ input: wire }))!;
    // strict-echo inserts blank reasoning; the producer's carrier keeps its
    // identity and its index is re-derived, never carried over stale.
    const shifted = [...wire.slice(0, 1), { type: "reasoning", summary: [{ type: "summary_text", text: "" }] }, ...wire.slice(1)];
    const after = collectSeparatorManifest(shifted, ordered.slots, JSON.stringify({ input: shifted }));
    assert.ok(after, "the carrier is still present, so the claim survives");
    assert.equal(after.claims[0]!.index, before.claims[0]!.index + 1, "the index follows the carrier, not the old position");
    assert.equal(shifted[after.claims[0]!.index], ordered.slots[0]!.carrier);
});

test("#2627 provenance: an altered carrier fails revalidation", () => {
    const ordered = repairResponsesAssistantOrdering(SEPARATOR_FOLDED, SEPARATOR_ORIGINAL);
    const wire = coreToResponses(ordered.messages) as Item[];
    const body = JSON.stringify({ input: wire });
    const manifest = collectSeparatorManifest(wire, ordered.slots, body)!;
    const mutated = wire.map((item, k) => (k === manifest.claims[0]!.index ? { ...item, content: `${RESPONSES_TURN_SEPARATOR} (edited)` } : item));
    assert.equal(separatorProvenanceSet(manifest, mutated, JSON.stringify({ input: mutated })).size, 0, "a rewritten body drops the claims");
    const reparsed = JSON.parse(body) as { input: Item[] };
    assert.equal(separatorProvenanceSet(manifest, reparsed.input, body).size, 1, "a fresh parse of the exact body keeps the proven claim");
});

test("#2627 provenance: the actual wire judge accepts only body-bound producer claims", () => {
    const ordered = repairResponsesAssistantOrdering(SEPARATOR_FOLDED, SEPARATOR_ORIGINAL);
    const wire = coreToResponses(ordered.messages) as Item[];
    const entry = responsesToCore({ input: coreToResponses(SEPARATOR_FOLDED) } as Parameters<typeof responsesToCore>[0]).msgs;
    const body = JSON.stringify({ input: wire });
    const manifest = collectSeparatorManifest(wire, ordered.slots, body)!;
    const verdicts: { ok: boolean }[] = [];
    _setInvariantJudgeForTest(true, (verdict) => { verdicts.push(verdict); });
    try {
        maybeRunInvariantJudge({ originalMessages: entry, body, parsed: JSON.parse(body), protocol: "responses", separatorManifest: manifest });
        assert.equal(verdicts.at(-1)?.ok, true, "a fresh parse of the real codec output accepts its producer-owned separator");

        const changedBody = `${body} `;
        maybeRunInvariantJudge({ originalMessages: entry, body: changedBody, parsed: JSON.parse(changedBody), protocol: "responses", separatorManifest: manifest });
        assert.equal(verdicts.at(-1)?.ok, false, "semantically equal but changed bytes cannot borrow the old provenance");

        const prose: CoreMessage = { id: `${RESPONSES_TURN_SEPARATOR_ID_PREFIX}99`, role: "user", contentType: "text", text: RESPONSES_TURN_SEPARATOR };
        const spoofWire = coreToResponses([...ordered.messages.slice(0, 1), prose, ...ordered.messages.slice(1)]) as Item[];
        const spoofBody = JSON.stringify({ input: spoofWire });
        const spoofManifest = collectSeparatorManifest(spoofWire, ordered.slots, spoofBody);
        maybeRunInvariantJudge({ originalMessages: entry, body: spoofBody, parsed: JSON.parse(spoofBody), protocol: "responses", separatorManifest: spoofManifest });
        assert.equal(verdicts.at(-1)?.ok, false, "client-authored look-alike text and a reserved-looking id remain judgeable");
    } finally {
        _setInvariantJudgeForTest(false);
    }
});

test("#2627 provenance: multipart and opaque layout items survive with a marker", () => {
    const multipart = { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_text", text: " world" }] };
    const opaque = { type: "item_reference", id: "opaque_ref" };
    const originalWire: Item[] = [
        multipart,
        { type: "reasoning", id: "rsA", encrypted_content: "ENC_A", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "TEXT-A" }] },
        opaque,
        { type: "message", role: "user", content: "turn removed by folding" },
        { type: "reasoning", id: "rsB", encrypted_content: "ENC_B", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "TEXT-B" }] },
    ];
    const parsed = responsesToCore({ input: originalWire } as unknown as Parameters<typeof responsesToCore>[0]);
    const original = parsed.msgs as CoreMessage[];
    const folded = original.filter((message) => message.text !== "turn removed by folding");
    const ordered = repairResponsesAssistantOrdering(folded, original);
    assert.equal(ordered.slots.length, 1, "folding joined two reasoning-bearing assistant turns");
    const rebuilt = patchResponsesInput(parsed, ordered.messages) as Item[];
    assert.deepEqual(rebuilt.find((item) => item["type"] === "item_reference"), opaque);
    assert.deepEqual(rebuilt.find((item) => item["role"] === "user"), multipart);
    assert.deepEqual(rebuilt.filter((item) => item["type"] === "reasoning"), originalWire.filter((item) => item["type"] === "reasoning"));
    const body = JSON.stringify({ input: rebuilt });
    const manifest = collectSeparatorManifest(rebuilt, ordered.slots, body);
    assert.ok(manifest);
    const reparsed = JSON.parse(body) as { input: Item[] };
    assert.equal(separatorProvenanceSet(manifest, reparsed.input, body).size, 1);
});

