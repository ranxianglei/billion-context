/**
 * #3464 (R1 of the #2960 identity pipeline): host message ids ingested into
 * the canonical store — reconcile becomes exact set algebra instead of
 * byte-hash guessing.
 *
 * Acceptance coverage:
 *  - stamped lane: one row per host message across drifted resends (no twins);
 *  - unstamped lane: behavior bit-identical to pre-R1;
 *  - fork snapshots can map a host id back to its bili ref (messages rows
 *    carry host_id + ref/ref_num);
 *  - schema v5→v6 migration is additive and probe-guarded;
 *  - Pass -1 claims by exact host-id equality before every heuristic pass,
 *    role-gated, k-th within multi-core groups, and no-ops on unstamped lanes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { STORAGE_DDL_V1_FOR_TESTS, STORAGE_SCHEMA_VERSION } from "../src/storage/schema.ts";
import { UnifiedStore, sha256Hex } from "../src/storage/store.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import {
    HOST_ID_BODY_FIELD,
    HOST_ID_MAX_ENTRIES,
    HOST_ID_MAX_ENTRY_LEN,
    extractHostIds,
    collectWireHostIds,
    coreHostRefs,
    hostKeyOf,
} from "../src/host-id-channel.ts";
import {
    planReconciliation,
    reconcileFoldCoverage,
    normalizedIdentity,
    normalizedIdentityNoToolCallId,
    type FoldAnchor,
    type ReconcileOptions,
} from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue3464-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* leaked temp dir on a Windows runner is harmless */ }
}

function msg(id: string, role: string, text: string, extra?: Record<string, unknown>): CoreMessage {
    return { id, role, contentType: "text", text, ...extra } as CoreMessage;
}

/** LegacySessionLike fixture — state key order matters (digest-sensitive). */
function mkLegacy(
    id: string,
    lastMessages: LegacySessionLike["lastMessages"],
    opts?: {
        lastMessagesHostIds?: (string | null)[];
        pluginSnapshot?: LegacySessionLike["pluginSnapshot"];
        pluginSnapshotHostIds?: (string | null)[];
        byRaw?: Record<string, string>;
    },
): LegacySessionLike {
    const byRaw = opts?.byRaw ?? {};
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw, byRef: Object.fromEntries(Object.entries(byRaw).map(([k, v]) => [v, k])) },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: false,
        pluginSnapshot: opts?.pluginSnapshot,
        lastMessagesHostIds: opts?.lastMessagesHostIds,
        pluginSnapshotHostIds: opts?.pluginSnapshotHostIds,
    };
}

describe("extractHostIds (#3464)", () => {
    const field = HOST_ID_BODY_FIELD;

    test("valid stamp passes through and is stripped", () => {
        const parsed: Record<string, unknown> = { messages: [{}, {}], [field]: ["H1", null] };
        const ex = extractHostIds(parsed, parsed.messages as readonly unknown[] | undefined);
        assert.deepEqual(ex.ids, ["H1", null]);
        assert.equal(ex.stripped, true);
        assert.ok(!(field in parsed), "reserved field must never survive extraction");
    });

    test("absent field is a no-op", () => {
        const parsed: Record<string, unknown> = { messages: [{}] };
        const ex = extractHostIds(parsed, parsed.messages as readonly unknown[] | undefined);
        assert.equal(ex.ids, null);
        assert.equal(ex.stripped, false);
    });

    test("length mismatch ⇒ malformed, stripped, ignored", () => {
        const parsed: Record<string, unknown> = { messages: [{}, {}], [field]: ["only-one"] };
        const ex = extractHostIds(parsed, parsed.messages as readonly unknown[] | undefined);
        assert.equal(ex.ids, null);
        assert.equal(ex.stripped, true);
        assert.ok(!(field in parsed));
    });

    test("non-array field ⇒ malformed, stripped", () => {
        const parsed: Record<string, unknown> = { messages: [{}], [field]: "H1" };
        const ex = extractHostIds(parsed, parsed.messages as readonly unknown[] | undefined);
        assert.equal(ex.ids, null);
        assert.equal(ex.stripped, true);
        assert.ok(!(field in parsed));
    });

    test("non-string / empty / oversized / control-char entries ⇒ malformed", () => {
        const bad: unknown[][] = [[42], [""], [["x".repeat(HOST_ID_MAX_ENTRY_LEN + 1)]], [["a\nb"]], [["a b"]]];
        for (const raw of bad) {
            const parsed: Record<string, unknown> = { messages: [{}], [field]: raw };
            const ex = extractHostIds(parsed, parsed.messages as readonly unknown[] | undefined);
            assert.equal(ex.ids, null, JSON.stringify(raw));
            assert.equal(ex.stripped, true);
            assert.ok(!(field in parsed));
        }
    });

    test("more entries than the channel allows ⇒ malformed", () => {
        const n = HOST_ID_MAX_ENTRIES + 1;
        const parsed: Record<string, unknown> = { messages: new Array(n).fill({}), [field]: new Array(n).fill("H") };
        const ex = extractHostIds(parsed, parsed.messages as readonly unknown[] | undefined);
        assert.equal(ex.ids, null);
        assert.equal(ex.stripped, true);
    });

    test("missing message array ⇒ malformed (cannot verify alignment)", () => {
        const parsed: Record<string, unknown> = { [field]: ["H1"] };
        const ex = extractHostIds(parsed, undefined);
        assert.equal(ex.ids, null);
        assert.equal(ex.stripped, true);
        assert.ok(!(field in parsed));
    });
});

