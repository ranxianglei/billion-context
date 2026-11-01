import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap, refForRaw } from "acp-kernel";
import { responsesToCore, coreToResponses, type ResponsesProjection, type BiliMessage, type ResponsesRequestBody } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { stripKernelSummaries } from "../src/server.ts";
import { repairResponsesAssistantOrdering, collectSeparatorManifest, reanchorSeparatorManifest, separatorCoreProvenance, separatorProvenanceSet, isSeparatorCarrier, RESPONSES_TURN_SEPARATOR } from "../src/server/responses-ordering.ts";
import { stampOutbound } from "../src/chain-checkpoint.ts";
import { applyCompatRolesJson } from "../src/compat-roles.ts";
import { dropCompatFieldsJson } from "../src/compat-drop.ts";
import { patchResponsesInputWithToolImages as patchResponsesInput } from "../src/responses-tool-output.ts";
import { RESPONSES_TURN_SEPARATOR_ID_PREFIX } from "../src/turn-separator.ts";
import { _setInvariantJudgeForTest, maybeRunInvariantJudge, type JudgeVerdict } from "../src/invariant-judge.ts";

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


// --- #2627 final-wire re-anchoring (relay boundary) ---------------------
// prepare binds its claims to the exact bytes it serialized, and the relay then
// rewrites those bytes (compat roles, output steering, dropFields, the chain
// checkpoint). Those transforms mutate the parsed graph IN PLACE, so a marker's
// carrier keeps its object identity while its INDEX can move. The relay therefore
// runs them on the graph `collectSeparatorManifest` was handed — not on a fresh
// `JSON.parse`, which would hand it unrelated objects and prove nothing. Each test
// below builds that same graph, mutates it, and re-anchors.

function manifestWithSeparator() {
    const ordered = repairResponsesAssistantOrdering(SEPARATOR_FOLDED, SEPARATOR_ORIGINAL);
    const wire = coreToResponses(ordered.messages) as Item[];
    const body = JSON.stringify({ input: wire });
    const manifest = collectSeparatorManifest(wire, ordered.slots, body);
    assert.ok(manifest, "fixture produces a real producer-owned claim");
    // The relay's working graph: the SAME objects, wrapped as prepare wraps them.
    const graph = { input: wire } as { input: Item[] } & Record<string, unknown>;
    return { ordered, wire, graph, body, manifest };
}

test("#2627 re-anchor: a role rewrite that leaves carriers canonical keeps the claim", () => {
    const { ordered, graph, body, manifest } = manifestWithSeparator();
    // `assistant` → `developer` touches real assistant turns only; the marker
    // carrier is a `user` message and stays canonical.
    const rewritten = applyCompatRolesJson(graph, "responses", { assistant: "developer" });
    assert.ok(rewritten > 0, "fixture actually changed a role");
    const finalBody = JSON.stringify(graph);
    assert.notEqual(finalBody, body, "the rewrite produced different bytes");
    assert.equal(separatorProvenanceSet(manifest, graph.input, finalBody).size, 0, "the prepare-time binding no longer describes these bytes");
    const reanchored = reanchorSeparatorManifest(manifest, graph.input, finalBody);
    assert.ok(reanchored, "carrier identity survives the rewrite");
    assert.equal(reanchored.claims.length, 1);
    assert.equal(graph.input[reanchored.claims[0]!.index], ordered.slots[0]!.carrier, "the claim still points at the producer's own carrier object");
    assert.deepEqual([...separatorProvenanceSet(reanchored, graph.input, finalBody)], [reanchored.claims[0]!.index], "and the re-bound manifest is accepted against the final bytes");
});

test("#2627 re-anchor: a role rewrite that de-canonicalizes a carrier drops only that claim", () => {
    const { ordered, graph, manifest } = manifestWithSeparator();
    // `user` → `developer` rewrites the marker carrier itself out of its
    // canonical `{type:"message", role:"user"}` shape — the claim cannot be
    // honoured, and re-anchoring must NOT hand it to the neighbour.
    const rewritten = applyCompatRolesJson(graph, "responses", { user: "developer" });
    assert.ok(rewritten > 0, "fixture actually changed a role");
    assert.equal(graph.input.indexOf(ordered.slots[0]!.carrier) >= 0, true, "the object is still there");
    const finalBody = JSON.stringify(graph);
    assert.equal(reanchorSeparatorManifest(manifest, graph.input, finalBody), undefined, "a non-canonical carrier proves nothing");
    assert.equal(separatorProvenanceSet(manifest, graph.input, finalBody).size, 0, "and nothing is exempted for the judge");
});

