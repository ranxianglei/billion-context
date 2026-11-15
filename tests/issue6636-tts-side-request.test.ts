import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { isAudioOutputCall, isSideRequest, resolveSideLane } from "../src/server/side-request.ts";

// #6636: dsh-fish-soul synthesizes speech through a TTS model exposed on
// /chat/completions (Xiaomi MiMo mimo-v2.5-tts). The plugin sends a tool-less
// {model, messages:[user, assistant], audio:{format, voice}, stream:false}
// body — a one-shot media side call, not a conversation. Pre-fix bili ran it
// through the full pipeline: the FUNCTION_ACP_TAGS_TIMESTAMPED system prompt
// was injected as messages[0] and every message got an <acp> prefix, and the
// upstream 400d with "messages[0] system role is not allowed for TTS model"
// (the same messages undecorated return 200 — control experiment in the
// issue). Post-fix the tool-less audio shape rides the #388 verbatim side
// passthrough: nothing injected, kernel state untouched. Delete the predicate
// in src/server/side-request.ts and this goes red.
process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-tts-side-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

// The issue's exact TTS body (verbatim, including the Chinese text).
const TTS_BODY = {
    model: "mimo-v2.5-tts",
    messages: [
        { role: "user", content: "请用自然口语的方式朗读下面这句话" },
        { role: "assistant", content: "这条要念的话。" },
    ],
    audio: { format: "mp3", voice: "mimo_default" },
    stream: false,
};

test("isAudioOutputCall: positive — the captured #6636 TTS shape", () => {
    assert.equal(isAudioOutputCall(TTS_BODY), true, "issue shape (audio object, no tools)");
    assert.equal(isAudioOutputCall({ model: "m", messages: [{ role: "user", content: "hi" }], audio: { voice: "v" } }), true, "voice-only audio still counts");
    assert.equal(isAudioOutputCall({ model: "m", messages: [{ role: "user", content: "hi" }], audio: { format: "mp3" } }), true, "format-only audio still counts");
    assert.equal(isAudioOutputCall({ model: "m", messages: [{ role: "user", content: "hi" }], audio: { format: "mp3" }, tools: [] }), true, "an empty tools array is no action surface");
    assert.equal(isAudioOutputCall({ model: "m", messages: [{ role: "user", content: "hi" }], audio: { format: "mp3" }, stream: true }), true, "streaming TTS is still a media side call");
});

test("isAudioOutputCall: negatives — every veto keeps the request on the main pipeline", () => {
    assert.equal(isAudioOutputCall(null), false, "null body");
    assert.equal(isAudioOutputCall({}), false, "empty body");
    assert.equal(isAudioOutputCall({ model: "m", messages: [{ role: "user", content: "hi" }] }), false, "no audio field");
    assert.equal(isAudioOutputCall({ model: "m", messages: [{ role: "user", content: "hi" }], audio: {} }), false, "empty audio object carries no media request");
    assert.equal(isAudioOutputCall({ model: "m", messages: [{ role: "user", content: "hi" }], audio: "mp3" }), false, "audio must be an object");
    assert.equal(isAudioOutputCall({ model: "m", messages: [{ role: "user", content: "hi" }], audio: [{ format: "mp3" }] }), false, "audio must not be an array");
    assert.equal(isAudioOutputCall({ ...TTS_BODY, tools: [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: {} } } }] }), false, "any tool entry vetoes (#546: an action surface marks a main turn)");
});

test("isSideRequest: the audio shape is a side request; explicit intent still outranks the structure", () => {
    assert.equal(isSideRequest(TTS_BODY), true, "tool-less audio request is a side request");
    assert.equal(isSideRequest(TTS_BODY, "main"), false, "explicit main intent vetoes the structure");
    assert.equal(isSideRequest(TTS_BODY, "title"), true, "declared side agent stays side");
    // The old rules are untouched for everything the structure does not claim.
    assert.equal(isSideRequest({ max_tokens: 100 }), true, "tiny-budget heuristic intact");
    assert.equal(isSideRequest({ max_tokens: 1024, tools: [{ name: "compress" }] }), false, "#546 veto intact for client tools");
});

