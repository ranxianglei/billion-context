// #7658 (proposal discussion): egress-on parent × POST /__bili/plugin/fork full
// chain. The #7439 R-B ruling (fork = whole-table copy of the egress flow) is
// implemented in cloneSessionRows → egressPointForkSession, but the host-side
// chain had ZERO tests covering an egress-armed parent: plugin-fork tests never
// arm egress, egress tests never fork. This file pins the current behavior end
// to end (real server, real upstream stub, unified=full + egressPlane on) and
// gates the follow-up wirings:
//   T4 is the red pin — a capped (snapshot-dropped) egress-on parent returns
//   409 SNAPSHOT_UNAVAILABLE even though the op-log holds the full bytes; it
//   flips to 201 when the forkSnapshot egress-on source lands.
//
// Invariants pinned here (from #7439/#7577 rulings):
//   - a fork-to-now child inherits the parent's flow VERBATIM (numbers,
//     retired marks, op order) in the same transaction as the session clone;
//   - a mid-history fork self-heals: the child's first turn diffs its prefix
//     against the copied parent view → one D-run covering the dropped tail,
//     log_seq continues strictly above the parent's high water (never re-
//     issued), and the probe passes without legacy downgrade;
//   - the unified projection of the child is exactly the child's prefix
//     (cloned rows beyond the branch point are retired by the completeLog
//     historian sweep — children have no session_ext, so the sweep always
//     runs for them).

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { setLogCapture } from "../src/logger.ts";
import { forkOrderHashOf } from "../src/agent/fork-adopt.ts";

const MODEL = "claude-test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-7658-fork-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
const SAVED_PLANE = process.env.BILI_ROLLOUT_EGRESS_PLANE;
process.env.NODE_ENV = "test";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";

type Snap = { parentRevision: string; orderHash: string; orderedMessages: Array<{ rawId: string; ref: string | null; identityHash: string }> };

