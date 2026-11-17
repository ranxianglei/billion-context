/**
 * #6947 (direction C1 — persistence separated from the session identity
 * ledger): the turn-final reply was captured (handoffResponse) but only
 * written to the store when the NEXT request re-sent the conversation, so an
 * idle session's last reply never reached index.db and the /__bili web UI
 * kept showing the previous reply.
 *
 * Fix (direction C1): the reply is stashed as plan-ready rows in
 * `metadata.handoffReply` — OUTSIDE the messages table, on purpose:
 *
 *  - `session.lastMessages` is the single source of truth for the resident
 *    window (digest parity, web view, fork raw/ref check) and the reply's
 *    REF is minted by the kernel only when a request presents it; appending
 *    the reply there created a window where fork/snapshot saw a message
 *    with no ref and 409'd (the original #6953 regression).
 *  - the messages table's seq space is the ref-ledger substrate: on the
 *    first fold `persist.maybeRestampToLedger` aligns every live ref onto
 *    the store row's seq+1 (#4316), so a non-view row interleaved in the
 *    table would desync every post-fold ref (golden wire drift).
 *
 * metadata_json is persisted in BOTH the legacy file and the unified DB,
 * identical in both views ⇒ digest-equal — so the reply still lands
 * durably in the database for #6947's "anything reading the DB loses the
 * turn's final reply" concern, without touching the view, the ledger, or
 * any wire. A client re-send then persists the reply as a normal view row
 * (kernel-minted ref) exactly as before #6947.
 *
 * Invariants pinned here:
 *  1. lastMessages is NEVER touched by the write-back (fork invariant);
 *  2. stash ids are byte-identical to what the production codec derives on
 *     re-send (DB readers can dedup the stash against view rows by id);
 *  3. stash row identity equals the planner identity of the re-sent core
 *     (same join key, should readers ever join them);
 *  4. cluster numbering matches a full codec pass (repeated reply text);
 *  5. folded snapshots and stale guards suppress the stash too;
 *  6. the stash NEVER reaches the messages table: ingests of a session
 *     carrying the stash produce exactly the view's rows, refs included.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreMessage } from "acp-kernel";
import { canonicalToolArgs, deriveCanonicalMessageId, deriveMessageId, openaiToCore } from "acp-kernel/wire";
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

/** The stashed turn-final reply rows (direction C1) decoded back to cores —
 *  row.content is the exact planner serialization, so parsing recovers the
 *  core a re-send would present. */
function stashCores(session: Session): CoreMessage[] {
    const stash = session.metadata.handoffReply as { rows?: Array<{ msgId: string; content: string }> } | undefined;
    return (stash?.rows ?? []).map((r) => JSON.parse(r.content) as CoreMessage);
}

function stashMetadata(session: Session): Record<string, unknown> {
    return session.metadata.handoffReply === undefined ? {} : { handoffReply: session.metadata.handoffReply };
}

function withReply(session: Session, text: string): void {
    session.stats.requests = 1;
    const reply = createHandoffReply(session);
    reply.append("0", "text", text);
    reply.save();
}

test("turn-final reply is stashed for persistence WITHOUT touching lastMessages (fork invariant)", () => {
    const session = createSession("wb-basic");
    const tail = convo([{ role: "user", content: "hello" }]);
    session.lastMessages = tail;
    withReply(session, "héllo world");
    const messages = session.lastMessages ?? [];
    assert.equal(session.lastMessages, tail, "lastMessages must stay the exact resident window (invariant 1)");
    assert.equal(messages.length, 1, "the reply must NOT land in lastMessages — the view is the ledger's territory");
    const stashed = stashCores(session);
    assert.equal(stashed.length, 1, "the reply must be stashed for the DB");
    const row = stashed[0];
    assert.ok(row, "the stash row must exist");
    assert.equal(row.role, "assistant");
    assert.equal(row.contentType, "text");
    assert.equal(row.text, "héllo world");
    assert.ok(row.id.startsWith("h_"), `codec id shape, got ${row.id}`);
    assert.equal(row.id, deriveMessageId("assistant", "text", "héllo world", {}));
    // The export path is untouched: metadata still carries the capture's own ids.
    assert.deepEqual(capturedIds(session), ["reply_0"]);
});

