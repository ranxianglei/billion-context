import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig, createInitialState } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { CLAUDE_NOTIFICATION_SYSTEM_PREFIX, isClaudeNotificationRequest, isSideRequest, resolveSideLane } from "../src/server/side-request.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";

// #4840: Claude Desktop's Code-tab notification classifier fires a side call under
// the MAIN conversation id — a fixed system sentence + exactly one freshly-built
// user blob (four ordered status labels), NO tools, max_tokens=3072. Pre-fix the
// <=200 budget gate in isSideRequest missed it and no dedicated shape existed, so
// it rode the FULL pipeline as a main turn: its usage sample replaced the main
// baseline, its model (Haiku) became the session's last model, and its single
// message clobbered the persisted snapshot + ledger; restoreOutputBudget also
// seeded outputBudgetHighWater from its 3072 budget. Post-fix the structural shape
// rides the #388 side passthrough (kernel state, stats, snapshot, high-water all
// untouched) and skips restoreOutputBudget.

const MAIN_MODEL = "claude-sonnet-4-5";
const NOTIF_MODEL = "claude-haiku-5-5";
const SESSION = "notif-side-sess";
// The main turn's real usage is high; the notification's much smaller sample must
// not replace it as the session baseline.
const MAIN_INPUT_TOKENS = 85_000;
const NOTIF_INPUT_TOKENS = 12_149;

// The exact fixed policy sentence Claude Desktop's classifier sends (#4840 capture).
const NOTIF_SYSTEM = `${CLAUDE_NOTIFICATION_SYSTEM_PREFIX} Read the tail of what the agent just said and decide which of four states it's in, so the system knows whether to notify the user.`;

function notifBlob(tailCount = 913): string {
    return `Current state: working\nTool calls so far: 3\nUser's most recent ask: [synthetic]\nAssistant message tail (last ${tailCount} chars):\n[synthetic tail]`;
}

function notificationBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        model: NOTIF_MODEL,
        stream: true,
        max_tokens: 3072,
        system: NOTIF_SYSTEM,
        messages: [{ role: "user", content: notifBlob() }],
        ...over,
    };
}

test("isClaudeNotificationRequest: positive — the captured Claude Desktop shape", () => {
    assert.equal(isClaudeNotificationRequest(notificationBody()), true, "captured anthropic shape (string content, tail 913)");
    assert.equal(isClaudeNotificationRequest(notificationBody({ messages: [{ role: "user", content: [{ type: "text", text: notifBlob() }] }] })), true, "text-block content");
    assert.equal(isClaudeNotificationRequest(notificationBody({ messages: [{ role: "user", content: [{ type: "text", text: notifBlob() }, { type: "text", text: "" }] }] })), true, "multiple text blocks concatenate");
    assert.equal(isClaudeNotificationRequest(notificationBody({ messages: [{ role: "user", content: notifBlob(0) }] })), true, "tail length 0 still matches the \\d+ regex");
    assert.equal(isClaudeNotificationRequest(notificationBody({ messages: [{ role: "user", content: notifBlob(2000) }] })), true, "tail length 2000 (dynamic, not hardcoded)");
    // System carried as a role:system entry instead of top-level (openai-style wire).
    const sysInMsgs = notificationBody();
    delete sysInMsgs.system;
    sysInMsgs.messages = [{ role: "system", content: NOTIF_SYSTEM }, ...(sysInMsgs.messages as unknown[])];
    assert.equal(isClaudeNotificationRequest(sysInMsgs), true, "system on a role:system carrier");
});

