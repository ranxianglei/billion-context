// Regression guard for #2817 — a dsh IDENTIFIED persona (x-bili-plugin headers)
// accumulates PLUGIN-MODE fold blocks on the openai lane (commandcode-style
// /v1/chat/completions), then the user switches models CROSS-WIRE to the anthropic
// lane (kimi-style /v1/messages).
//
// Pre-fix (v0.1.188, the incident this was written from): the persona migrate
// criterion is wire-sensitive → the anthropic render fails chainContinues → the turn
// forks onto `<conv>|sub:<fp>` with ZERO inherited fold blocks → the full raw replay
// (794,612 tokens in the incident) goes upstream unfolded.
//
// Post-fix (v0.1.193, wire-neutral affinity hashing from #2791/#2807): the neutralTurns()
// projection makes the anthropic render of the same conversation hash-equal at the noted
// depth → migrate on the raw key, the client echoed compress pair rides the anthropic
// outbound as the fold carrier, covered content stays folded.
//
// Coverage note: affinity-crosswire-fold.test.ts guards the ANONYMOUS pfa-* path; this
// file is the identified-persona + plugin-mode-fold + cross-wire combination.
//
// Dual-version contract: on tag v0.1.188 this FAILS at the switch turn (assertion 1,
// `12 !== 13`); on v0.1.193+ it passes. Run recipe for both tags is in the PR body.
//
// Hermetic: one mock upstream serves both lanes (openai SSE + anthropic SSE); the fold
// is a CLIENT-side plugin compress (tool API + echoed pair), exactly like the real dsh
// web client; no real AI is ever called.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-2817-incident-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { getSession, peekSession } = await import("../src/session.ts");
const { defaultConfig } = await import("acp-kernel");

