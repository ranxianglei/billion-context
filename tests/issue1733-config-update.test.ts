// #1733: history compression makes mid-history configuration_update items
// adjacent → upstream 400 unsupported_value "Consecutive 'configuration_update'
// items are not allowed". The rebuild layer must fold adjacent runs into one
// last-wins deep-merged item at every Responses forward boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap, prune, isRenderedSummaryMessage } from "acp-kernel";
import type { ResponseInputItem } from "acp-kernel/wire";
import { responsesToCoreWithToolImages, patchResponsesInputWithToolImages, mergeAdjacentConfigurationUpdates } from "../src/responses-tool-output.ts";
import { hoistTrappedToolItems } from "../src/tool-pair-order.js";
import { validateResponsesBody } from "./wire-contract-fakes.ts";

const cfg = (effort: string): ResponseInputItem => ({ type: "configuration_update", reasoning: { effort } });
const userMsg = (id: string, text: string): ResponseInputItem => ({ type: "message", id, role: "user", content: [{ type: "input_text", text }] });
const assistantMsg = (id: string, text: string): ResponseInputItem => ({ type: "message", id, role: "assistant", content: [{ type: "output_text", text }] });

function adjacentConfigUpdateIndices(items: readonly ResponseInputItem[]): number[] {
    const idx: number[] = [];
    for (let i = 1; i < items.length; i++) {
        if (items[i].type === "configuration_update" && items[i - 1].type === "configuration_update") idx.push(i);
    }
    return idx;
}

function firstText(item: ResponseInputItem): string | undefined {
    const raw = item as { content?: unknown };
    if (!Array.isArray(raw.content)) return undefined;
    const head = raw.content[0];
    if (typeof head !== "object" || head === null) return undefined;
    const text = (head as { text?: unknown }).text;
    return typeof text === "string" ? text : undefined;
}

test("#1733 merge: adjacent run folds with last-wins deep-merge semantics", () => {
    // issue case: [medium, high] → high
    const r1 = mergeAdjacentConfigurationUpdates([cfg("medium"), cfg("high")]);
    assert.equal(r1.length, 1);
    assert.deepEqual(r1[0], { type: "configuration_update", reasoning: { effort: "high" } });
    // distinct fields from both updates survive
    const r2 = mergeAdjacentConfigurationUpdates([
        { type: "configuration_update", reasoning: { effort: "medium" } },
        { type: "configuration_update", temperature: 0.5 },
    ]);
    assert.equal(r2.length, 1);
    assert.deepEqual(r2[0], { type: "configuration_update", reasoning: { effort: "medium" }, temperature: 0.5 });
    // nested merge keeps sibling keys of the earlier update
    const r3 = mergeAdjacentConfigurationUpdates([
        { type: "configuration_update", reasoning: { effort: "medium", summary: "auto" } },
        { type: "configuration_update", reasoning: { effort: "high" } },
    ]);
    assert.equal(r3.length, 1);
    assert.deepEqual(r3[0], { type: "configuration_update", reasoning: { effort: "high", summary: "auto" } });
    // three-run collapses to one item, last wins
    const r4 = mergeAdjacentConfigurationUpdates([cfg("low"), cfg("medium"), cfg("high")]);
    assert.equal(r4.length, 1);
    assert.deepEqual(r4[0], { type: "configuration_update", reasoning: { effort: "high" } });
});

test("#1733 merge: no adjacent pair → byte-stable (same item references)", () => {
    const a = cfg("medium");
    const b = userMsg("m1", "x");
    const c = cfg("high");
    const out = mergeAdjacentConfigurationUpdates([a, b, c]);
    assert.equal(out.length, 3);
    assert.equal(out[0], a);
    assert.equal(out[1], b);
    assert.equal(out[2], c);
    const once = mergeAdjacentConfigurationUpdates([cfg("medium"), cfg("high")]);
    assert.deepEqual(mergeAdjacentConfigurationUpdates(once), once);
});

// The issue's offline replay: drop exactly the messages a compression block
// covers and rebuild. Pre-fix this emitted two adjacent configuration_updates.
test("#1733 repro: pruning messages between two configuration_updates yields one merged item", () => {
    const input: ResponseInputItem[] = [
        userMsg("m1", "q1"), assistantMsg("a1", "r1"),
        userMsg("m2", "q2"), assistantMsg("a2", "r2"),
        cfg("medium"),
        userMsg("m3", "q3"), assistantMsg("a3", "r3"),
        userMsg("m4", "q4"), assistantMsg("a4", "r4"),
        cfg("high"),
        userMsg("m5", "q5"), assistantMsg("a5", "r5"),
    ];
    const projection = responsesToCoreWithToolImages({ model: "gpt-x", input });
    const dropTexts = new Set(["q3", "r3", "q4", "r4"]);
    const dropCoreIds = new Set<string>();
    for (const slot of projection.layout) {
        const text = firstText(slot.original);
        if (text !== undefined && dropTexts.has(text) && slot.coreId) dropCoreIds.add(slot.coreId);
    }
    assert.equal(dropCoreIds.size, 4, "all four middle messages are tracked");
    const pruned = projection.msgs.filter((m) => !dropCoreIds.has(m.id));
    const rebuilt = patchResponsesInputWithToolImages(projection, pruned);
    assert.notEqual(typeof rebuilt, "string");
    assert.deepEqual(adjacentConfigUpdateIndices(rebuilt), []);
    const updates = rebuilt.filter((it) => it.type === "configuration_update");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], { type: "configuration_update", reasoning: { effort: "high" } });
    assert.deepEqual(validateResponsesBody({ input: rebuilt }), []);
});

