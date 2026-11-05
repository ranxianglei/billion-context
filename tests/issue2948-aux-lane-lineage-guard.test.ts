// #2948: livePersonaDescendant picked its target on freshness + traffic alone,
// so a host-stamped management call (compress/decompress/acp_status) was
// redirected onto a `|sub:` descendant that carries PERPETUAL traffic but
// rendered nothing — the dsh auto-review aux lane (fixed system prompt + a
// fresh flattened blob before every tool call): stats.requests bumped every
// turn, kernel state untouched, ref registry permanently empty. Every
// redirected compress then died with "every ref is unknown to this session"
// (`highest ref=none`) — manual compression dead for the whole conversation
// while auto-fold kept working on the parent (silent failure). Production
// proof: same session, bili 0.1.192 → 3× outcome=applied; 0.1.195 (first with
// livePersonaDescendant) → 13× highest-ref=none, all behind the redirect log
// line naming the aux fork.
// Fix under test: personaDescendantsOf now requires candidates to HOLD REFS
// (non-empty state.messageRefs.byRef). Consequences pinned below:
//   A. a ref-less fresh descendant is never followed (the incident shape);
//   B. a REAL ref-holding fork is STILL followed even when a ref-less aux
//      lane is fresher than it (filter-then-pick; #2601 preserved).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Hermetic state dirs BEFORE importing the server modules (same discipline as
// issue2601-persona-fork-lineage.test.ts).
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-e2e-2948-aux-guard-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

// Imported AFTER the XDG env above.
const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { resetToolRingForTest } = await import("../src/tool-ring.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { forwardTool } = await import("../src/agent/shared.ts");
const { getSession, peekSession, _resetSessionsForTest } = await import("../src/session.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const SYSTEM_A = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-A.\nWorkspace: /tmp.";
const SYSTEM_B = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-B.\nWorkspace: /tmp.";
const forkKey = (conv: string, system: string): string =>
    `${conv}|sub:${createHash("sha256").update(system, "utf8").digest("hex").slice(0, 16)}`;
const long = (s: string): string => `${s}-` + "z".repeat(120);
const msgs = (n: number, tag: string): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: long(`${tag}-${i + 1}`) }));

type Rig = { baseUrl: string; chatUrl: string; proxy: http.Server; relay: http.Server };

function startRelay(): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "r1", object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "plain reply" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5 },
            }));
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

async function startRig(): Promise<Rig> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    resetToolRingForTest();
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const relay = startRelay();
    await once(relay, "listening");
    const relayPort = (relay.address() as { port: number }).port;
    const opts = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${relayPort}`]: { models: { "gpt-test": { context: 1_000_000 } }, compressProtocol: "marker" } },
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {}),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as unknown as Parameters<typeof startServer>[0];
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        baseUrl: `http://127.0.0.1:${proxyPort}`,
        chatUrl: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`,
        proxy,
        relay,
    };
}

async function stopRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.relay.close();
    await once(rig.relay, "close");
}

async function dshTurn(rig: Rig, system: string, history: { role: string; content: string }[], conv: string): Promise<void> {
    const res = await fetch(rig.chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv },
        body: JSON.stringify({ model: "gpt-test", max_tokens: 64_000, messages: [{ role: "system", content: system }, ...history] }),
    });
    assert.equal(res.status, 200, "dsh turn must succeed");
    await res.json();
}

/** Seed a resident `|sub:` descendant exactly as the production aux lane
 *  presents itself: carried traffic, strictly newer lastSeen than everything
 *  else in the lineage — but zero refs (kernel state never touched). */
function seedAuxLane(id: string, requests: number, lastSeen: number): void {
    const s = getSession(id);
    s.stats.requests = requests;
    s.lastSeen = lastSeen;
    assert.deepEqual(Object.keys(s.state.messageRefs.byRef), [], "seeded aux lane holds no refs");
}

test("#2948 e2e: a ref-less aux lane with perpetual traffic is never a lineage target", async () => {
    const rig = await startRig();
    const CONV = "dshc-2948-a";
    const AUX = `${CONV}|sub:auxdeadbeef0000`;
    try {
        // Main conversation under the raw key — the parent holds refs.
        await dshTurn(rig, SYSTEM_A, msgs(6, "main"), CONV);
        const parent = peekSession(CONV);
        assert.ok(parent, "parent session exists under the raw key");
        assert.ok(Object.keys(parent.state.messageRefs.byRef).length > 0, "the parent rendered messages and holds refs");

        // The aux lane: fresher than the parent, heavy traffic, no refs.
        seedAuxLane(AUX, 1574, Date.now() + 50);

        // Pre-fix, this candidate satisfied EVERY selection criterion
        // (prefix match + requests > 0 + fresh + strictly newer) — the guard
        // is what keeps it out, not any other filter.
        const out = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(out.failed, false, "the management call itself succeeds");
        assert.ok(!out.text.includes("|sub:"), "no redirect into the ref-less aux lane — served by the parent");
        assert.ok(!out.text.includes(AUX), "the aux lane's id never reaches the receipt");
    } finally {
        await stopRig(rig);
    }
});

test("#2948 e2e: a ref-holding fork still wins over a fresher ref-less aux lane (#2601 preserved)", async () => {
    const rig = await startRig();
    const CONV = "dshc-2948-b";
    const FORK = forkKey(CONV, SYSTEM_B);
    const AUX = `${CONV}|sub:auxdeadbeef0001`;
    try {
        // Legitimate persona fork: model switch with DISCONTINUOUS history
        // (the #2601 shape) — the fork renders real turns and holds refs.
        await dshTurn(rig, SYSTEM_A, msgs(6, "main"), CONV);
        await dshTurn(rig, SYSTEM_B, msgs(3, "switched"), CONV);
        const fork = peekSession(FORK);
        assert.ok(fork, "the discontinuous switch forked onto |sub:");
        assert.ok(Object.keys(fork.state.messageRefs.byRef).length > 0, "the real fork holds refs");

        // The production configuration: the aux lane is FRESHER than the real
        // fork (its blob fires before every tool call of the live turn).
        seedAuxLane(AUX, 4096, (fork.lastSeen ?? 0) + 50);

        // Filter-then-pick: the ref-holding sibling must win over the fresher
        // ref-less one. Pre-fix this routed to AUX and every compress died
        // with "every ref is unknown to this session".
        const out = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(out.failed, false, "the management call succeeds");
        assert.ok(out.text.includes(FORK), "the host-stamped call is served from the ref-holding fork");
        assert.ok(!out.text.includes(AUX), "the fresher ref-less aux lane is not selected");
    } finally {
        await stopRig(rig);
    }
});
