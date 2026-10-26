// #4740: when a single tool-result exceeds the chunk budget, splitChunks splits
// its tiny call fragment off into its own span. The kernel's minCompressRange
// gate counts raw msg.text.length at the SUBMITTED bounds before tool-pair
// widening runs, so previewing that fragment is atomically rejected every
// round: the serial lane burned one preview + one misleading "too small" warn
// per round, and the batch lane (one pop per range per round) nominated
// NOTHING while active, stalling those ranges indefinitely. preflight must
// discard sub-minimum spans CPU-only before previewing; pair-widening at apply
// time pulls the orphaned fragment back into the fold.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, defaultPrompts, type CompressibleRange, type Config, type CompressionCore, type CoreMessage } from "acp-kernel";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import type { Session } from "../src/session.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";
import { _resetForTest as resetRegistryForTest } from "../src/registry.ts";
import type { ExternalSummaryBatchResult, SummaryWork } from "../src/external-summary.ts";
import type { ConfiguredSummaryPlan } from "../src/external-summary-runtime.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0, "each attempt releases its upstream idle timer");
    _resetFetchUtilForTest();
    resetRegistryForTest();
});

const LIMIT = 16_384; // chunk budget = max(2000, floor(16384 * 0.6)) = 9830 units
const MIN_RANGE = 5000; // default compress.minCompressRange

type Submitted = { startRef: string; endRef: string };

// Every applyCompression range whose raw-message span carries less than
// minCompressRange characters is one the kernel's pre-check rejects
// atomically — preflight must never submit one. Block-boundary specs (bN
// refs) do not resolve to message indices and are ignored here.
function subMinSubmissions(submitted: readonly Submitted[], session: Session, messages: readonly CoreMessage[]): number {
    const idxOf = new Map<string, number>();
    messages.forEach((m, i) => idxOf.set(m.id, i));
    const refToIdx = new Map<string, number>();
    for (const [rawId, ref] of Object.entries(session.state.messageRefs.byRaw)) {
        const i = idxOf.get(rawId);
        if (i !== undefined) refToIdx.set(ref, i);
    }
    let count = 0;
    for (const r of submitted) {
        const s = refToIdx.get(r.startRef);
        const e = refToIdx.get(r.endRef);
        if (s === undefined || e === undefined || s > e) continue;
        let mass = 0;
        for (let i = s; i <= e; i++) mass += messages[i]?.text?.length ?? 0;
        if (mass > 0 && mass < MIN_RANGE) count += 1;
    }
    return count;
}

function recordingCore(core: CompressionCore, submitted: Submitted[]): CompressionCore {
    return {
        ...core,
        applyCompression: (input: Parameters<CompressionCore["applyCompression"]>[0]) => {
            for (const r of input.ranges) submitted.push({ startRef: r.startRef, endRef: r.endRef });
            return core.applyCompression(input);
        },
    };
}

// Gate-log shape: a huge tool-result (~20k tok > 9830 budget) preceded by a
// tiny tool-call. splitChunks must break before the result, leaving a head
// fragment whose raw char mass sits under the kernel gate — exactly the span
// that used to die "too small" at preview.
function overflowFixture(): CoreMessage[] {
    return [
        { id: "u1", role: "user", contentType: "text", text: "Start the task." },
        { id: "a1", role: "assistant", contentType: "text", text: "FILLER_A ".repeat(400) }, // 3200 chars ≈ 800 tok
        { id: "call1", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "tc1", text: JSON.stringify({ command: "cat bigfile.txt" }) }, // ~30 chars
        { id: "res1", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tc1", text: "R".repeat(80_000) }, // ≈ 20k tok > budget
    ];
}

test("#4740 preflight serial lane: sub-minimum head fragment is skipped CPU-only, never previewed", async () => {
    const compact = "SUMMARY: the bigfile dump is disposable filler; keep the task goal and next step.";
    const bodies: unknown[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            bodies.push(JSON.parse(raw));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: compact } }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
        const messages = overflowFixture();
        const session = getSession(`issue4740-serial-${randomUUID()}`);
        const config = defaultConfig(LIMIT, { preserveRecentMessages: 0, preserveRecentTokens: 0 }) as Config;
        const core = createCore();
        const submitted: Submitted[] = [];
        const base = recordingCore(core, submitted);
        const rigged: CompressionCore = {
            ...base,
            processTurn: (input) => {
                const turn = core.processTurn(input);
                if (!turn.nudge) return turn;
                const byRaw = turn.state.messageRefs.byRaw;
                const ranges: CompressibleRange[] = [
                    { startRef: byRaw["u1"], endRef: byRaw["res1"], count: 4, tokens: 21_000, chars: 83_244, toolPct: 0.9, textPct: 0.1 },
                ];
                return { ...turn, nudge: { ...turn.nudge, compressibleRanges: ranges } };
            },
        };
        const logs: Array<[string, string]> = [];
        const deps: PreflightDeps = {
            core: rigged, session, config, prompts: defaultPrompts, protocol: "openai",
            url: `http://127.0.0.1:${port}/v1/messages`, headers: {}, model: "weak-local-model",
            log: (level, msg) => { logs.push([level, msg]); },
        };
        const result = await preflightCompress(deps, messages);
        assert.equal(result.compressedRanges, 1, `the oversized result must still fold: ${JSON.stringify(result.failure ?? null)}`);
        assert.equal(subMinSubmissions(submitted, session, messages), 0, "no sub-minimum span may be submitted to applyCompression");
        assert.ok(!logs.some(([, msg]) => msg.includes("Total compressible content too small")),
            "no misleading 'too small' warn may be logged");
        assert.ok(bodies.length >= 1, "the fold used a real summary call");
        const block = session.state.blocks.find((b) => b.effectiveMessageIds.includes("res1"));
        assert.ok(block, "a block covers the huge result");
        assert.ok(block!.effectiveMessageIds.includes("call1"), "pair-widening pulled the orphaned call back into the fold");
        assert.ok(!result.failure, `preflight converged: ${JSON.stringify(result.failure ?? null)}`);
    } finally {
        server.close();
        server.closeIdleConnections?.();
        await once(server, "close");
    }
});

