import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// Issue #496: the default image cost (base64/4) matches byte-counting relays (#488)
// but overestimates pixel-tile upstreams, so PR #489's fit gate hard-fails (502) an
// image-dominated payload whose REAL cost is tiny. Fix = forward-once-then-learn: when
// images are the sole over-window component and there is NO upstream overflow evidence,
// forward once and let the upstream arbitrate. This file pins the OTHER billing model:
// a byte-counting relay that genuinely rejects the payload must see exactly ONE rejected
// forward, after which the self-heal learns the window and later requests fail fast —
// i.e. #488's infinite 400 loop is NOT reintroduced by the fix.

const OVERFLOW_BODY = JSON.stringify({
    error: { type: "invalid_request_error", message: "context_window_exceeded: prompt exceeds the context window" },
});

function summaryJson(): string {
    return JSON.stringify({
        id: "msg_summary",
        type: "message",
        role: "assistant",
        model: "claude-img",
        content: [{ type: "text", text: "PREFLIGHT SUMMARY: folded segment." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 500, output_tokens: 50 },
    });
}

function screenshotPayload(): string {
    // 7 screenshots × 60k base64 chars = 7 × 15_000 = 105_000 ESTIMATED image tokens
    // against a 10_000 window; the text is trivially small, so images are the sole
    // over-window component (textEstimate < limit) — the forward-once trigger shape.
    const bigB64 = "A".repeat(60_000);
    const images = Array.from({ length: 7 }, () => ({ type: "image", source: { type: "base64", media_type: "image/png", data: bigB64 } }));
    return JSON.stringify({
        model: "claude-img",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: [{ type: "text", text: "seven screenshots attached" }, ...images] }],
    });
}

test("e2e #496 (byte-counting relay): one rejected forward, then fail-fast — the 400 loop is not reintroduced", async () => {
    const streamForwards: boolean[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { parsed = {}; }
            // A preflight summarization call (non-streaming) — answer it so a fold
            // attempt on a later request completes instead of hanging the proxy.
            if (parsed.stream === false) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(summaryJson());
                return;
            }
            // Every streaming request is a genuine client forward: the byte-counting
            // relay rejects the oversized multimodal payload with a context overflow.
            streamForwards.push(true);
            res.writeHead(400, { "content-type": "application/json" });
            res.end(OVERFLOW_BODY);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-img": { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
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
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const headers = { "content-type": "application/json", "x-acp-session": "img-relay-sess" };

        // --- Request 1: no overflow evidence yet → forward ONCE; relay rejects 400 ---
        const r1 = await fetch(url, { method: "POST", headers, body: screenshotPayload() });
        assert.equal(r1.status, 400, "first forward passes the relay's 400 through verbatim");
        const r1text = await r1.text();
        assert.ok(r1text.includes("context_window_exceeded"), "relay error body passes through");
        assert.deepEqual(streamForwards, [true], "request 1 was forwarded exactly once");

        // #987: the relay's 400 carries NO window number, so nothing is
        // learned — but the emergency shrink arms at the DECLARED window
        // (10k, the rejection itself is evidence), which is the overflow
        // EVIDENCE that breaks the forward-once loop below.
        const s = listSessions().find((x) => x.id === "img-relay-sess");
        assert.ok(s, "session exists");
        assert.equal(s!.metadata.confirmedContextLimits, undefined, "#987: no window ever learned");
        assert.equal((s!.stats as { lastInputTokens?: number }).lastInputTokens, 10_000, "emergency shrink armed at the declared window");

        // --- Request 2: overflow EVIDENCE now exists → NO forward-once → fail-fast ---
        const r2 = await fetch(url, { method: "POST", headers, body: screenshotPayload() });
        // #3461: the image payload is over-window per bili's own meter and no
        // fold can close the gap — a structurally doomed verdict answers 413
        // (non-retryable) instead of the legacy 502.
        assert.equal(r2.status, 413, "second request fails fast instead of forwarding again");
        const err2 = JSON.parse(await r2.text()) as { error?: { code?: string } };
        assert.equal(err2.error?.code, "preflight_compress_failed");
        assert.deepEqual(streamForwards, [true], "request 2 was NEVER forwarded (loop broken after one rejection)");

        // --- Request 3: stable — still fail-fast, still exactly one forward total ---
        const r3 = await fetch(url, { method: "POST", headers, body: screenshotPayload() });
        assert.equal(r3.status, 413, "third request also fails fast (cooldown replays the same verdict, #3461)");
        await r3.text();
        assert.deepEqual(streamForwards, [true], "still exactly one forward total (no re-forwarding loop)");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
