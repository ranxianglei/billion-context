// #4921: dsh's instruction-file REVISION notices were invisible to the
// dsh-lane durable guard. @deepseek-ai/dsh-agent-instructions re-emits its
// workspace-instructions baseline (#2447) only when baselineIdentity —
// projectRoot + discovery/budget config, NOT file contents — changes;
// content edits arrive instead as separate per-file notices:
// "Updated instructions from: <path>" (file edited), "Additional
// instructions from: <path>" (file discovered after the baseline),
// "Instructions removed: <path>" (file deleted/disabled). The guard matched
// ONLY the uppercase baseline label "Instructions from:", so every revision
// notice was ordinary foldable history while the STALE baseline stayed
// BLOCKED — after one fold the model kept executing changed/removed rules
// and the correction died with the block (field evidence in the report:
// 11 real update carriers, 9 folded). Fix: a dedicated revision classifier
// projects each notice to its OWN per-path identity
// (`durable/agents-md-update/<path>`) so the default latest-per-path policy
// (`durable/*`) keeps the baseline PLUS the newest notice of every changed
// file live — sharing the baseline's single identity would demote the
// baseline itself to foldable in multi-file sessions. This test pins: the
// three evidenced shapes project per-path, the lane chain orders revisions
// BEFORE the shared baseline (an update body can quote the baseline label),
// the baseline classifier is byte-identical to pre-fix behavior, and a real
// fold through /__bili/plugin/tool keeps baseline + newest-per-path alive
// while the superseded older notice folds (per-path latest, not
// all-instance) — with the unregistered-lane negative (allowlist discipline,
// KDD #9).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { dshWorkspaceInstructionsPath, dshWorkspaceInstructionsRevisionPath, durableMessageToolPaths } from "../src/durable-message-guards.ts";
import { resetSessionOrderForTest } from "../src/session-resolve.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "gpt-test";
const MAIN_SYSTEM = "You are DeepSeek Harness, the main coding agent.";
const RULE_MARKER = "$HOME/.agents/rules/web-access-rules/web-access-rules.md";
const RULE_V2 = "always run lint AND typecheck before committing";
const RULE_V3 = "always run lint AND typecheck AND unit tests before committing";
const ADD_RULE = "sub module: always build the wasm target";
const BASELINE_MSG = `\x3csystem-reminder\x3e\nThe following workspace instructions may be relevant to your work.\n\nInstructions from: ~/.dsh/AGENTS.md\n\n## \u89c4\u5219\n$HOME/.agents/rules/\n\u251c\u2500\u2500 web-access-rules/\n\u2502   \u251c\u2500\u2500 ${RULE_MARKER}   # \u4efb\u4f55 web search/fetch \u524d\u5fc5\u8bfb\n\nInstructions from: AGENTS.md\n\n# project rules\nalways run lint before committing\n\x3c/system-reminder\x3e`;
const UPDATE_MSG = `\x3csystem-reminder\x3e\nUpdated instructions from: AGENTS.md\n\n# project rules v2\n${RULE_V2}\n\x3c/system-reminder\x3e`;
const UPDATE2_MSG = `\x3csystem-reminder\x3e\nUpdated instructions from: AGENTS.md\n\n# project rules v3\n${RULE_V3}\n\x3c/system-reminder\x3e`;
const ADD_MSG = `\x3csystem-reminder\x3e\nAdditional instructions from: sub/AGENTS.md\n\n${ADD_RULE}\n\x3c/system-reminder\x3e`;
const REMOVE_MSG = `\x3csystem-reminder\x3e\nInstructions removed: sub/AGENTS.md\n\x3c/system-reminder\x3e`;
// An update body that QUOTES the baseline label literally (real traffic,
// seq=2346 in the #4921 report): must land in the per-path group, never the
// shared baseline identity.
const QUOTED_UPDATE_MSG = `\x3csystem-reminder\x3e\nUpdated instructions from: AGENTS.md\n\nkeep the "Instructions from: ~/.dsh/AGENTS.md" section intact\n\x3c/system-reminder\x3e`;

function filler(tag: string): string {
    return `${tag}-` + "z".repeat(900);
}

