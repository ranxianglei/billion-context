/**
 * #6880: the plugin-declared request purpose replaces content-guessing for
 * dsh's auxiliary calls.
 *
 * The post-#6880 dsh plugin stamps `x-bili-plugin-purpose` from
 * GenerateOptions.purpose on every dispatch (dsh contract: ordinary
 * conversation requests leave it unset). The server classifies a
 * plugin-ANNOUNCED request with a non-empty purpose as a side request by
 * declaration — no per-feature template matching — and lets the guard
 * recognize a declared compaction even when dsh's INSTRUCTION text drifted.
 * The content heuristics stay as the fallback for pre-#6880 plugin installs,
 * so every pin below pairs the declared path with its undeclared twin.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, pluginPurposeHeader, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { KNOWN_AUXILIARY_PURPOSES, isSideRequest } from "../src/server/side-request.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX } from "../src/server/dsh-compaction-guard.ts";

// ---- unit pins -------------------------------------------------------------

test("pluginPurposeHeader honors the purpose only behind the x-bili-plugin marker", () => {
    const base = { "x-bili-plugin-purpose": "compaction" };
    assert.equal(pluginPurposeHeader({ ...base, "x-bili-plugin": "dsh" }), "compaction");
    // unannounced client: inert telemetry, never steering
    assert.equal(pluginPurposeHeader(base), undefined);
    // empty / whitespace values are absent values
    assert.equal(pluginPurposeHeader({ "x-bili-plugin": "dsh", "x-bili-plugin-purpose": "  " }), undefined);
    assert.equal(pluginPurposeHeader({ "x-bili-plugin": "dsh" }), undefined);
    // multi-value: the first wins, like every sibling plugin header
    assert.equal(pluginPurposeHeader({ "x-bili-plugin": "dsh", "x-bili-plugin-purpose": ["session-title", "junk"] }), "session-title");
});

test("isSideRequest: a declared purpose outranks every body heuristic", () => {
    // the dsh title shape that broke the legacy budget rule (#2503): 4096
    // budget, no tools — with a purpose it is a side request by declaration
    const titleShape = { model: "fake-a", max_completion_tokens: 4096, messages: [{ role: "user", content: "x" }] };
    assert.equal(isSideRequest(titleShape, undefined, "session-title"), true);
    // a NEW, previously-unknown sidecar purpose needs no recognizer at all
    assert.equal(isSideRequest(titleShape, undefined, "some-future-sidecar"), true);
    // declared conversation (no purpose) keeps the legacy behavior
    assert.equal(isSideRequest(titleShape), false);
    assert.equal(isSideRequest(titleShape, undefined, undefined), false);
    // purpose still cannot override an explicit "main" agent veto from the
    // same host (opencode v2 territory — the two headers never co-occur in
    // practice, but the intent rung order must stay sane)
    assert.equal(isSideRequest({ model: "fake-a", messages: [{ role: "user", content: "x" }] }, "main", "whatever"), false);
});

test("KNOWN_AUXILIARY_PURPOSES documents the four dsh purposes on the wire today", () => {
    assert.ok(KNOWN_AUXILIARY_PURPOSES.has("session-title"));
    assert.ok(KNOWN_AUXILIARY_PURPOSES.has("compaction"));
    assert.ok(KNOWN_AUXILIARY_PURPOSES.has("auto-review"));
    assert.ok(KNOWN_AUXILIARY_PURPOSES.has("timeline-report"));
});

// ---- handle-level pins -----------------------------------------------------

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-issue6880-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const MAIN_SYSTEM = "MAIN OPERATING SYSTEM";

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
    const send = async (conversationId: string, body: Record<string, unknown>, extra: Record<string, string> = {}) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, ...extra };
        return fetch(`${origin}/bili/${upstream.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
    };
    const dshSend = (conversationId: string, body: Record<string, unknown>, agent?: string, purpose?: string) => {
        const extra: Record<string, string> = { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId };
        if (agent !== undefined) extra["x-bili-plugin-agent"] = agent;
        if (purpose !== undefined) extra["x-bili-plugin-purpose"] = purpose;
        return send(conversationId, body, extra).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }));
    };
    const subSessions = async (prefix: string) => {
        const list = (await (await fetch(origin + "/__bili/sessions")).json()) as { sessions?: { id: string }[] };
        assert.ok(Array.isArray(list.sessions));
        return (list.sessions ?? []).map((s) => s.id).filter((id) => id.startsWith(prefix + "|sub:"));
    };
    return { forwarded, dshSend, send, subSessions, origin, close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await new Promise((r2) => setTimeout(r2, 50)); } };
}

test("declared title sidecar rides the passthrough under the raw key even with unknown system text", async () => {
    const h = await harness();
    try {
        const history = [
            { role: "user", content: "set up the workspace" },
            { role: "assistant", content: "done" },
        ];
        // The #2503 killer shape: alpha.2 budget (4096, no tools) AND a system
        // prompt that is NOT the tracked DSH_TITLE_SYSTEM_PREFIX template —
        // i.e. a dsh version whose title text moved. Only the declaration
        // can still classify it.
        const driftedTitleSystem = "Summarize this conversation into a short heading. New template text.";
        const titleBody = { model: "fake-a", max_completion_tokens: 4096, stream: false, messages: [{ role: "system", content: driftedTitleSystem }, ...history, { role: "user", content: `[${JSON.stringify(history)}]` }] };

        // 1. declared: side request by purpose — verbatim, no ghost, no kernel.
        await h.dshSend("conv1", titleBody, undefined, "session-title");
        assert.deepEqual(h.forwarded.at(-1), titleBody, "declared sidecar forwarded verbatim (nothing injected)");
        assert.equal(resolveConversation("conv1").session?.stats.requests ?? 0, 0, "declared sidecar runs no kernel request");
        assert.deepEqual(await h.subSessions("conv1"), [], "declared sidecar mints no |sub: ghost");

        // 2. first real main turn still claims the raw key.
        const mainBody = { model: "fake-a", max_completion_tokens: 8192, stream: false, messages: [{ role: "system", content: MAIN_SYSTEM }, ...history, { role: "assistant", content: "ok" }, { role: "user", content: "now configure ci" }], tools: [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } } }] };
        await h.dshSend("conv1", mainBody, "main");
        const session = resolveConversation("conv1").session!;
        assert.equal(session.stats.requests, 1, "the main turn runs the full pipeline exactly once");
        assert.deepEqual(await h.subSessions("conv1"), [], "main turn stays on the raw key (no persona fork)");
    } finally {
        await h.close();
    }
});

test("the same body WITHOUT the purpose header is a main turn (legacy path unchanged)", async () => {
    const h = await harness();
    try {
        const history = [{ role: "user", content: "hello" }];
        const body = { model: "fake-a", max_completion_tokens: 4096, stream: false, messages: [{ role: "system", content: "Summarize this conversation into a short heading." }, ...history, { role: "user", content: "anything" }] };
        // pre-#6880 plugin: no purpose header, unknown system text, big
        // budget — the legacy heuristics cannot classify it as a sidecar, so
        // it runs the full pipeline exactly as before (behavior parity for
        // un-upgraded installs).
        const r1 = await h.dshSend("conv2", body);
        assert.equal(r1.status, 200);
        assert.equal(resolveConversation("conv2").session?.stats.requests ?? 0, 1, "undeclared looks like a main turn to the legacy rules");
        // but with the declaration, an IDENTICAL body on a fresh id is a
        // sidecar — the header, not the bytes, decides.
        const r2 = await h.dshSend("conv3", body, undefined, "session-title");
        assert.equal(r2.status, 200);
        assert.equal(resolveConversation("conv3").session?.stats.requests ?? 0, 0, "identical body + declaration is a sidecar");
    } finally {
        await h.close();
    }
});

test("a purpose header without the x-bili-plugin marker is inert", async () => {
    const h = await harness();
    try {
        const body = { model: "fake-a", max_completion_tokens: 8192, stream: false, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: "hello" }] };
        // unannounced client: the purpose must not steer it into the side
        // passthrough — the trust gate keeps the pipeline running.
        const r = await h.send("conv4", body, { "x-bili-plugin-purpose": "compaction" });
        assert.equal(r.status, 200);
        assert.equal(resolveConversation("conv4").session?.stats.requests ?? 0, 1, "no marker: purpose ignored, full pipeline runs");
    } finally {
        await h.close();
    }
});

test("a declared dsh compaction is guarded even when the INSTRUCTION text drifted", async () => {
    const h = await harness();
    try {
        // dsh bumped its compaction INSTRUCTION template; the tracked prefix
        // no longer matches (the #2193 failure mode) — but the plugin
        // declaration still carries the purpose.
        const driftedInstruction = "Please compress the prior conversation. " + DSH_COMPACTION_INSTRUCTION_PREFIX.slice(0, 3);
        const body = { model: "fake-a", max_completion_tokens: 8192, stream: false, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: "old work" }, { role: "assistant", content: "ok" }, { role: "user", content: driftedInstruction }] };
        const r = await h.dshSend("conv5", body, undefined, "compaction");
        assert.equal(r.status, 422, "declared compaction is refused like its text-matched twin");
        const err = r.body?.error as { code?: string };
        assert.equal(err?.code, "dsh_compaction_refused");
        assert.equal(h.forwarded.length, 0, "the refused call never reaches the upstream");
    } finally {
        await h.close();
    }
});
