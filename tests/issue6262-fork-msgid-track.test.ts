// #6262 principle 1 (msgid identity track, discussion #6262): the fork protocol
// gains an OPTIONAL identity track. When both sides expose host-stable message
// ids (a host-pinned parent carries the host ids AS its snapshot rawIds), a
// cell whose id matches but whose bytes drifted no longer truncates the fork
// prefix — the claim extends to the id-stable length, `driftFrom` marking the
// byte stop. Everything degrades to today's byte-only track: absent ids on
// either side, a misaligned array, or an unpinned parent (content-digest
// rawIds never equal host ids) → the byte path, byte for byte.
//
// Server observability: the fork response gains `driftFrom` and status
// "drifted" / "expanded+drifted" when the gate passes; a gate failure is
// SILENT (strict byte fork, no 409 — old clients and unpinned parents see
// exactly today's behavior).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { forkIdentityHashOf, forkOrderHashOf, openaiBodyToCore, tryForkAdoption, type ForkIdentity } from "../src/agent/fork-adopt.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-6262-fork-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

// ---------------------------------------------------------------------------
// Client track (tryForkAdoption) — stubbed snapshot/fork transport.
// ---------------------------------------------------------------------------

const PARENT_MESSAGES = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
] as const;
const PARENT_BODY = { model: "m", messages: [...PARENT_MESSAGES] };
const RAW_IDS = ["r-0", "r-1", "r-2", "r-3", "r-4"];
const PARENT_CORE = openaiBodyToCore(PARENT_BODY);
assert(PARENT_CORE !== null && PARENT_CORE.length === 5, "harness: parent body must project to 5 core messages");

// Snapshot identities derived from the parent core: identityHash = the same
// hash the client will recompute, rawId = the (pinned) host id.
const IDENTITIES: ForkIdentity[] = PARENT_CORE.map((m, k) => ({ rawId: RAW_IDS[k]!, ref: null, identityHash: forkIdentityHashOf(m) }));
const SNAPSHOT = {
    ok: true,
    protocolVersion: 2,
    status: "exact",
    sessionId: "parent-sess",
    parentRevision: "a".repeat(64),
    orderHash: forkOrderHashOf(IDENTITIES),
    orderedMessages: IDENTITIES,
};

type Call = { url: string; body?: string };
function stubTransport(forkResponse?: { status: number; body?: Record<string, unknown> }): { calls: Call[]; fetchImpl: typeof fetch } {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, body: typeof init?.body === "string" ? init.body : undefined });
        if (u.includes("/__bili/plugin/snapshot")) {
            return new Response(JSON.stringify(SNAPSHOT), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(forkResponse?.body ?? { ok: true, replayed: false }), { status: forkResponse?.status ?? 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
}

// Child = parent with the 4th cell (assistant "a2") re-rendered by the host —
// same stable id, different bytes. Byte stop = 3, id run = 5.
const DRIFT_BODY = {
    model: "m",
    messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2-DRIFT" },
        { role: "user", content: "u3" },
    ],
};

test("#6262: msgid track extends the prefix across an identity-stable drift cell", async () => {
    const { calls, fetchImpl } = stubTransport();
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "p", childConversationId: "c", body: DRIFT_BODY, msgIds: [...RAW_IDS], fetchImpl });
    assert.deepEqual(result, { outcome: "adopted", branchPoint: 5, replayed: false });
    const fork = calls.find((c) => c.url.includes("/__bili/plugin/fork"));
    assert(fork !== undefined && fork.body !== undefined);
    const payload = JSON.parse(fork!.body!) as {
        branchPoint: { messageCount: number; orderHash: string };
        orderedMessages: ForkIdentity[];
        prefixMsgIds?: string[];
        driftFrom?: number;
        idempotencyKey: string;
    };
    assert.equal(payload.branchPoint.messageCount, 5);
    assert.equal(payload.driftFrom, 3, "driftFrom = the byte stop");
    assert.deepEqual(payload.prefixMsgIds, RAW_IDS, "host ids for the whole claimed prefix");
    assert.deepEqual(payload.orderedMessages, IDENTITIES, "claimed identities stay the PARENT's, verbatim");
    assert.equal((payload.branchPoint as { orderHash: string }).orderHash, SNAPSHOT.orderHash, "full-length prefix reuses the snapshot orderHash");
    assert.equal(payload.idempotencyKey, "fork:c");
});

