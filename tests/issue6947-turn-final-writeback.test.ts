/**
 * #6947: the turn-final reply was captured (handoffReply) but only written to
 * session.metadata.handoffResponse — consumed solely by the `bili export` CLI.
 * The store row existed only after the NEXT request re-sent the conversation
 * (client re-send), so an idle session's last reply was missing from
 * index.db and the /__bili web UI kept showing the previous reply.
 *
 * Fix: handoffReply.save() appends the captured messages back into
 * session.lastMessages with codec-derivable ids (deriveMessageId + cluster
 * numbering), so the debounced turn-end save persists them immediately.
 * store.ts: when a full re-ingest joins a stored row whose ref is still NULL
 * (its ref was minted only once the client re-sent the tagged text), backfill
 * it — NULL only, never a rewrite, never the "BLOCKED" byRaw token.
 *
 * Invariants pinned here:
 *  1. write-back ids are byte-identical to what the production codec derives
 *     on re-send → the store join (`${msg_id}\u0000${identity}`) hits and the
 *     UNIQUE constraint keeps exactly one row;
 *  2. cluster numbering matches a full codec pass (repeated reply text);
 *  3. folded snapshots and stale guards are untouched by the write-back;
 *  4. ref backfill is idempotent and one-directional (NULL → minted only).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreMessage } from "acp-kernel";
import { deriveMessageId, openaiToCore } from "acp-kernel/wire";
import { createSession, type Session } from "../src/session.ts";
import { createHandoffReply } from "../src/server/handoff-response.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6947-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir is harmless */
    }
}

/** Production request codec: what the kernel derives for a client re-send. */
function convo(wireMsgs: Array<{ role: "user" | "assistant"; content: string }>): CoreMessage[] {
    return openaiToCore({ messages: wireMsgs }).msgs as unknown as CoreMessage[];
}

function capturedIds(session: Session): string[] {
    return (session.metadata.handoffResponse as { messages?: CoreMessage[] } | undefined)?.messages?.map((m) => m.id) ?? [];
}

function withReply(session: Session, text: string): void {
    session.stats.requests = 1;
    const reply = createHandoffReply(session);
    reply.append("0", "text", text);
    reply.save();
}

test("write-back appends the turn-final reply with a codec-derivable id", () => {
    const session = createSession("wb-basic");
    session.lastMessages = convo([{ role: "user", content: "hello" }]);
    withReply(session, "héllo world");
    const messages = session.lastMessages ?? [];
    assert.equal(messages.length, 2, "the reply must land in lastMessages, not only in metadata");
    const appended = messages[1];
    assert.ok(appended, "the reply row must exist");
    assert.equal(appended.role, "assistant");
    assert.equal(appended.contentType, "text");
    assert.equal(appended.text, "héllo world");
    assert.ok(appended.id.startsWith("h_"), `codec id shape, got ${appended.id}`);
    assert.equal(appended.id, deriveMessageId("assistant", "text", "héllo world", {}));
    // The export path is untouched: metadata still carries the capture's own ids.
    assert.deepEqual(capturedIds(session), ["reply_0"]);
});

test("a client re-send through the production codec derives the SAME ids (store join stability)", () => {
    const session = createSession("wb-resend");
    session.lastMessages = convo([{ role: "user", content: "hello" }]);
    withReply(session, "héllo world");
    const resent = convo([
        { role: "user", content: "hello" },
        { role: "assistant", content: "héllo world" },
    ]);
    assert.equal(resent[0].id, session.lastMessages![0].id, "user id stable across passes");
    assert.equal(resent[1].id, session.lastMessages![1].id, "reply id must match the re-send derivation");
});

test("cluster numbering matches a full codec pass when reply text repeats", () => {
    const wire = [
        { role: "user" as const, content: "ping" },
        { role: "assistant" as const, content: "pong" },
        { role: "user" as const, content: "ping" },
        { role: "assistant" as const, content: "pong" },
    ];
    const session = createSession("wb-cluster");
    session.lastMessages = convo(wire);
    const base = deriveMessageId("assistant", "text", "pong", {});
    assert.notEqual(session.lastMessages![1].id, session.lastMessages![3].id, "fixture sanity: codec clusters repeats");
    withReply(session, "pong");
    const appended = session.lastMessages![4];
    const expected = convo([...wire, { role: "assistant", content: "pong" }])[4];
    assert.equal(appended.id, expected.id, "third 'pong' must get the same cluster suffix the codec would mint");
    assert.notEqual(appended.id, base, "must not collide with the base (cluster 0) id");
});

