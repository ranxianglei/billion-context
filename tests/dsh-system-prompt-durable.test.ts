// DeepSeek Harness admits a changed system prompt IN HISTORY on routes that
// read a later `system` message as the effective prompt: SystemPromptProjection
// (deepseek-harness MIT packages/core/agent-loop/src/runtime-context.ts) appends
// a complete system message after the cached history instead of rewriting node
// 0, and the Messages serializer (packages/llm/llm-deepseek/src/serialize.ts)
// ships it as { role: "system", content: [{ type: "text", text }] } between the
// user turn and the next assistant. The newest such message IS the prompt in
// force. ACP folded it like any plain-text message, so one compress covering it
// left the session on the stale head prompt until the text changed again.
// src/durable-message-guards.ts now projects it to durable/system-prompt
// (dshSystemPromptPath): latest-per-identity, superseded copies stay foldable.
//
// Pinned at three levels: classifier rows in both directions (#3617), fold
// geometry through the real wire codecs + applyCompression, and a real fold
// through /__bili/plugin/tool on the Messages wire with the forwarded body as
// the assertion surface.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import {
    SUMMARY_HEADER,
    assignRefs,
    collectLatestProtected,
    createCore,
    createInitialState,
    defaultConfig,
    hasUnrecoverableMediaPayload,
    isMessageLatestProtected,
} from "acp-kernel";
import type { Config, CoreMessage } from "acp-kernel";
import { anthropicToCore, openaiToCore, responsesToCore } from "acp-kernel/wire";
import type { AnthropicRequestBody, AnthropicWireMessage } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { resetSessionOrderForTest } from "../src/session-resolve.ts";
import {
    dshSystemPromptPath,
    durableMessageToolPaths,
    oneShotCarrierPaths,
    withDurableProtection,
} from "../src/durable-message-guards.ts";

const PAD = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(60);
const PROMPT_V1 = "You are the harness agent. PROMPT-REV-1 answer in English.";
const PROMPT_V2 = `You are the harness agent. PROMPT-REV-2 answer in French. ${PAD}`;
const PROMPT_V3 = `You are the harness agent. PROMPT-REV-3 answer in German. ${PAD}`;
const LIVE = "current live request: run the migration now";
const SUMMARY = "A long enough summary body to satisfy the minimum summary length gate of fifty characters.";

function mk(id: string, role: CoreMessage["role"], text: string): CoreMessage {
    return { id, role, contentType: "text", text } as CoreMessage;
}

/** The exact wire shape of the llm-deepseek serializer's in-history update. */
function sys(text: string): AnthropicWireMessage {
    return { role: "system", content: [{ type: "text", text }] };
}

/** A tool-registry developer update as the same serializer ships it. */
function toolDelta(name: string): AnthropicWireMessage {
    return { role: "system", content: [{ type: "tool_addition", tool: { type: "tool_reference", name } }] } as unknown as AnthropicWireMessage;
}

function dshConfig(): Config {
    return withDurableProtection(defaultConfig(200_000, { preserveRecentMessages: 1, preserveRecentTokens: 0 }), durableMessageToolPaths.dsh!);
}

function fold(msgs: CoreMessage[], config: Config, startRef: string, endRef: string) {
    const state = createInitialState();
    state.messageRefs = assignRefs(msgs, { existing: state.messageRefs, nextIndex: 1 }).map;
    const res = createCore().applyCompression({ ranges: [{ startRef, endRef, summary: SUMMARY }], messages: msgs, state, config });
    const folded = new Set(res.state.blocks.filter((b) => b.active).flatMap((b) => b.effectiveMessageIds));
    return { res, folded };
}

