// #5794 item 2: the INGEST cost band. The #5794 session sent 51.2 MiB (29,619
// messages) every round; the slot budget (32 MiB admission, #5932) capped
// CONCURRENCY but a single body still burned the event loop for 5.5–7.2 s per
// round in the JSON.parse + normalization sweep (54.6% of local CPU → 747 s
// FATAL → every session's cache went cold). Any parseable body over the band
// (default 32 MiB) is already ≥ ~8M tokens — beyond every real model window —
// so it is refused with an actionable 413 (stage ingest) BEFORE the sweep.
// This suite pins both directions with a small band (1 MiB) so the over-cap
// body stays a few MiB: over → 413 with the dimension + remedy, under → 200.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
// 1 MiB test band. node:test can run several files in ONE process (the CI
// test lanes do), so the band is armed per-test and RESTORED in finally.
const TEST_BAND = 1024 * 1024;
function armIngestBand(): () => void {
    const prev = process.env.BILI_INGEST_BODY_BYTES;
    process.env.BILI_INGEST_BODY_BYTES = String(TEST_BAND);
    return () => {
        if (prev === undefined) delete process.env.BILI_INGEST_BODY_BYTES;
        else process.env.BILI_INGEST_BODY_BYTES = prev;
    };
}

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { limitsIngestBytes } from "../src/knobs.ts";
import { rmrf } from "./tmp-rm.ts";

const WINDOW = 20_000;

type Call = { bytes: number };

function chatSse(text: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", { usage: { prompt_tokens: 100, completion_tokens: 3 } }) + "data: [DONE]\n\n";
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

function proxyOptions(routes: Record<string, object>, window = WINDOW): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: window,
        kernelConfig: defaultConfig(window, {
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

async function setup(window = WINDOW): Promise<{ ctx: Ctx; calls: Call[]; close: () => void }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: window } } } }, window));
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

// #7426: the band is DISABLED by default (0 = no ingest cap) for ALL lanes. The e2e tests
// below arm it explicitly (1 MiB via BILI_INGEST_BODY_BYTES), so this pins the new default
// they would otherwise hide, plus the opt-in re-arm path (operator still has the escape hatch).
test("#7426: ingest band defaults to 0 (unlimited, all lanes); BILI_INGEST_BODY_BYTES re-arms it", () => {
    const prev = process.env.BILI_INGEST_BODY_BYTES;
    try {
        delete process.env.BILI_INGEST_BODY_BYTES;
        assert.equal(limitsIngestBytes(), 0, `default must be 0 = no ingest cap (#7426), got ${limitsIngestBytes()}`);
        process.env.BILI_INGEST_BODY_BYTES = "33554432";
        assert.equal(limitsIngestBytes(), 33554432, "BILI_INGEST_BODY_BYTES re-arms the #5794 cost band");
    } finally {
        if (prev === undefined) delete process.env.BILI_INGEST_BODY_BYTES;
        else process.env.BILI_INGEST_BODY_BYTES = prev;
    }
});

const postMessages = (ctx: Ctx, content: string) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content }] }),
    });

