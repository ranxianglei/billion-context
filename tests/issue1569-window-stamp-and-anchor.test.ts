import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #1569: two defects in OpenCode v2 native plugin mode:
//   A. the configured model context limit never reached the proxy — the V2
//      plugin read ctx.catalog.model.list(), a seam that exists on NO stable
//      @opencode/cli build (probed 2.0.18: Context exposes model/provider
//      domains, no catalog key at all). The header went unstamped silently
//      and the proxy sized against registry windows (922K peek vs the host's
//      own 302K config) — making the 85% pressure band unreachable.
//   B. during the transient window right after a failed turn (baseline is
//      estimate-grade), the nudge sized on the char-count upper bound —
//      ~3.5× high on code/JSON-heavy payloads — lighting spurious bands whose
//      kernel growth-reference pin then blocked GENUINE nudges until context
//      regrew past the artifact (false T1 at 66%, false EMERGENCY at 120%,
//      ~20-min dead zone in the reported log). Fix: once a REAL usage report
//      has landed (lastUsageGradeTokens anchor), size on the calibrated
//      CJK-aware estimate of the current view; never-reporting upstreams keep
//      the fail-closed upper bound (#553/#728).

import { createOpencodeV2Setup } from "../src/agent/opencode-v2.ts";
import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error("until: timeout");
        await new Promise((r) => setTimeout(r, 5));
    }
}

// Real clients separate two provider requests by a network RTT (>= 1
// macrotask); the seam harvest settles within microseconds of round 1, so one
// tick is enough for round 2 to observe the stamped window.
const rtt = (): Promise<void> => new Promise((r) => setTimeout(r));

function withEnv1569(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return fn().finally(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

function startMiniProxy(): Promise<{ origin: string; close: () => Promise<void> }> {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }));
}

/** Minimal V2 ctx: only the http.request hook seam plus caller-supplied
 *  catalog/model seams under test. */
function makeMinimalCtx(extra: Record<string, unknown>) {
    let cb: ((e: Record<string, unknown>) => void | Promise<void>) | undefined;
    const ctx: Record<string, unknown> = {
        session: {
            hook: async (name: string, c: (e: Record<string, unknown>) => void | Promise<void>) => {
                assert.equal(name, "http.request");
                cb = c;
                return {};
            },
        },
        tool: { transform: async () => ({}) },
        command: { transform: async () => ({}) },
        event: {
            subscribe: (_opts?: { signal?: AbortSignal }) => ({
                [Symbol.asyncIterator]: (): AsyncIterator<never> => ({ next: async () => ({ done: true as const, value: undefined }) }),
            }),
        },
        ...extra,
    };
    const fire = async (model?: { providerID?: string; id?: string }) => {
        const store: Record<string, string> = {};
        await cb!({
            sessionID: "ses_1569",
            model,
            request: { url: `${globalThis.__miniOrigin}/bili/http://upstream.example/v1`, headers: { set: (k: string, v: string) => { store[k] = v; } } },
        });
        return store;
    };
    return { ctx, fire };
}

declare global {
    // eslint-disable-next-line no-var
    var __miniOrigin: string;
}

