/**
 * #6947 (direction C — persistence separated from the session identity
 * ledger): the turn-final reply was captured (handoffResponse) but only
 * written to the store when the NEXT request re-sent the conversation, so an
 * idle session's last reply never reached index.db and the /__bili web UI
 * kept showing the previous reply.
 *
 * Fix (direction C): handoffReply.save() must NOT append the reply to
 * session.lastMessages — that array is the single source of truth for the
 * resident window (digest parity, web view, fork raw/ref check), and the
 * reply's REF is minted by the kernel only when a request presents it.
 * Pushing the reply there created a window where fork/snapshot saw a
 * message with no ref and 409'd (the #6953 regression). Instead:
 *
 *  - the captured reply is stashed as plan-ready rows in
 *    metadata.handoffReply (persisted → both views digest-equal), with ids
 *    derived EXACTLY as the next codec pass derives them (SAME canonical
 *    seed the codecs feed deriveCanonicalMessageId, #3642, + cluster
 *    numbering);
 *  - the planners (ingest.ts) turn the stash into trailing NON-TAIL log
 *    rows — never tailSeqs — so the reconstructed view stays equal to the
 *    session file's lastMessages;
 *  - store.ts: the full path joins the re-send onto the stored row by
 *    msg_id+identity and backfills the NULL ref (#6953, NULL only, never
 *    BLOCKED); the delta path (this PR's join extension) joins a stored row
 *    ABOVE the trusted tip in place (keep seq, claim the NULL ref), so the
 *    #3133 fast path stays green across the turn-end → re-send boundary
 *    instead of paying a refused delta + O(n) full re-ingest per turn.
 *
 * Invariants pinned here:
 *  1. lastMessages is NEVER touched by the write-back (fork invariant);
 *  2. stash ids are byte-identical to what the production codec derives on
 *     re-send → the store join hits and the UNIQUE constraint keeps exactly
 *     one row;
 *  3. cluster numbering matches a full codec pass (repeated reply text);
 *  4. folded snapshots and stale guards suppress the stash too;
 *  5. ref backfill is idempotent and one-directional (NULL → minted only);
 *  6. the delta fast path stays green across turn-end stash + re-send join.
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
import { planIngest, planIngestDelta, type LegacySessionLike } from "../src/storage/ingest.ts";

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

/** The stashed turn-final reply rows (direction C) decoded back to cores —
 *  row.content is the exact planner serialization, so parsing recovers the
 *  core the store will see. */
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
    assert.equal(stashed.length, 1, "the reply must be stashed for the store");
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

test("a client re-send through the production codec derives the SAME ids (store join stability)", () => {
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
    // raw args) would mint a DIFFERENT id than the re-send codec pass — the
    // re-send then joins by (msg_id, identity) and the old row is retired,
    // costing a full re-ingest per tool call on every turn. Pinned here so
    // the exact-join property cannot regress to that shape.
    assert.equal(tool.id, deriveCanonicalMessageId("assistant", "tool-call", canonicalToolArgs("{\"q\":1}"), { toolName: "search" }));
});