describe("dshSystemPromptPath units", () => {
    test("positives: a plain-text system-role core from each wire codec", () => {
        assert.equal(dshSystemPromptPath(mk("s0", "system", PROMPT_V2)), "durable/system-prompt");

        const ant = anthropicToCore({ messages: [{ role: "user", content: "hi" }, sys(PROMPT_V2)] }).msgs;
        assert.equal(ant[1]!.role, "system");
        assert.equal(dshSystemPromptPath(ant[1]!), "durable/system-prompt", "Messages wire, text-block content (llm-deepseek shape)");
        const antStr = anthropicToCore({ messages: [{ role: "user", content: "hi" }, { role: "system", content: PROMPT_V2 }] }).msgs;
        assert.equal(dshSystemPromptPath(antStr[1]!), "durable/system-prompt", "Messages wire, string content");

        const oai = openaiToCore({ model: "m", messages: [{ role: "system", content: PROMPT_V1 }, { role: "user", content: "hi" }, { role: "system", content: PROMPT_V2 }] }).msgs;
        const oaiSys = oai.filter((m) => m.role === "system");
        assert.equal(oaiSys.length, 1, "the leading system is hoisted out of the fold space; only the in-history one is a core");
        assert.equal(dshSystemPromptPath(oaiSys[0]!), "durable/system-prompt", "chat-completions wire");

        const rsp = responsesToCore({ model: "m", input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
            { type: "message", role: "system", content: [{ type: "input_text", text: PROMPT_V2 }] },
        ] } as never).msgs;
        const rspSys = rsp.filter((m) => m.role === "system");
        assert.equal(rspSys.length, 1);
        assert.equal(dshSystemPromptPath(rspSys[0]!), "durable/system-prompt", "responses wire, typed system item");
        // llm-pi-ai ships the update as a typeless developer item on the
        // responses API (its conversation-updates wire test pins the shape).
        const rspDev = responsesToCore({ model: "m", input: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
            { role: "developer", content: PROMPT_V2 },
        ] } as never).msgs.filter((m) => m.role === "system");
        assert.equal(rspDev.length, 1);
        assert.equal(dshSystemPromptPath(rspDev[0]!), "durable/system-prompt", "responses wire, developer item with string content");
    });

    test("negatives: other roles, non-text, empty, structured systems, bili's own summary carrier", () => {
        assert.equal(dshSystemPromptPath(mk("u1", "user", PROMPT_V2)), undefined, "a user message is never the system prompt, whatever it says");
        assert.equal(dshSystemPromptPath(mk("a1", "assistant", PROMPT_V2)), undefined, "a model echo of the prompt never projects (#2766)");
        const tool = { id: "t1", role: "tool", contentType: "tool-result", text: PROMPT_V2 } as CoreMessage;
        assert.equal(dshSystemPromptPath(tool), undefined, "tool channel is not a carrier surface");
        assert.equal(dshSystemPromptPath({ id: "s1", role: "system", contentType: "reasoning", text: PROMPT_V2 } as CoreMessage), undefined, "non-text content types never match");
        assert.equal(dshSystemPromptPath({ id: "s2", role: "system", contentType: "text" } as CoreMessage), undefined, "missing text is safe");
        assert.equal(dshSystemPromptPath(mk("s3", "system", "")), undefined, "an empty system node supplies no prompt");
        assert.equal(dshSystemPromptPath(mk("s4", "system", " \n\t")), undefined, "whitespace-only likewise");
        assert.equal(dshSystemPromptPath(mk("s5", "system", `${SUMMARY_HEADER}\nearlier work, folded`)), undefined, "the kernel renders its own summary carrier role system — never a host prompt");
        assert.equal(dshSystemPromptPath(mk("s6", "system", `${SUMMARY_HEADER} — topic\nearlier work, folded`)), undefined);

        // Structured systems are control-plane state the kernel already refuses
        // to fold on its own; they must not ALSO claim the prompt identity, or a
        // tool delta arriving after the prompt would take the latest slot.
        const delta = anthropicToCore({ messages: [{ role: "user", content: "hi" }, toolDelta("search")] }).msgs[1]!;
        assert.equal(hasUnrecoverableMediaPayload(delta), true, "precondition: kernel hard rule owns this message");
        assert.equal(dshSystemPromptPath(delta), undefined, "tool_addition system (anthropic wire)");
        const mixed = anthropicToCore({ messages: [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "text", text: "tools changed" }, { type: "tool_addition", tool: { type: "tool_reference", name: "search" } }] } as unknown as AnthropicWireMessage] }).msgs[1]!;
        assert.equal(dshSystemPromptPath(mixed), undefined, "text + tool delta in one system message is still structured");
        const directive = anthropicToCore({ messages: [{ role: "user", content: "hi" }, { role: "system", content: [], output_config: { effort: "low" } }] }).msgs[1]!;
        assert.equal(dshSystemPromptPath(directive), undefined, "directive-only system");
        const oaiDelta = openaiToCore({ model: "m", messages: [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "text", text: "tools changed" }, { type: "tool_addition", name: "search" }] }] } as never).msgs.find((m) => m.role === "system")!;
        assert.equal(hasUnrecoverableMediaPayload(oaiDelta), true);
        assert.equal(dshSystemPromptPath(oaiDelta), undefined, "structured system (chat-completions wire)");
        // llm-pi-ai's chat-completions tool addition: a content-less system
        // message carrying a `tools` key.
        const oaiTools = openaiToCore({ model: "m", messages: [{ role: "user", content: "hi" }, { role: "system", tools: [{ type: "function", function: { name: "search", parameters: { type: "object", properties: {} } } }] }] } as never).msgs.find((m) => m.role === "system")!;
        assert.equal(hasUnrecoverableMediaPayload(oaiTools), true);
        assert.equal(dshSystemPromptPath(oaiTools), undefined, "tools-carrying system (chat-completions wire)");
    });

    test("lane wiring: the dsh slot registry resolves it, the drift-accounting registry does not, no other lane does", () => {
        const m = mk("w", "system", PROMPT_V2);
        assert.equal(durableMessageToolPaths.dsh!(m), "durable/system-prompt");
        assert.equal(oneShotCarrierPaths.dsh!(m), undefined, "expected-rebase accounting is deliberately unchanged by this identity");
        for (const registry of [durableMessageToolPaths, oneShotCarrierPaths]) {
            for (const [lane, classify] of Object.entries(registry)) {
                if (lane === "dsh") continue;
                assert.notEqual(classify(m), "durable/system-prompt", `KDD #9: lane ${lane} must not project a plain-text system`);
            }
        }
    });

    test("the twelve user-channel identities resolve exactly as before", () => {
        const samples: Array<[string, string]> = [
            ["\x3csystem-reminder\x3e \x3cavailable_skills\x3e updated catalog \x3c/available_skills\x3e", "durable/skill-catalog"],
            ["Instructions from: /home/x/.dsh/AGENTS.md", "durable/agents-md"],
            ["Current runtime context. This snapshot supersedes earlier runtime-context snapshots.", "durable/runtime-context"],
            ["\x3cmcp_catalog\x3e registered servers \x3c/mcp_catalog\x3e", "durable/mcp-catalog"],
            ["Time sampled while preparing turn 9, step 1: 2026-11-01T00:00:00Z", "oneshot/time-context"],
            ["\x3cpath\x3ex.png\x3c/path\x3e \x3ctype\x3eimage\x3c/type\x3e \x3ccontent\x3epng bytes\x3c/content\x3e", "oneshot/ptc-image"],
            ['background job bash-abcd (bash: "true") finished [status: completed, exit code: 0]. Read its output with job_output.', "oneshot/tool-job-notice"],
            ["[MNEMON] recall note", "oneshot/mnemon"],
            ["Background subagent session-x finished and will do no further work unless you send it more.", "oneshot/subagent-settled"],
            ["Agent session-y sent a message: over there", "oneshot/agent-relay"],
            ['Image "x.png" (sha256:2e896b95dec003df); request preview 1600x900px.', "oneshot/image-handle"],
            ['[image omitted to fit request image limits; "x.png" (sha256:2e896b95dec003df).] user words', "oneshot/image-offload-placeholder"],
        ];
        for (const [text, expected] of samples) {
            assert.equal(durableMessageToolPaths.dsh!(mk("u", "user", text)), expected, `user-role ${expected} unchanged`);
            assert.equal(oneShotCarrierPaths.dsh!(mk("u", "user", text)), expected, `drift registry ${expected} unchanged`);
            assert.equal(durableMessageToolPaths.dsh!(mk("a", "assistant", text)), undefined, `assistant echo of ${expected} still never projects`);
            // Role is the evidence: a system prompt that merely QUOTES a carrier
            // marker is still the system prompt, and must not take that
            // carrier's latest slot away from the real user-channel instance.
            assert.equal(durableMessageToolPaths.dsh!(mk("s", "system", `${text}\n${PROMPT_V2}`)), "durable/system-prompt", `system-role text quoting the ${expected} marker`);
            // The drift registry is not re-ordered: for that same message it
            // still answers by marker, as it did before this identity existed.
            assert.equal(oneShotCarrierPaths.dsh!(mk("s", "system", `${text}\n${PROMPT_V2}`)), expected, `drift registry, system-role text quoting the ${expected} marker: unchanged`);
        }
        assert.equal(durableMessageToolPaths.dsh!(mk("u", "user", "an ordinary human request")), undefined);
    });
});

