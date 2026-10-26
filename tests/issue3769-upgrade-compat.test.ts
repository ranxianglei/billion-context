// #3769 upgrade compatibility (owner merge condition): sessions persisted by a
// pre-fold-gate kernel carry their rotation-hidden orphan pairs ONLY in
// `hiddenOrphanRefs` (no sweptOrphanCallIds / pendingOrphanSweepMinRef). After
// upgrading, those pairs must stay hidden on the outbound history — resurrecting
// them re-inserts mid-history bytes and breaks the cached prefix again.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
// This suite is a full-mode story by design (its own comments: "since the
// #3818 full-mode default the index row IS the load path") — pin it so the
// CI runner's legacy storage baseline preload cannot flip the lane and turn
// the index-row load path into an un-probeable namespaced file (same
// discipline as the storage family; explicit env beats the preload's ??=).
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-upg-hermetic-")), "no-config.json");

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

const LABEL = "upg3769";
const ARG_JSON = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", topic: "upg", summary: "UPG_SUM_MARKER" }] });
const RESULT_TEXT = "UPG_RESULT_MARKER";

type M = Record<string, unknown>;

const u1: M = { role: "user", content: "q one alpha" };
const a1: M = { role: "assistant", content: "a one alpha" };
const u2: M = { role: "user", content: "q two beta" };
const a2: M = { role: "assistant", content: "a two beta" };
const pairCall: M = { role: "assistant", content: null, tool_calls: [{ id: "call_upg1", type: "function", function: { name: "compress", arguments: ARG_JSON } }] };
const pairResult: M = { role: "tool", tool_call_id: "call_upg1", content: RESULT_TEXT };
const u3: M = { role: "user", content: "q three gamma" };
const u4: M = { role: "user", content: "q four delta UPG_TAIL_MARKER" };

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

async function post(url: string, messages: M[], bodies: string[]): Promise<number> {
    const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": LABEL },
        body: JSON.stringify({ model: "gpt-test", messages, stream: true }),
    });
    void bodies;
    return r.status ?? 0;
}

type PersistRecord = {
    version: number;
    savedAt: number;
    id: string;
    payload: {
        meta: { label?: string };
        messages: { id: string; contentType?: string; toolName?: string; toolCallId?: string }[];
        state: { messageRefs: { byRaw: Record<string, string> }; hiddenOrphanRefs?: string[]; sweptOrphanCallIds?: string[]; pendingOrphanSweepMinRef?: number };
    };
};

function findSessionFile(root: string, label: string): string {
    const stack = [root];
    while (stack.length > 0) {
        const d = stack.pop()!;
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) {
                stack.push(p);
            } else if (e.name.endsWith(".json") && !e.name.endsWith(".content-store.json")) {
                try {
                    const rec = JSON.parse(readFileSync(p, "utf8")) as PersistRecord;
                    if (rec.id === label || rec.payload?.meta?.label === label) return p;
                } catch { /* not our file */ }
            }
        }
    }
    throw new Error(`no session file for ${label} under ${root}`);
}

