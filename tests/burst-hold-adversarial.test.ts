// Mutation contract (#1487): drop the usage-ceiling condition in holdGrowthNudge -> T2 goes red;
// drop the share gate in detectToolBurst -> T1 goes red. Hermetic loopback rig, default `npm test` gate.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import { openaiToCore } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { detectToolBurst } from "../src/burst-hold.ts";

const WINDOW = 200_000;
// Hold ceiling = min(EMERGENCY_NUDGE_ESCALATION_PCT = 0.7, maxContextLimitPct = 0.75) => 70%.
const CEILING_PCT = 70;
// Unique to the per-turn rendered nudge; absent from the static compress system prompt.
const NUDGE_MARKER = "efficiency nudge";

type ChatMsg = Record<string, unknown>;
type LogEntry = { level: string; msg: string };
type NudgeEvent = { label: string; usagePct: number; heldInfo: string | null; reason: string };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function filler(nChars: number): string {
    const unit = "the quick brown fox jumps over the lazy dog. ";
    let s = "";
    while (s.length < nChars) s += unit;
    return s.slice(0, nChars);
}

// The marker protocol carries no per-message inline tags — real refs appear only in the
// nudge's "compressible ranges" list. The nudge message also embeds the compress guide,
// whose EXAMPLES contain literal mNNNNN strings (m00132, m00746, ...); those examples are
// rejected because session refs are dense per-message (N rendered messages ⇒ refs ≤ m00NNN),
// so any number above the payload's message count cannot be a live ref of this session.
function extractNudgeRefs(body: string): string[] {
    try {
        const j = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
        const msgs = j.messages ?? [];
        const cap = msgs.length;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i]!;
            if (msg.role !== "user") continue;
            const content = typeof msg.content === "string" ? msg.content : "";
            if (!content.includes(NUDGE_MARKER)) continue;
            const seen = new Map<number, string>();
            const re = /\bm(\d{4,})\b/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(content)) !== null) {
                const n = Number(m[1]);
                if (n <= cap) seen.set(n, m[0]!);
            }
            return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, token]) => token);
        }
    } catch {
        // non-JSON body
    }
    return [];
}

type FakeModelState = {
    reqs: { body: string; bytes: number }[];
    compressCalls: number;
    failedCompressions: number;
    lastCompressBytes: number;
};

