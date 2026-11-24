import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { startServer, countSystemAndToolsTokens, projectThinkingMass } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { estimateCoreMessages } from "../src/preflight.ts";
import { applyEstimateCalibration } from "../src/util.ts";
import { settleUsageReport } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";

let seq = 0;
function sigOnly(sig: string): BiliMessage {
    seq++;
    return { id: `sig-${seq}`, role: "assistant", contentType: "reasoning", text: "", thinkingSignature: sig };
}
function textMsg(chars: number): BiliMessage {
    seq++;
    return { id: `txt-${seq}`, role: "user", contentType: "text", text: "a".repeat(chars) };
}

let sessSeq = 0;
function makeSession(): Session {
    sessSeq += 1;
    return {
        id: `cal-think-${sessSeq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const ORIGIN = "http://127.0.0.1:8317";
const OTHER_ORIGIN = "http://127.0.0.1:9999";

test("projectThinkingMass: calibrated k̂ > 1 with empty-text signature carrier does not double-count tokenizer gap", () => {
    const msgs = [
        textMsg(160_000 * 4),
        sigOnly("cpa-gemini-carrier-v1:next:function:" + "x".repeat(600)),
    ];
    const systemText = "S".repeat(7_200);
    const localBase = estimateCoreMessages(msgs) + countSystemAndToolsTokens(systemText, []);
    const k = 1.46;
    const providerInputTokens = Math.round(localBase * k) + 150;

    projectThinkingMass(msgs, {
        providerInputTokens,
        measured: true,
        systemText,
        tools: [],
        imageTokens: 0,
        calibrationFactor: k,
        calibrationOrigin: ORIGIN,
        currentOrigin: ORIGIN,
    });

    const postLocal = estimateCoreMessages(msgs) + countSystemAndToolsTokens(systemText, []);
    const calibrated = applyEstimateCalibration(postLocal, k, ORIGIN, ORIGIN);
    assert.ok(
        Math.abs(calibrated - providerInputTokens) <= 50,
        `calibrated post-projection estimate ${calibrated} must match billed ${providerInputTokens} (pre-fix inflated to ~${Math.round(providerInputTokens * k)})`,
    );
    assert.ok((msgs[1]!.thinkingTokens ?? 0) < 250, `empty-text carrier should not absorb tokenizer gap, got ${msgs[1]!.thinkingTokens}`);
});

test("projectThinkingMass: real hidden thinking with k̂ > 1 reconstructs exact billed total and preserves k̂ without drift", () => {
    const msgs = [
        textMsg(100_000 * 4),
        sigOnly("s".repeat(2000)),
    ];
    const overhead = countSystemAndToolsTokens("", []);
    const localBase = estimateCoreMessages(msgs) + overhead;
    const k = 1.46;
    const hiddenThinkingBilled = 50_000;
    const providerInputTokens = Math.round(localBase * k) + hiddenThinkingBilled;

    projectThinkingMass(msgs, {
        providerInputTokens,
        measured: true,
        systemText: "",
        tools: [],
        imageTokens: 0,
        calibrationFactor: k,
        calibrationOrigin: ORIGIN,
        currentOrigin: ORIGIN,
    });

    const postLocal = estimateCoreMessages(msgs) + overhead;
    const calibrated = applyEstimateCalibration(postLocal, k, ORIGIN, ORIGIN);
    assert.ok(
        Math.abs(calibrated - providerInputTokens) <= 10,
        `calibrated post-projection estimate ${calibrated} must reconstruct billed ${providerInputTokens}`,
    );

    const s = makeSession();
    for (let i = 0; i < 3; i++) {
        settleUsageReport(s, { total: providerInputTokens, reportedCached: null, upstream: ORIGIN }, postLocal);
    }
    assert.ok(typeof s.stats.calibratedEstimate === "number", "k̂ published");
    assert.ok(
        Math.abs(s.stats.calibratedEstimate! - k) < 0.01,
        `k̂ must remain ~${k} without drift, got ${s.stats.calibratedEstimate}`,
    );
});

test("projectThinkingMass: falls back to uncalibrated gap when k̂ is absent or origin mismatches", () => {
    const msgsAbsent = [textMsg(40_000), sigOnly("s".repeat(1000))];
    const msgsMismatch = [textMsg(40_000), sigOnly("s".repeat(1000))];
    const overhead = countSystemAndToolsTokens("", []);
    const localBase = estimateCoreMessages(msgsAbsent) + overhead;
    const billed = localBase + 30_000;

    const gotAbsent = projectThinkingMass(msgsAbsent, {
        providerInputTokens: billed,
        measured: true,
        systemText: "",
        tools: [],
        imageTokens: 0,
    });
    const gotMismatch = projectThinkingMass(msgsMismatch, {
        providerInputTokens: billed,
        measured: true,
        systemText: "",
        tools: [],
        imageTokens: 0,
        calibrationFactor: 1.46,
        calibrationOrigin: OTHER_ORIGIN,
        currentOrigin: ORIGIN,
    });

    assert.equal(gotAbsent, 30_000);
    assert.equal(gotMismatch, 30_000);
    assert.equal(msgsAbsent[1]!.thinkingTokens, 30_000);
    assert.equal(msgsMismatch[1]!.thinkingTokens, 30_000);
});

test("projectThinkingMass: real hidden thinking with k̂ < 1 avoids under-projection", () => {
    const msgs = [
        textMsg(100_000 * 4),
        sigOnly("s".repeat(2000)),
    ];
    const overhead = countSystemAndToolsTokens("", []);
    const localBase = estimateCoreMessages(msgs) + overhead;
    const k = 0.7;
    const hiddenThinkingBilled = 40_000;
    const providerInputTokens = Math.round(localBase * k) + hiddenThinkingBilled;

    projectThinkingMass(msgs, {
        providerInputTokens,
        measured: true,
        systemText: "",
        tools: [],
        imageTokens: 0,
        calibrationFactor: k,
        calibrationOrigin: ORIGIN,
        currentOrigin: ORIGIN,
    });

    const postLocal = estimateCoreMessages(msgs) + overhead;
    const calibrated = applyEstimateCalibration(postLocal, k, ORIGIN, ORIGIN);
    assert.ok(
        Math.abs(calibrated - providerInputTokens) <= 10,
        `calibrated estimate ${calibrated} must match billed ${providerInputTokens} when k̂ < 1`,
    );
});

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("e2e: session with learned k̂ ≈ 1.46 does not falsely trip preflight when an empty-text signed thinking carrier arrives under window", async () => {
    let mainRequests = 0;
    let summaryRequests = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(raw) as { messages?: unknown[]; tools?: unknown[]; system?: unknown };
            const isSummary = !Array.isArray(parsed.tools) || parsed.tools.length === 0;
            if (isSummary) {
                summaryRequests++;
                res.writeHead(502, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { type: "server_error", message: "simulated summary failure" } }));
                return;
            }
            mainRequests++;
            const approxLocalTokens = Math.ceil(raw.length / 4);
            const billedTokens = Math.min(236_500, Math.round(approxLocalTokens * 1.46));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(anthropicSse("message_start", {
                type: "message_start",
                message: { id: `msg_cal_${mainRequests}`, role: "assistant", usage: { input_tokens: billedTokens } },
            }));
            res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            res.write(anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
            res.write(anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }));
            res.write(anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }));
            res.write(anthropicSse("message_stop", { type: "message_stop" }));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();

    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gemini-4-neon-xhigh": { context: 300_000 } } } },
        modelContextLimit: 300_000,
        kernelConfig: defaultConfig(300_000),
        compress: { injectTool: true, injectNudge: true, reasoning: { drop: false } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
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

    try {
        const sessionId = "repro-k-double-count-3340e3ce";
        const system = "S".repeat(8_000);
        const tools = [{ name: "Read", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }];
        const messages: Array<Record<string, unknown>> = [{ role: "user", content: "start investigation" }];

        const postTurn = async (): Promise<{ status: number; body: string }> => {
            const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-acp-session": sessionId,
                },
                body: JSON.stringify({
                    model: "gemini-4-neon-xhigh",
                    max_tokens: 1024,
                    stream: true,
                    system,
                    tools,
                    messages,
                }),
            });
            return { status: resp.status, body: await resp.text() };
        };

        // 3 turns with visible thinking + large text (~158K local tokens -> ~231K billed at k̂=1.46)
        // so the calibration ring publishes k̂ ≈ 1.46 while actual usage stays well below the ~268K preflight wall.
        for (let i = 0; i < 3; i++) {
            messages.push({
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "reasoning step " + "r".repeat(2_000), signature: `sig_vis_${i}` },
                    { type: "tool_use", id: `tu_${i}`, name: "Read", input: { path: `/tmp/f${i}.ts` } },
                ],
            });
            messages.push({
                role: "user",
                content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: `file ${i}: ` + "c".repeat(200_000) }],
            });
            const r = await postTurn();
            assert.equal(r.status, 200, `warmup turn ${i + 1} must succeed`);
            assert.match(r.body, /event: message_stop/, `warmup turn ${i + 1} must complete cleanly`);
        }

        // Turn 4: add ONE empty-text signature-only carrier (CPA Gemini function-call carrier shape).
        // Real billed input is ~236K (< 268K window), so preflight must NOT trigger.
        messages.push({
            role: "assistant",
            content: [
                { type: "thinking", thinking: "", signature: "cpa-gemini-carrier-v1:next:function:" + "z".repeat(400) },
                { type: "tool_use", id: "tu_carrier", name: "Read", input: { path: "/tmp/carrier.ts" } },
            ],
        });
        messages.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_carrier", content: "small result" }],
        });

        const turn4 = await postTurn();
        assert.equal(summaryRequests, 0, `turn 4 under window must NOT trigger spurious preflight summary (saw ${summaryRequests})`);
        assert.equal(turn4.status, 200, `turn 4 must return 200, got ${turn4.status}: ${turn4.body}`);
        assert.match(turn4.body, /event: message_stop/, `turn 4 must forward cleanly without preflight error: ${turn4.body}`);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
