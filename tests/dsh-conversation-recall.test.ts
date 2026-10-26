/**
 * #4082 negotiated conversation recall — dsh gate wiring stakes.
 *
 * The dsh takeover gate refuses dispatches whose host attribution is missing
 * (#3918: quota/429 retries and model switches run outside the agent scope,
 * so the AsyncLocalStorage initiator is absent and the request goes DIRECT —
 * uncompressed, unguarded, permanently for the session).
 *
 * The recall wiring learns (lane → sid, boundary) on every ATTRIBUTED
 * dispatch in beforeSend, and when the gate later sees an unattributed
 * dispatch whose body history contains a remembered boundary, it claims the
 * request and beforeSend stamps the negotiated conversation header, so the
 * retry rides the plugin lane as the same session.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import test from "node:test";

import {
    __resetConversationRecallForTests,
    conversationRecallStats,
} from "../src/agent/conversation-recall.ts";
import {
    _resetRegisterForTest,
    _settleNativeForTest,
    _stateBeforeSendForTest,
    _stateTakeoverGateForTest,
    _stateToolsReadyForTest,
    apply,
    type PluginContext,
} from "../src/agent/dsh-native.ts";

const POLL_DEADLINE_MS = 15000;

async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

/** Minimal manifest-serving proxy — registration only; no model traffic. */
async function startMockProxy(): Promise<{ origin: string; close: () => void }> {
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                version: "0.1.119",
                tools: { anthropic: [{ name: "compress", description: "Compress a range of messages", input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } }] },
            }));
            return;
        }
        if (url === "/__bili/plugin/session-name") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
        });
    });
}

type HostCtx = ReturnType<typeof makeCtx>;

function makeCtx() {
    let initiator: { session?: { id?: unknown } } | undefined;
    const tools: unknown[] = [];
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    return {
        tools: { register: (t: unknown) => tools.push(t) },
        commands: { register: (_c: unknown) => undefined },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown } } | undefined) => (initiator = i),
        registeredTools: tools,
        on: (event: string, listener: (...a: unknown[]) => void) => {
            (listeners.get(event) ?? listeners.set(event, []).get(event)!).push(listener);
        },
        emit: (event: string, ...args: unknown[]) => { for (const l of listeners.get(event) ?? []) l(...args); },
        inject: (_deps: readonly string[], _cb: (sub: unknown) => void) => undefined,
    };
}

const MODEL_URL = "https://api.anthropic.com/v1/messages";

function bodyOf(messages: Array<{ role: string; content: string }>, model = "claude-x"): string {
    return JSON.stringify({ model, max_tokens: 1024, stream: true, system: "be brief", messages });
}

