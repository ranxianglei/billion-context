// #1307: auxiliary requests (auto-review / risk classifiers) ride the main
// session key WITHOUT a tiny output budget, so the #388 ≤200 heuristic cannot
// see them. They walk the full pipeline with a 1-2 message synthetic view, and
// the post-forward rememberPluginMessages() used to evict the remembered
// snapshot with that view — so every subsequent plugin-path compress found its
// refs dangling ("Requested range(s) cannot be anchored") and long sessions
// lost compression entirely (issue: 163/163 failures with ctx==1 message).
// The fix guards the WRITE POINT: a side-shaped view (≤2 messages) never
// evicts a richer remembered snapshot. This test pins the guard and the
// end-to-end outcome (compress still anchors after a review-shaped request).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { _rememberedForTest, _resetPluginStateForTest, rememberPluginMessages } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "claude-sonnet-4-5";

test("rememberPluginMessages: a zero-overlap smaller view never evicts the snapshot (#1307)", () => {
    _resetPluginStateForTest();
    const msg = (id: string, text: string) => ({ id, role: "user", contentType: "text", text }) as const;
    const mainView = Array.from({ length: 8 }, (_, i) => msg(`raw-${i}`, `main ${i}`));
    // Fresh session: a 1-message view writes (no previous snapshot to protect).
    rememberPluginMessages("iso-a", [msg("r0", "first")], [msg("r0", "first")]);
    assert.equal(_rememberedForTest().get("iso-a")?.processed.length, 1);
    // First real main turn (8 messages, larger than the 1-msg snapshot — grow
    // direction always writes; note: zero id overlap here, that is the point).
    rememberPluginMessages("iso-a", mainView, mainView);
    assert.equal(_rememberedForTest().get("iso-a")?.processed.length, 8);
    // 1-message auxiliary shape (auto-review): zero overlap, smaller → kept.
    rememberPluginMessages("iso-a", [msg("rev", "flattened transcript")], [msg("rev", "flattened transcript")]);
    assert.equal(_rememberedForTest().get("iso-a")?.processed.length, 8, "main snapshot survives the side-shaped write");
    // 3-message auxiliary shape (few-shot review prompt): a SIZE guard (≤2)
    // would let this through — identity overlap must not. Zero overlap + smaller → kept.
    rememberPluginMessages("iso-a", [msg("fs-s", "policy"), msg("fs-x", "example"), msg("fs-u", "transcript")], [msg("fs-s", "policy"), msg("fs-x", "example"), msg("fs-u", "transcript")]);
    assert.equal(_rememberedForTest().get("iso-a")?.processed.length, 8, "3-message zero-overlap auxiliary shape is still refused (count is a proxy, identity is not)");
    // Empty views (side passthrough prepared) never clobber either.
    rememberPluginMessages("iso-a", [], []);
    assert.equal(_rememberedForTest().get("iso-a")?.processed.length, 8);
    // A genuinely LARGER zero-overlap view writes: a real restart on the same
    // session id must be able to take over (guard is shrink-direction only).
    const restart = Array.from({ length: 10 }, (_, i) => msg(`new-${i}`, `restart ${i}`));
    rememberPluginMessages("iso-a", restart, restart);
    assert.equal(_rememberedForTest().get("iso-a")?.processed.length, 10);
    // A SMALLER view that OVERLAPS the snapshot is a continuation (client
    // trimmed some old messages and resent the rest) — it MUST write; refusing
    // here would freeze the snapshot against genuine history edits.
    const trimmed = restart.slice(2);
    rememberPluginMessages("iso-a", trimmed, trimmed);
    assert.equal(_rememberedForTest().get("iso-a")?.processed.length, 8, "overlapping smaller view writes (continuation, not auxiliary)");
    // Same-size zero-overlap refresh writes (not a shrink).
    rememberPluginMessages("iso-c", [msg("c0", "a")], [msg("c0", "a")]);
    rememberPluginMessages("iso-c", [msg("c1", "b")], [msg("c1", "b")]);
    assert.equal(_rememberedForTest().get("iso-c")?.processed.length, 1, "same-size refresh replaces (not a shrink)");
    // A fresh session's small view still writes when nothing richer exists.
    rememberPluginMessages("iso-b", [msg("b0", "solo")], [msg("b0", "solo")]);
    assert.equal(_rememberedForTest().get("iso-b")?.processed.length, 1);
    _resetPluginStateForTest();
});

type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server };

async function startRig(): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
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
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port as number;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
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
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxyPort: proxy.address().port as number, upstreamPort, proxy, upstream };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

const CONV = "iso1307-conv";

test("e2e plugin lane: review-shaped request keeps the snapshot; compress still anchors (#1307)", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "test-agent", "x-acp-session": CONV };
        const tools = [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: {} } } }];

        // Phase 1 — main turn: 12 × ~6k-char messages + tools → refs assigned,
        // remembered snapshot set to the main view.
        const mainMsgs = Array.from({ length: 12 }, (_, i): { role: string; content: string } => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `main-${i + 1}-` + "z".repeat(6000),
        }));
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools, messages: mainMsgs }) });
        assert.equal(r1.status, 200);
        await r1.text();
        const s1 = getSession(CONV);
        assert.ok(s1, "session exists after the main turn");
        assert.ok(Object.keys(s1.state.messageRefs.byRaw).length >= 12, "refs assigned to the main history");
        assert.ok((_rememberedForTest().get(CONV)?.processed.length ?? 0) >= 12, "remembered snapshot holds the main view");

        // Phase 2 — the auto-review shape: SAME session key, NO tools, a
        // NORMAL output budget (the layer stack fills one in upstream of the
        // wire), and a synthetic system+user pair. Pre-#1307 this evicted the
        // remembered snapshot with the 1-message view.
        const review = {
            model: MODEL,
            max_tokens: 384_000,
            messages: [
                { role: "system", content: "You are a code-review risk classifier." },
                { role: "user", content: "Conversation transcript (flattened):\nuser: build the thing\nassistant: ok, building\n... Decide: risky?" },
            ],
        };
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify(review) });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.ok((_rememberedForTest().get(CONV)?.processed.length ?? 0) >= 12, "the main snapshot survived the review-shaped request (#1307 guard)");

        // Phase 3 — plugin-path compress against the SURVIVING snapshot: the
        // refs it cites must anchor instead of reporting dangling ranges.
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: CONV,
                tool: "compress",
                args: { content: [{ startId: "m00001", endId: "m00006", summary: "The user and assistant set up the task and worked through the initial build steps in detail." }] },
            }),
        });
        const toolJson = JSON.parse(await toolRes.text()) as { ok: boolean; result?: string; error?: string };
        assert.ok(toolJson.ok, `compress via plugin tool API failed: ${JSON.stringify(toolJson)}`);
        assert.match(toolJson.result ?? "", /Compressed m00001/, "compress anchored against the main snapshot");
        assert.doesNotMatch(toolJson.result ?? "", /cannot be anchored/, "no dangling-ref failure");
    } finally {
        await closeRig(rig);
    }
});
