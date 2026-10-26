import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, type Session } from "../src/session.ts";
import {
    SELF_HEAL_WINDOW,
    biliToolsDeclaredOnWire,
    countBiliToolUses,
    declaresMcpBiliToolsOnWire,
    evaluateSelfHealRound,
    nudgeSuppressed,
    pluginLaneDegraded,
} from "../src/session-self-heal.ts";
import { warnActivePluginSessions } from "../src/plugin-install.ts";

// #2155: stuck-session self-heal.
//   D2 zombie plugin lane — the plugin was uninstalled but already-open client
//   windows keep the session plugin-bound (sticky metadata) and headerless:
//   nudges keep firing against a model that no longer has the bili tools, the
//   model loops calling a gone MCP tool. Detection = 5 consecutive nudged
//   rounds with no plugin header, no bili tools on the wire, no reduction.
//   Remedies: degrade-to-proxy (give the wire-injected tools back, primary)
//   or suppress-nudge (when injection is unavailable).
//   D1 nudge idle — same loop shape without a plugin binding: suppress the
//   nudge until a compression reduction proves it useful again.
//   D3 — a non-streaming preflight summary dying at a Cloudflare 524 burns
//   100s per retry; learn stream-once on FIRST 524/504 (#2133 lane, auto).

const noop = () => {};

function mkSession(): Session {
    return {
        id: "s1",
        metadata: {},
        state: { nextBlockId: 1 },
        lastCompress: undefined,
    } as unknown as Session;
}

function mkCoreMessages(toolNames: string[]): CoreMessage[] {
    return toolNames.map((toolName) => ({ role: "assistant", toolName }) as CoreMessage);
}

// ---- unit: state machine ----------------------------------------------------

test("unit: zombie plugin lane arms degrade-to-proxy after the window", () => {
    const s = mkSession();
    s.metadata.pluginAgent = "zcode";
    const logs: string[] = [];
    for (let i = 0; i < SELF_HEAL_WINDOW - 1; i++) {
        evaluateSelfHealRound(
            s,
            { pluginHeaderPresent: false, biliToolsDeclared: false, nudgeActive: true, biliToolUses: 0, degradeAvailable: true },
            noop,
        );
        assert.equal(pluginLaneDegraded(s), false, `round ${i + 1}: not yet`);
    }
    evaluateSelfHealRound(
        s,
        { pluginHeaderPresent: false, biliToolsDeclared: false, nudgeActive: true, biliToolUses: 0, degradeAvailable: true },
        (level: string, msg: string) => logs.push(`${level}:${msg}`),
    );
    assert.equal(pluginLaneDegraded(s), true, "armed at exactly the window");
    assert.equal(nudgeSuppressed(s), false, "degrade keeps the nudge — the tools are back");
    const sh = s.metadata.selfHeal as { detected: string; action: string };
    assert.equal(sh.detected, "plugin-lane-gone");
    assert.equal(sh.action, "degrade-to-proxy");
    assert.ok(logs.some((l) => l.includes("plugin lane gone")), "detection is logged");
});

test("unit: degrade unavailable falls back to suppress-nudge", () => {
    const s = mkSession();
    s.metadata.pluginAgent = "zcode";
    for (let i = 0; i < SELF_HEAL_WINDOW; i++) {
        evaluateSelfHealRound(
            s,
            { pluginHeaderPresent: false, biliToolsDeclared: false, nudgeActive: true, biliToolUses: 0, degradeAvailable: false },
            noop,
        );
    }
    assert.equal(pluginLaneDegraded(s), false, "no degrade when injectTool is off");
    assert.equal(nudgeSuppressed(s), true, "falls back to suppression");
    assert.equal((s.metadata.selfHeal as { action: string }).action, "suppress-nudge");
});

test("unit: healthy plugin lane (header present) never arms", () => {
    const s = mkSession();
    s.metadata.pluginAgent = "zcode";
    for (let i = 0; i < SELF_HEAL_WINDOW + 4; i++) {
        evaluateSelfHealRound(
            s,
            { pluginHeaderPresent: true, biliToolsDeclared: true, nudgeActive: true, biliToolUses: 1, degradeAvailable: true },
            noop,
        );
    }
    assert.equal(s.metadata.selfHeal, undefined);
});

