import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap, refForRaw } from "acp-kernel";
import { responsesToCore, coreToResponses, type ResponsesProjection, type BiliMessage } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";
import { startServer } from "../src/server.ts";
import { stripKernelSummaries } from "../src/server/prepare-shared.ts";
import { repairResponsesAssistantOrdering } from "../src/server/prepare-responses.ts";

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
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100, contextTokens: 100 },
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
const reasoningMsg = (id: string, enc: string): CoreMessage => ({ id, role: "assistant", contentType: "reasoning", text: id, rawResponsesItem: { type: "reasoning", id, encrypted_content: enc, summary: [] } });
const toolCall = (id: string, callId: string, name: string, args: string): CoreMessage => ({ id, role: "assistant", contentType: "tool-call", toolCallId: callId, toolName: name, text: args });
const toolResult = (id: string, callId: string, out: string): CoreMessage => ({ id, role: "tool", contentType: "tool-result", toolCallId: callId, text: out });

function wireItems(core: CoreMessage[]): Item[] {
    return coreToResponses(core) as Item[];
}

test("#564 path 2: compress re-request keeps Responses assistant run ordering valid after summary dedup", async () => {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000, {
        compress: { minCompressRange: 0, minSummaryLength: 0 },
        preserveRecentMessages: 4,
        preserveRecentTokens: 0,
    });
    const projection = responsesToCore(twoTurnBody());
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
        return repairResponsesAssistantOrdering(stripKernelSummaries([...t.messages, ...records] as BiliMessage[], t.state), original);
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
    const out = repairResponsesAssistantOrdering(folded, original);
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
    const out = repairResponsesAssistantOrdering(folded, original);
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
    const out = repairResponsesAssistantOrdering(folded, original);
    assert.equal(out.length, folded.length, "nothing added or dropped when a non-assistant carrier already separates the runs");
    assert.ok(out.map((m) => m.id).includes("acp_summary_b1"), "summary carrier preserved");
    assert.ok(!out.some((m) => (m.text ?? "").includes("compressed")), "no synthetic separator injected");
    assertValidAssistantOrdering(wireItems(out), "carrier");
});