test("a client re-send through the production codec derives the SAME ids (join stability)", () => {
    const session = createSession("wb-resend");
    session.lastMessages = convo([{ role: "user", content: "hello" }]);
    withReply(session, "héllo world");
    const resent = convo([
        { role: "user", content: "hello" },
        { role: "assistant", content: "héllo world" },
    ]);
    assert.equal(resent[0].id, session.lastMessages![0].id, "user id stable across passes");
    assert.equal(resent[1].id, stashCores(session)[0].id, "stash id must match the re-send derivation");
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
    const stashed = stashCores(session);
    const expected = convo([...wire, { role: "assistant", content: "pong" }])[4];
    assert.equal(stashed[0].id, expected.id, "third 'pong' must get the same cluster suffix the codec would mint");
    assert.notEqual(stashed[0].id, base, "must not collide with the base (cluster 0) id");
});

test("tool calls stash with toolName/toolCallId preserved and id-derivable", () => {
    const session = createSession("wb-tool");
    session.lastMessages = convo([{ role: "user", content: "go" }]);
    session.stats.requests = 1;
    const reply = createHandoffReply(session);
    reply.append("0", "text", "looking");
    reply.tool("1", "search", "call_1", "{\"q\":1}");
    reply.save();
    assert.equal((session.lastMessages ?? []).length, 1, "no push into lastMessages");
    const stashed = stashCores(session);
    assert.equal(stashed.length, 2);
    const tool = stashed.find((m) => m.contentType === "tool-call")!;
    assert.equal(tool.toolName, "search");
    assert.equal(tool.toolCallId, "call_1");
    // Canonical seed (#3642): toolCallId OUT of the id (transport plumbing),
    // args canonicalized. Legacy deriveMessageId (toolCallId slot filled,
    // raw args) would mint a DIFFERENT id than the re-send codec pass.
    // Pinned here so the exact-match property cannot regress to that shape.
    assert.equal(tool.id, deriveCanonicalMessageId("assistant", "tool-call", canonicalToolArgs("{\"q\":1}"), { toolName: "search" }));
});

test("a client re-send of a TOOL-CALL reply through the production codec derives the SAME ids (join stability)", () => {
    const session = createSession("wb-tool-resend");
    session.lastMessages = convo([{ role: "user", content: "go" }]);
    session.stats.requests = 1;
    const reply = createHandoffReply(session);
    reply.append("0", "text", "looking");
    reply.tool("1", "search", "call_1", " { \"q\" : 1 } ");
    reply.save();
    const stashed = stashCores(session);
    // The client re-sends the turn: assistant text + tool call + tool result.
    // The codec sees the args as the client stored them (byte-identical — the
    // client echoes what it received); canonicalToolArgs normalizes both sides.
    const resent = openaiToCore({ messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "looking", tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: " { \"q\" : 1 } " } }] },
        { role: "tool", tool_call_id: "call_1", content: "found it" },
    ] }).msgs as unknown as CoreMessage[];
    assert.equal(resent[0].id, session.lastMessages![0].id, "user id stable");
    assert.equal(resent[1].id, stashed[0].id, "reply text id must match the re-send derivation");
    assert.equal(resent[2].id, stashed[1].id, "tool-call id must match the re-send derivation (canonical join)");
});

/**
 * #6947 join polish: ids matching is only HALF of the join — the store key
 * is `${msg_id}\u0000${identity}` and identity covers EVERY stored field
 * (id/wireIndex stripped). The raw capture lacks the sidecars the client's
 * re-send codec stamps (openai `reasoningContent` on reasoning cores) and
 * keeps the streamed args verbatim while clients like pi re-serialize them
 * compact — so without restampForJoin a DB reader deduping the stash
 * against view rows would miss the match. The stash rows therefore carry
 * the same restamped bytes the re-send will present, and their identity
 * equals the planner identity of the re-sent cores.
 */
