/**
 * Egress serve-from-log byte identity (seg 4a, proposal discussions/7398,
 * #6785 perf work): rebuildOutboundFromLog must produce EXACTLY the bytes
 * the legacy chain (systemToUser → coreToOpenai → hardenOpenaiAssistantContent)
 * produces for the same messages — that is the claim the shadow comparison
 * in prepare-openai measures, and the precondition for any future swap.
 * Also pins the degrade directions (#3617): missing CAS body / no casRef →
 * null (caller keeps the legacy path), never a partial rebuild.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isRenderedSummaryMessage } from "acp-kernel";
import { coreToOpenai, type BiliMessage } from "acp-kernel/wire";
import { hardenOpenaiAssistantContent, systemToUser } from "../src/util.ts";
import { egressStateAppend, egressStateCompact, egressStateView } from "../src/storage/egress-state.ts";
import { recordEgressTurn, type EgressOpLogStore } from "../src/storage/egress-record.ts";
import { rebuildOutboundFromLog, type EgressContentStore } from "../src/storage/egress-serve.ts";
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
    cas: Map<string, string>;
    store: EgressOpLogStore & EgressContentStore;
    dir: string;
}

function open(): Harness {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-serve-"));
    const { db } = openSqliteDatabase(path.join(dir, "index.db"));
    migrateSchema(db);
    const cas = new Map<string, string>();
    const store = {
        egressStateAppendOps: (sid: string, ops: Parameters<typeof egressStateAppend>[2], nowMs: number) => egressStateAppend(db, sid, ops, nowMs),
        egressStateView: (sid: string) => egressStateView(db, sid),
        egressStateCompactView: (sid: string, view: Parameters<typeof egressStateCompact>[2], nowMs: number) => egressStateCompact(db, sid, view, nowMs),
        egressPutContent: (t: string) => {
            const h = createHash("sha256").update(t, "utf8").digest("hex");
            if (!cas.has(h)) cas.set(h, t);
            return h;
        },
        egressGetContent: (h: string) => cas.get(h) ?? null,
    };
    return { db, cas, store, dir };
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
        const reb = rebuildOutboundFromLog(view, H.store);
        assert.ok(reb !== null);
        assert.equal(JSON.stringify(reb!.elements), JSON.stringify(legacyChain(msgs)), "rebuilt elements are byte-identical to the legacy chain");
        // steady turn: tail append keeps identity on the replayed (table) view
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: view, conversation: [...msgs, M("d", "fourth", "assistant")], systemText: "SYS", nowMs: 2000 });
        const fromTable = egressStateView(H.db, S);
        const reb2 = rebuildOutboundFromLog(fromTable, H.store);
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
        const reb = rebuildOutboundFromLog(view, H.store);
        assert.ok(reb !== null);
        assert.equal(JSON.stringify(reb!.elements), JSON.stringify(legacyChain(msgs)), "summary re-voicing is byte-identical");
    } finally {
        close(H);
    }
});

test("degrade #1: a missing CAS body → null (whole turn stays legacy)", () => {
    const H = open();
    try {
        const S = "sess-s3";
        const msgs: BiliMessage[] = [M("a", "hello"), M("b", "world", "assistant")];
        const view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: msgs, systemText: undefined, nowMs: 1000 });
        const victim = view.find((r) => r.msgid === "a")!;
        H.cas.delete(victim.casRef!);
        assert.equal(rebuildOutboundFromLog(view, H.store), null, "any missing body nulls the whole rebuild");
    } finally {
        close(H);
    }
});

test("degrade #2: rows recorded without CAS (pre-seg-4) → null", () => {
    const H = open();
    try {
        const S = "sess-s4";
        const noCas: EgressOpLogStore = {
            egressStateAppendOps: H.store.egressStateAppendOps,
            egressStateView: H.store.egressStateView,
            egressStateCompactView: H.store.egressStateCompactView,
        };
        const view = recordEgressTurn({ store: noCas, sessionId: S, prev: undefined, conversation: [M("a", "hello")], systemText: undefined, nowMs: 1000 });
        assert.ok(view.every((r) => r.casRef === undefined), "no CAS seam → no casRef rows");
        assert.equal(rebuildOutboundFromLog(view, H.store), null, "casRef-less rows are unrebuildable");
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
        const reb = rebuildOutboundFromLog(view, H.store);
        assert.ok(reb !== null, "tool rows rebuild — the recorded CAS bytes are the full core message (toolCallId/toolName included)");
        assert.equal(JSON.stringify(reb!.elements), JSON.stringify(legacyChain(msgs)), "tool-heavy conversation is byte-identical to the legacy chain");
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
        const reb = rebuildOutboundFromLog(fromTable, H.store);
        assert.ok(reb !== null);
        assert.equal(JSON.stringify(reb!.elements), JSON.stringify(legacyChain(folded)), "post-compaction rebuild is byte-identical");
    } finally {
        close(H);
    }
});
