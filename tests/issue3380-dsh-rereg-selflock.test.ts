// #3380: plugin tool registration state self-lock.
//
// Incident (bili v0.1.197, DSH desktop): a healthy session lost its proxy at
// runtime; the respawn gave up once (onGiveUp), which cleared BOTH
// register.base AND register.toolsReady. Tools had been registered into the
// host process's tool layer hours earlier and survived the proxy death — so
// every later re-registration attempt threw DSH's duplicate error
// ('tool "compress" is already registered'), the retry loop burned the same
// doomed failure 145×/h on a flat 10s wall, toolsReady stayed false forever,
// headersFor stopped stamping x-bili-plugin*, and every model request rode
// bili anonymously (wire mode → zero-fold pfa-* ledgers → 413
// preflight_compress_failed on large sessions) until the host restarted.
//
// Root cause: conflation of two lifecycles — tool registrations belong to the
// HOST CONTEXT (they die only with their context; execute closures read the
// live base, #983), while the proxy-death paths treated them as proxy-owned.
// Fix under test:
//   1. proxy-death paths no longer clear toolsReady (identity survives a
//      respawn; NO doomed re-registration ever runs again);
//   2. registration is idempotent — a name this process already holds is
//      adopted, not thrown on (converges partial/dirty states);
//   3. consecutive failures escalate: capped exponential back-off + one loud
//      notice with the recovery action (retries never stop — #983/#2082);
//   4. /acp exposes wire-mode identity loss instead of staying silent.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
    apply,
    maybeRetryForTest,
    _resetRegisterForTest,
    _setSpawnForTest,
    _settleNativeForTest,
    _stateHeadersForTest,
    _stateOnGiveUpForTest,
    _registerStateForTest,
    _regBackoffForTest,
    type PluginContext,
} from "../src/agent/dsh-native.ts";
import { rmrf } from "./tmp-rm.ts";

// The node:test runner sets NODE_TEST_CONTEXT itself; set defensively so a
// standalone file run behaves identically (dsh-native reads it lazily).
process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT ?? "1";
process.env.BILI_PERSIST = "0";
delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PROXY;

afterEach(() => { void _settleNativeForTest(); });

type RegisteredTool = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: { agent?: { session?: { id?: unknown } }; signal?: AbortSignal }) => Promise<unknown>;
};
type CommandSpec = {
    name: string;
    description?: string;
    handler: (invocation?: { agent?: { session?: { id?: unknown } } }) => Promise<{ kind: string; text: string }>;
};

// DSH's root tool layer: ONE registry per host process. Re-registering a name
// this process already holds throws the verbatim incident error — this is
// exactly what turned #3380's post-respawn re-registration into a self-lock.
const rootLayer = new Map<string, boolean>();
const DSH_DUP_ERROR = (name: string): Error =>
    new Error(`tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`);

function resetRootLayer(): void {
    rootLayer.clear();
}

async function startMockProxy(toolNames: string[]): Promise<{ origin: string; close: () => void; manifestRequests: () => number }> {
    const counters = { manifestRequests: 0 };
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            counters.manifestRequests += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                version: "0.1.119",
                tools: { anthropic: toolNames.map((name) => ({ name, description: `${name} (test)`, input_schema: { type: "object", properties: {} } })) },
            }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    return {
        origin: `http://127.0.0.1:${addr.port}`,
        close: () => { server.close(); server.closeAllConnections?.(); },
        manifestRequests: () => counters.manifestRequests,
    };
}

type HostCtx = Parameters<typeof apply>[0];

function mockCtx(opts: { registerError?: () => Error | undefined } = {}) {
    const tools: RegisteredTool[] = [];
    const commands: CommandSpec[] = [];
    let initiator: { session?: { id?: unknown } } | undefined = undefined;
    return {
        tools: {
            register: (t: RegisteredTool) => {
                const err = opts.registerError?.();
                if (err !== undefined) throw err;
                if (rootLayer.has(t.name)) throw DSH_DUP_ERROR(t.name);
                rootLayer.set(t.name, true);
                tools.push(t);
            },
        },
        commands: { register: (c: CommandSpec) => commands.push(c) },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
        inject: (_deps: readonly string[], _cb: (sub: HostCtx) => void) => {},
    };
}