test("isClaudeNotificationRequest: negatives — every veto keeps the request on the main pipeline", () => {
    assert.equal(isClaudeNotificationRequest(null), false, "null body");
    assert.equal(isClaudeNotificationRequest("nope"), false, "non-object body");
    assert.equal(isClaudeNotificationRequest({}), false, "empty body");
    assert.equal(isClaudeNotificationRequest(notificationBody({ tools: [{ name: "bash", description: "d", input_schema: { type: "object", properties: {} } }] })), false, "any tools surface vetoes");
    assert.equal(isClaudeNotificationRequest(notificationBody({ system: "You are a helpful assistant." })), false, "wrong system prompt vetoes");
    assert.equal(isClaudeNotificationRequest(notificationBody({ messages: [{ role: "user", content: notifBlob() }, { role: "assistant", content: "ok" }] })), false, "history-bearing (assistant turn) vetoes");
    assert.equal(isClaudeNotificationRequest(notificationBody({ messages: [{ role: "user", content: notifBlob() }, { role: "user", content: "second" }] })), false, "two user messages veto");
    assert.equal(isClaudeNotificationRequest(notificationBody({ messages: [{ role: "user", content: `Current state: working\nUser's most recent ask: x\nAssistant message tail (last 913 chars):\ny` }] })), false, "missing the 'Tool calls so far:' label vetoes");
    assert.equal(isClaudeNotificationRequest(notificationBody({ messages: [{ role: "user", content: `Assistant message tail (last 913 chars):\ny\nCurrent state: working\nTool calls so far: 3\nUser's most recent ask: x` }] })), false, "out-of-order labels veto (tail first)");
    assert.equal(isClaudeNotificationRequest(notificationBody({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }, { type: "text", text: notifBlob() }] }] })), false, "a non-text block vetoes");
    assert.equal(isClaudeNotificationRequest(notificationBody({ messages: [{ role: "user", content: "" }] })), false, "empty user content vetoes");
    // A normal Haiku turn (tools + multi-turn history) never matches.
    assert.equal(isClaudeNotificationRequest({ model: NOTIF_MODEL, max_tokens: 1024, tools: [{ name: "bash", description: "d", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "do it" }, { role: "assistant", content: "done" }] }), false, "a real Haiku agent turn does not match");
});

test("isSideRequest still misses the notification (documents the gap this fix closes)", () => {
    assert.equal(isSideRequest(notificationBody()), false, "max_tokens=3072 defeats the <=200 heuristic and no other rule claims it");
});

test("isSideRequest: explicit main intent vetoes everything (unchanged)", () => {
    assert.equal(isSideRequest(notificationBody(), "main"), false, "explicit main stays main");
    assert.equal(isSideRequest({ max_tokens: 100 }, "main"), false, "explicit main beats even the tiny-budget heuristic");
});

test("resolveSideLane: the #4840 label names the structural shape in the log line", () => {
    assert.equal(
        resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: false, sideIntent: true, requestAgent: undefined, sideLabel: "claude notification classifier sidecar (#4840)" }).reason,
        "claude notification classifier sidecar (#4840)",
    );
    // Without a label the historical reason strings are byte-stable.
    assert.equal(
        resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: false, sideIntent: true, requestAgent: undefined }).reason,
        "max_tokens<=200",
    );
});

