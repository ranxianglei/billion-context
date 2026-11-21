import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, getStore } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";
import { __resetIncrementalClientForTests, noteIncrementalAck, planIncrementalTurn, type IncrementalWireMessage } from "../src/agent/incremental-client.ts";

// #6776 compact retouch: the client sends {index, hash, marks} instead of
// {index, message} for cache-control-only retouches, shrinking the patch to
// O(marks) instead of O(message size). The server compares the align-hash
// (content without cache_control) against the stored per-wire-message hash
// and maps the mark list to core ids via the wire span.

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-compact-retouch-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

const MARK = { type: "ephemeral" };
const SYSTEM = [{ type: "text", text: "you are a coding agent", cache_control: MARK }];

function alignHash(m: { role: string; content: unknown }): string {
    const content = Array.isArray(m.content)
        ? m.content.map((b: unknown) => {
            if (b === null || typeof b !== "object" || !("cache_control" in b)) return b;
            const { cache_control: _drop, ...rest } = b as Record<string, unknown>;
            return rest;
        })
        : m.content;
    return createHash("sha256").update(`${m.role}\u0000${JSON.stringify(content)}`).digest("hex").slice(0, 16);
}

interface H {
    post: (path: string, body: string, headers: Record<string, string>) => Promise<{ status: number; appliedSeq?: number; body?: Record<string, unknown> }>;
    probe: () => Promise<{ status: number; body: Record<string, unknown> }>;
    forwarded: Record<string, unknown>[];
    close: () => Promise<void>;
}

