// #2791 / #2807: END-TO-END cross-wire continuity proof. The wire-neutral
// affinity hashing (affinity-neutral.ts) is unit-pinned at the resolver
// level, but the property that actually closes #2791 is a PROXY-level
// conjunction that no resolver test can see:
//
//   session continuity (same pfa-* id, no re-mint)
//   AND fold attachment survives the switch (carrier on the outbound,
//       covered early content ABSENT — not merely "the same session id")
//   AND no re-fold fires on the switch turn (no round-2, blocks stable).
//
// The load-bearing implicit contract: the openai and anthropic wire
// adapters must derive the SAME kernel core ids for the same logical
// content (content-hash ids are computed after wire->core conversion). The
// affinity layer now matches across wires, so if an adapter change ever
// breaks core-id equivalence, session continuity stays green while fold
// attachment silently dies — the history would replay unfolded (the 263%
// symptom) behind a passing affinity suite. This test is the tooth that
// catches exactly that regression class, in both directions of failure:
//   - affinity layer regresses -> fresh pfa-* mint (pfas !== 1)
//   - adapter/core-id equivalence regresses -> carrier missing or covered
//     content leaking through unfolded.
// Verified red on master (pre-#2807): pfas=2, no carrier, covered fillers
// all present on the switch body.
//
// Harness: single rig, both lanes on one mock upstream (openai SSE on
// /v1/chat/completions, anthropic SSE on /v1/messages), proxy-mode compress
// via injectTool so the fold executes server-side — the anonymous stateless
// client replays its full history every turn, exactly like dsh web.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

// Hermetic state dirs BEFORE importing the server modules.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-2791-crosswire-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { getSession } = await import("../src/session.ts");
const { prefixAffinity } = await import("../src/prefix-affinity.ts");
const { defaultConfig } = await import("acp-kernel");

const THRESHOLD = 64 * 1024;
const SUMMARY_TEXT = "Fold summary: the audit covered provinces one through six, ledger entries stable, no anomalies recorded in any region of the network.";
const EARLY_FILLER_TAG = "Paragraph 3-";
const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: ledger audit of the ming dynasty grain transport network continued without incident across all provinces. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

const parseRefIds = (body: string): string[] => {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
};

