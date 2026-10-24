// #2447: dsh's workspace instructions (AGENTS.md) are DURABLE STATE carried
// as an ordinary user message — @deepseek-ai/dsh-agent-instructions merges the
// global (~/.dsh/AGENTS.md) and project instructions into ONE user-role
// \x3csystem-reminder\x3e baseline whose sections are labelled
// "Instructions from: <path>", and re-emits it only when baselineIdentity
// (projectRoot + discovery/budget config, NOT file contents) changes. The
// generic ACP fold treats every history message as consumable, so one
// compression killed hard constraints like "read X before any web access"
// permanently — same mechanism family as the #2419 skill catalog, second
// carrier missed by the #2428 whitelist. Fix: project the baseline label to
// its durable identity via the dsh-lane classifier in
// src/durable-message-guards.ts (dshWorkspaceInstructionsPath, #2736).
// This test pins BOTH ends: the dsh lane keeps the baseline across a real fold
// executed through /__bili/plugin/tool, and an unregistered lane still folds
// it away (allowlist discipline — KDD #9: never enable wholesale).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { dshWorkspaceInstructionsPath, durableMessageToolPaths } from "../src/durable-message-guards.ts";
// #2989: rig hygiene resets the LIVE session-order registry (the persona-
// anchor ladder is off the production path on every lane since #3134 —
// v2 order resolution everywhere, google included).
import { resetSessionOrderForTest } from "../src/session-resolve.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, peekSession, _resetSessionsForTest, effectiveConfig } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "gpt-test";
const MAIN_SYSTEM = "You are DeepSeek Harness, the main coding agent.";
const RULE_MARKER = "$HOME/.agents/rules/web-access-rules/web-access-rules.md";
const INSTR_MSG = `\x3csystem-reminder\x3e\nThe following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.\n\nInstructions from: ~/.dsh/AGENTS.md\n\n## \u89c4\u5219\n$HOME/.agents/rules/\n\u251c\u2500\u2500 web-access-rules/\n\u2502   \u251c\u2500\u2500 ${RULE_MARKER}   # \u4efb\u4f55 web search/fetch \u524d\u5fc5\u8bfb\n\u251c\u2500\u2500 coding-rules.md           # \u901a\u7528\u7f16\u7801\u89c4\u8303\n\nInstructions from: AGENTS.md\n\n# project rules\nalways run lint before committing\n\x3c/system-reminder\x3e`;
const CHANGE_MSG = `\x3csystem-reminder\x3e\nUpdated instructions from: AGENTS.md\n\n# project rules v2\nalways run lint AND typecheck before committing\n\x3c/system-reminder\x3e`;

function filler(tag: string): string {
    return `${tag}-` + "z".repeat(900);
}

type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server; bodies: string[] };

