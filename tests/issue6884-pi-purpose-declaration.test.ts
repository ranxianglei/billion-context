/**
 * #6884: pi's leg of the #6880 plugin purpose declaration (cross-agent
 * session-id audit, discussions/6884 — "dsh, pi — exactly the two where bili
 * has in-process plugins").
 *
 * pi has NO auxiliary LLM calls — no title-gen, no compaction summarizer,
 * no auto-review; subagents and forks mint FRESH session ids (their
 * parentSession file header points back at the parent), so every dispatch
 * through the pi plugin is the session's MAIN conversation turn. The plugin
 * therefore stamps the "conversation" sentinel (plugin.ts
 * PLUGIN_PURPOSE_CONVERSATION) on EVERY dispatch, and the server treats that
 * sentinel, from a PI-marked request, as a declared MAIN turn riding the
 * #1699 explicit-"main" intent rung: it outranks every body heuristic.
 *
 * The sentinel deliberately means something different per client:
 *  - pi: a FACT about the dispatch (pi cannot have an undeclared aux call —
 *    the concept does not exist) → suppresses the heuristics;
 *  - dsh: an INFERENCES ("dsh left GenerateOptions.purpose unset" —
 *    possibly a brand-new aux feature) → stays ≡ absent, the body
 *    heuristics classify, byte-for-byte as before this change (#6880 pin in
 *    tests/issue6880-purpose-declaration.test.ts stays green).
 *
 * The bug this defends: a pi main turn whose BODY happens to match a legacy
 * side shape — canonical case: a `pi -p` one-shot (or any toolless
 * configuration) with a small maxTokens — was demoted to the #388 side
 * passthrough by the max_tokens<=200 budget heuristic and never entered the
 * kernel pipeline: no compression state, no tools, silent substrate loss on
 * a real conversation turn.
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
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-issue6884-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

/** The #388 killer shape for a declared pi main turn: toolless body whose
 *  output budget is under the 200-token side-request heuristic. Pre-change
 *  this demoted a real main turn to the side passthrough. */
const SIDE_SHAPED_BODY = { model: "fake-a", max_completion_tokens: 64, stream: false, messages: [{ role: "user", content: "one-shot: what is the smallest prime greater than 50?" }] };

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
    // piSend: the post-#6884 pi plugin shape — marker + conversation id +
    // the "conversation" sentinel on every dispatch. `purpose: undefined`
    // simulates a pre-#6884 pi install (marker + conversation id, no
    // purpose header); `marker: false` a wire-mode (unannounced) client.
    const piSend = (conversationId: string, body: Record<string, unknown>, purpose?: string, marker = true) => {
        const extra: Record<string, string> = {};
        if (marker) {
            extra["x-bili-plugin"] = "pi";
            extra["x-bili-plugin-conversation"] = conversationId;
        }
        if (purpose !== undefined) extra["x-bili-plugin-purpose"] = purpose;
        return send(conversationId, body, extra).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }));
    };
    const dshSend = (conversationId: string, body: Record<string, unknown>, purpose?: string) => {
        const extra: Record<string, string> = { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId };
        if (purpose !== undefined) extra["x-bili-plugin-purpose"] = purpose;
        return send(conversationId, body, extra).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }));
    };
    const subSessions = async (prefix: string) => {
        const list = (await (await fetch(origin + "/__bili/sessions")).json()) as { sessions?: { id: string }[] };
        assert.ok(Array.isArray(list.sessions));
        return (list.sessions ?? []).map((s) => s.id).filter((id) => id.startsWith(prefix + "|sub:"));
    };
    return { forwarded, piSend, dshSend, send, subSessions, origin, close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await new Promise((r2) => setTimeout(r2, 50)); } };
}

test("a DECLARED pi main turn with a side-shaped body rides the full pipeline", async () => {
    const h = await harness();
    try {
        // declared: the sentinel outranks the max_tokens<=200 budget
        // heuristic — the turn enters the kernel pipeline exactly once.
        const r = await h.piSend("pi1", SIDE_SHAPED_BODY, "conversation");
        assert.equal(r.status, 200);
        const session = resolveConversation("pi1").session!;
        assert.ok(session, "the raw conversation resolved to a session");
        assert.equal(session.stats.requests, 1, "declared main turn runs the full pipeline once (not the side passthrough)");
        assert.deepEqual(await h.subSessions("pi1"), [], "no persona fork off a declared pi main turn");
    } finally {
        await h.close();
    }
});

test("the IDENTICAL body WITHOUT the purpose header still rides the side passthrough (legacy path unchanged)", async () => {
    const h = await harness();
    try {
        // pre-#6884 pi install shape: marker + conversation id, no purpose —
        // the body heuristics classify as before, so the same shape IS a
        // side request. The declaration, not the bytes, is what changed the
        // lane decision.
        const r = await h.piSend("pi2", SIDE_SHAPED_BODY);
        assert.equal(r.status, 200);
        assert.equal(resolveConversation("pi2").session?.stats.requests ?? 0, 0, "undeclared side-shaped body keeps the legacy demotion");
        assert.equal(h.forwarded.length, 1, "it still reaches the upstream");
        assert.deepEqual(h.forwarded.at(-1), SIDE_SHAPED_BODY, "side passthrough forwards verbatim (nothing injected)");
    } finally {
        await h.close();
    }
});

