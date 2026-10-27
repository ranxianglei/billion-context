import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate state + config so a developer's real billion-context.json and
// session files never leak into the rig (wiring-test pattern).
const HOME = mkdtempSync(path.join(tmpdir(), "bc-2935-"));
process.env.HOME = HOME;
process.env.BILI_CONFIG_FILE = path.join(HOME, "billion-context.json");

// Imported AFTER the env isolation above.
const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { _resetSessionsForTest, getSession, listSessions, peekSession } = await import("../src/session.ts");
const { deleteSessionArtifacts, personaForkIds } = await import("../src/session-delete.ts");
const { prefixAffinity } = await import("../src/prefix-affinity.ts");
const { restoreExportDir } = await import("../src/image-restore.ts");
import type { ProxyOptions } from "../src/config.ts";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function textScript(): string {
    return [
        "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ].join("");
}

test("personaForkIds: only <base>|sub:* descendants match (#2935)", () => {
    const sessions = [
        { id: "conv-1" },
        { id: "conv-1|sub:aaa" },
        { id: "conv-1|sub:bbb" },
        { id: "conv-10" }, // shares the bare prefix "conv-1" but is NOT a fork
        { id: "conv-1x" },
        { id: "other|sub:zzz" },
    ];
    assert.deepEqual(personaForkIds("conv-1", sessions), ["conv-1|sub:aaa", "conv-1|sub:bbb"]);
    assert.deepEqual(personaForkIds("other", sessions), ["other|sub:zzz"]);
    assert.deepEqual(personaForkIds("nope", sessions), []);
});

test("deleteSessionArtifacts tears down every artifact for a resident session (#2935)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bc-2935-store-"));
    const store = new SessionStore({ dir, debounceMs: 1 });
    _setStoreForTest(store);
    _resetSessionsForTest();
    try {
        const meta = { protocol: "anthropic", upstreamOrigin: "https://api.example.com" } as const;
        const s = getSession("del-a", meta);
        // Seed every co-lifecycle artifact so we can prove each is torn down.
        prefixAffinity.note("del-a", 1, "tail-hash-a", ["h1"], true);
        assert.ok(prefixAffinity.trackedSessionIds().includes("del-a"), "affinity chain tracked");
        const spill = restoreExportDir("del-a");
        mkdirSync(spill, { recursive: true });
        writeFileSync(path.join(spill, "img.bin"), "x");
        assert.ok(existsSync(spill), "image spill present before teardown");

        // Force the persisted record out so there is something to remove.
        await store.writeNow(s);
        assert.ok(store.loadSync("del-a", meta) !== null, "session persisted before teardown");

        const out = await deleteSessionArtifacts("del-a");
        assert.equal(out.deleted, true, "reported deleted");
        assert.equal(out.deferred, false, "not deferred");
        assert.equal(peekSession("del-a"), undefined, "resident dropped from memory");
        assert.equal(store.loadSync("del-a", meta), null, "persisted record removed");
        assert.ok(!existsSync(spill), "image spill dir removed");
        assert.ok(!prefixAffinity.trackedSessionIds().includes("del-a"), "affinity chain forgotten");
    } finally {
        _resetSessionsForTest();
    }
});

test("deleteSessionArtifacts defers while a request is in-flight, then succeeds (#2935)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bc-2935-busy-"));
    _setStoreForTest(new SessionStore({ dir, debounceMs: 1 }));
    _resetSessionsForTest();
    try {
        const s = getSession("del-busy", { protocol: "anthropic", upstreamOrigin: "https://api.example.com" });
        s.inFlight = 1; // simulate an active request holding the session
        const busy = await deleteSessionArtifacts("del-busy");
        assert.equal(busy.deleted, false, "not deleted while busy");
        assert.equal(busy.deferred, true, "deferred while busy");
        assert.equal(busy.reason, "busy");
        assert.ok(peekSession("del-busy"), "still resident while busy");

        s.inFlight = 0;
        const done = await deleteSessionArtifacts("del-busy");
        assert.equal(done.deleted, true, "deleted once idle");
        assert.equal(peekSession("del-busy"), undefined, "resident dropped after idle");
    } finally {
        _resetSessionsForTest();
    }
});

