// #5596: the dsh ledger floor plans the output clamp on an over-counting,
// stale-by-construction proxy — two independent distortions compounded.
//
// Field shape (proxy 0.0.7827-pr.5469, dsh lane, 256K window): dsh native
// compaction replay refused (~866KB envelope) → metadata
// dshCompactionRefusedBytes → floor = 866760/4 = 216690 tokens while dsh's
// OWN meter read ~184K (bytes/4 over-counts by ~18%). The requested output
// (128384 = the dsh profile's 50%-of-window default) crosses the #3384
// giant line (>= 25% of the window), so the floor drove planning every
// turn; on top of the already-over-counting proxy the #5278 ×1.12 safe pass
// ran, plus the 5% margin on the inflated value — ≈1.36× total — and the
// clamp slammed into the 4096 capability-floor plateau
// (cap floor(256000 - 242693 - 12135) = 1172, floored at 4096). Every
// answer on that lane left with a 4096-token budget; two real answers got
// cut off mid-work. The session lane of the same case (floor 164287) was
// lighter but still clamped (62797 instead of the raw formula's 83498).
//
// Fix A1 (budget.ts): when the floor IS the planning basis (strictly above
// the folded estimate) it is a high-water BYTES proxy, not a low-biased
// local estimate — the #5278 safe pass would double-count it, so skip it
// and judge raw. Est-driven calls pass the flag off: byte-identical.
//
// Fix A2 (handle.ts): an AUTHORED checkpoint landing resets dsh's raw
// ledger (#3723), so the refused-replay high-water no longer bounds any
// future raw scale — the guard deletes the key on the authored path
// instead of recording it. The floor stays sticky-while-refused for the
// #2490 kill chain (refused checkpoints never land, the ledger only grows);
// only a landed checkpoint or session eviction ends a floor early.
//
// What stays byte-identical (pinned elsewhere, re-pinned where a value
// flows through the new flag path): the #2490/#3384 pinned ledger shapes
// (5909, 55000), the #3071 capability floor, the doomed-probe surrender
// (cap < OUTPUT_CLAMP_FLOOR), the refusal-side high-water recording
// (tests/issue2490-ledger-floor-doomed-probe.test.ts e2e, tests/issue3384-
// ledger-floor-starvation.test.ts e2e), and every non-floor lane
// (dshCompactionRefusedBytes is written only by the dsh guard — other
// lanes see floor 0, flag false, the legacy two-pass).
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
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { clampOutgoingOutput, dshLedgerFloorTokens } from "../src/server/budget.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import { BILI_SNAPSHOT_TAG_PREFIX } from "../src/server/dsh-authored-compaction.ts";

// ---------------------------------------------------------------------------
// Unit: clampOutgoingOutput through the new flag path.

type CtxArgs = Parameters<typeof clampOutgoingOutput>[2];

const ctxOf = (over: Partial<CtxArgs>): CtxArgs => ({
    systemText: "",
    tools: undefined,
    processedMessages: [{ role: "user", text: "hello" } as never],
    lastInputTokens: 30_000,
    lastInputTokensSource: "usage",
    nativeWindow: 256_000,
    headroomWindow: 256_000, // real dsh deployments run headroom ~= declared window
    imageTokens: 0,
    ...over,
}) as CtxArgs;

const clampLog = (lines: string[]): ((level: string, msg: string) => void) =>
    (level, msg) => { if (level === "info" || level === "warn") lines.push(msg); };

test("A1: the #5596 field sub-lane — floor-driven planning skips the #5278 inflation (28475, not the 4096 plateau)", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 128_384 };
    // 128384 >= 0.25 * 256000 → the #3384 giant ground engages the floor
    // (folded est 30K << floor 216690 → the floor IS the planning basis).
    clampOutgoingOutput(rebuilt, "max_tokens", ctxOf({ ledgerFloorTokens: 216_690 }), "s-5596-a", clampLog(lines));
    // Raw formula: 256000 - 216690 - ceil(216690 * 0.05) = 256000 - 216690 - 10835 = 28475.
    // Pre-fix the safe pass inflated to ceil(216690*1.12) = 242693 → cap 1172
    // → clamped to the 4096 capability floor — the field lane's starvation.
    assert.equal(rebuilt.max_tokens, 28_475, "raw formula on the over-counting proxy; pre-fix this was 4096");
    assert.match(lines[0] ?? "", /planning floor 216690 from the refused dsh compaction replay \(#2490\)/);
});

test("A1: the #5596 field session lane — 83498 (pre-fix 62797)", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 128_384 };
    clampOutgoingOutput(rebuilt, "max_tokens", ctxOf({ ledgerFloorTokens: 164_287 }), "s-5596-b", clampLog(lines));
    // Raw: 256000 - 164287 - ceil(164287 * 0.05) = 256000 - 164287 - 8215 = 83498.
    // Pre-fix: safe est ceil(164287*1.12) = 184002, margin 9201 → cap 62797.
    assert.equal(rebuilt.max_tokens, 83_498, "raw formula; pre-fix this was 62797");
});