test("the IDENTICAL body without the x-bili-plugin marker keeps the legacy demotion (unannounced clients unaffected)", async () => {
    const h = await harness();
    try {
        const r = await h.piSend("pi3", SIDE_SHAPED_BODY, undefined, false);
        assert.equal(r.status, 200);
        assert.equal(resolveConversation("pi3").session?.stats.requests ?? 0, 0, "wire-mode client: heuristics still classify");
    } finally {
        await h.close();
    }
});

test("the DSH sentinel declares main: a dsh main turn with a side-shaped body rides the full pipeline (#7572)", async () => {
    const h = await harness();
    try {
        // #7572: the "conversation" sentinel is a FACT about the dispatch for
        // dsh too — ordinary conversation leaves GenerateOptions.purpose UNSET
        // (the plugin stamps the sentinel), while every auxiliary call sets a
        // real purpose value. So the sentinel can only appear on a main turn,
        // and it rides the #1699 explicit-"main" intent rung (like pi): it
        // outranks the max_tokens<=200 budget heuristic. Pre-#7572 this body
        // was demoted to the #388 side passthrough by the budget heuristic and
        // never entered the kernel pipeline — the long-conversation brick.
        const r = await h.dshSend("pi4", SIDE_SHAPED_BODY, "conversation");
        assert.equal(r.status, 200);
        assert.equal(resolveConversation("pi4").session?.stats.requests ?? 0, 1, "dsh sentinel + side-shaped body: declared main turn rides the full pipeline (#7572)");
        assert.deepEqual(await h.subSessions("pi4"), [], "no persona fork off a declared dsh main turn");
    } finally {
        await h.close();
    }
});

test("a declared pi conversation keys the raw id across system drift (one session one key terminal state)", async () => {
    const h = await harness();
    try {
        const base = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
        // turn 1: pre-#6884 install shape (undeclared).
        await h.piSend("pi5", { model: "fake-a", max_completion_tokens: 8192, stream: false, messages: [{ role: "system", content: "MAIN OPERATING SYSTEM" }, ...base] });
        // turn 2: upgraded plugin declares the sentinel, and its system text
        // drifted (pi version bump / AGENTS.md edit) with history-disjoint
        // content. pi is not in any persona-split registry, so the raw id IS
        // the identity: one session, no fork, blocks never orphan.
        const r = await h.piSend("pi5", { model: "fake-a", max_completion_tokens: 8192, stream: false, messages: [{ role: "system", content: "MAIN OPERATING SYSTEM (v2 instructions)" }, { role: "user", content: "completely different fresh context" }, { role: "user", content: "keep going" }] }, "conversation");
        assert.equal(r.status, 200);
        assert.equal(resolveConversation("pi5").session?.stats.requests ?? 0, 2, "both turns live on the raw session");
        assert.deepEqual(await h.subSessions("pi5"), [], "no |sub: lane off declared pi traffic");
    } finally {
        await h.close();
    }
});

test("a declared dsh main turn with NO tools and a starved budget (16) gets its budget restored (#7572 gate 2)", async () => {
    const h = await harness();
    try {
        // The exact #7572 shape: a dsh main turn (conversation sentinel) whose
        // history outgrew the window, so the host shrunk the output budget to
        // 16 to fit. Pre-#7572 the no-tools early return in restoreOutputBudget
        // swallowed the rescue (the request looked like a side request), so the
        // 16 budget forwarded verbatim and the model could never emit the
        // compress call. Post-#7572 the trusted declared-main flag skips the
        // no-tools early return, so the budget is restored to the ceiling.
        const starved = { model: "fake-a", max_completion_tokens: 16, stream: false, messages: [{ role: "user", content: "continue the long conversation" }] };
        const r = await h.dshSend("pi6", starved, "conversation");
        assert.equal(r.status, 200);
        assert.equal(resolveConversation("pi6").session?.stats.requests ?? 0, 1, "declared dsh main turn rides the full pipeline");
        const fwd = h.forwarded.at(-1) as { max_completion_tokens?: number };
        assert.ok(typeof fwd.max_completion_tokens === "number" && fwd.max_completion_tokens > 16,
            `starved 16 budget was restored to ${fwd.max_completion_tokens} (above the 16 floor), not forwarded verbatim (#7572 gate 2)`);
    } finally {
        await h.close();
    }
});

test("a dsh AUXILIARY call (real purpose) with no tools and a small budget keeps the legacy demotion + no restore (#7572 negative)", async () => {
    const h = await harness();
    try {
        // The negative case: a dsh aux call (e.g. session-title) carries a REAL
        // purpose (not the conversation sentinel), so declaredMainTurn is false.
        // The no-tools early return in restoreOutputBudget still applies, and
        // the request is heuristic-classified as a side request. This pins that
        // the #7572 rescue does NOT leak to auxiliary calls.
        const aux = { model: "fake-a", max_completion_tokens: 64, stream: false, messages: [{ role: "user", content: "generate a title" }] };
        const r = await h.dshSend("pi7", aux, "session-title");
        assert.equal(r.status, 200);
        assert.equal(resolveConversation("pi7").session?.stats.requests ?? 0, 0, "dsh aux call (real purpose) keeps the legacy side demotion");
        const fwd = h.forwarded.at(-1) as { max_completion_tokens?: number };
        assert.equal(fwd.max_completion_tokens, 64, "aux budget forwarded verbatim (no restore) — the rescue is declared-main-only (#7572 negative)");
    } finally {
        await h.close();
    }
});