async function withSetup(fn: (host: HostCtx, proxy: { origin: string }) => Promise<void>): Promise<void> {
    __resetConversationRecallForTests();
    const proxy = await startMockProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-recall-"));
    const saved: Array<[string, string | undefined]> = [];
    for (const key of ["BILLION_CONTEXT_PROXY", "DSH_HOME", "BILI_PROVIDER_REWRITES", "BILI_NATIVE_DSH", "BILLION_CONTEXT_PLUGIN"]) {
        saved.push([key, process.env[key]]);
    }
    process.env.BILLION_CONTEXT_PROXY = proxy.origin;
    process.env.DSH_HOME = home;
    delete process.env.BILI_PROVIDER_REWRITES;
    delete process.env.BILI_NATIVE_DSH;
    delete process.env.BILLION_CONTEXT_PLUGIN;
    _resetRegisterForTest(proxy.origin);
    const ctx = makeCtx();
    apply(ctx as unknown as PluginContext);
    try {
        await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration");
        await fn(ctx, proxy);
    } finally {
        await _settleNativeForTest();
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
}

test("dsh recall: attributed dispatch learns; broken-attribution retry is claimed and stamped", async () => {
    await withSetup(async (ctx) => {
        const beforeSend = _stateBeforeSendForTest();
        const gate = _stateTakeoverGateForTest();
        assert.ok(beforeSend !== undefined && gate !== undefined);

        // Turn 1 — attribution works. beforeSend learns the lane boundary.
        ctx.setInitiator({ session: { id: "sess-alpha" } });
        const authHeaders = { authorization: "Bearer sk-live-1", "content-type": "application/json" };
        const init1: RequestInit = { method: "POST", headers: authHeaders, body: bodyOf([
            { role: "user", content: "investigate the flaky test" },
            { role: "assistant", content: "it is a port race in the harness" },
        ]) };
        await beforeSend(MODEL_URL, init1);
        assert.equal(conversationRecallStats().learned, 1, "attributed dispatch teaches the table");
        assert.equal(await gate(MODEL_URL, { bytes: 400 }), true, "attributed gate still claims");

        // Turn 2 — the host retries from a different execution chain: no
        // initiator. Same history (retry shape), maybe a different model.
        ctx.setInitiator(undefined);
        const init2: RequestInit = { method: "POST", headers: { ...authHeaders }, body: bodyOf([
            { role: "user", content: "investigate the flaky test" },
            { role: "assistant", content: "it is a port race in the harness" },
        ], "claude-y") };
        assert.equal(await gate(MODEL_URL, { bytes: 400 }, init2), true, "negotiated recall claims the retry (#3918 shape)");

        // beforeSend stamps the negotiated conversation header atomically
        // with the body (#3370 discipline) so the proxy binds the same session.
        // The stamp rebuilds init.headers (#3370), so read through a Headers view.
        await beforeSend(MODEL_URL, init2);
        const headers = new Headers(init2.headers);
        assert.equal(headers.get("x-bili-plugin"), "dsh");
        assert.equal(headers.get("x-bili-plugin-conversation"), "sess-alpha");
    });
});

test("dsh recall: routed (settings-overlay) lane — learn on the overlay URL, claim on the unwrapped upstream URL (#4109)", async () => {
    await withSetup(async (ctx, proxy) => {
        const beforeSend = _stateBeforeSendForTest();
        const gate = _stateTakeoverGateForTest();
        assert.ok(beforeSend !== undefined && gate !== undefined);

        // The dsh desktop overlay routes model calls through the local proxy
        // in `/bili/` rewrite form. On that lane native-intercept hands the
        // gate the UNWRAPPED upstream target (routedTarget) but beforeSend
        // the FULL overlay URL — recall must key both as ONE logical lane.
        const overlayUrl = `${proxy.origin}/bili/${MODEL_URL}`;

        // Turn 1 — attribution works; beforeSend sees the overlay URL.
        ctx.setInitiator({ session: { id: "sess-routed" } });
        const authHeaders = { authorization: "Bearer sk-live-3", "content-type": "application/json" };
        const init1: RequestInit = { method: "POST", headers: authHeaders, body: bodyOf([
            { role: "user", content: "triage the desktop overlay report" },
            { role: "assistant", content: "the overlay URL shape is the culprit" },
        ]) };
        await beforeSend(overlayUrl, init1);
        assert.equal(conversationRecallStats().learned, 1, "attributed routed dispatch teaches the table");
        assert.equal(conversationRecallStats().lanes, 1, "overlay form collapses into the upstream lane key, not a second lane (#4109)");

        // Turn 2 — unattributed retry, same history, different model: the
        // gate is called with routedTarget (the upstream URL), exactly as
        // native-intercept.ts does on the routed branch. Before the fix the
        // learn key (overlay) never equaled the claim key (upstream), so the
        // recall never fired on the flagship lane.
        ctx.setInitiator(undefined);
        const init2: RequestInit = { method: "POST", headers: { ...authHeaders }, body: bodyOf([
            { role: "user", content: "triage the desktop overlay report" },
            { role: "assistant", content: "the overlay URL shape is the culprit" },
        ], "claude-y") };
        assert.equal(await gate(MODEL_URL, { bytes: 400 }, init2), true, "negotiated recall claims the routed retry — one lane key for raw and routed (#4109)");

        // beforeSend sees the overlay URL again and stamps the negotiated
        // conversation header atomically with the body (#3370 discipline).
        await beforeSend(overlayUrl, init2);
        const headers = new Headers(init2.headers);
        assert.equal(headers.get("x-bili-plugin"), "dsh");
        assert.equal(headers.get("x-bili-plugin-conversation"), "sess-routed");
    });
});

test("dsh recall: a different logical lane is never claimed, raw or routed", async () => {
    await withSetup(async (ctx, proxy) => {
        const beforeSend = _stateBeforeSendForTest();
        const gate = _stateTakeoverGateForTest();
        assert.ok(beforeSend !== undefined && gate !== undefined);

        // Learn on the anthropic lane (overlay form — collapses to the same
        // key as the raw lane after #4109).
        ctx.setInitiator({ session: { id: "sess-lane-a" } });
        const init1: RequestInit = { method: "POST", headers: { authorization: "Bearer sk-live-4" }, body: bodyOf([
            { role: "user", content: "shared opening question" },
            { role: "assistant", content: "shared answer closes the parent turn" },
        ]) };
        await beforeSend(`${proxy.origin}/bili/${MODEL_URL}`, init1);

        // An unattributed dispatch on a DIFFERENT logical lane (another
        // provider endpoint) carries the identical history — the lane is the
        // search namespace, so no evidence, no claim, refusal stands.
        ctx.setInitiator(undefined);
        const otherLaneUrl = "https://api.openai.com/v1/chat/completions";
        const init2: RequestInit = { method: "POST", headers: { authorization: "Bearer sk-live-4" }, body: bodyOf([
            { role: "user", content: "shared opening question" },
            { role: "assistant", content: "shared answer closes the parent turn" },
        ]) };
        assert.equal(await gate(otherLaneUrl, { bytes: 400 }, init2), false, "history evidence never crosses lanes");
        await beforeSend(otherLaneUrl, init2);
        const headers = new Headers(init2.headers);
        assert.equal(headers.get("x-bili-plugin"), null);
        assert.equal(headers.get("x-bili-plugin-conversation"), null);
    });
});

test("dsh recall: fork-shaped divergence is NOT claimed — direct behavior preserved", async () => {
    await withSetup(async (ctx) => {
        const beforeSend = _stateBeforeSendForTest();
        const gate = _stateTakeoverGateForTest();
        assert.ok(beforeSend !== undefined && gate !== undefined);

        ctx.setInitiator({ session: { id: "sess-beta" } });
        const init1: RequestInit = { method: "POST", headers: { authorization: "Bearer sk-live-2" }, body: bodyOf([
            { role: "user", content: "shared opening question" },
            { role: "assistant", content: "shared answer closes the parent turn" },
        ]) };
        await beforeSend(MODEL_URL, init1);

        // A fork replays the shared PREFIX but diverges before the parent's
        // latest boundary — no claim, no stamp, today's refusal stands.
        ctx.setInitiator(undefined);
        const init2: RequestInit = { method: "POST", headers: { authorization: "Bearer sk-live-2" }, body: bodyOf([
            { role: "user", content: "shared opening question" },
            { role: "user", content: "fork: take a completely different approach" },
        ]) };
        assert.equal(await gate(MODEL_URL, { bytes: 400 }, init2), false, "no boundary evidence — gate refuses as today");
        await beforeSend(MODEL_URL, init2);
        const headers = new Headers(init2.headers);
        assert.equal(headers.get("x-bili-plugin"), null, "no marker stamped without evidence");
        assert.equal(headers.get("x-bili-plugin-conversation"), null, "never stamped without evidence");
    });
});

test("dsh recall #4110: content:null tool-call boundary never adopts another session's retry", async () => {
    await withSetup(async (ctx) => {
        const beforeSend = _stateBeforeSendForTest();
        const gate = _stateTakeoverGateForTest();
        assert.ok(beforeSend !== undefined && gate !== undefined);

        const toolCallBody = (callId: string, userText: string): string => JSON.stringify({
            model: "gpt-x",
            max_tokens: 1024,
            stream: true,
            messages: [
                { role: "user", content: userText },
                { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "get_weather", arguments: "{\"city\":\"sf\"}" } }] },
            ],
        });

        // Session A, attribution ok: the boundary is a PURE TOOL-CALL turn
        // (content:null + tool_calls — the #4110 degenerate class pre-fix).
        ctx.setInitiator({ session: { id: "sess-alpha" } });
        const authHeaders = { authorization: "Bearer sk-live-3", "content-type": "application/json" };
        await beforeSend(MODEL_URL, { method: "POST", headers: authHeaders, body: toolCallBody("call_A1", "session A: investigate the flaky test") });
        assert.equal(conversationRecallStats().learned, 1, "tool-call boundary carries evidence and is learned");

        // Session B, attribution lost: its retry history contains its OWN
        // same-class tool-call turn. Pre-#4110 both fingerprinted identically
        // (content:null, tool_calls ignored) ⇒ B adopted into A. Now refused.
        ctx.setInitiator(undefined);
        const initB: RequestInit = { method: "POST", headers: { ...authHeaders }, body: toolCallBody("call_B1", "session B: write the release notes") };
        assert.equal(await gate(MODEL_URL, { bytes: 400 }, initB), false, "same-class message from another session is not evidence — gate refuses");
        await beforeSend(MODEL_URL, initB);
        const headersB = new Headers(initB.headers);
        assert.equal(headersB.get("x-bili-plugin"), null, "no marker stamped for a foreign session's retry");
        assert.equal(headersB.get("x-bili-plugin-conversation"), null, "no cross-session stamp");

        // Positive control on the same lane: A's OWN retry resends its
        // byte-identical tool-call history — still claimed and stamped, the
        // recall bridge is not disabled for tool-call turns.
        const initA: RequestInit = { method: "POST", headers: { ...authHeaders }, body: toolCallBody("call_A1", "session A: investigate the flaky test") };
        assert.equal(await gate(MODEL_URL, { bytes: 400 }, initA), true, "byte-identical resend of the learned boundary is claimed");
        await beforeSend(MODEL_URL, initA);
        const headersA = new Headers(initA.headers);
        assert.equal(headersA.get("x-bili-plugin"), "dsh");
        assert.equal(headersA.get("x-bili-plugin-conversation"), "sess-alpha");
    });
});

test("dsh recall #4110: all-degenerate history is not learned", async () => {
    await withSetup(async (ctx) => {
        const beforeSend = _stateBeforeSendForTest();
        assert.ok(beforeSend !== undefined);

        // A dispatch whose every message lacks content AND tool_calls proves
        // nothing — no boundary exists, nothing enters the table (#4110).
        ctx.setInitiator({ session: { id: "sess-gamma" } });
        const body = JSON.stringify({ model: "gpt-x", max_tokens: 1024, stream: true, messages: [
            { role: "user", content: "" },
            { role: "assistant", content: null },
        ] });
        await beforeSend(MODEL_URL, { method: "POST", headers: { authorization: "Bearer sk-live-4" }, body });
        assert.equal(conversationRecallStats().learned, 0, "degenerate boundary is not learned");
    });
});
