// #5716: the hot-adoption guard's RESOLVER side is pinned in
// tests/hot-adoption-guard.test.ts; this file pins the two PLUGIN-PLANE gates
// that sit on top of the same evidence (src/plugin.ts): proxy-tool execution
// on a session a live peer is writing answers 409 naming the peer (the last
// write gate for memory-resident sessions), and disk adoption in
// resolveForkConversation refuses contested ids — an honest 404 instead of
// adopting and clobbering. The deliberate asymmetry is pinned too: a
// memory-resident session stays snapshot-servable even while hot, because its
// writes are already gated at the tool plane.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { setHotAdoptionProbe } from "../src/adoption-guard.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { type PluginToolDeps, _resetPluginStateForTest, handlePluginSnapshot, handlePluginTool } from "../src/plugin.ts";
import { getSession, type Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

function mockRes(): { res: http.ServerResponse; status(): number; body(): string } {
    let body = "";
    let status = 0;
    const res = {
        writeHead: (code: number) => { status = code; return undefined; },
        end: (chunk: unknown) => { body = String(chunk ?? ""); },
    } as unknown as http.ServerResponse;
    return { res, status: () => status, body: () => body };
}

function peer() {
    return { instanceId: "peer-x", pid: process.pid, origin: "stdio", version: "test", lane: "pi", servedAt: Date.now() };
}

describe("#5716: proxy tool execution refuses hot resident sessions with 409", () => {
    let deps: PluginToolDeps;
    let sessionId: string;

    beforeEach(() => {
        _resetPluginStateForTest();
        _setStoreForTest(new SessionStore({ enabled: false }));
        deps = { core: createCore(), config: defaultConfig(400_000), log: () => {} };
        sessionId = getSession(`t-hottool-${Math.random().toString(36).slice(2)}`).id;
    });

    afterEach(() => {
        setHotAdoptionProbe(undefined);
    });

    async function call(tool: string, args: Record<string, unknown> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
        const out = mockRes();
        await handlePluginTool(JSON.stringify({ conversationId: sessionId, tool, args }), out.res, deps);
        return { status: out.status(), json: JSON.parse(out.body()) as Record<string, unknown> };
    }

    it("read tool on a hot resident session → 409 naming the peer", async () => {
        setHotAdoptionProbe((sid) => sid === sessionId ? [peer()] : []);
        const r = await call("acp_status");
        assert.equal(r.status, 409);
        assert.equal(r.json.ok, false);
        assert.match(String(r.json.error), /another bili instance/);
        assert.match(String(r.json.error), /peer-x/);
    });

    it("write tool on a hot resident session → 409 before execution", async () => {
        setHotAdoptionProbe((sid) => sid === sessionId ? [peer()] : []);
        const r = await call("compress", { ranges: [] });
        assert.equal(r.status, 409);
        assert.match(String(r.json.error), /another bili instance/);
    });

    it("same session uncontested → executes normally", async () => {
        const r = await call("acp_status");
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true);
    });
});

function makeSession(id: string): Session {
    const s: Session = {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://upstream" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
    seedSnapshot(s);
    return s;
}

/** Give a session a minimal valid fork source: one core whose raw/ref mapping
 *  satisfies forkSnapshot's bidirectional invariant, so the snapshot plane can
 *  answer 200 instead of failing on an empty fixture. */
function seedSnapshot(s: Session): void {
    const rawId = `raw-${s.id}`;
    s.pluginSnapshot = [{ id: rawId, role: "user", contentType: "text", text: `seed ${s.id}` }];
    s.state.messageRefs.byRaw[rawId] = "m00001";
    s.state.messageRefs.byRef["m00001"] = rawId;
}

describe("#5716: disk adoption in resolveForkConversation refuses hot ids", () => {
    let dir: string;
    let store: SessionStore;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "bili-hotadopt-"));
        store = new SessionStore({ dir, debounceMs: 1, enabled: true, log: () => {} });
        _setStoreForTest(store);
        _resetPluginStateForTest();
    });

    afterEach(() => {
        setHotAdoptionProbe(undefined);
        store.cancelAll();
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmrf(dir);
    });

    it("disk-only contested session → honest 404, not an adoption", async () => {
        const id = `t-hotdisk-${Math.random().toString(36).slice(2)}`;
        await store.writeNow(makeSession(id));
        setHotAdoptionProbe((sid) => sid === id ? [peer()] : []);
        const out = mockRes();
        await handlePluginSnapshot(id, out.res);
        assert.equal(out.status(), 404);
        assert.equal((JSON.parse(out.body()) as Record<string, unknown>).code, "PARENT_NOT_FOUND");
    });

    it("disk-only uncontested session → adopted (reaches the fork plane, not the refusal)", async () => {
        const id = `t-hotdisk-${Math.random().toString(36).slice(2)}`;
        await store.writeNow(makeSession(id));
        const out = mockRes();
        await handlePluginSnapshot(id, out.res);
        // Adoption succeeded: the guard refusal answers 404 PARENT_NOT_FOUND;
        // reaching the fork plane with this fixture (whose disk record carries
        // no raw tail) answers 409 SNAPSHOT_UNAVAILABLE — pre-existing fork
        // behavior, unrelated to the guard. A regression that refused or broke
        // adoption lands back on 404/PARENT_NOT_FOUND.
        assert.notEqual(out.status(), 404);
        assert.notEqual((JSON.parse(out.body()) as Record<string, unknown>).code, "PARENT_NOT_FOUND");
        assert.equal(out.status(), 409);
        assert.equal((JSON.parse(out.body()) as Record<string, unknown>).code, "SNAPSHOT_UNAVAILABLE");
    });

    it("memory-resident session stays snapshot-servable while hot (writes gated at the tool plane)", async () => {
        const id = `t-hotdisk-${Math.random().toString(36).slice(2)}`;
        await store.writeNow(makeSession(id));
        seedSnapshot(getSession(id));
        setHotAdoptionProbe((sid) => sid === id ? [peer()] : []);
        const out = mockRes();
        await handlePluginSnapshot(id, out.res);
        assert.equal(out.status(), 200);
        const json = JSON.parse(out.body()) as Record<string, unknown>;
        assert.equal(json.ok, true);
        assert.equal(json.sessionId, id);
    });
});
