// #2490: the dsh-vs-bili double-bookkeeping deadlock had TWO load-bearing
// lies, pinned here end-to-end:
//   (a) the ledger floor — the #1729/#1835 guard refuses dsh's native
//       compaction envelope (a FULL replay of the host's raw history), but
//       that raw ledger stays invisible to bili's folded view, so the output
//       clamp planned turn budgets against the SMALL folded input while the
//       host was about to re-send the whole raw ledger next turn. Incident:
//       window 1M, folded input ~200K, refused replay ~900K tokens → clamp
//       let max_tokens=384_000 through → one 7.5MB assistant turn landed →
//       un-folding kill chain (turn 37→40 death). Fix: the guard records the
//       replay SIZE on the session (high-water bytes + count), and
//       clampOutgoingOutput plans against max(folded estimate, ledger floor).
//   (b) the doomed probe — the #2313 forward-once-for-evidence bet assumes
//       some tokenizer might make the payload fit. Beyond window×7.5 BYTES
//       of core text (densest live-route billing observed: ~6.8 B/token,
//       #2122) no tokenizer can, so the probe is a guaranteed 400 with an
//       8MB body — fail fast instead of paying it.
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
import { getSession } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import { clampOutgoingOutput, dshLedgerFloorTokens } from "../src/server/budget.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import { rmrf } from "./tmp-rm.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WINDOW = 20_000;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment held deterministic load-growth payloads across turns; every marker derives from the turn index, so folding loses nothing.";

type Call = { summary: boolean; contentChars: number };

function chatSse(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const u = usage ? { usage } : {};
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", u) + "data: [DONE]\n\n";
}

