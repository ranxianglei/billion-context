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
import { setLogCapture } from "../src/logger.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// #5022: the escalation banner printed entryTokens = max(last-measured context,
// raw-resend estimate) under the same "payload ~N tok vs window" phrasing the
// round lines use for the LIVE context. In the incident log the banner read
// ~1.81M and the very next round line ~1.14M — read as fold loss when it was
// two calibers of the same payload (the client re-sends its full raw history
// over a smaller server-side folded context). The reporter actually drew that
// wrong conclusion before checking. Fix: name the second caliber whenever the
// two diverge materially (> CALIBER_NOTE_DIVERGENCE = 25%) — display only; the
// budget math keeps judging entryTokens byte-for-byte as before (#2383
// discipline). Companion fix: the completion line printed result.savedTokens
// (raw meter delta) next to a calibrated A→B pair whose own delta differs
// (605,998 vs 673,512 net in the incident) — it now headlines the delta of the
// two figures it prints; the meter value stays the #3444 benefit-gate input.
//
// Scenarios (gate discipline — both directions):
//   A positive branch 1: measured baseline far below the raw resend → note
//     "(entry estimate from raw resend; last-measured context ~N tok)".
//   B negative: fresh session, no baseline → legacy line shape, NO note.
//   C positive branch 2: stale high-water baseline above the raw resend → note
//     "(entry estimate from measured baseline; raw-resend estimate ~N tok)".
// Every scenario also pins the completion line's internal consistency
// (~X saved must equal A − B of the pair it prints).

const WINDOW = 40_000;

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session.";

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

// chars/4 estimator: n messages × charsPerMessage ≈ n×charsPerMessage/4 tokens.
function conversation(nMessages: number, charsPerMessage: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    const filler = "The quick brown fox jumps over the lazy dog. ";
    for (let i = 0; i < nMessages; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        const head = `Message ${i} of the long conversation. `;
        const core = (head + filler.repeat(Math.ceil(charsPerMessage / filler.length))).slice(0, charsPerMessage - 8);
        msgs.push({ role, content: `${core} tail${i}` });
    }
    return msgs;
}

interface Harness {
    post: (sessionId: string, messages: Array<{ role: string; content: string }>) => Promise<number>;
    lines: () => string[];
    close: () => Promise<void>;
}

