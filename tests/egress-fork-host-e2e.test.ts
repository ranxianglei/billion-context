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
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { setLogCapture } from "../src/logger.ts";
import { forkOrderHashOf, tryForkAdoption } from "../src/agent/fork-adopt.ts";

const MODEL = "claude-test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-7658-fork-"));
// Windows runner: a still-released-by-Defender/GC SQLite handle on this tree
// makes a plain rmSync throw EPERM (observed CI flake, hookFailed). Bounded
// retries, swallowed on persistent refusal — same pattern as issue3397.
function rmBestEffort(p: string): void {
    try {
        rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}
test.after(() => rmBestEffort(testRoot));
const SAVED_PLANE = process.env.BILI_ROLLOUT_EGRESS_PLANE;
process.env.NODE_ENV = "test";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
// KDD #25: the fork flows read the legacy view getters (viewFor) — these
// suites simulate a pre-gate DB (full table set) while egressPlane=1;
// the 7-table invariant lives in tests/eg-sweep-egress-identity.test.ts.
process.env.BILI_TEST_FORCE_FULL_DDL = "1";

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

type FullSnap = Snap & { messages: Array<{ rawId: string; ref: string | null; role: string; text: string | null; toolName: string | null; toolCallId: string | null; contentType: string | null }> };

/** Snapshot with the per-message rows — the CANONICAL bytes a pinned host
 *  actually holds (that is what its next request re-sends). */
async function snapshotFull(origin: string, convId: string): Promise<FullSnap> {
    const res = await fetch(`${origin}/__bili/plugin/snapshot?conversationId=${convId}`);
    assert.equal(res.status, 200, `snapshot ${convId}: ${res.status}`);
    const snap = (await res.json()) as FullSnap;
    assert(Array.isArray(snap.messages) && snap.messages.length === snap.orderedMessages.length, "per-message rows present");
    return snap;
}

/** Read the raw egress tables straight off the index (same seam as T1). */
async function rawBlockRows(dir: string, convId: string, table: "egress_block_state" | "egress_block_flow"): Promise<unknown[]> {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(`${dir}/sessions/index.db`, { readOnly: true });
    const rows = db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${table === "egress_block_state" ? "op_seq" : "op_seq"}`).all(convId);
    db.close();
    return rows as unknown[];
}

/** Real client tool channel (POST /__bili/plugin/tool — what pi/ekko do):
 *  fold the parent's own cells. Returns the server receipt (the exact text
 *  the client later re-sends as the tool result). */
async function compressTool(origin: string, convId: string, startRef: string, endRef: string, summary: string, callId?: string): Promise<string> {
    const res = await fetch(`${origin}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: convId, tool: "compress", args: { content: [{ startId: startRef, endId: endRef, summary }] }, ...(callId !== undefined ? { toolCallId: callId } : {}) }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, `compress ${convId}: ${res.status} ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { result?: string; code?: string };
    assert(typeof body.result === "string" && body.result.startsWith("[Compressed "), `compress receipt shape (${JSON.stringify(body).slice(0, 200)})`);
    return body.result;
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

test("#7658 T4: capped egress-on parent — snapshot and fork serve from the op log", async () => {
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
        // #7658 wiring 2: the raw snapshot is gone, but the egress op log
        // still holds the full canonical history — the snapshot route falls
        // back to it (forkSnapshot's egressOpLogSource) instead of 409ing.
        assert.equal(snapAfter.status, 200, `capped egress-on parent snapshot must serve from the op log (got ${snapAfter.status})`);
        const snapAfterBody = (await snapAfter.json()) as { ok?: boolean; parentRevision?: string; orderHash?: string; orderedMessages?: { rawId: string; ref: number | null; identityHash: string }[] };
        assert.equal(snapAfterBody.orderedMessages?.length, 5);

        // A client still holding the PRE-cap snapshot conflicts: the
        // op-log cells carry the canonical (stamped) bytes, so the
        // pre-cap identity hashes drift on the stamped cells. That is
        // identity-stable byte drift — the #6262 track — and the strict
        // byte check refuses it (drift-track extension: follow-up).
        const staleFork = await postFork(h.origin, {
            protocolVersion: 2, parentConversationId: "p4", childConversationId: "c4", parentRevision: snap.parentRevision,
            branchPoint: { messageCount: snap.orderedMessages.length, orderHash: snap.orderHash }, orderedMessages: snap.orderedMessages, idempotencyKey: "fork:c4-stale",
        });
        assert.equal(staleFork.status, 409, JSON.stringify(staleFork.body));
        assert.equal(staleFork.body.code, "BRANCH_POINT_CONFLICT", "stale pre-cap snapshot → identity drift → conflict (documented boundary)");

        // The real host flow: re-snapshot, then fork with the fresh cells.
        const fork = await postFork(h.origin, {
            protocolVersion: 2, parentConversationId: "p4", childConversationId: "c4", parentRevision: snapAfterBody.parentRevision!,
            branchPoint: { messageCount: snapAfterBody.orderedMessages!.length, orderHash: snapAfterBody.orderHash! }, orderedMessages: snapAfterBody.orderedMessages!, idempotencyKey: "fork:c4",
        });
        assert.equal(fork.status, 201, JSON.stringify(fork.body));
        // The child got the verbatim whole-table copy — number space intact.
        assert.deepEqual(h.store.egressOpLogStore()!.egressStateView("c4"), h.store.egressOpLogStore()!.egressStateView("p4"));
    } finally {
        await h.close(h.store);
    }
});

test("#7658 T5: fork-then-compress — the child's client-side fold books correctly in its own flow", async () => {
    // On the plugin lane the fold executes HOST-side (pi folds its own state
    // and re-sends the folded history on the next turn; the proxy only
    // salvages/forwards the tool call — src/plugin.ts:3714). The egress side
    // of "fork 后能压缩吗" is therefore: the child's first turn AFTER the
    // client-side fold must book a D-run over the covered cells plus a fresh
    // summary I row numbered above the parent high water, compact, keep the
    // parent isolated, and keep serving from its own flow.
    const logs: string[] = [];
    const T5_SUMMARY = "T5 folded summary: the child compressed its inherited prefix. " + "y".repeat(64);
    const h = await harness(logs);
    try {
        await seedParent(h.base, "p5");
        await settle(h.store, "p5");
        const ustore = h.store.egressOpLogStore()!;
        const parentView = ustore.egressStateView("p5");
        const parentHighWater = Math.max(...parentView.map((r) => r.num));

        const snap = await snapshot(h.origin, "p5");
        const { status, body } = await postFork(h.origin, {
            protocolVersion: 2, parentConversationId: "p5", childConversationId: "c5", parentRevision: snap.parentRevision,
            branchPoint: { messageCount: snap.orderedMessages.length, orderHash: snap.orderHash }, orderedMessages: snap.orderedMessages, idempotencyKey: "fork:c5",
        });
        assert.equal(status, 201, JSON.stringify(body));

        // The child's first turn is ALREADY folded: the host kept the head
        // cell and the fresh tail, and replaced the middle with the summary
        // carrier (what pi does after a local compress).
        const childMsgs = [HISTORY[0]!, { role: "assistant" as const, content: T5_SUMMARY }, HISTORY[4]!, m("user", 6)];
        const childIds = ["p5-id-0", "c5-fold-0", "p5-id-4", "c5-new-0"];
        await turn(h.base, "c5", childMsgs, childIds);
        await settle(h.store, "c5");

        const childView = ustore.egressStateView("c5");
        const liveIds = new Set(childView.map((r) => r.msgid));
        assert.ok(liveIds.has("c5-new-0"), "the fresh cell is live");
        assert.ok(liveIds.has("p5-id-0") && liveIds.has("p5-id-4"), "the uncovered head/tail cells survive the fold");
        const summaryRow = childView.find((r) => r.bytes.includes(T5_SUMMARY));
        assert(summaryRow, "the fold summary rides its own flow row");
        assert(summaryRow!.num > parentHighWater, `summary number ${summaryRow!.num} continues above the parent high water ${parentHighWater}`);
        for (const id of ["p5-id-1", "p5-id-2", "p5-id-3"]) assert(!liveIds.has(id), `covered cell ${id} must be retired from the child flow`);

        // Compaction: a D-bearing batch wrote the B base row and physically
        // pruned the log before it — the flow is not a raw append-only dump.
        const { DatabaseSync } = await import("node:sqlite");
        const raw = new DatabaseSync(`${h.dir}/sessions/index.db`, { readOnly: true });
        const bCount = (raw.prepare("SELECT COUNT(*) AS n FROM egress_state WHERE session_id = 'c5' AND row_type = 'B'").get() as { n: number }).n;
        assert.ok(bCount >= 1, `the D-run triggered compaction (B rows: ${bCount})`);
        raw.close();

        // The next turn still serves from the child's own flow (no legacy
        // downgrade): it advances by exactly one numbered cell.
        await turn(h.base, "c5", [...childMsgs, m("assistant", 7)], [...childIds, "c5-new-1"]);
        await settle(h.store, "c5");
        const childView2 = ustore.egressStateView("c5");
        const row2 = childView2.find((r) => r.msgid === "c5-new-1");
        assert(row2, "the second turn cell landed");
        const preTurn2Max = Math.max(...childView.map((r) => r.num));
        assert.equal(row2!.num, preTurn2Max + 1, `the second cell takes the next flow number (${row2!.num} after ${preTurn2Max})`);

        // Parent isolation holds through the fold too.
        assert.deepEqual(ustore.egressStateView("p5"), parentView, "parent flow untouched by the child fold");
    } finally {
        await h.close(h.store);
    }
});

test("#7658 T6: real client adoption — tryForkAdoption (the #2399 client half) end to end", async () => {
    // T1-T5 drove the fork endpoint with hand-built receipts; a real host
    // (pi /fork → dsh resume-replay) never does — it runs tryForkAdoption:
    // snapshot → longest (role,text) prefix against the rows it holds →
    // msgid id-track → fork POST. This drives THAT code path against an
    // egress-on parent, then proves the child's first model call serves from
    // its own copied flow.
    const logs: string[] = [];
    const h = await harness(logs);
    try {
        await seedParent(h.base, "p6");
        await settle(h.store, "p6");
        const ustore = h.store.egressOpLogStore()!;
        const parentView = ustore.egressStateView("p6");

        const snap = await snapshotFull(h.origin, "p6");
        // The host's outgoing body, rebuilt from the canonical cells it holds.
        const hostBody = { model: MODEL, messages: snap.messages.map((row) => ({ role: row.role, content: row.text ?? "" })) };
        const result = await tryForkAdoption({
            base: h.origin,
            parentConversationId: "p6",
            childConversationId: "c6",
            body: hostBody,
            msgIds: snap.orderedMessages.map((o) => o.rawId),
        });
        assert.equal(result.outcome, "adopted", `adoption must not degrade`);
        assert.equal(result.branchPoint, snap.orderedMessages.length, "full-prefix adoption");

        // The full-chain effects equal a raw POST fork: verbatim whole-table
        // copy, latch inheritance, lineage pair + egress watermark.
        assert.deepEqual(ustore.egressStateView("c6"), parentView, "client-adopted child flow is the verbatim copy");
        assert.equal(peekSession("c6")!.metadata.egressAuthority, true, "child inherits the egressAuthority latch");
        {
            const { DatabaseSync } = await import("node:sqlite");
            const raw = new DatabaseSync(`${h.dir}/sessions/index.db`, { readOnly: true });
            const row = raw.prepare("SELECT parent_session_id, fork_egress_watermark FROM sessions WHERE session_id = 'c6'").get() as { parent_session_id: string | null; fork_egress_watermark: number | null };
            raw.close();
            assert.equal(row.parent_session_id, "p6");
            assert.equal(row.fork_egress_watermark, ustore.egressStateMaxSeq("p6"));
        }

        // The child's first model call: the prefix cells are the CANONICAL
        // (stamped) bytes — flow is the content authority, so that is exactly
        // what the host holds after an adopted fork — plus the fresh tail.
        const before = ustore.egressStateMaxSeq("c6");
        const inheritedMax = Math.max(...ustore.egressStateView("c6").map((r) => r.num ?? 0));
        const childMsgs = [...snap.messages.map((row) => ({ role: row.role, content: row.text ?? "" })), m("user", 6)];
        await turn(h.base, "c6", childMsgs, [...snap.orderedMessages.map((o) => o.rawId), "c6-new-0"]);
        await settle(h.store, "c6");
        const v2 = ustore.egressStateView("c6");
        // Renumber (2026-11-25): the new cell's number is one above the
        // HIGHEST inherited canonical number — the kernel ledger and the
        // egress numbers are the same space now, so the kernel mints
        // highWater+1 (or the dense fallback does). The op_seq count
        // (before) is a different sequence and no longer predicts it.
        assert.equal(v2.find((r) => r.msgid === "c6-new-0")?.num, inheritedMax + 1, `served from its own flow: one new number above the inherited high water ${inheritedMax}, no downgrade (op_seq at fork was ${before})`);
    } finally {
        await h.close(h.store);
    }
});

test("#7658 T7: compression blocks fork, and both sides keep folding independently", async () => {
    // The block-side of "fork 后能压缩吗": the parent folds its middle cells
    // through the REAL client tool channel, the child forks the folded state,
    // and then BOTH sides fold again on their own — the parent's new fold
    // must not touch the child, and the child's must not touch the parent.
    const logs: string[] = [];
    const P7_SUMMARY = "T7 parent summary: the parent folded its middle cells. " + "z".repeat(64);
    const C7_SUMMARY = "T7 child summary: the child folded its own middle cells. " + "w".repeat(64);
    const h = await harness(logs);
    try {
        await seedParent(h.base, "p7");
        await settle(h.store, "p7");
        const ustore = h.store.egressOpLogStore()!;

        // Parent folds cells 2..4 via the real client tool channel, minting
        // its call id up front (#1567): the /tool call and the carrier the
        // host later re-sends share that id, so the kernel always sees the
        // block's live carrier.
        const parentCall = "call-p7-b1";
        const snap0 = await snapshotFull(h.origin, "p7");
        const r2 = snap0.orderedMessages[1]!.ref!;
        const r4 = snap0.orderedMessages[3]!.ref!;
        const receipt = await compressTool(h.origin, "p7", r2, r4, P7_SUMMARY, parentCall);
        await settle(h.store, "p7");
        // #7577 second leg: the egress BLOCK LEDGER rows ride the fork too —
        // written on the parent's egress record path (the unified ingest is
        // frozen for egress-on sessions), copied by the R-B four-table fork.
        // The block ledger rows land on the session's NEXT egress turn
        // (ledgerEgressBooks runs inside recordEgressTurn) - the /tool call
        // itself is not a turn, so at fork time the parent's ledger is still
        // empty and the fork copies it verbatim (asserted after the fork).
        const p7LedgerAtFork = await rawBlockRows(h.dir, "p7", "egress_block_flow");

        // Fork the folded state (client transcript still the 5 raw cells —
        // the host folds on its next turn).
        const snap = await snapshotFull(h.origin, "p7");
        assert.equal(snap.orderedMessages.length, 5);
        const { status, body } = await postFork(h.origin, {
            protocolVersion: 2, parentConversationId: "p7", childConversationId: "c7", parentRevision: snap.parentRevision,
            branchPoint: { messageCount: snap.orderedMessages.length, orderHash: snap.orderHash }, orderedMessages: snap.orderedMessages, idempotencyKey: "fork:c7",
        });
        assert.equal(status, 201, JSON.stringify(body));
        assert.deepEqual((body.inheritedBlocks as Array<{ id: string }>).map((b) => b.id), ["b1"], "the folded block is inherited wholesale (its covered cells are all inside the prefix)");
        // The ledger tables are copied verbatim by the four-table fork (T1's
        // message-flow twin, for blocks) - both sides empty at fork time.
        // The child's ledger self-heals at clone time: the clone ingest's
        // block diff (unified leg, runs for the fresh child even though the
        // egress-on legs are frozen for live turns) records the inherited
        // kernel block set into the child's ledger.
        const c7Ledger = (await rawBlockRows(h.dir, "c7", "egress_block_flow")) as Array<{ row_type: string; block_id: string }>;
        assert.equal(c7Ledger.length, 1, "child ledger holds exactly the inherited block at clone time");
        assert.equal(c7Ledger[0]!.row_type, "I");
        assert.equal(c7Ledger[0]!.block_id, "b1");
        // The KERNEL block set rides the fork: same blocks, same payloads.
        const p7KernelBlocks = JSON.stringify(peekSession("p7")!.state.blocks);
        const c7 = peekSession("c7")!;
        assert.equal(JSON.stringify(c7.state.blocks), p7KernelBlocks, "child kernel block set = parent's, byte for byte");
        const c7b1view = c7.blockContents.get("b1") as { one: { text: string } | null; full: { text?: string } } | undefined;
        assert(typeof c7b1view?.full?.text === "string" && c7b1view.full.text.length > 0, "b1's original content survives in the child");
        const c7BeforeFold = ustore.egressStateView("c7");

        // The parent folds AFTER the fork (原会话也能正常压缩, 不受新会话影响):
        // the host's next turn is the pi fold shape — head + its own summary
        // message + tail + fresh cell (the T5 shape; on the plugin lane the
        // fold executes host-side, src/plugin.ts:3714).
        const parentMsgs = [HISTORY[0]!, { role: "assistant" as const, content: P7_SUMMARY }, HISTORY[4]!, m("user", 6)];
        const parentIds = ["p7-id-0", "p7-fold-0", "p7-id-4", "p7-new-0"];
        await turn(h.base, "p7", parentMsgs, parentIds);
        await settle(h.store, "p7");
        const p7AfterFold = ustore.egressStateView("p7");
        const p7Live = new Set(p7AfterFold.map((r) => r.msgid));
        for (const gone of ["p7-id-1", "p7-id-2", "p7-id-3"]) assert(!p7Live.has(gone), `parent covered cell ${gone} retired by its own fold`);
        assert(p7Live.has("p7-fold-0") && p7Live.has("p7-new-0") && p7Live.has("p7-id-0") && p7Live.has("p7-id-4"), "head/fold/tail/new cells all live in the parent flow");
        // The parent's fold turn (its first egress turn since the /tool call
        // created b1) booked b1 into the PARENT's ledger - and only there.
        const p7LedgerAfterFold = (await rawBlockRows(h.dir, "p7", "egress_block_flow")) as Array<{ row_type: string; block_id: string }>;
        assert(p7LedgerAfterFold.some((r) => r.row_type === "I" && r.block_id === "b1"), "the parent's fold turn books b1 into its block ledger");
        assert.deepEqual(await rawBlockRows(h.dir, "c7", "egress_block_flow"), c7Ledger, "the child ledger is untouched by the parent's fold");
        const c7WatermarkAtFork = Math.max(...c7BeforeFold.map((r) => r.num));
        const p7FoldNum = p7AfterFold.find((r) => r.msgid === "p7-fold-0")?.num;
        assert(p7FoldNum !== undefined && p7FoldNum > c7WatermarkAtFork, `the post-fork parent summary takes a fresh number above the fork watermark (${p7FoldNum} > ${c7WatermarkAtFork})`);
        // 新会话不受原会话影响: the child is byte-for-byte the fork-time copy.
        assert.deepEqual(ustore.egressStateView("c7"), c7BeforeFold, "the parent's post-fork fold must not touch the child flow");
        assert.equal(JSON.stringify(peekSession("c7")!.state.blocks), p7KernelBlocks, "child block set untouched by the parent's post-fork fold");

        // The child folds its OWN range (新会话也能正常压缩, 不影响原会话):
        // r2..r4 was ALREADY consumed by the parent's b1, so the child
        // compresses a DIFFERENT live range (head + tail cells) — the real
        // tool channel books it as b2 in the child only.
        const r1 = snap0.orderedMessages[0]!.ref!;
        const r5 = snap0.orderedMessages[4]!.ref!;
        await compressTool(h.origin, "c7", r1, r5, C7_SUMMARY);
        await settle(h.store, "c7");
        const p7FlowBeforeChildFold = ustore.egressStateView("p7");
        const childMsgs = [HISTORY[0]!, { role: "assistant" as const, content: C7_SUMMARY }, HISTORY[4]!, m("user", 6)];
        await turn(h.base, "c7", childMsgs, ["p7-id-0", "c7-fold-0", "p7-id-4", "c7-new-0"]);
        await settle(h.store, "c7");
        const c7AfterFold = ustore.egressStateView("c7");
        const c7Live = new Set(c7AfterFold.map((r) => r.msgid));
        for (const gone of ["p7-id-1", "p7-id-2", "p7-id-3"]) assert(!c7Live.has(gone), `child covered cell ${gone} retired by its own fold`);
        assert(c7Live.has("c7-fold-0") && c7Live.has("c7-new-0"), "the child's fold and fresh cell book in its own flow");
        const c7NewNum = c7AfterFold.find((r) => r.msgid === "c7-new-0")?.num;
        assert(c7NewNum !== undefined && c7NewNum > c7WatermarkAtFork, `the child's fresh cell continues above the inherited watermark (${c7NewNum} > ${c7WatermarkAtFork})`);
        assert.deepEqual(ustore.egressStateView("p7"), p7FlowBeforeChildFold, "the child's fold must not touch the parent flow");
        assert(!peekSession("p7")!.state.blocks.some((b) => b.blockId === "b2"), "the child's own block b2 never leaks into the parent's block set");
        // ...and the ledgers match their kernel sets: the child's fold turn
        // re-books the inherited b1 (self-heal) plus its own b2; the parent
        // keeps exactly b1.
        const c7LedgerFinal = (await rawBlockRows(h.dir, "c7", "egress_block_flow")) as Array<{ row_type: string; block_id: string }>;
        const p7LedgerFinal = (await rawBlockRows(h.dir, "p7", "egress_block_flow")) as Array<{ row_type: string; block_id: string }>;
        assert(c7LedgerFinal.some((r) => r.block_id === "b1") && c7LedgerFinal.some((r) => r.row_type === "I" && r.block_id === "b2"), "child ledger holds b1 (clone-time record, U'd to the egress-record shape) + b2 (its own fold)");
        assert(p7LedgerFinal.some((r) => r.row_type === "I" && r.block_id === "b1") && !p7LedgerFinal.some((r) => r.block_id === "b2"), "parent ledger keeps exactly b1");
    } finally {
        await h.close(h.store);
    }
});

