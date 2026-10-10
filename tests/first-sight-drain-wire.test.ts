import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Activate the staged smooth-transition note for the whole file: the drain
// switch must SUPPRESS it inside the first-sight window (test 1) while leaving
// it on the wire in steady state (test 2) — suppression scoped to digestion.
process.env.BILI_MAX_SHRINK_PER_COMPRESS = "0.3";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #2326: a pre-inflated history handed to bili (dsh plugin hand-off, CLI
// resume, rollout adoption) is a first-sight mass. The nudge decision for a
// brand-new session sizes on 0 (no usage report yet — see effectiveTokenCount
// #1492/#1820), so the mass lands as: r1 carries the backlog (no nudge), the
// upstream reports its real input size, and r2 — same full history resent,
// usage now known — fires the nudge with the kernel's ' [first-sight mass]'
// marker. The request pipeline must then steer the model to drain the whole
// backlog in ONE batched compress call: cascading single folds re-bill the
// remaining tail to the prefix cache on every piecemeal landing (2.29×/tok
// vs 0.032×/tok, ~70×).
//
// Wire-level regression net (fake upstream, no model): the batched-drain note
// must appear on the forwarded body exactly when the first-sight marker rides
// the nudge, and must NOT leak into steady-state nudges (byte-identical legacy
// guidance there, staged note intact).

const MODEL = "claude-sonnet-4-5";
// Sizing: the outbound payload (~234K chars ≈ 104K upper-bound est) must stay
// under the 95% truncate band (LIMIT 120K → 87%), while the usage-grade report
// (95K/120K = 79%) sits in the pressure band — above maxContextLimitPct 75%,
// below EMERGENCY 95% — and the ~60K pending clears the flat 50K growth cap.
const LIMIT = 120_000;
const REPORTED = 95_000; // fake upstream's usage report (sizes r2+)

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

// ~234K chars of compressible filler ≈ 60K pending tokens: above the 50K
// growth cap (first-sight needs a ≥-cap penalty) and an 87%-of-LIMIT upper
// bound on the outbound (under the 95% truncate band).
function bigConversation(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 13; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        const filler = `FILLER_${i}_x`.repeat(3000); // 18K chars per message, ≥ minCompressRange
        msgs.push({ role, content: `Backlog message ${i}. ${filler}` });
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
                res.end(okSse(forwards.length === 1 ? REPORTED : REPORTED));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg_s", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "s" }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 5 } }));
            }
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: LIMIT,
        kernelConfig: defaultConfig(LIMIT),
        // Pin the window via the OPERATOR setting (compress.modelContextLimit):
        // it outranks the model-table native window (claude-sonnet-4-5 → 200K
        // would otherwise win and read 58K as 29% — below the nudge band) and
        // is exempt from codex-alignment clamping.
        compress: { injectTool: true, injectNudge: true, modelContextLimit: LIMIT },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        logFile: "/home/dog/tmp/bili12/wire-diag.log",
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
    });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxyPort, upstreamPort, forwards, proxy, upstream };
}

