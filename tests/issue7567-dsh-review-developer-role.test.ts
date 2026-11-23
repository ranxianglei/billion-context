// #7567: DSH auto-review sidecar carries a `developer`-role message; an
// OpenAI-compatible upstream (Qwen/DashScope gateway) rejects the role with
// 400 `{"code":"invalid_parameter_error","message":"developer is not one of
// ['system', 'assistant', 'user', 'tool', 'function']"}` → every review-gated
// tool call fails before its body runs.
//
// Two facets, both fixed in this PR:
//   (1a) detectRoleRejection did not match this error shape — the offending
//        role name comes FIRST and the word "role" never appears, so the three
//        existing patterns (all keyed on "role") missed it → no auto-rewrite.
//   (1b) the learn-on-failure compat-roles ladder in forwardCaptured only runs
//        on STRING bodies (its compat setup is gated on `typeof body ===
//        "string"`), but the side lane built sideBody as a Buffer → a DSH
//        auto-review sidecar 400'd on an unsupported role was forwarded
//        verbatim with no auto-rewrite, even on the main pipeline path.
//
// This file pins the END-TO-END behavior: an unstamped DSH auto-review sidecar
// (sticky-bound session) with a `developer` carrier, against an upstream that
// rejects `developer` with the Qwen/DashScope 400, is auto-rewritten
// `developer`→`system` and retried successfully — the request the client sent
// is rescued, not forwarded verbatim into a guaranteed 400.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { DSH_AUTO_REVIEW_SYSTEM_PREFIX } from "../src/server/side-request.ts";

const MODEL = "deepseek-flash";

// The fixed REVIEW_POLICY system prompt (version-pinned first line).
const REVIEW_POLICY = `${DSH_AUTO_REVIEW_SYSTEM_PREFIX} in this conversation.\n\nYou must decide whether the pending action is allowed, and reply with exactly one JSON verdict.`;

// The exact Qwen/DashScope rejection for the `developer` role (#7567).
const QWEN_DEVELOPER_400 = JSON.stringify({
    code: "invalid_parameter_error",
    param: null,
    message: "developer is not one of ['system', 'assistant', 'user', 'tool', 'function']",
    type: "invalid_request_error",
});

function reviewBlob(): string {
    return [
        "ENVIRONMENT",
        "profile: web; model: deepseek-v4.1-flash",
        "",
        "PROJECT_INSTRUCTIONS",
        "(none)",
        "",
        "FILTERED_HISTORY",
        "[user] earlier turn A about the harness setup.",
        "",
        "PENDING_ACTION",
        "tool call: write(path=..., content=...)",
    ].join("\n");
}

type Rig = {
    proxyPort: number;
    upstreamPort: number;
    bodies: string[];
    close: () => Promise<void>;
};

async function startRig(): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            // The Qwen/DashScope gateway rejects the `developer` role.
            if (raw.includes('"role":"developer"')) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(QWEN_DEVELOPER_400);
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 120, completion_tokens: 3, total_tokens: 123 },
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
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: 30_000 } } } },
        modelContextLimit: 30_000,
        kernelConfig: defaultConfig(30_000),
        compress: { injectTool: true, injectNudge: true },
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
    return {
        proxyPort: (proxy.address() as { port: number }).port,
        upstreamPort,
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

const chatUrl = (rig: Rig) => `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;

test("#7567: an unstamped DSH auto-review sidecar with a `developer` carrier is auto-rewritten to `system` and retried", async () => {
    const rig = await startRig();
    const conv = "rev7567-developer";
    try {
        // Seed a dsh-bound main turn (binds the session's sticky pluginAgent).
        const seed = {
            model: MODEL,
            messages: [
                { role: "system", content: "You are a coding agent." },
                { role: "user", content: "hello" },
                { role: "assistant", content: "ok" },
            ],
        };
        const r0 = await fetch(chatUrl(rig), {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv },
            body: JSON.stringify(seed),
        });
        assert.equal(r0.status, 200, "seed main turn succeeds");
        await r0.text();
        const s = getSession(conv);
        assert.ok(s, "seed session exists");
        assert.equal(s!.metadata.pluginAgent, "dsh", "session is sticky-bound to dsh");

        // The incident topology: the auto-review sidecar arrives UNSTAMPED (no
        // x-bili-plugin header), keyed to the conversation only through the
        // generic session header, and carries the policy on a `developer`
        // role message (some DSH host builds use it for the system prompt).
        const bodiesBefore = rig.bodies.length;
        const review = {
            model: MODEL,
            messages: [
                { role: "developer", content: REVIEW_POLICY },
                { role: "user", content: reviewBlob() },
            ],
        };
        const r = await fetch(chatUrl(rig), {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": conv },
            body: JSON.stringify(review),
        });
        assert.equal(r.status, 200, "the review request is rescued (auto-rewrite + retry), not forwarded verbatim into a 400");
        await r.text();

        // The upstream saw TWO requests: the original (developer) that 400'd,
        // and the rewritten retry (system) that succeeded.
        const reviewBodies = rig.bodies.slice(bodiesBefore);
        assert.equal(reviewBodies.length, 2, `the proxy retried after the 400 (got ${reviewBodies.length} upstream hit(s))`);
        assert.ok(reviewBodies[0]!.includes('"role":"developer"'), "the first upstream hit carried the original `developer` role");
        assert.ok(!reviewBodies[1]!.includes('"role":"developer"'), "the retry carries no `developer` role");
        assert.ok(reviewBodies[1]!.includes('"role":"system"'), "the retry re-cast the carrier as `system`");
        // The policy text survived the rewrite (only the role changed).
        assert.ok(reviewBodies[1]!.includes(DSH_AUTO_REVIEW_SYSTEM_PREFIX), "the REVIEW_POLICY text is intact on the retry");
    } finally {
        await rig.close();
    }
});
