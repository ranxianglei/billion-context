import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #3978 (floor 17/18): once bili has committed early preflight headers (#568
// grace keep-alive) and then decides NOT to forward, the response must still
// terminate with an explicit protocol frame — pre-fix the stream simply never
// completed (writeHead of a later status is impossible; respond:false wrote
// nothing), so clients held a 200 + open stream and waited out their own
// watchdog, unable to tell "bili gave up" from a dead network. Now every
// committed no-forward exit writes one terminal frame ({ok:false,
// error:{message,retryable}} — bili's native fail-fast shape) and ends():
// SSE gets `event: error`, non-streaming JSON gets the object appended after
// the whitespace padding. Uncommitted exits keep the normal status-code path.
//
// Scenario: a summary upstream that answers instantly but with a summary too
// short to accept (< minSummaryLength) makes EVERY fold attempt fail, so
// preflight exhausts its rounds without shrinking the payload — the generic
// fail-fast exit — well after the (shrunk) grace has committed headers.
// Pre-fix that exit left the stream dangling forever; the tests below race
// the body read against a deadline so the pre-fix hang fails the suite.

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

const SUMMARY_TEXT = "ok"; // 2 chars < minSummaryLength 50 ⇒ every fold rejected

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 100 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

// ~1200 calibrated tokens per message ⇒ 40 msgs ≈ 48K vs a 12K route window:
// over-window on arrival, far below the emergency-digest byte bound. Unique
// tags per test keep the inbound-body hash distinct (the dead-end cooldown is
// keyed on model+limit+sha256(body), not on the session id).
function conversation(n: number, tag: string): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        const filler = `T${tag}_msg_${i}_payload_`.repeat(90);
        msgs.push({ role, content: `Message ${i} of the conversation. ${filler}` });
    }
    return msgs;
}

interface Rig {
    proxyPort: number;
    mainUrl: string;
    proxy: http.Server;
    mainUpstream: http.Server;
    summaryUpstream: http.Server;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Per-summary-call latency. With instant summaries the whole exhausted
// marathon finishes in tens of ms — BEFORE the shrunk grace commits headers —
// so the tests would exercise the uncommitted path only. A few hundred ms per
// batch keeps the marathon alive past the grace (and gives T4 a live request
// to abort mid-flight).
async function startRig(summaryDelayMs = 0): Promise<Rig> {
    const mainUpstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(okSse());
    });
    mainUpstream.listen(0, "127.0.0.1");
    await once(mainUpstream, "listening");
    const mainUrl = `http://127.0.0.1:${(mainUpstream.address() as { port: number }).port}`;

    // Instant, always-too-short summaries ⇒ zero accepted folds ⇒ fast
    // round exhaustion ⇒ the generic fail-fast exit.
    const summaryUpstream = http.createServer((_req, res) => {
        setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
        }, summaryDelayMs);
    });
    summaryUpstream.listen(0, "127.0.0.1");
    await once(summaryUpstream, "listening");
    const sumUrl = `http://127.0.0.1:${(summaryUpstream.address() as { port: number }).port}`;

    process.env.E2E_ISSUE3978_TF_SUM_KEY = "k";
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: mainUrl,
        routes: { [mainUrl]: { models: { "claude-small": { context: 12_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000, {
            compress: { minCompressRange: 100, maxSummaryLength: 20_000, minSummaryLength: 50 },
        }),
        namedProviders: {
            sum: { baseUrl: sumUrl, api: "openai", apiKeyEnv: "E2E_ISSUE3978_TF_SUM_KEY", models: { sm: {} } },
        },
        compress: {
            injectTool: true,
            injectNudge: true,
            externalSummary: { enabled: true, targets: ["sum/sm"] },
        },
        promptCache: { routing: "auto" },
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
        mitm: { enabled: false, domains: [] },
    } as Parameters<typeof startServer>[0]);
    await once(proxy, "listening");
    return { proxyPort: (proxy.address() as { port: number }).port, mainUrl, proxy, mainUpstream, summaryUpstream };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.mainUpstream.close();
    rig.mainUpstream.closeIdleConnections?.();
    await once(rig.mainUpstream, "close");
    rig.summaryUpstream.close();
    rig.summaryUpstream.closeIdleConnections?.();
    await once(rig.summaryUpstream, "close");
}

// Read the body to completion, racing a deadline: pre-fix the stream never
// terminates, so this is what turns the silent-dangle bug into a red test.
async function readBodyWithDeadline(res: Response, ms: number, what: string): Promise<string> {
    assert.ok(res.body, "response must have a body");
    const reader = res.body.getReader();
    let out = "";
    const decoder = new TextDecoder();
    const readAll = (async () => {
        for (;;) {
            const { value, done: d } = await reader.read();
            if (d) break;
            out += decoder.decode(value, { stream: true });
        }
        return out;
    })();
    const finishedFirst = await Promise.race([readAll.then(() => true), sleep(ms).then(() => false)]);
    assert.ok(finishedFirst, `${what}: the stream must terminate (no completion within ${ms}ms)`);
    return readAll;
}