// Honors a nudge iff the payload carries one; omits usage so the proxy's local estimate drives it.
function startFakeModel(state: FakeModelState): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const bytes = Buffer.byteLength(body);
            state.reqs.push({ body, bytes });
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const nudgeRefs = extractNudgeRefs(body);
            const shrunkEnough = bytes < state.lastCompressBytes * 0.9;
            const refSpanOk = nudgeRefs.length >= 2 && Number(nudgeRefs[nudgeRefs.length - 1]!.slice(1)) - Number(nudgeRefs[0]!.slice(1)) >= 6;
            const shouldCompress = body.includes(NUDGE_MARKER) && refSpanOk && shrunkEnough;
            if (shouldCompress) {
                state.lastCompressBytes = bytes;
                state.compressCalls++;
                const from = nudgeRefs[0]!;
                const to = nudgeRefs[nudgeRefs.length - 1]!;
                res.write(sseLine({
                    id: "b1",
                    object: "chat.completion.chunk",
                    choices: [{
                        index: 0,
                        delta: {
                            role: "assistant",
                            content: null,
                            tool_calls: [{
                                index: 0,
                                id: `call_compress_${state.compressCalls}`,
                                type: "function",
                                function: {
                                    name: "compress",
                                    arguments: JSON.stringify({
                                        content: [{
                                            startId: from,
                                            endId: to,
                                            topic: "adversarial fold",
                                            summary: `folded the middle segment ${from}..${to}: every intermediate tool output in this range was consumed during earlier turns and its conclusions are captured in prior summaries, so later turns can continue from this block without the raw payloads`,
                                        }],
                                    }),
                                },
                            }],
                        },
                    }],
                }));
                res.write(sseLine({ id: "b1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
            } else {
                const text = `ok ${state.reqs.length}`;
                res.write(sseLine({ id: "b1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
                res.write(sseLine({ id: "b1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

const NUDGE_LINE_RE = /^\[[^\]]+\] nudge (INJECT|INJECT-ESC|HOLD|ARMED-SUPPRESSED|idle)(?: T[^:]+)?: usage=(\d+)%.*(?:reason="([^"]*)")?/;

function parseNudgeEvents(logs: LogEntry[]): NudgeEvent[] {
    const out: NudgeEvent[] = [];
    for (const entry of logs) {
        const m = entry.msg.match(NUDGE_LINE_RE);
        if (!m) continue;
        out.push({
            label: m[1]!,
            usagePct: Number(m[2]),
            heldInfo: entry.msg.match(/,\s*(burst-hold\([^)]*\))/)?.[1] ?? null,
            reason: m[3] ?? "",
        });
    }
    return out;
}

// Same conversion the proxy's OpenAI prepare path applies — detector input matches wire reality.
function tailDetection(history: ChatMsg[]): ReturnType<typeof detectToolBurst> {
    const { msgs } = openaiToCore({ model: "gpt-test", messages: history } as Parameters<typeof openaiToCore>[0]);
    return detectToolBurst(msgs as CoreMessage[]);
}

type Rig = {
    close(): Promise<void>;
    post(history: ChatMsg[]): Promise<string>;
    eventsSince(mark: number): NudgeEvent[];
    logs: LogEntry[];
    fake: FakeModelState;
};

async function startRig(sessionId: string): Promise<Rig> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: LogEntry[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const fake: FakeModelState = { reqs: [], compressCalls: 0, failedCompressions: 0, lastCompressBytes: Infinity };
    const model = startFakeModel(fake);
    await listen(model);
    const modelPort = (model.address() as { port: number }).port;
    const base = defaultConfig(WINDOW);
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${modelPort}`]: {
                models: { "gpt-test": { context: WINDOW } },
                compressProtocol: "marker",
            },
        } as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            nudge: { ...base.nudge, growthFloor: 2000, growthCap: 2000, minGrowthFloor: 800 },
        }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${modelPort}/v1/chat/completions`;
    return {
        logs,
        fake,
        async post(history: ChatMsg[]): Promise<string> {
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": sessionId },
                body: JSON.stringify({ model: "gpt-test", stream: true, messages: history }),
                duplex: "half",
            } as RequestInit);
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
            let raw = "";
            for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
            let reply = "";
            for (const line of raw.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]") continue;
                try {
                    const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }> };
                    const c = j.choices?.[0]?.delta?.content;
                    if (typeof c === "string") reply += c;
                } catch {
                    // keep-alive / non-JSON SSE noise
                }
            }
            return reply;
        },
        eventsSince(mark: number): NudgeEvent[] {
            return parseNudgeEvents(logs.slice(mark));
        },
        async close(): Promise<void> {
            setLogCapture(null);
            await close(proxy);
            await close(model);
        },
    };
}

function readRound(i: number, resultChars: number): ChatMsg[] {
    const id = `call_read_${i}`;
    return [
        { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `f${i}.ts` }) } }] },
        { role: "tool", tool_call_id: id, content: filler(resultChars) },
    ];
}

function batchRound(tag: string, count: number, resultChars: number): ChatMsg[] {
    const calls: ChatMsg[] = [];
    const results: ChatMsg[] = [];
    for (let k = 0; k < count; k++) {
        const id = `call_${tag}_${k}`;
        calls.push({ id, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `${tag}_${k}.ts` }) } });
        results.push({ role: "tool", tool_call_id: id, content: filler(resultChars) });
    }
    return [
        { role: "user", content: `now read ${count} files in parallel for ${tag}` },
        { role: "assistant", content: null, tool_calls: calls },
        ...results,
    ];
}

function steadyRound(tag: string, pairs: number, charsPerMsg: number): ChatMsg[] {
    const msgs: ChatMsg[] = [];
    for (let p = 0; p < pairs; p++) {
        msgs.push({ role: "user", content: `question ${tag}.${p}: ` + filler(charsPerMsg) });
        msgs.push({ role: "assistant", content: `answer ${tag}.${p}: ` + filler(charsPerMsg) });
    }
    return msgs;
}

