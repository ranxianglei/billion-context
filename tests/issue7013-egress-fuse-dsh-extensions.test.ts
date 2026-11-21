// #7013/#7189/#7168 pin (relay-level): the egress window fuse's measured tier
// prices the FULL wire body per string field — before f6e891d a DSH session's
// top-level dsh_session_log (~8 MiB of pure transport telemetry the model
// never reads) counted into the `other` bucket (~1.5M–2M tokens) and a real
// ~100K-token prompt died with a local 413 egress_window_fuse (retryable:false)
// every round. The fix skips root-level `dsh_*` extension subtrees in
// estimateRawBodyTokens/estimateRawBodyBreakdown (src/preflight.ts:471-476,
// :482, :525). tests/raw-body-dsh-extensions.test.ts pins the estimator
// alone; this file pins the FUSE path end to end (both gates that share the
// meter: the relay fuse and preflight's measured bar) so a regression to
// "count everything" fails here, not in the field.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { estimateRawBodyBreakdown } from "../src/preflight.ts";
import { rmrf } from "./tmp-rm.ts";

const WINDOW = 20_000;

function chatSse(text: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", { usage: { prompt_tokens: 100, completion_tokens: 3 } }) + "data: [DONE]\n\n";
}

// ~8 MiB of transport-only DSH session log: 400 events × ~20 KB. Pure
// telemetry — the model never reads it, it exists so the desktop host can
// reconcile its local view.
function dshSessionLog(): unknown[] {
    return Array.from({ length: 400 }, (_, i) => ({
        seq: i,
        type: "assistant/text",
        text: `event-${i}: ` + "e".repeat(20_000),
    }));
}

type Call = { bytes: number };

function makeUpstream(): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            calls.push({ bytes: Buffer.concat(chunks).length });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chatSse("forwarded answer"));
        });
    });
    return { server, calls };
}

function proxyOptions(routes: Record<string, object>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
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

type Ctx = { url: string; headers: Record<string, string> };

async function setup(): Promise<{ ctx: Ctx; calls: Call[]; close: () => void }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "s-7013" },
        },
        calls,
        // #4245 deterministic teardown (same shape as the #4079 fixture).
        close: () => {
            proxy.close();
            proxy.closeAllConnections?.();
            upstream.close();
            upstream.closeAllConnections?.();
        },
    };
}

test("e2e #7013: an 8 MiB top-level dsh_session_log does NOT trip the relay egress fuse — the small real prompt forwards (pre-f6e891d the same body was a local 413 egress_window_fuse every round)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-7013a-"));
    const { ctx, calls, close } = await setup();
    try {
        // No `model` in the body → preflight's `!model` early return skips its
        // doom math entirely; the RELAY egress fuse is the gate under test.
        // The real prompt is ~50 tokens; the extension is ~8 MiB ≈ ~2M naive
        // tokens — over the 1M floored fuse bar, and it must be INVISIBLE to
        // the meter now.
        const r = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers },
            body: JSON.stringify({
                stream: true,
                messages: [{ role: "user", content: "continue the refactor" }],
                dsh_session_log: { version: 1, sessionId: "sess-7013", events: dshSessionLog() },
            }),
        });
        const body = await r.text();

        assert.equal(r.status, 200, `the small real prompt must forward despite the 8 MiB telemetry extension (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(calls.length, 1, "the request reached the upstream");
        // The extension itself rode along (the model host wants it) — this is
        // forwarding, not stripping: the upstream saw the whole ~8 MiB body.
        assert.ok(calls[0]!.bytes > 7_900_000, `upstream should receive the full body incl. the extension (got ${calls[0]!.bytes}B)`);
    } finally {
        await close();
        rmrf(root);
    }
});

test("e2e #7189: same shape WITH model present — preflight's measured gate (the second consumer of the same meter, armMeasuredBar) must not 413 either", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-7189-"));
    const { ctx, calls, close } = await setup();
    try {
        const r = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers },
            body: JSON.stringify({
                model: "gpt-test",
                stream: true,
                messages: [{ role: "user", content: "continue the refactor" }],
                dsh_session_log: { version: 1, sessionId: "sess-7189", events: dshSessionLog() },
            }),
        });
        const body = await r.text();

        assert.equal(r.status, 200, `with model present, preflight's measured gate shares the dsh_-blind meter and must not 413 (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(calls.length, 1, "the request reached the upstream");
        assert.ok(calls[0]!.bytes > 7_900_000, `upstream should receive the full body incl. the extension (got ${calls[0]!.bytes}B)`);
    } finally {
        await close();
        rmrf(root);
    }
});

test("residual semantics: a NON-dsh_ top-level extension field STILL counts (the exclusion is prefix-scoped, not \"all unknown fields\" — #7013 is about dsh_* telemetry, not a meter bypass)", () => {
    const base = {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hello" }],
    };
    const baseTotal = estimateRawBodyBreakdown(base).total;
    const withVendorField = {
        ...base,
        vendor_extension: { note: "z".repeat(400_000) },
    };
    assert.ok(
        estimateRawBodyBreakdown(withVendorField).total > baseTotal + 50_000,
        `a non-dsh_ top-level payload must still be priced (base ${baseTotal}, got ${estimateRawBodyBreakdown(withVendorField).total}) — the fix excludes the dsh_ telemetry prefix only`,
    );
});