function bigMessages(count = 30, charsPerMsg = 4_400): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    const pad = Math.max(1, charsPerMsg - 12);
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}: ` + "f".repeat(pad) });
    }
    return messages;
}

function makeUpstream(): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            try {
                const parsed = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
                const chars = (parsed.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
                calls.push({ summary: isSummary, contentChars: chars });
                if (isSummary) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
                    return;
                }
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(chatSse("forwarded answer", { prompt_tokens: Math.max(1, Math.round(chars / 40)), completion_tokens: 3 }));
            } catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end('{"error":{"message":"unparseable"}}');
            }
        });
    });
    return { server, calls };
}

function proxyOptions(routes: Record<string, object>, overrides?: Partial<ProxyOptions>): ProxyOptions {
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
        ...overrides,
    } as ProxyOptions;
}

type Ctx = { url: string; headers: Record<string, string>; upstreamPort: number };

async function setup(overrides?: Partial<ProxyOptions>): Promise<{ ctx: Ctx; calls: Call[]; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } }, overrides));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "" },
            upstreamPort,
        },
        calls,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            upstream.close();
            upstream.closeIdleConnections?.();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

const post = (ctx: Ctx, messages: Array<{ role: string; content: string }>) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
    });

// Mirrors the #2313 stuck-meter seed: usage-grade baseline is DEMOTED by the
// #1933 F2 route gate (estimate-sourced, foreign origin) so baselineFloor
// drops to 0 and the probe-forward gate is the next decision.
async function seedStuckMeter(ctx: Ctx, sessionId: string, lastInputTokens = 7_300_000): Promise<void> {
    ctx.headers["x-acp-session"] = sessionId;
    const r = await post(ctx, [{ role: "user", content: "hello" }]);
    assert.equal(r.status, 200);
    await r.text();
    const s = getSession(sessionId);
    assert.ok(s, "session exists after turn 1");
    s.stats.lastInputTokens = lastInputTokens;
    s.stats.lastInputTokensSource = "estimate";
    s.stats.lastInputTokensOrigin = "http://127.0.0.1:1";
}

// ---------------------------------------------------------------------------
// (a) ledger floor

test("unit #2490: dshLedgerFloorTokens — bytes/4 caliber, high-water, legacy-safe", () => {
    assert.equal(dshLedgerFloorTokens(undefined), 0, "no metadata bag (partial fixture) is legacy-neutral");
    assert.equal(dshLedgerFloorTokens({}), 0, "nothing recorded yet");
    assert.equal(dshLedgerFloorTokens({ dshCompactionRefusedBytes: 3_600_000 }), 900_000, "the incident's 3.6MB replay floors planning at ~900K tokens");
    assert.equal(dshLedgerFloorTokens({ dshCompactionRefusedBytes: 0 }), 0, "zero bytes is not a floor");
    assert.equal(dshLedgerFloorTokens({ dshCompactionRefusedBytes: Number.NaN }), 0, "NaN is ignored");
    assert.equal(dshLedgerFloorTokens({ dshCompactionRefusedBytes: "big" }), 0, "non-number is ignored");
    assert.equal(dshLedgerFloorTokens({ dshCompactionRefusedBytes: 100 }), 25, "ceil to whole tokens");
});

const clampCtx = (over: Partial<Parameters<typeof clampOutgoingOutput>[2]>) =>
    ({
        systemText: "",
        tools: undefined,
        processedMessages: [{ role: "user", text: "hello" } as never],
        lastInputTokens: 200_000,
        lastInputTokensSource: "usage",
        nativeWindow: 1_000_000,
        imageTokens: 0,
        ...over,
    }) as Parameters<typeof clampOutgoingOutput>[2];

const clampLog = (lines: string[]): ((level: string, msg: string) => void) =>
    (level, msg) => { if (level === "info" || level === "warn") lines.push(msg); };

test("unit #2490: the incident clamp — ledger floor 900K vs window 1M cuts max_tokens 384K → 55K", () => {
    const lines: string[] = [];
    const rebuilt: Record<string, unknown> = { max_tokens: 384_000 };
    // Without the floor (pre-fix): folded input 200K, margin 10K → cap 790K ≥
    // requested → NO clamp. This is the exact permissiveness that let the
    // 7.5MB turn-37 monster out the door.
    const before: Record<string, unknown> = { max_tokens: 384_000 };
    clampOutgoingOutput(before, "max_tokens", clampCtx({ ledgerFloorTokens: undefined }), "s1", clampLog(lines));
    assert.equal(before.max_tokens, 384_000, "pre-fix: unclamped while the raw ledger sits at 900K");
    assert.equal(lines.length, 0, "no clamp, no log");

    // With the floor: planning input max(200K, 900K)=900K, margin 45K →
    // cap floor(1M − 900K − 45K) = 55K — the monster budget cannot exist.
    clampOutgoingOutput(rebuilt, "max_tokens", clampCtx({ ledgerFloorTokens: 900_000 }), "s2", clampLog(lines));
    assert.equal(rebuilt.max_tokens, 55_000, "planned against the refused raw ledger, not the folded view");
    assert.match(lines[0] ?? "", /planning floor 900000 from the refused dsh compaction replay \(#2490\)/, "the log says which basis drove the clamp");
});

test("unit #2490: the floor only ever TIGHTENS — small floors, absent requests, legacy paths unchanged", () => {
    // Floor below the folded input: planning basis stays the folded estimate.
    const small: Record<string, unknown> = { max_tokens: 384_000 };
    clampOutgoingOutput(small, "max_tokens", clampCtx({ ledgerFloorTokens: 10_000 }), "s3", clampLog([]));
    assert.equal(small.max_tokens, 384_000, "a ledger smaller than the folded input changes nothing");

    // Cap below OUTPUT_CLAMP_FLOOR surrenders to preflight (existing
    // semantics — a 990K ledger against a 1M window is preflight territory).
    const huge: Record<string, unknown> = { max_tokens: 384_000 };
    const lines: string[] = [];
    clampOutgoingOutput(huge, "max_tokens", clampCtx({ ledgerFloorTokens: 990_000 }), "s4", clampLog(lines));
    assert.equal(huge.max_tokens, 384_000, "cap < 1024 → no clamp (preflight owns that regime)");
    assert.equal(lines.length, 0);

    // No floor at all → byte-identical legacy behavior (frozen by #2122 tests).
    const legacy: Record<string, unknown> = { max_tokens: 8_000 };
    clampOutgoingOutput(legacy, "max_tokens", clampCtx({ ledgerFloorTokens: 0 }), "s5", clampLog([]));
    assert.equal(legacy.max_tokens, 8_000);
});

test("e2e #2490 a: the guard records the refused replay SIZE on the session (high-water, counted)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-2490-"));
    const cfgFile = path.join(root, "billion-context.json");
    writeFileSync(cfgFile, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = cfgFile;
    const { ctx, calls, close } = await setup();
    try {
        ctx.headers["x-acp-session"] = "s-2490-a";
        const envelope = (prefixChars: number) => JSON.stringify({
            model: "gpt-test",
            stream: true,
            messages: [
                { role: "system", content: "sys" },
                { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} ${"x".repeat(prefixChars)}` },
            ],
        });
        // 400KB replay, then a 100KB retry — the high-water mark must keep 400KB.
        const big = envelope(400_000);
        const small = envelope(100_000);
        const postRaw = (body: string) => fetch(ctx.url, { method: "POST", headers: { ...ctx.headers }, body });
        let r = await postRaw(big);
        assert.equal(r.status, 422, "guard refuses (default)");
        await r.text();
        r = await postRaw(small);
        assert.equal(r.status, 422, "guard refuses the retry too");
        await r.text();

        const s = getSession("s-2490-a");
        assert.ok(s, "session exists");
        assert.equal(s.metadata.dshCompactionRefused, true, "flag (from #1835) still set");
        assert.equal(s.metadata.dshCompactionRefusedBytes, Buffer.byteLength(big), "recorded the FIRST (larger) replay's exact body bytes");
        assert.equal(s.metadata.dshCompactionRefusals, 2, "every refusal counted");
        assert.equal(calls.length, 0, "nothing reaches the upstream");
    } finally {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevConfig;
        await close();
        rmrf(root);
    }
});

// ---------------------------------------------------------------------------
// (b) doomed probe

