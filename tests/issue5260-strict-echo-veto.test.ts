import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.js";
import { isStrictReasoningEcho } from "../src/server.js";
import { isReasoningEchoForbiddenReject } from "../src/strict-echo.js";
import { startFakeUpstream } from "./wire-contract-fakes.ts";

// #5260: Mistral serving a deepseek-named model (pi plugin-native, bili 0.1.209).
// The static /deepseek/i detection (#1027) makes bili inject a blank
// reasoning_content on every assistant tool-call message; Mistral's schema
// forbids the field entirely and answers 422 extra_forbidden on every
// tool-call turn — permanently, because nothing ever learned the gateway
// rejects the field. Fix: learn-on-failure VETO — a 4xx that names the echo
// field AND rejects it as extra turns strict echo off for the session
// (mirroring the #684/#762 positive learning in the opposite direction).
// Ledger: WC-023 (tests/wire-contract-fakes.ts), enforced here through the
// mistral-lane validation-parity fake.

function fakeSession(over: Record<string, unknown> = {}): Session {
    return {
        id: "s1",
        meta: {},
        state: createInitialState(),
        stats: { requests: 0 },
        metadata: { ...over },
    } as unknown as Session;
}

const MISTRAL_422 = JSON.stringify({
    detail: [{ type: "extra_forbidden", loc: ["body", "messages", 5, "assistant", "reasoning_content"], msg: "Extra inputs are not permitted", input: "" }],
});

const DEEPSEEK_DEMAND_400 = JSON.stringify({
    error: { code: 11155, message: "The 'reasoning_content' in the thinking mode must be passed back to the API" },
});

test("#5260: isReasoningEchoForbiddenReject — the exact Mistral shape vetoes", () => {
    assert.equal(isReasoningEchoForbiddenReject(422, MISTRAL_422), true);
    // OpenAI-style wording for the same class of rejection.
    assert.equal(isReasoningEchoForbiddenReject(422, JSON.stringify({ error: { message: "Unrecognized request argument supplied: reasoning_content" } })), true);
    assert.equal(isReasoningEchoForbiddenReject(400, JSON.stringify({ error: { message: "Unknown field: reasoning_text" } })), true);
});

test("#5260: demand-class and unrelated rejections never veto", () => {
    // DeepSeek's own 400 DEMANDS the field be echoed back — the opposite evidence class.
    assert.equal(isReasoningEchoForbiddenReject(400, DEEPSEEK_DEMAND_400), false);
    // Field named but no extra-marker wording.
    assert.equal(isReasoningEchoForbiddenReject(400, JSON.stringify({ error: { message: "reasoning_content is invalid for this model" } })), false);
    // Extra-marker wording but no echo-field mention.
    assert.equal(isReasoningEchoForbiddenReject(422, JSON.stringify({ detail: [{ type: "extra_forbidden", loc: ["body", "foo"], msg: "Extra inputs are not permitted", input: "" }] })), false);
    // Non-4xx statuses never veto.
    assert.equal(isReasoningEchoForbiddenReject(200, MISTRAL_422), false);
    assert.equal(isReasoningEchoForbiddenReject(500, MISTRAL_422), false);
});

test("#5260: the veto outranks both learned and static evidence", () => {
    // Static detection alone still matches (regression guard for #1027).
    assert.equal(isStrictReasoningEcho(fakeSession(), "https://api.mistral.ai", "deepseek-v4-1-flash-1017"), true);
    // Learned flag alone still wins (regression guard for #684/#762).
    assert.equal(isStrictReasoningEcho(fakeSession({ strictReasoningEcho: true }), "https://openrouter.ai"), true);
    // Veto beats the static match — the reporter's exact case.
    assert.equal(isStrictReasoningEcho(fakeSession({ strictReasoningEchoVeto: true }), "https://api.mistral.ai", "deepseek-v4-1-flash-1017"), false);
    // Veto beats the learned flag too.
    assert.equal(isStrictReasoningEcho(fakeSession({ strictReasoningEcho: true, strictReasoningEchoVeto: true }), "https://api.deepseek.com"), false);
});

interface Captured {
    level: string;
    msg: string;
}

// The follow-up request carrying the first tool call — the exact failure point
// of the report. One assistant tool-call message, lacking the echo field.
const CLIENT_MESSAGES = [
    { role: "user", content: "what is the weather" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: "{\"q\":\"weather\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "sunny" },
];

test("#5260: main-path e2e — one 422 vetoes strict echo, the next request goes out clean", async () => {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const fake = await startFakeUpstream("openai-chat", { lane: "mistral" });
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: fake.url,
        routes: {
            [fake.url]: { models: { "deepseek-v4-1-flash-1017": { context: 1_048_576 } } },
        },
        modelContextLimit: 1_048_576,
        kernelConfig: defaultConfig(1_048_576),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        chainContentDetection: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const post = () => fetch(`http://127.0.0.1:${proxyPort}/bili/${fake.url}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "re5260-1" },
            body: JSON.stringify({ model: "deepseek-v4-1-flash-1017", messages: CLIENT_MESSAGES }),
        });

        // Request 1: static detection (#1027) injects the blank echo — the fake,
        // enforcing Mistral's schema, rejects it exactly like api.mistral.ai did.
        const resp1 = await post();
        assert.equal(resp1.status, 422);
        const err1 = JSON.parse(await resp1.text()) as { detail?: Array<{ type?: string; msg?: string }> };
        assert.equal(err1.detail?.[0]?.type, "extra_forbidden");
        assert.ok(err1.detail?.[0]?.msg?.includes("reasoning_content"), "relayed 422 names the rejected field");

        assert.equal(fake.violations.length, 1, `expected exactly one WC-023 violation, got: ${fake.violations.join(" | ")}`);
        assert.match(fake.violations[0]!, /WC-023/);
        const first = fake.requests[0]!.body as { messages: Record<string, unknown>[] };
        const firstTc = first.messages.find((m) => Array.isArray(m.tool_calls));
        assert.ok(firstTc, "first forwarded body carries the tool-call message");
        assert.equal(firstTc!.reasoning_content, "", "request 1 shows the static-detection injection");

        const vetoed = captured.find((c) => c.level === "warn" && c.msg.includes("vetoed strictReasoningEcho"));
        assert.ok(vetoed, `expected the veto learn-on-failure log, got: ${captured.map((c) => c.msg).join(" | ")}`);

        // Request 2 (same session): the veto holds — no injection, clean accept.
        const resp2 = await post();
        assert.equal(resp2.status, 200);
        await resp2.text();

        assert.equal(fake.violations.length, 1, "the second request must NOT re-violate the Mistral schema");
        const second = fake.requests[1]!.body as { messages: Record<string, unknown>[] };
        const secondTc = second.messages.find((m) => Array.isArray(m.tool_calls));
        assert.ok(secondTc, "second forwarded body carries the tool-call message");
        assert.ok(!("reasoning_content" in secondTc!), "second forwarded body is free of the forbidden field");

        const injections = captured.filter((c) => c.msg.includes("injected blank reasoning_content"));
        assert.equal(injections.length, 1, `exactly one injection (request 1), got: ${injections.map((c) => c.msg).join(" | ")}`);
    } finally {
        await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
        await fake.close();
        setLogCapture(null);
    }
});