test("#6262: absent msgIds → byte track, byte for byte (legacy client)", async () => {
    const { calls, fetchImpl } = stubTransport();
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "p", childConversationId: "c", body: DRIFT_BODY, fetchImpl });
    assert.deepEqual(result, { outcome: "adopted", branchPoint: 3, replayed: false });
    const payload = JSON.parse(calls.find((c) => c.url.includes("/__bili/plugin/fork"))!.body!) as Record<string, unknown>;
    assert.equal(payload.branchPoint && (payload.branchPoint as { messageCount: number }).messageCount, 3);
    assert.equal("prefixMsgIds" in payload, false, "no id track fields on the byte path");
    assert.equal("driftFrom" in payload, false);
    assert.equal((payload.orderedMessages as unknown[]).length, 3);
});

test("#6262: unpinned parent (ids never align) → byte track, fields omitted", async () => {
    const { calls, fetchImpl } = stubTransport();
    const hostUuids = ["uuid-0", "uuid-1", "uuid-2", "uuid-3", "uuid-4"];
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "p", childConversationId: "c", body: DRIFT_BODY, msgIds: hostUuids, fetchImpl });
    assert.deepEqual(result, { outcome: "adopted", branchPoint: 3, replayed: false });
    const payload = JSON.parse(calls.find((c) => c.url.includes("/__bili/plugin/fork"))!.body!) as Record<string, unknown>;
    assert.equal("prefixMsgIds" in payload, false, "nId=0 < branchPoint → unverified ids are never sent");
    assert.equal("driftFrom" in payload, false);
});

test("#6262: id run shorter than the byte run → byte track wins, fields omitted", async () => {
    const { calls, fetchImpl } = stubTransport();
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "p", childConversationId: "c", body: DRIFT_BODY, msgIds: ["r-0", "r-1", "different"], fetchImpl });
    assert.deepEqual(result, { outcome: "adopted", branchPoint: 3, replayed: false });
    const payload = JSON.parse(calls.find((c) => c.url.includes("/__bili/plugin/fork"))!.body!) as Record<string, unknown>;
    assert.equal("prefixMsgIds" in payload, false, "nId=2 < branchPoint=3 → omitted");
    assert.equal("driftFrom" in payload, false);
});

test("#6262: pinned parent, no drift → ids ride the full byte prefix, no driftFrom", async () => {
    const { calls, fetchImpl } = stubTransport();
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "p", childConversationId: "c", body: { ...PARENT_BODY, messages: [...PARENT_MESSAGES] }, msgIds: [...RAW_IDS], fetchImpl });
    assert.deepEqual(result, { outcome: "adopted", branchPoint: 5, replayed: false });
    const payload = JSON.parse(calls.find((c) => c.url.includes("/__bili/plugin/fork"))!.body!) as Record<string, unknown>;
    assert.deepEqual(payload.prefixMsgIds, RAW_IDS);
    assert.equal("driftFrom" in payload, false, "no extension → no driftFrom");
});

test("#6262: misaligned msgIds (length ≠ core) → byte track, fields omitted", async () => {
    const { calls, fetchImpl } = stubTransport();
    const result = await tryForkAdoption({ base: "http://proxy", parentConversationId: "p", childConversationId: "c", body: DRIFT_BODY, msgIds: RAW_IDS.slice(0, 4), fetchImpl });
    assert.deepEqual(result, { outcome: "adopted", branchPoint: 3, replayed: false });
    const payload = JSON.parse(calls.find((c) => c.url.includes("/__bili/plugin/fork"))!.body!) as Record<string, unknown>;
    assert.equal("prefixMsgIds" in payload, false);
    assert.equal("driftFrom" in payload, false);
});

