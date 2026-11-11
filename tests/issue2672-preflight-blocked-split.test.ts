import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on 4xx retries so the halving path exercises immediately.
process.env.BILI_REPLAY_RETRY_MAX = "1";
process.env.BILI_REPLAY_RETRY_BASE_MS = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #2672 regression: the chunked retry after a summary failure split the range
// IN HALF ON RAW MESSAGE INDICES. Protected messages hold the truthy BLOCKED
// sentinel in state.messageRefs.byRaw, so when the blind midpoint landed on
// one, BOTH halves carried an unresolvable boundary ("Invalid boundary
// ref(s): startId=\"BLOCKED\""), every sub-chunk was rejected at preview, and
// the whole range was abandoned — despite each half being summarizable once
// its rim snapped past the protected message(s). The kernel already excludes
// protected messages from a block's effective ids; only the BOUNDARIES must
// name resolvable messages.
//
// Geometry (token regime, named session; ASCII text estimates at chars/4 plus
// a fixed tool-schema/wire overhead — measured ~4.3k tok here): window 8000,
// chunk budget 0.6x = 4800 tok. The kernel segments compressible ranges at
// USER messages once a group reaches >= 3 (kernel recommend.ts), while
// BLOCKED-ref messages create NO gap — so the old region is one user opener
// followed by assistant messages only, keeping it a SINGLE range that spans
// the protected pair internally (exactly the production shape).
//   idx 0      user opener (short)
//   idx 1..2   assistant foldable 2697 chars   \
//   idx 3..4   assistant PROTECTED 2562 chars  | c1 = [0..7] by token packing
//   idx 5..7   assistant foldable 2697 chars   /   (8 + 6x675 = 4733 <= 4800),
//   idx 8      assistant PROTECTED 2562 chars    mid = 3 -> BOTH raw halves
//   idx 9      assistant foldable 2697 chars     [4..7]/[0..3] touch the pair
//   idx 10..14 assistant tail 358 chars          -> recent zone (M=1000 grows
//   idx 15     latest user msg                    backward; endpoint drifts +-1)
// est ~10.7k tok vs 8000: gap (< old-region mass) so the #1841/#330 strict
// walk runs UNRELAXED; overshoot ~1.3x stays far below the emergency-digest
// coverage bound (19.2x), so the LLM summary path is exercised. c1's body
// (~13.6k chars, protected pair excluded) exceeds FAIL_ABOVE_CHARS; the
// snapped halves ([0..2] ~5.4k chars, [5..7] ~8.1k chars) sit inside
// [minCompressRange 5000, FAIL_ABOVE). idx 8 is protected so the residual
// chunk after c1 carries < minCompressRange of effective mass no matter where
// the recent-zone endpoint lands — nothing besides the snapped halves can fold.
// Pre-fix: both halves carry a BLOCKED boundary -> preview rejects both ->
// nothing folds -> payload stays over-window -> 502 (#4079: no marker is written anymore).
// Post-fix: halves snap past the protected rim, fold, payload fits -> 200.

const SUMMARY_TEXT =
    "BLOCKED-SPLIT TEST SUMMARY: the segment held deterministic load-growth payload across several turns; every raw marker is derivable from the seed, so the folded view loses nothing of value.";

const PROTECT_MARKER = "PROTECTED_MARKER_2672";

const FAIL_ABOVE_CHARS = 12_000;
// Mirrors config.compress.minCompressRange (kernel default) — sub-minimum spans
// are rejected at preview, so a recovered chunk below this was not a real fold.
const MIN_COMPRESS_RANGE_CHARS = 5_000;

type Call = { stream: boolean; summary: boolean; contentChars: number; failed: boolean; hasMarker: boolean };

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function failedSummarySse(res: http.ServerResponse): void {
    res.write(sse("response.failed", {
        type: "response.failed",
        response: { id: "resp_fail", status: "failed", error: { code: "context_length_exceeded", message: "Input is too long for this model." } },
    }));
    res.end();
}

function okSummarySse(res: http.ServerResponse): void {
    for (const part of [SUMMARY_TEXT.slice(0, 40), SUMMARY_TEXT.slice(40)]) {
        res.write(sse("response.output_text.delta", { type: "response.output_text.delta", delta: part }));
    }
    res.write(sse("response.completed", { type: "response.completed", response: { id: "resp_sum", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5 } } }));
    res.end();
}

function forwardSse(res: http.ServerResponse, inputTokens = 800): void {
    res.write(sse("response.completed", {
        type: "response.completed",
        response: {
            id: "resp_fwd",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: inputTokens, output_tokens: 4 },
        },
    }));
    res.end();
}

type ParsedBody = { stream?: boolean; instructions?: unknown; input?: unknown; model?: string };

function parseBody(raw: string): ParsedBody {
    try {
        return JSON.parse(raw) as ParsedBody;
    } catch {
        return {};
    }
}

function isSummaryCall(parsed: ParsedBody): boolean {
    return typeof parsed.instructions === "string" && Array.isArray(parsed.input) && parsed.input.length === 1;
}

function inputContent(parsed: ParsedBody): string {
    const first = Array.isArray(parsed.input) ? parsed.input[0] : undefined;
    const c = first && typeof first === "object" ? (first as Record<string, unknown>).content : undefined;
    return typeof c === "string" ? c : "";
}

