import { test } from "node:test";
import assert from "node:assert/strict";
import { assignRefs, createCore, createInitialState, defaultConfig, highestUsedIndex, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { gcMessageRefs } from "../src/ref-gc.ts";
import { reapOrphanBlocks } from "../src/orphan-gc.ts";
import { deactivateBlock } from "acp-kernel";

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

const noLog = (_level: string, _msg: string): void => {};

function logs(): { lines: string[]; log: (level: string, msg: string) => void } {
    const lines: string[] = [];
    return { lines, log: (level, msg) => lines.push(`${level} ${msg}`) };
}

function msg(id: string, text = `body of ${id}`): CoreMessage {
    return { id, role: "user", contentType: "text", text };
}

test("prunes dead byRaw/byRef entries and keeps live view ids", () => {
    const session = makeSession();
    const view = [msg("h_a"), msg("h_b"), msg("h_c")];
    session.state.messageRefs.byRaw = { h_a: "m00001", h_b: "m00002", h_dead: "m00003", h_c: "m00004" };
    session.state.messageRefs.byRef = { m00001: "h_a", m00002: "h_b", m00003: "h_dead", m00004: "h_c" };
    const { pruned } = gcMessageRefs(session, view, view, noLog);
    assert.equal(pruned, 1);
    assert.deepEqual(session.state.messageRefs.byRaw, { h_a: "m00001", h_b: "m00002", h_c: "m00004" });
    assert.equal(session.state.messageRefs.byRef["m00003"], undefined);
});

test("keeps tombstones for active-block effectiveMessageIds", () => {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push(msg(`h_msg${i}`, `message ${i} ${"x".repeat(2000)}`));
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00007", summary: "compressed early history that is long enough to pass the min summary length check" }],
        messages: turn.messages,
        state: turn.state,
        config,
    });
    session.state = res.state;
    const block = session.state.blocks[session.state.blocks.length - 1];
    assert.ok(block.active);
    // Client drops the folded range (native compaction / truncation): ids
    // 0..6 are in NEITHER view anymore; they live solely via the block.
    const tail = msgs.slice(7);
    const t2 = core.processTurn({ messages: tail, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    // The kernel keeps only anchor ids in effectiveMessageIds (here msg0/msg1);
    // the rest of the folded range is unreachable except through the summary.
    session.state.messageRefs.byRaw["h_ghost"] = "m00099";
    session.state.messageRefs.byRef["m00099"] = "h_ghost";
    const { pruned } = gcMessageRefs(session, tail, t2.messages, noLog);
    assert.ok(pruned >= 1);
    assert.equal(session.state.messageRefs.byRaw["h_ghost"], undefined);
    for (const id of block.effectiveMessageIds) {
        assert.ok(session.state.messageRefs.byRaw[id], `anchor id ${id} must keep its tombstone`);
    }
    for (const m of tail) {
        assert.ok(session.state.messageRefs.byRaw[m.id], `live id ${m.id} must keep its mapping`);
    }
    const { byRaw, byRef } = session.state.messageRefs;
    for (const [rawId, ref] of Object.entries(byRaw)) {
        assert.equal(byRef[ref], rawId, `byRaw/byRef must stay consistent for ${rawId}`);
    }
});

test("keeps mappings for refs cited in outgoing summary text", () => {
    const session = makeSession();
    // h_cited left BOTH views (folded long ago); its only remaining surface is
    // the outgoing summary text citing m00007 (kept via the cited-ref scan).
    const incoming = [msg("h_a"), msg("h_b")];
    session.state.messageRefs.byRaw = { h_a: "m00001", h_b: "m00002", h_cited: "m00007" };
    session.state.messageRefs.byRef = { m00001: "h_a", m00002: "h_b", m00007: "h_cited" };
    const outgoing = [msg("h_a"), msg("h_b", "summary: the folded section m00007 covers the auth refactor")];
    const { pruned } = gcMessageRefs(session, incoming, outgoing, noLog);
    assert.equal(pruned, 0);
    assert.equal(session.state.messageRefs.byRaw["h_cited"], "m00007");
});

test("prunes tokenSnapshot entries of dead refs", () => {
    const session = makeSession();
    const view = [msg("h_live")];
    session.state.messageRefs.byRaw = { h_live: "m00001", h_dead: "m00002" };
    session.state.messageRefs.byRef = { m00001: "h_live", m00002: "h_dead" };
    session.state.tokenSnapshot = { m00001: 10, m00002: 20 };
    gcMessageRefs(session, view, view, noLog);
    assert.deepEqual(session.state.tokenSnapshot, { m00001: 10 });
});

test("kernel reuses freed slots after gc (highestUsedIndex+1 cursor)", () => {
    const session = makeSession();
    const view = [msg("h_live")];
    session.state.messageRefs.byRaw = { h_live: "m00001", h_dead: "m00002", h_dead2: "m00003" };
    session.state.messageRefs.byRef = { m00001: "h_live", m00002: "h_dead", m00003: "h_dead2" };
    gcMessageRefs(session, view, view, noLog);
    // Exactly what assignRefsNode does each turn.
    const refResult = assignRefs([msg("h_new")], {
        existing: session.state.messageRefs,
        nextIndex: highestUsedIndex(session.state.messageRefs) + 1,
    });
    assert.equal(refResult.map.byRaw["h_new"], "m00002");
});

test("issue repro: 40 refs for 37 messages with 3 ghosts gets exactly the ghosts pruned", () => {
    const session = makeSession();
    const view: CoreMessage[] = [];
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    for (let i = 1; i <= 37; i++) {
        const id = `h_real${i}`;
        const ref = `m${String(i).padStart(5, "0")}`;
        view.push(msg(id));
        byRaw[id] = ref;
        byRef[ref] = id;
    }
    for (const [id, ref] of [["h_ghost14", "m00038"], ["h_ghost35", "m00039"], ["h_ghost36", "m00040"]] as const) {
        byRaw[id] = ref;
        byRef[ref] = id;
    }
    session.state.messageRefs.byRaw = byRaw;
    session.state.messageRefs.byRef = byRef;
    const { pruned } = gcMessageRefs(session, view, view, noLog);
    assert.equal(pruned, 3);
    assert.equal(Object.keys(session.state.messageRefs.byRaw).length, 37);
});

test("orphan-gc then ref-gc: reaped block ids are collected the same turn", () => {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push(msg(`h_msg${i}`, `message ${i} ${"x".repeat(2000)}`));
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00007", summary: "compressed early history that is long enough to pass the min summary length check" }],
        messages: turn.messages,
        state: turn.state,
        config,
    });
    session.state = res.state;
    // Client drops the whole folded range AND the tail: block orphans after
    // ORPHAN_THRESHOLD turns, then ref-gc must drop its tombstones too.
    const replacement = [msg("h_fresh", "client-native-compact replacement summary")];
    for (let i = 0; i < 4; i++) {
        const t = core.processTurn({ messages: replacement, state: session.state, config, tokenCount: 10, renderTags: "text-only" });
        session.state = t.state;
        reapOrphanBlocks(session, replacement, deactivateBlock);
        gcMessageRefs(session, replacement, t.messages, noLog);
    }
    assert.equal(session.state.blocks.filter((b) => b.active).length, 0);
    for (const b of session.state.blocks) {
        for (const id of b.effectiveMessageIds) {
            assert.equal(session.state.messageRefs.byRaw[id], undefined, `reaped block id ${id} must be collected`);
        }
    }
    assert.ok(session.state.messageRefs.byRaw["h_fresh"]);
});