async function startRig(): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c: Buffer) => (b += c.toString("utf8")));
        req.on("end", () => {
            bodies.push(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetSessionOrderForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000, {
            preserveRecentMessages: 3,
            preserveRecentTokens: 0,
            compress: { minCompressRange: 500, maxSummaryLength: 20_000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxyPort: (proxy.address() as { port: number }).port, upstreamPort, proxy, upstream, bodies };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

/** Refs from NON-SYSTEM message content only: the injected system prompt
 *  carries literal ACP-tag EXAMPLES (e.g. \x3cacp …\x3em00001\x3c/acp\x3e)
 *  that a whole-body scan would mistake for live refs. */
function parseRefIds(body: string): string[] {
    let messages: Array<{ role?: string; content?: unknown }> = [];
    try {
        messages = (JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    } catch {
        return [];
    }
    const text = messages
        .filter((m) => m.role !== "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
        .join("\n");
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) ids.push(m[1]!);
    return ids;
}

test("dshWorkspaceInstructionsPath: projects the baseline label to durable/agents-md on text messages only", () => {
    const msg = (contentType: string, text: unknown) => ({ id: "id-1", createdAt: 0, contentType, text }) as never;
    assert.equal(dshWorkspaceInstructionsPath(msg("text", INSTR_MSG)), "durable/agents-md", "the merged global+project baseline projects");
    assert.equal(dshWorkspaceInstructionsPath(msg("text", "plain prose about workspace setup")), undefined);
    assert.equal(dshWorkspaceInstructionsPath(msg("text", CHANGE_MSG)), undefined, "lowercase reconciliation variants stay consumable history");
    assert.equal(dshWorkspaceInstructionsPath(msg("tool-call", "Instructions from: AGENTS.md")), undefined, "non-text content types never match");
    assert.equal(dshWorkspaceInstructionsPath(msg("text", undefined)), undefined, "missing text is safe");
    const dshClassifier = durableMessageToolPaths["dsh"];
    assert.ok(dshClassifier, "dsh lane is registered");
    assert.equal(dshClassifier!(msg("text", "\x3cavailable_skills\x3e…\x3c/available_skills\x3e")), "durable/skill-catalog", "lane entry still covers the #2419 catalog shape");
    assert.deepEqual(Object.keys(durableMessageToolPaths), ["dsh"], "allowlist stays dsh-only (KDD #9 evidence-permitlist discipline)");
});

/** Grow a dsh-lane conversation whose fold range POSITIONALLY covers the
 *  instructions baseline (it sits mid-history between two tagged fillers),
 *  execute a real compress through /__bili/plugin/tool, and return the next
 *  turn's upstream body. */
async function runFoldScenario(agent: string, conv: string): Promise<{ postFoldBody: string; toolJson: Record<string, unknown> }> {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": agent, "x-bili-plugin-conversation": conv };
        const post = (messages: Array<{ role: string; content: string }>) =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...messages] }) });

        // Turn 1: two tagged fillers BEFORE the baseline…
        const msgs: Array<{ role: string; content: string }> = [];
        msgs.push({ role: "user", content: filler("F1") });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A1") });
        // …turn 2 drops the baseline mid-history…
        msgs.push({ role: "user", content: INSTR_MSG });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A2") });
        // …and turns 3–8 grow past it.
        for (let i = 3; i <= 8; i++) {
            msgs.push({ role: "user", content: filler(`F${i}`) });
            await (await post(msgs)).text();
            msgs.push({ role: "assistant", content: filler(`A${i}`) });
        }

        const refIds = parseRefIds(rig.bodies.at(-1)!);
        assert.ok(refIds.length >= 10, `expected >= 10 tagged messages, got ${refIds.length}`);
        // Fold from the FIRST tagged message (before the baseline) up to four
        // back from the tail (clears preserveRecentMessages: 3): the range
        // covers the baseline positionally — the old code folds it away.
        const startId = refIds[0]!;
        const endId = refIds[refIds.length - 4]!;
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: {
                    topic: "issue2447 fold",
                    content: [{ startId, endId, topic: "issue2447 fold", summary: "issue2447 fold summary: filler turns F1..F8 were discussed and consumed; nothing else survived this range." }],
                },
            }),
        });
        const toolJson = (await toolRes.json()) as Record<string, unknown>;
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `compress must succeed: HTTP ${toolRes.status} ${JSON.stringify(toolJson)}`);

        // Next turn: the rebuilt wire is the assertion surface.
        msgs.push({ role: "user", content: filler("F9") });
        await (await post(msgs)).text();
        return { postFoldBody: rig.bodies.at(-1)!, toolJson };
    } finally {
        await closeRig(rig);
    }
}

test("dsh lane (#2447): the workspace-instructions baseline survives a fold that positionally covers it", async () => {
    const { postFoldBody } = await runFoldScenario("dsh", "i2447-dsh");
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened (protection may not veto the whole range)");
    assert.ok(postFoldBody.includes(RULE_MARKER), "the hard-constraint rule path must survive the fold (hard-protected, stays fully visible)");
    assert.ok(postFoldBody.includes("Instructions from: AGENTS.md"), "the project-level section must survive too (one message carries both)");
    // A1 (not F1): the kernel pins the session's FIRST user message on the
    // wire even when a block covers it (kernel/src/prune.ts rebuildMessages,
    // DESIGN.md §8.1 — strict providers reject user-less conversations), so
    // F1 would survive any fold and cannot witness consumption.
    assert.ok(!postFoldBody.includes("A1-"), "folded filler before the baseline must be gone (the fold really consumed its range)");
    assert.ok(!postFoldBody.includes("F5-"), "folded filler after the baseline must be gone");
});

test("unregistered lane: without the guard the baseline folds away (pins lane scoping)", async () => {
    const { postFoldBody } = await runFoldScenario("test-agent", "i2447-plain");
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(!postFoldBody.includes(RULE_MARKER), "an unregistered lane has no durable-state guard — the baseline is ordinary history and folds away");
});

test("session-level: the dsh lane stamps the guard onto the effective config", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "i2447-stamp" },
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: INSTR_MSG }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = peekSession("i2447-stamp");
        assert.ok(s, "dsh session exists");
        // Guard proven directly on the stamped config: effectiveConfig() re-resolves
        // the dsh lane classifier and applies withDurableProtection. (#3999: the live
        // carrier is numbered at birth, so the old BLOCKED-ref witness no longer holds.)
        const sFull = getSession("i2447-stamp");
        const eff = effectiveConfig(sFull, defaultConfig(200_000));
        assert.ok(eff.protectedLatestTools?.includes("durable/*"), "dsh lane resolves the durable/* guard onto its effective config");
        const refs = Object.values(sFull.state.messageRefs.byRaw);
        assert.ok(refs.some((r) => /^m\d+$/.test(r)), "the live workspace-instructions carrier is numbered at birth (#3999)");
    } finally {
        await closeRig(rig);
    }
});
