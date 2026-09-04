import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import {
    _setForTest as setRegistryForTest,
    bundledRegistryForTestsOnly,
    bundledSnapshotLookup,
    modelVariants,
} from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

// #393: Claude Opus 5 via a relay (Anthropic /v1/messages) was treated as 200K
// instead of 1M. Four root causes, each fixed and covered here:
//   1. the models.dev lookup was gated on a host that only exists in MITM /
//      zero-config /bili/ mode, so plain --upstream mode always fell to the
//      static table (claude-* -> 200K);
//   2. the status panel had a hardcoded 200K fallback and
//      effectiveContextLimit was only written in plugin mode;
//   3. variant suffixes like -thinking missed the registry (claude-opus-5 is
//      1M in the snapshot, claude-opus-5-thinking resolved to 200K);
//   4. the overflow self-heal only lowered the window, never raised it.

const ONE_M = 1_000_000;

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
}

async function startRig(inputTokens = 500, log = false): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            if (req.method === "GET") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ data: [{ id: "claude-opus-5" }] }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse(inputTokens));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log,
        logFile: log ? "/tmp/issue-393-test.log" : undefined,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;
    return { proxyPort, upstreamPort, proxy, upstream };
}

function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    return once(rig.proxy, "close").then(() => {
        rig.upstream.close();
        return once(rig.upstream, "close");
    });
}

function body(model: string): string {
    return JSON.stringify({ model, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] });
}

// --- Fix 3 (unit): variant suffix normalization ---

test("#393: modelVariants strips inference suffixes (original first)", () => {
    assert.deepEqual(modelVariants("claude-opus-5-thinking"), ["claude-opus-5-thinking", "claude-opus-5"]);
    assert.deepEqual(modelVariants("claude-opus-5"), ["claude-opus-5"]);
    assert.deepEqual(modelVariants("gpt-5-high"), ["gpt-5-high", "gpt-5"]);
});

test("#393: bundledSnapshotLookup resolves the -thinking variant to the base model's window", () => {
    assert.equal(bundledSnapshotLookup("claude-opus-5"), ONE_M);
    assert.equal(bundledSnapshotLookup("claude-opus-5-thinking"), ONE_M, "variant normalizes to the base model in the snapshot");
});

// --- Fix 1 + 3 (integration): --upstream mode (host=undefined) resolves the registry ---

test("#393: --upstream mode (no /bili/ prefix) resolves claude-opus-5(-thinking) to 1M", async () => {
    setRegistryForTest(bundledRegistryForTestsOnly()!);
    const rig = await startRig();
    try {
        // No /bili/ prefix and no MITM -> route=undefined -> host=undefined.
        // The registry lookup must still run (Fix 1) and normalize the variant (Fix 3).
        for (const model of ["claude-opus-5", "claude-opus-5-thinking"]) {
            const sid = `upstream-${model}`;
            const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": sid, "x-bili-plugin": "test-agent" },
                body: body(model),
            });
            assert.equal(r.status, 200);
            await r.text();
            const sess = listSessions().find((s) => s.id === sid);
            assert.equal(sess?.metadata.effectiveContextLimit, ONE_M, `${model} -> 1M in --upstream mode`);
        }
    } finally {
        await closeRig(rig);
    }
});

// --- Fix 2 (integration): wire mode (no plugin header) records effectiveContextLimit ---

test("#393: wire mode (no x-bili-plugin) also records effectiveContextLimit", async () => {
    setRegistryForTest(bundledRegistryForTestsOnly()!);
    const rig = await startRig();
    try {
        const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "wire-sess" },
            body: body("claude-opus-5"),
        });
        assert.equal(r.status, 200);
        await r.text();
        const sess = listSessions().find((s) => s.id === "wire-sess");
        assert.equal(sess?.metadata.effectiveContextLimit, ONE_M, "wire-mode session records the resolved window");
    } finally {
        await closeRig(rig);
    }
});

// --- Fix 5 (integration): upward self-heal ---

test("#393: self-heal raises a too-small fallback window when a turn exceeded it", async () => {
    setRegistryForTest({}); // empty registry -> claude-unknown falls to the static table (200K)
    const rig = await startRig(300_000); // upstream truthfully reports a 300K input
    try {
        const headers = { "content-type": "application/json", "x-acp-session": "selfheal-sess" };

        // Request 1: the 200K fallback window is used; the turn's real input (300K)
        // is recorded but does not yet correct the window.
        const r1 = await fetch(`http://127.0.0.1:${rig.proxyPort}/v1/messages`, { method: "POST", headers, body: body("claude-unknown") });
        assert.equal(r1.status, 200);
        await r1.text();
        let sess = listSessions().find((s) => s.id === "selfheal-sess")!;
        assert.equal(sess.metadata.effectiveContextLimit, 200_000, "first turn uses the 200K fallback");

        // Request 2: a prior successful turn whose input (300K) exceeded the 200K
        // window it was measured under is the only signal the real window is larger
        // (a too-small fallback never overflows, it just compresses early) -> raise.
        const r2 = await fetch(`http://127.0.0.1:${rig.proxyPort}/v1/messages`, { method: "POST", headers, body: body("claude-unknown") });
        assert.equal(r2.status, 200);
        await r2.text();
        sess = listSessions().find((s) => s.id === "selfheal-sess")!;
        assert.equal(sess.metadata.effectiveContextLimit, 300_000, "window raised to the observed input");
        assert.equal((sess.metadata.learnedContextLimits as Record<string, number>)["claude-unknown"], 300_000, "learned window persisted per model");
    } finally {
        await closeRig(rig);
    }
});

// --- Fix 6 (integration): /models is a known discovery path ---

test("#393: GET /models does not log an unrecognized-path warn (control: unknown path does)", async () => {
    const rig = await startRig(500, true); // log on so the warn path is observable
    const captured: string[] = [];
    setLogCapture((level, msg) => { captured.push(`${level}:${msg}`); });
    try {
        const r1 = await fetch(`http://127.0.0.1:${rig.proxyPort}/models`, { method: "GET" });
        await r1.text();
        assert.equal(captured.filter((l) => l.includes("unrecognized path")).length, 0, "/models is a known discovery path");

        const r2 = await fetch(`http://127.0.0.1:${rig.proxyPort}/totally-unknown-xyz`, { method: "GET" });
        await r2.text();
        assert.ok(captured.some((l) => l.includes("unrecognized path") && l.includes("totally-unknown-xyz")), "unknown path still warns (control)");
    } finally {
        setLogCapture(null);
        await closeRig(rig);
    }
});