test("#2627 re-anchor: a fresh JSON.parse of the same body proves nothing (seeding regression)", () => {
    const { ordered, graph, body, manifest } = manifestWithSeparator();
    // The relay must seed its working graph from prepare's OWN parsed object
    // (`prepared.parsedBody`), because that object is the one
    // `collectSeparatorManifest` walked. A fresh parse of the identical bytes
    // yields equal-looking but DIFFERENT objects, so no claim can re-anchor —
    // this is why seeding from `parsedBody` (not `JSON.parse(prepared.body)`)
    // is load-bearing rather than an optimization.
    const reparsed = JSON.parse(body) as { input: Item[] };
    assert.deepEqual(reparsed.input, graph.input, "the bodies are identical as JSON");
    assert.equal(reanchorSeparatorManifest(manifest, reparsed.input, body), undefined, "but a re-parse carries no object identity, so it re-anchors nothing");
    const seeded = reanchorSeparatorManifest(manifest, graph.input, body);
    assert.ok(seeded, "the prepare-owned graph does re-anchor");
    assert.equal(graph.input[seeded.claims[0]!.index], ordered.slots[0]!.carrier);
});

test("#2627 re-anchor: an appended checkpoint keeps the claim on its own carrier", () => {
    const { ordered, graph, manifest } = manifestWithSeparator();
    const marker = ordered.slots[0]!.carrier;
    assert.ok(graph.input.indexOf(marker) >= 0, "fixture carries the marker");
    const stamped = stampOutbound(graph, "responses", "proc-1", 1_700_000_000_000) as { input: Item[] };
    assert.ok(stamped, "fixture stamped");
    assert.notEqual(stamped.input.length, graph.input.length, "the checkpoint added a carrier");
    const finalBody = JSON.stringify(stamped);
    const reanchored = reanchorSeparatorManifest(manifest, stamped.input, finalBody);
    assert.ok(reanchored, "the marker carrier is still in the graph");
    const claim = reanchored.claims[0]!;
    assert.equal(stamped.input[claim.index], marker, "re-indexed onto the same object, never a neighbour");
    assert.equal(claim.index, stamped.input.indexOf(marker), "the claim index IS the carrier's position in the final array");
    assert.equal(isSeparatorCarrier(stamped.input[claim.index]), true, "and it is still a canonical carrier there");
});

test("#2627 re-anchor: a checkpoint inserted BEFORE the marker shifts the claim with it", () => {
    const { ordered, graph, manifest } = manifestWithSeparator();
    // Force a real pre-marker insertion: a trailing compaction_trigger makes the
    // checkpoint land before it, and a marker that sits after the insertion point
    // must keep pointing at itself while its index moves.
    const marker = ordered.slots[0]!.carrier as Item;
    const shifted = { input: [{ type: "message", role: "user", content: "pre" } as Item, ...graph.input, { type: "compaction_trigger" } as Item] };
    assert.ok(shifted.input.indexOf(marker) > graph.input.indexOf(marker), "fixture shifted the marker");
    const stamped = stampOutbound(shifted, "responses", "proc-1", 1_700_000_000_000) as { input: Item[] };
    assert.ok(stamped, "fixture stamped");
    const reanchored = reanchorSeparatorManifest(manifest, stamped.input, JSON.stringify(stamped));
    assert.ok(reanchored, "the marker survived the insertion");
    assert.equal(reanchored.claims.length, 1, "and only the producer's marker is claimed");
    assert.equal(stamped.input[reanchored.claims[0]!.index], marker, "the claim followed the marker, not the old index");
    assert.notEqual(reanchored.claims[0]!.index, manifest.claims[0]!.index, "the prepare-time index would have pointed at the wrong item");
});

test("#2627 re-anchor: the real judge accepts a stamped turn without a false I1/I2", () => {
    const { graph, manifest } = manifestWithSeparator();
    const entry = responsesToCore({ input: coreToResponses(SEPARATOR_FOLDED) } as Parameters<typeof responsesToCore>[0]).msgs;
    const stamped = stampOutbound(graph, "responses", "proc-1", 1_700_000_000_000) as { input: Item[] };
    const finalBody = JSON.stringify(stamped);
    const reanchored = reanchorSeparatorManifest(manifest, stamped.input, finalBody);
    assert.ok(reanchored);
    const verdicts: JudgeVerdict[] = [];
    _setInvariantJudgeForTest(true, (verdict) => { verdicts.push(verdict); });
    try {
        // Without the re-anchor the stale binding exempts nothing, so the judge
        // reports the marker as a mid-history insertion.
        maybeRunInvariantJudge({ originalMessages: entry, body: finalBody, parsed: JSON.parse(finalBody), protocol: "responses", separatorManifest: manifest });
        assert.equal(verdicts.at(-1)?.ok, false, "an unproven separator is judged as an insertion");

        maybeRunInvariantJudge({ originalMessages: entry, body: finalBody, parsed: JSON.parse(finalBody), protocol: "responses", separatorManifest: reanchored });
        assert.equal(verdicts.at(-1)?.ok, true, "the re-anchored claim excuses exactly the producer's marker");
        assert.deepEqual(verdicts.at(-1)?.violations ?? [], [], "no I1/I2 finding survives the re-anchor");
    } finally {
        _setInvariantJudgeForTest(false);
    }
});

