// #5072 — stale-client "RESTART THE HOST PROCESS" signal (Option A items 1+2).
// Incident: a long-lived pi process holds bili v0.1.208 in memory while the
// disk/proxy build self-updated to v0.1.209. Every recovery path hits the same
// fingerprint gate (attach refused, rotation needs strictly-newer, adopt needs
// compatible, spawn exits 3 twin-collision) and the old behavior was silent:
// model traffic went direct uncompressed until it slammed the upstream window.
// This file pins: the terminal error's full element set (case 1), the same-build
// control (case 2), the pi-lane visibility surface (case 7, positive+negative),
// and the proxy-mode zero-diff regression (case 9). The rotation/adoption
// boundary decisions around the signal (cases 3-6) live in tests/launcher.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { ensureProxyRunning, STALE_CLIENT_RESTART_SIGNAL, type SpawnChild } from "../src/launcher.ts";
import type { ProxyInstanceFile as InstanceFile } from "../src/instance.ts";
import { VERSION } from "../src/version.ts";
import { defaultLogFile } from "../src/paths.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetForTest as niReset, installNativeFetchIntercept, type NativeInterceptState } from "../src/agent/native-intercept.ts";
import { _bootstrapForTest, _resetNativeStateForTest, _setEnsureProxyForTest, _staleClientFlagForTest } from "../src/agent/pi-native.ts";
import { rmrf } from "./tmp-rm.ts";

// --- hermetic fixtures -------------------------------------------------------

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp5072-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

function holder(over: Partial<InstanceFile> = {}): InstanceFile {
    return {
        origin: "http://127.0.0.1:8787",
        instanceId: "inst-5072",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 8787,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: FP_HASH,
        ...over,
    };
}

function fastExit(code: number): SpawnChild {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
        pid: 42423,
        unref() {},
        kill() {
            return true;
        },
        on(event, listener) {
            const list = handlers.get(event) ?? [];
            list.push(listener);
            handlers.set(event, list);
            // synchronous emit: the death lands before the spawn poll loop's
            // first tick, so the terminal path is reached without burning SPAWN_WAIT_MS
            if (event === "exit") listener(code, null);
        },
    };
}

function virtualClock() {
    let ticks = 0;
    return { now: () => ticks * 1000, sleep: async () => { ticks += 10; } };
}

async function withIso(run: () => Promise<void>): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5072-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    const prevXdgData = process.env.XDG_DATA_HOME;
    const prevXdgState = process.env.XDG_STATE_HOME;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
    try {
        await run();
    } finally {
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdgConfig;
        if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevXdgData;
        if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdgState;
    }
}

// --- case 1: the incident terminal -------------------------------------------

