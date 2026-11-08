// #5937: a session-level `compress.modelContextLimit` was ignored by parts of
// the window chain — the DSH host-side oversize gate and its
// x-bili-plugin-context-window stamp read only the cached model info (#5885
// defect-4: a 450K cap never moved the 1,048,576 -> 792,576 headroom math),
// the relay egress fuse sized an explicit sub-1M cap against its 1M anti-guess
// floor so the cap could never doom a body, and the post-fold measured-token
// fit proof judged against the RAW resolved native window instead of the
// operator's declared wall.
//
// This suite pins all three consumers:
//   1. main path — the proxy-side judging chain sizes off the key end-to-end
//      ([window] base, [headroom] effective window, session stamps);
//   2. egress fuse — an explicit cap replaces the 1M anti-guess floor
//      (both directions: over-cap dooms locally, under-cap forwards);
//   3. dsh-native effectiveContextWindow — global-level compress.modelContextLimit
//      overrides the cached model info (absolute + percent), never guesses.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";
import { setLogCapture, muteStderrLeg } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";
import { _effectiveContextWindowForTest, _setModelInfoForTest, type PluginContext } from "../src/agent/dsh-native.ts";

const ROUTE_WINDOW = 1_048_576; // the route-declared NATIVE window
const CAP = 450_000; // the operator's compress.modelContextLimit
const MAX_TOKENS = 256_000; // output budget
const HEADROOM_WINDOW = CAP - Math.min(MAX_TOKENS, Math.floor(CAP * 0.25)); // 337,500
const FUSE_BAR_BYTES = Math.max(2_000_000, CAP * 7.5); // 3,375,000 — the operator-sized bar

type Captured = { level: string; msg: string };

function chatSse(text: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", { usage: { prompt_tokens: 100, completion_tokens: 3 } }) + "data: [DONE]\n\n";
}