test("#2627 re-anchor: a client look-alike is never adopted by the re-anchor", () => {
    const { ordered, graph, manifest } = manifestWithSeparator();
    // A client item with the separator's exact text (and a reserved-looking id in
    // its payload) sits next to the producer's marker.
    graph.input.splice(0, 0, { type: "message", role: "user", content: RESPONSES_TURN_SEPARATOR, id: `${RESPONSES_TURN_SEPARATOR_ID_PREFIX}99` } as Item);
    const finalBody = JSON.stringify(graph);
    const reanchored = reanchorSeparatorManifest(manifest, graph.input, finalBody);
    assert.ok(reanchored, "the producer's marker is still present");
    assert.equal(reanchored.claims.length, 1, "the look-alike adds no claim even though its shape matches");
    assert.equal(graph.input[reanchored.claims[0]!.index], ordered.slots[0]!.carrier, "the single claim is the producer's object");
    assert.notEqual(reanchored.claims[0]!.index, 0, "the client item at index 0 is not adopted");
    const owned = separatorProvenanceSet(reanchored, graph.input, finalBody);
    assert.deepEqual([...owned], [reanchored.claims[0]!.index], "the judge exempts only the producer's index");
});

test("#2627 re-anchor: a replaced or dropped carrier fails closed", () => {
    const { ordered, graph, manifest } = manifestWithSeparator();
    // Replaced with a fresh look-alike object (an opaque rewrite or re-serialize).
    const replaced = { input: graph.input.map((item) => (item === ordered.slots[0]!.carrier ? { type: "message", role: "user", content: RESPONSES_TURN_SEPARATOR } as Item : item)) };
    assert.equal(reanchorSeparatorManifest(manifest, replaced.input, JSON.stringify(replaced)), undefined, "a substituted object proves no lineage");
    // Dropped entirely.
    const removed = { input: graph.input.filter((item) => item !== ordered.slots[0]!.carrier) };
    assert.equal(reanchorSeparatorManifest(manifest, removed.input, JSON.stringify(removed)), undefined, "an absent carrier claims nothing");
    // A body the caller cannot vouch for (no string) also fails closed.
    assert.equal(reanchorSeparatorManifest(manifest, graph.input, null), undefined, "no body binding, no claims");
});

test("#2627 drop-fields: an unrelated dotted drop keeps only the real claim", () => {
    const { ordered, graph, body, manifest } = manifestWithSeparator();
    // A configured drop that touches a plain object elsewhere on the wire. The
    // marker carrier is untouched by reference, so its claim survives — the
    // blanket "any dotted path ⇒ discard all claims" rule was too broad.
    graph.plausible = { nested: { keep: 1, gone: 2 } } as never;
    const dropped = dropCompatFieldsJson(graph as Record<string, unknown>, ["plausible.nested.gone"]);
    assert.equal(dropped, 1, "fixture actually deleted a key");
    const finalBody = JSON.stringify(graph);
    assert.notEqual(finalBody, body, "the drop produced different bytes");
    const reanchored = reanchorSeparatorManifest(manifest, graph.input, finalBody);
    assert.ok(reanchored, "an unrelated structural deletion destroys no lineage");
    assert.equal(reanchored.claims.length, 1, "exactly the producer's marker stays claimed");
    assert.equal(graph.input[reanchored.claims[0]!.index], ordered.slots[0]!.carrier);
    assert.deepEqual([...separatorProvenanceSet(reanchored, graph.input, finalBody)], [reanchored.claims[0]!.index]);
});

test("#2627 drop-fields: a root drop that deletes `input` grants nothing", () => {
    const { graph, manifest } = manifestWithSeparator();
    // The carrier is deleted with its whole array: no claim may be handed to
    // anything else, and the manifest must not survive.
    const dropped = dropCompatFieldsJson(graph as Record<string, unknown>, ["input"]);
    assert.equal(dropped, 1, "fixture deleted the carrier container");
    assert.equal("input" in graph, false, "the array itself is gone");
    assert.equal(reanchorSeparatorManifest(manifest, undefined, JSON.stringify(graph)), undefined, "no carriers ⇒ no claims");
});