test("unit: bili tool uses reset the streaks — no arm on intermittent health", () => {
    const s = mkSession();
    s.metadata.pluginAgent = "zcode";
    for (let i = 0; i < SELF_HEAL_WINDOW - 1; i++) {
        evaluateSelfHealRound(
            s,
            { pluginHeaderPresent: false, biliToolsDeclared: false, nudgeActive: true, biliToolUses: 0, degradeAvailable: true },
            noop,
        );
    }
    evaluateSelfHealRound(
        s,
        { pluginHeaderPresent: false, biliToolsDeclared: true, nudgeActive: true, biliToolUses: 2, degradeAvailable: true },
        noop,
    );
    evaluateSelfHealRound(
        s,
        { pluginHeaderPresent: false, biliToolsDeclared: false, nudgeActive: true, biliToolUses: 0, degradeAvailable: true },
        noop,
    );
    assert.equal(pluginLaneDegraded(s), false, "streak restarted after the healthy round");
});

test("unit: suppress-nudge lifts when a compression reduction resumes", () => {
    const s = mkSession();
    for (let i = 0; i < SELF_HEAL_WINDOW; i++) {
        evaluateSelfHealRound(s, { pluginHeaderPresent: false, biliToolsDeclared: true, nudgeActive: true, biliToolUses: 0, degradeAvailable: false }, noop);
    }
    assert.equal(nudgeSuppressed(s), true);
    s.state.nextBlockId = 2; // a fold happened
    const logs: string[] = [];
    evaluateSelfHealRound(s, { pluginHeaderPresent: false, biliToolsDeclared: true, nudgeActive: true, biliToolUses: 0, degradeAvailable: false }, (l: string, m: string) => logs.push(`${l}:${m}`));
    assert.equal(nudgeSuppressed(s), false, "suppression lifted by the reduction");
    assert.equal(s.metadata.selfHeal, undefined, "state cleared");
    assert.ok(logs.some((x) => x.includes("suppression lifted")), "recovery is logged");
});

test("unit: degrade-to-proxy clears when the plugin header comes back", () => {
    const s = mkSession();
    s.metadata.pluginAgent = "zcode";
    for (let i = 0; i < SELF_HEAL_WINDOW; i++) {
        evaluateSelfHealRound(s, { pluginHeaderPresent: false, biliToolsDeclared: false, nudgeActive: true, biliToolUses: 0, degradeAvailable: true }, noop);
    }
    assert.equal(pluginLaneDegraded(s), true);
    const logs: string[] = [];
    evaluateSelfHealRound(s, { pluginHeaderPresent: true, biliToolsDeclared: true, nudgeActive: true, biliToolUses: 1, degradeAvailable: true }, (l: string, m: string) => logs.push(`${l}:${m}`));
    assert.equal(pluginLaneDegraded(s), false, "plugin mode restored");
    assert.equal(s.metadata.selfHeal, undefined);
    assert.ok(logs.some((x) => x.includes("plugin lane is back")), "recovery is logged");
});

test("unit: countBiliToolUses counts mcp-prefixed and bare ACP tool names", () => {
    const msgs = mkCoreMessages(["mcp__bili__compress", "compress", "web_search", "mcp__other__thing"]);
    assert.equal(countBiliToolUses(msgs), 2);
    assert.equal(countBiliToolUses([]), 0);
});

test("unit: biliToolsDeclaredOnWire sees every protocol's tool shape", () => {
    assert.equal(biliToolsDeclaredOnWire({ tools: [{ name: "mcp__bili__compress" }] }, "anthropic"), true);
    assert.equal(biliToolsDeclaredOnWire({ tools: [{ name: "web_search" }] }, "anthropic"), false);
    assert.equal(biliToolsDeclaredOnWire({ tools: [{ type: "function", function: { name: "compress" } }] }, "openai"), true);
    assert.equal(biliToolsDeclaredOnWire({ tools: [{ type: "function", function: { name: "bash" } }] }, "openai"), false);
    assert.equal(
        biliToolsDeclaredOnWire({ tools: [{ functionDeclarations: [{ name: "mcp__bili__compress" }] }] }, "google"),
        true,
    );
    assert.equal(biliToolsDeclaredOnWire({}, "openai"), false);
});

test("unit: declaresMcpBiliToolsOnWire requires the strict MCP server prefix", () => {
    assert.equal(declaresMcpBiliToolsOnWire({ tools: [{ name: "mcp__bili__acp_status" }] }), true);
    assert.equal(declaresMcpBiliToolsOnWire({ tools: [{ function: { name: "mcp__bili__compress" } }] }), true);
    assert.equal(declaresMcpBiliToolsOnWire({ tools: [{ type: "namespace", tools: [{ name: "mcp__bili__search_context" }] }] }), true);
    assert.equal(declaresMcpBiliToolsOnWire({ tools: [{ name: "acp_status" }] }), false);
    assert.equal(declaresMcpBiliToolsOnWire({ tools: [{ function: { name: "compress" } }] }), false);
    assert.equal(declaresMcpBiliToolsOnWire({ tools: [{ name: "mcp__other__compress" }] }), false);
    assert.equal(declaresMcpBiliToolsOnWire({}), false);
});