test("upgraded pre-fold-gate state keeps rotation-hidden orphans hidden end-to-end (#3769)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-upg-store-"));
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            const n = bodies.length;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: `ok ${n}` } }] }));
            res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upPort = (upstream.address() as { port: number }).port;

    const stores: SessionStore[] = [];
    const proxies: http.Server[] = [];
    const closedProxies = new Set<http.Server>();
    async function closeProxy(p: http.Server): Promise<void> {
        if (closedProxies.has(p)) return;
        closedProxies.add(p);
        p.close();
        p.closeIdleConnections?.();
        await once(p, "close").catch(() => undefined);
    }
    try {
        // Phase 1: current code runs two turns; the failed pair rides visibly
        // (fold-gated contract: no fold -> no sweep) and the record lands on disk.
        const store1 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        stores.push(store1);
        _setStoreForTest(store1);
        _resetSessionsForTest();
        setRegistryForTest({});
        const proxy1 = await startServer({
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upPort}`]: { models: { "gpt-test": { context: 15_000 } } } },
            modelContextLimit: 15_000,
            kernelConfig: defaultConfig(15_000),
            compress: { injectTool: true, injectNudge: true },
            sessionHeader: "x-acp-session",
            passthrough: false,
            passthroughSource: null,
            autoUpdate: false,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: true,
            releaseNotesCheck: true,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            mitm: { enabled: false, domains: [] },
        } as unknown as ProxyOptions);
        await once(proxy1, "listening");
        proxies.push(proxy1);
        const port1 = (proxy1.address() as { port: number }).port;
        const url1 = `http://127.0.0.1:${port1}/bili/http://127.0.0.1:${upPort}/v1/chat/completions`;

        assert.equal(await post(url1, [u1, a1, u2, a2], bodies), 200);
        assert.equal(await post(url1, [u1, a1, u2, a2, { role: "assistant", content: "ok 1" }, pairCall, pairResult, u3], bodies), 200);
        // New-code baseline: without a fold the pair stays visible outbound.
        assert.ok(bodies[bodies.length - 1]!.includes("UPG_SUM_MARKER"), "pre-upgrade baseline: failed pair rides visibly");

        const s1 = listSessions().find((x) => x.meta.label === LABEL);
        assert.ok(s1, "session exists");
        assert.ok(store1.flushSync(s1!));
        await closeProxy(proxy1);

        // Phase 2: a fresh store hydrates the record, then shapes it into
        // what a pre-fold-gate kernel left behind — rotation had hidden the
        // pair (remembered by ref), new sweep fields absent. Refs are read
        // off the dual-written envelope; the mutation itself goes THROUGH THE
        // STORE: since the #3818 full-mode default the index row IS the load
        // path, so patching only the envelope would leave a stale row the
        // loader serves instead.
        _resetSessionsForTest();
        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        stores.push(store2);
        _setStoreForTest(store2);

        const file = findSessionFile(dir, LABEL);
        const rec = JSON.parse(readFileSync(file, "utf8")) as PersistRecord;
        const callMsg = rec.payload.messages.find((m) => m.contentType === "tool-call" && m.toolName === "compress");
        const resMsg = rec.payload.messages.find((m) => m.contentType === "tool-result" && m.toolCallId === "call_upg1");
        assert.ok(callMsg && resMsg, "record snapshot carries the failed pair");
        const callRef = rec.payload.state.messageRefs.byRaw[callMsg!.id];
        const resRef = rec.payload.state.messageRefs.byRaw[resMsg!.id];
        assert.ok(callRef && resRef, "refs resolvable from the persisted state");
        const sPre = store2.loadSync(LABEL);
        assert.ok(sPre, "record hydrates before the upgrade turn");
        sPre.state.hiddenOrphanRefs = [callRef, resRef];
        delete sPre.state.sweptOrphanCallIds;
        delete sPre.state.pendingOrphanSweepMinRef;
        assert.ok(store2.flushSync(sPre), "patched record commits through the store");
        const proxy2 = await startServer({
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upPort}`]: { models: { "gpt-test": { context: 15_000 } } } },
            modelContextLimit: 15_000,
            kernelConfig: defaultConfig(15_000),
            compress: { injectTool: true, injectNudge: true },
            sessionHeader: "x-acp-session",
            passthrough: false,
            passthroughSource: null,
            autoUpdate: false,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: true,
            releaseNotesCheck: true,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            mitm: { enabled: false, domains: [] },
        } as unknown as ProxyOptions);
        await once(proxy2, "listening");
        proxies.push(proxy2);
        const port2 = (proxy2.address() as { port: number }).port;
        const url2 = `http://127.0.0.1:${port2}/bili/http://127.0.0.1:${upPort}/v1/chat/completions`;

        const hist3: M[] = [u1, a1, u2, a2, { role: "assistant", content: "ok 1" }, pairCall, pairResult, u3, { role: "assistant", content: "ok 2" }, u4];
        assert.equal(await post(url2, hist3, bodies), 200);
        const out = bodies[bodies.length - 1]!;
        assert.ok(!out.includes("UPG_SUM_MARKER"), "upgrade: hidden compress args do not resurface");
        assert.ok(!out.includes("UPG_RESULT_MARKER"), "upgrade: hidden result does not resurface");
        assert.ok(out.includes("UPG_TAIL_MARKER"), "live tail rides normally");

        const s2 = listSessions().find((x) => x.meta.label === LABEL);
        assert.ok(s2, "hydrated session exists");
        assert.ok(s2.state.hiddenOrphanRefs?.includes(callRef!), "legacy hidden set survived hydration and self-perpetuates");
        await closeProxy(proxy2);
    } finally {
        for (const s of stores) s.closeQuietly();
        for (const p of proxies) await closeProxy(p);
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close").catch(() => undefined);
        _setStoreForTest(new SessionStore({ enabled: false }));
        void rmrf(dir);
    }
});