function bigMessages(count: number, charsPerMsg: number): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    const pad = Math.max(1, charsPerMsg - 12);
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}: ` + "f".repeat(pad) });
    }
    return messages;
}

function makeUpstream(): { server: http.Server; calls: number[] } {
    const calls: number[] = [];
    const server = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            calls.push(req.headers["content-length"] ? Number(req.headers["content-length"]) : 0);
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chatSse("forwarded answer"));
        });
    });
    return { server, calls };
}

function proxyOptions(upstreamPort: number, baseLimit: number = ROUTE_WINDOW): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: ROUTE_WINDOW } } },
        } as ProxyOptions["routes"],
        modelContextLimit: baseLimit,
        kernelConfig: defaultConfig(baseLimit, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { modelContextLimit: CAP, injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: true,
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
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

async function setup(baseLimit?: number): Promise<{ url: string; calls: number[]; close: () => void }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    muteStderrLeg();
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort, baseLimit));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
        calls,
        // #4245 deterministic teardown: force-destroy sockets, don't gate on
        // cross-socket 'close' events.
        close: () => {
            proxy.close();
            proxy.closeAllConnections?.();
            upstream.close();
            upstream.closeAllConnections?.();
        },
    };
}

test("#5937 main path: compress.modelContextLimit drives the judging chain end-to-end", async (t) => {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    t.after(() => setLogCapture(null));

    const { url, close } = await setup();
    try {
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "op-win-main" },
            body: JSON.stringify({
                model: "gpt-test",
                stream: true,
                max_tokens: MAX_TOKENS,
                messages: [
                    { role: "user", content: "hello" },
                    { role: "assistant", content: "hi" },
                ],
            }),
        });
        assert.equal(r.status, 200, "small capped-window request forwards");
        await r.text();

        // The window resolution consumed the operator cap, not the 1M native.
        const windowLine = captured.find((e) => e.level === "info" && e.msg.startsWith("[window]"));
        assert.ok(windowLine, "[window] line present");
        assert.match(windowLine.msg, new RegExp(`base=${CAP}`), "the resolved base carries the cap");

        // Headroom derived FROM the cap: 450000 − min(256000, 112500) = 337500 —
        // the #5885 defect-4 expectation verbatim.
        const headroom = captured.find((e) => e.level === "info" && e.msg.includes("[headroom]"));
        assert.ok(headroom, "[headroom] line present");
        assert.match(headroom.msg, new RegExp(`effective window ${CAP} -> ${HEADROOM_WINDOW}`), "headroom derives from the cap, not the raw model window");

        // The session stamps carry the provenance the egress fuse keys off.
        const s = getSession("op-win-main");
        assert.ok(s, "session exists");
        assert.equal(s.metadata.effectiveContextLimit, CAP, "effective wall is the cap");
        assert.equal(s.metadata.reservedContextLimit, HEADROOM_WINDOW, "reserved window is the post-headroom cap");
        assert.equal(s.metadata.operatorWindowTuned, true, "operator provenance stamped");
    } finally {
        await close();
    }
});

test("#5937 egress fuse both-ways: an explicit cap replaces the 1M anti-guess floor", async () => {
    // Base kernel limit = CAP too: no-model bodies re-stamp effectiveContextLimit
    // from the UNRESOLVED base config (existing master semantics, load-bearing
    // for #4079's no-model isolation), so keeping base == cap makes that
    // re-stamp harmless while the OPERATOR PROVENANCE stamp — the behavior under
    // test — is what switches the bar from the 1M-floored 7.5MB to 450K×7.5.
    const { url, calls, close } = await setup(CAP);
    try {
        const headers = { "content-type": "application/json", "x-acp-session": "op-fuse" };
        // Establish the session through normal model traffic (stamps the caps).
        const warm = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(warm.status, 200);
        await warm.text();

        // No `model` in the body → preflight's `!model` early return makes the
        // FUSE the only window comparison on this send (#4079 isolation trick).
        // ~4.0MB core text: OVER the operator bar (3,375,000 B) — pre-fix this
        // body forwarded under the 1M-floored 7.5MB bar even though the
        // session's declared wall is 450K.
        const doomed = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ stream: true, messages: bigMessages(900, 4_450) }),
        });
        const body = await doomed.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; code?: string; retryable?: boolean; message?: string } };
        assert.equal(doomed.status, 413, `over-cap body must be stopped locally (got ${doomed.status})`);
        assert.equal(parsed.error?.type, "request_too_large");
        assert.equal(parsed.error?.code, "egress_window_fuse");
        assert.equal(parsed.error?.retryable, false);
        assert.match(parsed.error?.message ?? "", /that is ≥ ~\d+ tokens vs the operator-declared model window 450000/, "the token math names the operator wall");
        assert.match(parsed.error?.message ?? "", /compress\.modelContextLimit, #5937/, "the refusal names the setting");
        assert.match(parsed.error?.message ?? "", /raise\/remove compress\.modelContextLimit/, "the remedy names how to release it");
        assert.equal(calls.length, 1, "only the warm-up reached the upstream");

        // Negative direction: ~2.98MB sits UNDER the operator bar (and over the
        // 2MB absolute floor) — it must forward despite dwarfing most windows'
        // naive ratio bars.
        const under = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ stream: true, messages: bigMessages(670, 4_450) }),
        });
        assert.equal(under.status, 200, "under-bar bodies forward");
        await under.text();
        assert.equal(calls.length, 2, "the under-bar body reached the upstream");
    } finally {
        await close();
    }
});

// --- dsh-native plugin-side window resolution (global-level cap) ------------

const fakeCtx = (provider: string, model: string): PluginContext =>
    ({ agents: { currentInitiator: () => ({ session: { requestHeader: () => ({ config: { provider, model } }) } }) } }) as unknown as PluginContext;

function writeConfig(root: string, name: string, raw: string): string {
    const p = path.join(root, name);
    fs.writeFileSync(p, raw, "utf8");
    return p;
}

test("#5937 dsh-native: global compress.modelContextLimit overrides the cached model info", (t) => {
    const root = mkdtempSafe();
    const prev = process.env.BILI_CONFIG_FILE;
    const ctx = fakeCtx("p5937", "m5937");
    const INFO = 1_048_576;
    t.after(() => {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prev;
        _setModelInfoForTest();
        rmrf(root);
    });

    // Absolute cap with a cached info window: the cap REPLACES the info.
    process.env.BILI_CONFIG_FILE = writeConfig(root, "abs.json", JSON.stringify({ compress: { modelContextLimit: 450_000 } }));
    _setModelInfoForTest({ provider: "p5937", model: "m5937", contextWindow: INFO });
    assert.equal(_effectiveContextWindowForTest(ctx), 450_000, "absolute cap overrides the info window");

    // Percent resolves against the info window.
    process.env.BILI_CONFIG_FILE = writeConfig(root, "pct.json", JSON.stringify({ compress: { modelContextLimit: "50%" } }));
    assert.equal(_effectiveContextWindowForTest(ctx), INFO / 2, '"50%" resolves against the cached info window');

    // No config at all: legacy behavior — the info window stands.
    process.env.BILI_CONFIG_FILE = path.join(root, "missing.json");
    assert.equal(_effectiveContextWindowForTest(ctx), INFO, "no config → the cached info window (unchanged behavior)");

    // No cached info window: an absolute declaration still arms the gate...
    _setModelInfoForTest();
    process.env.BILI_CONFIG_FILE = writeConfig(root, "abs.json", JSON.stringify({ compress: { modelContextLimit: 450_000 } }));
    assert.equal(_effectiveContextWindowForTest(ctx), 450_000, "absolute cap arms the gate without any info window");

    // ...but a percentage has no base and garbage has no meaning: disable the
    // arm rather than yield a wrong (or 1-token) window.
    process.env.BILI_CONFIG_FILE = writeConfig(root, "pct.json", JSON.stringify({ compress: { modelContextLimit: "50%" } }));
    assert.equal(_effectiveContextWindowForTest(ctx), undefined, "percent without an info window disables the arm");
    process.env.BILI_CONFIG_FILE = writeConfig(root, "garbage.json", JSON.stringify({ compress: { modelContextLimit: "abc" } }));
    assert.equal(_effectiveContextWindowForTest(ctx), undefined, "unparseable value without an info window disables the arm");

    // Garbage WITH an info window degrades harmlessly to the info window
    // (== no config set), never to a sub-token wall.
    _setModelInfoForTest({ provider: "p5937", model: "m5937", contextWindow: INFO });
    assert.equal(_effectiveContextWindowForTest(ctx), INFO, "unparseable value with an info window degrades to the info window");
});

function mkdtempSafe(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bili-5937-"));
}
