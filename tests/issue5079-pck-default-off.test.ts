import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { startServer } from "../src/server.ts";
import { defaultConfig } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _resetPckProbeForTest } from "../src/pck-probe.ts";
import { resolveRelayAffinityPck } from "../src/session-id.ts";
import type { ConversationIdentity } from "../src/session-id.ts";
import { parsePromptCacheRouting } from "../src/config.ts";
import { resolvePromptCacheKey } from "../src/server/prepare-responses.ts";
import { PCK_NOTICE_ID, dismissedUpgradeNotices, dismissUpgradeNotice, pckNoticeActive } from "../src/pck-notice.ts";
import type { Server } from "node:http";

// #5079: prompt_cache_key self-stamping becomes a parameter and defaults OFF.
// The decision functions are unit-pinned here (both wires + notice state);
// the egress wire is pinned end-to-end with a live proxy below. The
// pre-#5079 stamping behavior under routing auto/enabled stays pinned in
// tests/issue2218-relay-affinity-signal.test.ts (its harness runs routing
// "auto" explicitly).

test("#5079 unit: parsePromptCacheRouting defaults to disabled", () => {
    assert.equal(parsePromptCacheRouting(undefined), "disabled");
    assert.equal(parsePromptCacheRouting(""), "disabled");
    assert.equal(parsePromptCacheRouting("banana"), "disabled");
    assert.equal(parsePromptCacheRouting("auto"), "auto");
    assert.equal(parsePromptCacheRouting("enabled"), "enabled");
    assert.equal(parsePromptCacheRouting("disabled"), "disabled");
});

test("#5079 unit: chat-wire resolveRelayAffinityPck routing gate", () => {
    _resetPckProbeForTest();
    const loop = "http://127.0.0.1:7864/v1";
    // NEW DEFAULT: internal plugin lane, no client key → never stamps
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", undefined, loop, loop, "disabled", "s1"), "drop");
    // pre-#5079 behavior preserved behind the switch
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", undefined, loop, loop, "auto", "s1"), "stamp");
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", undefined, loop, loop, "enabled", "s1"), "stamp");
    // bili's OWN echo (body key === conversation id on the plugin lane) is
    // bili machinery, not client intent: dropped under the new default…
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", "s1", loop, loop, "disabled", "s1"), "drop");
    // …and harmlessly re-stamped under auto (same value either way)
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", "s1", loop, loop, "auto", "s1"), "stamp");
    // a GENUINE client key (≠ session id) passes through even under the
    // new default — the gate only controls bili's own emission
    assert.equal(resolveRelayAffinityPck("x-bili-plugin-conversation", "client-pool-key", loop, loop, "disabled", "s1"), "keep-client");
    assert.equal(resolveRelayAffinityPck(undefined, "client-pool-key", loop, loop, "disabled"), "keep-client");
});

const headerIdentity: ConversationIdentity = { value: "real-session", source: "header", clientProvided: true };
const promotedIdentity: ConversationIdentity = { value: "real-session", source: "prompt-cache-key", clientProvided: true };

test("#5079 unit: responses-wire resolvePromptCacheKey routing gate", () => {
    // explicit body key echoing the bound session id (identity came from a
    // header) = bili's own emission → suppressed by the new default…
    assert.equal(resolvePromptCacheKey("real-session", headerIdentity, "disabled", "https://api.openai.com", "real-session"), undefined);
    // …while auto keeps the pre-#5079 forward behavior
    assert.equal(resolvePromptCacheKey("real-session", headerIdentity, "auto", "https://api.openai.com", "real-session"), "real-session");
    // a promoted identity MEANS the key was the binding — it is client-owned
    // and always forwards, even when its value equals the session id
    assert.equal(resolvePromptCacheKey("real-session", promotedIdentity, "disabled", "https://api.openai.com", "real-session"), "real-session");
    // non-matching explicit values are never bili's
    assert.equal(resolvePromptCacheKey("other-key", headerIdentity, "disabled", "https://api.openai.com", "real-session"), "other-key");
    // injection path: disabled kills it even on api.openai.com (the #5079
    // behavior change), auto keeps the host gate, enabled removes it
    assert.equal(resolvePromptCacheKey(undefined, headerIdentity, "disabled", "https://api.openai.com", "real-session"), undefined);
    assert.equal(resolvePromptCacheKey(undefined, headerIdentity, "auto", "https://api.openai.com", "real-session"), "real-session");
    assert.equal(resolvePromptCacheKey(undefined, headerIdentity, "auto", "https://chatgpt.com", "real-session"), undefined);
    assert.equal(resolvePromptCacheKey(undefined, headerIdentity, "enabled", "https://relay.example.com", "real-session"), "real-session");
    // kernel-minted identities were never injectable
    assert.equal(resolvePromptCacheKey(undefined, { ...headerIdentity, clientProvided: false }, "enabled", "https://relay.example.com"), undefined);
});

