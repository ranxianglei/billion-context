import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// Hermetic state dirs (#2806 review): A1/A2 drive genuine ANONYMOUS clients —
// prefix affinity mints pfa-* sessions and persists them to
// prefix-affinity.json in the shared default state dir. Without isolation the
// scenarios hydrate and co-write the chains of every sibling test file running
// concurrently in the same CI job (dozens of foreign chains showed up in the
// suites' own hydration logs), which flipped the anchor assertions. Same idiom
// as tests/prefix-affinity-orphan.test.ts (#2719).
const hermeticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-2806-anonanchor-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = hermeticRoot;
test.after(() => fs.rmSync(hermeticRoot, { recursive: true, force: true }));

// #2033: effectiveTokenCount took the anonymous-prefix-affinity branch BEFORE
// checking lastUsageGradeTokens (src/server.ts), so an anonymous session that
// held a REAL usage anchor but whose latest turn wrote an estimate-grade
// failure arm (armFailureShrink after a 5xx with no usage report) sized the
// next turn on the FULL RAW HISTORY upper bound instead of the anchor — the
// exact ghost path #1839 closed for explicit-identity sessions, which DO reach
// the later anchor check. Pinned here with a genuine anonymous client (no
// identity headers — prefix affinity resolves the pfa-* session, the
// tests/fork-adoption.test.ts harness shape):
//   A1. success-with-usage → 503-no-usage → appended turn on the same resolved
//       session: the nudge must size on the usage anchor (source "usage"), not
//       the raw-history bound; no spurious preflight summary calls, no spurious
//       nudge injection.
//   A2. anchor-less anonymous session (never-reporting upstream, #553/#728):
//       the conservative raw-history fallback stays intact — the nudge is not
//       blinded to 0 and stays estimate-grade.

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest, type Session } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

const WINDOW = 120_000;
const NUDGE_MARKER = "Context limit reached";

// Dense ASCII code fixture (same shape as the #1839/#1569 suites): the
// char-count upper bound of this history sits well ABOVE the usage anchor
// (so the pre-fix raw-bound ghost is observable) but far below the 120k
// window (so NO turn may trigger preflight — any summary call means the sizing
// regressed). The relay bills at chars/4 (billing caliber) so every report
// tracks its payload's scale: the #4425 non-main settle gate rejects reports
// an order of magnitude below the established session load, and a constant
// tiny-billing fixture would read as aux-shaped once a failure arm inflates
// the incumbent (the arm carries the char-count bound, ~4× the billing scale).
const LINE = (i: number) =>
    `const handler_${i} = (req: Request, res: Response) => { res.status(200).json({ status: "ok", id: ${i}, ts: Date.now() }); };`;
const HEAVY = (i: number) => `CODE_${i}_` + LINE(i).repeat(62);

type Msg = { role: string; content: unknown };

function baseConversation(): Msg[] {
    const msgs: Msg[] = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: i < 8 ? HEAVY(i) : `note_${i}_short tail ${i}` });
    }
    return msgs;
}

type VerdictRule = { when?: string; status?: number; body?: string };

/** Content-routed OpenAI relay: a streaming chat completion gets the verdict of
 *  the FIRST rule whose `when` substring appears in its LAST message's content,
 *  else 200 SSE (usage reported iff reportUsage). Routing by the last message
 *  (not the whole body) matters: every turn resends the FULL history, so a
 *  marker in an earlier turn would keep matching every later turn. Non-stream
 *  calls (kernel summary lane) always get a plain completion. */
function makeRelay(rules: VerdictRule[], reportUsage: boolean) {
    const received: Buffer[] = [];
    const billedCalls: number[] = [];
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
                /* non-JSON — treat as non-stream */
            }
            if (parsed.stream !== true) {
                nonStream += 1;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary", object: "chat.completion", created: 0, model: "gpt-test",
                    choices: [{ index: 0, message: { role: "assistant", content: "SUMMARY: ok." }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 },
                }));
                return;
            }
            const msgsArr = Array.isArray(parsed.messages) ? (parsed.messages as Array<Record<string, unknown>>) : [];
            const lastMsg = msgsArr[msgsArr.length - 1];
            const tail = typeof lastMsg?.content === "string" ? lastMsg.content : JSON.stringify(lastMsg?.content ?? "");
            const rule = rules.find((r) => r.when !== undefined && tail.includes(r.when));
            if (rule) {
                res.writeHead(rule.status ?? 500, { "content-type": "application/json" });
                res.end(rule.body ?? "");
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`);
            const done: Record<string, unknown> = { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
            if (reportUsage) {
                const billed = Math.round(raw.length / 4);
                billedCalls.push(billed);
                done.usage = { prompt_tokens: billed, completion_tokens: 3 };
            }
            res.write(`data: ${JSON.stringify(done)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    return { server, received, nonStreamCalls: () => nonStream, billedCalls };
}

function lastNudgeSized(logs: string[], sessionId: string): number {
    const re = new RegExp(`\\[${sessionId}\\] nudge .*?usage=\\d+% \\((\\d+)/`, "g");
    let m: RegExpExecArray | null;
    let last = -1;
    while ((m = re.exec(logs.join("\n"))) !== null) last = Number(m[1]);
    return last;
}

function streamedBodies(received: Buffer[]): string[] {
    return received.map((b) => b.toString("utf8")).filter((t) => {
        try {
            return (JSON.parse(t) as Record<string, unknown>).stream === true;
        } catch {
            return false;
        }
    });
}

async function startHarness(script: VerdictRule[], reportUsage: boolean) {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _resetSessionsForTest();
    const relay = makeRelay(script, reportUsage);
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = (relay.server.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    // NO identity headers — genuine anonymous client; prefix affinity resolves
    // the pfa-* session (#309/#553 lane).
    const post = (messages: Msg[]) => fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", max_tokens: 1024, stream: true, messages }),
    });
    const anonSession = (): Session => {
        const s = listSessions().find((x) => x.metadata.anonymousPrefixAffinity);
        assert.ok(s, "an anonymous prefix-affinity session exists");
        return s!;
    };
    const close = async () => {
        await new Promise<void>((r) => proxy.close(() => r()));
        await new Promise<void>((r) => relay.server.close(() => r()));
    };
    return { logs, relay, post, anonSession, close };
}