test("stash rows JOIN the client re-send by identity (openai lane: reasoning sidecar + compacted args)", () => {
    const argsRaw = '{ "command" : "echo hi" }'; // streamed verbatim (host JSON style)
    const session = createSession("wb-join");
    session.lastMessages = convo([{ role: "user", content: "go" }]);
    session.stats.requests = 1;
    const reply = createHandoffReply(session, () => true, "openai");
    reply.append("r", "reasoning", "let me think");
    reply.append("0", "text", "looking");
    reply.tool("1", "bash", "call_1", argsRaw);
    reply.save();
    assert.equal((session.lastMessages ?? []).length, 1, "lastMessages untouched");
    const stashed = stashCores(session);
    const reasoning = stashed.find((m) => m.contentType === "reasoning")!;
    assert.equal((reasoning as { reasoningContent?: string }).reasoningContent, "let me think", "openai reasoning cores must carry the codec's reasoningContent sidecar");
    const tool = stashed.find((m) => m.contentType === "tool-call")!;
    assert.equal(tool.text, '{"command":"echo hi"}', "tool-call args must be re-serialized the way clients (pi) re-send them: parse + JSON.stringify");

    // The re-send: pi re-sends the reasoning via the reasoning_content field
    // and the args as it re-serialized them (compact, order preserved).
    const resent = openaiToCore({ messages: [
        { role: "user", content: "go" },
        { role: "assistant", reasoning_content: "let me think", content: "looking", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "hi" },
    ] }).msgs as unknown as CoreMessage[];

    // DB-reader join key: (msgId, identity). The stash must present the SAME
    // key the planner derives for the re-sent cores — verified by planning a
    // session whose view IS the re-send (no stash involvement in the planner).
    const plan = planIngest({
        id: "sjoinplan",
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], messageRefs: { byRaw: { [resent[1].id]: "m00002" }, byRef: {} }, nextBlockId: 1, nextRunId: 1 },
        blockContents: new Map(),
        lastMessages: [convo([{ role: "user", content: "go" }])[0], resent[1], resent[2], resent[3]],
        lastMessagesFolded: false,
    } as unknown as LegacySessionLike);
    assert.ok(plan, "planner must accept the re-send view");
    for (const m of stashed) {
        const row = plan.messages.find((e) => e.msgId === m.id);
        assert.ok(row, `re-send view must contain a row for stash msgId ${m.id}`);
        const stashRow = (stashMetadata(session).handoffReply as { rows: { msgId: string; identity: string }[] }).rows.find((r) => r.msgId === m.id)!;
        assert.equal(row.identity, stashRow.identity, `stash identity === planner identity for ${m.contentType} (same join key)`);
    }
});

test("without the protocol hint the openai reasoning/tool-call join is NOT claimed (residual stays visible)", () => {
    const session = createSession("wb-join-noproto");
    session.lastMessages = convo([{ role: "user", content: "go" }]);
    session.stats.requests = 1;
    const reply = createHandoffReply(session); // no protocol → no restamp
    reply.append("r", "reasoning", "let me think");
    reply.tool("1", "bash", "call_1", '{ "command" : "echo hi" }');
    reply.save();
    const stashed = stashCores(session);
    const reasoning = stashed.find((m) => m.contentType === "reasoning")!;
    assert.equal((reasoning as { reasoningContent?: string }).reasoningContent, undefined, "no sidecar without the protocol hint");
    const tool = stashed.find((m) => m.contentType === "tool-call")!;
    assert.equal(tool.text, '{ "command" : "echo hi" }', "args stay verbatim without the protocol hint");
});

test("folded snapshot: neither stash nor lastMessages is touched", () => {
    const session = createSession("wb-folded");
    const tail = convo([{ role: "user", content: "hello" }]);
    session.lastMessages = tail;
    session.lastMessagesFolded = true;
    withReply(session, "answer");
    assert.equal(session.lastMessages, tail, "folded view must stay untouched");
    assert.equal(session.metadata.handoffReply, undefined, "a folded snapshot is a pruned view — no stash rows from it");
    assert.deepEqual(capturedIds(session), ["reply_0"], "metadata capture still lands for export");
});