test("#5072 case 1: stale-client terminal error carries every evidence element (refusal + restart directive + version)", async () => {
    await withIso(async () => {
        const diag: string[] = [];
        const mismatched = holder({ lane: "pi", codeFingerprint: "deadbeef" });
        const clock = virtualClock();
        let thrown: unknown;
        try {
            await ensureProxyRunning(
                { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
                {
                    scriptPath: FP_SCRIPT,
                    readInstanceFile: () => mismatched,
                    listAdoptCandidates: () => [mismatched],
                    fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-5072", pid: process.pid, watchdog: { armed: true } }),
                    fetchDetailImpl: async () => ({ ok: false, detail: "ECONNREFUSED" }),
                    spawnImpl: () => fastExit(3),
                    registerWatcher: async () => "ok",
                    attachDiag: (m: string) => diag.push(m),
                    now: clock.now,
                    sleep: clock.sleep,
                },
            );
            throw new Error("expected ensureProxyRunning to reject");
        } catch (e) {
            thrown = e;
        }
        const err = thrown instanceof Error ? thrown : new Error(String(thrown));
        for (const needle of [
            STALE_CLIENT_RESTART_SIGNAL,
            "code-fingerprint-mismatch",
            `v${VERSION}`,
            "#5072 stale client",
            "compression is DISABLED for this host process",
        ]) {
            assert.ok(err.message.includes(needle), `terminal error missing ${JSON.stringify(needle)}:\n${err.message}`);
        }
        assert.match(err.message, /code 3 \(twin-collision signal\)/, err.message);
        // evidence source (i): each candidate's skip reason must be recorded in
        // the diagnostic stream where the evidence triple is re-judged
        assert.ok(diag.some((m) => m.includes("native-attach: skip") && m.includes("code-fingerprint-mismatch")), `diag lost the skip reason: ${JSON.stringify(diag)}`);
    });
});

// --- case 2: same-build control (negative direction) -------------------------

test("#5072 case 2: an identical-build lane owner attaches cleanly — no refusal, no restart signal anywhere", async () => {
    await withIso(async () => {
        const diag: string[] = [];
        let spawnCalls = 0;
        const compatible = holder({ lane: "pi" });
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi", parentPid: 42424 },
            {
                scriptPath: FP_SCRIPT,
                readInstanceFile: () => compatible,
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-5072", pid: process.pid, watchdog: { armed: true } }),
                spawnImpl: () => { spawnCalls++; return fastExit(3); },
                registerWatcher: async () => "ok",
                attachDiag: (m: string) => diag.push(m),
            },
        );
        assert.equal(handle.attached, true);
        assert.equal(handle.origin, compatible.origin);
        assert.equal(spawnCalls, 0, "a same-build twin is attached, never re-spawned");
        assert.ok(!diag.some((m) => m.includes("code-fingerprint-mismatch")), `unexpected refusal in control group: ${JSON.stringify(diag)}`);
        assert.ok(!diag.some((m) => m.includes(STALE_CLIENT_RESTART_SIGNAL)), `restart signal fired in control group: ${JSON.stringify(diag)}`);
        const logPath = defaultLogFile();
        const logBody = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
        assert.ok(!logBody.includes(STALE_CLIENT_RESTART_SIGNAL), "log picked up a spurious restart signal");
    });
});

// --- case 7: pi-lane visibility (positive + negative) ------------------------

test("#5072 case 7a: pi bootstrap catch routes a stale-client error to the restart wording and the tagged degrade reason", async () => {
    await withIso(async () => {
        const savedFetch = globalThis.fetch;
        _resetNativeStateForTest();
        // The exact shape the launcher's terminal throw produces (all elements).
        const staleMsg = `bili: proxy child exited before becoming healthy (code 3 (twin-collision signal)) — (#5072 stale client: every live pi candidate was refused for code-fingerprint-mismatch while the exited child's twin signal proves the serving holder matches the CURRENT disk script — this process loaded v${VERSION} while the disk build differs ⇒ compression is DISABLED for this host process; ${STALE_CLIENT_RESTART_SIGNAL} so it reloads the updated plugin — model requests go direct (uncompressed) until then)`;
        try {
            _setEnsureProxyForTest(async () => { throw new Error(staleMsg); });
            const origin = await (await _bootstrapForTest())();
            assert.equal(origin, undefined, "a failed bootstrap hands out no origin");
            assert.equal(_staleClientFlagForTest(), true, "the flag marking later degrades must be set");
            const log = fs.readFileSync(defaultLogFile(), "utf8");
            for (const needle of ["[native-client]", "STALE CLIENT", STALE_CLIENT_RESTART_SIGNAL, "code-fingerprint-mismatch"]) {
                assert.ok(log.includes(needle), `host event log missing ${JSON.stringify(needle)}:\n${log}`);
            }
            // Subsequent degraded dispatches carry the tagged reason.
            const calls: string[] = [];
            globalThis.fetch = (async (_input: unknown) => { calls.push("direct"); return new Response("{}", { status: 200 }); }) as typeof fetch;
            niReset({ anchor: savedFetch });
            const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined), staleClientRestartRequired: true };
            assert.equal(installNativeFetchIntercept(state), true);
            await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
            assert.deepEqual(calls, ["direct"], "traffic goes direct, but tagged");
            assert.equal(state.lastUnavailableReason, "stale-client-restart-required");
        } finally {
            // Reset the chain BEFORE restoring globalThis.fetch: the chain
            // restores its pre-install anchor (the stub) on reset, so an
            // earlier bare assignment would be clobbered back to the stub.
            niReset({ anchor: savedFetch });
            globalThis.fetch = savedFetch;
            _resetNativeStateForTest();
        }
    });
});

