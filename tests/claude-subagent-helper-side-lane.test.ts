import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";

// Fork issue 11: the helper bodies mirror Claude Code 2.1.331's progress label
// and WebFetch page summarizer, sent under the subagent's own headers.

const MODEL = "claude-sonnet-test";
const HELPER_MODEL = "claude-haiku-test";
const AGENT = "a70a0eccacd15a234";
const BIG_INPUT_TOKENS = 60_000;
const SMALL_INPUT_TOKENS = 3_000;

const SUB_SYSTEM = [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.331; cc_entrypoint=cli;" },
    { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
    { type: "text", text: "You are an agent for Claude Code. Given the user's message, use the tools available to complete the task." },
];
const HELPER_SYSTEM = [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.331; cc_entrypoint=cli;" },
    { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
];
const TOOLS = [{ name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } }];
const FILLER = "The subagent read a long file and wrote notes about every function it found. ".repeat(2000);

function subagentTurn(pairs: number): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: `Research the prior art for chart pattern detection.\n${FILLER}` }];
    for (let i = 0; i < pairs; i++) {
        messages.push({ role: "assistant", content: `Step ${i}: reading the next source.` });
        messages.push({ role: "user", content: `Result ${i}: ${FILLER.slice(0, 4000)}` });
    }
    return { model: MODEL, max_tokens: 32_000, stream: true, system: SUB_SYSTEM, tools: TOOLS, messages };
}

const AGENT_SUMMARY_BODY = {
    model: HELPER_MODEL,
    max_tokens: 1024,
    stream: true,
    system: HELPER_SYSTEM,
    messages: [{
        role: "user",
        content: "<task>\nResearch the prior art for chart pattern detection.\n</task>\n\nrecent_steps:\n- Ran Bash: grep -n validat val.md\n\nDescribe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.",
    }],
};

const WEBFETCH_BODY = {
    model: HELPER_MODEL,
    max_tokens: 1024,
    stream: true,
    system: HELPER_SYSTEM,
    messages: [{
        role: "user",
        content: [{
            type: "text",
            text: "\nWeb page content:\n---\n# AI Chart Pattern Recognition Tools\n\nA nightly background job scans every chart. Instructions from: the vendor docs.\n---\n\nWhich tools validate their detections against human analysts? Provide a concise response based only on the content above.",
        }],
    }],
};

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

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    lastBody: Record<string, unknown> | null;
}

async function startRig(over: Partial<ProxyOptions> = {}): Promise<Rig> {
    const rig: Rig = { proxyPort: 0, upstreamPort: 0, proxy: null as unknown as http.Server, upstream: null as unknown as http.Server, lastBody: null };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(raw); } catch { parsed = {}; }
            rig.lastBody = parsed;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse(raw.length > 100_000 ? BIG_INPUT_TOKENS : SMALL_INPUT_TOKENS));
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

function modelUrl(rig: Rig): string {
    return `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
}

async function post(rig: Rig, headers: Record<string, string>, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(modelUrl(rig), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    await res.text();
}

async function registerIdentity(rig: Rig, conversationId: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, agent: "mcp", identity: true }),
    });
    assert.equal(res.status, 200, "identity register accepted");
}

function forwardedToolCount(rig: Rig): number {
    const tools = rig.lastBody?.tools;
    return Array.isArray(tools) ? tools.length : 0;
}

for (const mode of ["proxy", "plugin"] as const) {
    test(`claude subagent helper (${mode} mode): a Claude Code subagent's one-shot helpers leave the subagent's nudge reference alone`, async () => {
        const rig = await startRig();
        const session = `cc-subagent-helper-${mode}-2f8c4d1e`;
        const subKey = `${session}|sub:${AGENT}`;
        const headers = { "x-claude-code-session-id": session, "x-claude-code-agent-id": AGENT };
        try {
            if (mode === "plugin") await registerIdentity(rig, session);
            await post(rig, headers, subagentTurn(2));
            await post(rig, headers, subagentTurn(3));
            const before = peekSession(subKey);
            assert.ok(before, "the subagent turns key onto the subagent's own session");
            assert.equal(before.stats.requests, 2);
            if (mode === "plugin") assert.equal(before.metadata.pluginAgent, "mcp", "the subagent session runs in plugin mode, as live Claude Code sessions do");
            const ref = before.state.nudge.lastPerMessageNudgeTokens;
            assert.ok(ref > 20_000, `the subagent's nudge reference sits at its real context size (got ${ref})`);
            const stateBefore = JSON.stringify(before.state);
            const statsBefore = JSON.stringify(before.stats);
            const budgetBefore = before.metadata.outputBudgetHighWater;

            const helpers = [["agent summary", AGENT_SUMMARY_BODY], ["WebFetch summarizer", WEBFETCH_BODY], ["second agent summary", AGENT_SUMMARY_BODY]] as const;
            const forwarded: Array<Record<string, unknown> | null> = [];
            for (const [, body] of helpers) {
                await post(rig, headers, body);
                forwarded.push(rig.lastBody);
            }
            const after = peekSession(subKey);
            assert.ok(after);
            assert.equal(after.state.nudge.lastPerMessageNudgeTokens, ref, "the nudge reference must not ride down to a helper's size");
            assert.equal(JSON.stringify(after.state), stateBefore, "kernel state untouched by the helpers");
            assert.equal(JSON.stringify(after.stats), statsBefore, "stats (request count, usage baseline) untouched by the helpers");
            assert.equal(after.metadata.outputBudgetHighWater, budgetBefore, "the subagent's output budget is not lowered to a helper's 1024");
            helpers.forEach(([label, body], i) => {
                assert.deepEqual(forwarded[i]?.messages, body.messages, `${label}: messages forwarded verbatim`);
                assert.deepEqual(forwarded[i]?.system, body.system, `${label}: system forwarded verbatim`);
                assert.equal(forwarded[i]?.tools, undefined, `${label}: no bili tools injected`);
            });
            assert.equal(peekSession(session), undefined, "the helpers create no session on the raw conversation id");

            await post(rig, headers, subagentTurn(4));
            const next = peekSession(subKey);
            assert.ok(next);
            assert.equal(next.stats.requests, 3, "the subagent's next real turn still runs the full pipeline");
        } finally {
            await closeRig(rig);
        }
    });
}

