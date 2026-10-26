// #2042 regression: stripKernelSummaries used to rescan the full post-kernel
// history once PER active block (O(B×N)) while looking up each block's carrier
// evidence. The fix indexes the evidence in a single pass. These tests pin the
// OLD semantics byte-for-byte (carrier hit/miss per branch, fail-safe
// directions, preflight/inactive handling, order preservation) plus two
// deterministic complexity probes: no per-block full scan, and each
// compress call's args parsed at most once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, type CompressionBlock, type CompressionState } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { stripKernelSummaries } from "../src/server.ts";

function msg(partial: Partial<BiliMessage> & { id: string }): BiliMessage {
    return { role: "user", contentType: "text", text: "x", ...partial } as BiliMessage;
}
const summary = (blockId: string): BiliMessage => msg({ id: `acp_summary_${blockId}`, role: "system", text: "summary" });
const tail = (n: string | number): BiliMessage => msg({ id: `u${n}`, text: "tail" });
const toolCall = (toolCallId: string, toolName: string, args?: string): BiliMessage =>
    msg({ id: `tc_${toolCallId}`, role: "assistant", contentType: "tool-call", toolCallId, toolName, ...(args !== undefined ? { text: args } : {}) });

function stateWith(blocks: Array<Partial<CompressionBlock>>): CompressionState {
    const s = createInitialState();
    s.blocks = blocks.map((b, i) => ({ blockId: `b${i}`, ...b }) as CompressionBlock);
    return s;
}
const ids = (msgs: BiliMessage[]): string[] => msgs.map((m) => m.id);

test("plain block: carrier tool call present -> summary stripped", () => {
    const messages = [summary("b0"), toolCall("proxy_call_b0", "bash"), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "b0", active: true, compressCallId: "proxy_call_b0" }]));
    assert.deepEqual(ids(out), ["tc_proxy_call_b0", "u0"]);
});

test("plain block: no carrier -> fallback summary kept", () => {
    const messages = [summary("b0"), toolCall("other_call", "bash"), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "b0", active: true, compressCallId: "proxy_call_b0" }]));
    assert.deepEqual(ids(out), ids(messages));
});

test("plain block match ignores tool name (old semantics: any tool-call id)", () => {
    const messages = [summary("b0"), toolCall("proxy_call_b0", "compress", '{"content":[]}'), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "b0", active: true, compressCallId: "proxy_call_b0" }]));
    assert.deepEqual(ids(out), ["tc_proxy_call_b0", "u0"]);
});

test("non-tool-call message carrying the same toolCallId does not count", () => {
    const messages = [summary("b0"), msg({ id: "x1", role: "user", contentType: "text", toolCallId: "proxy_call_b0" }), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "b0", active: true, compressCallId: "proxy_call_b0" }]));
    assert.deepEqual(ids(out), ids(messages));
});