// ---------------------------------------------------------------------------
// Server gate (full chain) — real proxy, real snapshot/fork endpoints.
// ---------------------------------------------------------------------------

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    return { upstreamUrl, origin: `http://127.0.0.1:${paddr.port}`, close: async () => { store.cancelAll(); proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); } };
}

// Parent core = 4 cells (the system message hoists out of the fold space):
// [u, a, u, a]. The drift cell is the LAST parent cell (assistant "a4").
const PARENT4 = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "first original ".repeat(250) },
    { role: "assistant", content: "second original ".repeat(250) },
    { role: "user", content: "third original ".repeat(250) },
    { role: "assistant", content: "fourth original" },
];

test("#6262: full chain — drifted fork adopts past the byte stop and the child replay rides it", async () => {
    const h = await harness();
    try {
        const seed = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "parent-sid" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: PARENT4 }),
        });
        assert.equal(seed.status, 200, await seed.text());

        const parentSnap = (await (await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=parent-sid`)).json()) as {
            parentRevision: string;
            orderHash: string;
            orderedMessages: Array<{ rawId: string; ref: string | null; identityHash: string }>;
        };
        assert.equal(parentSnap.orderedMessages.length, 4, "system hoists out of the fold space");
        const rawIds = parentSnap.orderedMessages.map((m) => m.rawId);

        // Child: parent with the last cell re-rendered (same host id, new bytes) + a new tail.
        const childMessages = [
            PARENT4[0]!,
            PARENT4[1]!,
            PARENT4[2]!,
            PARENT4[3]!,
            { role: "assistant", content: "fourth original RE-RENDERED" },
            { role: "user", content: "new fork tail" },
        ];
        const adoption = await tryForkAdoption({
            base: h.origin,
            parentConversationId: "parent-sid",
            childConversationId: "child-sid",
            body: { model: "claude-test", max_tokens: 1024, stream: false, messages: childMessages },
            msgIds: [...rawIds, "tail-host-id"],
        });
        assert.deepEqual(adoption, { outcome: "adopted", branchPoint: 4, replayed: false }, "the id track extends the byte stop (3) to 4");

        const childSnap = (await (await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=child-sid`)).json()) as { orderedMessages: unknown[] };
        assert.equal(childSnap.orderedMessages.length, 4, "the child inherits the full parent prefix, drift cell included");

        // The child's first replay (drifted text) must be accepted — the ledger
        // reserved the drift cell's id/ref, so the kernel rides it instead of
        // 409ing the child conversation.
        const replay = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "child-sid" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: childMessages }),
        });
        assert.equal(replay.status, 200, await replay.text());
    } finally {
        await h.close();
    }
});