test("stale guards (request advance / snapshot swap) suppress the stash too", () => {
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
        assert.equal((session.lastMessages ?? []).length, before, "no touch for a stale response");
        assert.equal(session.metadata.handoffResponse, undefined);
        assert.equal(session.metadata.handoffReply, undefined, "stale response must not stash rows either");
    }
});

function mkLegacy(id: string, lastMessages: CoreMessage[], byRaw: Record<string, string>, metadata: Record<string, unknown> = {}): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata,
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

function turnFinalPair(): { user: CoreMessage; reply: CoreMessage; metadata: Record<string, unknown> } {
    const session = createSession("wb-store-pair");
    session.lastMessages = convo([{ role: "user", content: "install it" }]);
    withReply(session, "done: installed");
    const user = session.lastMessages![0];
    const reply = stashCores(session)[0];
    return { user, reply, metadata: stashMetadata(session) };
}

/**
 * #6947 × #4316: the messages table's seq space is the ref-ledger substrate
 * (on the first fold, live refs are restamped onto row seq+1). The stash
 * must therefore NEVER materialize as a table row — a stray row would
 * desync every post-fold ref (golden wire drift). What lands in the DB is
 * `sessions.metadata_json.handoffReply`; the messages table stays exactly
 * the view.
 */
test("store: the stash never reaches the messages table; the view's rows are exactly the view", () => {
    const dir = tmpdir("bili-6947-table-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const { user, reply, metadata } = turnFinalPair();
            // Turn end: the session carries the stash in metadata; the
            // planner must ignore it — table rows == view rows == [user].
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947", [user], {}, metadata))), true);
            let rows = store.getMessages("s6947");
            assert.equal(rows.length, 1, `only the user row may exist (got ${rows.length}: ${JSON.stringify(rows.map((r) => [r.seq, r.msgId, r.ref ?? "null"]))})`);
            assert.equal(rows[0].msgId, user.id);
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("store: the re-send lands as a normal view row with the kernel-minted ref", () => {
    const dir = tmpdir("bili-6947-resend-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const { user, reply, metadata } = turnFinalPair();
            // Next request: the client re-sends the reply; it becomes a
            // normal view row with the kernel-minted ref — pre-#6947
            // behavior, no stash involvement.
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947r", [user, reply], { [reply.id]: "m00002" }, metadata))), true);
            const rows = store.getMessages("s6947r");
            assert.equal(rows.length, 2, `both view rows exist (got ${JSON.stringify(rows.map((r) => [r.seq, r.msgId, r.ref ?? "null"]))})`);
            assert.equal(rows.find((r) => r.msgId === reply.id)?.ref, "m00002", "kernel-minted ref lands at insert time");
            assert.equal(rows.find((r) => r.msgId === user.id)?.seq, 0, "view row seqs stay contiguous (ledger substrate)");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("store: ref backfill never rewrites a stored ref and never writes BLOCKED", () => {
    const dir = tmpdir("bili-6947-guard-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const session = createSession("wb-store-blocked");
            session.lastMessages = convo([{ role: "user", content: "install it" }]);
            withReply(session, "blocked reply");
            const u2 = session.lastMessages![0];
            const r2 = stashCores(session)[0];
            const md2 = stashMetadata(session);
            // Ref minted at insert time (the common flow).
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947g", [u2, r2], { [r2.id]: "m00002" }, md2))), true);
            // A later ingest presenting the same row under a BLOCKED token
            // (or any other ref) must NOT rewrite the stored projection:
            // the backfill only claims NULL refs (#6953 guard).
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947g", [u2, r2], { [r2.id]: "BLOCKED" }, md2))), true);
            const row = store.getMessages("s6947g").find((r) => r.msgId === r2.id)!;
            assert.equal(row.ref, "m00002", "stored ref is frozen (index-time projection); backfill never rewrites");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});
