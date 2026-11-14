// #4867: a turn whose upstream forward fails (non-2xx or thrown error) must
// not leave the canonical advanced — before the fix the failed forward left it
// ahead while no ack went out (#3344 stamps on 2xx only), so the client's plain
// retry hit a 409 seq-mismatch and paid a full resync. Contract pinned here:
// after a failed forward, retrying the SAME delta lands. The gate's other
// direction is pinned too: once the 2xx head carrying the ack has reached the
// client, a late crash must NOT roll back — the client already advanced, and a
// rollback would be reverse drift (its next delta would 409).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
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
import { __resetIncrementalLaneForTests, handleIncrementalTurn } from "../src/incremental-lane.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-incr4867-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

const CONVERSATION_ID = "conv-inc-4867";

interface Turn {
    sinceSeq: number;
    messages: unknown[];
    resync?: boolean;
    system?: string;
}

interface Harness {
    proxyUrl: string;
    turn: (t: Turn) => Promise<{ status: number; headers: Headers; body: unknown }>;
    probeConv: () => Promise<{ status: number; body: { conversation?: { appliedSeq: number; boundary: string | null } } }>;
    /** Next `remaining` UPSTREAM requests answer `status` (default 502); counted
     *  per upstream request, so internal replays consume the budget too. */
    setFailures: (remaining: number, status?: number) => void;
    forwarded: Record<string, unknown>[];
    close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    let failRemaining = 0;
    let failStatus = 502;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            if (failRemaining > 0) {
                failRemaining--;
                res.writeHead(failStatus, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { type: "upstream_error", message: "simulated blip" } }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const turn = async (t: Turn) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONVERSATION_ID },
            body: JSON.stringify({ conversationId: CONVERSATION_ID, sinceSeq: t.sinceSeq, ...(t.resync ? { resync: true } : {}), ...(t.system !== undefined ? { system: t.system } : {}), path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, messages: t.messages }),
        });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, headers: response.headers, body };
    };
    const probeConv = async () => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn?conversation=${CONVERSATION_ID}`, { method: "GET", headers: { "x-bili-plugin": "dsh" } });
        const body = (await response.json()) as { conversation?: { appliedSeq: number; boundary: string | null } };
        return { status: response.status, body };
    };
    return {
        proxyUrl,
        turn,
        probeConv,
        setFailures: (remaining: number, status?: number) => { failRemaining = remaining; failStatus = status ?? 502; },
        forwarded,
        close: async () => { await new Promise<void>((resolve) => proxy.close(() => resolve())); store.closeQuietly(); await new Promise<void>((resolve) => upstream.close(() => resolve())); },
    };
}

const userTurn = (n: number, text: string) => ({ id: `u${n}`, role: "user", contentType: "text", content: `${text}`.repeat(400) });
const assistantTurn = (n: number) => ({ id: `a${n}`, role: "assistant", contentType: "text", content: `model answer ${n}` });

// Wire content is a string or an array of blocks depending on the shape the
// assembler produced — flatten both for assertions.
const textOf = (m: { content?: unknown }): string => {
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((b) => (b !== null && typeof b === "object" && "text" in b ? String((b as { text?: unknown }).text ?? "") : "")).join("");
    return "";
};

// The budget must outlast the pipeline's internal replay ladder (default 3
// replays on transient upstream errors) so the CLIENT actually sees the
// failure instead of a silently recovered attempt.
const BLIP_BUDGET = 6;

test("#4867: seed whose forward answers 502 → the same seed retries cleanly (no 409 resync)", async () => {
    const h = await harness();
    try {
        h.setFailures(BLIP_BUDGET, 502);
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1, "seed-one")] });
        assert.ok(seed.status >= 400 && seed.status < 600, `failed forward surfaces non-2xx (got ${String(seed.status)})`);
        assert.equal(seed.headers.get("x-bili-applied-seq"), null, "no ack on a failed forward (#3344)");

        h.setFailures(0);
        const retry = await h.turn({ sinceSeq: 0, messages: [userTurn(1, "seed-one")] });
        assert.equal(retry.status, 200, "plain retry of the same delta lands — pre-fix this was a 409 seq-mismatch forcing a full resync");
        assert.equal(retry.headers.get("x-bili-applied-seq"), "1");
        const upstreamBody = h.forwarded.at(-1) as { messages: { role?: string; content?: unknown }[] };
        assert.ok(Array.isArray(upstreamBody.messages) && upstreamBody.messages.length === 1);
        assert.equal(upstreamBody.messages[0].role, "user");
        // Content carries ACP identity markers around the payload text.
        assert.ok(textOf(upstreamBody.messages[0]).includes("seed-one"));
    } finally {
        await h.close();
    }
});

test("#4867: delta whose forward answers 502 → same delta retries onto the unchanged canonical (assembled prefix, no resync)", async () => {
    const h = await harness();
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1, "seed-one")] });
        assert.equal(seed.status, 200);
        assert.equal(seed.headers.get("x-bili-applied-seq"), "1");

        h.setFailures(BLIP_BUDGET, 502);
        const delta = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2, "second-question")] });
        assert.ok(delta.status >= 400 && delta.status < 600, `failed forward surfaces non-2xx (got ${String(delta.status)})`);
        assert.equal(delta.headers.get("x-bili-applied-seq"), null);

        h.setFailures(0);
        const retry = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2, "second-question")] });
        assert.equal(retry.status, 200, "retry hits the still-length-1 canonical — pre-fix the canonical had advanced to 3 and this 409'd");
        assert.equal(retry.headers.get("x-bili-applied-seq"), "3");
        const upstreamBody = h.forwarded.at(-1) as { messages: { role: string }[] };
        assert.equal(upstreamBody.messages.length, 3, "server-assembled history = seed + retried delta (no client resync round-trip)");
        assert.deepEqual(upstreamBody.messages.map((m) => m.role), ["user", "assistant", "user"]);

        const probe = await h.probeConv();
        assert.equal(probe.status, 200);
        assert.equal(probe.body.conversation?.appliedSeq, 3);
    } finally {
        await h.close();
    }
});

test("#4867: RESYNC whose forward fails restores the pre-resync canonical (old-length deltas land again)", async () => {
    const h = await harness();
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1, "seed-one")] });
        assert.equal(seed.status, 200);
        const d1 = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1)] });
        assert.equal(d1.status, 200);
        assert.equal(d1.headers.get("x-bili-applied-seq"), "2");

        h.setFailures(BLIP_BUDGET, 502);
        const resync = await h.turn({ sinceSeq: 0, resync: true, system: "new-system", messages: [userTurn(9, "resync-nine")] });
        assert.ok(resync.status >= 400 && resync.status < 600, `failed resync surfaces non-2xx (got ${String(resync.status)})`);
        assert.equal(resync.headers.get("x-bili-applied-seq"), null);

        h.setFailures(0);
        const delta = await h.turn({ sinceSeq: 2, messages: [assistantTurn(9)] });
        assert.equal(delta.status, 200, "post-failed-resync delta against the old length must land");
        assert.equal(delta.headers.get("x-bili-applied-seq"), "3");
        // [u1, a1] + delta [a9]: a1 and a9 are consecutive assistants, so the
        // wire carries them merged — 2 messages, user then assistant.
        const upstreamBody = h.forwarded.at(-1) as { messages: { role?: string; content?: unknown }[] };
        assert.equal(upstreamBody.messages.length, 2);
        assert.ok(textOf(upstreamBody.messages[0]).includes("seed-one"), "prefix is the PRE-resync canonical, not the rejected replacement");
        assert.equal(upstreamBody.messages[1].role, "assistant");
        const allText = upstreamBody.messages.map((m) => textOf(m)).join("\n");
        assert.ok(allText.includes("model answer 9"), "the retried delta landed");
        assert.ok(!allText.includes("resync-nine"), "the rejected resync replacement is gone from the wire");
    } finally {
        await h.close();
    }
});

test("#4867: forward THROWS before any byte reaches the client → canonical rolls back (direct call)", async () => {
    const h = await harness();
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1, "seed-one")] });
        assert.equal(seed.status, 200);
        assert.equal(seed.headers.get("x-bili-applied-seq"), "1");

        const payload = JSON.stringify({ conversationId: CONVERSATION_ID, sinceSeq: 1, path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, messages: [assistantTurn(1)] });
        const req = Readable.from([Buffer.from(payload)]) as unknown as http.IncomingMessage;
        Object.assign(req, { headers: { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONVERSATION_ID }, socket: {} });
        const res = new http.ServerResponse(req);
        await assert.rejects(
            handleIncrementalTurn(req, res, () => undefined, async () => { throw new Error("simulated upstream crash"); }),
            /simulated upstream crash/,
        );

        const probe = await h.probeConv();
        assert.equal(probe.status, 200);
        assert.equal(probe.body.conversation?.appliedSeq, 1, "warm canonical rolled back to the pre-turn length — pre-fix it stayed at 2");

        const delta = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2, "after-crash")] });
        assert.equal(delta.status, 200, "the client's plain retry lands after a thrown forward");
        assert.equal(delta.headers.get("x-bili-applied-seq"), "3");
    } finally {
        await h.close();
    }
});

test("#4867: forward throws AFTER the 2xx head reached the client → NO rollback (ack already delivered)", async () => {
    const h = await harness();
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1, "seed-one")] });
        assert.equal(seed.status, 200);
        assert.equal(seed.headers.get("x-bili-applied-seq"), "1");

        // writeHead on the detached response genuinely flips headersSent — the
        // lane sees exactly what a real mid-body crash looks like from here:
        // the 2xx head carrying x-bili-applied-seq is already with the client.
        const payload = JSON.stringify({ conversationId: CONVERSATION_ID, sinceSeq: 1, path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, messages: [assistantTurn(1)] });
        const req = Readable.from([Buffer.from(payload)]) as unknown as http.IncomingMessage;
        Object.assign(req, { headers: { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONVERSATION_ID }, socket: {} });
        const res = new http.ServerResponse(req);
        await assert.rejects(
            handleIncrementalTurn(req, res, () => undefined, async (_synthetic, out) => {
                out.writeHead(200, { "content-type": "application/json" });
                throw new Error("simulated mid-body crash");
            }),
            /simulated mid-body crash/,
        );

        const probe = await h.probeConv();
        assert.equal(probe.status, 200);
        assert.equal(probe.body.conversation?.appliedSeq, 2, "no rollback once the ack head is flushed — rolling back now would desync the advanced client");

        const delta = await h.turn({ sinceSeq: 2, messages: [assistantTurn(1), userTurn(2, "after-crash")] });
        assert.equal(delta.status, 200, "a client that adopted the flushed ack continues from seq 2 without a resync");
        assert.equal(delta.headers.get("x-bili-applied-seq"), "4");
    } finally {
        await h.close();
    }
});