test("plugin block: exact range match via flat args -> stripped", () => {
    const messages = [summary("pb0"), toolCall("c1", "compress", '{"startId":"m1","endId":"m9"}'), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pb0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m9" }]));
    assert.deepEqual(ids(out), ["tc_c1", "u0"]);
});

test("plugin block: exact range match via content array -> stripped", () => {
    const messages = [summary("pb0"), toolCall("c1", "compress", '{"content":[{"startId":"m1","endId":"m9"}]}'), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pb0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m9" }]));
    assert.deepEqual(ids(out), ["tc_c1", "u0"]);
});

test("plugin block: range mismatch -> anchor kept", () => {
    const messages = [summary("pb0"), toolCall("c1", "compress", '{"startId":"m1","endId":"m8"}'), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pb0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m9" }]));
    assert.deepEqual(ids(out), ids(messages));
});

test("plugin block: bad JSON args -> fail-safe keeps anchor", () => {
    const messages = [summary("pb0"), toolCall("c1", "compress", "{not json"), toolCall("c2", "compress", "null"), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pb0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m9" }]));
    assert.deepEqual(ids(out), ids(messages));
});

test("plugin block: no compress call at all -> anchor kept", () => {
    const messages = [summary("pb0"), toolCall("c1", "bash"), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pb0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m9" }]));
    assert.deepEqual(ids(out), ids(messages));
});

test("legacy plugin block without refs: any compress call present -> stripped (even unparseable)", () => {
    const withCall = [summary("lb0"), toolCall("c1", "compress", "{bad"), tail(0)];
    assert.deepEqual(
        ids(stripKernelSummaries(withCall, stateWith([{ blockId: "lb0", active: true, compressCallId: "plugin_1" }])),
    ), ["tc_c1", "u0"]);
    const withoutCall = [summary("lb0"), toolCall("c1", "bash"), tail(0)];
    assert.deepEqual(
        ids(stripKernelSummaries(withoutCall, stateWith([{ blockId: "lb0", active: true, compressCallId: "plugin_1" }])),
    ), ids(withoutCall));
});

test("preflight block (no compressCallId) always keeps its anchor", () => {
    const messages = [summary("pf0"), toolCall("proxy_call_pf0", "bash"), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "pf0", active: true }]));
    assert.deepEqual(ids(out), ids(messages));
});

test("inactive block keeps its anchor even when its carrier rides along", () => {
    const messages = [summary("in0"), toolCall("proxy_call_in0", "bash"), tail(0)];
    const out = stripKernelSummaries(messages, stateWith([{ blockId: "in0", active: false, compressCallId: "proxy_call_in0" }]));
    assert.deepEqual(ids(out), ids(messages));
});

test("mixed branches: only blocks with carriers are stripped, order preserved", () => {
    const messages = [
        summary("p_hit"), summary("p_miss"), summary("pl_hit"), summary("pl_bad"),
        toolCall("proxy_call_p_hit", "bash"),
        toolCall("c1", "compress", '{"content":[{"startId":"m1","endId":"m2"},{"startId":"m3","endId":"m4"}]}'),
        toolCall("c2", "compress", "{bad json"),
        tail(0),
    ];
    const state = stateWith([
        { blockId: "p_hit", active: true, compressCallId: "proxy_call_p_hit" },
        { blockId: "p_miss", active: true, compressCallId: "proxy_call_gone" },
        { blockId: "pl_hit", active: true, compressCallId: "plugin_1", startRef: "m3", endRef: "m4" },
        { blockId: "pl_bad", active: true, compressCallId: "plugin_2", startRef: "m5", endRef: "m6" },
    ]);
    const out = stripKernelSummaries(messages, state);
    assert.deepEqual(ids(out), ["acp_summary_p_miss", "acp_summary_pl_bad", "tc_proxy_call_p_hit", "tc_c1", "tc_c2", "u0"]);
});

test("one content array serving two plugin blocks parses the args exactly once", () => {
    const messages = [
        summary("a0"), summary("a1"),
        toolCall("c1", "compress", '{"content":[{"startId":"m1","endId":"m2"},{"startId":"m3","endId":"m4"}]}'),
        tail(0),
    ];
    const state = stateWith([
        { blockId: "a0", active: true, compressCallId: "plugin_1", startRef: "m1", endRef: "m2" },
        { blockId: "a1", active: true, compressCallId: "plugin_2", startRef: "m3", endRef: "m4" },
    ]);
    let parses = 0;
    const origParse = JSON.parse.bind(JSON);
    JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) => { parses++; return origParse(text, reviver); }) as typeof JSON.parse;
    try {
        assert.deepEqual(ids(stripKernelSummaries(messages, state)), ["tc_c1", "u0"]);
    } finally {
        JSON.parse = origParse as typeof JSON.parse;
    }
    assert.equal(parses, 1);
});

// Deterministic complexity probes (no timing thresholds): instrument element
// accesses through a Proxy and prove the scan cost is O(N+B), not O(B×N).
function instrument(messages: BiliMessage[]) {
    const stats = { visits: 0, someCalls: 0 };
    const view: BiliMessage[] = new Proxy(messages, {
        get(target, prop, receiver) {
            if (prop === Symbol.iterator) {
                return () => {
                    const it = (target as Iterable<BiliMessage>)[Symbol.iterator]();
                    return { next: () => { stats.visits++; return it.next(); } };
                };
            }
            if (prop === "some") {
                return (cb: (m: BiliMessage) => boolean) => { stats.someCalls++; return messages.some(cb); };
            }
            const v = Reflect.get(target, prop, receiver);
            return typeof v === "function" ? v.bind(target) : v;
        },
    });
    return { view, stats };
}

for (const B of [250, 500]) {
    test(`no-carrier fixture: ${B} blocks x ${4 * B} messages stay linear (both branches)`, () => {
        for (const mode of ["plain", "plugin"] as const) {
            const state = createInitialState();
            const messages: BiliMessage[] = [];
            for (let i = 0; i < B; i++) {
                const callId = mode === "plain" ? `proxy_call_${i}` : `plugin_${i}`;
                state.blocks.push(mode === "plain"
                    ? { blockId: `b${i}`, active: true, compressCallId: callId } as CompressionBlock
                    : { blockId: `b${i}`, active: true, compressCallId: callId, startRef: `m${i}a`, endRef: `m${i}b` } as CompressionBlock);
                messages.push(summary(`b${i}`));
                for (let j = 0; j < 3; j++) messages.push(tail(`${i}_${j}`));
            }
            const { view, stats } = instrument(messages);
            const out = stripKernelSummaries(view, state);
            assert.deepEqual(out, messages.slice());
            assert.equal(stats.someCalls, 0);
            // old code: B*N + N element touches (>= 251,000 at B=250).
            // one index pass is N+1 (terminal next counted); allow generous slack.
            assert.ok(stats.visits <= 2 * messages.length + 4 * B, `visits=${stats.visits} exceeds O(N+B) bound`);
        }
    });
}