test("#7658 T8: fork-after-fork — the grandchild inherits the whole chain", async () => {
    // p8 folds FIRST (real gate order: a session compresses, then a host
    // forks it), c8 forks the FOLDED state — its compressed content rides
    // the fork as a verbatim flow row, not as a kernel block (the block's
    // covered cells are already retired from the live prefix) — and then
    // c8 turns, and g8 forks c8 mid-history.
    const logs: string[] = [];
    const P8_SUMMARY = "T8 summary: p8 folded its middle before anyone forked it. " + "v".repeat(64);
    const h = await harness(logs);
    try {
        await seedParent(h.base, "p8");
        await settle(h.store, "p8");
        const ustore = h.store.egressOpLogStore()!;

        // p8 folds its middle: real tool channel, then the pi fold turn.
        const snap0 = await snapshotFull(h.origin, "p8");
        const r2 = snap0.orderedMessages[1]!.ref!;
        const r4 = snap0.orderedMessages[3]!.ref!;
        await compressTool(h.origin, "p8", r2, r4, P8_SUMMARY);
        await settle(h.store, "p8");
        const p8Msgs = [HISTORY[0]!, { role: "assistant" as const, content: P8_SUMMARY }, HISTORY[4]!, m("user", 6)];
        const p8Ids = ["p8-id-0", "p8-fold-0", "p8-id-4", "p8-new-0"];
        await turn(h.base, "p8", p8Msgs, p8Ids);
        await settle(h.store, "p8");
        const p8View = ustore.egressStateView("p8");
        const p8Live = new Set(p8View.map((r) => r.msgid));
        assert(p8Live.has("p8-fold-0") && p8Live.has("p8-new-0"), "p8's fold booked in its own flow");

        // p8 → c8: fork the FOLDED state. The compressed content (the
        // summary row) is copied verbatim; the kernel block b1 is NOT
        // inherited, because its covered cells no longer exist in the live
        // prefix — the summary row IS the compressed block, now.
        const snap = await snapshotFull(h.origin, "p8");
        assert.equal(snap.orderedMessages.length, 4, "folded parent exposes 4 live cells");
        const f1 = await postFork(h.origin, {
            protocolVersion: 2, parentConversationId: "p8", childConversationId: "c8", parentRevision: snap.parentRevision,
            branchPoint: { messageCount: snap.orderedMessages.length, orderHash: snap.orderHash }, orderedMessages: snap.orderedMessages, idempotencyKey: "fork:c8",
        });
        assert.equal(f1.status, 201, JSON.stringify(f1.body));
        assert.deepEqual(ustore.egressStateView("c8"), p8View, "c8's flow = the folded parent flow, verbatim");
        const c8Summary = ustore.egressStateView("c8").find((r) => r.bytes.includes(P8_SUMMARY));
        assert(c8Summary, "the parent's compressed summary row survives the fork byte for byte");
        const c8HighWater = ustore.egressStateMaxSeq("c8");
        assert.equal(c8HighWater, ustore.egressStateMaxSeq("p8"), "c8's flow watermark = p8's at fork time");

        // c8's first turn: resends the inherited prefix on its ids + fresh cell.
        const c8Msgs = [HISTORY[0]!, { role: "assistant" as const, content: P8_SUMMARY }, HISTORY[4]!, m("user", 6), m("assistant", 7)];
        await turn(h.base, "c8", c8Msgs, [...p8Ids, "c8-new-0"]);
        await settle(h.store, "c8");
        const c8View = ustore.egressStateView("c8");
        assert.equal(c8View.find((r) => r.msgid === "c8-new-0")?.num, Math.max(...p8View.map((r) => r.num)) + 1, "c8's cell continues above the inherited number space");

        // c8 → g8: MID-HISTORY fork (prefix = first 3 cells).
        const snapC8 = await snapshotFull(h.origin, "c8");
        assert.equal(snapC8.orderedMessages.length, 5);
        const prefix3 = snapC8.orderedMessages.slice(0, 3);
        const f2 = await postFork(h.origin, {
            protocolVersion: 2, parentConversationId: "c8", childConversationId: "g8", parentRevision: snapC8.parentRevision,
            branchPoint: { messageCount: 3, orderHash: forkOrderHashOf(prefix3) }, orderedMessages: prefix3, idempotencyKey: "fork:g8",
        });
        assert.equal(f2.status, 201, JSON.stringify(f2.body));
        const c8ViewAtG8Fork = ustore.egressStateView("c8");
        assert.deepEqual(ustore.egressStateView("g8"), c8ViewAtG8Fork, "g8's flow = c8's flow at fork time, verbatim (tail included)");
        {
            const { DatabaseSync } = await import("node:sqlite");
            const raw = new DatabaseSync(`${h.dir}/sessions/index.db`, { readOnly: true });
            const c8row = raw.prepare("SELECT parent_session_id, fork_egress_watermark FROM sessions WHERE session_id = 'c8'").get() as { parent_session_id: string | null; fork_egress_watermark: number | null };
            const g8row = raw.prepare("SELECT parent_session_id, fork_egress_watermark FROM sessions WHERE session_id = 'g8'").get() as { parent_session_id: string | null; fork_egress_watermark: number | null };
            raw.close();
            assert.equal(c8row.parent_session_id, "p8", "lineage level 1: c8 <- p8");
            assert.equal(g8row.parent_session_id, "c8", "lineage level 2: g8 <- c8");
            assert.equal(g8row.fork_egress_watermark, ustore.egressStateMaxSeq("c8"), "g8's watermark column = c8's flow watermark at its fork time");
        }

        // g8's first turn drops the tail c8 had grown (the D-run) and adds
        // its own cell, numbered above c8's high water.
        const g8Msgs = [HISTORY[0]!, { role: "assistant" as const, content: P8_SUMMARY }, HISTORY[4]!, m("user", 6)];
        await turn(h.base, "g8", g8Msgs, ["p8-id-0", "p8-fold-0", "p8-id-4", "g8-new-0"]);
        await settle(h.store, "g8");
        const g8View = ustore.egressStateView("g8");
        const g8Live = new Set(g8View.map((r) => r.msgid));
        for (const gone of ["p8-new-0", "c8-new-0"]) assert(!g8Live.has(gone), `tail cell ${gone} retired from g8 by the mid-history fork D-run`);
        const c8NumHighWater = Math.max(...c8ViewAtG8Fork.map((r) => r.num));
        assert.equal(g8View.find((r) => r.msgid === "g8-new-0")?.num, c8NumHighWater + 1, "g8's fresh cell continues strictly above c8's number high water at its fork time");
        // Both ancestors untouched by the grandchild.
        assert.deepEqual(ustore.egressStateView("c8"), c8ViewAtG8Fork, "c8 untouched by g8's turn");
        assert.deepEqual(ustore.egressStateView("p8"), p8View, "p8 untouched by its descendants' turns");
    } finally {
        await h.close(h.store);
    }
});

