// #5656/#5584: dsh fires one-shot model sidecars around the main conversation
// under the SAME conversation id — title-gen (#2503, pinned prefix), auto-review
// (#4438, pinned prefix), prompt-enhance (#5656, new system text every host
// release). Every NEW sidecar that misses the pinned prefixes and fires before
// the first main turn CLAIMS the raw-key anchor (first-seen-instructions
// semantics), exiling the real conversation onto `<id>|sub:<fp>` for the session
// lifetime: compress/acp_status resolve the bare id, see the 1-message ghost,
// never match a ref, trip the circuit breaker — compression is permanently dead
// and the context grows unbounded (11 of 13 sessions on the reporter's machine,
// feeding #5671's terminal 7.3×-window deaths). isDshSingleShotSidecar closes
// the hole structurally: no action surface (no tools) + single-shot body (one
// non-system message, no assistant turn) + a non-empty system carrier, ANY
// system text, and no durable-state marker in the user blob; the call sites
// additionally require a small pinned output budget (#5687 follow-up,
// hasSingleShotBudget). These tests pin that contract in both directions (#3617).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { resetSessionOrderForTest } from "../src/session-resolve.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, peekSession, _resetSessionsForTest } from "../src/session.ts";
import { hasSingleShotBudget, isDshSingleShotSidecar } from "../src/server/side-request.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "claude-sonnet-4-5";
const MAIN_SYSTEM = "You are DeepSeek Harness, the main coding agent.\nWorkspace: /tmp.";
// The #5656 incident sidecar: prompt-enhance. Own system, one user blob, no
// tools — deliberately NOT any pinned prefix.
const ENHANCE_SYSTEM = "你是一个提示词重写助手。请重写用户提供的提示词，使其更清晰。";
const TRANSLATE_SYSTEM = "Translate the user's text to English. Output only the translation.";

const forkKey = (conv: string, system: string): string =>
    `${conv}|sub:${createHash("sha256").update(system, "utf8").digest("hex").slice(0, 16)}`;

const tools = [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: {} } } }];

const mainMsgs = (n: number): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i): { role: string; content: string } => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `main-${i + 1}-` + "z".repeat(6000),
    }));

type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server };
type UpstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const chatCompletionUpstream: UpstreamHandler = (req, res) => {
    let b = "";
    req.on("data", (c: Buffer) => (b += c.toString("utf8")));
    req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }));
    });
};

async function startRig(upstreamHandler: UpstreamHandler = chatCompletionUpstream): Promise<Rig> {
    const upstream = http.createServer(upstreamHandler);
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
        kernelConfig: defaultConfig(200_000),
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
    return { proxyPort: (proxy.address() as { port: number }).port, upstreamPort, proxy, upstream };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

test("unit #5656: isDshSingleShotSidecar matches the one-shot no-tools shape on every wire", () => {
    // The incident shape: own system, one user blob, NO tools key at all.
    assert.equal(isDshSingleShotSidecar("openai", { model: MODEL, messages: [{ role: "system", content: ENHANCE_SYSTEM }, { role: "user", content: "请重写以下提示词：帮我写个脚本" }] }), true, "openai: system + single user, no tools");
    assert.equal(isDshSingleShotSidecar("openai", { model: MODEL, tools: [], messages: [{ role: "system", content: ENHANCE_SYSTEM }, { role: "user", content: "blob" }] }), true, "empty tools array is no action surface");
    assert.equal(isDshSingleShotSidecar("openai", { model: MODEL, messages: [{ role: "system", content: ENHANCE_SYSTEM }, { role: "user", content: [{ type: "text", text: "blob" }] }] }), true, "parts-array content");
    assert.equal(isDshSingleShotSidecar("openai", { model: MODEL, messages: [{ role: "developer", content: ENHANCE_SYSTEM }, { role: "user", content: "blob" }] }), true, "developer-role system carrier");
    assert.equal(isDshSingleShotSidecar("anthropic", { model: MODEL, system: ENHANCE_SYSTEM, messages: [{ role: "user", content: "blob" }] }), true, "anthropic top-level system");
    assert.equal(isDshSingleShotSidecar("responses", { model: MODEL, instructions: ENHANCE_SYSTEM, input: [{ type: "message", role: "user", content: "blob" }] }), true, "responses instructions + single item");
    assert.equal(isDshSingleShotSidecar("google", { model: MODEL, systemInstruction: { parts: [{ text: ENHANCE_SYSTEM }] }, contents: [{ role: "user", parts: [{ text: "blob" }] }] }), true, "google systemInstruction + contents");
});

test("unit #5656: isDshSingleShotSidecar vetoes every main-turn and aux shape", () => {
    // Action surface: a main turn carries tools (#546) — the discriminator.
    assert.equal(isDshSingleShotSidecar("openai", { model: MODEL, tools, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: "go" }] }), false, "tools present = main turn, even single-message");
    assert.equal(isDshSingleShotSidecar("openai", { model: MODEL, tools: [{ type: "function", function: { name: "acp_compress" } }], messages: [{ role: "system", content: ENHANCE_SYSTEM }, { role: "user", content: "blob" }] }), false, "only-bili tools still count as an action surface here (#1897 owns that lane)");
    // Replayed history: the single-shot bar (#4438 discipline).
    assert.equal(isDshSingleShotSidecar("openai", { model: MODEL, messages: [{ role: "system", content: ENHANCE_SYSTEM }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }), false, "assistant turn in history");
    assert.equal(isDshSingleShotSidecar("openai", { model: MODEL, messages: [{ role: "system", content: ENHANCE_SYSTEM }, { role: "user", content: "a" }, { role: "user", content: "b" }] }), false, "two user messages");
    assert.equal(isDshSingleShotSidecar("responses", { model: MODEL, instructions: ENHANCE_SYSTEM, input: [{ type: "reasoning", summary: [] }] }), false, "responses reasoning item");
    // Degenerate bodies.
    assert.equal(isDshSingleShotSidecar("openai", { model: MODEL, messages: [{ role: "user", content: "no system" }] }), false, "no system carrier — kernel empty-carrier path, not this gate");
    assert.equal(isDshSingleShotSidecar("openai", { model: MODEL, messages: [{ role: "system", content: "   " }, { role: "user", content: "blob" }] }), false, "whitespace-only system carrier");
    assert.equal(isDshSingleShotSidecar("openai", { model: MODEL, messages: [{ role: "system", content: ENHANCE_SYSTEM }, { role: "user", content: "" }] }), false, "empty user content");
    assert.equal(isDshSingleShotSidecar(null, { model: MODEL }), false, "null protocol");
    assert.equal(isDshSingleShotSidecar("openai", null), false, "null body");
    assert.equal(isDshSingleShotSidecar("openai", "nope"), false, "non-object body");
});

