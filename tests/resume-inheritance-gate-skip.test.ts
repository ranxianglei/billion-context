import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { setLogCapture, muteStderrLeg } from "../src/logger.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";

/**
 * #4264: a SKIPPED resume-inheritance gate must not be silent either. The
 * miss diagnostics (#4265) only fire when the gate RUNS; when a conjunct
 * short-circuits (resumeInheritance=false, derivedFromSessionId already
 * linked, publicForkReceipt present) the session produced zero
 * [resume-inheritance] output — indistinguishable in the log from a
 * pre-#4265 build. Both directions are pinned: skip → exactly one bounded
 * debug line naming the reason (first request only), no skip → the existing
 * miss line instead (never "skipped").
 */

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function startMockUpstream(): http.Server {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }));
            res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

function proxyOpts(resumeInheritance: boolean | undefined): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {} as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 400,
            compress: { minCompressRange: 200, minSummaryLength: 20, maxSummaryLength: 5000 },
        }),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        forkAdoption: true,
        resumeInheritance,
        sessionHeader: "x-claude-code-session-id",
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
        mitm: { enabled: false, domains: [] },
    };
}

async function chat(url: string, sessionId: string, text: string): Promise<void> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: text }] }),
    });
    if (!res.ok) {
        const errBody = await res.text();
        assert.fail(`HTTP ${res.status}: ${errBody}`);
    }
    let raw = "";
    for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
    assert.ok(raw.includes("[DONE]"), "the mock upstream must stream a complete reply");
}

async function startHarness(resumeInheritance: boolean | undefined): Promise<{ proxy: http.Server; relay: http.Server; url: string }> {
    process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "res-gate-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const relay = startMockUpstream();
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(resumeInheritance));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, relay, url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions` };
}

test("a skipped resume-inheritance gate logs exactly one bounded debug line naming the reason (#4264)", async () => {
    muteStderrLeg();
    const h = await startHarness(false);
    const captured: Array<{ level: string; msg: string }> = [];
    try {
        setLogCapture((level, msg) => captured.push({ level, msg }));
        await chat(h.url, "gate-skip-disabled", "first turn");
        await chat(h.url, "gate-skip-disabled", "second turn");
    } finally {
        setLogCapture(null);
        await close(h.proxy);
        await close(h.relay);
    }
    const lines = captured.filter(({ msg }) => msg.includes("[resume-inheritance]"));
    assert.equal(lines.length, 1, "the skip line fires once per session, not per request");
    assert.equal(lines[0]!.level, "debug", "skip observability stays debug-level — zero steady-state noise");
    assert.match(lines[0]!.msg, /\[gate-skip-disabled\] \[resume-inheritance\] skipped: resumeInheritance=false \(#4264\)/);
});

test("an unskipped gate keeps the existing miss line and never says skipped (#4264 negative direction)", async () => {
    muteStderrLeg();
    const h = await startHarness(undefined);
    const captured: Array<{ level: string; msg: string }> = [];
    try {
        setLogCapture((level, msg) => captured.push({ level, msg }));
        await chat(h.url, "gate-open-miss", "first turn");
    } finally {
        setLogCapture(null);
        await close(h.proxy);
        await close(h.relay);
    }
    const lines = captured.filter(({ msg }) => msg.includes("[resume-inheritance]"));
    assert.equal(lines.length, 1, "the gate ran — exactly the existing miss diagnostic, nothing else");
    assert.equal(lines[0]!.level, "debug", "no eligible chain: debug granularity as before");
    assert.match(lines[0]!.msg, /\[gate-open-miss\] \[resume-inheritance\] miss: no eligible tracked chain \(floor 8\) \(#4264\)/);
    assert.ok(!lines[0]!.msg.includes("skipped"), "the miss line must stay distinguishable from the skip line");
});
