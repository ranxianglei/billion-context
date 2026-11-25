import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest, _sessionsSizeForTest, peekSession } from "../src/session.ts";
import { buildSessionCacheReport, getCacheLedger } from "../src/cache-ledger.ts";
import { LANE_TOKEN_MARKER, mintClaudeLaneToken } from "../src/claude-lane-token.ts";

const MODEL = "claude-sonnet-test";
const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

interface UsageSpec {
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    lastBody: Record<string, unknown> | null;
    nextUsage: UsageSpec;
}

function anthropicSse(u: UsageSpec): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
                id: "m1",
                role: "assistant",
                usage: {
                    input_tokens: u.inputTokens,
                    cache_creation_input_tokens: u.cacheCreationTokens,
                    cache_read_input_tokens: u.cacheReadTokens,
                },
            },
        })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

async function startRig(over: Partial<ProxyOptions> = {}): Promise<Rig> {
    const rig: Rig = {
        proxyPort: 0,
        upstreamPort: 0,
        proxy: null as unknown as http.Server,
        upstream: null as unknown as http.Server,
        lastBody: null,
        nextUsage: { inputTokens: 100, cacheCreationTokens: 1000, cacheReadTokens: 0 },
    };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            try {
                rig.lastBody = JSON.parse(raw) as Record<string, unknown>;
            } catch {
                rig.lastBody = {};
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(anthropicSse(rig.nextUsage));
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
        ...over,
    } as ProxyOptions);
    await once(proxy, "listening");
    rig.proxy = proxy;
    rig.upstream = upstream;
    rig.proxyPort = (proxy.address() as { port: number }).port;
    rig.upstreamPort = upstreamPort;
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

async function post(rig: Rig, headers: Record<string, string>, body: Record<string, unknown>, usage: UsageSpec): Promise<void> {
    rig.nextUsage = usage;
    const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    await res.text();
}

async function registerPlugin(rig: Rig, conversationId: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, agent: "mcp", identity: true }),
    });
    assert.equal(res.status, 200);
}

type Msg = { role: string; content: unknown };

function history(prefix: string, turns: number): Msg[] {
    const out: Msg[] = [];
    for (let i = 1; i <= turns; i++) {
        out.push({ role: "user", content: `${prefix}-user-${i}` });
        out.push({ role: "assistant", content: `${prefix}-assistant-${i}` });
    }
    return out;
}

function tokenedHistory(prefix: string, turns: number, token: string): Msg[] {
    const base = history(prefix, turns);
    const first = base[0];
    return [
        { role: "user", content: [{ type: "text", text: `<system-reminder>${LANE_TOKEN_MARKER}${token}</system-reminder>` }, { type: "text", text: String(first.content) }] },
        ...base.slice(1),
    ];
}

function upstreamSystemTexts(rig: Rig): string[] {
    const sys = rig.lastBody?.system;
    if (!Array.isArray(sys)) return [];
    return sys
        .filter((b): b is { type: string; text: string } => b !== null && typeof b === "object" && typeof (b as { text?: unknown }).text === "string")
        .map((b) => b.text);
}

