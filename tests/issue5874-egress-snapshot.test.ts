// #5874 v2 step 3 — egress_snapshot: the CAS-materialized D-lane prefix
// (+/- gate discipline, #3617).
//
// Shape: one cache row per CUT (fold boundary / every-K / user-message
// boundary — the latter is step 4). A row pins the DERIVED stable prefix
// (D-lane buildView output up to the seam, anchors included) into the content
// CAS plus the input aggregate the prefix was derived from. The input
// aggregate is id-bound: sha256 over (seq, msg_id, content_hash) of ALL
// generations of the pinned id set (a content rewrite or new generation of a
// pinned id moves it; a pure retirement or tail growth does NOT). The egress
// read re-derives the aggregate BEFORE trusting the bytes; a miss degrades
// the round to the live derive (never sticky, never partial). A PINNED
// post-cut fold that crosses the prefix also degrades: its summary replaces
// the originals in the render, so the materialized bytes are stale; an
// UNPINNED crossing fold (covered rows re-emerged live) re-renders the
// originals — the old bytes stay valid.
//
// Fold fixture shape (production, per tests/issue5874-fold-journal.test.ts):
// the folded log keeps EVERY original message (the kernel tags the covered
// ids in the transcript — the model may cite them) and appends the summary
// under a NEW id. Covered rows only die on a LATER ingest whose log no longer
// carries them (the complete-log sweep retires them) — that later state is
// the PINNED one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CoreMessage } from "acp-kernel";
import {
    planIngest,
    type LegacySessionLike,
} from "../src/storage/ingest.js";
import { openSqliteDatabase, type SqliteDatabase } from "../src/storage/driver.js";
import { UnifiedStore } from "../src/storage/store.js";
import { egressInputHash } from "../src/storage/snap.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function open(dir: string): UnifiedStore {
    return UnifiedStore.open(join(dir, "store.db"));
}
function rm(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function core(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text } as CoreMessage;
}

function plainSession(n: number): LegacySessionLike {
    const lastMessages: CoreMessage[] = [];
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    for (let i = 1; i <= n; i++) {
        const id = `m${i}`;
        lastMessages.push(core(id, i % 2 === 1 ? "user" : "assistant", `text ${i}`));
        byRaw[id] = String(1000 + i);
        byRef[String(1000 + i)] = id;
    }
    return {
        id: "sess-es",
        createdAt: 1000,
        lastSeen: 2000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw, byRef } },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: true,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

/** A folded session in PRODUCTION shape: the log keeps every original
 *  verbatim and appends the summary under a NEW id (m7). */
function foldedSession(covered: string[], drop?: string[]): LegacySessionLike {
    const base = plainSession(6);
    const dropSet = new Set(drop ?? []);
    const keep = base.lastMessages!.filter((m) => !dropSet.has(m.id));
    const blk = {
        blockId: "blk-f1",
        runId: "run-f1",
        createdAt: 2000,
        tier: 1,
        active: true,
        summary: "summary f1",
        effectiveMessageIds: covered,
        directBlockIds: [],
        compressedTokens: covered.length * 10,
        survivedCount: 6 - covered.length,
        generation: "young",
    };
    base.state.blocks = [blk as never];
    base.state.nextBlockId = 2;
    base.lastMessages = [...keep, core("m7", "assistant", "summary f1")];
    (base.state.messageRefs as { byRaw: Record<string, string>; byRef: Record<string, string> }).byRaw["m7"] = "1007";
    (base.state.messageRefs as { byRaw: Record<string, string>; byRef: Record<string, string> }).byRef["1007"] = "m7";
    return base;
}