function mockCtxTyped(ctx: ReturnType<typeof mockCtx>): PluginContext {
    return ctx as unknown as PluginContext;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        const v = env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 15000;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

function logFileOf(home: string): string {
    return path.join(home, "billion-context", "bili.log");
}

test("#3380 incident repro: identity survives proxy death + respawn — no doomed re-registration ever runs", async () => {
    const proxyA = await startMockProxy(["compress", "decompress"]);
    const proxyB = await startMockProxy(["compress", "decompress"]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3380-incident-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3380-incident-state-"));
    try {
        // grace window shrunk so the dead-attach probe falls through to the
        // spawn seam quickly instead of waiting the production evidence grace
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxyA.origin, BILI_ATTACH_EVIDENCE_GRACE_MS: "50", XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(undefined);
            resetRootLayer();
            const raw = mockCtx();
            const ctx = mockCtxTyped(raw);
            raw.setInitiator({ session: { id: "i3380" } });
            apply(ctx);
            await waitFor(() => rootLayer.size === 2, "initial registration");
            const h1 = _stateHeadersForTest()?.("http://example.test/v1/messages");
            assert.equal(h1?.["x-bili-plugin"], "dsh", "phase 1: identity stamped");
            assert.equal(h1?.["x-bili-plugin-conversation"], "i3380");

            // Phase 2: the proxy dies and its respawn gives up. Old code
            // cleared toolsReady here — the self-lock's ignition.
            proxyA.close();
            const giveUp = _stateOnGiveUpForTest();
            assert.ok(giveUp !== undefined, "give-up seam armed by the attach plan");
            giveUp!();
            await _settleNativeForTest();
            assert.equal(_registerStateForTest().base, undefined, "the origin is gone");
            assert.equal(_registerStateForTest().toolsReady, true, "the latch SURVIVES proxy death (registrations belong to the host context)");

            // Phase 3: a NEW origin lands through the respawn seam.
            _setSpawnForTest(async () => proxyB.origin);
            try {
                maybeRetryForTest(ctx);
                await waitFor(() => _registerStateForTest().base === proxyB.origin, "respawn landing on the new origin");
                assert.equal(proxyB.manifestRequests(), 0, "NO doomed re-registration flight ran against the new proxy");
                assert.equal(rootLayer.size, 2, "no duplicate registration reached the host tool layer");
                const h2 = _stateHeadersForTest()?.("http://example.test/v1/messages");
                assert.equal(h2?.["x-bili-plugin"], "dsh", "identity restored on the new origin without re-registration");
                assert.equal(h2?.["x-bili-plugin-conversation"], "i3380", "same conversation identity carried across the respawn");
            } finally {
                _setSpawnForTest(undefined);
            }
        });
    } finally {
        proxyA.close();
        proxyB.close();
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
        resetRootLayer();
    }
});

test("#3380 idempotent adoption: a pre-existing registration is adopted, the rest still lands", async () => {
    const proxy = await startMockProxy(["compress", "decompress"]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3380-adopt-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3380-adopt-state-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(undefined);
            resetRootLayer();
            // Dirty state: an earlier interrupted flight left "compress" held
            // in the process's tool layer.
            rootLayer.set("compress", true);
            const raw = mockCtx();
            const ctx = mockCtxTyped(raw);
            raw.setInitiator({ session: { id: "i3380-adopt" } });
            apply(ctx);
            await waitFor(() => _registerStateForTest().toolsReady, "registration converges despite the held name");
            assert.ok(rootLayer.has("compress") && rootLayer.has("decompress"), "both tools present in the host layer");
            assert.equal(raw.registeredTools.length, 1, "only the missing tool was registered fresh");
            const h = _stateHeadersForTest()?.("http://example.test/v1/messages");
            assert.equal(h?.["x-bili-plugin"], "dsh", "plugin mode restored after adoption");
            await waitFor(() => fs.existsSync(logFileOf(stateHome)) && fs.readFileSync(logFileOf(stateHome), "utf8").includes("adopted 1 pre-existing registration"), "adoption convergence logged once");
        });
    } finally {
        proxy.close();
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
        resetRootLayer();
    }
});

test("#3380 P2 back-off schedule: capped exponential, streak resets on success", async () => {
    const saved = process.env.BILI_DSH_RETRY_INTERVAL_MS;
    process.env.BILI_DSH_RETRY_INTERVAL_MS = "20";
    try {
        assert.equal(_regBackoffForTest(1), 20, "first failure: base interval");
        assert.equal(_regBackoffForTest(2), 40, "second failure: doubled");
        assert.equal(_regBackoffForTest(3), 80, "third failure: doubled again");
        const plateau = _regBackoffForTest(100);
        assert.equal(plateau, 5 * 60 * 1000, "hard cap at 5 minutes");
        assert.equal(_regBackoffForTest(101), plateau, "stays capped");
    } finally {
        if (saved === undefined) delete process.env.BILI_DSH_RETRY_INTERVAL_MS;
        else process.env.BILI_DSH_RETRY_INTERVAL_MS = saved;
    }
});