for (const mode of ["proxy", "plugin"] as const) {
    test(`billing header (${mode} mode): rotating billing header preserves systemFp and cache-ledger attribution while genuine prompt edits still trigger`, async () => {
        const rig = await startRig();
        const sessionId = randomUUID();
        const headers = { "x-claude-code-session-id": sessionId };
        const basePrompt = "You are Claude Code, Anthropic's official CLI for Claude.";
        const billing1 = "x-anthropic-billing-header: cc_version=2.1.331.aaa; cc_entrypoint=sdk-cli; cch=11111;";
        const billing2 = "x-anthropic-billing-header: cc_version=2.1.331.aaa; cc_entrypoint=sdk-cli; cch=22222; cc_prev_msg=msg_01AAAAAAAAAAAAAAAAAAAAAA;";
        const billing3 = "x-anthropic-billing-header: cc_version=2.1.331.aaa; cc_entrypoint=sdk-cli; cch=33333; cc_prev_msg=msg_01BBBBBBBBBBBBBBBBBBBBBB;";
        const billing4 = "x-anthropic-billing-header: cc_version=2.1.331.aaa; cc_entrypoint=sdk-cli; cch=44444; cc_prev_msg=msg_01CCCCCCCCCCCCCCCCCCCCCC;";

        try {
            if (mode === "plugin") await registerPlugin(rig, sessionId);

            await post(
                rig,
                headers,
                { model: MODEL, max_tokens: 1024, stream: true, system: [{ type: "text", text: billing1 }, { type: "text", text: basePrompt }], messages: history("main", 1) },
                { inputTokens: 100, cacheCreationTokens: 20_000, cacheReadTokens: 0 },
            );
            const assertUpstreamHead = (billing: string, prompt: string, label: string): void => {
                assert.ok(Array.isArray(rig.lastBody?.system), label);
                assert.deepEqual((rig.lastBody?.system as unknown[]).slice(0, 2), [{ type: "text", text: billing }, { type: "text", text: prompt }], label);
            };
            assertUpstreamHead(billing1, basePrompt, "turn 1 billing header forwarded byte-exact");
            const s1 = peekSession(sessionId);
            assert.ok(s1);
            assert.equal(s1.metadata.pluginAgent, mode === "plugin" ? "mcp" : undefined, `mode ${mode} active`);
            const fpTurn1 = structuredClone(s1.metadata.systemFp);

            await post(
                rig,
                headers,
                { model: MODEL, max_tokens: 1024, stream: true, system: [{ type: "text", text: billing2 }, { type: "text", text: basePrompt }], messages: history("main", 2) },
                { inputTokens: 100, cacheCreationTokens: 900, cacheReadTokens: 20_100 },
            );
            assertUpstreamHead(billing2, basePrompt, "turn 2 billing header forwarded byte-exact");
            assert.deepEqual(s1.metadata.systemFp, fpTurn1, "adding cc_prev_msg (+42 chars) must not change systemFp");

            await post(
                rig,
                headers,
                { model: MODEL, max_tokens: 1024, stream: true, system: [{ type: "text", text: billing3 }, { type: "text", text: basePrompt }], messages: history("main", 3) },
                { inputTokens: 100, cacheCreationTokens: 22_000, cacheReadTokens: 0 },
            );
            assertUpstreamHead(billing3, basePrompt, "turn 3 billing header forwarded byte-exact");
            assert.deepEqual(s1.metadata.systemFp, fpTurn1, "rotating cch and cc_prev_msg must not change systemFp");

            const reportBeforeEdit = buildSessionCacheReport(s1);
            assert.equal(reportBeforeEdit.promptSwitches.count, 0, "billing header rotation must not record promptSwitches");
            assert.equal(reportBeforeEdit.promptSwitches.missedTokens, 0, "billing header rotation must not absorb missed tokens");
            const turn3Line = reportBeforeEdit.lines[2];
            assert.ok(turn3Line);
            assert.ok(turn3Line.ttlRepay > 0, "turn 3 cache drop stays recorded as ttlRepay");
            const ledgerLine3 = getCacheLedger(s1).lines[2];
            assert.notEqual(ledgerLine3?.cause, "prompt", "turn 3 TTL miss must not be misattributed as prompt");
            assert.equal(ledgerLine3?.sf, undefined, "turn 3 must not set system-prompt-flipped flag");

            await post(
                rig,
                headers,
                { model: MODEL, max_tokens: 1024, stream: true, system: [{ type: "text", text: billing4 }, { type: "text", text: `${basePrompt} Extra rule.` }], messages: history("main", 4) },
                { inputTokens: 100, cacheCreationTokens: 23_000, cacheReadTokens: 0 },
            );
            assertUpstreamHead(billing4, `${basePrompt} Extra rule.`, "turn 4 billing header forwarded byte-exact");
            assert.notDeepEqual(s1.metadata.systemFp, fpTurn1, "genuine non-billing prompt edit still updates systemFp");

            const reportAfterEdit = buildSessionCacheReport(s1);
            assert.equal(reportAfterEdit.promptSwitches.count, 1, "genuine system prompt edit records one prompt switch");
            assert.ok(reportAfterEdit.promptSwitches.missedTokens > 0, "genuine system prompt edit attributes missed tokens");
        } finally {
            await closeRig(rig);
        }
    });
}