test("A1: est-driven planning keeps the #5278 safe pass byte-identical", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 384_000 };
    // Folded usage 700K against a 1M window, no floor: the safe pass must
    // still apply (it corrects a LOW-biased local estimator).
    clampOutgoingOutput(rebuilt, "max_tokens", ctxOf({ lastInputTokens: 700_000, nativeWindow: 1_000_000, headroomWindow: 1_000_000, ledgerFloorTokens: 0 }), "s-5596-c", clampLog(lines));
    // Safe: est 700000 + a ~0.4-token local residue (the estimator's
    // fractional delta, cf. #3384's 89699.41) → ceil(*1.12) = 784001,
    // margin 39201 → cap 1000000 - 784001 - 39201 = 176798. The raw no-
    // inflation path would give ~265000 — the difference IS the #5278
    // inflation, which must survive here.
    assert.equal(rebuilt.max_tokens, 176_798, "#5278 safe pass intact on est-driven planning");
});

test("A1: the #3384 pinned shape stays 5909 through the flag path (raw and flag paths agree)", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 384_000 };
    clampOutgoingOutput(rebuilt, "max_tokens", ctxOf({ lastInputTokens: 89_699, nativeWindow: 1_000_000, headroomWindow: 1_000_000, ledgerFloorTokens: 946_753 }), "s-5596-d", clampLog(lines));
    // 946753 > 89699 → flag on → raw: 1000000 - 946753 - 47338 = 5909 —
    // the exact pre-fix value (the pre-fix safe path surrendered to the raw
    // fallback on this shape, so both paths agree).
    assert.equal(rebuilt.max_tokens, 5_909, "#3384 pinned value preserved (re-pinned: tests/issue3384-ledger-floor-starvation.test.ts)");
});

test("A1: boundary — est equal to the floor still takes the safe pass (#3071 plateau territory)", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 128_384 };
    // floorDrives is strict (>): at equality the planning basis reads as the
    // folded estimate and the safe pass applies — the 4096 result is the
    // #3071 capability-floor behavior, unchanged by this fix.
    clampOutgoingOutput(rebuilt, "max_tokens", ctxOf({ lastInputTokens: 216_690, ledgerFloorTokens: 216_690 }), "s-5596-e", clampLog(lines));
    // Safe: est 242693 → cap 1172 → floored at 4096.
    assert.equal(rebuilt.max_tokens, 4_096, "equality boundary keeps the legacy safe path");
});

test("A1: the doomed-probe surrender survives on the flag path (cap below the floor → no clamp)", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 128_384 };
    // Floor 254000 against a 256K window: the host's own counter is at the
    // wall — no output budget recovers the session; preflight owns it.
    clampOutgoingOutput(rebuilt, "max_tokens", ctxOf({ ledgerFloorTokens: 254_000 }), "s-5596-f", clampLog(lines));
    assert.equal(rebuilt.max_tokens, 128_384, "cap below OUTPUT_CLAMP_FLOOR → surrender, no clamp (the #2490 pin)");
    assert.equal(lines.length, 0);
});

test("A1: dshLedgerFloorTokens — a cleared key reads 0 (the A2 end state)", () => {
    assert.equal(dshLedgerFloorTokens({}), 0, "deleted key → no floor");
    assert.equal(dshLedgerFloorTokens({ dshCompactionRefusedBytes: 866_760 }), 216_690, "recorded high-water → floor");
});

// ---------------------------------------------------------------------------
// E2E: the field shape end-to-end (100K window, openai wire).
//
// Filler 330_000 chars → envelope ~330.1KB → floor ~82.5K = 82.5% of the
// 100K window — exactly the field band where the pre-fix safe path lands in
// [1024, 4096) (the plateau) while the raw formula leaves real budget.

const E2E_WINDOW = 100_000;
const GIANT = 25_000; // 25% of the window — the #3384 giant line (inclusive)

function chatSse(text: string, usage: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", { usage }) + "data: [DONE]\n\n";
}

// 24 messages × ~1.5k chars (~375 tokens each, ~9K total): the default
// protection zone leaves the oldest messages compressible, so the mock's
// m00001..m00008 range lands an active block (armBlock).
function conversation(): { role: string; content: string }[] {
    const out: { role: string; content: string }[] = [];
    for (let i = 0; i < 24; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(88) });
    }
    return out;
}

type Call = { maxTokens: number | null };

type Harness = {
    calls: Call[];
    url: string;
    sessionOf: (label: string) => { meta: { label: string }; state: { blocks: { id: string; active: boolean }[] }; metadata: Record<string, unknown> } | undefined;
};

