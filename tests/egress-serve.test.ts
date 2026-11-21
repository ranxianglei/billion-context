/**
 * Egress serve-from-log byte identity (seg 4a, proposal discussions/7398,
 * #6785 perf work; #7439 ruling 1: self-contained bytes): rebuildOutboundFromLog
 * must produce EXACTLY the bytes the legacy chain (systemToUser → coreToOpenai
 * → hardenOpenaiAssistantContent) produces for the same messages — that is the
 * claim the shadow comparison in prepare-openai measures, and the precondition
 * for any future swap. #7439 ruling 1: the rows carry the message BYTES inline
 * (no content CAS), so the rebuild reads them straight from the view.
 * Also pins the degrade directions (#3617): empty/missing bytes / non-JSON
 * bytes / out-of-scope row → null (caller keeps the legacy path), never a
 * partial rebuild.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isRenderedSummaryMessage } from "acp-kernel";
import { coreToOpenai, type BiliMessage } from "acp-kernel/wire";
import { hardenOpenaiAssistantContent, systemToUser } from "../src/util.ts";
import { egressStateAppend, egressStateAt, egressStateCompact, egressStateView, egressFlowMaxSeq } from "../src/storage/egress-state.ts";
import { recordEgressTurn, type EgressOpLogStore } from "../src/storage/egress-record.ts";
import { rebuildOutboundFromLog, rebuildOutboundWithLadder, type EgressLadderStore } from "../src/storage/egress-serve.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-serve-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

interface Harness {
    db: ReturnType<typeof openSqliteDatabase>["db"];
    store: EgressOpLogStore & EgressLadderStore;
    dir: string;
}

function open(): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-serve-"));
    const { db } = openSqliteDatabase(path.join(dir, "index.db"));
    migrateSchema(db);
    const store: EgressOpLogStore & EgressLadderStore = {
        egressStateAppendOps: (sid: string, ops: Parameters<typeof egressStateAppend>[2], nowMs: number) => egressStateAppend(db, sid, ops, nowMs),
        egressStateView: (sid: string) => egressStateView(db, sid),
        egressStateViewAt: (sid: string, logSeq: number) => egressStateAt(db, sid, logSeq),
        egressFlowMaxSeq: (sid: string) => egressFlowMaxSeq(db, sid),
        egressStateCompactView: (sid: string, view: Parameters<typeof egressStateCompact>[2], nowMs: number) => egressStateCompact(db, sid, view, nowMs),
    };
    return { db, store, dir };
}

function close(H: Harness): void {
    H.db.close();
    fs.rmSync(H.dir, { recursive: true, force: true });
}

const M = (id: string, text: string, role: "user" | "assistant" = "user"): BiliMessage =>
    ({ id, role, contentType: "text", text } as BiliMessage);

function legacyChain(msgs: BiliMessage[]): unknown {
    return hardenOpenaiAssistantContent(coreToOpenai(systemToUser(msgs, (m) => isRenderedSummaryMessage(m))));
}

test("byte identity: plain text conversation rebuilds EXACTLY the legacy elements", () => {
    const H = open();
    try {
        const S = "sess-s1";
        const msgs: BiliMessage[] = [M("a", "hello"), M("b", "world", "assistant"), M("c", "third")];
        let view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: "SYS", nowMs: 1000 });
        const reb = rebuildOutboundFromLog(view);
        assert.ok(reb !== null);
        assert.equal(JSON.stringify(reb!.elements), JSON.stringify(legacyChain(msgs)), "rebuilt elements are byte-identical to the legacy chain");
        // steady turn: tail append keeps identity on the replayed (table) view
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: view, conversation: [...msgs, M("d", "fourth", "assistant")], systemText: "SYS", nowMs: 2000 });
        const fromTable = egressStateView(H.db, S);
        const reb2 = rebuildOutboundFromLog(fromTable);
        assert.ok(reb2 !== null);
        assert.equal(JSON.stringify(reb2!.elements), JSON.stringify(legacyChain([...msgs, M("d", "fourth", "assistant")])), "table-replayed view stays byte-identical");
    } finally {
        close(H);
    }
});

test("byte identity: acp_summary rows re-voice to user exactly like the legacy chain", () => {
    const H = open();
    try {
        const S = "sess-s2";
        const msgs: BiliMessage[] = [M("a", "hello"), { id: "acp_summary_1", role: "system", contentType: "text", text: "<summary>...</summary>" } as BiliMessage, M("c", "third")];
        const view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        const reb = rebuildOutboundFromLog(view);
        assert.ok(reb !== null);
        assert.equal(JSON.stringify(reb!.elements), JSON.stringify(legacyChain(msgs)), "summary re-voicing is byte-identical");
    } finally {
        close(H);
    }
});

test("degrade #1: a row with empty bytes → null (whole turn stays legacy)", () => {
    const H = open();
    try {
        const S = "sess-s3";
        const msgs: BiliMessage[] = [M("a", "hello"), M("b", "world", "assistant")];
        const view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        // #7439: the bytes are self-contained — a row whose bytes went empty
        // (pre-#7439 row, corruption) cannot be served.
        const victim = view.find((r) => r.msgid === "a")!;
        victim.bytes = "";
        assert.equal(rebuildOutboundFromLog(view), null, "any empty-bytes row nulls the whole rebuild");
    } finally {
        close(H);
    }
});

test("degrade #2: a row with non-JSON bytes → null", () => {
    const H = open();
    try {
        const S = "sess-s4";
        const msgs: BiliMessage[] = [M("a", "hello"), M("b", "world", "assistant")];
        const view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        const victim = view.find((r) => r.msgid === "a")!;
        victim.bytes = "not-json";
        assert.equal(rebuildOutboundFromLog(view), null, "a non-JSON byte payload nulls the whole rebuild");
    } finally {
        close(H);
    }
});

test("degrade #3: a row whose bytes are valid JSON but out-of-scope role → null", () => {
    const H = open();
    try {
        const S = "sess-s5";
        const msgs: BiliMessage[] = [M("a", "hello"), M("b", "world", "assistant")];
        const view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        const victim = view.find((r) => r.msgid === "a")!;
        victim.bytes = JSON.stringify({ id: "a", role: "bogus-role", text: "x" });
        assert.equal(rebuildOutboundFromLog(view), null, "an out-of-scope role nulls the whole rebuild");
    } finally {
        close(H);
    }
});

test("byte identity: tool rows rebuild (the row bytes carry the sidecars)", () => {
    const H = open();
    try {
        const S = "sess-s6";
        const callMsg = { id: "t0", role: "assistant", contentType: "tool-call", text: "\"{\\\"q\\\":1}\"", toolCallId: "call_1", toolName: "bash" } as BiliMessage;
        const toolMsg = { id: "t1", role: "tool", contentType: "text", text: "result", toolCallId: "call_1", toolName: "bash" } as BiliMessage;
        const msgs: BiliMessage[] = [M("a", "hello"), callMsg, toolMsg, M("b", "after", "assistant")];
        const view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        const reb = rebuildOutboundFromLog(view);
        assert.ok(reb !== null, "tool rows rebuild — the recorded bytes are the full core message (toolCallId/toolName included)");
        assert.equal(JSON.stringify(reb!.elements), JSON.stringify(legacyChain(msgs)), "tool-heavy conversation is byte-identical to the legacy chain");
    } finally {
        close(H);
    }
});

test("byte identity survives compaction: fold shape → base row → still identical", () => {
    const H = open();
    try {
        const S = "sess-s7";
        const five: BiliMessage[] = [M("a", "1"), M("b", "2", "assistant"), M("c", "3"), M("d", "4", "assistant"), M("e", "5")];
        let view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: five, systemText: undefined, nowMs: 1000 });
        const folded: BiliMessage[] = [M("a", "1"), { id: "acp_summary_9", role: "system", contentType: "text", text: "<summary>2..4</summary>" } as BiliMessage, M("e", "5")];
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: view, conversation: folded, systemText: undefined, nowMs: 2000 });
        const fromTable = egressStateView(H.db, S);
        assert.equal(fromTable.length, 3, "view is the folded shape (a + summary + e)");
        const reb = rebuildOutboundFromLog(fromTable);
        assert.ok(reb !== null);
        assert.equal(JSON.stringify(reb!.elements), JSON.stringify(legacyChain(folded)), "post-compaction rebuild is byte-identical");
    } finally {
        close(H);
    }
});

test("the view rows are self-contained: every non-system row carries its bytes inline", () => {
    const H = open();
    try {
        const S = "sess-s8";
        const msgs: BiliMessage[] = [M("a", "hello"), M("b", "world", "assistant")];
        const view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: "SYS", nowMs: 1000 });
        for (const r of view) {
            if (r.type === "system") continue;
            assert.equal(typeof r.bytes, "string");
            assert.ok(r.bytes.length > 0, `row ${r.msgid} carries inline bytes`);
            // the bytes are the FINAL core JSON — they round-trip to the message
            const parsed = JSON.parse(r.bytes) as { id: string; role: string };
            assert.equal(parsed.id, r.msgid, "the inline bytes carry the message id");
            assert.equal(parsed.role, r.role, "the inline bytes carry the message role");
        }
    } finally {
        close(H);
    }
});

// #7439 ruling 5: the degradation ladder. The current point is served first;
// a corrupt point walks back to the nearest healthy flow point; a fully
// unreadable flow returns null (session recovery — NEVER client bytes).

test("ladder #1: a healthy current point is served as-is (logSeq = maxSeq)", () => {
    const H = open();
    try {
        const S = "sess-l1";
        const msgs: BiliMessage[] = [M("a", "hello"), M("b", "world", "assistant")];
        recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        const maxSeq = egressFlowMaxSeq(H.db, S);
        const ladder = rebuildOutboundWithLadder(H.store, S);
        assert.ok(ladder !== null, "a healthy flow rebuilds");
        assert.equal(ladder!.logSeq, maxSeq, "served from the current point");
        assert.equal(ladder!.rows, 2, "the current view has 2 rows");
        assert.equal(JSON.stringify(ladder!.elements), JSON.stringify(legacyChain(msgs)), "the served elements are byte-identical");
    } finally {
        close(H);
    }
});

test("ladder #2: a corrupt current point walks back to the nearest healthy point", () => {
    const H = open();
    try {
        const S = "sess-l2";
        const turn1: BiliMessage[] = [M("a", "hello"), M("b", "world", "assistant")];
        recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: turn1, systemText: undefined, nowMs: 1000 });
        const turn2: BiliMessage[] = [...turn1, M("c", "third")];
        recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: turn2, systemText: undefined, nowMs: 2000 });
        // corrupt the LATEST I row in the STATE table (the current point) —
        // its bytes went NULL (corruption). The current point now fails.
        H.db.prepare("UPDATE egress_state SET bytes = NULL WHERE session_id = ? AND row_type = 'I' AND log_seq = (SELECT MAX(log_seq) FROM egress_state WHERE session_id = ? AND row_type = 'I')").run(S, S);
        const ladder = rebuildOutboundWithLadder(H.store, S);
        assert.ok(ladder !== null, "the ladder finds a healthy point");
        // turn-1's point is logSeq 2 (I a = logSeq 1, I b = logSeq 2 — the
        // log_seq values start at 1, not 0). The corrupt current point is
        // logSeq 3 (I c), so the ladder walks back to logSeq 2.
        assert.equal(ladder!.logSeq, 2, "served from the turn-1 point (logSeq 2), not the corrupt current point (logSeq 3)");
        assert.equal(ladder!.rows, 2, "the turn-1 view has 2 rows (a + b)");
        assert.equal(JSON.stringify(ladder!.elements), JSON.stringify(legacyChain(turn1)), "the served elements are turn-1's bytes");
    } finally {
        close(H);
    }
});

test("ladder #3: a fully unreadable flow returns null (session recovery, never client bytes)", () => {
    const H = open();
    try {
        const S = "sess-l3";
        const msgs: BiliMessage[] = [M("a", "hello"), M("b", "world", "assistant")];
        recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        // corrupt EVERY I row in BOTH tables — no point rebuilds.
        H.db.prepare("UPDATE egress_state SET bytes = NULL WHERE session_id = ? AND row_type = 'I'").run(S);
        H.db.prepare("UPDATE egress_flow SET bytes = NULL WHERE session_id = ? AND row_type = 'I'").run(S);
        const ladder = rebuildOutboundWithLadder(H.store, S);
        assert.equal(ladder, null, "no healthy point → null (the caller does session recovery)");
    } finally {
        close(H);
    }
});