describe("fold geometry through the wire codec (latest-per-identity)", () => {
    // Head prompt rides the top-level `system` field; two in-history updates
    // follow, each after a user turn and before the next assistant.
    function body(): AnthropicRequestBody {
        return {
            model: "m",
            max_tokens: 1024,
            system: PROMPT_V1,
            messages: [
                { role: "user", content: `first question ${PAD}` },
                { role: "assistant", content: `first answer ${PAD}` },
                { role: "user", content: `second question ${PAD}` },
                sys(PROMPT_V2),
                { role: "assistant", content: `second answer ${PAD}` },
                { role: "user", content: `third question ${PAD}` },
                sys(PROMPT_V3),
                toolDelta("search"),
                { role: "assistant", content: `third answer ${PAD}` },
                { role: "user", content: LIVE },
            ],
        };
    }
    const IDX = { v2: 3, v3: 6, delta: 7, lastAssistant: 8, live: 9 };

    test("dsh lane: the newest system prompt survives a fold that covers it; the superseded copy folds (THE repro)", () => {
        const msgs = anthropicToCore(body()).msgs;
        assert.equal(msgs.length, 10, "one core per wire message");
        const { res, folded } = fold(msgs, dshConfig(), "m00001", "m00009");
        assert.ok(res.result.blocksCreated >= 1, `the fold must happen, got errors=${JSON.stringify(res.result.errors)} warnings=${JSON.stringify(res.result.warnings)}`);
        assert.ok(!folded.has(msgs[IDX.v3]!.id), "the prompt in force must stay out of every block");
        assert.ok(folded.has(msgs[IDX.v2]!.id), "the superseded prompt copy folds like ordinary history");
        assert.ok(folded.has(msgs[0]!.id) && folded.has(msgs[IDX.lastAssistant]!.id), "history on both sides of the pinned prompt folds");
        assert.ok(!folded.has(msgs[IDX.delta]!.id), "the tool-delta system stays hard-pinned by the kernel rule, as before");
        assert.ok(!folded.has(msgs[IDX.live]!.id), "the live request stays visible");
    });

    test("unregistered lane: a plain-text in-history system still folds (KDD #9 scoping)", () => {
        const msgs = anthropicToCore(body()).msgs;
        const plain = defaultConfig(200_000, { preserveRecentMessages: 1, preserveRecentTokens: 0 });
        const { res, folded } = fold(msgs, plain, "m00001", "m00009");
        assert.ok(res.result.blocksCreated >= 1, `the fold must happen, got errors=${JSON.stringify(res.result.errors)}`);
        assert.ok(folded.has(msgs[IDX.v3]!.id), "no classifier, no pin: Claude Code's environment note and friends stay foldable");
        assert.ok(folded.has(msgs[IDX.v2]!.id));
        assert.ok(!folded.has(msgs[IDX.delta]!.id), "the structured system is pinned on every lane");
    });

    test("a later tool-delta system never takes the prompt identity; a later prompt does", () => {
        const config = dshConfig();
        const msgs = anthropicToCore(body()).msgs;
        const latest = collectLatestProtected(msgs, config);
        assert.equal(isMessageLatestProtected(msgs[IDX.v3]!, latest), true, "V3 is the live instance although a tool delta follows it");
        assert.equal(isMessageLatestProtected(msgs[IDX.v2]!, latest), false);
        assert.equal(isMessageLatestProtected(msgs[IDX.delta]!, latest), false, "the delta is protected by its own rule, not by this identity");

        const grown = body();
        grown.messages.push({ role: "assistant", content: "done" }, { role: "user", content: "next" }, sys(`${PROMPT_V3} PROMPT-REV-4`));
        const msgs2 = anthropicToCore(grown).msgs;
        const latest2 = collectLatestProtected(msgs2, config);
        assert.equal(isMessageLatestProtected(msgs2.at(-1)!, latest2), true, "the appended update takes the identity over");
        assert.equal(isMessageLatestProtected(msgs2[IDX.v3]!, latest2), false, "the copy it supersedes becomes foldable — exactly one live instance");
    });

    test("the four durable carriers keep their own latest slot next to the prompt", () => {
        const config = dshConfig();
        const msgs: CoreMessage[] = [
            mk("c1", "user", "\x3cavailable_skills\x3e v1 \x3c/available_skills\x3e"),
            mk("c2", "user", "Instructions from: /repo/AGENTS.md"),
            mk("c3", "user", "\x3cmcp_catalog\x3e fs \x3c/mcp_catalog\x3e"),
            mk("c4", "user", "Current runtime context. sandbox=on"),
            mk("p1", "system", PROMPT_V2),
            mk("c5", "user", "\x3cavailable_skills\x3e v2 \x3c/available_skills\x3e"),
            // A prompt that documents the harness' own markers must not demote
            // the real carriers above.
            mk("p2", "system", `${PROMPT_V3} The catalog arrives as \x3cavailable_skills\x3e; workspace rules as "Instructions from:"; state as "Current runtime context"; servers as \x3cmcp_catalog\x3e.`),
            mk("u9", "user", LIVE),
        ];
        const latest = collectLatestProtected(msgs, config);
        const pinned = msgs.filter((m) => isMessageLatestProtected(m, latest)).map((m) => m.id);
        assert.deepEqual(pinned, ["c2", "c3", "c4", "c5", "p2"], "newest of each of the five identities, nothing else");
    });

    test("Rule-3 anchor is unchanged: the newest human request, never a system prompt", () => {
        const config = dshConfig();
        const msgs: CoreMessage[] = [
            mk("o1", "user", `old question ${PAD}`),
            mk("o2", "assistant", `old answer ${PAD}`),
            mk("live", "user", LIVE),
            mk("p", "system", PROMPT_V3),
            mk("t", "user", "Time sampled while preparing turn 9, step 1: 2026-11-01T00:00:00Z"),
            mk("a3", "assistant", `working on it ${PAD}`),
        ];
        const { res, folded } = fold(msgs, config, "m00001", "m00006");
        assert.equal(res.result.blocksCreated, 1, `got errors=${JSON.stringify(res.result.errors)} warnings=${JSON.stringify(res.result.warnings)}`);
        assert.deepEqual([...folded].sort(), ["o1", "o2"], "#3953 keeps everything at/after the live request visible, prompt included");
        assert.ok(res.result.warnings.some((w) => w.startsWith("Excluded") && w.includes("Last-user anchor: m00003")), `receipt names the anchor ref, got: ${JSON.stringify(res.result.warnings)}`);
    });

    test("whole-identity takeover still wins: a user-configured durable pattern replaces the default", () => {
        const base = defaultConfig(200_000, { preserveRecentMessages: 1, preserveRecentTokens: 0 });
        const takenOver = withDurableProtection({ ...base, protectedTools: [...base.protectedTools, "durable/agents-md"] }, durableMessageToolPaths.dsh!);
        assert.deepEqual(takenOver.protectedLatestTools ?? [], base.protectedLatestTools ?? [], "no default durable/* is injected");
        const msgs = anthropicToCore(body()).msgs;
        const { folded } = fold(msgs, takenOver, "m00001", "m00009");
        assert.ok(folded.has(msgs[IDX.v3]!.id), "the user's policy names only agents-md, so the prompt follows their policy");
        const opted = withDurableProtection({ ...base, protectedLatestTools: ["durable/system-prompt"] }, durableMessageToolPaths.dsh!);
        const { folded: folded2 } = fold(msgs, opted, "m00001", "m00009");
        assert.ok(!folded2.has(msgs[IDX.v3]!.id), "the identity is addressable by name like the other four");
        assert.ok(folded2.has(msgs[IDX.v2]!.id));
    });
});