test("#3380 P2 integration: failures escalate on the ladder, then heal clean", async () => {
    const proxy = await startMockProxy(["compress"]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3380-backoff-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3380-backoff-state-"));
    const savedInterval = process.env.BILI_DSH_RECOVERY_INTERVAL_MS;
    const savedRetry = process.env.BILI_DSH_RETRY_INTERVAL_MS;
    process.env.BILI_DSH_RECOVERY_INTERVAL_MS = "20";
    process.env.BILI_DSH_RETRY_INTERVAL_MS = "20";
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(undefined);
            resetRootLayer();
            let failing = true;
            const raw = mockCtx({ registerError: () => (failing ? new Error("manifest down (transient)") : undefined) });
            const ctx = mockCtxTyped(raw);
            apply(ctx);
            // Third consecutive failure arms the third ladder step (4×base).
            await waitFor(() => _registerStateForTest().failStreak >= 3, "three consecutive failures");
            const snap = _registerStateForTest();
            assert.equal(snap.lastRegistrationError, "manifest down (transient)", "last error recorded for status surfaces");
            const delta = snap.retryAt - Date.now();
            assert.ok(delta >= 30 && delta <= 95, `retryAt sits on the 80ms ladder step (got ${delta}ms)`);
            // Heal: the transient fault clears, the next attempt succeeds, and
            // the bookkeeping resets.
            failing = false;
            await waitFor(() => _registerStateForTest().toolsReady, "heal after the fault clears");
            const healed = _registerStateForTest();
            assert.equal(healed.failStreak, 0, "streak resets on success");
            assert.equal(healed.lastRegistrationError, undefined, "stale error cleared");
        });
    } finally {
        for (const [k, v] of [["BILI_DSH_RECOVERY_INTERVAL_MS", savedInterval], ["BILI_DSH_RETRY_INTERVAL_MS", savedRetry]] as const) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        proxy.close();
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
        resetRootLayer();
    }
});

test("#3380 P2 notice: exactly one loud restart hint across a long failure streak", async () => {
    const proxy = await startMockProxy(["compress"]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3380-notice-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3380-notice-state-"));
    const savedInterval = process.env.BILI_DSH_RECOVERY_INTERVAL_MS;
    const savedRetry = process.env.BILI_DSH_RETRY_INTERVAL_MS;
    process.env.BILI_DSH_RECOVERY_INTERVAL_MS = "20";
    process.env.BILI_DSH_RETRY_INTERVAL_MS = "20";
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(undefined);
            resetRootLayer();
            const raw = mockCtx({ registerError: () => new Error("manifest down (persistent)") });
            apply(mockCtxTyped(raw));
            const MARKER = "bili tools still unavailable after";
            await waitFor(() => {
                if (_registerStateForTest().failStreak < 7) return false;
                const log = fs.existsSync(logFileOf(stateHome)) ? fs.readFileSync(logFileOf(stateHome), "utf8") : "";
                return log.split(MARKER).length - 1 >= 1;
            }, "streak past the notice threshold with the notice logged");
            const log = fs.readFileSync(logFileOf(stateHome), "utf8");
            assert.equal(log.split(MARKER).length - 1, 1, "the notice fires exactly once, not per attempt");
            assert.ok(log.includes("Restart dsh to restore"), "carries the recovery action");
            assert.ok(log.includes("manifest down (persistent)"), "carries the last error");
        });
    } finally {
        for (const [k, v] of [["BILI_DSH_RECOVERY_INTERVAL_MS", savedInterval], ["BILI_DSH_RETRY_INTERVAL_MS", savedRetry]] as const) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        proxy.close();
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
        resetRootLayer();
    }
});

test("#3380 P3 /acp: wire-mode identity loss is exposed, not silent", async () => {
    const proxy = await startMockProxy(["compress"]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3380-acp-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3380-acp-state-"));
    const savedInterval = process.env.BILI_DSH_RECOVERY_INTERVAL_MS;
    const savedRetry = process.env.BILI_DSH_RETRY_INTERVAL_MS;
    process.env.BILI_DSH_RECOVERY_INTERVAL_MS = "20";
    process.env.BILI_DSH_RETRY_INTERVAL_MS = "20";
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(undefined);
            resetRootLayer();
            let failing = true;
            const raw = mockCtx({ registerError: () => (failing ? new Error("manifest down (transient)") : undefined) });
            const ctx = mockCtxTyped(raw);
            apply(ctx);
            const acp = raw.registeredCommands.find((c) => c.name === "acp");
            assert.ok(acp !== undefined, "acp command registered");
            const invocation = { agent: { session: { id: "i3380-acp" } } };

            // (a) proxy answers but tools are down → wire-mode warning.
            await waitFor(() => _registerStateForTest().failStreak >= 1, "first registration failure");
            const wire = await acp!.handler(invocation);
            assert.equal(wire.kind, "success");
            assert.ok(wire.text.includes("WITHOUT identity headers (wire mode"), "wire-mode loss named explicitly");
            assert.ok(wire.text.includes("manifest down (transient)"), "last error surfaced");
            assert.ok(wire.text.includes("Restart dsh to restore"), "recovery action surfaced");

            // (b) heal, then lose the proxy entirely → recovering, not "install".
            failing = false;
            await waitFor(() => _registerStateForTest().toolsReady, "heal");
            proxy.close();
            const giveUp = _stateOnGiveUpForTest();
            assert.ok(giveUp !== undefined);
            giveUp!();
            await _settleNativeForTest();
            const out = await acp!.handler(invocation);
            assert.equal(out.kind, "error");
            assert.ok(out.text.includes("proxy temporarily unreachable"), "a previously-serving proxy reads as an outage with recovery running");
            assert.ok(!out.text.includes("no proxy detected — install"), "not misread as a missing install");
        });
    } finally {
        for (const [k, v] of [["BILI_DSH_RECOVERY_INTERVAL_MS", savedInterval], ["BILI_DSH_RETRY_INTERVAL_MS", savedRetry]] as const) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        proxy.close();
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
        resetRootLayer();
    }
});