type DeleteBody = { ok: boolean; conversationId?: string; deleted?: string[]; deferred?: string[]; error?: string };

type Rig = {
    proxyUrl: (p: string) => string;
    modelUrl: () => string;
    closeAll: () => Promise<void>;
};

async function startRig(): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(textScript());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetPluginStateForTest();
    _resetSessionsForTest();

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "l2935-model": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyUrl: (p) => `http://127.0.0.1:${proxyPort}${p}`,
        modelUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        closeAll: async () => {
            await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
            await new Promise<void>((resolve, reject) => upstream.close((e) => (e ? reject(e) : resolve())));
        },
    };
}

async function register(rig: Rig, conversationId: string): Promise<void> {
    const res = await fetch(rig.proxyUrl("/__bili/plugin/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, agent: "pi" }),
    });
    assert.equal(res.status, 200, "register accepted");
}

async function postDelete(rig: Rig, rawBody: string): Promise<{ status: number; body: DeleteBody }> {
    const res = await fetch(rig.proxyUrl("/__bili/plugin/delete"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawBody,
    });
    return { status: res.status, body: (await res.json()) as DeleteBody };
}

test("POST /__bili/plugin/delete: validation, host-session cleanup, fork cascade, sibling isolation (#2935)", async () => {
    const rig = await startRig();
    try {
        // --- validation (synchronous 400s) ---
        assert.equal((await postDelete(rig, "not json")).status, 400, "invalid JSON rejected");
        assert.equal((await postDelete(rig, "{}")).status, 400, "missing conversationId rejected");
        assert.equal((await postDelete(rig, JSON.stringify({ conversationId: "" }))).status, 400, "blank conversationId rejected");

        // --- unknown conversation: idempotent no-op, still 200 ---
        const none = await postDelete(rig, JSON.stringify({ conversationId: "never-existed" }));
        assert.equal(none.status, 200);
        assert.deepEqual(none.body.deleted, [], "nothing deleted for unknown conversation");
        assert.deepEqual(none.body.deferred, [], "nothing deferred for unknown conversation");

        // --- real host-created session: register + one model turn, then delete ---
        const before = new Set(listSessions().map((s) => s.id));
        await register(rig, "del-e2e");
        await fetch(rig.modelUrl(), {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-conversation": "del-e2e" },
            body: JSON.stringify({ model: "l2935-model", max_tokens: 8192, stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        const created = listSessions().find((s) => !before.has(s.id));
        assert.ok(created, "the model turn created a session bound to the conversation");

        const delHost = await postDelete(rig, JSON.stringify({ conversationId: "del-e2e" }));
        assert.equal(delHost.status, 200);
        assert.ok(delHost.body.deleted?.includes(created.id), "host session deleted by its conversation id");
        assert.equal(peekSession(created.id), undefined, "host session dropped from memory");

        // --- fork cascade + independent-sibling isolation (resident ids) ---
        getSession("conv-x", { protocol: "anthropic", upstreamOrigin: "https://api.example.com" });
        getSession("conv-x|sub:fp1", { protocol: "anthropic", upstreamOrigin: "https://api.example.com" });
        getSession("conv-y", { protocol: "anthropic", upstreamOrigin: "https://api.example.com" });

        const delX = await postDelete(rig, JSON.stringify({ conversationId: "conv-x" }));
        assert.equal(delX.status, 200);
        assert.ok(delX.body.deleted?.includes("conv-x"), "parent conversation deleted");
        assert.ok(delX.body.deleted?.includes("conv-x|sub:fp1"), "persona fork cascades with its parent");
        assert.ok(!delX.body.deleted?.includes("conv-y"), "independent sibling NOT deleted");
        assert.equal(peekSession("conv-x"), undefined, "parent gone from memory");
        assert.equal(peekSession("conv-x|sub:fp1"), undefined, "fork gone from memory");
        assert.ok(peekSession("conv-y"), "independent sibling survives");
    } finally {
        await rig.closeAll();
        _resetSessionsForTest();
        _resetPluginStateForTest();
    }
});