test("#6262: server marks the receipt — status drifted + driftFrom echo; gate failure stays strict (no 409)", async () => {
    const h = await harness();
    try {
        const seed = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "p2" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: PARENT4 }),
        });
        assert.equal(seed.status, 200, await seed.text());
        const parentSnap = (await (await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=p2`)).json()) as {
            parentRevision: string;
            orderedMessages: Array<{ rawId: string; ref: string | null; identityHash: string }>;
        };
        const rawIds = parentSnap.orderedMessages.map((m) => m.rawId);
        const prefix = parentSnap.orderedMessages;

        // (1) gate passes → status "drifted" + driftFrom echo.
        const driftedRes = await fetch(`${h.origin}/__bili/plugin/fork`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ protocolVersion: 1, parentConversationId: "p2", childConversationId: "c-drift", parentRevision: parentSnap.parentRevision, branchPoint: { messageCount: 4, orderHash: forkOrderHashOf(prefix) }, orderedMessages: prefix, idempotencyKey: "fork:c-drift", prefixMsgIds: rawIds, driftFrom: 3 }),
        });
        const driftedText = await driftedRes.text();
        assert.equal(driftedRes.status, 201, driftedText);
        const driftedBody = JSON.parse(driftedText) as { status: string; driftFrom?: number; inheritedBlocks: unknown[] };
        assert.equal(driftedBody.status, "drifted");
        assert.equal(driftedBody.driftFrom, 3);

        // (2) gate failure (ids ≠ parent rawIds) → the byte-verified fork still
        // succeeds, STRICT: status "exact", no driftFrom, no 409.
        const strictRes = await fetch(`${h.origin}/__bili/plugin/fork`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ protocolVersion: 1, parentConversationId: "p2", childConversationId: "c-strict", parentRevision: parentSnap.parentRevision, branchPoint: { messageCount: 4, orderHash: forkOrderHashOf(prefix) }, orderedMessages: prefix, idempotencyKey: "fork:c-strict", prefixMsgIds: ["wrong-0", "wrong-1", "wrong-2", "wrong-3"] }),
        });
        const strictText = await strictRes.text();
        assert.equal(strictRes.status, 201, strictText);
        const strictBody = JSON.parse(strictText) as { status: string; driftFrom?: number };
        assert.equal(strictBody.status, "exact");
        assert.equal("driftFrom" in strictBody, false);

        // (3) prefixMsgIds present but driftFrom === messageCount → normalized
        // to no drift: exact.
        const normRes = await fetch(`${h.origin}/__bili/plugin/fork`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ protocolVersion: 1, parentConversationId: "p2", childConversationId: "c-norm", parentRevision: parentSnap.parentRevision, branchPoint: { messageCount: 4, orderHash: forkOrderHashOf(prefix) }, orderedMessages: prefix, idempotencyKey: "fork:c-norm", prefixMsgIds: rawIds, driftFrom: 4 }),
        });
        const normText = await normRes.text();
        assert.equal(normRes.status, 201, normText);
        const normBody = JSON.parse(normText) as { status: string; driftFrom?: number };
        assert.equal(normBody.status, "exact");
        assert.equal("driftFrom" in normBody, false);

        // (4) parse rejections — 400, never a 409, never a silent ignore.
        const badLength = await fetch(`${h.origin}/__bili/plugin/fork`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ protocolVersion: 1, parentConversationId: "p2", childConversationId: "c-bad1", parentRevision: parentSnap.parentRevision, branchPoint: { messageCount: 4, orderHash: forkOrderHashOf(prefix) }, orderedMessages: prefix, idempotencyKey: "fork:c-bad1", prefixMsgIds: rawIds.slice(0, 3) }),
        });
        assert.equal(badLength.status, 400);
        const badShape = await fetch(`${h.origin}/__bili/plugin/fork`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ protocolVersion: 1, parentConversationId: "p2", childConversationId: "c-bad2", parentRevision: parentSnap.parentRevision, branchPoint: { messageCount: 4, orderHash: forkOrderHashOf(prefix) }, orderedMessages: prefix, idempotencyKey: "fork:c-bad2", prefixMsgIds: ["ok", "", "x", "y"] }),
        });
        assert.equal(badShape.status, 400);
        const driftOnly = await fetch(`${h.origin}/__bili/plugin/fork`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ protocolVersion: 1, parentConversationId: "p2", childConversationId: "c-bad3", parentRevision: parentSnap.parentRevision, branchPoint: { messageCount: 4, orderHash: forkOrderHashOf(prefix) }, orderedMessages: prefix, idempotencyKey: "fork:c-bad3", driftFrom: 3 }),
        });
        assert.equal(driftOnly.status, 400);
        const driftOob = await fetch(`${h.origin}/__bili/plugin/fork`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ protocolVersion: 1, parentConversationId: "p2", childConversationId: "c-bad4", parentRevision: parentSnap.parentRevision, branchPoint: { messageCount: 4, orderHash: forkOrderHashOf(prefix) }, orderedMessages: prefix, idempotencyKey: "fork:c-bad4", prefixMsgIds: rawIds, driftFrom: 9 }),
        });
        assert.equal(driftOob.status, 400);
    } finally {
        await h.close();
    }
});