test("billing header: billing header prefix matching handles leading whitespace and index > 0, and rejects mid-sentence matches", async () => {
    const rig = await startRig();
    const sessionId = randomUUID();
    const headers = { "x-claude-code-session-id": sessionId };

    try {
        await post(
            rig,
            headers,
            {
                model: MODEL,
                max_tokens: 1024,
                stream: true,
                system: [
                    { type: "text", text: "   x-anthropic-billing-header: cc_version=2.1.331.aaa; cch=11111;" },
                    { type: "text", text: "You are Claude Code." },
                ],
                messages: history("p", 1),
            },
            { inputTokens: 100, cacheCreationTokens: 5000, cacheReadTokens: 0 },
        );
        const sess = peekSession(sessionId);
        assert.ok(sess);
        const fp1 = structuredClone(sess.metadata.systemFp);

        await post(
            rig,
            headers,
            {
                model: MODEL,
                max_tokens: 1024,
                stream: true,
                system: [
                    { type: "text", text: "You are Claude Code." },
                    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.331.bbb; cch=22222; cc_prev_msg=msg_01CCCC;" },
                ],
                messages: history("p", 2),
            },
            { inputTokens: 100, cacheCreationTokens: 200, cacheReadTokens: 5100 },
        );
        assert.deepEqual(sess.metadata.systemFp, fp1, "billing block at index 1 or with leading spaces still excluded from systemFp");

        await post(
            rig,
            headers,
            {
                model: MODEL,
                max_tokens: 1024,
                stream: true,
                system: [{ type: "text", text: "You are Claude Code. Note: x-anthropic-billing-header: appears here." }],
                messages: history("p", 3),
            },
            { inputTokens: 100, cacheCreationTokens: 5400, cacheReadTokens: 0 },
        );
        const fp3 = structuredClone(sess.metadata.systemFp);
        assert.notDeepEqual(fp3, fp1, "non-billing text mentioning billing header mid-sentence counts in systemFp");

        await post(
            rig,
            headers,
            {
                model: MODEL,
                max_tokens: 1024,
                stream: true,
                system: [{ type: "text", text: "You are Claude Code. Note: x-anthropic-billing-header: changed text here." }],
                messages: history("p", 4),
            },
            { inputTokens: 100, cacheCreationTokens: 5500, cacheReadTokens: 0 },
        );
        assert.notDeepEqual(sess.metadata.systemFp, fp3, "changing a block with billing prefix mid-sentence still updates systemFp");
    } finally {
        await closeRig(rig);
    }
});

