// #2601 active-parent guard for persona-lineage following.
//
// The #2601 follow (host-stamped nativeCaller management call → live `|sub:`
// descendant) is correct when the RAW parent went FROZEN before the fork was
// born: the fork is the frozen parent's continuation, and the host keeps
// stamping the raw id, so its compress/decompress/acp_status refs can only
// live in the fork's namespace.
//
// It must NOT fire when the parent kept receiving turns AFTER the fork was
// created (parallel persona forks / subagent lanes sharing the base id):
// the parent is live and authoritative, its refs live in ITS namespace, and
// re-routing the host's calls into a fork's namespace is the "every ref is
// unknown to this session" breaker (#2601) in reverse — the exact incident
// shape of the dsh fusion-board report (11 consecutive compress failures,
// 8× cannot-anchor after persona re-routing).
//
// The discriminator is BIRTH ORDER: follow the fork only when the parent has
// seen NO traffic since the fork was minted — `fork.createdAt > parent.
// lastSeen` — not merely when the fork has newer traffic
// (`fork.lastSeen > parent.lastSeen`, the pre-fix rule, which also matches a
// STILL-ACTIVE parent whose parallel fork happens to be fresher).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Hermetic state dirs BEFORE importing the server modules (#7.2 / #2668).
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-e2e-active-parent-guard-"));
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
const { resetSessionOrderForTest } = await import("../src/session-resolve.ts");
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
/** Content-length string (≥32 chars post-normalization) so the normalized
 *  projection keeps the leaf, like real dsh turns. */
const long = (s: string): string => `${s}-` + "z".repeat(120);
const msgs = (n: number, tag: string): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: long(`${tag}-${i + 1}`) }));

type Rig = { baseUrl: string; chatUrl: string; proxy: http.Server; relay: http.Server };

function startRelay(): http.Server {
    // Deterministic fake openai upstream: every request gets a plain answer.
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
    resetSessionOrderForTest();
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
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.relay.close();
    rig.relay.closeIdleConnections?.();
    await once(rig.relay, "close");
}

async function dshTurn(rig: Rig, conv: string, system: string, history: { role: string; content: string }[]): Promise<void> {
    const res = await fetch(rig.chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv },
        body: JSON.stringify({ model: "gpt-test", max_tokens: 64_000, messages: [{ role: "system", content: system }, ...history] }),
    });
    assert.equal(res.status, 200, "dsh turn must succeed");
    await res.json();
}

test("#2601 active-parent guard: a frozen parent still follows the fork; an active parent stays authoritative", async () => {
    const rig = await startRig();
    const CONV = "dshc-active-parent";
    const FORK = forkKey(CONV, SYSTEM_B);
    try {
        // ── (1) #2601 legit shape, no regression: the parent goes FROZEN
        // before the fork is born → host-stamped calls follow the fork.
        await dshTurn(rig, CONV, SYSTEM_A, msgs(6, "main"));
        await dshTurn(rig, CONV, SYSTEM_B, msgs(3, "switched"));
        let fork = peekSession(FORK);
        assert.ok(fork, "the discontinuous switched turn forked onto |sub:");
        // peekSession, NOT getSession: getSession refreshes lastSeen (session.ts)
        // and would advance the parent past the fork's createdAt, breaking the
        // birth-order precondition the guard relies on.
        let parent = peekSession(CONV);
        assert.ok(parent, "the main session exists under the raw key");
        assert.ok((fork.createdAt ?? 0) > (parent.lastSeen ?? 0),
            "precondition: the fork was born after the parent's last traffic (frozen parent)");
        const out1 = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(out1.failed, false);
        assert.ok(out1.text.includes(FORK),
            "frozen-parent case still follows the live fork (#2601, no regression)");

        // ── (2) The incident shape: the parent kept receiving turns AFTER
        // the fork was created (parallel persona fork / subagent lane sharing
        // the base id), and the fork happens to be fresher. The pre-fix rule
        // (fork.lastSeen > parent.lastSeen) would redirect the host's call
        // into the fork's namespace → "every ref is unknown" → cannot-anchor.
        // Birth-order gate: fork.createdAt (earlier) > parent.lastSeen (after
        // the fork) is FALSE → the active parent stays authoritative.
        const base = Date.now();
        fork = peekSession(FORK)!;
        parent = peekSession(CONV)!;
        fork.createdAt = base - 30_000;  // fork born well before the parent's latest traffic
        parent.lastSeen = base - 10_000; // parent still receiving turns after the fork
        fork.lastSeen = base - 5_000;    // fork fresher than the parent (and fresh: < 10 min)
        const out2 = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(out2.failed, false);
        assert.ok(!out2.text.includes("|sub:"),
            "an active parent stays authoritative — no redirect into the parallel fork's namespace");
    } finally {
        await stopRig(rig);
    }
});