test("e2e #5794: a decoded body over the ingest cost band is refused 413 (stage ingest) BEFORE the parse sweep — zero upstream calls", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5794a-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup();
    try {
        // ~3 MiB of content in ONE message: over the 1 MiB test band, far
        // under the 5 GiB receive cap and the 32 MiB slot band (so the
        // admission budget is not the thing answering), and identity-encoded
        // (the #5794 shape: plain JSON, no content-encoding).
        const r = await postMessages(ctx, "x".repeat(3 * 1024 * 1024));
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; stage?: string; message?: string } };

        assert.equal(r.status, 413, `over-band body must be refused (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(parsed.error?.type, "request_too_large", "the structured too-large family");
        assert.equal(parsed.error?.stage, "ingest", "the STAGE names the ingest band (distinct from receive/decode caps)");
        assert.match(parsed.error?.message ?? "", /exceeds the ingestion cost band/, "the band is named for the operator");
        assert.match(parsed.error?.message ?? "", /restart the session or rewind/, "the actionable remedy is present");
        // THE behavior under test: the body never enters the parse sweep and
        // never reaches the upstream (on master this body cost 5.5–7.2 s of
        // event loop per round before any window logic could even look at it).
        assert.equal(calls.length, 0, `upstream must see zero calls (got ${JSON.stringify(calls)})`);
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("e2e #5794 control: a body under the ingest band is unaffected (the band must not false-block)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5794b-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup();
    try {
        // 30 KB ≈ ~7.5K tokens: under the 1 MiB band AND under the 20K window
        // (so preflight's token trigger stays quiet too) — a plain normal turn.
        const under = await postMessages(ctx, "x".repeat(30 * 1024));
        assert.equal(under.status, 200, `30 KiB < the 1 MiB band must be accepted (got ${under.status})`);
        await under.text();
        assert.equal(calls.length, 1, "the under-band body reached the upstream");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("e2e #5794 image doctrine: an over-band body carrying images is NOT refused at ingest (pixels never doom on raw bytes)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-5794c-"));
    const disarm = armIngestBand();
    // b64 pixels bill at ~1/4 token per char, so a ~1.6 MiB image body is
    // ~400K tokens in token-space — over the file's 20K window but far under
    // the 1M window this test arms. The point is the INGEST stage, not the
    // token meter: an over-band IMAGE body must flow through to the upstream
    // (governed by the slot budget / receive cap / lane shed), while an
    // over-band TEXT body is refused before the sweep.
    const { ctx, calls, close } = await setup(1_000_000);
    try {
        const b64 = Buffer.alloc(600 * 1024, 1).toString("base64"); // ~800 KB each
        const r = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers },
            body: JSON.stringify({
                model: "gpt-test",
                stream: true,
                messages: [{ role: "user", content: [
                    { type: "text", text: "what is in these?" },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
                ] }],
            }),
        });
        const body = await r.text();
        assert.equal(r.status, 200, `over-band IMAGE body must not be refused at ingest (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(calls.length, 1, "the image body reached the upstream — image mass is governed by the image lanes, not the byte band");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

// #6908/#7426 tradeoff pin: d351a4d disabled the band BY DEFAULT (0 = no cap,
// all lanes) because the re-send lanes (dsh/opencode replay the FULL history
// every round) self-locked once their session grew past the cap — the dsh
// compaction call is itself a full-history inbound body, so the gate could
// never let the very call that would shrink it through. That is a CONSCIOUS
// tradeoff, not an oversight: an operator who re-arms the band accepts that
// the over-cap re-send lanes get refused at ingest again. Pin both lanes so a
// future "fix" that exempts opencode/dsh from the armed band does not silently
// undo the #5794 cost protection for everyone who opted back in.
test("e2e #6908/#7426: a RE-ARMED ingest band still refuses the re-send lanes (opencode, dsh) — default-off is an opt-in re-arm, not a lane exemption", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-7426b-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup();
    try {
        const big = "x".repeat(3 * 1024 * 1024); // ~3 MiB, over the 1 MiB test band
        for (const lane of ["opencode", "dsh"]) {
            const r = await fetch(ctx.url, {
                method: "POST",
                headers: { ...ctx.headers, "x-bili-plugin": lane },
                body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: big }] }),
            });
            const body = await r.text();
            const parsed = JSON.parse(body) as { error?: { type?: string; stage?: string } };
            assert.equal(r.status, 413, `re-armed band: the over-cap ${lane} body must be refused again (got ${r.status}): ${body.slice(0, 300)}`);
            assert.equal(parsed.error?.stage, "ingest", `the ${lane} refusal is at the INGEST stage (the tradeoff is explicit, not hidden)`);
        }
        assert.equal(calls.length, 0, "neither over-cap re-send body reached the upstream");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

// #6908: the /v1/responses lane is EXEMPT from the ingest band even when it is
// re-armed (src/server/handle.ts: protocol === "responses" → band 0). dsh
// desktop's compaction rides this wire with image-heavy full-history bodies;
// the byte band was the wrong meter for that lane from the start, so the
// exemption holds regardless of the operator's re-arm.
test("e2e #6908: the /v1/responses lane ignores a RE-ARMED ingest band (exempt by protocol, even when the operator opted back in)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-6908-"));
    const disarm = armIngestBand();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(
                `event: response.completed\ndata: ${JSON.stringify({ response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } })}\n\n`,
            );
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-resp": { context: 30_000 } } } }, 30_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        // ~3 MiB of input text: over the 1 MiB armed band, no images. On the
        // chat/completions lane the same body is a 413 ingest refusal; on the
        // responses lane the gate is bypassed.
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-6908" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "conv-6908", instructions: "test", input: "y".repeat(3 * 1024 * 1024) }),
        });
        const body = await r.text();
        let stage: string | undefined;
        try { stage = (JSON.parse(body) as { error?: { stage?: string } }).error?.stage; } catch { /* non-JSON body: not an ingest refusal either */ }
        const refusedAtIngest = r.status === 413 && stage === "ingest";
        assert.ok(!refusedAtIngest, `the responses lane must NOT be answered by the ingest band (got ${r.status}, stage ${stage}): ${body.slice(0, 300)}`);
    } finally {
        disarm();
        proxy.close();
        proxy.closeAllConnections?.();
        upstream.close();
        upstream.closeAllConnections?.();
        rmrf(root);
    }
});