// Faithful pipeline: real kernel applyCompression + prune, then the proxy's
// rebuild — the exact sequence server.ts runs after a compress turn.
test("#1733 end-to-end: kernel applyCompression + prune + patch yields protocol-clean input", () => {
    // tail after the second update mirrors a live session where the
    // conversation continues past the covered range
    const input: ResponseInputItem[] = [
        userMsg("m1", "q1"), assistantMsg("a1", "r1"),
        userMsg("m2", "q2"), assistantMsg("a2", "r2"),
        cfg("medium"),
        userMsg("m3", "q3"), assistantMsg("a3", "r3"),
        userMsg("m4", "q4"), assistantMsg("a4", "r4"),
        cfg("high"),
        userMsg("m5", "q5"), assistantMsg("a5", "r5"),
        userMsg("m6", "q6"), assistantMsg("a6", "r6"),
        userMsg("m7", "q7"), assistantMsg("a7", "r7"),
        userMsg("m8", "q8"), assistantMsg("a8", "r8"),
    ];
    const projection = responsesToCoreWithToolImages({ model: "gpt-x", input });
    const core = createCore();
    const config = defaultConfig(200000);
    config.compress.minCompressRange = 1;
    config.compress.minSummaryLength = 1;
    const state = createInitialState();
    state.messageRefs = assignRefs(projection.msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    const coveredCoreIds: string[] = [];
    for (const slot of projection.layout) {
        const text = firstText(slot.original);
        if ((text === "q3" || text === "r3" || text === "q4" || text === "r4") && slot.coreId) coveredCoreIds.push(slot.coreId);
    }
    assert.equal(coveredCoreIds.length, 4);
    const startRef = state.messageRefs.byRaw[coveredCoreIds[0]];
    const endRef = state.messageRefs.byRaw[coveredCoreIds[coveredCoreIds.length - 1]];
    // explicit empty protected set isolates rebuild fidelity from the
    // protection policy (default preserveRecentTokens=5000 would protect
    // this entire small fixture)
    const fold = core.applyCompression({ ranges: [{ startRef, endRef, summary: "middle history summarized" }], messages: projection.msgs, state, config, protectedMessageIds: new Set() });
    assert.equal(fold.result.blocksCreated, 1, fold.result.errors.join("; "));
    const visible = prune(projection.msgs, fold.state).filter((m) => !isRenderedSummaryMessage(m));
    const rebuilt = patchResponsesInputWithToolImages(projection, visible);
    assert.notEqual(typeof rebuilt, "string");
    assert.deepEqual(adjacentConfigUpdateIndices(rebuilt), []);
    const updates = rebuilt.filter((it) => it.type === "configuration_update");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], { type: "configuration_update", reasoning: { effort: "high" } });
});

// Second adjacency producer: hoistTrappedToolItems (#766) batches two trapped
// updates together even without any compression. The call-site composition
// (merge after hoist) must close it.
test("#1733 hoist path: two updates trapped by one call are folded after hoist", () => {
    const items: ResponseInputItem[] = [
        { type: "function_call", call_id: "cA", name: "bash", arguments: "{}" },
        cfg("medium"),
        { type: "function_call", call_id: "cB", name: "ls", arguments: "{}" },
        { type: "function_call_output", call_id: "cB", output: "files" },
        cfg("high"),
        { type: "function_call_output", call_id: "cA", output: "ok" },
    ];
    const hoisted = hoistTrappedToolItems(items);
    assert.ok(adjacentConfigUpdateIndices(hoisted).length > 0, "precondition: hoist creates the adjacency");
    const merged = mergeAdjacentConfigurationUpdates(hoisted);
    assert.deepEqual(adjacentConfigUpdateIndices(merged), []);
    assert.deepEqual(merged.filter((it) => it.type === "configuration_update"), [{ type: "configuration_update", reasoning: { effort: "high" } }]);
});

test("#1733 validator: fake upstream rejects adjacent configuration_updates (WC-011)", () => {
    const violations = validateResponsesBody({ input: [cfg("medium"), cfg("high")] });
    assert.ok(violations.some((v) => v.startsWith("WC-011")), violations.join("; "));
    assert.deepEqual(validateResponsesBody({ input: [cfg("medium"), userMsg("m1", "x"), cfg("high")] }), []);
});