test("a client re-send of a TOOL-CALL reply through the production codec derives the SAME ids (store join stability)", () => {
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
 * compact — so without restampForJoin the re-send lands a SECOND row for
 * the same logical message: tombstone churn + the content CAS storing the
 * reply bytes twice, on every reply of every turn of a long session.
 */
test("stash bytes JOIN the client re-send by identity (openai lane: reasoning sidecar + compacted args)", () => {
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

    const dir = tmpdir("bili-6947-join-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const user = session.lastMessages![0];
            // Turn-end save: the view is [user] ONLY; the stash rows land as
            // non-tail log rows (never tailSeqs), no refs minted yet.
            assert.equal(store.ingestSession(planIngest(mkLegacy("sjoin", [user], {}, stashMetadata(session)))), true);
            let rows = store.getMessages("sjoin");
            assert.equal(rows.length, 4, `user + 3 stash rows (got ${rows.length}: ${JSON.stringify(rows.map((r) => [r.seq, r.msgId, r.retiredAt ?? "live"]))})`);
            for (const m of stashed) {
                const row = rows.find((r) => r.msgId === m.id);
                assert.ok(row, `stash row for ${m.contentType} must exist after the turn-end save`);
                assert.equal(row.ref, null, "no ref until the re-send (invariant 2)");
            }
            // Next request: the client re-sends the whole turn. The reply
            // cores must JOIN the stash rows — no second rows, seq stable.
            assert.equal(store.ingestSession(planIngest(mkLegacy("sjoin", [...convo([{ role: "user", content: "go" }]), ...resent], { [resent[1].id]: "m00002" }, stashMetadata(session)))), true);
            rows = store.getMessages("sjoin");
            assert.equal(rows.length, 5, `the re-send must join, not duplicate (got ${rows.length} rows: ${JSON.stringify(rows.map((r) => [r.seq, r.msgId, r.retiredAt ?? "live"]))})`);
            for (const m of resent) {
                const storedRow = rows.find((r) => r.msgId === m.id);
                assert.ok(storedRow, `re-send core ${m.contentType} must share the stash row's id`);
            }
            const turnEndTool = rows.filter((r) => r.msgId === tool.id);
            assert.equal(turnEndTool.length, 1, "tool-call: exactly one live row after the join");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
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

test("store: turn-final row lands once, ref backfilled on the re-send ingest (NULL only)", () => {
    const dir = tmpdir("bili-6947-backfill-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const { user, reply, metadata } = turnFinalPair();
            // Turn-end save: the view is [user]; the stash row lands, its ref
            // is not minted yet, and it is NOT in tailSeqs (view parity).
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947", [user], {}, metadata))), true);
            let rows = store.getMessages("s6947");
            assert.equal(rows.length, 2, "user row + one stash row");
            const first = rows.find((r) => r.msgId === reply.id);
            assert.ok(first, "the turn-final row must exist after the turn-end save");
            assert.equal(first.ref, null);

            // Next request: the client re-sends the tagged reply; the ref is
            // minted. A full re-ingest joins the stored row and backfills.
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947", [user, reply], { [reply.id]: "m00002" }, metadata))), true);
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
            const { user, reply, metadata } = turnFinalPair();
            // Ref minted at insert time (the common flow).
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947g", [user, reply], { [reply.id]: "m00002" }, metadata))), true);
            // A later ingest with a different minted ref must NOT rewrite it.
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947g", [user, reply], { [reply.id]: "m00009" }, metadata))), true);
            let row = store.getMessages("s6947g").find((r) => r.msgId === reply.id);
            assert.equal(row?.ref, "m00002", "stored ref is frozen (index-time projection)");

            // BLOCKED is a byRaw-only token: it must not land in messages.ref.
            const session = createSession("wb-store-blocked");
            session.lastMessages = convo([{ role: "user", content: "install it" }]);
            withReply(session, "blocked reply");
            const u2 = session.lastMessages![0];
            const r2 = stashCores(session)[0];
            const md2 = stashMetadata(session);
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947b", [u2], {}, md2))), true);
            assert.equal(store.ingestSession(planIngest(mkLegacy("s6947b", [u2, r2], { [r2.id]: "BLOCKED" }, md2))), true);
            row = store.getMessages("s6947b").find((r) => r.msgId === r2.id);
            assert.equal(row?.ref, null, "BLOCKED must stay out of messages.ref");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

/**
 * #3133 × #6947: the delta fast path must stay green across the turn-end →
 * re-send boundary. Turn end is an equal-length raw delta whose only payload
 * is the stash (non-tail rows); the re-send then presents the reply as a
 * NORMAL tail message that joins the stored stash row in place (seq kept,
 * NULL ref claimed) instead of tripping the strictly-append guard into an
 * O(n) full re-ingest on every turn of every long session.
 */
test("store: delta fast path survives the turn-end stash save and the re-send join", () => {
    const dir = tmpdir("bili-6947-delta-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const session = createSession("wb-delta");
            const u1 = convo([{ role: "user", content: "install it" }])[0];
            session.lastMessages = [u1];
            withReply(session, "done: installed");
            const reply = stashCores(session)[0];
            const md = stashMetadata(session);

            // Request N (full path primes the watermark at the user row).
            assert.equal(store.ingestSession(planIngest(mkLegacy("sd", [u1], {}))), true);
            const boundary = store.probeIngestBoundary("sd", 0);
            assert.ok(boundary, "watermark probe must find the user row at seq 0");

            // Turn N end: equal-length raw delta, payload = the stash row.
            const turnEnd = planIngestDelta({ ...(mkLegacy("sd", [u1], {}, md) as object) } as LegacySessionLike, 0, [0], { msgId: boundary.msgId, contentHash: boundary.contentHash }, true, null);
            assert.ok(turnEnd, "the turn-end save must take the delta fast path (not the full re-ingest)");
            assert.equal(turnEnd.nonTailCount, 1, "the stash row is the only payload and it is non-tail");
            assert.deepEqual(turnEnd.tailSeqs, [0], "the stash row must NOT extend tailSeqs (view parity)");
            assert.equal(store.ingestSession(turnEnd, { trustedSeq: 0, boundaryMsgId: boundary.msgId, boundaryHash: boundary.contentHash, trustedTailSeqs: [0] }), true, "the turn-end delta must commit");
            let rows = store.getMessages("sd");
            assert.equal(rows.length, 2, "user + stash row");
            assert.equal(rows.find((r) => r.msgId === reply.id)?.ref, null, "still no ref at turn end");
            const stashSeq = rows.find((r) => r.msgId === reply.id)!.seq;

            // Request N+1: the client re-sends [u1, reply] plus a new user
            // turn. The reply is a TAIL row now and joins the stored stash
            // row in place; the new row appends.
            const u2 = convo([{ role: "user", content: "next" }])[0];
            const resend = { ...(mkLegacy("sd", [u1, reply, u2], { [reply.id]: "m00002" }, md) as object) } as LegacySessionLike;
            const resendPlan = planIngestDelta(resend, 0, [0], { msgId: boundary.msgId, contentHash: boundary.contentHash }, true, null);
            assert.ok(resendPlan, "the re-send must take the delta fast path (join in place, no full re-ingest)");
            assert.equal(resendPlan.nonTailCount, 0, "the stash is gated out once the reply is a view row");
            assert.equal(store.ingestSession(resendPlan, { trustedSeq: 0, boundaryMsgId: boundary.msgId, boundaryHash: boundary.contentHash, trustedTailSeqs: [0] }), true, "the re-send delta must commit");
            rows = store.getMessages("sd");
            assert.equal(rows.length, 3, `no duplicate rows after the join (got ${rows.length}: ${JSON.stringify(rows.map((r) => [r.seq, r.msgId, r.ref ?? "null"]))})`);
            const joined = rows.find((r) => r.msgId === reply.id)!;
            assert.equal(joined.seq, stashSeq, "the joined row keeps its stored seq");
            assert.equal(joined.ref, "m00002", "the NULL ref was claimed on the join");
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});