test("dshWorkspaceInstructionsRevisionPath: the three evidenced shapes project to per-path identities", () => {
    const msg = (contentType: string, text: unknown, role?: string) => ({ id: "id-1", createdAt: 0, contentType, text, ...(role ? { role } : {}) }) as never;
    assert.equal(dshWorkspaceInstructionsRevisionPath(msg("text", UPDATE_MSG)), "durable/agents-md-update/AGENTS.md");
    assert.equal(dshWorkspaceInstructionsRevisionPath(msg("text", UPDATE2_MSG)), "durable/agents-md-update/AGENTS.md", "same path, same identity (latest-per-path grouping key)");
    assert.equal(dshWorkspaceInstructionsRevisionPath(msg("text", ADD_MSG)), "durable/agents-md-update/sub/AGENTS.md", "distinct path → distinct identity");
    assert.equal(dshWorkspaceInstructionsRevisionPath(msg("text", REMOVE_MSG)), "durable/agents-md-update/sub/AGENTS.md", "the removed notice rides the same per-path group (newest event wins)");
    // Negatives: mid-line mentions, wrong case, other content types, prose.
    assert.equal(dshWorkspaceInstructionsRevisionPath(msg("text", "please re-read \"Updated instructions from: AGENTS.md\" in your notes")), undefined, "mid-line mention is not a carrier line");
    assert.equal(dshWorkspaceInstructionsRevisionPath(msg("text", "\x3csystem-reminder\x3e\nupdated instructions from: AGENTS.md\n\x3c/system-reminder\x3e")), undefined, "markers match their exact evidenced casing (no widening)");
    assert.equal(dshWorkspaceInstructionsRevisionPath(msg("text", UPDATE_MSG, "assistant")), undefined, "#2766: assistant-role echoes are never carriers");
    assert.equal(dshWorkspaceInstructionsRevisionPath(msg("tool-call", UPDATE_MSG)), undefined, "non-text content types never match");
    assert.equal(dshWorkspaceInstructionsRevisionPath(msg("text", undefined)), undefined, "missing text is safe");
    assert.equal(dshWorkspaceInstructionsRevisionPath(msg("text", "plain prose about workspace setup")), undefined);
});

test("lane chain: revisions order BEFORE the shared baseline; the baseline classifier is untouched", () => {
    const msg = (contentType: string, text: unknown) => ({ id: "id-1", createdAt: 0, contentType, text }) as never;
    const dshClassifier = durableMessageToolPaths["dsh"];
    assert.ok(dshClassifier, "dsh lane is registered");
    // Precedence: a revision body quoting the literal baseline label must
    // resolve to the per-path identity, not durable/agents-md.
    assert.equal(dshClassifier!(msg("text", QUOTED_UPDATE_MSG)), "durable/agents-md-update/AGENTS.md", "revision outranks the baseline it quotes");
    assert.equal(dshClassifier!(msg("text", UPDATE_MSG)), "durable/agents-md-update/AGENTS.md");
    assert.equal(dshClassifier!(msg("text", BASELINE_MSG)), "durable/agents-md", "baseline still resolves to the shared identity");
    // The baseline classifier itself is byte-identical to pre-fix behavior:
    // it does NOT match the lowercase revision variants (they are the
    // revision classifier's domain, #4921).
    assert.equal(dshWorkspaceInstructionsPath(msg("text", UPDATE_MSG)), undefined);
    assert.equal(dshWorkspaceInstructionsPath(msg("text", BASELINE_MSG)), "durable/agents-md");
    assert.deepEqual(Object.keys(durableMessageToolPaths), ["dsh"], "allowlist stays dsh-only (KDD #9 evidence-permitlist discipline)");
});

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
 *  carries literal ACP-tag EXAMPLES that a whole-body scan would mistake
 *  for live refs. */
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

/** Grow a dsh-lane conversation whose fold range POSITIONALLY covers the
 *  given mid-history carriers, execute a real compress through
 *  /__bili/plugin/tool, and return the next turn's upstream body. */