describe("collectWireHostIds (#3464 plugin side)", () => {
    test("reads each wire message's own id, pads with null", () => {
        const out = collectWireHostIds([{ id: "a" }, {}, { id: "c" }], 100);
        assert.deepEqual(out, ["a", null, "c"]);
    });

    test("nothing to stamp ⇒ null", () => {
        assert.equal(collectWireHostIds([{}, { content: 1 }], 100), null);
    });

    test("ANY malformed entry kills the whole stamp", () => {
        assert.equal(collectWireHostIds([{ id: 7 }, { id: "ok" }], 100), null);
        assert.equal(collectWireHostIds([{ id: "" }], 100), null);
        assert.equal(collectWireHostIds([{ id: "x".repeat(HOST_ID_MAX_ENTRY_LEN + 1) }], 100), null);
        assert.equal(collectWireHostIds([{ id: "bad\nid" }], 100), null);
    });

    test("over-cap message count ⇒ null", () => {
        const msgs = new Array(HOST_ID_MAX_ENTRIES + 1).fill({ id: "x" });
        assert.equal(collectWireHostIds(msgs, HOST_ID_MAX_ENTRIES), null);
    });
});

describe("coreHostRefs (#3464 slot semantics)", () => {
    test("multi-core wire message gets per-core slots", () => {
        const refs = coreHostRefs(
            [{ id: "a", wireIndex: 0 }, { id: "b", wireIndex: 0 }, { id: "c", wireIndex: 1 }],
            ["H1", "H1", "H2"],
        );
        assert.deepEqual(refs, [{ hostId: "H1", slot: 0 }, { hostId: "H1", slot: 1 }, { hostId: "H2", slot: 0 }]);
        assert.notEqual(hostKeyOf(refs[0]!), hostKeyOf(refs[1]!));
    });

    test("cores without wireIndex get per-core-unique slots", () => {
        const refs = coreHostRefs([{ id: "a" }, { id: "b" }, { id: "c" }], ["H1", null, "H2"]);
        assert.deepEqual(refs, [{ hostId: "H1", slot: 0 }, null, { hostId: "H2", slot: 2 }]);
    });

    test("unpairable list ⇒ all-null refs", () => {
        const refs = coreHostRefs([{ id: "a" }, { id: "b" }], ["only"]);
        assert.deepEqual(refs, [null, null]);
        assert.deepEqual(coreHostRefs([{ id: "a" }], undefined), [null]);
    });

    test("composite key separator cannot occur inside a validated id", () => {
        assert.equal(hostKeyOf({ hostId: "abc", slot: 2 }), "abc\u00002");
    });
});