function parseTerminalFrame(body: string): { ok: boolean; error?: { message?: string; retryable?: boolean } } {
    const idx = body.indexOf("event: error");
    assert.ok(idx >= 0, `expected an 'event: error' frame, got: ${JSON.stringify(body.slice(0, 300))}`);
    const dataLine = body.slice(idx).split("\n").find((l) => l.startsWith("data: "));
    assert.ok(dataLine, "the error event must carry a data line");
    return JSON.parse(dataLine.slice("data: ".length));
}

test("e2e: SSE no-forward exit after committed headers terminates with an error frame (#3978)", async () => {
    process.env.BILI_PREFLIGHT_HOLD_MS = "300";
    const rig = await startRig(500);
    try {
        const t0 = Date.now();
        const res = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/${rig.mainUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "tf-sse" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(40, "sse") }),
        });
        // #568 commits early 200 + SSE headers after the shrunk grace.
        assert.equal(res.status, 200);
        const body = await readBodyWithDeadline(res, 20_000, "SSE");
        const elapsed = Date.now() - t0;
        const frame = parseTerminalFrame(body);
        assert.equal(frame.ok, false, "terminal frame carries the native fail-fast shape");
        assert.ok(typeof frame.error?.message === "string" && frame.error.message.length > 0, "frame carries a message");
        assert.equal(typeof frame.error?.retryable, "boolean", "frame carries retryable");
        console.log(`[issue3978-tf] SSE terminated in ${elapsed}ms with terminal frame`);
    } finally {
        delete process.env.BILI_PREFLIGHT_HOLD_MS;
        await closeRig(rig);
    }
});

test("e2e: JSON no-forward exit after committed headers appends a parseable error object (#3978)", async () => {
    process.env.BILI_PREFLIGHT_HOLD_MS = "300";
    const rig = await startRig(500);
    try {
        const res = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/${rig.mainUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "tf-json" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: false, messages: conversation(40, "json") }),
        });
        assert.equal(res.status, 200);
        const raw = await readBodyWithDeadline(res, 20_000, "JSON");
        // Whitespace padding + appended object must still be ONE valid JSON doc.
        const frame = JSON.parse(raw.trim());
        assert.equal(frame.ok, false, "appended object carries the native fail-fast shape");
        assert.ok(typeof frame.error?.message === "string" && frame.error.message.length > 0, "object carries a message");
        assert.equal(typeof frame.error?.retryable, "boolean", "object carries retryable");
    } finally {
        delete process.env.BILI_PREFLIGHT_HOLD_MS;
        await closeRig(rig);
    }
});

test("e2e: uncommitted no-forward exit keeps the plain status-code response (#3978 negative control)", async () => {
    // Huge grace ⇒ headers never commit during the (fast) exhaustion run ⇒
    // the normal writeHead(status) path must be untouched.
    process.env.BILI_PREFLIGHT_HOLD_MS = "600000";
    const rig = await startRig();
    try {
        const res = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/${rig.mainUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "tf-uncommitted" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(40, "uncom") }),
        });
        assert.notEqual(res.status, 200, "no early 200 commit without grace expiry");
        const body = await res.text();
        assert.ok(!body.includes("event: error"), "no terminal frame on the uncommitted path");
    } finally {
        delete process.env.BILI_PREFLIGHT_HOLD_MS;
        await closeRig(rig);
    }
});

test("e2e: client abort after committed headers logs the outcome and does not crash (#3978)", async () => {
    process.env.BILI_PREFLIGHT_HOLD_MS = "300";
    const rig = await startRig(800);
    const logs: string[] = [];
    setLogCapture((level: string, msg: string) => {
        logs.push(`${level} ${msg}`);
    });
    try {
        const ac = new AbortController();
        const p = fetch(`http://127.0.0.1:${rig.proxyPort}/bili/${rig.mainUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "tf-abort" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: conversation(40, "abort") }),
            signal: ac.signal,
        }).then(
            (r) => r.body?.cancel().catch(() => undefined),
            () => undefined,
        );
        // Wait past the grace so bili has committed headers, then kill the client.
        await sleep(1500);
        ac.abort();
        await p;
        await sleep(500);
        const abortLine = logs.find((l) => l.includes("preflight aborted") && l.includes("not forwarding"));
        assert.ok(abortLine, `the abort branch must log its outcome; tail: ${logs.slice(-8).join(" | ")}`);
    } finally {
        setLogCapture(null);
        delete process.env.BILI_PREFLIGHT_HOLD_MS;
        await closeRig(rig);
    }
});