function mainConversation(n: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Main message ${i} ${"z".repeat(500)}` });
    }
    return msgs;
}

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

function isNotifShape(b: Record<string, unknown>): boolean {
    return typeof b.system === "string" && b.system.startsWith(CLAUDE_NOTIFICATION_SYSTEM_PREFIX);
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    lastBody: Record<string, unknown> | null;
    upstreamHits: number;
}

async function startRig(): Promise<Rig> {
    const rig: Rig = { proxyPort: 0, upstreamPort: 0, proxy: null as unknown as http.Server, upstream: null as unknown as http.Server, lastBody: null, upstreamHits: 0 };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
            rig.lastBody = parsed;
            rig.upstreamHits++;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse(isNotifShape(parsed) ? NOTIF_INPUT_TOKENS : MAIN_INPUT_TOKENS));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        proxy: "",
        proxyFallback: { explicitDirect: true, globalSource: "direct" },
        auxProxyFallback: { explicitDirect: true, globalSource: "direct" },
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
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
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    rig.proxy = proxy; rig.upstream = upstream; rig.proxyPort = proxyPort; rig.upstreamPort = upstreamPort;
    return rig;
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

test("e2e: the notification classifier rides the side passthrough — no pollution, no high-water seed (#4840)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // Main turn 1: a normal tool-less turn whose REAL usage lands at 85K — the
        // baseline the notification's 12K sample would clobber pre-fix.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MAIN_MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();
        const s1 = getSession(SESSION);
        assert.ok(s1, "session exists after the main request");
        assert.notEqual(JSON.stringify(s1.state), JSON.stringify(createInitialState()), "main request mutates kernel state");
        assert.equal(s1.stats.lastInputTokens, MAIN_INPUT_TOKENS, "main usage captured as the baseline");
        assert.equal(s1.metadata.outputBudgetHighWater, 1024, "high-water learned from the healthy main turn");
        assert.equal(s1.metadata.lastModel, MAIN_MODEL, "the main model is recorded as the session's last model");

        const stateAfterMain = JSON.stringify(s1.state);
        const statsAfterMain = JSON.stringify(s1.stats);
        const snapshotAfterMain = JSON.stringify(s1.lastMessages);
        const requestsAfterMain = s1.stats.requests;
        const nudgeRefAfterMain = s1.state.nudge.lastPerMessageNudgeTokens;

        // The notification classifier call on the SAME session key: the upstream
        // reports 12K input for it — pre-fix that replaces the 85K baseline.
        const body = notificationBody();
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r2.status, 200);
        await r2.text();

        // Verbatim forward: budget untouched (restoreOutputBudget skipped), nothing injected.
        const fwd = rig.lastBody;
        assert.ok(fwd, "upstream received the notification request");
        assert.equal(fwd!.max_tokens, 3072, "notification budget must NOT be mutated by restoreOutputBudget");
        assert.equal(fwd!.system, body.system, "system forwarded verbatim");
        assert.deepEqual(fwd!.messages, body.messages, "messages forwarded verbatim (no prompt/render tags injected)");
        const fwdTools = fwd!.tools;
        assert.ok(!Array.isArray(fwdTools) || fwdTools.length === 0, "no bili tools injected into the side passthrough");

        // Kernel state, stats, snapshot, counter and high-water all untouched.
        const s2 = getSession(SESSION);
        assert.ok(s2, "session still exists after the notification request");
        assert.equal(JSON.stringify(s2.state), stateAfterMain, "notification must NOT mutate kernel state");
        assert.equal(s2.state.nudge.lastPerMessageNudgeTokens, nudgeRefAfterMain, "nudge reference untouched by the notification usage sample");
        assert.equal(JSON.stringify(s2.stats), statsAfterMain, "notification must NOT mutate stats");
        assert.equal(s2.stats.lastInputTokens, MAIN_INPUT_TOKENS, "the notification's 12K usage must NOT replace the main 85K baseline");
        assert.equal(JSON.stringify(s2.lastMessages), snapshotAfterMain, "notification must NOT clobber the message snapshot");
        assert.equal(s2.stats.requests, requestsAfterMain, "notification must NOT increment the main request counter");
        assert.equal(s2.metadata.outputBudgetHighWater, 1024, "the notification's 3072 max_tokens must NOT seed the high-water");
        assert.equal(s2.metadata.lastModel, MAIN_MODEL, "the notification's Haiku model must NOT become the session's last model");

        // Main turn 2: the pipeline still works after the notification request.
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MAIN_MODEL, max_tokens: 1024, stream: true, messages: mainConversation(9) }) });
        assert.equal(r3.status, 200);
        await r3.text();
        const s3 = getSession(SESSION);
        assert.ok(s3.stats.requests > requestsAfterMain, "main turn 2 increments the request counter");
        assert.notEqual(JSON.stringify(s3.state), stateAfterMain, "main turn 2 advances kernel state");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: a normal Haiku agent turn (tools + history) stays a main turn — compression still injected (#4840 control)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": `${SESSION}-control` };

        const body: Record<string, unknown> = {
            model: NOTIF_MODEL,
            max_tokens: 1024,
            stream: true,
            tools: [{ name: "bash", description: "d", input_schema: { type: "object", properties: {} } }],
            messages: mainConversation(6),
        };
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        await r.text();

        const s = getSession(`${SESSION}-control`);
        assert.ok(s, "session exists after the control request");
        assert.ok(s.stats.requests >= 1, "a real Haiku agent turn must go through the pipeline, not the side passthrough");
        assert.notEqual(JSON.stringify(s.state), JSON.stringify(createInitialState()), "kernel state must advance for the control request");
        assert.ok(JSON.stringify(rig.lastBody ?? {}).length > JSON.stringify(body).length + 1000, "proxy-mode injection (tools/prompt) still happens for real main turns");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: explicit agent=main outranks the notification shape — full pipeline (#4840 main-veto)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        // Both headers are required: #1699 honors x-bili-plugin-agent ONLY from an
        // announced plugin (x-bili-plugin present), so a bare agent header alone
        // cannot flip the classification.
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": `${SESSION}-mainveto`, "x-bili-plugin": "claude", "x-bili-plugin-agent": "main" };

        const body = notificationBody();
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        await r.text();

        const s = getSession(`${SESSION}-mainveto`);
        assert.ok(s, "session exists after the main-veto request");
        assert.ok(s.stats.requests >= 1, "an explicitly-marked main request must ride the full pipeline despite matching the notification shape (the side passthrough leaves the counter at 0)");
        assert.notEqual(JSON.stringify(s.state), JSON.stringify(createInitialState()), "kernel state must advance for an explicit-main request");
    } finally {
        await closeRig(rig);
    }
});