describe("schema v6 host-id columns (#3464)", () => {
    test("fresh DB lands at v6 with columns and partial index", () => {
        const dir = tmpdir("bili-3464-fresh-");
        try {
            const dbPath = path.join(dir, "index.db");
            UnifiedStore.open(dbPath).close();
            const db = openSqliteDatabase(dbPath).db;
            const version = (db.prepare("PRAGMA user_version").get() as unknown as Record<string, number>)["user_version"];
            assert.equal(version, STORAGE_SCHEMA_VERSION);
            const cols = (db.prepare("PRAGMA table_info(messages)").all() as unknown as { name?: unknown }[])
                .map((c) => (typeof c?.name === "string" ? c.name : ""));
            assert.ok(cols.includes("host_id"), cols.join(","));
            assert.ok(cols.includes("host_slot"), cols.join(","));
            const indexes = (db.prepare("PRAGMA index_list(messages)").all() as unknown as { name?: unknown }[])
                .map((i) => (typeof i?.name === "string" ? i.name : ""));
            assert.ok(indexes.includes("idx_messages_host"), indexes.join(","));
            db.close();
        } finally {
            rmBestEffort(dir);
        }
    });

    test("v5 database migrates additively to v6", () => {
        const v5Ddl = STORAGE_DDL_V1_FOR_TESTS
            .replace(/^\s*host_id\s+TEXT,$/m, "")
            .replace(/^\s*host_slot\s+INTEGER,$/m, "")
            .replace(/^-- #3464 \(R1\)[\s\S]*?CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_host[^\n]*\n/m, "");
        assert.ok(!v5Ddl.includes("host_id"), "synthesized v5 DDL must not carry the v6 columns");
        const dir = tmpdir("bili-3464-migrate-");
        try {
            const dbPath = path.join(dir, "index.db");
            const raw = openSqliteDatabase(dbPath).db;
            raw.exec(v5Ddl);
            raw.exec("PRAGMA user_version = 5");
            raw.close();
            UnifiedStore.open(dbPath).close();
            const db = openSqliteDatabase(dbPath).db;
            assert.equal(
                (db.prepare("PRAGMA user_version").get() as unknown as Record<string, number>)["user_version"],
                STORAGE_SCHEMA_VERSION,
            );
            const cols = (db.prepare("PRAGMA table_info(messages)").all() as unknown as { name?: unknown }[])
                .map((c) => (typeof c?.name === "string" ? c.name : ""));
            assert.ok(cols.includes("host_id"));
            assert.ok(cols.includes("host_slot"));
            const indexes = (db.prepare("PRAGMA index_list(messages)").all() as unknown as { name?: unknown }[])
                .map((i) => (typeof i?.name === "string" ? i.name : ""));
            assert.ok(indexes.includes("idx_messages_host"));
            // existing rows keep working: a NULL-host row inserts fine
            db.exec("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES ('h', 1, 1, 'sha256', x'00')");
            db.exec("INSERT INTO sessions (session_id, namespace, created_at, updated_at) VALUES ('s', 'proxy', 1, 1)");
            db.exec("INSERT INTO messages (session_id, seq, msg_id, role, kind, content_hash) VALUES ('s', 0, 'm', 'user', 'message', 'h')");
            db.close();
        } finally {
            rmBestEffort(dir);
        }
    });
});

describe("planIngest host-keyed dedup (#3464 acceptance 1 & 2)", () => {
    test("drifted resend under the same host id yields ONE row, fresher bytes win, position kept", () => {
        const snapCore = msg("cs", "user", "original bytes", { wireIndex: 0 });
        const tailCoreA = msg("ctA", "user", "DRIFTED bytes after marker strip", { wireIndex: 0 });
        const tailCoreB = msg("ctB", "assistant", "next turn", { wireIndex: 1 });
        const legacy = mkLegacy("twins", [tailCoreA, tailCoreB], {
            lastMessagesHostIds: ["H1", "H2"],
            pluginSnapshot: [snapCore],
            pluginSnapshotHostIds: ["H1"],
        });
        const plan = planIngest(legacy);
        const h1Rows = plan.messages.filter((r) => r.hostId === "H1");
        assert.equal(h1Rows.length, 1, "same host id across legs must not mint a twin row");
        assert.equal(h1Rows[0]!.content, JSON.stringify(tailCoreA), "later leg carries fresher bytes");
        assert.equal(h1Rows[0]!.seq, 0, "first-seen position is kept");
        assert.equal(plan.messages.length, 2);
        assert.deepEqual(plan.messages.map((r) => r.hostSlot), [0, 0]);
    });

    test("unstamped lane keeps today's byte-keyed rows bit-for-bit", () => {
        const snapCore = msg("cs", "user", "original bytes", { wireIndex: 0 });
        const tailCoreA = msg("ctA", "user", "DRIFTED bytes after marker strip", { wireIndex: 0 });
        const legacy = mkLegacy("notwins", [tailCoreA], {
            pluginSnapshot: [snapCore],
        });
        const plan = planIngest(legacy);
        assert.equal(plan.messages.length, 2, "without host ids the twin stays (pre-R1 behavior)");
        assert.ok(plan.messages.every((r) => r.hostId === null && r.hostSlot === null));
    });

    test("one wire message projecting two cores keeps both rows via slots", () => {
        const c1 = msg("c1", "assistant", "text part", { wireIndex: 0 });
        const c2 = msg("c2", "assistant", "{\"rows\":1}", { wireIndex: 0, contentType: "tool_call", toolCallId: "t1", toolName: "q" });
        const legacy = mkLegacy("slots", [c1, c2], { lastMessagesHostIds: ["HP", "HP"] });
        const plan = planIngest(legacy);
        assert.equal(plan.messages.length, 2);
        assert.deepEqual(plan.messages.map((r) => r.hostSlot).sort(), [0, 1]);
        assert.ok(plan.messages.every((r) => r.hostId === "HP"));
    });

    test("fork mapping: a stamped row carries its bili ref (acceptance 3)", () => {
        const c1 = msg("c1", "user", "hello", { wireIndex: 0 });
        const c2 = msg("c2", "assistant", "world", { wireIndex: 1 });
        const legacy = mkLegacy("refs", [c1, c2], {
            lastMessagesHostIds: ["HA", "HB"],
            byRaw: { c1: "m00001", c2: "m00002" },
        });
        const plan = planIngest(legacy);
        const ra = plan.messages.find((r) => r.hostId === "HA")!;
        const rb = plan.messages.find((r) => r.hostId === "HB")!;
        assert.equal(ra.ref, "m00001");
        assert.equal(rb.ref, "m00002");
    });
});

describe("store: host-key seq continuity and in-place refresh (#3464)", () => {
    function openStore(): { dir: string; store: UnifiedStore } {
        const dir = tmpdir("bili-3464-store-");
        return { dir, store: UnifiedStore.open(path.join(dir, "index.db")) };
    }

    test("byte drift re-ingest reuses the host-keyed seq and refreshes content", () => {
        const { dir, store } = openStore();
        try {
            const m0 = msg("m0", "user", "first", { wireIndex: 0 });
            const m1v1 = msg("m1v1", "assistant", "second original", { wireIndex: 1 });
            store.ingestSession(planIngest(mkLegacy("cont", [m0, m1v1], {
                lastMessagesHostIds: ["H0", "H1"],
            })));
            const first = store.getMessages("cont");
            assert.equal(first.length, 2);
            const h1Seq = first.find((r) => r.hostId === "H1")!.seq;

            // same turn resends with drifted bytes (marker strip), same host id
            const m1v2 = msg("m1v2", "assistant", "second AFTER drift", { wireIndex: 1 });
            store.ingestSession(planIngest(mkLegacy("cont", [m0, m1v2], {
                lastMessagesHostIds: ["H0", "H1"],
            })), undefined, { completeLog: true });
            const second = store.getMessages("cont");
            assert.equal(second.length, 2, "drift must not mint a third row");
            const h1 = second.find((r) => r.hostId === "H1")!;
            assert.equal(h1.seq, h1Seq, "host-key continuity: seq survives byte drift");
            assert.equal(h1.contentHash, sha256Hex(JSON.stringify(m1v2)));
            const h0 = second.find((r) => r.hostId === "H0")!;
            assert.equal(h0.msgId, "m0");
        } finally {
            rmBestEffort(dir);
        }
    });
});

describe("reconcile Pass -1: exact host-id set algebra (#3464)", () => {
    function anchorOf(m: CoreMessage, h?: string): FoldAnchor {
        const a: FoldAnchor = { n: normalizedIdentity(m), r: m.role, b: m.text?.length ?? 0, ...(h !== undefined ? { h } : {}) };
        if (m.toolCallId) {
            a.t = m.toolCallId;
            a.m = normalizedIdentityNoToolCallId(m);
        }
        return a;
    }

    test("vanished covered id reappears under the same host id with alien bytes ⇒ claimed by host id", () => {
        const u1 = msg("u1", "user", "first turn");
        const u2 = msg("u2", "user", "please analyze module 2");
        const u3 = msg("u3", "user", "final turn");
        const anchors = { u1: anchorOf(u1, "H1"), u2: anchorOf(u2, "H2"), u3: anchorOf(u3, "H3") };
        // churned: new id AND unrelated words — every byte-based pass misses it
        const churned = msg("u2-new", "user", "completely unrelated wording here");
        const inbound = [u1, churned, u3];
        const plan = planReconciliation(["u1", "u2", "u3"], anchors, inbound, new Set(["u1", "u2", "u3"]), undefined, ["H1", "H2", "H3"]);
        assert.deepEqual(plan.claims.get("u2"), ["u2-new"]);
        assert.equal(plan.byHost, 1);
        assert.equal(plan.unmatched.length, 0);
    });

    test("role guard rejects a cross-role claim on the same host id", () => {
        const u2 = msg("u2", "user", "please analyze module 2");
        const anchors = { u2: anchorOf(u2, "H2") };
        const wrongRole = msg("u2-new", "assistant", "completely unrelated wording");
        const plan = planReconciliation(["u2"], anchors, [wrongRole], new Set(["u2"]), undefined, ["H2"]);
        assert.equal(plan.byHost, 0);
        assert.equal(plan.claims.size, 0);
        assert.deepEqual(plan.unmatched, ["u2"]);
    });

    test("multi-core group pairs k-th to k-th within the shared host id", () => {
        const x0 = msg("x0", "user", "stable head");
        const o1 = msg("o1", "user", "alpha words");
        const o2 = msg("o2", "user", "beta words");
        const x9 = msg("x9", "user", "stable tail");
        const n1 = msg("n1", "user", "alien alpha");
        const n2 = msg("n2", "user", "alien beta");
        const inbound = [x0, n1, n2, x9];
        const covered = new Set(["o1", "o2"]);
        const plan = planReconciliation(
            ["x0", "o1", "o2", "x9"],
            { x0: anchorOf(x0), o1: anchorOf(o1, "HP"), o2: anchorOf(o2, "HP"), x9: anchorOf(x9) },
            inbound,
            covered,
            undefined,
            [null, "HP", "HP", null],
        );
        assert.deepEqual(plan.claims.get("o1"), ["n1"]);
        assert.deepEqual(plan.claims.get("o2"), ["n2"]);
        assert.equal(plan.byHost, 2);
    });

    test("unstamped lane: no host ids ⇒ Pass -1 inert, byte passes unchanged", () => {
        const u1 = msg("u1", "user", "first turn");
        const u2 = msg("u2", "user", "please analyze module 2");
        const u3 = msg("u3", "user", "final turn");
        const anchors = { u1: anchorOf(u1), u2: anchorOf(u2), u3: anchorOf(u3) };
        const churnedWs = msg("u2-new", "user", "please analyze  module 2\r\n");
        const inbound = [u1, churnedWs, u3];
        const without = planReconciliation(["u1", "u2", "u3"], anchors, inbound, new Set(["u1", "u2", "u3"]));
        const withNulls = planReconciliation(["u1", "u2", "u3"], anchors, inbound, new Set(["u1", "u2", "u3"]), undefined, ["H1", "H2", "H3"]);
        assert.equal(without.byHost, 0);
        assert.deepEqual(without.claims.get("u2"), withNulls.claims.get("u2"), "stamped-lane claim must not change what the byte passes already claim");
        assert.equal(withNulls.byHost, 0, "whitespace churn is claimed positionally, not by host id — counters stay honest");
    });

    test("anchor.h persists across passes and survives a later unstamped request", () => {
        const originals = Array.from({ length: 10 }, (_, i) => msg(`a${i}`, "user", `stable context words ${i}`));
        const allIds = originals.map((m) => m.id!);
        const hostIds = originals.map((_, i) => `H${i}`);
        const session: Session = {
            state: { blocks: [{ active: true, effectiveMessageIds: allIds, directMessageIds: allIds }] },
            metadata: {},
        } as unknown as Session;
        const opts = (extra?: Partial<ReconcileOptions>): ReconcileOptions & { mode?: string } =>
            ({ mode: "repair", sessionId: "s1", log: () => {}, ...extra });

        reconcileFoldCoverage(session, originals, opts({ hostIds }));
        const anchorMeta = session.metadata["foldAnchors"] as Record<string, FoldAnchor>;
        assert.equal(anchorMeta["a4"].h, "H4", "first stamped pass seeds anchor.h");

        const churned = originals.map((m, i) => (i === 4 ? msg("a4-new", "user", "totally different words four") : m));
        const result = reconcileFoldCoverage(session, churned, opts({ hostIds }));
        assert.equal(result.kind, "reanchored");
        assert.equal(result.byHost, 1, "Pass -1 claims the drifted message by host id");
        const rewritten = allIds.map((id, i) => (i === 4 ? "a4-new" : id));
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, rewritten);

        // plugin stops stamping mid-conversation: degrade to heuristic passes, never worse
        const wsChurn = originals.map((m, i) => (i === 5 ? msg("a5-new", "user", "stable context  words 5\r\n") : m));
        const degraded = reconcileFoldCoverage(session, wsChurn, opts());
        assert.equal(degraded.byHost, 0);
        assert.equal(degraded.kind, "reanchored", "positional layer still heals unstamped whitespace churn");
    });
});