async function withHarness(fn: (h: Harness) => Promise<void>, optsOverride: Partial<ProxyOptions> = {}): Promise<void> {
    const calls: Call[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { messages?: unknown[]; max_tokens?: number };
            try {
                parsed = JSON.parse(raw);
            } catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end('{"error":{"message":"unparseable"}}');
                return;
            }
            const messages = (parsed.messages ?? []) as Array<{ content?: unknown }>;
            const chars = messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
            calls.push({ maxTokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : null });
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (messages.length >= 20) {
                // armBlock turn: the model compresses the oldest pair → active block.
                const args = JSON.stringify({ content: [{ startId: "m00001", endId: "m00008", topic: "setup", summary: "SETUP-FOLDED-SUMMARY-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK" }] });
                res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "compress", arguments: args } }] } }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "done compressing" } }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
                res.end();
                return;
            }
            res.end(chatSse("forwarded answer", { prompt_tokens: Math.max(1, Math.round(chars / 40)), completion_tokens: 3 }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: E2E_WINDOW } } } },
        modelContextLimit: E2E_WINDOW,
        kernelConfig: defaultConfig(E2E_WINDOW, { preserveRecentMessages: 2, preserveRecentTokens: 2000 }),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
        ...optsOverride,
    } as unknown as ProxyOptions);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    const h: Harness = {
        calls,
        url: `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        sessionOf: (label) => listSessions().find((x) => x.meta.label === label) as never,
    };
    try {
        await fn(h);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        delete process.env.BILI_DSH_AUTHORED_COMPACTION;
    }
}

async function turn(h: Harness, label: string, messages: unknown[], extra: Record<string, unknown> = {}): Promise<{ status: number; body: string }> {
    const r = await fetch(h.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": label },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages, ...extra }),
    });
    return { status: r.status ?? 0, body: await r.text() };
}

async function postRaw(h: Harness, label: string, body: string): Promise<{ status: number; body: string }> {
    const r = await fetch(h.url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": label }, body });
    return { status: r.status ?? 0, body: await r.text() };
}

/** One normal turn that leaves an active block behind (authored gate). */
async function armBlock(h: Harness, label: string): Promise<void> {
    const r = await turn(h, label, conversation());
    assert.equal(r.status, 200, r.body);
    const s = h.sessionOf(label);
    assert.ok(s, "session exists");
    assert.ok(s!.state.blocks.some((b) => b.active), "setup created an active block");
}

function compactionEnvelope(filler: string): string {
    return JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [
            { role: "user", content: filler },
            { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} Condense the conversation above.` },
        ],
    });
}

test("e2e A1: a refused envelope's floor plans the next giant turn with the raw formula — out of the 4096 plateau", async () => {
    await withHarness(async (h) => {
        const envelope = compactionEnvelope("x".repeat(330_000));
        const r = await postRaw(h, "s-5596-r", envelope);
        assert.equal(r.status, 422, r.body);
        assert.equal(JSON.parse(r.body).error.code, "dsh_compaction_refused");
        const s = h.sessionOf("s-5596-r")!;
        const floor = dshLedgerFloorTokens(s.metadata);
        assert.equal(floor, Math.ceil(Buffer.byteLength(envelope) / 4), "refusal still records the high-water (the #2490 pin)");
        // Giant normal turn (25% of the window — the #3384 giant line):
        const g = await turn(h, "s-5596-r", [{ role: "user", content: "hello" }], { max_tokens: GIANT });
        assert.equal(g.status, 200, g.body);
        const margin = Math.max(2_048, Math.ceil(floor * 0.05));
        const expected = Math.max(E2E_WINDOW - floor - margin, Math.min(4_096, E2E_WINDOW - floor));
        assert.ok(expected > 4_096, `test band check: the raw formula must leave the plateau (got ${expected})`);
        assert.equal(h.calls[h.calls.length - 1].maxTokens, expected,
            `raw-formula clamp ${expected} (pre-fix the #5278 safe pass landed the clamp in [1024, 4096) → the 4096 field plateau)`);
    });
});

test("e2e A2: an authored checkpoint landing clears the floor — the next giant turn goes out unclamped", async () => {
    await withHarness(async (h) => {
        await armBlock(h, "s-5596-a");
        process.env.BILI_DSH_AUTHORED_COMPACTION = "1";
        const envelope = compactionEnvelope("x".repeat(330_000));
        const r = await postRaw(h, "s-5596-a", envelope);
        assert.equal(r.status, 200, r.body);
        assert.ok(r.body.includes(BILI_SNAPSHOT_TAG_PREFIX), "authored checkpoint answered locally");
        const s = h.sessionOf("s-5596-a")!;
        assert.equal(s.metadata["dshAuthoredCompactions"], 1, "authored counter");
        assert.equal(s.metadata["dshCompactionRefusedBytes"], undefined, "#5596: the landed checkpoint resets dsh's raw ledger — the floor is cleared");
        assert.equal(dshLedgerFloorTokens(s.metadata), 0, "no floor for the next turn");
        // The next giant turn plans against the folded view alone:
        const g = await turn(h, "s-5596-a", [{ role: "user", content: "hello" }], { max_tokens: GIANT });
        assert.equal(g.status, 200, g.body);
        // Pre-A2 the stale 330KB envelope (floor ~82.5K) would have driven
        // this turn's clamp to ~13K; with the floor cleared the folded
        // estimate (~6-7K) leaves the full 25K budget intact.
        assert.equal(h.calls[h.calls.length - 1].maxTokens, GIANT, "no floor → no clamp, the requested budget goes out");
    });
});