test("#2033 A1: anchored anonymous session keeps sizing on the usage anchor after a failed turn (e2e)", async () => {
    const h = await startHarness([
        { when: "step two?", status: 503, body: '{"error":"upstream unavailable"}' },
    ], true);
    try {
        const base = baseConversation();
        const r1 = await h.post(base);
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();
        let s = h.anonSession();
        assert.ok(s.id.startsWith("pfa-"), `anonymous session resolved by prefix affinity (${s.id})`);
        assert.equal(s.stats.lastUsageGradeTokens, h.relay.billedCalls[0], "real usage report anchored the session");
        assert.equal(s.stats.lastInputTokensSource, "usage");

        const msgs2: Msg[] = [...base, { role: "assistant", content: "ok, done." }, { role: "user", content: "step two?" }];
        const r2 = await h.post(msgs2);
        assert.equal(r2.status, 503, "upstream 503 passes through");
        await r2.text();
        s = h.anonSession();
        // The #604 arm IS still written — load-bearing for the emergency-band
        // rescue on anchor-less sessions — but it carries ESTIMATE grade and
        // must not reach a sizing decision while a usage-grade anchor exists.
        assert.ok(s.stats.lastInputTokens > h.relay.billedCalls[0], `failure arm raised the baseline above the real anchor to an outbound estimate (${s.stats.lastInputTokens})`);
        assert.equal(s.stats.lastInputTokensSource, "estimate", "the arm is tagged estimate-grade");
        assert.ok(h.logs.some((l) => l.includes("armed emergency shrink with local estimate")), "armFailureShrink warn present");

        const msgs3: Msg[] = [...msgs2, { role: "assistant", content: "working." }, { role: "user", content: "step three?" }];
        const r3 = await h.post(msgs3);
        assert.equal(r3.status, 200, "turn 3 succeeds");
        await r3.text();
        s = h.anonSession();
        const sized = lastNudgeSized(h.logs, s.id);
        assert.ok(sized >= 0, "nudge diagnostic present");
        // Pre-fix this returned the char-count upper bound of the FULL
        // resubmitted history (58701 here, measured pre-fix): the anonymous early return ran
        // before the usage-grade anchor check, the exact ghost path #1839
        // closed for explicit sessions.
        assert.equal(sized, h.relay.billedCalls[0], "anchored anonymous session sizes on the last real usage report, not the raw-history bound");
        assert.equal(s.stats.contextTokensSource, "usage", "display grade follows the anchor, not the estimate");
        assert.equal(h.relay.nonStreamCalls(), 0, "no preflight summary calls");
        const streamed = streamedBodies(h.relay.received);
        assert.ok(!streamed[2].includes(NUDGE_MARKER), "no spurious nudge injection on the healthy turn");
    } finally {
        await h.close();
    }
});

test("#2033 A2: anchor-less anonymous session keeps the raw-history fallback (nudge not blinded, #553/#728)", async () => {
    const h = await startHarness([], false); // never-reporting upstream
    try {
        const base = baseConversation();
        const r1 = await h.post(base);
        assert.equal(r1.status, 200, "turn 1 succeeds");
        await r1.text();
        const msgs2: Msg[] = [...base, { role: "assistant", content: "ok, done." }, { role: "user", content: "step two?" }];
        const r2 = await h.post(msgs2);
        assert.equal(r2.status, 200, "turn 2 succeeds");
        await r2.text();
        const s = h.anonSession();
        assert.equal(s.stats.lastUsageGradeTokens, undefined, "never-reporting upstream wrote no anchor");
        const sized = lastNudgeSized(h.logs, s.id);
        assert.ok(sized > 0, `raw-history fallback kept the nudge measurable (got ${sized}; 0 would blind it — #553)`);
        assert.equal(s.stats.contextTokensSource, "estimate", "fallback stays estimate-grade");
        assert.equal(h.relay.nonStreamCalls(), 0, "no preflight summary calls");
    } finally {
        await h.close();
    }
});
