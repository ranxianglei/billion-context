/**
 * Egress serve-from-log byte identity (seg 4a, proposal discussions/7398,
 * #6785 perf work): rebuildOutboundFromLog must produce EXACTLY the bytes
 * the legacy chain (systemToUser → coreToOpenai → hardenOpenaiToolCallArguments
 * → hardenOpenaiAssistantContent) produces for the same messages — that is
 * the claim the shadow comparison
 * in prepare-openai measures, and the precondition for any future swap.
 * Also pins the degrade directions (#3617): corrupted/empty row bytes →
 * null (caller keeps the legacy path), never a partial rebuild.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isRenderedSummaryMessage } from "acp-kernel";
import { coreToOpenai, type BiliMessage } from "acp-kernel/wire";
import { hardenOpenaiAssistantContent, hardenOpenaiToolCallArguments, systemToUser } from "../src/util.ts";
import { egressAppendTurn, egressStateAt, egressStateView } from "../src/storage/egress-state.ts";
import { recordEgressTurn, type EgressOpLogStore } from "../src/storage/egress-record.ts";
import { rebuildCoreFromLog, rebuildOutboundFromLog } from "../src/storage/egress-serve.ts";
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
    store: EgressOpLogStore;
    dir: string;
}

function open(): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-serve-"));
    const { db } = openSqliteDatabase(path.join(dir, "index.db"));
    migrateSchema(db);
    const store = {
        egressAppendTurn: (sid: string, ops: Parameters<typeof egressAppendTurn>[2], baseSeq: number, nowMs: number) => egressAppendTurn(db, sid, ops, nowMs, { baseSeq }),
        egressStateView: (sid: string) => egressStateView(db, sid),
 
        egressStateViewAt: (sid: string, seq: number) => egressStateAt(db, sid, seq),
        egressStateMaxSeq: (sid: string) => (db.prepare(`SELECT COALESCE(MAX(op_seq), 0) AS mx FROM egress_flow WHERE session_id = ?`).get(sid) as { mx: number }).mx,
        egressStateTruncateAfter: (sid: string, seq: number) => {
            const a = db.prepare(`DELETE FROM egress_state WHERE session_id = ? AND op_seq > ?`).run(sid, seq);
            const b = db.prepare(`DELETE FROM egress_flow WHERE session_id = ? AND op_seq > ?`).run(sid, seq);
            return Number(a.changes) + Number(b.changes);
        },
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
    const argsHardened = hardenOpenaiToolCallArguments(coreToOpenai(systemToUser(msgs, (m) => isRenderedSummaryMessage(m))));
    return hardenOpenaiAssistantContent(argsHardened.messages);
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

test("degrade #1: corrupted row bytes → null (whole turn stays legacy)", () => {
    const H = open();
    try {
        const S = "sess-s3";
        const msgs: BiliMessage[] = [M("a", "hello"), M("b", "world", "assistant")];
        const view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        const corrupted = view.map((r) => r.msgid === "a" ? { ...r, bytes: "not-json{{" } : r);
        assert.equal(rebuildOutboundFromLog(corrupted), null, "any corrupt row nulls the whole rebuild");
    } finally {
        close(H);
    }
});

test("degrade #2: empty row bytes / bad role → null", () => {
    const H = open();
    try {
        const S = "sess-s4";
        const msgs: BiliMessage[] = [M("a", "hello")];
        const view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        const empty = view.map((r) => r.msgid === "a" ? { ...r, bytes: "" } : r);
        assert.equal(rebuildOutboundFromLog(empty), null, "an empty-bytes row is unrebuildable");
        const badRole = view.map((r) => r.msgid === "a" ? { ...r, bytes: JSON.stringify({ id: "a", role: "weird", contentType: "text", text: "x" }) } : r);
        assert.equal(rebuildCoreFromLog(badRole), null, "a role outside the core whitelist is unrebuildable");
        void S;
    } finally {
        close(H);
    }
});

test("byte identity: tool rows rebuild (the CAS body carries the sidecars)", () => {
    const H = open();
    try {
        const S = "sess-s5";
        const callMsg = { id: "t0", role: "assistant", contentType: "tool-call", text: "\"{\\\"q\\\":1}\"", toolCallId: "call_1", toolName: "bash" } as BiliMessage;
        const toolMsg = { id: "t1", role: "tool", contentType: "text", text: "result", toolCallId: "call_1", toolName: "bash" } as BiliMessage;
        const msgs: BiliMessage[] = [M("a", "hello"), callMsg, toolMsg, M("b", "after", "assistant")];
        const view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        const reb = rebuildOutboundFromLog(view);
        assert.ok(reb !== null, "tool rows rebuild — the recorded CAS bytes are the full core message (toolCallId/toolName included)");
        assert.equal(JSON.stringify(reb!.elements), JSON.stringify(legacyChain(msgs)), "tool-heavy conversation is byte-identical to the legacy chain");
    } finally {
        close(H);
    }
});

test("byte identity: empty tool-call arguments harden identically (#5595)", () => {
    const H = open();
    try {
        const S = "sess-s7";
        const emptyCall = { id: "t0", role: "assistant", contentType: "tool-call", text: "", toolCallId: "call_empty", toolName: "bash" } as BiliMessage;
        const toolMsg = { id: "t1", role: "tool", contentType: "text", text: "result", toolCallId: "call_empty", toolName: "bash" } as BiliMessage;
        const msgs: BiliMessage[] = [M("a", "hello"), emptyCall, toolMsg, M("b", "after", "assistant")];
        const view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        const reb = rebuildOutboundFromLog(view);
        assert.ok(reb !== null, "empty-args tool rows rebuild");
        assert.equal(JSON.stringify(reb!.elements), JSON.stringify(legacyChain(msgs)), "empty-args conversation is byte-identical to the legacy chain (both hardened)");
        const served = JSON.stringify(reb!.elements);
        assert.ok(served.includes("_bili"), "the served arguments carry the placeholder, not an empty string");
        assert.ok(!served.includes('"arguments":""'), "no empty arguments survive to the served elements");
    } finally {
        close(H);
    }
});

test("byte identity survives compaction: fold shape → base row → still identical", () => {
    const H = open();
    try {
        const S = "sess-s6";
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