test("cross-wire switch keeps the anonymous session AND its fold attached end-to-end (#2791/#2807)", { timeout: 180_000 }, async () => {
    const bodies: { openai: string[]; anthropic: string[] } = { openai: [], anthropic: [] };
    let suppress = false;
    let foldDemands = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const url = req.url ?? "";
            const idx = bodies.openai.length + bodies.anthropic.length + 1;
            const wantFold = !suppress && Buffer.byteLength(body) > THRESHOLD && parseRefIds(body).length >= 12;
            if (wantFold) { foldDemands++; suppress = true; }
            const reply = `Reply ${idx}: acknowledged. ` + FILLER(idx % 7, 0.2);
            if (url.endsWith("/v1/chat/completions")) {
                bodies.openai.push(body);
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                const line = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
                if (wantFold) {
                    const refs = parseRefIds(body);
                    const args = JSON.stringify({ content: [{ startId: refs[2]!, endId: refs[refs.length - 6]!, topic: "audit fold", summary: SUMMARY_TEXT }] });
                    line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_cmp_${idx}`, type: "function", function: { name: "compress", arguments: args } }] } }] });
                    line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 2 } });
                } else {
                    line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply } }] });
                    line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
                }
                res.write("data: [DONE]\n\n");
                res.end();
                return;
            }
            bodies.anthropic.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const ev = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
            ev("message_start", { type: "message_start", message: { id: `msg_a_${idx}`, role: "assistant", usage: { input_tokens: 100 } } });
            ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
            ev("content_block_stop", { type: "content_block_stop", index: 0 });
            ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
            ev("message_stop", { type: "message_stop" });
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "probe-model": { context: 200_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as unknown as import("../src/config.ts").ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const openaiBase = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const anthropicBase = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

    type Msg = { role: string; content: string };
    const hist: Msg[] = [];
    try {
        // Phase A — the openai lane establishes the anonymous session and folds.
        const openaiTurn = async (t: number): Promise<void> => {
            hist.push({ role: "user", content: `Turn ${t}: audit province ${t}. ` + FILLER(t, 6) });
            const resp = await fetch(openaiBase, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "probe-model", stream: true, messages: [...hist] }) });
            assert.equal(resp.status, 200, `openai turn ${t}`);
            await resp.text();
            hist.push({ role: "assistant", content: `Reply about province ${t}: acknowledged. ` + FILLER(t, 0.2) });
        };
        for (let t = 1; t <= 12; t++) await openaiTurn(t);
        const pfas = prefixAffinity.trackedSessionIds().filter((id) => id.startsWith("pfa-"));
        assert.equal(pfas.length, 1, "one anonymous session on the openai lane");
        const sessionId = pfas[0]!;
        const blocksAfterFold = getSession(sessionId)!.state.blocks.map((b) => b.blockId);
        assert.ok(blocksAfterFold.length >= 1, "the fold landed on the openai lane");
        const foldsBeforeSwitch = foldDemands;
        const anthropicsBeforeSwitch = bodies.anthropic.length;

        // Phase B — the wire switch: same conversation, anthropic render, new question.
        const anthropicTurn = async (t: number, question: string): Promise<void> => {
            hist.push({ role: "user", content: question });
            const messages = hist.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] }));
            const resp = await fetch(anthropicBase, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "probe-model", max_tokens: 1024, stream: true, messages }) });
            const raw = await resp.text();
            if (resp.status !== 200) assert.fail(`anthropic turn ${t}: ${resp.status}: ${raw.slice(0, 200)}`);
            hist.push({ role: "assistant", content: `Anthropic reply about turn ${t}: acknowledged. ` + FILLER(t, 0.2) });
        };
        await anthropicTurn(13, "Turn 13: which provinces did the audit cover, and were there anomalies?");

        const switchBody = bodies.anthropic[anthropicsBeforeSwitch]!;
        // Session continuity — no fresh pfa-* mint behind the wire switch.
        const pfasB = prefixAffinity.trackedSessionIds().filter((id) => id.startsWith("pfa-"));
        assert.equal(pfasB.length, 1, `the wire switch must not fork: got ${pfasB.join(", ")}`);
        assert.equal(pfasB[0], sessionId);
        // Fold attachment — the carrier rides the anthropic outbound and the
        // covered early content stays folded (NOT replayed raw).
        assert.ok(switchBody.includes(SUMMARY_TEXT), "the fold carrier is attached on the anthropic wire");
        assert.equal((switchBody.match(new RegExp(EARLY_FILLER_TAG, "g")) ?? []).length, 0, "covered early content must not replay unfolded on the switch turn");
        // No re-fold — one anthropic request (no round-2), no new fold demand.
        assert.equal(bodies.anthropic.length - anthropicsBeforeSwitch, 1, "no round-2 on the switch turn");
        assert.equal(foldDemands, foldsBeforeSwitch, "no re-fold demanded on the switch turn");
        assert.deepEqual(getSession(sessionId)!.state.blocks.map((b) => b.blockId), blocksAfterFold, "fold blocks unchanged across the switch");

        // Phase C — the follow-up turn stays folded and continues the same session.
        await anthropicTurn(14, "Turn 14: continue with province seven.");
        const followUp = bodies.anthropic[bodies.anthropic.length - 1]!;
        assert.ok(followUp.includes(SUMMARY_TEXT), "the carrier persists on the follow-up turn");
        assert.equal((followUp.match(new RegExp(EARLY_FILLER_TAG, "g")) ?? []).length, 0, "covered content stays folded on the follow-up turn");
        assert.equal(foldDemands, foldsBeforeSwitch, "no spurious re-fold after the switch");
        assert.deepEqual(prefixAffinity.trackedSessionIds().filter((id) => id.startsWith("pfa-")), [sessionId]);
    } finally {
        proxy.close();
        upstream.close();
    }
});

// #2791 follow-up (neutral projections for responses/google): the same
// proxy-level conjunction, extended onto the responses (/v1/responses,
// codex / dsh openai-responses shape) and google (v1beta
// :streamGenerateContent, Gemini shape) lanes. Phase A folds on the openai
// lane; phase B switches the SAME history onto the responses wire; phase C
// switches it again onto the google wire. Every switch must keep the one
// anonymous session, the fold carrier, and the covered content folded.
test("cross-wire switch onto the responses and google lanes keeps the session AND its fold (#2791)", { timeout: 180_000 }, async () => {
    const bodies: { openai: string[]; responses: string[]; google: string[] } = { openai: [], responses: [], google: [] };
    let suppress = false;
    let foldDemands = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const url = req.url ?? "";
            const idx = bodies.openai.length + bodies.responses.length + bodies.google.length + 1;
            const wantFold = !suppress && Buffer.byteLength(body) > THRESHOLD && parseRefIds(body).length >= 12;
            if (wantFold) { foldDemands++; suppress = true; }
            const reply = `Reply ${idx}: acknowledged. ` + FILLER(idx % 7, 0.2);
            if (url.endsWith("/v1/chat/completions")) {
                bodies.openai.push(body);
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                const line = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
                if (wantFold) {
                    const refs = parseRefIds(body);
                    const args = JSON.stringify({ content: [{ startId: refs[2]!, endId: refs[refs.length - 6]!, topic: "audit fold", summary: SUMMARY_TEXT }] });
                    line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_cmp_${idx}`, type: "function", function: { name: "compress", arguments: args } }] } }] });
                    line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 2 } });
                } else {
                    line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply } }] });
                    line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
                }
                res.write("data: [DONE]\n\n");
                res.end();
                return;
            }
            if (/\/responses$/.test(url)) {
                // Responses-API SSE (shape mirrors the real-codex fake upstream).
                bodies.responses.push(body);
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                const rid = `resp_${idx}`;
                const msgId = `msg_${rid}`;
                const msg = { type: "message", id: msgId, role: "assistant", content: [{ type: "output_text", text: reply }] };
                const ev = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
                ev("response.created", { type: "response.created", response: { id: rid, status: "in_progress", output: [] } });
                ev("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: msgId, role: "assistant", content: [] } });
                ev("response.output_text.delta", { type: "response.output_text.delta", item_id: msgId, output_index: 0, content_index: 0, delta: reply });
                ev("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: msg });
                ev("response.completed", { type: "response.completed", response: { id: rid, status: "completed", output: [msg], usage: { input_tokens: 100, output_tokens: 5 } } });
                res.write("data: [DONE]\n\n");
                res.end();
                return;
            }
            // google :streamGenerateContent?alt=sse — Gemini SSE frames.
            bodies.google.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const frame = (parts: Array<Record<string, unknown>>, finishReason?: string): void => {
                const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
                if (finishReason) candidate.finishReason = finishReason;
                res.write(`data: ${JSON.stringify({ candidates: [candidate], modelVersion: "probe-model" })}\n\n`);
            };
            frame([{ text: reply }]);
            frame([], "STOP");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "probe-model": { context: 200_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as unknown as import("../src/config.ts").ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const openaiBase = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const responsesBase = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
    const googleBase = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/probe-model:streamGenerateContent?alt=sse`;

    type Msg = { role: string; content: string };
    const hist: Msg[] = [];
    try {
        // Phase A — openai lane establishes the anonymous session and folds.
        const openaiTurn = async (t: number): Promise<void> => {
            hist.push({ role: "user", content: `Turn ${t}: audit province ${t}. ` + FILLER(t, 6) });
            const resp = await fetch(openaiBase, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "probe-model", stream: true, messages: [...hist] }) });
            assert.equal(resp.status, 200, `openai turn ${t}`);
            await resp.text();
            hist.push({ role: "assistant", content: `Reply about province ${t}: acknowledged. ` + FILLER(t, 0.2) });
        };
        for (let t = 1; t <= 12; t++) await openaiTurn(t);
        const pfas = prefixAffinity.trackedSessionIds().filter((id) => id.startsWith("pfa-"));
        assert.equal(pfas.length, 1, "one anonymous session on the openai lane");
        const sessionId = pfas[0]!;
        const blocksAfterFold = getSession(sessionId)!.state.blocks.map((b) => b.blockId);
        assert.ok(blocksAfterFold.length >= 1, "the fold landed on the openai lane");
        const foldsBeforeSwitch = foldDemands;

        // Phase B — switch onto the RESPONSES wire (codex / dsh openai-responses
        // render): same history re-rendered as input[] items.
        hist.push({ role: "user", content: "Turn 13: which provinces did the audit cover, and were there anomalies?" });
        const respItems = hist.map((m) => ({
            type: "message",
            role: m.role,
            content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
        }));
        const respB = await fetch(responsesBase, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "probe-model", stream: true, instructions: "crosswire probe", input: respItems }) });
        const respRaw = await respB.text();
        if (respB.status !== 200) assert.fail(`responses switch turn: ${respB.status}: ${respRaw.slice(0, 200)}`);
        hist.push({ role: "assistant", content: "Responses reply about turn 13: acknowledged." });

        const responsesBody = bodies.responses[bodies.responses.length - 1]!;
        let pfasB = prefixAffinity.trackedSessionIds().filter((id) => id.startsWith("pfa-"));
        assert.equal(pfasB.length, 1, `the responses switch must not fork: got ${pfasB.join(", ")}`);
        assert.equal(pfasB[0], sessionId);
        assert.ok(responsesBody.includes(SUMMARY_TEXT), "the fold carrier is attached on the responses wire");
        assert.equal((responsesBody.match(new RegExp(EARLY_FILLER_TAG, "g")) ?? []).length, 0, "covered early content must not replay unfolded on the responses switch");
        assert.equal(foldDemands, foldsBeforeSwitch, "no re-fold demanded on the responses switch");
        assert.deepEqual(getSession(sessionId)!.state.blocks.map((b) => b.blockId), blocksAfterFold, "fold blocks unchanged across the responses switch");

        // Phase C — switch AGAIN onto the GOOGLE wire (Gemini render): same
        // history re-rendered as contents[].parts[].
        hist.push({ role: "user", content: "Turn 14: continue with province seven." });
        const contents = hist.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
        const respG = await fetch(googleBase, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "probe-model", contents }) });
        const googleRaw = await respG.text();
        if (respG.status !== 200) assert.fail(`google switch turn: ${respG.status}: ${googleRaw.slice(0, 200)}`);

        const googleBody = bodies.google[bodies.google.length - 1]!;
        pfasB = prefixAffinity.trackedSessionIds().filter((id) => id.startsWith("pfa-"));
        assert.equal(pfasB.length, 1, `the google switch must not fork: got ${pfasB.join(", ")}`);
        assert.equal(pfasB[0], sessionId);
        assert.ok(googleBody.includes(SUMMARY_TEXT), "the fold carrier is attached on the google wire");
        assert.equal((googleBody.match(new RegExp(EARLY_FILLER_TAG, "g")) ?? []).length, 0, "covered early content must not replay unfolded on the google switch");
        assert.equal(foldDemands, foldsBeforeSwitch, "no re-fold demanded on the google switch");
        assert.deepEqual(getSession(sessionId)!.state.blocks.map((b) => b.blockId), blocksAfterFold, "fold blocks unchanged across the google switch");
    } finally {
        proxy.close();
        upstream.close();
    }
});

test.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