async function harness(logs: string[]) {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    setLogCapture(logs.length === 0 ? (_lvl, m) => logs.push(m) : null);
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 15 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { [MODEL]: { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: false, injectNudge: false, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    return {
        dir,
        store,
        origin: `http://127.0.0.1:${paddr.port}`,
        base: `http://127.0.0.1:${paddr.port}/bili/${upstreamUrl}/v1/chat/completions`,
        close: async (storeToClose: SessionStore) => {
            storeToClose.cancelAll();
            proxy.close();
            proxy.closeIdleConnections?.();
            upstream.close();
            upstream.closeIdleConnections?.();
            await Promise.all([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

const m = (role: "user" | "assistant", i: number) => ({ role, content: `message-${i} ${"x".repeat(32)}-${i}` });
const HISTORY = [m("user", 1), m("assistant", 2), m("user", 3), m("assistant", 4), m("user", 5)];

/** The egress record lands at the debounced SAVE, after the HTTP 200 —
 *  wait for two quiet flushes before asserting on the flow (same settle
 *  discipline as egress-authority-pinned.test.ts). */
async function settle(store: SessionStore, sid: string): Promise<void> {
    const race = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
    assert.equal(await race(store.afterNextFlush(sid), 10_000), true, "first debounced flush landed");
    assert.equal(await race(store.afterNextFlush(sid), 10_000), true, "second flush settled");
}

async function turn(base: string, convId: string, messages: unknown[], ids?: string[]): Promise<void> {
    // Pinned lane (egress authority precondition): every turn re-sends the
    // host-stable msg ids for the whole conversation (body.biliMsgIds — the
    // same channel the real plugin clients use; egress-authority-pinned.test.ts).
    const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": convId },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: false, messages, biliMsgIds: ids ?? messages.map((_, i) => `${convId}-id-${i}`) }),
    });
    assert.equal(res.status, 200, `turn ${convId}: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function snapshot(origin: string, convId: string): Promise<Snap> {
    const res = await fetch(`${origin}/__bili/plugin/snapshot?conversationId=${convId}`);
    assert.equal(res.status, 200, `snapshot ${convId}: ${res.status}`);
    return (await res.json()) as Snap;
}

async function postFork(origin: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${origin}/__bili/plugin/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function seedParent(base: string, convId: string): Promise<void> {
    // Two sequential turns → 5 cells. By the end of turn 1 the plane has armed
    // the session (egressAuthority latched) and the flow holds the bootstrap I
    // rows; turn 2 appends the next I batch.
    await turn(base, convId, HISTORY.slice(0, 3));
    await turn(base, convId, HISTORY.slice(0, 5));
}

test("#7658 T1: fork-to-now — egress-on parent, child flow is the verbatim whole-table copy", async () => {
    const logs: string[] = [];
    const h = await harness(logs);
    try {
        await seedParent(h.base, "p1");
        await settle(h.store, "p1");
        const parent = peekSession("p1");
        assert(parent, "parent session resident");
        assert.equal(parent.metadata.egressAuthority, true, "the plane must be armed (precondition of every assertion below)");
        const ustore = h.store.egressOpLogStore();
        assert(ustore, "unified egress op-log store present");
        const parentView = ustore.egressStateView("p1");
        assert.ok(parentView.length >= 5, `parent flow must hold the seeded cells (got ${parentView.length})`);

        const snap = await snapshot(h.origin, "p1");
        const { status, body } = await postFork(h.origin, {
            protocolVersion: 2, parentConversationId: "p1", childConversationId: "c1", parentRevision: snap.parentRevision,
            branchPoint: { messageCount: snap.orderedMessages.length, orderHash: snap.orderHash }, orderedMessages: snap.orderedMessages, idempotencyKey: "fork:c1",
        });
        assert.equal(status, 201, JSON.stringify(body));
        assert.equal(body.status, "exact");

        // The child flow IS the parent flow, byte for byte (R-B ruling: whole-
        // table copy in the clone transaction — nothing re-issued, nothing
        // re-played).
        assert.deepEqual(ustore.egressStateView("c1"), parentView, "child flow must equal the parent flow verbatim");
        assert.equal(ustore.egressStateMaxSeq("c1"), ustore.egressStateMaxSeq("p1"));
        // #7658 wiring 3: the egress fork point rides its own column — the
        // unified fork_point_seq is NULL for an egress-on parent whose
        // unified leg is frozen (no sessions row before the skeleton fix),
        // so the FLOW watermark the four tables were copied at needs a
        // carrier of its own, next to the lineage pair.
        {
            const { DatabaseSync } = await import("node:sqlite");
            const raw = new DatabaseSync(`${h.dir}/sessions/index.db`, { readOnly: true });
            const childRow = raw.prepare("SELECT parent_session_id, fork_point_seq, fork_egress_watermark FROM sessions WHERE session_id = 'c1'").get() as { parent_session_id: string | null; fork_point_seq: number | null; fork_egress_watermark: number | null };
            raw.close();
            assert.equal(childRow.parent_session_id, "p1", "lineage pair written on the child row");
            assert.equal(childRow.fork_egress_watermark, ustore.egressStateMaxSeq("p1"), "fork_egress_watermark = the FLOW watermark the tables were copied at");
        }

        // The child's unified projection is exactly the branch-point prefix
        // (no tail rows survive: parent egress-on sessions never ingest beyond
        // the arm point, and any cloned stray is retired by the child's
        // completeLog historian sweep).
        const childRows = h.store.unifiedMessageIdRows("c1");
        assert(childRows !== null, "child unified rows readable in full mode");
        assert.equal(childRows.length, snap.orderedMessages.length, `child projection = the ${snap.orderedMessages.length}-cell prefix (got ${childRows.length})`);
    } finally {
        await h.close(h.store);
    }
});

test("#7658 T2: mid-history fork — child's first turn converges one D-run, log_seq never re-issues", async () => {
    const logs: string[] = [];
    const h = await harness(logs);
    try {
        await seedParent(h.base, "p2");
        await settle(h.store, "p2");
        const ustore = h.store.egressOpLogStore();
        assert(ustore, "unified egress op-log store present");
        const parentView = ustore.egressStateView("p2");
        const parentHighWater = Math.max(...parentView.map((r) => r.num));
        // view index 0 is the system row; the 3-cell prefix is indices 1-3
        // (p2-id-0..2), so the dropped tail starts at index 4.
        const tailMsgids = new Set(parentView.slice(4).map((r) => r.msgid));

        const snap = await snapshot(h.origin, "p2");
        assert.equal(snap.orderedMessages.length, 5);
        const prefix = snap.orderedMessages.slice(0, 3);
        const { status, body } = await postFork(h.origin, {
            protocolVersion: 2, parentConversationId: "p2", childConversationId: "c2", parentRevision: snap.parentRevision,
            branchPoint: { messageCount: 3, orderHash: forkOrderHashOf(prefix) }, orderedMessages: prefix, idempotencyKey: "fork:c2",
        });
        assert.equal(status, 201, JSON.stringify(body));
        // #7658 wiring 1: the egressAuthority latch rides the fork
        // whitelist — without it the child re-boots from client bytes on
        // its first turn instead of being served from its own copied flow.
        assert.equal(peekSession("c2")!.metadata.egressAuthority, true, "child inherits the egressAuthority latch");
        // Copied verbatim at fork time — tail included (the drop is the
        // child's first diff, not the copy's).
        assert.deepEqual(ustore.egressStateView("c2"), parentView);

        // Child's first turn: the host keeps the parent's ids for the
        // inherited prefix (that IS what pi does on fork) and mints fresh
        // ids for the new tail.
        const childMsgs = [...HISTORY.slice(0, 3), m("user", 6)];
        const childIds = ["p2-id-0", "p2-id-1", "p2-id-2", "c2-new-0"];
        await turn(h.base, "c2", childMsgs, childIds);

        const childView = ustore.egressStateView("c2");
        const childMsgids = new Set(childView.map((r) => r.msgid));
        for (const t of tailMsgids) assert(!childMsgids.has(t), `dropped parent tail msgid ${t} must not be live in the child`);
        assert.equal(childView.length, 5, "child view = system + 3-cell prefix + 1 new tail cell");
        assert(childMsgids.has("c2-new-0"), "the fresh tail cell rides its host id");
        const nums = childView.map((r) => r.num).sort((a, b) => a - b);
        for (const n of nums.slice(0, 3)) assert(n <= parentHighWater, `prefix numbers are inherited, not re-issued (${n})`);
        const fresh = nums[nums.length - 1]!;
        assert(fresh > parentHighWater, `new tail number ${fresh} continues strictly above the parent high water ${parentHighWater}`);

        // Parent isolation: the child's D-run must not touch the parent flow.
        assert.deepEqual(ustore.egressStateView("p2"), parentView, "parent flow is untouched by the child's turns");

        // Second turn: the probe rides the inherited ids — no legacy
        // downgrade, so the flow ADVANCES with the new cell on a new
        // number (a probe failure would leave the flow exactly as the
        // first turn left it). The egress-lane log lines ride a logger
        // sink outside setLogCapture, so the no-downgrade verdict is
        // asserted on the log itself, not on captured strings.
        await turn(h.base, "c2", [...childMsgs, m("assistant", 7)], [...childIds, "c2-new-1"]);
        const childView2 = ustore.egressStateView("c2");
        const num2 = childView2.find((r) => r.msgid === "c2-new-1")?.num;
        assert.equal(childView2.length, 6, "second turn adds exactly one cell");
        assert.equal(num2, fresh + 1, `the second tail cell takes the next number (${num2} after ${fresh})`);
    } finally {
        await h.close(h.store);
    }
});

test("#7658 T3: cold parent — restart, snapshot via reconstruction, fork still 201", async () => {
    const logs: string[] = [];
    const h = await harness(logs);
    try {
        await seedParent(h.base, "p3");
        await settle(h.store, "p3");
        const parentView = h.store.egressOpLogStore()!.egressStateView("p3");
        h.store.cancelAll();

        // Fresh store on the same dir = cold process.
        const store2 = new SessionStore({ dir: h.dir + "/sessions", enabled: true, debounceMs: 15 });
        _setStoreForTest(store2);
        const snap = await snapshot(h.origin, "p3");
        assert.equal(snap.orderedMessages.length, 5, "cold parent snapshot serves the full 5-cell history (envelope/raw-tail reconstruction)");
        const { status, body } = await postFork(h.origin, {
            protocolVersion: 2, parentConversationId: "p3", childConversationId: "c3", parentRevision: snap.parentRevision,
            branchPoint: { messageCount: 5, orderHash: snap.orderHash }, orderedMessages: snap.orderedMessages, idempotencyKey: "fork:c3",
        });
        assert.equal(status, 201, JSON.stringify(body));
        assert.deepEqual(store2.egressOpLogStore()!.egressStateView("c3"), parentView, "cold fork still copies the flow verbatim");
        store2.cancelAll();
    } finally {
        await h.close(h.store);
    }
});

test("#7658 T4 (RED pin): capped egress-on parent — snapshot dropped → fork 409 today, 201 once the op-log source lands", async () => {
    const logs: string[] = [];
    const h = await harness(logs);
    try {
        await seedParent(h.base, "p4");
        await settle(h.store, "p4");
        assert.equal(peekSession("p4")!.metadata.egressAuthority, true, "armed precondition");
        const ustore = h.store.egressOpLogStore()!;
        assert.ok(ustore.egressStateView("p4").length >= 5, "the op-log holds the full history — the fork should be able to read it");

        // The client snapshotted BEFORE the cap hit — that is the only
        // snapshot it can hold, and it is well-formed.
        const snap = await snapshot(h.origin, "p4");
        assert.equal(snap.orderedMessages.length, 5);

        // Simulate the cap: raw history over BILI_PUBLIC_SNAPSHOT_CAP_BYTES →
        // dropOverCap clears pluginSnapshot and latches publicSnapshotCapped.
        const parent = peekSession("p4")!;
        parent.pluginSnapshot = undefined;
        parent.metadata.publicSnapshotCapped = true;
        await h.store.flushSessionNow(parent);

        const snapAfter = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=p4`);
        const fork = await postFork(h.origin, {
            protocolVersion: 2, parentConversationId: "p4", childConversationId: "c4", parentRevision: snap.parentRevision,
            branchPoint: { messageCount: snap.orderedMessages.length, orderHash: snap.orderHash }, orderedMessages: snap.orderedMessages, idempotencyKey: "fork:c4",
        });
        // TODAY: the fork cannot see the parent's history (unified table frozen
        // at the arm point, in-memory snapshot dropped) → 409.
        // TODO(#7658 wiring 2): flips to 201 when forkSnapshot gains the
        // egress-on source (rebuildCoreFromLog over the parent flow).
        if (process.env.BILI_TEST_EGRESS_FORK_OPLOG_SOURCE === "1") {
            assert.equal(snapAfter.status, 200, `capped egress-on parent snapshot must serve from the op log (got ${snapAfter.status})`);
            assert.equal(fork.status, 201, JSON.stringify(fork.body));
        } else {
            assert.equal(fork.status, 409, `current behavior pin: capped parent 409s (body: ${JSON.stringify(fork.body)})`);
            assert.equal(fork.body.code, "SNAPSHOT_UNAVAILABLE");
        }
    } finally {
        await h.close(h.store);
    }
});