// ---- integration: zombie degrade (openai wire) -------------------------------

function okJson(promptTokens: number): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
    });
}

function turn2Compressible(): Record<string, unknown>[] {
    const longText = "y".repeat(20_000);
    const filler: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 1; i <= 12; i++) {
        filler.push({ role: "user", content: `q${i} ` + "f".repeat(997) });
        filler.push({ role: "assistant", content: `a${i} ` + "e".repeat(997) });
    }
    return [
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
        { role: "assistant", content: longText },
        ...filler,
        { role: "user", content: "now summarize" },
    ];
}

async function startProxyUpstream(window: number, sessionId: string, respond: (raw: string, parsed: Record<string, unknown>, res: http.ServerResponse) => void) {
    const received: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: Record<string, unknown> = {};
            try {
                parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
                parsed = {};
            }
            received.push(parsed);
            respond(raw, parsed, res);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upPort}`]: { models: { m: { context: window } } } },
        modelContextLimit: window, kernelConfig: defaultConfig(window),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const pPort = (proxy.address() as { port: number }).port;
    const send = async (headers: Record<string, string>, body: Record<string, unknown>) => {
        const url = `http://127.0.0.1:${pPort}/bili/http://127.0.0.1:${upPort}/v1/chat/completions`;
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId, ...headers }, body: JSON.stringify(body) });
        await r.text();
        return r.status;
    };
    return { received, proxy, upstream, send };
}