// ---------------------------------------------------------------------------
// Real folds through the plugin tool endpoint, forwarded body as the surface.
// ---------------------------------------------------------------------------

const MODEL = "model-test";

type Wire = "messages" | "chat";
type Rig = { url: (wire: Wire) => string; toolUrl: string; bodies: string[]; close: () => Promise<void> };
type WireMsg = { role: string; content: unknown };

async function startRig(): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            if (req.url?.includes("/chat/completions")) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "chatcmpl-1",
                    object: "chat.completion",
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
                }));
                return;
            }
            const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(
                sse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: Math.max(1, Math.round(raw.length / 4)) } } }) +
                sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
                sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
                sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
                sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
                sse("message_stop", { type: "message_stop" }),
            );
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
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    return {
        url: (wire) => (wire === "messages" ? `${base}/v1/messages` : `${base}/v1/chat/completions`),
        toolUrl: `http://127.0.0.1:${proxyPort}/__bili/plugin/tool`,
        bodies,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function filler(tag: string): string {
    return `${tag}-` + "z".repeat(900);
}

const E2E_V2 = `PROMPT-REV-2 answer in French. ${"q".repeat(600)}`;
const E2E_V3 = `PROMPT-REV-3 answer in German. ${"q".repeat(600)}`;

/** Eight turns with two in-history prompt updates (turns 2 and 4), one real
 *  compress whose range covers both, then one more turn. Returns the request
 *  forwarded upstream after the fold.
 *  "messages": llm-deepseek shape — head prompt in the top-level field, each
 *  update a text-block system AFTER the user turn it was admitted with.
 *  "chat": llm-pi-ai's chat-completions shape, as its conversation-updates
 *  wire test pins it ("preserves update placement": assistant, system, user)
 *  — head prompt as the leading system message, each update a string-content
 *  system BEFORE the user turn it was admitted with. */
async function runFoldScenario(wire: Wire, agent: string, conv: string): Promise<{ raw: string; messages: WireMsg[] }> {
    const rig = await startRig();
    try {
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": agent, "x-bili-plugin-conversation": conv };
        const post = async (history: WireMsg[]) => {
            const body = wire === "messages"
                ? { model: MODEL, max_tokens: 8192, stream: true, system: PROMPT_V1, messages: history }
                : { model: MODEL, max_tokens: 8192, messages: [{ role: "system", content: PROMPT_V1 }, ...history] };
            const r = await fetch(rig.url(wire), { method: "POST", headers, body: JSON.stringify(body) });
            assert.equal(r.status, 200);
            await r.text();
        };
        const update = (text: string): WireMsg => (wire === "messages" ? sys(text) : { role: "system", content: text });
        const history: WireMsg[] = [];
        for (let i = 1; i <= 8; i++) {
            const text = i === 2 ? E2E_V2 : i === 4 ? E2E_V3 : undefined;
            if (text !== undefined && wire === "chat") history.push(update(text));
            history.push({ role: "user", content: filler(`F${i}`) });
            if (text !== undefined && wire === "messages") history.push(update(text));
            await post(history);
            history.push({ role: "assistant", content: filler(`A${i}`) });
        }

        const refs = Object.keys(getSession(conv).state.messageRefs.byRef).sort();
        assert.ok(refs.length >= 10, `expected >= 10 numbered messages, got ${refs.length}`);
        const toolRes = await fetch(rig.toolUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: conv,
                tool: "compress",
                args: { topic: "prompt fold", content: [{ startId: refs[0]!, endId: refs[refs.length - 4]!, topic: "prompt fold", summary: "prompt fold summary: filler turns F1..F8 were discussed and consumed; nothing else survived this range." }] },
            }),
        });
        const toolJson = (await toolRes.json()) as Record<string, unknown>;
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `compress must succeed: HTTP ${toolRes.status} ${JSON.stringify(toolJson)}`);

        history.push({ role: "user", content: filler("F9") });
        await post(history);
        const raw = rig.bodies.at(-1)!;
        return { raw, messages: (JSON.parse(raw) as { messages: WireMsg[] }).messages };
    } finally {
        await rig.close();
    }
}