test("e2e #2490 b: multi-MB core text beyond both doom bars fails fast instead of paying the probe 400", async () => {
    const { ctx, calls, close } = await setup();
    try {
        await seedStuckMeter(ctx, "s-2490-b");

        // 500 msgs × 4.4K chars ≈ 2.2MB of ASCII core text — past the absolute
        // 2MB bar (and the 20K window × 7.5 B/token = 150KB ratio bar).
        const r = await post(ctx, bigMessages(500, 4_400));
        // #2847: 413 (was 502) — a mathematically-determined rejection must be
        // non-retryable at the status-code layer, or status-driven hosts retry
        // the identical doomed payload (3 crashes in 10s in the field).
        assert.equal(r.status, 413, "doomed probe fails fast with NON-retryable 4xx semantics, not forwarded");
        const body = await r.text();
        assert.match(body, /~22\d{5} bytes/, "the byte math is in the operator-facing message");
        assert.match(body, /NOT forwarded even for evidence/, "the remedy wording is present");

        assert.ok(calls.length === 1 && calls[0]!.contentChars < 50_000, `only the seed turn reached the upstream (calls=${JSON.stringify(calls.map((c) => c.contentChars))}) — never the 2.2MB payload`);
    } finally {
        await close();
    }
});

test("e2e #2490 c: an experiment-sized payload still probes (control — #2313/#1001 behavior preserved)", async () => {
    const { ctx, calls, close } = await setup();
    try {
        await seedStuckMeter(ctx, "s-2490-c");

        // 30 msgs × 4.4K chars ≈ 132KB: over the ratio bar for a 20K window but
        // well under the absolute 2MB floor — dense-but-legal payloads keep the
        // probe (the #1001 rewrite test rides the same shape). The bet is still
        // worth one request.
        const r = await post(ctx, bigMessages());
        assert.equal(r.status, 200, "probe forward reaches the upstream");
        await r.text();

        assert.equal(calls.filter((c) => !c.summary).length, 2, "turn 1 + exactly one probe forward");
        assert.equal(calls.filter((c) => c.summary).length, 0, "no summarization before evidence");
        const s = getSession("s-2490-c");
        assert.ok(s);
        assert.equal(s.stats.lastInputTokensSource, "usage", "the probe still settles a usage baseline");
    } finally {
        await close();
    }
});

// ---------------------------------------------------------------------------
// (d) #4079: the doomed 413 logs whether the payload GREW or REPEATED

async function runDoomedScenario(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
): Promise<{ status: number; profiles: string[] }> {
    const root = mkdtempSync(path.join(tmpdir(), "bili-4079-"));
    const lines: string[] = [];
    setLogCapture((_level, msg) => lines.push(msg));
    try {
        const { ctx, close } = await setup({ log: true, logFile: path.join(root, "bili.log") });
        try {
            await seedStuckMeter(ctx, sessionId);
            const r = await post(ctx, messages);
            const body = await r.text();
            return { status: r.status, profiles: lines.filter((l) => l.includes("core-text profile")) };
        } finally {
            await close();
        }
    } finally {
        setLogCapture(null);
        rmrf(root);
    }
}

test("e2e #4079: the doomed 413 logs one core-text profile line, reading an all-distinct payload as GROWN", async () => {
    // Same shape as (b): 500 msgs × 4.4K chars ≈ 2.2MB core text — but every
    // message is unique (`turn i:` prefix), so the ratio must read near zero:
    // the payload grew by content, not by repetition.
    const { status, profiles } = await runDoomedScenario("s-4079-grew", bigMessages(500, 4_400));
    assert.equal(status, 413, "still fails fast on the same bars");
    assert.equal(profiles.length, 1, "exactly one profile line accompanies the refusal");
    assert.match(profiles[0]!, /\d+ message\(s\), \d+B core over \d+ distinct text\(s\), \d+B unique/);
    assert.match(profiles[0]!, /duplicateRatio=0\.0\d{2}/, "unique-per-message payload → growth, not repetition");
});

test("e2e #4079: the doomed 413 reads a repeated-text payload as REPEATED (the #4079 incident shape)", async () => {
    const blob = "r".repeat(4_400);
    const { status, profiles } = await runDoomedScenario("s-4079-repeat", Array.from({ length: 500 }, () => ({ role: "user", content: blob })));
    assert.equal(status, 413, "the identical byte mass still trips the same bars");
    assert.equal(profiles.length, 1, "exactly one profile line accompanies the refusal");
    assert.match(profiles[0]!, /duplicateRatio=0\.9\d{2}/, "one blob repeated 500× → repetition, not growth");
});

test("e2e #4079: the non-doomed probe forward logs NO profile line (negative direction, #3617)", async () => {
    const { status, profiles } = await runDoomedScenario("s-4079-control", bigMessages());
    assert.equal(status, 200, "experiment-sized payload still probes (#2313/#1001 preserved)");
    assert.equal(profiles.length, 0, "the diagnostic only fires on the refusal path, never on the hot path");
});