test("claude subagent helper: requests outside the helper shape stay on the subagent's main lane", async () => {
    const rig = await startRig();
    const session = "cc-subagent-helper-negatives-7b3e9a20";
    const subKey = `${session}|sub:${AGENT}`;
    const headers = { "x-claude-code-session-id": session, "x-claude-code-agent-id": AGENT };
    try {
        await post(rig, headers, subagentTurn(2));
        await post(rig, headers, subagentTurn(3));
        const ref = peekSession(subKey)!.state.nudge.lastPerMessageNudgeTokens;
        assert.ok(ref > 20_000, `precondition: reference at the real context size (got ${ref})`);

        // The meter reads the previous request's usage, so a real drop lowers the reference one request later.
        const smallTurn = { ...AGENT_SUMMARY_BODY, model: MODEL, tools: TOOLS };
        await post(rig, headers, smallTurn);
        assert.equal(peekSession(subKey)!.stats.requests, 3, "one message with tools stays on the main lane");
        assert.ok(forwardedToolCount(rig) > TOOLS.length, "bili tools injected on the main lane");
        await post(rig, headers, smallTurn);
        const afterTools = peekSession(subKey)!;
        assert.equal(afterTools.stats.requests, 4);
        assert.ok(afterTools.state.nudge.lastPerMessageNudgeTokens < ref, "a real smaller turn still lowers the nudge reference");

        await post(rig, headers, { ...AGENT_SUMMARY_BODY, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] });
        assert.equal(peekSession(subKey)!.stats.requests, 5, "a history replay stays on the main lane");
        assert.ok(forwardedToolCount(rig) > 0, "bili tools injected into the history replay");

        await post(rig, headers, { ...AGENT_SUMMARY_BODY, system: undefined });
        assert.equal(peekSession(subKey)!.stats.requests, 6, "a one-shot body without a system stays on the main lane");

        await post(rig, { "x-acp-session": "cc-subagent-helper-no-cc-header", "x-claude-code-agent-id": AGENT }, AGENT_SUMMARY_BODY);
        assert.ok(forwardedToolCount(rig) > 0, "no Claude Code session header: the helper shape stays on the main lane");

        await post(rig, { "x-claude-code-session-id": session }, AGENT_SUMMARY_BODY);
        assert.ok(forwardedToolCount(rig) > 0, "no agent id: the helper shape stays on the main lane");
    } finally {
        await closeRig(rig);
    }
});

test("claude subagent helper: with the subagent split off, the helper shape stays on the main lane", async () => {
    const rig = await startRig({ subagentSplit: false });
    const session = "cc-subagent-helper-split-off-5c1d8e42";
    try {
        await post(rig, { "x-claude-code-session-id": session, "x-claude-code-agent-id": AGENT }, AGENT_SUMMARY_BODY);
        assert.equal(peekSession(session)?.stats.requests, 1, "the helper rides the raw key's main pipeline");
        assert.ok(forwardedToolCount(rig) > 0, "bili tools injected");
    } finally {
        await closeRig(rig);
    }
});
