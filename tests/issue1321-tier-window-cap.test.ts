import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { capRegistryWindowByStandard, expandedContextSuffixWindow } from "../src/server.ts";
import { MAX_ANTHROPIC_BETA_WINDOW } from "../src/server/context-window.ts";
import { tierGatedStandardWindow } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #1321 (from #1310 item 2): models.dev advertises the MAX window a tier-gated
// model id can serve (anthropic/claude-opus-5-5 → 1,000,000), but a plain
// subscription serves the STANDARD 200K until the client negotiates otherwise
// (context-Nm beta header / [Nm]-suffixed model name). The warm registry peek
// outranks the built-in table by design (#344 fresher-source-wins), so without
// tier evidence the resolved window was 1M — every nudge/emergency threshold
// sat up to 5× beyond the client's own wall and never fired while Claude Code
// enforced 200K locally. Fix: cap registry-derived windows at the built-in
// standard window for tier-gated families when the request carries no tier
// evidence; operator sources stay exempt and other families keep
// fresher-source-wins (#344/#852).

const MODEL = "claude-opus-5-5"; // 200K standard; models.dev advertises 1M
const ONE_M = 1_000_000;
const BETA = "context-1m-2025-08-07";
const MEASURED = 261_206; // ~261K input from the #1310 log evidence

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

// ~30K tokens of compressible content so the kernel has a viable T1 range to
// offer if EMERGENCY fires (same helper as anthropic-beta-window.test.ts).
function bigConversation(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        const filler = `MARKER_${i}_content_`.repeat(250);
        msgs.push({ role, content: `Message ${i} of the long conversation. ${filler}` });
    }
    return msgs;
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    forwards: string[];
    proxy: http.Server;
    upstream: http.Server;
}