function makeUpstream(calls: Call[], failAboveChars: number): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = parseBody(Buffer.concat(chunks).toString("utf8"));
            const content = isSummaryCall(parsed) ? inputContent(parsed) : "";
            const failed = isSummaryCall(parsed) && content.length > failAboveChars;
            calls.push({ stream: parsed.stream === true, summary: isSummaryCall(parsed), contentChars: content.length, failed, hasMarker: content.includes(PROTECT_MARKER) });
            if (isSummaryCall(parsed) && parsed.stream !== true) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ detail: "Stream must be set to true" }));
                return;
            }
            if (failed) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                failedSummarySse(res);
                return;
            }
            if (isSummaryCall(parsed)) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                okSummarySse(res);
            } else {
                forwardSse(res);
            }
        });
    });
}

function foldText(i: number): string {
    return `Assistant analysis part ${i}. ` + `FOLD_${i}_payload_`.repeat(178);
}

function protectText(i: number): string {
    return `Protected segment ${i} ${PROTECT_MARKER} stays visible. ` + `PROT_${i}_payload_`.repeat(167);
}

function tailText(i: number): string {
    return `Tail segment ${i} near the recent zone. ` + `TAIL_${i}_payload_`.repeat(20);
}

function buildInput() {
    const item = (role: string, text: string) => ({ type: "message", role, content: text });
    // One user opener, then assistant messages only: a user message inside the
    // old region would split it into per-turn ranges (kernel segmentation),
    // which is not the shape under test.
    return [
        item("user", "Please begin the long analysis."),
        item("assistant", foldText(1)),
        item("assistant", foldText(2)),
        item("assistant", protectText(3)),
        item("assistant", protectText(4)),
        item("assistant", foldText(5)),
        item("assistant", foldText(6)),
        item("assistant", foldText(7)),
        item("assistant", protectText(8)),
        item("assistant", foldText(9)),
        item("assistant", tailText(10)),
        item("assistant", tailText(11)),
        item("assistant", tailText(12)),
        item("assistant", tailText(13)),
        item("assistant", tailText(14)),
        item("user", "Please continue."),
    ];
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: 8_000,
        // Content-keyed protection: idx 3..4 sit exactly on c1's halving
        // midpoint; idx 8 keeps the residual chunk sub-minimum no matter where
        // the shrunken recent-zone endpoint lands (it drifts +-1 message).
        kernelConfig: defaultConfig(8_000, {
            preserveRecentMessages: 6,
            preserveRecentTokens: 1_000,
            isMessageProtected: (m) => (m.text ?? "").includes(PROTECT_MARKER),
        }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

async function driveResponses(proxyPort: number, upstreamPort: number, session: string, model: string, input: unknown): Promise<Response> {
    return await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model, stream: true, input }),
    });
}

test("#2672 halving midpoint on a protected message: halves snap past the BLOCKED rim and recover", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, FAIL_ABOVE_CHARS);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 8_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponses(proxyPort, upstreamPort, "s2672-split", "gpt-7-sol", buildInput());
        assert.equal(r.status, 200, `request must recover via boundary-snapped halves, got ${r.status}`);
        await r.text();

        const summaries = calls.filter((c) => c.summary);
        const failed = summaries.filter((c) => c.failed);
        const succeeded = summaries.filter((c) => !c.failed);
        assert.ok(failed.length >= 1, `expected the oversized chunk to fail first, got ${JSON.stringify(summaries)}`);
        assert.ok(failed.every((c) => c.contentChars > FAIL_ABOVE_CHARS), "only oversized chunks may fail");
        // At least one boundary-snapped half must have folded; the walk may
        // stop after the first if that alone closes the gap to the window.
        assert.ok(
            succeeded.length >= 1,
            `a smaller chunk must recover via its own summary, got ${JSON.stringify(summaries)}`,
        );
        assert.ok(
            succeeded.every((c) => c.contentChars <= FAIL_ABOVE_CHARS && c.contentChars >= MIN_COMPRESS_RANGE_CHARS),
            `recovered chunks must be real sub-spans (>= minCompressRange, <= failing size), got ${JSON.stringify(summaries)}`,
        );
        assert.ok(
            succeeded.every((c) => c.contentChars < Math.min(...failed.map((f) => f.contentChars))),
            "recovery must come from STRICTLY smaller chunks than the failures",
        );
        // The kernel hard-excludes protected messages from the block: their
        // bytes must never ride inside a summary call.
        assert.ok(
            summaries.every((c) => !c.hasMarker),
            `protected content leaked into a summarization body: ${JSON.stringify(summaries)}`,
        );
        assert.ok(calls.some((c) => !c.summary), "the folded payload was forwarded");

        const sess = listSessions().find((s) => s.id.includes("s2672-split"));
        assert.ok(sess, "session recorded");
        assert.equal(sess?.metadata?.preflightDeadEnd, undefined, "successful preflight must not leave a dead-end marker");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        upstream.close();
        upstream.closeIdleConnections?.();
        await Promise.all([once(proxy, "close"), once(upstream, "close")]);
    }
});
