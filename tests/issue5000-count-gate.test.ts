// #5000 item 2: the COUNT dimension — a hard upstream wire constraint on the
// messages[] array length that no byte/token estimate can express. Incident
// #5000's 55.2 MiB / 26,903-message session cleared EVERY size gate (core
// text 1.44 MiB, the 2 MiB absolute floor, the egress byte floor) and died at
// the upstream with the count error. This suite pins the per-upstream opt-in
// gate (BILI_MAX_MESSAGES=500 here): over-count bodies answer an actionable
// 413 (restart/rewind) with ZERO upstream calls — including token-fit bodies
// (the gate runs BEFORE preflight's token trigger, which is exactly the
// #5000 case), and under-count bodies forward unchanged.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
// The gate is per-upstream: 0/unset = disabled (the default — no global
// value exists). node:test can run several files in ONE process (the CI test
// lanes do), so the limit is armed per-test and RESTORED in finally — a
// module-scope pin would leak into sibling suites' sessions.
function armCountLimit(): () => void {
    const prev = process.env.BILI_MAX_MESSAGES;
    process.env.BILI_MAX_MESSAGES = String(COUNT_LIMIT);
    return () => {
        if (prev === undefined) delete process.env.BILI_MAX_MESSAGES;
        else process.env.BILI_MAX_MESSAGES = prev;
    };
}

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

const WINDOW = 20_000;
const COUNT_LIMIT = 500;

type Call = { bytes: number };

function chatSse(text: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", { usage: { prompt_tokens: 100, completion_tokens: 3 } }) + "data: [DONE]\n\n";
}

function tinyMessages(count: number): Array<{ role: string; content: string }> {
    // ~4 chars of CONTENT per message, but the rebuilt body prepends an
    // ~69-byte <acp …>mNNNNN</acp> ref marker to every message (the m-ref
    // ledger the compress tooling relies on), so each message costs ~20.8
    // tokens on the wire. 600 msgs ≈ 12.5K tokens < the 15K budget → the
    // body is TOKEN-FIT, yet its count (600) exceeds the limit (500): the
    // only dimension that can reject it is COUNT. That is the real #5000
    // shape (26,903 ref-marked messages that cleared every size gate).
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: "hi i" });
    }
    return messages;
}

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
            headers: { "content-type": "application/json", "x-acp-session": "s-count-ingest" },
        },
        calls,
        close: () => {
            proxy.close();
            proxy.closeAllConnections?.();
            upstream.close();
            upstream.closeAllConnections?.();
        },
    };
}

const post = (ctx: Ctx, messages: Array<{ role: string; content: string }>, withModel: boolean) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({ ...(withModel ? { model: "gpt-test" } : {}), stream: true, messages }),
    });

test(`e2e #5000: a TOKEN-FIT body over the upstream's count limit is answered 413 with the COUNT dimension — zero upstream calls (BILI_MAX_MESSAGES=${COUNT_LIMIT})`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5000a-"));
    const disarm = armCountLimit();
    const { ctx, calls, close } = await setup();
    try {
        // 600 tiny messages: ~12.5K tokens < 15K budget (token-fit — the
        // token trigger never fires, so preflight would early-return and the
        // body would sail to a guaranteed count-400 upstream). The count gate
        // runs BEFORE that trigger, so it is the only gate that can see this
        // shape.
        const r = await post(ctx, tinyMessages(600), true);
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; code?: string; retryable?: boolean; message?: string } };

        assert.equal(r.status, 413, `over-count body must fail fast (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(parsed.error?.code, "preflight_compress_failed", "the preflight fail-fast house shape");
        assert.equal(parsed.error?.retryable, false, "retrying re-sends the same 600-message history (#2847 semantics)");
        assert.match(parsed.error?.message ?? "", /message count 600 exceeds the upstream wire limit 500/, "the COUNT math is in the operator-facing message");
        assert.match(parsed.error?.message ?? "", /COUNT dimension/, "the dimension names itself — it is not a byte/token judgment");
        assert.match(parsed.error?.message ?? "", /restart the session or rewind/, "the actionable remedy is present (folding cannot close the gap in one preflight)");
        // THE behavior under test: the doomed payload NEVER reaches the upstream
        // (before the gate this exact shape cleared every size gate — #5000).
        assert.equal(calls.length, 0, `upstream must see zero calls (got ${JSON.stringify(calls)})`);
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("e2e #5000: the SAME over-count body without a model (preflight's !model early return) still gets the count 413 — the gate precedes the model check", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5000b-"));
    const disarm = armCountLimit();
    const { ctx, calls, close } = await setup();
    try {
        const r = await post(ctx, tinyMessages(600), false);
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; retryable?: boolean; message?: string } };

        assert.equal(r.status, 413, `no-model over-count body must fail fast (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(parsed.error?.retryable, false, "non-retryable — retrying re-sends the same history");
        assert.match(parsed.error?.message ?? "", /message count 600 exceeds the upstream wire limit 500/, "the COUNT math is present");
        assert.equal(calls.length, 0, `upstream must see zero calls (got ${JSON.stringify(calls)})`);
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("e2e #5000 control: under-count bodies forward unchanged when the gate is armed (the gate must not false-block)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5000c-"));
    const disarm = armCountLimit();
    const { ctx, calls, close } = await setup();
    try {
        const under = await post(ctx, tinyMessages(400), true);
        const ub = await under.text();
        assert.equal(under.status, 200, `400 messages < the 500 limit must forward (got ${under.status}): ${ub.slice(0, 300)}`);
        assert.equal(calls.length, 1, "the under-count body reached the upstream");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});