/** History entries (the head prompt excluded) whose content mentions `needle`. */
function carrying(messages: WireMsg[], needle: string): WireMsg[] {
    return messages.filter((m) => JSON.stringify(m.content).includes(needle) && !JSON.stringify(m.content).includes("PROMPT-REV-1"));
}

describe("real fold through /__bili/plugin/tool", () => {
    test("dsh lane, Messages wire: the forwarded request still carries the prompt in force after a fold that covers it", async () => {
        const { raw, messages } = await runFoldScenario("messages", "dsh", "sysprompt-dsh-messages");
        assert.ok(raw.includes("[Compressed conversation section]"), "the fold must have happened (protection may not veto the whole range)");
        const kept = carrying(messages, "PROMPT-REV-3");
        assert.equal(kept.length, 1, "the newest in-history system prompt must still reach the model, once, verbatim in history");
        // Known limit, pinned so it cannot change silently: the fold removed
        // the assistant that followed the prompt, and the kernel's position
        // heal (healIllegalSystemPositions) re-voices a plain system it finds
        // in such a spot as user. The text survives; the system role does not.
        // A kernel that relocates instead of demoting flips this to "system".
        assert.equal(kept[0]!.role, "user", "Messages wire today: prompt text kept, role demoted by the position heal");
        assert.ok(!raw.includes("PROMPT-REV-2"), "the superseded copy is ordinary history and folds away");
        assert.ok(!raw.includes("A1-"), "folded filler before the prompt must be gone (the fold really consumed its range)");
        assert.ok(!raw.includes("A5-"), "folded filler after the prompt must be gone");
        assert.ok(raw.includes("PROMPT-REV-1"), "the head prompt in the top-level system field is untouched");
    });

    test("dsh lane, chat-completions wire: same pin, and the message keeps its system role", async () => {
        const { raw, messages } = await runFoldScenario("chat", "dsh", "sysprompt-dsh-chat");
        assert.ok(raw.includes("[Compressed conversation section]"), "the fold must have happened");
        const kept = carrying(messages, "PROMPT-REV-3");
        assert.equal(kept.length, 1, "the newest in-history system prompt must still reach the model");
        assert.equal(kept[0]!.role, "system", "re-emitted verbatim from its sidecar (#4159/#4166)");
        assert.ok(!raw.includes("PROMPT-REV-2"), "the superseded copy folds away");
        assert.ok(!raw.includes("A1-") && !raw.includes("A5-"), "the fold consumed history on both sides of the prompt");
    });

    for (const wire of ["messages", "chat"] as const) {
        test(`unregistered lane, ${wire} wire: the same prompt folds away (pins lane scoping)`, async () => {
            const { raw } = await runFoldScenario(wire, "test-agent", `sysprompt-plain-${wire}`);
            assert.ok(raw.includes("[Compressed conversation section]"), "the fold must have happened");
            assert.ok(!raw.includes("PROMPT-REV-3"), "an unregistered lane has no classifier — a plain in-history system is ordinary history");
            assert.ok(raw.includes("PROMPT-REV-1"), "the head prompt is not part of the fold space on any lane");
        });
    }
});