test("#4740 preflight batch lane: sub-minimum fragments no longer stall both ranges", async () => {
    const messages: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "Start the task." },
        { id: "a1", role: "assistant", contentType: "text", text: "FILLER_A ".repeat(400) },
        { id: "callA", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "tcA", text: JSON.stringify({ command: "cat bigfile-a.txt" }) },
        { id: "resA", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tcA", text: "R".repeat(80_000) },
        { id: "u2", role: "user", contentType: "text", text: "Next step." },
        { id: "a2", role: "assistant", contentType: "text", text: "FILLER_B ".repeat(400) },
        { id: "callB", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "tcB", text: JSON.stringify({ command: "cat bigfile-b.txt" }) },
        { id: "resB", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tcB", text: "S".repeat(80_000) },
    ];
    const session = getSession(`issue4740-batch-${randomUUID()}`);
    const config = defaultConfig(LIMIT, { preserveRecentMessages: 0, preserveRecentTokens: 0 }) as Config;
    const core = createCore();
    const submitted: Submitted[] = [];
    const summarizeCalls: Array<readonly SummaryWork[]> = [];
    const plan = {
        stats: { calls: 0, attempts: 0 },
        summarize: async (work: readonly SummaryWork[]) => {
            summarizeCalls.push(work);
            const batch: ExternalSummaryBatchResult = {
                status: "finished",
                results: work.map(() => ({ status: "success" as const, summary: "SUMMARY: disposable dump; keep goal and next step.", targetIndex: 0, attempts: [] })),
            };
            return batch;
        },
    } as unknown as ConfiguredSummaryPlan;
    const base = recordingCore(core, submitted);
    const rigged: CompressionCore = {
        ...base,
            processTurn: (input) => {
                const turn = core.processTurn(input);
                if (!turn.nudge) return turn;
                const byRaw = turn.state.messageRefs.byRaw;
                const mk = (first: string, last: string): CompressibleRange => ({
                startRef: byRaw[first], endRef: byRaw[last], count: 4, tokens: 21_000, chars: 83_300, toolPct: 0.9, textPct: 0.1,
            });
            return { ...turn, nudge: { ...turn.nudge, compressibleRanges: [mk("u1", "resA"), mk("u2", "resB")] } };
        },
    };
    const logs: Array<[string, string]> = [];
    const deps: PreflightDeps = {
        core: rigged, session, config, prompts: defaultPrompts, protocol: "openai",
        url: "http://127.0.0.1:9/v1/chat/completions", headers: {}, model: "weak-local-model",
        externalSummary: plan,
        log: (level, msg) => { logs.push([level, msg]); },
    };
    const result = await preflightCompress(deps, messages);
    assert.equal(summarizeCalls.length, 1, `the batch lane must nominate BOTH ranges in one wave (got ${summarizeCalls.length} call(s))`);
    assert.ok(summarizeCalls[0].length >= 2, `both viable spans ride the same summary call (got ${summarizeCalls[0].length})`);
    assert.equal(result.compressedRanges, 2, `both ranges must fold: ${JSON.stringify(result.failure ?? null)}`);
    assert.equal(subMinSubmissions(submitted, session, messages), 0, "no sub-minimum span may be submitted to applyCompression");
    assert.ok(!logs.some(([, msg]) => msg.includes("Total compressible content too small")),
        "no misleading 'too small' warn may be logged");
    for (const [callId, resultId] of [["callA", "resA"], ["callB", "resB"]] as const) {
        const block = session.state.blocks.find((b) => b.effectiveMessageIds.includes(resultId));
        assert.ok(block, `a block covers ${resultId}`);
        assert.ok(block!.effectiveMessageIds.includes(callId), `pair-widening pulled ${callId} back into the fold`);
    }
});