test("#5079 unit: upgrade notice state (per-instance dismissal)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pck-notice-"));
    const env = { ...process.env, XDG_STATE_HOME: dir };
    assert.equal(pckNoticeActive("disabled", env), true);
    assert.equal(pckNoticeActive("auto", env), false);
    assert.equal(pckNoticeActive("enabled", env), false);
    // foreign ids are rejected and do not touch this notice's state
    assert.equal(dismissUpgradeNotice("foreign-id", env), false);
    assert.equal(pckNoticeActive("disabled", env), true);
    assert.equal(dismissUpgradeNotice(PCK_NOTICE_ID, env), true);
    assert.equal(dismissUpgradeNotice(PCK_NOTICE_ID, env), true);
    assert.equal(pckNoticeActive("disabled", env), false);
    assert.ok(dismissedUpgradeNotices(env).has(PCK_NOTICE_ID));
    // dismissal persists across readers (the web banner re-reads per overview)
    assert.ok(fs.existsSync(path.join(dir, "billion-context", "upgrade-notices.json")));
});

interface Captured {
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
}

function chatSse(): string {
    return (
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n"
    );
}

async function startHarness(routing: "disabled" | "auto"): Promise<{ proxyPort: number; upstreamPort: number; captured: Captured[]; close(): Promise<void> }> {
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let body: Record<string, unknown> = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
            captured.push({ headers: req.headers, body });
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(chatSse());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy: Server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: routing },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        captured,
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

function pluginLaneHeaders(sid: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": sid };
}

test("#5079 e2e: default-off — plugin lane no longer stamps prompt_cache_key at egress", async () => {
    _resetPckProbeForTest();
    const h = await startHarness("disabled");
    try {
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        const r = await fetch(base, { method: "POST", headers: pluginLaneHeaders("dsh-sid-off"), body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello off" }] }) });
        assert.equal(r.status, 200);
        await r.text();
        const [b] = h.captured;
        // the affinity BODY signal is gone by default…
        assert.equal(b.body.prompt_cache_key, undefined);
        // …but the header identity path (workbuddy hub style relays) is untouched
        assert.equal(b.headers["x-session-id"], "dsh-sid-off");
    } finally {
        await h.close();
    }
});

test("#5079 e2e: default-off — bili's own echoed pck (=== conversation id) is stripped", async () => {
    _resetPckProbeForTest();
    const h = await startHarness("disabled");
    try {
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        const r = await fetch(base, { method: "POST", headers: pluginLaneHeaders("dsh-sid-echo"), body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello echo" }], prompt_cache_key: "dsh-sid-echo" }) });
        assert.equal(r.status, 200);
        await r.text();
        const [b] = h.captured;
        assert.equal(b.body.prompt_cache_key, undefined);
    } finally {
        await h.close();
    }
});

test("#5079 e2e: default-off — a genuine client pck still forwards verbatim", async () => {
    _resetPckProbeForTest();
    const h = await startHarness("disabled");
    try {
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        const r = await fetch(base, { method: "POST", headers: pluginLaneHeaders("dsh-sid-own"), body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello own" }], prompt_cache_key: "client-pool-key" }) });
        assert.equal(r.status, 200);
        await r.text();
        const [b] = h.captured;
        assert.equal(b.body.prompt_cache_key, "client-pool-key");
    } finally {
        await h.close();
    }
});

test("#5079 e2e: routing auto restores the pre-#5079 stamp (positive pair of the default-off rows)", async () => {
    _resetPckProbeForTest();
    const h = await startHarness("auto");
    try {
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        const r = await fetch(base, { method: "POST", headers: pluginLaneHeaders("dsh-sid-auto"), body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello auto" }] }) });
        assert.equal(r.status, 200);
        await r.text();
        const [b] = h.captured;
        assert.equal(b.body.prompt_cache_key, "dsh-sid-auto");
    } finally {
        await h.close();
    }
});