test("T1 sequential reads hide under the share gate: growth nudges fire normally, nothing held", async () => {
    const rig = await startRig("adv-t1");
    try {
        const history: ChatMsg[] = [{ role: "user", content: "please read these files one by one" }];
        for (let i = 1; i <= 30; i++) {
            history.push(...readRound(i, 2000));
            const reply = await rig.post(history);
            assert.ok(reply.length > 0, `round ${i}: empty reply`);
        }
        history.push({ role: "user", content: "what did you find across all of them?" });
        await rig.post(history);
        const events = rig.eventsSince(0);
        const holds = events.filter((e) => e.label === "HOLD");
        const injects = events.filter((e) => e.label === "INJECT" || e.label === "INJECT-ESC");
        const det = tailDetection(history);
        assert.ok(det.toolResults >= 5, `tail carries >=5 tool results so a count-only detector would trip (got ${det.toolResults})`);
        assert.equal(det.active, false, `strict alternation must NOT be a burst (share=${det.share.toFixed(2)})`);
        assert.equal(holds.length, 0, `sequential reads must never be held: ${JSON.stringify(holds)}`);
        assert.ok(injects.length >= 3, `expected >=3 growth injections over 30 sequential reads, got ${injects.length}`);
        assert.ok(injects.every((e) => e.usagePct < CEILING_PCT), `every injection fired via the growth path below the ceiling (got ${injects.map((e) => e.usagePct).join(",")})`);
        assert.ok(rig.fake.compressCalls >= 1, "compression must have happened");
        console.log(`[t1-metrics] rounds=30 holds=${holds.length} injects=${injects.length} maxUsage=${Math.max(...events.map((e) => e.usagePct))}% folds=${rig.fake.compressCalls}`);
    } finally {
        await rig.close();
    }
});

test("T2 perpetual parallel batches: held below ceiling, released at ceiling, usage bounded", async () => {
    const rig = await startRig("adv-t2");
    try {
        const ROUNDS = 14;
        const history: ChatMsg[] = [];
        for (let i = 1; i <= ROUNDS; i++) {
            history.push(...batchRound(`b${i}`, 10, 1500));
            const reply = await rig.post(history);
            assert.ok(reply.length > 0, `round ${i}: empty reply`);
        }
        const events = rig.eventsSince(0);
        const holds = events.filter((e) => e.label === "HOLD");
        const releases = events.filter((e) => e.label === "INJECT" || e.label === "INJECT-ESC");
        assert.ok(holds.length >= 3, `expected >=3 held requests below the ceiling, got ${holds.length}`);
        assert.ok(holds.every((e) => e.usagePct < CEILING_PCT), `every hold occurred below the ceiling (got ${holds.map((e) => e.usagePct).join(",")})`);
        assert.ok(holds.every((e) => e.heldInfo?.startsWith("burst-hold")), "each hold is attributed to burst-hold in the diag log");
        assert.ok(releases.length >= 1, "a release must occur at/above the ceiling — no never-compress trajectory exists");
        const firstRelease = releases[0]!;
        assert.ok(firstRelease.usagePct >= CEILING_PCT - 2, `first release must come at/above the ceiling (got ${firstRelease.usagePct}%, reason="${firstRelease.reason}")`);
        const maxUsage = Math.max(...events.map((e) => e.usagePct));
        assert.ok(maxUsage <= 82, `usage must stay bounded near the ceiling (max ${maxUsage}%)`);
        assert.ok(rig.fake.compressCalls >= 1, "compression must have executed");
        const peakIdx = events.findIndex((e) => e.usagePct === maxUsage);
        const afterPeak = events.slice(peakIdx + 1).map((e) => e.usagePct);
        assert.ok(afterPeak.some((u) => u <= maxUsage - 10), `expected a post-fold drop after the ${maxUsage}% peak (after: ${afterPeak.join(",")})`);
        const due = holds.length + releases.length;
        console.log(`[t2-metrics] rounds=${ROUNDS} holds=${holds.length} releases=${releases.length} holdRatio=${due ? (holds.length / due).toFixed(2) : "-"} firstReleaseAt=${firstRelease.usagePct}% maxUsage=${maxUsage}% folds=${rig.fake.compressCalls}`);
    } finally {
        await rig.close();
    }
});