test("#7658 T9: the egress BLOCK LEDGER is written on the egress record path (the #7577 second leg)", async () => {
    // #7577 promised the block ledger (egress_block_state / egress_block_flow)
    // rebuilds the block set from the op log alone — but its only writer sat
    // in the unified ingestSession (src/storage/store.ts, gated on the
    // save-envelope metadata.egressAuthority), and a fully armed egress-on
    // session skips the unified record entirely (egressProjectionFrozen,
    // src/persist.ts) — so the ledger tables stayed EMPTY (T9 used to pin
    // that red). Fix (this PR): the egress record path carries the in-memory
    // block set (egressBlockLedgerFor) and diffBlockSet lands it in the
    // dual-clock tables with the kstate residual sidecar — the second leg of
    // the kstate retirement (block flow → blocks; the message flow already
    // covered messageRefs/tokenSnapshot/tsStamps).
    const logs: string[] = [];
    const T9_SUMMARY = "T9 pin: a fully armed egress-on fold. " + "q".repeat(64);
    const h = await harness(logs);
    try {
        await seedParent(h.base, "p9");
        await settle(h.store, "p9");
        assert.equal(peekSession("p9")!.metadata.egressAuthority, true, "armed precondition");
        const snap0 = await snapshotFull(h.origin, "p9");
        const r2 = snap0.orderedMessages[1]!.ref!;
        const r4 = snap0.orderedMessages[3]!.ref!;
        await compressTool(h.origin, "p9", r2, r4, T9_SUMMARY);
        await settle(h.store, "p9");
        // The KERNEL block landed (the /tool channel works)...
        const blocksAtFold = peekSession("p9")!.state.blocks;
        assert.equal(blocksAtFold.filter((b) => b.active).length, 1, "the fold created exactly one active kernel block");
        // ...and the fold turn records it in the ledger on the egress record
        // path (the kernel deactivates b1 afterwards — its covered cells left
        // the host history without a live carrier; kernel consumer logic,
        // unrelated to egress; the block row stays in state.blocks).
        const msgs = [HISTORY[0]!, { role: "assistant" as const, content: T9_SUMMARY }, HISTORY[4]!, m("user", 6)];
        await turn(h.base, "p9", msgs, ["p9-id-0", "p9-fold-0", "p9-id-4", "p9-new-0"]);
        await settle(h.store, "p9");
        assert.equal(peekSession("p9")!.state.blocks.length, blocksAtFold.length, "the kernel block row survives its deactivation");
        // THE LEDGER IS WRITTEN: one I row in the flow, one state replica.
        const stateRows = (await rawBlockRows(h.dir, "p9", "egress_block_state")) as Array<Record<string, unknown>>;
        const flowRows = (await rawBlockRows(h.dir, "p9", "egress_block_flow")) as Array<Record<string, unknown>>;
        assert.equal(stateRows.length, 1, "one state-replica row (b1)");
        assert.equal(stateRows[0]?.["block_id"], "b1");
        const iRow = flowRows.find((r) => r["row_type"] === "I" && r["block_id"] === "b1");
        assert(iRow !== undefined, "the I row for b1 in the block flow");
        // Self-contained (ruling 7439-2): the I row carries the block's FULL
        // bytes (the original covered messages, not the summary) and the
        // kstate residual sidecar; coordinates are best-effort on the egress
        // clock — b1's covered cells were D-retired by THIS turn, so the seqs
        // are the 0/0 "unknown bounds" shape and the msgids carry the range.
        const payload = JSON.parse(String(iRow!["payload"])) as Record<string, unknown>;
        assert(payload["full"] === undefined || String(payload["full"]).includes(String(HISTORY[1]!.content)), "the I row's full bytes carry the original covered messages");
        const sidecar = iRow!["kstate_json"];
        assert(typeof sidecar === "string" && sidecar.length > 0, "the kstate residual sidecar rides the row");
        JSON.parse(sidecar as string);
        assert.equal(payload["startMsgid"], "p9-id-1", "coverage start msgid");
        assert.equal(payload["endMsgid"], "p9-id-3", "coverage end msgid");
        // Replay reconstructs the block set from the ledger alone.
        const rep = h.store.egressOpLogStore()!.egressBlockReplay("p9", Number(stateRows[0]!["op_seq"]));
        assert(rep.blocks.has("b1"), "replay returns b1");
        assert(typeof rep.kstate === "string" && rep.kstate.length > 0, "replay returns the sidecar");
    } finally {
        await h.close(h.store);
    }
});