test("unit #5687 follow-up: hasSingleShotBudget accepts only a small pinned numeric budget", () => {
    assert.equal(hasSingleShotBudget({ max_tokens: 4096 }), true, "anthropic wire preset (prompt-enhance 4096)");
    assert.equal(hasSingleShotBudget({ max_tokens: 8192 }), true, "boundary inclusive");
    assert.equal(hasSingleShotBudget({ max_tokens: 8193 }), false, "just past the boundary");
    assert.equal(hasSingleShotBudget({ max_completion_tokens: 4096 }), true, "openai chat modern field");
    assert.equal(hasSingleShotBudget({ max_output_tokens: 1024 }), true, "responses wire field");
    assert.equal(hasSingleShotBudget({ model: MODEL }), false, "field omitted (openai main-turn shape) -> full pipeline");
    assert.equal(hasSingleShotBudget({ max_tokens: 64_000 }), false, "conversation-sized main-turn budget");
    assert.equal(hasSingleShotBudget({ max_tokens: 0 }), false, "zero");
    assert.equal(hasSingleShotBudget({ max_tokens: -1 }), false, "negative");
    assert.equal(hasSingleShotBudget({ max_tokens: "4096" }), false, "numeric string is not a number (fail-safe direction)");
    assert.equal(hasSingleShotBudget(null), false, "null body");
    assert.equal(hasSingleShotBudget("nope"), false, "non-object body");
});

test("e2e #5656 (incident repro): a single-shot sidecar arriving FIRST never claims the raw-key anchor — the main conversation keeps the raw key", async () => {
    const rig = await startRig();
    const CONV = "dshp-5656-openai";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };

        // Phase 1 — the prompt-enhance sidecar fires BEFORE the first main
        // turn (the #5656 incident order). Pre-fix it claimed the raw-key
        // anchor with ENHANCE_SYSTEM's fingerprint.
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: "system", content: ENHANCE_SYSTEM }, { role: "user", content: "请重写以下提示词：帮我写个脚本" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.ok(!peekSession(forkKey(CONV, ENHANCE_SYSTEM)), "sidecar minted no fork");
        const afterSidecar = peekSession(CONV);
        assert.equal(afterSidecar === undefined || Object.keys(afterSidecar.state.messageRefs.byRaw).length === 0, true, "sidecar left no refs on the raw key (kernel-no-touch)");

        // Phase 2 — the first MAIN turn (different system, tools, history)
        // must claim the raw key itself: no fork for EITHER persona.
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools, messages: [{ role: "system", content: MAIN_SYSTEM }, ...mainMsgs(12)] }),
        });
        assert.equal(r2.status, 200);
        await r2.text();
        const main = getSession(CONV);
        assert.ok(main, "main session exists under the RAW conversation key");
        assert.ok(Object.keys(main.state.messageRefs.byRaw).length >= 12, "refs assigned to the main history");
        assert.ok(!peekSession(forkKey(CONV, MAIN_SYSTEM)), "main system did NOT fork onto |sub: — the raw key is the main session's");
        assert.equal(resolveConversation(CONV)?.entry?.sessionId, main.id, "raw conversation key resolves to the main session id");

        // Phase 3 — a later single-shot sidecar with yet another system text
        // (a future host feature) stays stateless: no fork, no kernel touch.
        const r3 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: "system", content: TRANSLATE_SYSTEM }, { role: "user", content: "translate this" }] }),
        });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.ok(!peekSession(forkKey(CONV, TRANSLATE_SYSTEM)), "future sidecar system minted no fork");
        assert.ok(Object.keys(getSession(CONV).state.messageRefs.byRaw).length >= 12, "main refs intact after the sidecar");
        assert.equal(getSession(CONV)?.stats.requests, 1, "sidecar did not count as a main request");

        // Phase 4 — the next main turn keeps the raw key.
        const r4 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools, messages: [{ role: "system", content: MAIN_SYSTEM }, ...mainMsgs(4)] }),
        });
        assert.equal(r4.status, 200);
        await r4.text();
        assert.equal(getSession(CONV)?.stats.requests, 2, "main turn rides the raw key");
    } finally {
        await closeRig(rig);
    }
});