test("T3 oscillating batch/steady rounds: no stickiness — steady rounds are never held", async () => {
    const rig = await startRig("adv-t3");
    try {
        const CYCLES = 4;
        const history: ChatMsg[] = [];
        type RoundRec = { kind: "batch" | "steady"; events: NudgeEvent[]; detActive: boolean; detShare: number };
        const records: RoundRec[] = [];
        for (let c = 1; c <= CYCLES; c++) {
            history.push(...batchRound(`c${c}b`, 10, 1000));
            const mark = rig.logs.length;
            const reply = await rig.post(history);
            assert.ok(reply.length > 0, `cycle ${c} batch: empty reply`);
            const det = tailDetection(history);
            records.push({ kind: "batch", events: rig.eventsSince(mark), detActive: det.active, detShare: det.share });
            history.push(...steadyRound(`c${c}s`, 4, 1000));
            const mark2 = rig.logs.length;
            const reply2 = await rig.post(history);
            assert.ok(reply2.length > 0, `cycle ${c} steady: empty reply`);
            const det2 = tailDetection(history);
            records.push({ kind: "steady", events: rig.eventsSince(mark2), detActive: det2.active, detShare: det2.share });
        }
        for (const r of records) {
            if (r.kind === "batch") {
                assert.ok(r.detActive, `batch tail must be detected as a burst (share=${r.detShare.toFixed(2)})`);
                assert.ok(r.detShare >= 0.8, `batch tail share should sit near 0.83 (got ${r.detShare.toFixed(2)})`);
            } else {
                assert.equal(r.detActive, false, `steady tail must NOT be a burst — no stickiness (share=${r.detShare.toFixed(2)})`);
            }
        }
        const steady = records.filter((r) => r.kind === "steady");
        const steadyHolds = steady.flatMap((r) => r.events.filter((e) => e.label === "HOLD"));
        assert.equal(steadyHolds.length, 0, `steady rounds must never be held: ${JSON.stringify(steadyHolds)}`);
        const steadyWithInjection = steady.filter((r) => r.events.some((e) => e.label === "INJECT" || e.label === "INJECT-ESC"));
        assert.ok(steadyWithInjection.length / steady.length >= 0.5, `more than half of steady rounds must inject normally (${steadyWithInjection.length}/${steady.length})`);
        const batchHolds = records.filter((r) => r.kind === "batch").flatMap((r) => r.events.filter((e) => e.label === "HOLD"));
        // The exact hold COUNT depends on fold timing (a post-fold baseline reset legitimately
        // idles the next round; the fresh-session zero baseline idles the first), so pin the
        // INVARIANT instead: a sub-ceiling burst round must NEVER be injected (plain or escaped)
        // — hold or idle are the only legal states — and at least one round must demonstrate the hold.
        const batchInjects = records.filter((r) => r.kind === "batch").flatMap((r) => r.events.filter((e) => e.label === "INJECT" || e.label === "INJECT-ESC"));
        assert.equal(batchInjects.length, 0, `sub-ceiling burst rounds must never be injected: ${JSON.stringify(batchInjects)}`);
        assert.ok(batchHolds.length >= 1, `at least one sub-ceiling burst round must be held (got ${batchHolds.length} holds over ${CYCLES} cycles)`);
        const all = rig.eventsSince(0);
        console.log(`[t3-metrics] cycles=${CYCLES} batchHolds=${batchHolds.length} steadyHolds=${steadyHolds.length} steadyInjected=${steadyWithInjection.length}/${steady.length} maxUsage=${Math.max(...all.map((e) => e.usagePct))}% folds=${rig.fake.compressCalls}`);
    } finally {
        await rig.close();
    }
});