test("integration: zombie plugin session degrades to proxy tool injection, then recovers when the header returns", async () => {
    const WINDOW = 100_000;
    const { received, proxy, upstream, send } = await startProxyUpstream(WINDOW, "zomb-d2", (_raw, _parsed, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(okJson(57_600)); // 72% of the 80k reserved window -> emergency nudge every round
    });
    try {
        const body = { model: "m", max_tokens: 20_000, messages: turn2Compressible() };
        // r1 binds the plugin lane (header present -> plugin mode, tools stay client-side).
        await send({ "x-bili-plugin": "zcode" }, body);
        // r2..r6: headerless, no tools on the wire — the zombie shape.
        for (let i = 0; i < SELF_HEAL_WINDOW; i++) {
            const status = await send({}, body);
            assert.equal(status, 200);
        }
        const bound = listSessions().find((x) => x.id === "zomb-d2");
        assert.ok(bound, "session exists");
        assert.equal(bound!.metadata.pluginAgent, "zcode", "sticky binding survives the uninstalled plugin");
        assert.ok(bound!.metadata.selfHeal, "self-heal state recorded on the session");
        assert.equal((bound!.metadata.selfHeal as { action: string }).action, "degrade-to-proxy");
        // r7: degraded — the wire injection is back.
        await send({}, body);
        const toolNames = ((received[received.length - 1]!.tools as { function?: { name?: string } }[]) ?? []).map((t) => t.function?.name);
        assert.ok(toolNames!.includes("compress"), `degraded session gets the ACP tools on the wire (got ${JSON.stringify(toolNames)})`);
        // r8: the plugin reappears (client reinstalled) — plugin mode wins again,
        // restored on the very first header-bearing request (#2155 restore hook).
        await send({ "x-bili-plugin": "zcode" }, body);
        const lastTools = received[received.length - 1]!.tools;
        assert.equal(lastTools, undefined, "header back -> plugin mode, no wire injection");
        const healed = listSessions().find((x) => x.id === "zomb-d2");
        assert.equal(healed!.metadata.selfHeal, undefined, "self-heal cleared on recovery");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("integration: nudge-idle loop (non-plugin) suppresses the nudge after the window", async () => {
    const WINDOW = 100_000;
    const sessionId = "idle-d1";
    const { received, proxy, upstream, send } = await startProxyUpstream(WINDOW, sessionId, (_raw, _parsed, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(okJson(57_600));
    });
    try {
        const body = { model: "m", max_tokens: 20_000, messages: turn2Compressible() };
        const len = () => ((received[received.length - 1]!.messages as unknown[]) ?? []).length;
        await send({}, body); // r1 baseline — usage lands only after its own response (no nudge yet, no idle credit)
        const base = len();
        await send({}, body); // r2 — first pressure round: the backoff gate opens once, nudged (idle credit 1)
        assert.equal(len(), base + 1, "the first over-limit round still carries the nudge");
        for (let i = 0; i < SELF_HEAL_WINDOW - 2; i++) await send({}, body); // r3..r5 — #3461 backoff holds: no repeat injection, but the gated pressure rounds still earn idle credit (2..4)
        assert.equal(len(), base, "#3461: no storm — the held rounds carry no nudge");
        const sh = listSessions().find((x) => x.id === sessionId)!.metadata.selfHeal;
        assert.equal(sh, undefined, "not yet armed at window-1 idle credits");
        await send({}, body); // r6 — the 5th credited pressure round arms suppression
        const armed = listSessions().find((x) => x.id === sessionId)!.metadata.selfHeal as { action: string };
        assert.equal(armed.action, "suppress-nudge");
        await send({}, body); // r7 runs suppressed
        assert.equal(len(), base, "suppression keeps the nudge gone");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

// ---- integration: D3 — 524 learns streaming summaries (#2133 lane, auto) ----

const STATED_OVERFLOW_BODY_128K = JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "prompt is too long: 130000 tokens > 128000 maximum" },
});

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. Key decisions: chose the preflight approach over lossy truncation because the payload must stay coherent. Files touched: src/a.ts:10, src/b.ts:20. Outcome: fixed and verified by tests.";

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 5000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function summarySse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "s1", role: "assistant", usage: { input_tokens: 10 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: SUMMARY_TEXT } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function bigConversation(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

test("integration: a 524 on the non-streaming summary flips the session to streaming on the first hit", async () => {
    let summary524 = 0;
    let streamingCall = 0;
    const summaryBodies: Record<string, unknown>[] = [];
    const forwarded: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try {
                parsed = JSON.parse(raw) as { stream?: boolean };
            } catch {
                parsed = {};
            }
            if (raw.includes("must be compressed because")) {
                summaryBodies.push(JSON.parse(raw) as Record<string, unknown>);
                if (parsed.stream === false) {
                    summary524 += 1;
                    res.writeHead(524, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "gateway timeout" }));
                    return;
                }
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(summarySse());
                return;
            }
            forwarded.push(raw);
            if (streamingCall === 0) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(STATED_OVERFLOW_BODY_128K);
            } else {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse());
            }
            streamingCall += 1;
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
        modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest",
        advisoryCheck: false, releaseNotesCheck: false, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() });
        const headers = { "content-type": "application/json", "x-acp-session": "d3-sess" };
        const r1 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r1.status, 200, "the turn is rescued despite the 524");
        assert.equal(r1.headers.get("content-type"), "text/event-stream");
        await r1.text();
        assert.equal(summary524, 1, "exactly one 524 — no internal non-streaming retries burned");
        assert.equal(summaryBodies.length, 2, "one non-streaming attempt, one streaming retry");
        assert.equal(summaryBodies[0]!.stream, false);
        assert.equal(summaryBodies[1]!.stream, true, "the retry goes out as SSE");
        const s = listSessions().find((x) => x.id === "d3-sess");
        assert.ok(s, "session exists");
        assert.equal(s!.metadata.preflightStreamSummary, true, "learned for the session (#2133 lane, auto)");
        const lastForward = forwarded[forwarded.length - 1]!;
        assert.ok(lastForward.includes(SUMMARY_TEXT), "the fold summary made it into the rescued body");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

// ---- unit: CLI remove warn ---------------------------------------------------

test("unit: warnActivePluginSessions reports recent live sessions and stays silent on query failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bilixdg-"));
    const prev = process.env.XDG_STATE_HOME;
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessions: [{ id: "a", clientHint: "zcode", lastSeen: new Date().toISOString() }, { id: "b", clientHint: "zcode", lastSeen: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }] }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = (upstream.address() as { port: number }).port;
    try {
        process.env.XDG_STATE_HOME = dir;
        fs.mkdirSync(path.join(dir, "billion-context"), { recursive: true });
        fs.writeFileSync(path.join(dir, "billion-context", "proxy-origin"), JSON.stringify({ origin: `http://127.0.0.1:${port}` }));
        const note = await warnActivePluginSessions("zcode");
        assert.ok(note.includes("1 active zcode session"), `names the recent session only (got: ${note})`);
        // Dead proxy: the note degrades to silence.
        fs.writeFileSync(path.join(dir, "billion-context", "proxy-origin"), JSON.stringify({ origin: "http://127.0.0.1:1" }));
        const silent = await warnActivePluginSessions("zcode");
        assert.equal(silent, "");
    } finally {
        if (prev === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prev;
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