test("#2627 unknown ownership: an opaque rewrite reports no separator I1/I2 but stays armed", () => {
    const { graph, manifest } = manifestWithSeparator();
    const entry = responsesToCore({ input: coreToResponses(SEPARATOR_ORIGINAL) } as Parameters<typeof responsesToCore>[0]).msgs;
    const body = JSON.stringify(graph);
    const verdicts: JudgeVerdict[] = [];
    _setInvariantJudgeForTest(true, (verdict) => { verdicts.push(verdict); });
    try {
        // BASELINE: with the manifest proven against these bytes the marker is
        // exempt, so the same send is clean.
        maybeRunInvariantJudge({ originalMessages: entry, body, parsed: JSON.parse(body), protocol: "responses", separatorManifest: manifest });
        assert.equal(verdicts.at(-1)?.ok, true, "the anchored claim exempts the producer's own marker");

        // ABSENT (the pre-fix bug): dropping the manifest without recording that
        // ownership is unknown makes the judge read bili's marker as a client
        // insertion — the false I1 this feature exists to prevent.
        maybeRunInvariantJudge({ originalMessages: entry, body, parsed: JSON.parse(body), protocol: "responses" });
        assert.equal(verdicts.at(-1)?.ok, false, "no claims at all ⇒ the marker is judged as an insertion");
        assert.ok((verdicts.at(-1)?.violations ?? []).some((v) => v.kind === "mid-insertion"), "and the finding is specifically an insertion");

        // UNKNOWN: an opaque host rewrite destroyed the proof, so the same send
        // must not be accused of an insertion bili itself made.
        maybeRunInvariantJudge({ originalMessages: entry, body, parsed: JSON.parse(body), protocol: "responses", separatorOwnershipUnknown: true });
        assert.equal(verdicts.at(-1)?.ok, true, "unknown ownership does not accuse the client of bili's own marker");
        assert.deepEqual(verdicts.at(-1)?.violations ?? [], [], "and no I1/I2 survives it");

        // ...while a NON-separator integrity finding still fires under unknown
        // ownership: an orphaned tool call is a tool-pair problem, not a
        // separator question, so it must not be excused.
        const orphaned = { input: [...graph.input, { type: "function_call", call_id: "call_orphan", name: "f", arguments: "{}" } as unknown as Item] };
        maybeRunInvariantJudge({ originalMessages: entry, body: JSON.stringify(orphaned), parsed: orphaned as never, protocol: "responses", separatorOwnershipUnknown: true });
        assert.equal(verdicts.at(-1)?.ok, false, "unknown separator ownership does not disarm unrelated checks");
        assert.ok((verdicts.at(-1)?.violations ?? []).some((v) => v.kind === "unpaired-tool-call"), "the tool-pair finding is still reported");
    } finally {
        _setInvariantJudgeForTest(false);
    }
});

test("#2627 unknown ownership: a client-only look-alike is still judged", () => {
    // No producer manifest at all ⇒ ownership is ABSENT, not unknown. A client
    // that sends a separator-shaped item on its own gets the normal verdict —
    // and adding a manifest for someone else's turn does not change that.
    const entry = responsesToCore({ input: coreToResponses(SEPARATOR_ORIGINAL) } as Parameters<typeof responsesToCore>[0]).msgs;
    // Mid-history, where an unexplained element is an INSERTION: appending after
    // the whole inbound is a legitimate client tail, not a false exemption.
    const items = coreToResponses(SEPARATOR_ORIGINAL) as Item[];
    const outbound = {
        input: [
            items[0]!,
            { type: "message", role: "user", content: RESPONSES_TURN_SEPARATOR } as Item,
            ...items.slice(1),
        ],
    };
    const body = JSON.stringify(outbound);
    const verdicts: JudgeVerdict[] = [];
    _setInvariantJudgeForTest(true, (verdict) => { verdicts.push(verdict); });
    try {
        maybeRunInvariantJudge({ originalMessages: entry, body, parsed: JSON.parse(body), protocol: "responses" });
        assert.equal(verdicts.at(-1)?.ok, false, "a client-origin look-alike is a real insertion when nothing is unknown");
        assert.ok((verdicts.at(-1)?.violations ?? []).some((v) => v.kind === "mid-insertion"), "and it is reported as an insertion");
    } finally {
        _setInvariantJudgeForTest(false);
    }
});