test("#1569 A1: stamps window+output from ctx.model.list (v2.0.x stable seam)", async () => {
    const proxy = await startMiniProxy();
    globalThis.__miniOrigin = proxy.origin;
    try {
        await withEnv1569({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const fake = makeMinimalCtx({
                model: { list: async () => ({ data: [{ providerID: "prov", id: "gpt-6-sol", limit: { context: 302000, output: 32768 } }] }) },
            });
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                const r1 = await fake.fire({ providerID: "prov", id: "gpt-6-sol" });
                assert.equal(r1["x-bili-plugin"], "opencode");
                await rtt();
                const r2 = await fake.fire({ providerID: "prov", id: "gpt-6-sol" });
                await until(() => r2["x-bili-plugin-context-window"] === "302000");
                assert.equal(r2["x-bili-plugin-max-output"], "32768");
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("#1569 A2: stamps window from catalog.provider.list Map records (dev-build seam)", async () => {
    const proxy = await startMiniProxy();
    globalThis.__miniOrigin = proxy.origin;
    try {
        await withEnv1569({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const fake = makeMinimalCtx({
                catalog: {
                    provider: {
                        list: async () => [{ provider: { id: "prov" }, models: new Map([["m1", { limit: { context: 111000 } }]]) }],
                    },
                },
            });
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                await fake.fire({ providerID: "prov", id: "m1" });
                await rtt();
                const r2 = await fake.fire({ providerID: "prov", id: "m1" });
                await until(() => r2["x-bili-plugin-context-window"] === "111000");
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("#1569 A3: stamps window from catalog.provider.list plain-object records (RPC-deserialized form)", async () => {
    const proxy = await startMiniProxy();
    globalThis.__miniOrigin = proxy.origin;
    try {
        await withEnv1569({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const fake = makeMinimalCtx({
                catalog: {
                    provider: {
                        list: async () => [{ provider: { id: "p2" }, models: { m2: { providerID: "p2", id: "m2", limit: { context: 222000 } } } }],
                    },
                },
            });
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                await fake.fire({ providerID: "p2", id: "m2" });
                await rtt();
                const r2 = await fake.fire({ providerID: "p2", id: "m2" });
                await until(() => r2["x-bili-plugin-context-window"] === "222000");
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("#1569 A4: legacy catalog.model.list seam still works (build parity)", async () => {
    const proxy = await startMiniProxy();
    globalThis.__miniOrigin = proxy.origin;
    try {
        await withEnv1569({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const fake = makeMinimalCtx({
                catalog: { model: { list: async () => ({ data: [{ providerID: "qwen", id: "m1", limit: { context: 262144 } }] }) } },
            });
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                await fake.fire({ providerID: "qwen", id: "m1" });
                await rtt();
                const r2 = await fake.fire({ providerID: "qwen", id: "m1" });
                await until(() => r2["x-bili-plugin-context-window"] === "262144");
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("#1569 A5: every seam empty → header unstamped + exactly ONE console.warn", async () => {
    const proxy = await startMiniProxy();
    globalThis.__miniOrigin = proxy.origin;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
        await withEnv1569({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const fake = makeMinimalCtx({
                model: { list: async () => ({ data: [] }) },
                catalog: {
                    model: { list: async () => ({ data: [] }) },
                    provider: { list: async () => [] },
                },
            });
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                await fake.fire({ providerID: "prov", id: "missing" });
                const r2 = await fake.fire({ providerID: "prov", id: "missing" });
                await new Promise((r) => setTimeout(r, 50));
                assert.equal(r2["x-bili-plugin-context-window"], undefined, "no window header when no seam yields a limit");
                const mine = warnings.filter((w) => w.includes("x-bili-plugin-context-window goes unstamped"));
                assert.equal(mine.length, 1, `exactly one degradation warning, got: ${JSON.stringify(warnings)}`);
                assert.match(mine[0], /opencode\.json limit\.context is NOT reaching the proxy/);
            } finally {
                cleanup();
            }
        });
    } finally {
        console.warn = origWarn;
        await proxy.close();
    }
});

test("#1569 A6: malformed entries ignored; rejecting seams inert-safe", async () => {
    const proxy = await startMiniProxy();
    globalThis.__miniOrigin = proxy.origin;
    try {
        await withEnv1569({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const fake = makeMinimalCtx({
                model: {
                    list: async () => ({
                        data: [
                            { providerID: 42, id: "m1", limit: { context: 302000 } },
                            { providerID: "p", id: "m2", limit: { context: Number.NaN } },
                            { providerID: "p", id: "m3", limit: { context: 999999 } },
                        ],
                    }),
                },
                catalog: { model: { list: async () => { throw new Error("boom"); } } },
            });
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                await fake.fire({ providerID: "p", id: "m3" });
                await rtt();
                const r2 = await fake.fire({ providerID: "p", id: "m3" });
                await until(() => r2["x-bili-plugin-context-window"] === "999999");
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

// ---------------- Part 2: estimate-grade sizing anchor (defect B) ----------------

const WINDOW = 120_000;
const POISON = 1_200_000;
const NUDGE_MARKER = "Context limit reached";

function okSse(reportUsage: boolean): string {
    const message: Record<string, unknown> = { id: "m1", role: "assistant" };
    if (reportUsage) message.usage = { input_tokens: 5000 };
    const start: Record<string, unknown> = { type: "message_start", message };
    const delta: Record<string, unknown> = { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } };
    if (reportUsage) delta.usage = { output_tokens: 3 };
    return (
        `event: message_start\ndata: ${JSON.stringify(start)}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify(delta)}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

// ~44k chars of dense ASCII code across six heavies: char-count upper bound
// ≈ 44k (≈37% of the 120k window — below every nudge band, per the #1492
// fixture rationale), calibrated estimate ≈ 1/4 of that. The two estimators
// disagree by ~4× on exactly the payload class from the #1569 log.
const LINE = (i: number) =>
    `const handler_${i} = (req: Request, res: Response) => { res.status(200).json({ status: "ok", id: ${i}, ts: Date.now() }); };`;
const HEAVY = (i: number) => `CODE_${i}_` + LINE(i).repeat(62);

type Msg = { role: string; content: unknown };

function baseConversation(): Msg[] {
    const msgs: Msg[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: i < 6 ? HEAVY(i) : `note_${i}_short tail ${i}` });
    }
    return msgs;
}

function makeRelay(reportUsage: boolean) {
    const received: Buffer[] = [];
    let nonStream = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks);
            received.push(raw);
            let parsed: Record<string, unknown> = {};
            try {
                parsed = JSON.parse(raw.toString("utf8"));
            } catch {
                /* non-JSON — treat as streaming forward */
            }
            if (parsed.stream !== true) {
                nonStream += 1;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary",
                    type: "message",
                    role: "assistant",
                    model: "claude-relay",
                    content: [{ type: "text", text: "SUMMARY: ok." }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse(reportUsage));
        });
    });
    return { server, received, nonStreamCalls: () => nonStream };
}

function lastNudgeSized(logs: string[], sessionId: string): number {
    const re = new RegExp(`\\[${sessionId}\\] nudge .*?usage=\\d+% \\((\\d+)/`, "g");
    let m: RegExpExecArray | null;
    let last = -1;
    while ((m = re.exec(logs.join("\n"))) !== null) last = Number(m[1]);
    return last;
}

async function runAnchorCase(sessionId: string, reportUsage: boolean): Promise<{ streamed: string[]; nonStream: number; logs: string[]; anchorAfterTurn1?: number }> {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _resetSessionsForTest();
    const relay = makeRelay(reportUsage);
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-relay": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    try {
        const url = `http://127.0.0.1:${proxy.address().port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const headers = { "content-type": "application/json", "x-acp-session": sessionId };
        const base = baseConversation();

        // --- Turn 1: establishes the session (+ the anchor iff usage reports) ---
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: base }),
        });
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();

        const s = listSessions().find((x) => x.id === sessionId);
        assert.ok(s, "session exists after turn 1");
        const anchorAfterTurn1 = s!.stats.lastUsageGradeTokens;
        // Poison exactly what armFailureShrink writes after an upstream failure.
        s!.stats.lastInputTokens = POISON;
        s!.stats.lastInputTokensSource = "estimate";

        // --- Turn 2: same history + one small exchange, baseline estimate-grade ---
        const msgs2: Msg[] = [...base, { role: "assistant", content: "ok, done." }, { role: "user", content: "step two?" }];
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-relay", max_tokens: 1024, stream: true, system: "You are a helpful assistant.", messages: msgs2 }),
        });
        assert.equal(r2.status, 200, "turn 2 succeeds");
        await r2.text();

        const streamed = relay.received
            .map((b) => b.toString("utf8"))
            .filter((t) => {
                try {
                    return (JSON.parse(t) as Record<string, unknown>).stream === true;
                } catch {
                    return false;
                }
            });
        return { relay, streamed, nonStream: relay.nonStreamCalls(), logs, anchorAfterTurn1 } as { streamed: string[]; nonStream: number; logs: string[]; anchorAfterTurn1?: number };
    } finally {
        setLogCapture(null);
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
}

test("#1569 B1: with a real-usage anchor, estimate-grade turns size on the calibrated view", async () => {
    const { streamed, nonStream, logs, anchorAfterTurn1 } = await runAnchorCase("issue1569-anchor-sess", true);
    assert.equal(anchorAfterTurn1, 5000, "turn 1's real usage report sets the calibration anchor");
    assert.equal(nonStream, 0, "preflight must stay silent (payload fits the window)");
    assert.equal(streamed.length, 2, "two streaming forwards (one per turn)");
    const sized = lastNudgeSized(logs, "issue1569-anchor-sess");
    assert.ok(sized >= 0, "turn 2 emitted a nudge diagnostic");
    assert.ok(sized < 25_000, `anchored sizing must use the calibrated estimate (~11k for this payload), not the ~44k char-count upper bound (got ${sized})`);
    assert.ok(!streamed[1].includes(NUDGE_MARKER), "no spurious nudge injection on the anchored turn");
});

test("#1569 B2: never-reporting upstream keeps the fail-closed upper bound (#553/#728)", async () => {
    const { nonStream, logs, anchorAfterTurn1 } = await runAnchorCase("issue1569-noreport-sess", false);
    assert.equal(anchorAfterTurn1, undefined, "no usage report → no anchor (legacy path preserved)");
    assert.equal(nonStream, 0, "preflight must stay silent (payload fits the window)");
    const sizedA = lastNudgeSized(logs, "issue1569-noreport-sess");
    assert.ok(sizedA >= 40_000, `unanchored sizing must keep the char-count upper bound (~44k) for fail-closed early compression (got ${sizedA})`);
});