test("#5072 case 7b: an ordinary bootstrap failure keeps the legacy wording and stays untagged (negative)", async () => {
    await withIso(async () => {
        const savedFetch = globalThis.fetch;
        _resetNativeStateForTest();
        const plainMsg = "proxy child exited before becoming healthy (code 1) — EACCES: permission denied";
        try {
            _setEnsureProxyForTest(async () => { throw new Error(plainMsg); });
            const origin = await (await _bootstrapForTest())();
            assert.equal(origin, undefined);
            assert.equal(_staleClientFlagForTest(), false, "an ordinary failure must NOT be labeled stale-client");
            const log = fs.readFileSync(defaultLogFile(), "utf8");
            assert.ok(log.includes(`bili-native: proxy bootstrap failed — model traffic goes direct (uncompressed): ${plainMsg}`), `legacy wording drifted:\n${log}`);
            assert.ok(!log.includes("STALE CLIENT"), `ordinary failure mislabeled:\n${log}`);
            // Interceptor side: generic failures degrade exactly as before.
            const calls: string[] = [];
            globalThis.fetch = (async (_input: unknown) => { calls.push("direct"); return new Response("{}", { status: 200 }); }) as typeof fetch;
            niReset({ anchor: savedFetch });
            const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
            assert.equal(installNativeFetchIntercept(state), true);
            await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
            assert.deepEqual(calls, ["direct"]);
            assert.equal(state.lastUnavailableReason, "bootstrap-failed");
        } finally {
            niReset({ anchor: savedFetch });
            globalThis.fetch = savedFetch;
            _resetNativeStateForTest();
        }
    });
});

// --- case 9: proxy-mode zero-diff regression ---------------------------------

test("#5072 case 9: proxy-mode (plain client, no in-process bili code) passes through byte-equal — zero diff", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5072-proxymode-"));
    const biliConfig = path.join(root, "billion-context.json");
    fs.writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;

    const seen: { marker?: string; body: string }[] = [];
    const upstream = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            seen.push({ marker: req.headers["x-test-marker"] as string | undefined, body });
            res.writeHead(200, { "content-type": "application/json", "x-upstream": "seen" });
            res.end(JSON.stringify({ echoBytes: body.length }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upPort}`,
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const pPort = (proxy.address() as { port: number }).port;
    try {
        for (let i = 0; i < 200; i++) {
            try {
                if ((await fetch(`http://127.0.0.1:${pPort}/__bili/health`, { signal: AbortSignal.timeout(500) })).status === 200) break;
            } catch {}
            await new Promise((r) => setTimeout(r, 50));
        }
        const payload = JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hello #5072 proxy-mode" }] });
        // A single plain client (NO x-bili-plugin header) against a real
        // startServer instance: the exchange must complete healthy end-to-end
        // and carry none of the #5072 machinery. Proxy mode is pure HTTP on
        // the client side — this PR touches no server-side path at all, so
        // this pin guarantees any future drift into plain-client traffic here
        // fails loudly instead of shipping silently.
        const res = await fetch(`http://127.0.0.1:${pPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-test-marker": "from-plain-client" },
            body: payload,
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-upstream"), "seen", "response came straight off the fake upstream");
        const respBody = await res.text();
        assert.equal(seen.length, 1, "exactly one request reached the fake upstream");
        assert.equal(seen[0].marker, "from-plain-client", "client headers forwarded intact");
        assert.ok(seen[0].body.includes("hello #5072 proxy-mode"), "client content survived the hop");
        // The fake upstream answers with a deterministic function of the body
        // it received — the client must see exactly those bytes back.
        assert.equal(respBody, JSON.stringify({ echoBytes: seen[0].body.length }), "response round-tripped unaltered");
        // Negative: none of the #5072 machinery may appear anywhere in either direction.
        for (const needle of [STALE_CLIENT_RESTART_SIGNAL, "code-fingerprint-mismatch", "#5072 stale client", "acp_summary"] as const) {
            assert.ok(!respBody.includes(needle) && !seen[0].body.includes(needle), `stale-client machinery leaked into proxy-mode exchange: ${needle}`);
        }
    } finally {
        proxy.closeAllConnections?.();
        proxy.close();
        upstream.closeAllConnections?.();
        upstream.close();
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevConfig;
        rmrf(root);
    }
});