function url(rig: Rig): string {
    return `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
}

async function post(rig: Rig, session: string, messages: Array<{ role: string; content: string }>): Promise<void> {
    const r = await fetch(url(rig), {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages }),
    });
    assert.equal(r.status, 200);
    await r.text();
}

const DRAIN = "First-sight digestion";
const BATCHED = "ONE batched compress call";
const STAGED = "Smooth-transition guidance";
const NUDGE_HINT = "never split the batch across separate calls"; // rides every rendered nudge (ONE_CALL_HINT tail, #2587)

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

test("wire: first-sight mass → batched-drain note forwarded, staged note suppressed", async () => {
    const rig = await startRig();
    try {
        // r1: the whole backlog arrives (dsh hand-off shape). A brand-new
        // session sizes on 0 — no nudge yet; the fake upstream reports the
        // real input size in the SSE usage.
        await post(rig, "fs-drain-1", bigConversation());
        assert.ok(!rig.forwards[0]!.includes(NUDGE_HINT), "no nudge before any usage report");

        // r2: same full history resent, usage now usage-grade 95K/120K = 79%
        // (pressure band, below EMERGENCY), pending ~60K over the 50K cap,
        // fresh nudge state → band nudge + ' [first-sight mass]'.
        await post(rig, "fs-drain-1", bigConversation());
        const fwd = rig.forwards[rig.forwards.length - 1]!;
        assert.ok(fwd.includes(NUDGE_HINT), "nudge fired on the usage report");
        assert.ok(fwd.includes(DRAIN), "batched-drain note rides the first-sight nudge");
        assert.ok(fwd.includes(BATCHED), "note names the ONE batched call");
        assert.ok(!fwd.includes(STAGED), "smooth-transition note suppressed during digestion (BILI_MAX_SHRINK_PER_COMPRESS is set)");
    } finally {
        await closeRig(rig);
    }
});

test("wire: steady-state nudge (no first-sight marker) → legacy guidance, no drain note", async () => {
    const rig = await startRig();
    try {
        // r1: backlog lands; r2: first-sight nudge (marker) — sets the stamp.
        await post(rig, "fs-steady", bigConversation());
        await post(rig, "fs-steady", bigConversation());
        assert.ok(rig.forwards[1]!.includes(DRAIN), "r2 was first-sight");

        // r3: same mass again, usage still pressure-band (79%) → nudge fires
        // again, but lastNudgeShownTokens > 0 and no fold re-armed it → no
        // first-sight marker → output must be the legacy shape: staged note
        // present (env set), drain note absent.
        await post(rig, "fs-steady", bigConversation());
        const fwd = rig.forwards[rig.forwards.length - 1]!;
        assert.ok(fwd.includes(NUDGE_HINT), "steady-state nudge still fires (pressure band)");
        assert.ok(!fwd.includes(DRAIN), "no batched-drain note outside the first-sight window");
        assert.ok(fwd.includes(STAGED), "staged smooth-transition note intact in steady state (no regression)");
    } finally {
        await closeRig(rig);
    }
});

test("wire: small fresh session → no nudge artifacts at all", async () => {
    const rig = await startRig();
    try {
        await post(rig, "fs-small", [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
            { role: "user", content: "whats up" },
        ]);
        const fwd = rig.forwards[rig.forwards.length - 1]!;
        assert.ok(!fwd.includes(DRAIN), "no drain note without a first-sight mass");
        assert.ok(!fwd.includes(NUDGE_HINT), "no nudge at low usage");
        assert.ok(!fwd.includes(STAGED), "no staged note either");
    } finally {
        await closeRig(rig);
    }
});

test("wire: pressure from usage report but NO mass → nudge without the drain note", async () => {
    const rig = await startRig();
    try {
        // r1: tiny chat (but the fake upstream reports 95K usage); r2: same
        // tiny history + one small compressible message. Usage is pressure-band
        // → the nudge would fire, but the compressible penalty (~4.5K tokens) is
        // far under the growth cap → no first-sight marker, no drain note: the
        // note keys on the MASS, not on fresh-session pressure alone. (With no
        // effective pending the kernel may suppress the nudge entirely — then
        // the drain note is trivially absent too; both outcomes assert that.)
        const small = [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
            { role: "user", content: `Small tool result. ${"pad_x".repeat(3000)}` }, // ~6K chars, one small range
        ];
        await post(rig, "fs-thin", small);
        await post(rig, "fs-thin", small);
        const fwd = rig.forwards[rig.forwards.length - 1]!;
        if (fwd.includes(NUDGE_HINT)) {
            assert.ok(!fwd.includes(DRAIN), "no drain note when there is no mass to drain");
        } else {
            // Kernel suppressed the nudge entirely (benefit below floor) — also
            // acceptable: either way no drain note.
            assert.ok(!fwd.includes(DRAIN), "no drain note when there is no mass to drain");
        }
    } finally {
        await closeRig(rig);
    }
});