test("T10 kstate retirement: the cold egress-on load rebuilds blocks/refs/tsStamps from the op log (PR-B)", async () => {
    // The egress-on unified legs are FROZEN (egressProjectionFrozen): the
    // kstate_json column never tracks the live kernel state of an armed
    // session, so a folded egress-on session cold-loaded the legacy way
    // comes back with an EMPTY block set (the #3573 "NO persisted blocks"
    // shape) — a cold fork of it inherits nothing. PR-B makes the load the
    // rebuild point: blocks from the block ledger (PR-A writes it),
    // messageRefs/tsStamps from the message flow, residual from the sidecar.
    // KDD #25 (owner ruling 2026-11-26): the former egressKstateRetireWrites / egressKstateRebuild
    // gates were removed — the kstate retirement+rebuild is part of egressPlane itself
    // (ONE switch), so no env pin is needed here.
    const logs: string[] = [];
    const h = await harness(logs);
    try {
        await seedParent(h.base, "p10");
        await settle(h.store, "p10");
        assert.equal(peekSession("p10")!.metadata.egressAuthority, true, "armed precondition");
        const snap0 = await snapshotFull(h.origin, "p10");
        const r2 = snap0.orderedMessages[1]!.ref!;
        const r4 = snap0.orderedMessages[3]!.ref!;
        const T10_SUMMARY = "T10 fold: the kstate retirement pin. " + "z".repeat(48);
        await compressTool(h.origin, "p10", r2, r4, T10_SUMMARY);
        await settle(h.store, "p10");
        const foldTurn = [HISTORY[0]!, { role: "assistant" as const, content: T10_SUMMARY }, HISTORY[4]!, m("user", 6)];
        await turn(h.base, "p10", foldTurn, ["p10-id-0", "p10-fold-0", "p10-id-4", "p10-new-0"]);
        await settle(h.store, "p10");
        // The fork materializes the parent's skeleton sessions row (the
        // egress-on parent has no full unified row of its own).
        const snapF = await snapshotFull(h.origin, "p10");
        const fp = await postFork(h.origin, {
            protocolVersion: 1,
            parentConversationId: "p10",
            childConversationId: "c10",
            parentRevision: snapF.parentRevision,
            branchPoint: { messageCount: snapF.orderedMessages.length, orderHash: snapF.orderHash },
            orderedMessages: snapF.orderedMessages,
            idempotencyKey: "fork:c10",
        });
        assert.equal(fp.status, 201, "the skeleton-row fork: " + JSON.stringify(fp.body));
        await settle(h.store, "p10");
        // PHASE 1 (PR-B ON): the cold load rebuilds the kernel state from
        // the op log alone.
        h.store.cancelAll();
        const store2 = new SessionStore({ dir: h.dir + "/sessions", enabled: true, debounceMs: 15 });
        try {
            const cold = await store2.loadAsync("p10");
            assert(cold !== null, "cold load finds the session");
            const blocks = cold!.state.blocks;
            assert.equal(blocks.length, 1, "the folded block rebuilt from the block ledger");
            assert.equal(blocks[0]!.blockId, "b1");
            assert.equal(blocks[0]!.summary, T10_SUMMARY, "the fold summary text rides the ledger payload");
            assert.deepEqual(blocks[0]!.effectiveMessageIds, ["p10-id-1", "p10-id-2", "p10-id-3"], "coverage msgids self-contained");
            const refs = (cold!.state as unknown as { messageRefs: { byRaw: Record<string, string> } }).messageRefs;
            assert(refs.byRaw["p10-id-0"] !== undefined, "messageRefs rebuilt from the live flow rows");
            const ts = cold!.state.tsStamps;
            // Renumber (2026-11-25): tsStamps derive from the LIVE view —
            // after the fold the covered cells are retired, so the four
            // live rows (id-0, fold-0, id-4, new-0) are the expected set.
            assert(ts !== undefined && Object.keys(ts).length === 4, "tsStamps derived for exactly the live rows (retired rows are not in the view)");
            assert(ts!["p10-id-0"] !== undefined && ts!["p10-fold-0"] !== undefined && ts!["p10-id-4"] !== undefined && ts!["p10-new-0"] !== undefined, "the four live rows carry their first-observed ts");
        } finally {
            store2.cancelAll();
        }
        // PHASE 2 (the pre-PR-B off-arm) is gone with the separate gate:
        // KDD #25 folded retirement+rebuild into egressPlane (ONE switch),
        // so the cold load above is the only behavior to pin.
    } finally {
        await h.close(h.store);
    }
});

