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

// #6908: the band's premise ("any parseable 32 MiB+ text body is ≥ ~8M tokens,
// beyond every window") equates INBOUND BYTES with MODEL INPUT. On the dsh
// plugin lane that is dimensionally wrong: the host re-sends its ENTIRE raw
// ledger every round on the OpenAI wire (no incremental lane there, #3433), so
// the body is the host's history — fold substrate, not model input — and bili's
// job is to fold it (field: 32.0 MiB inbound vs 446.4 KiB outbound, 70x). Two
// exemptions keep a healthy session from being 413'd forever: (A) the dsh
// plugin lane, and (B) the dsh compaction call (the ONLY action that shrinks
// the host's ledger via bili — rc.2 replays the full shadowed region, #2193, so
// the self-heal itself crosses the band and must pass the gate or the session
// self-locks). Both directions are pinned below.

test("e2e #6908 (A): the dsh plugin lane (x-bili-plugin: dsh) is exempt from the ingest band — an over-band full-resend body is folded and forwarded, not 413 at ingest", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-6908a-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup();
    try {
        // A realistic dsh full-resend body: the host re-sends its ENTIRE raw
        // ledger every round on the OpenAI wire (no incremental lane there,
        // #3433). The bulk is OLD foldable history (tool call/result pairs);
        // the core is a small recent user message. Total body is over the
        // 1 MiB test band, but the core is tiny — so bili folds the history
        // and forwards. Without the lane exemption the gate 413s it at ingest
        // before any folding happens (the field's self-lock).
        const messages: Array<Record<string, unknown>> = [];
        for (let i = 0; i < 1500; i++) {
            messages.push({ role: "assistant", content: "", tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `/tmp/file_${i}.txt` }) } }] });
            messages.push({ role: "tool", tool_call_id: `call_${i}`, content: "x".repeat(700) });
        }
        messages.push({ role: "user", content: "Summarize what you found." });
        const r = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "s-count-ingest" },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
        });
        const body = await r.text();
        // The gate (ingest) must NOT refuse the dsh lane — the body is the
        // host's fold substrate, not model input. A 200 SSE stream proves the
        // body passed the ingest gate, was folded, and was forwarded upstream.
        if (r.status !== 200) {
            const parsed = JSON.parse(body) as { error?: { stage?: string } };
            assert.notEqual(parsed.error?.stage, "ingest", `the dsh lane body must pass the ingest gate (got stage=${parsed.error?.stage}, status=${r.status}): ${body.slice(0, 300)}`);
        }
        assert.equal(r.status, 200, `the dsh lane body is folded and forwarded (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(calls.length, 1, "the dsh lane body reached the upstream");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("e2e #6908 (B): a dsh compaction call (marker present) passes the ingest band — the self-heal reaches the compaction guard, not a 413", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-6908b-"));
    const disarm = armIngestBand();
    const { ctx, close } = await setup();
    try {
        // The final user message STARTS with the compaction instruction prefix
        // (marker-decisive, #2193) and the body is over the 1 MiB band. Without
        // the sniff exemption the gate 413s it BEFORE parse and the self-heal is
        // blocked (self-lock). With it, the body reaches isDshCompactionCall and
        // is answered by the compaction guard (422 refusal on a fresh session
        // with no active fold blocks) — proving it got PAST the ingest gate.
        const marker = "You are now acting as a compaction engine for this AI coding assistant";
        const r = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: marker + "x".repeat(3 * 1024 * 1024) }] }),
        });
        const body = await r.text();
        assert.notEqual(r.status, 413, `compaction call must pass the ingest gate (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(r.status, 422, "the compaction guard answers it past the gate (proving it reached isDshCompactionCall)");
        assert.match(body, /dsh_compaction_refused/, "the refusal is the compaction guard's, not the ingest band's");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("e2e #6908 negative: an over-band body with NO plugin header and NO compaction marker is still refused 413 (the exemptions must not widen the band)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-6908c-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup();
    try {
        // Over the 1 MiB band, plain openai lane, no x-bili-plugin, no marker —
        // the band's original behavior is preserved (the #5794 shape).
        const r = await postMessages(ctx, "x".repeat(3 * 1024 * 1024));
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; stage?: string } };
        assert.equal(r.status, 413, `non-plugin over-band body must still be refused (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(parsed.error?.stage, "ingest", "still the ingest stage");
        assert.equal(calls.length, 0, "zero upstream calls — the band still holds for non-plugin lanes");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

// #7426: the #6908 exemption was dsh-only (`x-bili-plugin === "dsh"`), so the
// opencode lane — which has the SAME full-resend structure (the host re-sends
// its ENTIRE raw ledger every round; bili's job is to fold it) — was still
// 413-locked at the band (field: 33.5 MiB inbound vs ~391K tokens of actual
// context, a healthy 390-block session). The criterion generalizes to ANY
// plugin lane: the `x-bili-plugin` header announces "my body is my ledger,
// fold it," which is dimensionally true for every cooperative plugin lane.
// Both directions are pinned below.

test("e2e #7426: the opencode plugin lane (x-bili-plugin: opencode) is exempt from the ingest band — an over-band full-resend body is folded and forwarded, not 413 at ingest", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-7426a-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup();
    try {
        // A realistic opencode full-resend body: the host re-sends its ENTIRE
        // raw ledger every round. The bulk is OLD foldable history (tool
        // call/result pairs); the core is a small recent user message. Total
        // body is over the 1 MiB test band, but the core is tiny — so bili
        // folds the history and forwards. Without the lane exemption the gate
        // 413s it at ingest before any folding happens (the field's self-lock).
        const messages: Array<Record<string, unknown>> = [];
        for (let i = 0; i < 1500; i++) {
            messages.push({ role: "assistant", content: "", tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `/tmp/file_${i}.txt` }) } }] });
            messages.push({ role: "tool", tool_call_id: `call_${i}`, content: "x".repeat(700) });
        }
        messages.push({ role: "user", content: "Summarize what you found." });
        const r = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers, "x-bili-plugin": "opencode", "x-bili-plugin-conversation": "s-count-ingest" },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
        });
        const body = await r.text();
        // The gate (ingest) must NOT refuse the opencode lane — the body is
        // the host's fold substrate, not model input. A 200 SSE stream proves
        // the body passed the ingest gate, was folded, and was forwarded
        // upstream.
        if (r.status !== 200) {
            const parsed = JSON.parse(body) as { error?: { stage?: string } };
            assert.notEqual(parsed.error?.stage, "ingest", `the opencode lane body must pass the ingest gate (got stage=${parsed.error?.stage}, status=${r.status}): ${body.slice(0, 300)}`);
        }
        assert.equal(r.status, 200, `the opencode lane body is folded and forwarded (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(calls.length, 1, "the opencode lane body reached the upstream");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("e2e #7426 negative: an over-band body from a NON-plugin lane (no x-bili-plugin header) is still refused 413 — the generalized exemption must not leak to plain clients", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-7426b-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup();
    try {
        // Over the 1 MiB band, plain openai lane, NO x-bili-plugin header —
        // the band's original behavior is preserved for non-plugin clients
        // (the #5794 shape). The generalized exemption must not leak here.
        const r = await postMessages(ctx, "x".repeat(3 * 1024 * 1024));
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; stage?: string } };
        assert.equal(r.status, 413, `non-plugin over-band body must still be refused (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(parsed.error?.stage, "ingest", "still the ingest stage");
        assert.equal(calls.length, 0, "zero upstream calls — the band still holds for plain clients");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});
