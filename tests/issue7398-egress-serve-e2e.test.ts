// #7398 seg 4b: egress serve-from-log — when rollout egressPlane is on the
// outbound conversation elements come from the op-log (rebuildOutboundFromLog,
// self-contained bytes per #7439 ruling 1) instead of the legacy re-conversion,
// and are byte-identical to the legacy bytes by construction. Direction asserts
// (#3617): the served sessions (text AND tool — tool rows ride the row bytes)
// log "egress-serve: served"; the rollout-off controls never do.
//
// Method: one server, two sessions with IDENTICAL message sequences. Session A
// runs with the rollouts off (control = legacy). Session B runs with
// egressPlane on (served). The fake upstream captures every
// request body; A[n] and B[n] must be byte-identical, and B's log must show
// "egress-serve: served" lines scoped to the served sessions (both scenarios
// serve now — tool rows ride the row bytes); the -A controls never do.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

const MODEL = "gpt-test";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

const msg = (role: "user" | "assistant", i: number) =>
    ({ role, content: `${role}-message-${i} ${"x".repeat(64)}-${i}` });

function buildBody(history: unknown[]): string {
    return JSON.stringify({ model: MODEL, stream: false, messages: history });
}

async function runSession(
    base: string,
    sessionName: string,
    script: Array<{ messages: unknown[] }>,
    captured: string[],
): Promise<void> {
    const ctrl = new AbortController();
    try {
        for (const turn of script) {
            const res = await fetch(`${base}/v1/chat/completions`, {
                method: "POST",
                // The server only honors opts.sessionHeader ("x-acp-session");
                // send the session NAME as its value so session.id (and every
                // egress-serve log line) carries it for the direction asserts.
                headers: { "content-type": "application/json", authorization: "Bearer k", "x-acp-session": sessionName },
                body: buildBody(turn.messages),
                signal: ctrl.signal,
            });
            const t = await res.text();
            assert.equal(res.status, 200, `turn failed: ${res.status} ${t.slice(0, 200)}`);
            captured.push(t);
        }
    } finally {
        ctrl.abort();
    }
}

test("egress serve-from-log: served bytes == legacy bytes, text and tool alike (#7398 seg 4b)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-serve-e2e-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const savedPlane = process.env.BILI_ROLLOUT_EGRESS_PLANE;
    // Session A is the "rollouts off — pure legacy control" arm. GA
    // (2026-11-24): "unset" resolves ON, so the control forces "0"
    // explicitly (env wins over the 100 default).
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    try {
        setRegistryForTest({});
        const store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        const seenBodies: string[] = [];
        const upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                seenBodies.push(Buffer.concat(chunks).toString("utf8"));
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "chatcmpl-test", object: "chat.completion", model: MODEL,
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                }));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: llmUrl,
            routes: { [llmUrl]: { models: { [MODEL]: { context: 400_000 } } } },
            modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: true, debug: true, passthrough: false, autoUpdate: false,
            compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
            autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        const srv = await startServer(opts);
        await listen(srv);
        const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

        const textScript = [
            { messages: [msg("user", 1), msg("assistant", 2)] },
            { messages: [msg("user", 1), msg("assistant", 2), msg("user", 3), msg("assistant", 4)] },
            { messages: [msg("user", 1), msg("assistant", 2), msg("user", 3), msg("assistant", 4), msg("user", 5)] },
        ];
        const toolScript = [
            { messages: [msg("user", 1)] },
            {
                messages: [
                    msg("user", 1),
                    { role: "assistant", content: null, tool_calls: [{ id: "call_t1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }] },
                    { role: "tool", tool_call_id: "call_t1", content: "result-1" },
                ],
            },
        ];

        // Session A: rollouts off — pure legacy control.
        const ctrlA: string[] = [];
        await runSession(base, "serve-e2e-text-A", textScript, ctrlA);
        const ctrlAT: string[] = [];
        await runSession(base, "serve-e2e-tool-A", toolScript, ctrlAT);

        // Session B: serve on — same sequences must produce identical upstream bytes.
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
        const serveB: string[] = [];
        await runSession(base, "serve-e2e-text-B", textScript, serveB);
        const servedT: string[] = [];
        await runSession(base, "serve-e2e-tool-B", toolScript, servedT);

        assert.equal(serveB.length, 3);
        for (let i = 0; i < textScript.length; i++) {
            const a = JSON.parse(ctrlA[i]);
            const b = JSON.parse(serveB[i]);
            assert.deepEqual(b.messages, a.messages, `text turn ${i + 1}: served bytes must equal legacy bytes`);
        }
        const textBLogs = logs.filter((l) => l.includes("egress-serve"));
        assert.ok(textBLogs.some((l) => l.includes("egress-serve: served") && l.includes("serve-e2e-text-B")), "text session B must be served from the op-log at least on a steady turn");
        assert.ok(!logs.some((l) => l.includes("egress-serve: served") && (l.includes("serve-e2e-text-A") || l.includes("serve-e2e-tool-A"))), "control sessions (rollouts off) must never be served");
        for (let i = 0; i < toolScript.length; i++) {
            const a = JSON.parse(ctrlAT[i]);
            const b = JSON.parse(servedT[i]);
            assert.deepEqual(b.messages, a.messages, `tool turn ${i + 1}: served bytes must equal legacy bytes`);
        }
        // Both directions (#3617): the tool session IS served now (the CAS
        // body carries the toolCallId/toolName sidecars) and byte-identical.
        assert.ok(logs.some((l) => l.includes("egress-serve: served") && l.includes("serve-e2e-tool-B")), "tool session B must be served from the op-log too");

        srv.closeAllConnections?.();
        await new Promise((r) => srv.close(() => r(undefined)));
        upstream.closeAllConnections?.();
        await new Promise((r) => upstream.close(() => r(undefined)));
        store.closeQuietly();
    } finally {
        if (savedPlane === undefined) delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
        else process.env.BILI_ROLLOUT_EGRESS_PLANE = savedPlane;
        setLogCapture(null);
    }
});