const SUMMARY_TEXT = "Fold summary: the pve-redesign audit covered chapters one through three, ledger entries stable, no anomalies recorded anywhere in the cluster.";
const EARLY_FILLER_TAG = "Chapter 3-";
const FOLD_TOPIC = "pve redesign fold";
const TOOL_CALL_ID = "call_plug_1";
const FILLER = (seed: number, kb: number): string => {
    const para = `Chapter ${seed}: pve redesign audit of the grain transport network continued without incident across all provinces. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

// The incident's system shapes: openai lane stamped a one-line system;
// the anthropic rebuild carried a multi-block system. System text is NOT part
// of the neutral turn chain, but the persona anchor fingerprint changes — the
// migrate path must tolerate that (it did not pre-fix).
const SYSTEM_OPENAI = "You are DeepSeek Harness, the main coding agent. Model: gpt-5.6-sol.";
const SYSTEM_ANTHROPIC = [
    { type: "text", text: "You are DeepSeek Harness, the main coding agent." },
    { type: "text", text: "Model: k3-256k." },
    { type: "text", text: "Workspace: /workspace/pve-redesign." },
    { type: "text", text: "Wire: anthropic." },
];

type Pair = { kind: "pair"; callId: string; args: { content: { startId: string; endId: string; topic: string; summary: string }[] }; result: string };

test("issue #2817 regression: identified persona, PLUGIN-MODE fold on openai lane, cross-wire switch to anthropic keeps the raw key AND the fold", { timeout: 180_000 }, async () => {
    const bodies: { openai: string[]; anthropic: string[] } = { openai: [], anthropic: [] };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const url = req.url ?? "";
            const idx = bodies.openai.length + bodies.anthropic.length + 1;
            const reply = `Reply ${idx}: acknowledged. ` + FILLER(idx % 7, 0.2);
            if (url.endsWith("/v1/chat/completions")) {
                bodies.openai.push(body);
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                const line = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
                line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply } }] });
                line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
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
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as unknown as import("../src/config.ts").ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const openaiBase = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const anthropicBase = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

    // dsh identified-persona headers — the lane identity the dsh web client stamps.
    const CONV = "session-2817-incident-repro";
    const dshHeaders = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };

    // Logical conversation (wire-neutral) as ONE ordered list — the pair keeps its
    // historical position exactly like the real dsh client keeps the echoed
    // compress tool_call + tool_result in the transcript where it happened.
    type Turn = { role: "user" | "assistant"; text: string };
    type HistItem = Turn | { pair: "call" } | { pair: "result" };
    const hist: HistItem[] = [];
    let pluginPair: { args: { content: { startId: string; endId: string; topic: string; summary: string }[] }; result: string } | null = null;

    const renderOpenai = (): unknown[] => {
        const out: unknown[] = [{ role: "system", content: SYSTEM_OPENAI }];
        for (const t of hist) {
            if ("pair" in t) {
                if (t.pair === "call") out.push({ role: "assistant", content: null, tool_calls: [{ id: TOOL_CALL_ID, type: "function", function: { name: "compress", arguments: JSON.stringify(pluginPair!.args) } }] });
                else out.push({ role: "tool", tool_call_id: TOOL_CALL_ID, content: pluginPair!.result });
            } else out.push({ role: t.role, content: t.text });
        }
        return out;
    };
    const renderAnthropic = (): unknown[] => {
        const out: unknown[] = [];
        for (const t of hist) {
            if ("pair" in t) {
                if (t.pair === "call") out.push({ role: "assistant", content: [{ type: "tool_use", id: TOOL_CALL_ID, name: "compress", input: pluginPair!.args }] });
                else out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: TOOL_CALL_ID, content: pluginPair!.result }] });
            } else out.push({ role: t.role, content: [{ type: "text", text: t.text }] });
        }
        return out;
    };

    try {
        // Phase A — openai lane (commandcode-style). 8 turns ≈ 50KB of history.
        for (let t = 1; t <= 8; t++) {
            hist.push({ role: "user", text: `Turn ${t}: audit chapter ${t}. ` + FILLER(t, 6) });
            const resp = await fetch(openaiBase, { method: "POST", headers: dshHeaders, body: JSON.stringify({ model: "probe-model", stream: true, messages: renderOpenai() }) });
            assert.equal(resp.status, 200, `openai turn ${t}`);
            await resp.text();
            hist.push({ role: "assistant", text: `Reply about chapter ${t}: acknowledged. ` + FILLER(t, 0.2) });
        }
        assert.ok(getSession(CONV), "main persona session exists under the raw conversation key");

        // The client executes the compress tool via the plugin tool API — the same
        // endpoint the real dsh host calls when the user invokes `compress`.
        // Refs: m00001..m00015 are the 15 messages the session has rendered by now
        // (8 user + 7 assistant replies; the openai outbound's own <acp-message-id>
        // markers are documentation EXAMPLES and must not be parsed for refs).
        // Fold chapters 1-3 (user m00001 through assistant m00006, ~19KB head).
        const foldArgs = { content: [{ startId: "m00001", endId: "m00006", topic: FOLD_TOPIC, summary: SUMMARY_TEXT }] };
        const toolResp = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: CONV, tool: "compress", args: foldArgs }),
        });
        assert.equal(toolResp.status, 200);
        const toolJson = (await toolResp.json()) as { ok: boolean; result: string };
        assert.equal(toolJson.ok, true, `compress tool API failed: ${toolJson.result}`);
        assert.ok(!/FAILED/i.test(toolJson.result), `compress tool reported failure: ${toolJson.result}`);

        // Turn 9 echoes the pair at its historical position (right after u9) — the
        // client keeps the tool_call + tool_result in the transcript where the
        // compress ran, and all later turns append AFTER the pair.
        hist.push({ role: "user", text: "Turn 9: continue the audit. " + FILLER(9, 6) });
        pluginPair = { args: foldArgs, result: toolJson.result };
        hist.push({ pair: "call" }, { pair: "result" });
        const r9 = await fetch(openaiBase, { method: "POST", headers: dshHeaders, body: JSON.stringify({ model: "probe-model", stream: true, messages: renderOpenai() }) });
        await r9.text();
        hist.push({ role: "assistant", text: `Reply about chapter 9: acknowledged. ` + FILLER(9, 0.2) });

        const main = getSession(CONV);
        const blocksAfterFold = main.state.blocks.map((b) => b.blockId);
        assert.ok(blocksAfterFold.length >= 1, "plugin-mode fold landed on the openai lane");
        const foldedBody = bodies.openai[bodies.openai.length - 1]!;
        assert.ok(!foldedBody.includes(EARLY_FILLER_TAG), "covered head content folded away on the openai lane");
        assert.equal(main.stats.requests, 9);

        // Turns 10-12: openai lane stays folded.
        for (let t = 10; t <= 12; t++) {
            hist.push({ role: "user", text: `Turn ${t}: audit chapter ${t}. ` + FILLER(t, 6) });
            const resp = await fetch(openaiBase, { method: "POST", headers: dshHeaders, body: JSON.stringify({ model: "probe-model", stream: true, messages: renderOpenai() }) });
            await resp.text();
            hist.push({ role: "assistant", text: `Reply about chapter ${t}: acknowledged. ` + FILLER(t, 0.2) });
        }
        assert.equal(getSession(CONV).stats.requests, 12, "12 openai turns all rode the raw key");
        assert.deepEqual(getSession(CONV).state.blocks.map((b) => b.blockId), blocksAfterFold, "fold blocks stable on the openai lane");

        // Phase B — THE INCIDENT: cross-wire model switch. The whole conversation
        // (turns + the echoed compress pair in place) is replayed on the anthropic
        // lane with one new turn and the anthropic system shape. Pre-fix this
        // forked onto `<conv>|sub:<fp>` with zero folds (incident: 1583 msgs /
        // 794,612 tokens upstream). Post-fix the wire-neutral chain continues and
        // the turn migrates the anchor on the raw key.
        hist.push({ role: "user", text: "Turn 13: which chapters did the audit cover, and were there anomalies?" });
        const anthropicsBeforeSwitch = bodies.anthropic.length;
        const anthMessages = renderAnthropic();
        const rawSwitchPayload = JSON.stringify({ model: "probe-model", max_tokens: 1024, stream: true, system: SYSTEM_ANTHROPIC, messages: anthMessages });
        const rawSwitchBytes = Buffer.byteLength(rawSwitchPayload);
        const resp = await fetch(anthropicBase, { method: "POST", headers: { ...dshHeaders, "anthropic-version": "2023-06-01" }, body: rawSwitchPayload });
        const raw = await resp.text();
        if (resp.status !== 200) assert.fail(`anthropic switch turn: ${resp.status}: ${raw.slice(0, 200)}`);
        hist.push({ role: "assistant", text: "Anthropic reply about turn 13: acknowledged. " + FILLER(13, 0.2) });

        const switchBody = bodies.anthropic[anthropicsBeforeSwitch]!;
        const switchBytes = Buffer.byteLength(switchBody);

        // 1) THE incident assertion: the switch turn rides the RAW persona key.
        //    Pre-fix it forked — stats.requests stays at 12 and a `|sub:` husk serves.
        assert.equal(getSession(CONV).stats.requests, 13, `switch turn must keep riding the RAW persona key (fork would leave it at 12: incident #2817)`);
        // 2) Fold attachment on the switched wire: covered early content ABSENT.
        assert.equal((switchBody.match(new RegExp(EARLY_FILLER_TAG, "g")) ?? []).length, 0, "covered early content must NOT replay raw on the switch turn (incident blast)");
        // 3) The upstream blast metric: the covered volume must actually stay
        //    upstream-hidden. bili's fold keeps the startId piece visible as the
        //    head anchor and hides (startId..endId] (measured: a1..a3 = m00002..
        //    m00006 hidden ≈ 13.7KB, u4 merges into the u1 piece). Compare the
        //    MESSAGE ARRAY only — the proxy injects its own ~12KB system prompt
        //    into the outbound body, which the raw replay (client-side system)
        //    does not carry. The incident's blast was the FULL 794K replay
        //    (0% hidden).
        const bytesOf = (payload: string): number => {
            const parsedBody = JSON.parse(payload) as { messages: unknown[] };
            return Buffer.byteLength(JSON.stringify(parsedBody.messages));
        };
        const switchMsgBytes = bytesOf(switchBody);
        const rawMsgBytes = bytesOf(rawSwitchPayload);
        assert.ok(switchMsgBytes <= rawMsgBytes - 10_000, `upstream messages must stay folded: ${switchMsgBytes}B vs raw replay ${rawMsgBytes}B (incident: full 794K blast)`);
        // 4) No round-2 on the switch turn; fold blocks untouched.
        assert.equal(bodies.anthropic.length - anthropicsBeforeSwitch, 1, "no round-2 on the switch turn");
        assert.deepEqual(getSession(CONV).state.blocks.map((b) => b.blockId), blocksAfterFold, "fold blocks unchanged across the wire switch");

        // Phase C — follow-up anthropic turn stays on the same session, still folded.
        hist.push({ role: "user", text: "Turn 14: continue with chapter ten." });
        const r14 = await fetch(anthropicBase, { method: "POST", headers: { ...dshHeaders, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "probe-model", max_tokens: 1024, stream: true, system: SYSTEM_ANTHROPIC, messages: renderAnthropic() }) });
        const r14Text = await r14.text();
        if (r14.status !== 200) assert.fail(`anthropic turn 14: ${r14.status}: ${r14Text.slice(0, 200)}`);
        const followUp = bodies.anthropic[bodies.anthropic.length - 1]!;
        assert.equal(getSession(CONV).stats.requests, 14, "follow-up turn still rides the raw key");
        assert.equal((followUp.match(new RegExp(EARLY_FILLER_TAG, "g")) ?? []).length, 0, "covered content stays folded on the follow-up turn");
    } finally {
        proxy.close();
        upstream.close();
    }
});

test.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