test("resolveSideLane: the #6636 label names the structural shape in the log line", () => {
    assert.equal(
        resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "openai", stripApplied: false, sideIntent: true, requestAgent: undefined, sideLabel: "audio-output utility call (#6636)" }).reason,
        "audio-output utility call (#6636)",
    );
});

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    mkdirSync(join(dir, "billion-context", "sessions"), { recursive: true });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.close(); } }));
    });
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstream.url, routes: { [upstream.url]: { models: { "fake-a": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    // dsh shape: x-bili-plugin + conversation headers always; the persona agent
    // header is stamped on MAIN turns only — the TTS side call arrives without
    // it, like the title sidecar.
    const dshSend = async (conversationId: string, body: Record<string, unknown>, agent?: string) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId };
        if (agent !== undefined) headers["x-bili-plugin-agent"] = agent;
        const response = await fetch(`${origin}/bili/${upstream.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(response.status, 200, await response.text());
    };
    const sessionIds = async () => {
        const body = (await (await fetch(origin + "/__bili/sessions")).json()) as { sessions?: { id: string }[] };
        assert.ok(Array.isArray(body.sessions), `/__bili/sessions returned no list: ${JSON.stringify(body)}`);
        return body.sessions.map((s) => s.id);
    };
    const subSessions = async (prefix: string) => (await sessionIds()).filter((id) => id.startsWith(prefix + "|sub:"));
    return { forwarded, dshSend, subSessions, origin, close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await new Promise((r2) => setTimeout(r2, 50)); } };
}

test("e2e: the #6636 TTS call rides the #388 passthrough verbatim — no system prompt, no tags, no kernel touch", async () => {
    const h = await harness();
    try {
        // 1. TTS-first on a fresh session: the side call must not claim the
        // raw-key anchor with anything (no |sub: ghost, no kernel request).
        await h.dshSend("conv-tts-first", TTS_BODY);
        assert.deepEqual(h.forwarded.at(-1), TTS_BODY, "TTS call forwarded byte-identical (no system injected, no <acp> tags, audio intact)");
        assert.deepEqual(await h.subSessions("conv-tts-first"), [], "the TTS call mints no |sub: ghost");
        assert.equal(resolveConversation("conv-tts-first").session?.stats.requests ?? 0, 0, "the TTS call runs no kernel request");

        // 2. Control: a real main turn on a second session still gets the ACP
        // decoration (leading system prompt + per-message tags).
        const history = [
            { role: "user", content: "set up the workspace" },
            { role: "assistant", content: "done" },
        ];
        await h.dshSend("conv-tts-after-main", { model: "fake-a", max_completion_tokens: 8192, stream: false, messages: [{ role: "system", content: "MAIN OPERATING SYSTEM" }, ...history, { role: "user", content: "now configure ci" }], tools: [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } } }] }, "main");
        const mainFwd = h.forwarded.at(-1) as { messages: { role: string; content: string }[] };
        const mainSys = mainFwd.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
        assert.ok(mainSys.includes("ACP TAGS"), "control: the main turn still gets the ACP system prompt");
        assert.ok(mainFwd.messages.some((m) => typeof m.content === "string" && m.content.includes("<acp")), "control: the main turn still gets per-message <acp> tags");
        const mainSession = resolveConversation("conv-tts-after-main").session!;
        assert.ok(mainSession, "raw-key session exists");
        assert.equal(mainSession.stats.requests, 1, "the main turn runs the full pipeline exactly once");
        const requestsAfterMain = mainSession.stats.requests;
        const inputAfterMain = mainSession.stats.lastInputTokens;

        // 3. The TTS call on the SAME session, after anchoring: still verbatim,
        // kernel state and usage baseline untouched.
        await h.dshSend("conv-tts-after-main", TTS_BODY);
        assert.deepEqual(h.forwarded.at(-1), TTS_BODY, "post-anchor TTS call still forwarded byte-identical");
        assert.equal(mainSession.stats.requests, requestsAfterMain, "the TTS call must not count as a main request");
        assert.equal(mainSession.stats.lastInputTokens, inputAfterMain, "the TTS call must not touch the usage baseline");
        assert.deepEqual(await h.subSessions("conv-tts-after-main"), [], "still no |sub: ghost after anchoring");
    } finally {
        await h.close();
    }
});