test("warns once-ish when approaching capacity", () => {
    const session = makeSession();
    const view = [msg("h_high")];
    session.state.messageRefs.byRaw = { h_high: "m90100", h_dead: "m00002" };
    session.state.messageRefs.byRef = { m90100: "h_high", m00002: "h_dead" };
    const { lines, log } = logs();
    gcMessageRefs(session, view, view, log);
    assert.equal(session.state.messageRefs.byRaw["h_high"], "m90100");
    assert.ok(lines.some((l) => l.includes("approaching capacity")));
});

test("long-run stress: edits + truncation keep byRef same order as the live view", () => {
    const session = makeSession();
    const core = createCore();
    const config = defaultConfig(200000);
    let history: CoreMessage[] = [];
    let counter = 0;
    const hash = (n: number, gen: number) => `h_${n}_${gen}`;
    // 1000 client turns: ~5% of old messages get edited (content fingerprint
    // changes => old id dies), oldest 10 dropped every 50 turns (truncation).
    for (let turn = 0; turn < 1000; turn++) {
        counter += 1;
        history.push(msg(hash(counter, 0), `turn ${turn} fresh message ${"y".repeat(500)}`));
        if (turn % 20 === 0 && history.length > 4) {
            const victim = history[Math.floor(history.length / 2)];
            const n = Number(victim.id.split("_")[1]);
            history = history.map((m) => (m.id === victim.id ? msg(hash(n, 1), `EDITED turn ${turn} ${"y".repeat(500)}`) : m));
        }
        if (turn % 50 === 0 && history.length > 10) history = history.slice(10);
        const t = core.processTurn({ messages: history, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
        session.state = t.state;
        gcMessageRefs(session, history, t.messages, noLog);
    }
    const liveIds = new Set(history.map((m) => m.id));
    const { byRaw, byRef } = session.state.messageRefs;
    // Same order as the live view: every mapping resolves to a message the
    // client still sends (no ghosts), and nothing leaked unboundedly.
    for (const rawId of Object.keys(byRaw)) {
        assert.ok(liveIds.has(rawId), `ghost id ${rawId} survived gc`);
    }
    assert.ok(Object.keys(byRef).length <= history.length, `byRef (${Object.keys(byRef).length}) must not exceed the view (${history.length})`);
});