test("#7658 T11: the fork route must not leak a raw corruption error as FORK_FAILED (review fix)", async () => {
    const logs: string[] = [];
    const h = await harness(logs);
    let wdb: ReturnType<typeof openSqliteDatabase> | null = null;
    try {
        await seedParent(h.base, "p11");
        await settle(h.store, "p11");
        assert.equal(peekSession("p11")!.metadata.egressAuthority, true, "armed precondition");

        // Capped: the client-side raw snapshot is gone (same simulation as
        // T4) — the op log is the only remaining source for both routes.
        const parent = peekSession("p11")!;
        parent.pluginSnapshot = undefined;
        parent.metadata.publicSnapshotCapped = true;
        await h.store.flushSessionNow(parent);
        await settle(h.store, "p11");

        // A healthy op log still serves the snapshot (T4's wiring).
        const snap = await snapshot(h.origin, "p11");

        // DAMAGE the flow: a second reader removes the last-but-one row — the
        // replay density check then throws EgressStateCorruptError on every
        // egressStateView. The damage lands AFTER the last flush, so no
        // debounced save can repair it.
        wdb = openSqliteDatabase(join(h.dir, "sessions", "index.db"));
        const rows = wdb.db.prepare("SELECT op_seq FROM egress_flow WHERE session_id = ? ORDER BY op_seq").all("p11") as { op_seq: number }[];
        assert.ok(rows.length >= 5, `flow holds the history (${rows.length} rows)`);
        wdb.db.prepare("DELETE FROM egress_flow WHERE session_id = ? AND op_seq = ?").run("p11", rows[rows.length - 1].op_seq - 1);

        // The fork route computes its source link OUTSIDE the structured
        // 409 try: pre-fix the view's throw escaped the lock scope and
        // surfaced as a 503 FORK_FAILED whose body carries the raw
        // EgressStateCorruptError text (client-visible DB internals).
        // Post-fix egressOpLogSource degrades to "no source" and the route's
        // own try produces the diagnosable 409 SNAPSHOT_UNAVAILABLE.
        const fork = await postFork(h.origin, {
            protocolVersion: 2, parentConversationId: "p11", childConversationId: "c11", parentRevision: snap.parentRevision,
            branchPoint: { messageCount: snap.orderedMessages.length, orderHash: snap.orderHash }, orderedMessages: snap.orderedMessages, idempotencyKey: "fork:c11",
        });
        assert.equal(fork.status, 409, JSON.stringify(fork.body));
        assert.equal(fork.body.code, "SNAPSHOT_UNAVAILABLE", `a damaged op log degrades to the structured 409, not an unhandled 500 (${JSON.stringify(fork.body).slice(0, 200)})`);
        assert.match(logs.join("\n"), /egress op-log fork source unreadable/, "the degradation is logged (a damaged log is a support incident)");
    } finally {
        if (wdb) try { wdb.db.close(); } catch { /* best-effort */ }
        await h.close(h.store);
    }
});