test("e2e #5656 anthropic lane: the same incident order on /v1/messages", async () => {
    const rig = await startRig();
    const CONV = "dshp-5656-anthropic";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
        const sidecar = {
            model: MODEL,
            max_tokens: 4096,
            system: [{ type: "text", text: ENHANCE_SYSTEM }],
            messages: [{ role: "user", content: [{ type: "text", text: "请重写以下提示词：帮我写个脚本" }] }],
        };
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify(sidecar) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.ok(!peekSession(forkKey(CONV, ENHANCE_SYSTEM)), "anthropic sidecar minted no fork");

        const mainTurn = {
            model: MODEL,
            max_tokens: 64_000,
            tools: [{ name: "bash", description: "run", input_schema: { type: "object", properties: {} } }],
            system: [{ type: "text", text: MAIN_SYSTEM }],
            messages: mainMsgs(12).map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] })),
        };
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify(mainTurn) });
        assert.equal(r2.status, 200);
        await r2.text();
        const main = getSession(CONV);
        assert.ok(main, "main session exists under the RAW key");
        assert.ok(Object.keys(main.state.messageRefs.byRaw).length >= 12, "refs assigned");
        assert.ok(!peekSession(forkKey(CONV, MAIN_SYSTEM)), "no |sub: fork for the main system");
    } finally {
        await closeRig(rig);
    }
});

test("e2e #5656 negative: a tool-less multi-message MAIN turn still goes through the full pipeline (single-shot gate does not eat it)", async () => {
    const rig = await startRig();
    const CONV = "dshp-5656-tooled-off";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
        // Turn 1 of a tools-disabled conversation matches the single-shot SHAPE
        // (system + 1 user, no tools); the conversation-sized output budget
        // (64000 below) is what keeps it off the side lane (#5687 follow-up).
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: "main-1-" + "z".repeat(6000) }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();
        const stub = peekSession(CONV);
        const refs1 = stub ? Object.keys(stub.state.messageRefs.byRaw).length : 0;
        const reqs1 = stub ? stub.stats.requests : 0;
        // #5687 follow-up: this residual is REVOKED. A tool-less turn 1 that
        // carries a conversation-sized output budget (64000 here) is a MAIN turn,
        // not a utility sidecar: the small-budget requirement is what keeps it on
        // the kernel path. Pinning the old "rides the side lane" behavior here is
        // exactly what let #2817/#5403 regress.
        assert.ok(refs1 >= 1 && reqs1 >= 1, `tool-less turn 1 with a conversation budget goes through the full pipeline (refs=${refs1}, requests=${reqs1})`);
        // Turn 2 replays history (user+assistant+user): NOT single-shot — full
        // pipeline, claims the raw key, compression state builds.
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 64_000,
                messages: [
                    { role: "system", content: MAIN_SYSTEM },
                    { role: "user", content: "main-1-" + "z".repeat(6000) },
                    { role: "assistant", content: "main-2-" + "z".repeat(6000) },
                    { role: "user", content: "main-3-" + "z".repeat(6000) },
                ],
            }),
        });
        assert.equal(r2.status, 200);
        await r2.text();
        const s = getSession(CONV);
        assert.ok(Object.keys(s.state.messageRefs.byRaw).length >= 3, "tool-less MAIN replay went through the full pipeline (refs assigned)");
        assert.ok(!peekSession(forkKey(CONV, MAIN_SYSTEM)), "no fork — tool-less main traffic owns the raw key");
    } finally {
        await closeRig(rig);
    }
});
