import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "0";
// Fail fast on the very first 429 instead of the default 3 attempts with
// exponential backoff — these tests are about the post-retry behavior.
process.env.BILI_REPLAY_RETRY_MAX = "1";

import { createCore, defaultConfig, type Config } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { type CompressSettings, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #4050: a short request deactivates a retained fold (kernel syncBlocks, by
// design); when the main history then returns under canonical-equivalent id
// churn (client re-serialization), the fold must RECOVER its coverage instead
// of losing it forever (summary dropped from the wire, folded originals
// re-sent every turn). Four scenarios pin the contract end-to-end through a
// real HTTP proxy: two controls prove the material suffices (no-short churn
// recovers; exact-id resend recovers), the reported shape must recover too,
// and a genuinely edited span must stay an honest mismatch.

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

type Call = { stream: boolean; body: string };

function makeUpstreamOk(calls?: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls?.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ content: [{ type: "text", text: "SUMMARY: the large recent user message was a deterministic load-growth payload; its raw content is no longer needed." }] }));
            }
        });
    });
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>, kernelOverrides?: Partial<Config>, compressOverrides?: Partial<CompressSettings>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000, kernelOverrides),
        compress: { injectTool: true, injectNudge: true, ...compressOverrides },
        promptCache: { routing: "auto" },
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
    } as ProxyOptions);
}

for (const scenario of ["isolated-normalized", "short-exact", "short-normalized", "isolated-edited"] as const) {
    test(`issue4050 ${scenario}`, async () => {
        const calls: Call[] = [];
        const upstream = makeUpstreamOk(calls);
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;
        const proxy = await startProxy(upstreamPort, { "gpt-short-wire": { context: 400_000 } });
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const sid = `issue4050-${scenario}`;
        const post = async (input: unknown[]) => {
            const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, {
                method: "POST", headers: { "content-type": "application/json", "x-acp-session": sid },
                body: JSON.stringify({ model: "gpt-short-wire", stream: true, max_output_tokens: 1024, input }),
            });
            const body = await response.text();
            assert.equal(response.status, 200, body.slice(0, 300));
        };
        try {
            const main = Array.from({ length: 24 }, (_, i) => ({
                type: "message", role: i % 2 ? "assistant" : "user",
                content: `main turn ${i} ${(`UNIQUE_${i}_stable_text `).repeat(110)}`,
            }));
            await post(main);
            const session = getSession(sid);
            const messages = session.lastMessages;
            assert.ok(messages && messages.length >= 24);
            session.state = createCore().applyCompression({
                ranges: [{ startRef: "m00001", endRef: "m00007", summary: "Compressed main history: seven early turns preserved the investigation, implementation decisions, and verified test evidence." }],
                messages, state: session.state, config: defaultConfig(400_000),
            }).state;
            await post(main);
            assert.equal(session.state.blocks.length, 1);
            assert.ok(session.state.blocks[0].active);
            const baselineWireBytes = Buffer.byteLength(calls.at(-1)!.body);
            const before = session.state.blocks[0].effectiveMessageIds.slice();
            let activeAfterShort: number | null = null;
            if (scenario.startsWith("short-")) {
                const short = Array.from({ length: 3 }, (_, i) => ({
                    type: "message", role: "user",
                    content: Array.from({ length: 13 }, (_, j) => ({ type: "input_text", text: `utility ${i} part ${j} padding words here now` })),
                }));
                await post(short);
                activeAfterShort = session.state.blocks.filter(b => b.active).length;
                assert.equal(session.state.blocks.length, 1, "raw-count guard retains the block");
                assert.equal(activeAfterShort, 0, "short request deactivates retained block");
            }
            const replay = main.map(m => ({...m, content: scenario === "short-exact" ? m.content :
                scenario === "isolated-edited" ? "A genuinely different replacement with no prior semantic meaning." : m.content.replaceAll(" ", "  ")}));
            await post(replay);
            const wire = calls.at(-1)!.body;
            writeFileSync(`${tmpdir()}/issue4050-wire-${scenario}.json`, wire);
            const result = {
                scenario, activeAfterShort, retainedBlocks: session.state.blocks.length,
                finalActiveBlocks: session.state.blocks.filter(b => b.active).length,
                coveredIdsChanged: JSON.stringify(before) !== JSON.stringify(session.state.blocks[0]?.effectiveMessageIds),
                summaryOnWire: wire.includes("Compressed main history: seven early turns"),
                foldedAssistantOriginalOnWire: wire.includes("UNIQUE_1_stable_text"),
                baselineWireBytes, replayWireBytes: Buffer.byteLength(wire),
            };
            console.log("ISSUE4050_RESULT " + JSON.stringify(result));
            if (scenario === "isolated-edited") {
                // Negative control: a genuine edit is an honest mismatch — no
                // blind restore, the folded span simply does not come back.
                assert.equal(result.summaryOnWire, false, "a genuinely edited span is never restored");
                assert.equal(result.foldedAssistantOriginalOnWire, false);
                assert.equal(result.finalActiveBlocks, 0);
                assert.ok(result.replayWireBytes < result.baselineWireBytes, "the rewritten span replaces the seven folded turns");
            } else {
                assert.equal(result.summaryOnWire, true, `${scenario}: the fold recovers its coverage`);
                assert.equal(result.foldedAssistantOriginalOnWire, false, `${scenario}: the folded originals stay off the wire`);
                assert.equal(result.finalActiveBlocks, 1, `${scenario}: the retained block is active again`);
                assert.ok(result.replayWireBytes - result.baselineWireBytes < 5_000,
                    `${scenario}: no unfolded payload re-sent (pre-fix short-normalized paid +${80_867 - 63_850}B for the folded originals)`);
            }
        } finally {
            proxy.close(); proxy.closeIdleConnections?.();
            upstream.close(); upstream.closeIdleConnections?.();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
        }
    });
}