test("tool calls write back with toolName/toolCallId preserved and id-derivable", () => {
    const session = createSession("wb-tool");
    session.lastMessages = convo([{ role: "user", content: "go" }]);
    session.stats.requests = 1;
    const reply = createHandoffReply(session);
    reply.append("0", "text", "looking");
    reply.tool("1", "search", "call_1", "{\"q\":1}");
    reply.save();
    const messages = session.lastMessages ?? [];
    assert.equal(messages.length, 3);
    const tool = messages[2];
    assert.equal(tool.contentType, "tool-call");
    assert.equal(tool.toolName, "search");
    assert.equal(tool.toolCallId, "call_1");
    assert.equal(tool.id, deriveMessageId("assistant", "tool-call", "{\"q\":1}", { toolCallId: "call_1", toolName: "search" }));
});

test("folded snapshot: metadata is written but lastMessages is not grown", () => {
    const session = createSession("wb-folded");
    const tail = convo([{ role: "user", content: "hello" }]);
    session.lastMessages = tail;
    session.lastMessagesFolded = true;
    withReply(session, "answer");
    assert.equal(session.lastMessages, tail, "folded view must stay untouched");
    assert.deepEqual(capturedIds(session), ["reply_0"], "metadata capture still lands for export");
});

test("stale guards (request advance / snapshot swap) suppress the write-back too", () => {
    for (const advance of [
        (session: Session) => {
            session.stats.requests++;
        },
        (session: Session) => {
            session.lastMessages = [{ id: "new", role: "user", contentType: "text", text: "new request" }] as CoreMessage[];
        },
    ]) {
        const session = createSession("wb-stale");
        session.lastMessages = convo([{ role: "user", content: "hello" }]);
        session.stats.requests = 1;
        const before = (session.lastMessages ?? []).length;
        const reply = createHandoffReply(session);
        reply.append("0", "text", "old answer");
        advance(session);
        reply.save();
        assert.equal((session.lastMessages ?? []).length, before, "no write-back for a stale response");
        assert.equal(session.metadata.handoffResponse, undefined);
    }
});

function mkLegacy(id: string, lastMessages: CoreMessage[], byRaw: Record<string, string>): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: false,
    } as LegacySessionLike;
}

function turnFinalPair(): { user: CoreMessage; reply: CoreMessage } {
    const session = createSession("wb-store-pair");
    session.lastMessages = convo([{ role: "user", content: "install it" }]);
    withReply(session, "done: installed");
    const user = session.lastMessages![0];
    const reply = session.lastMessages![1];
    return { user, reply };
}

test("store: turn-final row lands once, ref backfilled on the re-send ingest (NULL only)", () => {
    const dir = tmpdir("bili-6947-backfill-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const { user, reply } = turnFinalPair();
            // Turn-end save: the reply row lands; its ref is not minted yet.
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947", [user, reply], {}))), true);
            let rows = store.getMessages("s6947");
            assert.equal(rows.length, 2);
            const first = rows.find((r) => r.msgId === reply.id);
            assert.ok(first, "the turn-final row must exist after the turn-end save");
            assert.equal(first.ref, null);

            // Next request: the client re-sends the tagged reply; the ref is
            // minted. A full re-ingest joins the stored row and backfills.
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947", [user, reply], { [reply.id]: "m00002" }))), true);
            rows = store.getMessages("s6947");
            assert.equal(rows.length, 2, "re-send must not duplicate the turn-final row");
            const joined = rows.find((r) => r.msgId === reply.id);
            assert.ok(joined);
            assert.equal(joined.seq, first.seq, "seq stability (D4-1) across the join");
            assert.equal(joined.ref, "m00002", "minted ref backfilled into the NULL row");
            assert.equal(rows.find((r) => r.msgId === user.id)?.ref, null, "unminted rows stay untouched");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("store: backfill never rewrites an already-stored ref and never writes BLOCKED", () => {
    const dir = tmpdir("bili-6947-guard-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const { user, reply } = turnFinalPair();
            // Ref minted at insert time (the common flow).
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947g", [user, reply], { [reply.id]: "m00002" }))), true);
            // A later ingest with a different minted ref must NOT rewrite it.
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947g", [user, reply], { [reply.id]: "m00009" }))), true);
            let row = store.getMessages("s6947g").find((r) => r.msgId === reply.id);
            assert.equal(row?.ref, "m00002", "stored ref is frozen (index-time projection)");

            // BLOCKED is a byRaw-only token: it must not land in messages.ref.
            const session = createSession("wb-store-blocked");
            session.lastMessages = convo([{ role: "user", content: "install it" }]);
            withReply(session, "blocked reply");
            const u2 = session.lastMessages![0];
            const r2 = session.lastMessages![1];
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947b", [u2, r2], {}))), true);
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947b", [u2, r2], { [r2.id]: "BLOCKED" }))), true);
            row = store.getMessages("s6947b").find((r) => r.msgId === r2.id);
            assert.equal(row?.ref, null, "BLOCKED must stay out of messages.ref");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});