async function harness(): Promise<H> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_COMPACT_RETOUCH = "1";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    __resetIncrementalClientForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 1000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: false, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const post = async (path: string, body: string, headers: Record<string, string>) => {
        const response = await fetch(`${proxyUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
        const text = await response.text();
        let parsed: Record<string, unknown> | undefined;
        try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
        const applied = response.headers.get("x-bili-applied-seq");
        return { status: response.status, appliedSeq: applied !== null && /^\d+$/.test(applied) ? Number(applied) : undefined, body: parsed };
    };
    const probe = async () => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, { headers: { "x-bili-plugin": "dsh" } });
        const body = await response.json() as Record<string, unknown>;
        return { status: response.status, body };
    };
    return {
        post,
        probe,
        forwarded,
        close: async () => {
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            store.closeQuietly();
            await new Promise<void>((resolve) => upstream.close(() => resolve()));
            delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
            delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_COMPACT_RETOUCH;
        },
    };
}

const laneHeaders = { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-compact-1" };

test("probe advertises compactRetouch when the rollout is on", async () => {
    const h = await harness();
    try {
        const { status, body } = await h.probe();
        assert.equal(status, 200);
        assert.equal(body.enabled, true);
        assert.equal(body.cacheControlRetouch, true);
        assert.equal(body.compactRetouch, true);
    } finally {
        await h.close();
    }
});

test("compact retouch: client sends {index, hash, marks} and the server applies the marks", async () => {
    const h = await harness();
    try {
        // Seed: send the first message WITH a cache_control mark (resync: true).
        const seedMsg: IncrementalWireMessage = { role: "user", content: [{ type: "text", text: "first", cache_control: MARK }] };
        const seedBody = JSON.stringify({
            conversationId: "conv-compact-1",
            sinceSeq: 0,
            resync: true,
            path: "/v1/messages",
            request: { model: "claude-test", max_tokens: 1024 },
            messages: [seedMsg],
            system: SYSTEM,
        });
        const seed = await h.post("/__bili/plugin/turn", seedBody, laneHeaders);
        assert.equal(seed.status, 200);
        assert.equal(seed.appliedSeq, 1);

        // Ack: record the seed in the client state (sentRaw = wireHash WITH mark).
        noteIncrementalAck("conv-compact-1", 1, [seedMsg], SYSTEM);

        // Delta: send a new message AND a retouch (the first message LOST its
        // cache_control mark — a rolling breakpoint moved to the new message).
        const deltaMsg: IncrementalWireMessage = { role: "assistant", content: [{ type: "text", text: "second", cache_control: MARK }] };
        const retouchedMsg: IncrementalWireMessage = { role: "user", content: [{ type: "text", text: "first" }] };
        const plan = planIncrementalTurn({
            cacheControlRetouch: true,
            compactRetouch: true,
            conversationId: "conv-compact-1",
            path: "/v1/messages",
            messages: [retouchedMsg, deltaMsg],
            system: SYSTEM,
            request: { model: "claude-test", max_tokens: 1024 },
        });
        assert.equal(plan.mode, "delta");
        const parsed = JSON.parse(plan.body) as { retouch?: { index: number; hash?: string; marks?: unknown[]; message?: unknown }[] };
        assert.ok(parsed.retouch, "retouch should be present");
        assert.equal(parsed.retouch!.length, 1);
        const r = parsed.retouch![0];
        assert.equal(r.index, 0);
        assert.equal(r.message, undefined, "compact retouch must not carry the full message");
        assert.equal(r.hash, alignHash(retouchedMsg));
        assert.deepEqual(r.marks, [null]);

        // Send the delta with the compact retouch.
        const delta = await h.post("/__bili/plugin/turn", plan.body, laneHeaders);
        assert.equal(delta.status, 200);
        assert.equal(delta.appliedSeq, 2);

        // The forwarded request should have the retouched message WITHOUT the
        // cache_control mark (the mark was removed by the retouch).
        const lastForwarded = h.forwarded.at(-1);
        assert.ok(lastForwarded);
        const msgs = lastForwarded!.messages as Record<string, unknown>[];
        assert.equal(msgs.length, 2);
        const firstContent = msgs[0].content as Record<string, unknown>[];
        assert.equal(firstContent[0].cache_control, undefined, "the retouch removed the mark");
    } finally {
        await h.close();
    }
});

test("compact retouch: hash mismatch (content changed) is refused with 409", async () => {
    const h = await harness();
    try {
        const seedMsg: IncrementalWireMessage = { role: "user", content: [{ type: "text", text: "first" }] };
        const seedBody = JSON.stringify({
            conversationId: "conv-compact-1",
            sinceSeq: 0,
            resync: true,
            path: "/v1/messages",
            request: { model: "claude-test", max_tokens: 1024 },
            messages: [seedMsg],
            system: SYSTEM,
        });
        const seed = await h.post("/__bili/plugin/turn", seedBody, laneHeaders);
        assert.equal(seed.status, 200);

        // Forge a compact retouch with the WRONG hash (content changed).
        const forgedBody = JSON.stringify({
            conversationId: "conv-compact-1",
            sinceSeq: 1,
            path: "/v1/messages",
            request: { model: "claude-test", max_tokens: 1024 },
            messages: [{ role: "assistant", content: [{ type: "text", text: "next" }] }],
            retouch: [{ index: 0, hash: "0000000000000000", marks: [null] }],
        });
        const forged = await h.post("/__bili/plugin/turn", forgedBody, laneHeaders);
        assert.equal(forged.status, 409);
    } finally {
        await h.close();
    }
});

test("compact retouch: cold canonical (no align hashes) is refused with 409", async () => {
    const h = await harness();
    try {
        // Seed the canonical, then reset the lane (simulating a process
        // restart → cold rebuild from the unified table).
        const seedMsg: IncrementalWireMessage = { role: "user", content: [{ type: "text", text: "first" }] };
        const seedBody = JSON.stringify({
            conversationId: "conv-compact-1",
            sinceSeq: 0,
            resync: true,
            path: "/v1/messages",
            request: { model: "claude-test", max_tokens: 1024 },
            messages: [seedMsg],
            system: SYSTEM,
        });
        const seed = await h.post("/__bili/plugin/turn", seedBody, laneHeaders);
        assert.equal(seed.status, 200);

        // Reset the lane → cold canonical (no wireSpans, no wireAlignHashes).
        __resetIncrementalLaneForTests();

        // Forge a compact retouch against the cold canonical.
        const forgedBody = JSON.stringify({
            conversationId: "conv-compact-1",
            sinceSeq: 1,
            path: "/v1/messages",
            request: { model: "claude-test", max_tokens: 1024 },
            messages: [{ role: "assistant", content: [{ type: "text", text: "next" }] }],
            retouch: [{ index: 0, hash: alignHash(seedMsg), marks: [null] }],
        });
        const forged = await h.post("/__bili/plugin/turn", forgedBody, laneHeaders);
        assert.equal(forged.status, 409);
    } finally {
        await h.close();
    }
});

test("compact retouch: malformed entry (missing hash or marks) is refused with 400", async () => {
    const h = await harness();
    try {
        const seedMsg: IncrementalWireMessage = { role: "user", content: [{ type: "text", text: "first" }] };
        const seedBody = JSON.stringify({
            conversationId: "conv-compact-1",
            sinceSeq: 0,
            resync: true,
            path: "/v1/messages",
            request: { model: "claude-test", max_tokens: 1024 },
            messages: [seedMsg],
            system: SYSTEM,
        });
        const seed = await h.post("/__bili/plugin/turn", seedBody, laneHeaders);
        assert.equal(seed.status, 200);

        // Entry with hash but no marks.
        const noMarks = await h.post("/__bili/plugin/turn", JSON.stringify({
            conversationId: "conv-compact-1",
            sinceSeq: 1,
            path: "/v1/messages",
            request: { model: "claude-test", max_tokens: 1024 },
            messages: [{ role: "assistant", content: [{ type: "text", text: "next" }] }],
            retouch: [{ index: 0, hash: alignHash(seedMsg) }],
        }), laneHeaders);
        assert.equal(noMarks.status, 400);

        // Entry with marks but no hash.
        const noHash = await h.post("/__bili/plugin/turn", JSON.stringify({
            conversationId: "conv-compact-1",
            sinceSeq: 1,
            path: "/v1/messages",
            request: { model: "claude-test", max_tokens: 1024 },
            messages: [{ role: "assistant", content: [{ type: "text", text: "next" }] }],
            retouch: [{ index: 0, marks: [null] }],
        }), laneHeaders);
        assert.equal(noHash.status, 400);
    } finally {
        await h.close();
    }
});

test("compact retouch: a mark on a sidecar (image) row updates the raw block but never pollutes entry.marks (#7321)", async () => {
    const h = await harness();
    try {
        // Seed: a user message with a text block AND an image block (the
        // image is a sidecar row — the kernel records no cache_control mark
        // for it, so the full path would never put it in entry.marks).
        const seedMsg: IncrementalWireMessage = {
            role: "user",
            content: [
                { type: "text", text: "first" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
            ],
        };
        const seedBody = JSON.stringify({
            conversationId: "conv-compact-1",
            sinceSeq: 0,
            resync: true,
            path: "/v1/messages",
            request: { model: "claude-test", max_tokens: 1024 },
            messages: [seedMsg],
            system: SYSTEM,
        });
        const seed = await h.post("/__bili/plugin/turn", seedBody, laneHeaders);
        assert.equal(seed.status, 200);
        // The seed produces two core rows (text + image sidecar).
        assert.equal(seed.appliedSeq, 2);

        // Delta: a new assistant message plus a compact retouch that ADDS a
        // cache_control mark to the image block (block index 1 = sidecar row).
        const deltaBody = JSON.stringify({
            conversationId: "conv-compact-1",
            sinceSeq: 2,
            path: "/v1/messages",
            request: { model: "claude-test", max_tokens: 1024 },
            messages: [{ role: "assistant", content: [{ type: "text", text: "second" }] }],
            retouch: [{ index: 0, hash: alignHash(seedMsg), marks: [null, MARK] }],
        });
        const delta = await h.post("/__bili/plugin/turn", deltaBody, laneHeaders);
        assert.equal(delta.status, 200);
        assert.equal(delta.appliedSeq, 3);

        // (a) The raw image block still gets its cache_control set in place —
        // the raw-block mutation channel is complete (reads rawMarks, not
        // entry.marks), so sidecar rows keep their mark on the wire.
        const lastForwarded = h.forwarded.at(-1);
        assert.ok(lastForwarded);
        const msgs = lastForwarded!.messages as Record<string, unknown>[];
        assert.equal(msgs.length, 2);
        const seedContent = msgs[0].content as Record<string, unknown>[];
        const imageBlock = seedContent.find((b) => (b as { type?: string }).type === "image");
        assert.ok(imageBlock, "the image block must be present in the forwarded wire");
        assert.deepEqual(imageBlock.cache_control, MARK, "the raw image block keeps its cache_control");

        // (b) entry.marks (persisted as inc:cache-marks) must NOT contain the
        // sidecar image row — only kernel-recorded rows belong there, matching
        // the full path. Before the #7321 fix the compact path wrote the
        // image row's mark into entry.marks, leaving a stale entry that the
        // full path would never produce.
        const marks = getStore().getSessionExt("conv-compact-1", "inc:cache-marks") as [string, unknown][];
        assert.ok(Array.isArray(marks), "inc:cache-marks must be persisted as an entry list");
        assert.equal(marks.length, 0, "entry.marks must be empty — the image row is not kernel-recorded");
    } finally {
        await h.close();
    }
});
