// #7398 seg 4b: egress serve-from-log — when rollout egressServeLog is on the
// outbound conversation elements come from the op-log + unified content CAS
// (rebuildOutboundFromLog) instead of the legacy re-conversion, and are
// byte-identical to the legacy bytes by construction. Degrade direction
// (#3617): a view that cannot be rebuilt (tool rows in v1) stays on the
// legacy path for the whole turn — never a partial serve.
//
// Method: one server, two sessions with IDENTICAL message sequences. Session A
// runs with the rollouts off (control = legacy). Session B runs with
// egressOpLog+egressServeLog on (served). The fake upstream captures every
// request body; A[n] and B[n] must be byte-identical, and B's log must show
// "egress-serve: served" (text scenario) or its absence (tool scenario).

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
    sessionHeader: string,
    script: Array<{ messages: unknown[] }>,
    captured: string[],
): Promise<void> {
    const ctrl = new AbortController();
    try {
        for (const turn of script) {
            const res = await fetch(`${base}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: "Bearer k", [sessionHeader]: "serve-e2e" },
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

test("egress serve-from-log: served bytes == legacy bytes; tool rows fall back (#7398 seg 4b)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-serve-e2e-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_EGRESS_OP_LOG = "1";
    const savedServe = process.env.BILI_ROLLOUT_EGRESS_SERVE_LOG;
    delete process.env.BILI_ROLLOUT_EGRESS_SERVE_LOG;
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
        process.env.BILI_ROLLOUT_EGRESS_SERVE_LOG = "1";
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
        assert.ok(textBLogs.some((l) => l.includes("egress-serve: served")), "text session must be served from the op-log at least on a steady turn");
        for (let i = 0; i < toolScript.length; i++) {
            const a = JSON.parse(ctrlAT[i]);
            const b = JSON.parse(servedT[i]);
            assert.deepEqual(b.messages, a.messages, `tool turn ${i + 1}: fallback bytes must equal legacy bytes`);
        }
        // Degrade direction: the tool scenario must NEVER log a served turn
        // (v1 scope: tool rows are not in the log metadata).
        assert.ok(!logs.some((l) => l.includes("egress-serve: served") && l.includes("serve-e2e-tool")), "tool session must stay legacy (no served line)");

        srv.closeAllConnections?.();
        await new Promise((r) => srv.close(() => r(undefined)));
        upstream.closeAllConnections?.();
        await new Promise((r) => upstream.close(() => r(undefined)));
        store.closeQuietly();
    } finally {
        if (savedServe === undefined) delete process.env.BILI_ROLLOUT_EGRESS_SERVE_LOG;
        else process.env.BILI_ROLLOUT_EGRESS_SERVE_LOG = savedServe;
        setLogCapture(null);
    }
});
