// #5825/#4491 parity: the OPENAI wire pins message identity to client-supplied
// ids exactly like the anthropic twin — biliMsgIds stripped from the real
// upstream always, pinned onto canonical rows only while
// BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY is on. Full-resend route
// (/v1/chat/completions) end-to-end against a fake upstream + sqlite rows.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

const MODEL = "gpt-test";
const ROLLOUT_ENV = "BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}
function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface Captured { url: string; body: string }

const turnBody = (conv: string) => ({
    model: MODEL,
    stream: false,
    messages: [
        { role: "user", content: `question-one ${conv}` },
        { role: "assistant", content: `answer-one ${conv}` },
        { role: "user", content: `question-two ${conv}` },
    ],
    // #4491 channel under test (host-stamped body field).
    biliMsgIds: ["open-u-1", "open-a-1", "open-u-2"],
});

test("openai wire: biliMsgIds never reach the upstream; rows carry client ids only while rollout is on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openai-msgid-pin-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const savedRollout = process.env[ROLLOUT_ENV];
    process.env[ROLLOUT_ENV] = "1";
    try {
        setLogCapture(null);
        setRegistryForTest({});
        const store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        const captured: Captured[] = [];
        const upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                captured.push({ url: req.url ?? "", body });
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
            compress: { injectTool: true, injectNudge: false },
            promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: false, debug: false, passthrough: false, autoUpdate: false,
            compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
            autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        const srv = await startServer(opts);
        await listen(srv);
        try {
            const proxyPort = (srv.address() as { port: number }).port;
            const post = async (conv: string) => {
                const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-acp-session": conv },
                    body: JSON.stringify(turnBody(conv)),
                });
                assert.equal(resp.status, 200, `${conv}: expected 200`);
                await resp.text();
            };
            const settle = async (sid: string) => {
                // Two drains: the lane-flow race notes (#5644/#5791) apply to
                // every debounced-save reader, not just the incremental lane.
                const ok = await store.afterNextFlush(sid);
                assert.ok(ok, `${sid}: first debounced flush landed`);
                assert.ok(await store.afterNextFlush(sid), `${sid}: second flush settled`);
            };
            const rows = (prefix: string) => {
                const db = new DatabaseSync(join(dir, "sessions", "index.db"), { readOnly: true });
                try {
                    const stmt = db.prepare("SELECT seq, msg_id FROM messages WHERE session_id = ? ORDER BY seq");
                    return (stmt.all(prefix) as unknown as { seq: number; msg_id: string }[]).map((r) => r.msg_id);
                } finally {
                    db.close();
                }
            };
            const forwardedOf = (marker: string) =>
                captured.find((c) => c.body.includes(marker))?.body ?? new Error(`no upstream capture contains ${JSON.stringify(marker)}`).message;

            // Turn A: rollout ON — pin carries client ids into rows.
            await post("conv-openai-pin");
            const bodyA = JSON.parse(forwardedOf("question-two conv-openai-pin")) as Record<string, unknown>;
            assert.equal(bodyA.biliMsgIds, undefined, "upstream must never see the bili-namespaced field");
            await settle("conv-openai-pin");
            const idsA = rows("conv-openai-pin");
            assert.deepEqual(idsA.sort(), ["open-a-1", "open-u-1", "open-u-2"].sort(), "rows carry the CLIENT ids (pin)");

            // Turn B: rollout OFF — same channel, stripped, NOT pinned.
            delete process.env[ROLLOUT_ENV];
            await post("conv-openai-nopin");
            const bodyB = JSON.parse(forwardedOf("question-two conv-openai-nopin")) as Record<string, unknown>;
            assert.equal(bodyB.biliMsgIds, undefined, "strip is unconditional even when rollout is off");
            await settle("conv-openai-nopin");
            const idsB = rows("conv-openai-nopin");
            assert.equal(idsB.length >= 3, true, "history rows were ingested anyway");
            assert.ok(!idsB.some((id) => id.startsWith("open-")), `client ids must NOT land while rollout is off: ${JSON.stringify(idsB)}`);
        } finally {
            srv.closeAllConnections?.();
            await close(srv);
            store.closeQuietly();
            await close(upstream);
        }
    } finally {
        if (savedRollout === undefined) delete process.env[ROLLOUT_ENV];
        else process.env[ROLLOUT_ENV] = savedRollout;
    }
});