async function setup(sessionIdPrefix: string): Promise<Harness> {
    const calls: Array<{ stream: boolean }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1500));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary",
                    type: "message",
                    role: "assistant",
                    model: "claude-40k",
                    content: [{ type: "text", text: SUMMARY_TEXT }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = mkdtempSync(path.join(tmpdir(), "bili-5022-"));
    const lines: string[] = [];
    setLogCapture((_level, msg) => lines.push(msg));
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-40k": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        logFile: path.join(root, "bili.log"),
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    return {
        post: async (sessionId: string, messages) => {
            const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": sessionId },
                body: JSON.stringify({ model: "claude-40k", max_tokens: 1024, stream: true, messages }),
            });
            await r.text();
            return r.status;
        },
        lines: () => lines,
        close: async () => {
            setLogCapture(null);
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function pinBaseline(sessionId: string, tokens: number): void {
    const s = listSessions().find((x) => x.id === sessionId);
    assert.ok(s, `session ${sessionId} exists`);
    s.stats.lastInputTokens = tokens;
    s.stats.lastInputTokensSource = "usage";
}

const BANNER_RE = /\[preflight\] payload ~(\d+) tok(.*)vs window (\d+) \(\~([\d.]+)x\) — raising summarization budget 16 -> (\d+), rounds 16 -> (\d+)/;

function bannerLines(lines: string[]): Array<{ payload: number; window: number; ratio: number; budget: number; rest: string }> {
    const out: Array<{ payload: number; window: number; ratio: number; budget: number; rest: string }> = [];
    for (const l of lines) {
        const m = l.match(BANNER_RE);
        if (m) out.push({ payload: Number(m[1]), window: Number(m[3]), ratio: Number(m[4]), budget: Number(m[5]), rest: m[2] ?? "" });
    }
    return out;
}

function assertCompletionLineConsistent(lines: string[]): void {
    const done = lines.filter((l) => /preflight compressed \d+ range\(s\)/.test(l));
    assert.equal(done.length, 1, "exactly one completion line");
    const m = done[0]!.match(/preflight compressed (\d+) range\(s\), ~(\d+) tokens saved \((\d+) → (\d+)\) in (\d+)ms/);
    assert.ok(m, `completion line parseable: ${done[0]}`);
    const saved = Number(m[2]);
    const a = Number(m[3]);
    const b = Number(m[4]);
    assert.equal(saved, Math.max(0, a - b), "#5022: the printed savings must equal the delta of the two figures it prints");
}

test("#5022 A: raw resend far above the measured baseline → banner names both calibers", async () => {
    const h = await setup("issue5022-a");
    try {
        // Turn 1: small request creates the session under claude-40k.
        assert.equal(await h.post("issue5022-a", conversation(4, 800)), 200);
        // Pin the last-measured context far below what turn 2 will re-send raw.
        pinBaseline("issue5022-a", 20_000);
        // Turn 2: full raw history re-send ≈ 96 messages × 4000 chars ≈ 96k tok ≈ 2.4× window.
        assert.equal(await h.post("issue5022-a", conversation(96, 4000)), 200);

        const banners = bannerLines(h.lines());
        assert.equal(banners.length, 1, "exactly one escalation banner from turn 2");
        const bn = banners[0]!;
        assert.ok(bn.payload >= 2 * bn.window, `overshoot band reached (payload ${bn.payload} vs window ${bn.window})`);
        assert.ok(bn.rest.includes("(entry estimate from raw resend; last-measured context ~20000 tok)"),
            `banner names the measured caliber: ${bn.rest}`);
        assertCompletionLineConsistent(h.lines());
    } finally {
        await h.close();
    }
});

test("#5022 B: fresh session without baseline → legacy banner shape, no note (byte-stable negative gate)", async () => {
    const h = await setup("issue5022-b");
    try {
        // Single oversized request on a fresh session id: no prior turn, no
        // usage report, lastInputTokens == 0 → the note must NOT appear.
        assert.equal(await h.post("issue5022-b", conversation(88, 4000)), 200);

        const banners = bannerLines(h.lines());
        assert.equal(banners.length, 1, "exactly one escalation banner");
        const bn = banners[0]!;
        assert.ok(!bn.rest.includes("entry estimate"), `no caliber note on a baseline-less session: ${bn.rest}`);
        assert.equal(bn.rest.trim(), "", `legacy shape kept intact: "${bn.rest}"`);
        assertCompletionLineConsistent(h.lines());
    } finally {
        await h.close();
    }
});

test("#5022 C: stale high-water baseline above the raw resend → banner names the measured-baseline caliber", async () => {
    const h = await setup("issue5022-c");
    try {
        assert.equal(await h.post("issue5022-c", conversation(4, 800)), 200);
        // Stale high-water mark (a wider-window predecessor model) well above
        // the raw resend estimate of turn 2 (≈ 48 messages × 4000 chars ≈ 48k).
        pinBaseline("issue5022-c", 90_000);
        assert.equal(await h.post("issue5022-c", conversation(48, 4000)), 200);

        const banners = bannerLines(h.lines());
        assert.equal(banners.length, 1, "exactly one escalation banner");
        const bn = banners[0]!;
        assert.equal(bn.payload, 90_000, "entry figure is the measured baseline (the max of the two calibers)");
        assert.ok(bn.rest.includes("(entry estimate from measured baseline; raw-resend estimate ~"),
            `banner names the raw-resend caliber: ${bn.rest}`);
        assertCompletionLineConsistent(h.lines());
    } finally {
        await h.close();
    }
});