async function runFoldScenario(agent: string, conv: string, carriers: string[]): Promise<string> {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": agent, "x-bili-plugin-conversation": conv };
        const post = (messages: Array<{ role: string; content: string }>) =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...messages] }) });

        const msgs: Array<{ role: string; content: string }> = [];
        msgs.push({ role: "user", content: filler("F1") });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A1") });
        let n = 2;
        for (const carrier of [BASELINE_MSG, ...carriers]) {
            msgs.push({ role: "user", content: carrier });
            await (await post(msgs)).text();
            msgs.push({ role: "assistant", content: filler(`A${n++}`) });
        }
        for (let i = 5; i <= 8; i++) {
            msgs.push({ role: "user", content: filler(`F${i}`) });
            await (await post(msgs)).text();
            msgs.push({ role: "assistant", content: filler(`A${i}`) });
        }

        const refIds = parseRefIds(rig.bodies.at(-1)!);
        // Protected carriers render as BLOCKED (no m-ref on the wire), so the
        // count is lower than the raw message count — same convention as
        // #2447's >= 10 floor.
        assert.ok(refIds.length >= 10, `expected >= 10 tagged messages, got ${refIds.length}`);
        // Fold from the FIRST tagged message up to four back from the tail
        // (clears preserveRecentMessages: 3): the range covers every carrier
        // positionally — the old code folds the revision notices away.
        const startId = refIds[0]!;
        const endId = refIds[refIds.length - 4]!;
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: {
                    topic: "issue4921 fold",
                    content: [{ startId, endId, topic: "issue4921 fold", summary: "issue4921 fold summary: filler turns F1..F8 were discussed and consumed; nothing else survived this range." }],
                },
            }),
        });
        const toolJson = (await toolRes.json()) as Record<string, unknown>;
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `compress must succeed: HTTP ${toolRes.status} ${JSON.stringify(toolJson)}`);

        msgs.push({ role: "user", content: filler("F9") });
        await (await post(msgs)).text();
        return rig.bodies.at(-1)!;
    } finally {
        await closeRig(rig);
    }
}

test("dsh lane (#4921): baseline AND the revision notice survive a fold that positionally covers both", async () => {
    const postFoldBody = await runFoldScenario("dsh", "i4921-revision", [UPDATE_MSG]);
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened (protection may not veto the whole range)");
    assert.ok(postFoldBody.includes(RULE_MARKER), "the stale-but-still-pinned baseline must survive (its own protection is unchanged)");
    assert.ok(postFoldBody.includes(RULE_V2), "THE BUG: the revision notice carries the current rule text and must survive the fold (old code folded it, leaving the stale baseline authoritative)");
    // A1 (not F1): the kernel pins the session's FIRST user message on the
    // wire even when a block covers it, so F1 cannot witness consumption.
    assert.ok(!postFoldBody.includes("A1-"), "folded filler before the baseline must be gone (the fold really consumed its range)");
    assert.ok(!postFoldBody.includes("F5-"), "folded filler after the carriers must be gone");
});

test("dsh lane (#4921): per-PATH latest — the superseded older notice folds, the newest stays pinned", async () => {
    const postFoldBody = await runFoldScenario("dsh", "i4921-perpath", [UPDATE_MSG, UPDATE2_MSG]);
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(postFoldBody.includes(RULE_MARKER), "the baseline keeps its own identity and survives");
    assert.ok(postFoldBody.includes(RULE_V3), "the NEWEST notice for the path is the live source of truth and stays pinned");
    assert.ok(!postFoldBody.includes(RULE_V2), "the SUPERSEDED older notice is ordinary foldable history under latest-per-path (all-instance pinning would keep it — and grow unboundedly)");
    assert.ok(!postFoldBody.includes("A1-"), "folded filler must be gone");
});

test("unregistered lane: without the guard the revision notice folds away (pins lane scoping)", async () => {
    const postFoldBody = await runFoldScenario("test-agent", "i4921-plain", [UPDATE_MSG]);
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(!postFoldBody.includes(RULE_V2), "an unregistered lane has no durable-state guard — the revision notice is ordinary history and folds away (KDD #9: never enable wholesale)");
});