for (const mode of ["proxy", "plugin"] as const) {
    test(`billing header (${mode} mode): lane-token subagents stay on one session across rotating billing headers while distinct personas still split`, async () => {
        const rig = await startRig();
        const sessionId = randomUUID();
        const ccHeaders = { "x-claude-code-session-id": sessionId };
        const sdkBlock = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";

        try {
            if (mode === "plugin") await registerPlugin(rig, sessionId);

            await post(
                rig,
                ccHeaders,
                {
                    model: MODEL,
                    max_tokens: 1024,
                    stream: true,
                    system: [
                        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.331; cch=main1;" },
                        { type: "text", text: sdkBlock },
                        { type: "text", text: "Main instructions." },
                    ],
                    messages: history("main", 3),
                },
                { inputTokens: 100, cacheCreationTokens: 10_000, cacheReadTokens: 0 },
            );
            assert.equal(_sessionsSizeForTest(), 1);
            assert.equal(peekSession(sessionId)?.metadata.pluginAgent, mode === "plugin" ? "mcp" : undefined, `mode ${mode} active on main session`);

            const tok = mintClaudeLaneToken();
            const tokPrompt = "You are a tokened subagent.";
            await post(
                rig,
                ccHeaders,
                {
                    model: MODEL,
                    max_tokens: 1024,
                    stream: true,
                    system: [
                        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.331; cch=tok1;" },
                        { type: "text", text: sdkBlock },
                        { type: "text", text: tokPrompt },
                    ],
                    messages: tokenedHistory("toksub", 2, tok),
                },
                { inputTokens: 100, cacheCreationTokens: 9_000, cacheReadTokens: 0 },
            );
            await post(
                rig,
                ccHeaders,
                {
                    model: MODEL,
                    max_tokens: 1024,
                    stream: true,
                    system: [
                        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.331; cch=tok2; cc_prev_msg=msg_01EEEEEEEEEEEEEEEEEEEEEE;" },
                        { type: "text", text: sdkBlock },
                        { type: "text", text: tokPrompt },
                    ],
                    messages: tokenedHistory("toksub", 3, tok),
                },
                { inputTokens: 100, cacheCreationTokens: 400, cacheReadTokens: 9_100 },
            );
            assert.equal(_sessionsSizeForTest(), 2, "lane-token subagent keeps one session across rotating billing headers");
            const tokKey = `${sessionId}|sub:${fp16(`${sdkBlock}\n\n${tokPrompt}`)}:t:${tok}`;
            const tokSess = peekSession(tokKey);
            assert.ok(tokSess, "lane-token subagent keys by non-billing persona text and lane token");
            assert.equal(tokSess.stats.requests, 2);
            assert.ok(tokSess.stats.lastInputTokens > 0, "lane-token subagent usage persists across turns");

            await post(
                rig,
                ccHeaders,
                {
                    model: MODEL,
                    max_tokens: 1024,
                    stream: true,
                    system: [
                        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.331; cch=tok3;" },
                        { type: "text", text: sdkBlock },
                        { type: "text", text: "You are a review specialist." },
                    ],
                    messages: tokenedHistory("toksub", 4, tok),
                },
                { inputTokens: 100, cacheCreationTokens: 8_000, cacheReadTokens: 0 },
            );
            assert.equal(_sessionsSizeForTest(), 3, "a genuinely different non-billing persona still keys onto its own session");
        } finally {
            await closeRig(rig);
        }
    });
}

test("billing header: billing-header-only system block preserves empty systemFp and stays on raw session while forwarding verbatim", async () => {
    const rig = await startRig();
    const sessionId = randomUUID();
    const headers = { "x-claude-code-session-id": sessionId };
    const billing1 = "x-anthropic-billing-header: cc_version=2.1.331.aaa; cc_entrypoint=sdk-cli; cch=only1;";
    const billing2 = "x-anthropic-billing-header: cc_version=2.1.331.aaa; cc_entrypoint=sdk-cli; cch=only2; cc_prev_msg=msg_01FFFFFFFFFFFFFFFFFFFFFF;";

    try {
        await post(
            rig,
            headers,
            { model: MODEL, max_tokens: 1024, stream: true, system: [{ type: "text", text: billing1 }], messages: history("only", 1) },
            { inputTokens: 100, cacheCreationTokens: 4_000, cacheReadTokens: 0 },
        );
        assert.equal(upstreamSystemTexts(rig)[0], billing1);
        const sess = peekSession(sessionId);
        assert.ok(sess);
        const fp1 = structuredClone(sess.metadata.systemFp);

        await post(
            rig,
            headers,
            { model: MODEL, max_tokens: 1024, stream: true, system: [{ type: "text", text: billing2 }], messages: history("only", 2) },
            { inputTokens: 100, cacheCreationTokens: 300, cacheReadTokens: 4_100 },
        );
        assert.equal(upstreamSystemTexts(rig)[0], billing2);
        assert.equal(_sessionsSizeForTest(), 1);
        assert.equal(sess.stats.requests, 2);
        assert.deepEqual(sess.metadata.systemFp, fp1);
    } finally {
        await closeRig(rig);
    }
});