test("#5874-v2 T1: egress_snapshot table probe-first (fresh + additive upgrade, no bump)", () => {
    process.env.BILI_PERSIST_ZSTD = "0";
    const fresh = mkdtempSync(join(tmpdir(), "bili-5874-es-"));
    try {
        const st = open(fresh);
        st.close();
        const raw = openSqliteDatabase(join(fresh, "store.db")).db as unknown as SqliteDatabase;
        assert.equal(
            (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='egress_snapshot'").get() as { name: string } | undefined)?.name,
            "egress_snapshot",
        );
    } finally { rm(fresh); }
});

test("#5874-v2 T2: the input aggregate is STABLE across an unrelated fold (+/-)", () => {
    process.env.BILI_PERSIST_ZSTD = "0";
    const dir = mkdtempSync(join(tmpdir(), "bili-5874-es-"));
    try {
        const st = open(dir);
        assert.ok(st.ingestSession(planIngest(plainSession(6))), "seed");
        const ids = ["m1", "m2", "m3", "m4"];
        const before = st.egressCut("sess-es", ids, undefined, 1000);
        assert.ok(before, "cut writes a row");
        assert.equal(before.ids.length, 4);
        assert.equal(before.lastStableId, "m4");
        // The fold lands over m5/m6 (outside the pinned set); the folded log
        // keeps every original, so m1..m4 are untouched: re-deriving over the
        // SAME ids must match byte-for-byte.
        assert.ok(st.ingestSession(planIngest(foldedSession(["m5", "m6"])), undefined, { completeLog: true }), "fold");
        const redone = st.egressCut("sess-es", ids, undefined, 2000);
        assert.ok(redone);
        assert.equal(redone.inputHash, before.inputHash, "aggregate stable across an unrelated fold");
        st.close();
    } finally { rm(dir); }
});

test("#5874-v2 T3: content move ⇒ aggregate move (the verify gate)", () => {
    process.env.BILI_PERSIST_ZSTD = "0";
    const dir = mkdtempSync(join(tmpdir(), "bili-5874-es-"));
    try {
        const path = join(dir, "store.db");
        const st = open(dir);
        assert.ok(st.ingestSession(planIngest(plainSession(6))), "seed");
        const raw = openSqliteDatabase(path).db as unknown as SqliteDatabase;
        // (+) window probe: a retirement inside the window moves it.
        const hashOf = () => egressInputHash(raw, "sess-es", 5, []);
        const before = hashOf();
        assert.ok(before);
        raw.prepare(
            "UPDATE messages SET retired_at = 2000 WHERE session_id = 'sess-es' AND msg_id = 'm2' AND retired_at IS NULL",
        ).run();
        assert.notEqual(hashOf(), before, "in-window retirement moves the window aggregate");
        // (+) id-bound aggregate: a new generation of a pinned id (via the
        //  real ingest path — a same-id content rewrite) moves it.
        const idHash = () => egressInputHash(raw, "sess-es", 0, ["m1", "m2"]);
        const idBefore = idHash();
        assert.ok(idBefore);
        const revised = plainSession(6);
        (revised.lastMessages as unknown as Array<{ id: string; text: string }>).find((m) => m.id === "m2")!.text = "m2-REVISED";
        assert.ok(st.ingestSession(planIngest(revised), undefined, { completeLog: true }), "rewrite m2");
        assert.notEqual(idHash(), idBefore, "new generation of a pinned id moves the id aggregate");
        // (-) a pure tail growth (new id m7) moves the id aggregate NOT.
        const idAfter = idHash();
        assert.ok(st.ingestSession(planIngest(plainSession(7)), undefined, { completeLog: true }), "tail growth");
        assert.equal(idHash(), idAfter, "tail growth leaves the id aggregate alone");
        st.close();
    } finally { rm(dir); }
});

test("#5874-v2 T4: egressReadView hits byte-identically and degrades on hash move (+/-)", () => {
    process.env.BILI_PERSIST_ZSTD = "0";
    const dir = mkdtempSync(join(tmpdir(), "bili-5874-es-"));
    try {
        const st = open(dir);
        assert.ok(st.ingestSession(planIngest(plainSession(6))), "seed");
        const prefix: CoreMessage[] = [core("m1", "user", "text 1"), core("m2", "assistant", "text 2")];
        const ids = ["m1", "m2"];
        const cut = st.egressCut("sess-es", ids, JSON.stringify(prefix), 1000);
        assert.ok(cut);

        // (+) unchanged ledger ⇒ the exact stored bytes come back.
        const hit = st.egressReadView("sess-es");
        assert.ok(hit);
        assert.deepEqual(JSON.parse(hit.prefix), prefix, "stored bytes verbatim");
        assert.equal(hit.lastStableId, "m2");
        // (-) ledger moved (a same-id rewrite of m1) ⇒ the id-bound re-derive
        //  catches it ⇒ null (legacy derive).
        const revised = plainSession(6);
        (revised.lastMessages as unknown as Array<{ id: string; text: string }>).find((m) => m.id === "m1")!.text = "m1-REVISED";
        assert.ok(st.ingestSession(planIngest(revised), undefined, { completeLog: true }), "rewrite m1");
        assert.equal(st.egressReadView("sess-es"), null, "hash move ⇒ degrade");
        st.close();
    } finally { rm(dir); }
});

test("#5874-v2 T5: deleteSession cascades egress_snapshot", () => {
    process.env.BILI_PERSIST_ZSTD = "0";
    const dir = mkdtempSync(join(tmpdir(), "bili-5874-es-"));
    try {
        const path = join(dir, "store.db");
        const st = open(dir);
        assert.ok(st.ingestSession(planIngest(plainSession(6))), "seed");
        st.egressCut("sess-es", ["m1"], JSON.stringify([core("m1", "user", "text 1")]), 1000);
        const raw = openSqliteDatabase(path).db as unknown as SqliteDatabase;
        assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM egress_snapshot").get() as { n: number }).n, 1);
        st.deleteSession("sess-es");
        assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM egress_snapshot").get() as { n: number }).n, 0);
        st.close();
    } finally { rm(dir); }
});

test("#5874-v2 T6: a PINNED post-cut fold crossing the prefix degrades the read (+/-)", () => {
    process.env.BILI_PERSIST_ZSTD = "0";
    const dir = mkdtempSync(join(tmpdir(), "bili-5874-es-"));
    try {
        const st = open(dir);
        assert.ok(st.ingestSession(planIngest(plainSession(6))), "seed");
        const prefix: CoreMessage[] = [core("m1", "user", "text 1"), core("m2", "assistant", "text 2")];
        const ids = ["m1", "m2"];
        const cut = st.egressCut("sess-es", ids, JSON.stringify(prefix), 1000);
        assert.ok(cut);
        // (+) step 1: the fold lands AFTER the cut over m1/m2; production
        //  shape keeps the covered ids live (the model may still cite them),
        //  so the fold journal row lands with resolvable bounds. While the
        //  covered rows are live the fold is UNPINNED — the originals still
        //  render, the old bytes are valid.
        assert.ok(st.ingestSession(planIngest(foldedSession(["m1", "m2"])), undefined, { completeLog: true }), "fold");
        const unpinned = st.egressReadView("sess-es");
        assert.ok(unpinned, "unpinned crossing fold ⇒ still valid");
        assert.deepEqual(JSON.parse(unpinned.prefix), prefix);
        // (+) step 2: a later save whose log drops m1/m2 (they died into the
        //  summary) retires the covered rows — the fold is now PINNED and
        //  crosses the prefix: the render shows the summary in their place,
        //  so the materialized bytes are stale ⇒ degrade.
        assert.ok(st.ingestSession(planIngest(foldedSession(["m1", "m2"], ["m1", "m2"])), undefined, { completeLog: true }), "covered rows die");
        assert.equal(st.egressReadView("sess-es"), null, "pinned crossing fold ⇒ degrade");
        st.close();
    } finally { rm(dir); }
});

test("#5874-v2 T7: a post-cut fold OUTSIDE the prefix keeps serving (+/-)", () => {
    process.env.BILI_PERSIST_ZSTD = "0";
    const dir = mkdtempSync(join(tmpdir(), "bili-5874-es-"));
    try {
        const st = open(dir);
        assert.ok(st.ingestSession(planIngest(plainSession(6))), "seed");
        const prefix: CoreMessage[] = [core("m1", "user", "text 1"), core("m2", "assistant", "text 2")];
        const ids = ["m1", "m2"];
        const cut = st.egressCut("sess-es", ids, JSON.stringify(prefix), 1000);
        assert.ok(cut);
        // (-) the fold lands after the cut over m6 and later pins (its row
        //  dies out of the log) — but it never crosses the pinned id set:
        //  the prefix render is untouched ⇒ the stored bytes are still valid.
        assert.ok(st.ingestSession(planIngest(foldedSession(["m6"])), undefined, { completeLog: true }), "tail fold");
        assert.ok(st.ingestSession(planIngest(foldedSession(["m6"], ["m6"])), undefined, { completeLog: true }), "tail fold pins");
        const hit = st.egressReadView("sess-es");
        assert.ok(hit, "non-crossing fold does not degrade the prefix read");
        assert.deepEqual(JSON.parse(hit.prefix), prefix, "stored bytes verbatim");
        st.close();
    } finally { rm(dir); }
});