async function startRig(): Promise<Rig> {
    const forwards: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            if (parsed.stream) {
                forwards.push(raw);
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(forwards.length === 1 ? MEASURED : 1000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg_s", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "s" }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 5 } }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    // models.dev advertises the MAX tier: the loopback host is not in
    // HOST_TO_PROVIDER, so the lookup reaches these entries via the
    // cross-provider suffix scan — the same path a relay deployment takes.
    setRegistryForTest({
        [`anthropic/${MODEL}`]: { limit: { context: ONE_M } },
        "openai/gpt-5.4": { limit: { context: 1_050_000 } },
    });
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;
    return { proxyPort, upstreamPort, forwards, proxy, upstream };
}

function url(rig: Rig): string {
    return `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
}

// The EMERGENCY nudge is rendered as a trailing user message whose text begins
// "⚠️ Context limit reached — compress now." (acp-kernel emergencyHeader).
function hasEmergencyNudge(body: string): boolean {
    return body.includes("Context limit reached");
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

// --- Unit: [Nm] suffix recognition ---

test("#1321: expandedContextSuffixWindow parses trailing [Nm] tier markers", () => {
    assert.equal(expandedContextSuffixWindow("claude-opus-5-5[1m]"), ONE_M);
    assert.equal(expandedContextSuffixWindow("claude-opus-5-5[2m]"), 2_000_000);
    assert.equal(expandedContextSuffixWindow("claude-opus-5-5[1M]"), ONE_M, "case-insensitive");
    assert.equal(expandedContextSuffixWindow("  claude-opus-5-5[1m]  "), ONE_M, "surrounding whitespace tolerated");
    assert.equal(expandedContextSuffixWindow("claude-opus-5-5[999m]"), MAX_ANTHROPIC_BETA_WINDOW, "clamped like the beta header (#1064 #12)");
    assert.equal(expandedContextSuffixWindow("claude-opus-5-5"), undefined, "plain id carries no tier evidence");
    assert.equal(expandedContextSuffixWindow("claude-opus-5-5[0m]"), undefined);
    assert.equal(expandedContextSuffixWindow("claude-opus-5-5[m]"), undefined);
    assert.equal(expandedContextSuffixWindow("claude-[1m]opus"), undefined, "marker must terminate the id");
    assert.equal(expandedContextSuffixWindow(undefined), undefined);
});

// --- Unit: tier-gated standard window ---

test("#1321: tierGatedStandardWindow returns the built-in window for claude only", () => {
    assert.equal(tierGatedStandardWindow("claude-opus-5-5"), 200_000);
    assert.equal(tierGatedStandardWindow("CLAUDE-SONNET-X"), 200_000, "case-insensitive");
    assert.equal(tierGatedStandardWindow("anthropic/claude-opus-5"), 200_000, "prefixed id falls back to the basename");
    assert.equal(tierGatedStandardWindow("my-claude"), undefined, "^-anchored family match");
    assert.equal(tierGatedStandardWindow("gpt-5"), undefined, "non-tier-gated family stays uncapped (#344)");
    assert.equal(tierGatedStandardWindow("deepseek-v4"), undefined);
    assert.equal(tierGatedStandardWindow("qwen3-max"), undefined);
    assert.equal(tierGatedStandardWindow(undefined), undefined);
});

// --- Unit: the cap itself ---

test("#1321: capRegistryWindowByStandard caps over-standard registry values without tier evidence", () => {
    assert.equal(capRegistryWindowByStandard(MODEL, ONE_M, false), 200_000, "advertised max capped to standard");
    assert.equal(capRegistryWindowByStandard(MODEL, ONE_M, true), ONE_M, "tier evidence bypasses the cap");
    assert.equal(capRegistryWindowByStandard(MODEL, 200_000, false), 200_000, "at-standard passes through");
    assert.equal(capRegistryWindowByStandard(MODEL, 128_000, false), 128_000, "sub-standard registry wins (fresher source)");
    assert.equal(capRegistryWindowByStandard("gpt-5.4", 1_050_000, false), 1_050_000, "non-tier-gated family untouched (#344/#852)");
    assert.equal(capRegistryWindowByStandard(MODEL, undefined, false), undefined);
});

// --- E2E: resolution through the real proxy pipeline ---

test("e2e: registry-advertised 1M without tier evidence → capped to the 200K standard (#1321)", async () => {
    const rig = await startRig();
    try {
        const r = await fetch(url(rig), {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "cap-sess" },
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(listSessions()[0]?.metadata.effectiveContextLimit, 200_000, "standard subscription budgeted at 200K, not the advertised 1M");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: context-Nm beta header → the advertised 1M stands", async () => {
    const rig = await startRig();
    try {
        const r = await fetch(url(rig), {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "beta-sess", "anthropic-beta": BETA },
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(listSessions()[0]?.metadata.effectiveContextLimit, ONE_M, "negotiated 1M tier honored");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: [1m]-suffixed model name → the advertised 1M stands", async () => {
    const rig = await startRig();
    try {
        const r = await fetch(url(rig), {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "suffix-sess" },
            body: JSON.stringify({ model: `${MODEL}[1m]`, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(listSessions()[0]?.metadata.effectiveContextLimit, ONE_M, "suffix-declared 1M tier honored");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: non-tier-gated family keeps fresher-source-wins (#344)", async () => {
    const rig = await startRig();
    try {
        const r = await fetch(url(rig), {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "control-sess" },
            body: JSON.stringify({ model: "gpt-5.4", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(listSessions()[0]?.metadata.effectiveContextLimit, 1_050_000, "registry 1,050,000 outranks the 400K table row — uncapped");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: #1310 symptom — EMERGENCY reachable again at 261K input on a 200K plan", async () => {
    const rig = await startRig();
    try {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": "symptom-sess",
        };
        const r1 = await fetch(url(rig), { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] }) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(listSessions()[0]?.stats.lastInputTokens, MEASURED, "session context is 261K tokens");

        // Before the fix the window was the advertised 1M (26% usage — no
        // trigger ever fired); capped at 200K it is 131% → EMERGENCY.
        const r2 = await fetch(url(rig), { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: bigConversation() }) });
        assert.equal(r2.status, 200);
        await r2.text();

        const lastForward = rig.forwards[rig.forwards.length - 1]!;
        assert.ok(hasEmergencyNudge(lastForward), "EMERGENCY nudge fires at 131% of the 200K window");
    } finally {
        await closeRig(rig);
    }
});
