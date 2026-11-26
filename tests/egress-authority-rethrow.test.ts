// Ruling 7439-5 (PR #7684, C3): a PINNED session whose op-log has no
// healthy point must fail the turn with 500 + `x-bili-egress: unreadable`
// on EVERY wire lane — the openai lane rethrows EgressAuthorityRejectError
// (prepare-openai.ts), but the anthropic / responses / google seams used to
// swallow it in their catch ("kernel transform failed, forwarding
// unchanged") and forward the CLIENT'S bytes to the upstream, which the
// ruling forbids. #7574 covers the openai wire end to end; this test
// covers the three lanes that had the swallowed path.

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

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

test("C3 a pinned session on a damaged log fails with 500 on every wire — the client bytes are never forwarded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-rethrow-c3-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    let store: SessionStore | null = null;
    let srv: http.Server | null = null;
    let upstream: http.Server | null = null;
    const upstreamCalls: string[] = [];
    try {
        setRegistryForTest({});
        store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        upstream = http.createServer((req, res) => {
            req.on("data", () => undefined);
            req.on("end", () => {
                const url = req.url ?? "";
                upstreamCalls.push(url);
                res.writeHead(200, { "content-type": "application/json" });
                if (url.includes(":generateContent")) {
                    res.end(JSON.stringify({
                        candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" }],
                        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
                    }));
                    return;
                }
                if (url.includes("/v1/responses")) {
                    res.end(JSON.stringify({
                        id: "resp_test", object: "response", created_at: 0, model: MODEL, status: "completed",
                        output: [{ id: "msg_out", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
                        usage: { input_tokens: 5, output_tokens: 3 },
                    }));
                    return;
                }
                if (url.includes("/v1/messages")) {
                    res.end(JSON.stringify({
                        id: "msg_test", type: "message", role: "assistant", model: MODEL,
                        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
                        usage: { input_tokens: 5, output_tokens: 3 },
                    }));
                    return;
                }
                res.end(JSON.stringify({
                    id: "chatcmpl-test", object: "chat.completion", model: MODEL,
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
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
        srv = await startServer(opts);
        await listen(srv);
        const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
        const call = async (
            url: string,
            headers: Record<string, string>,
            body: unknown,
        ): Promise<{ status: number; text: string; egressHeader: string | null }> => {
            const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
            const text = await resp.text();
            return { status: resp.status, text, egressHeader: resp.headers.get("x-bili-egress") };
        };
        const settle = async (sessionId: string): Promise<void> => {
            const race = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
            assert.equal(await race(store!.afterNextFlush(sessionId), 10_000), true, "first debounced flush landed");
            assert.equal(await race(store!.afterNextFlush(sessionId), 10_000), true, "second flush settled");
        };
        const dbPath = join(dir, "sessions", "index.db");
        // damage every row of a session in both tables while the server is live
        const corrupt = async (sid: string): Promise<void> => {
            for (let attempt = 1; attempt <= 50; attempt++) {
                const db = new DatabaseSync(dbPath);
                try {
                    db.exec("PRAGMA busy_timeout = 15000");
                    const st = db.prepare("UPDATE egress_state SET payload = ? WHERE session_id = ?").run('{"x":1}', sid);
                    const fl = db.prepare("UPDATE egress_flow SET payload = ? WHERE session_id = ?").run('{"x":1}', sid);
                    if (st.changes > 0 && fl.changes > 0) return;
                } catch (err) {
                    if (attempt === 50) throw err;
                } finally {
                    db.close();
                }
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error(`corrupt(${sid}): never got a live db handle`);
        };

        type LaneDef = {
            name: string;
            url: string;
            turn: (ids: string[]) => unknown;
        };
        const lanes: LaneDef[] = [
            {
                name: "openai",
                url: `${base}/v1/chat/completions`,
                turn: (ids) => ({
                    model: MODEL, stream: false,
                    messages: [
                        { role: "user", content: "q" },
                        { role: "assistant", content: "a" },
                        { role: "user", content: "next" },
                    ],
                    biliMsgIds: ids,
                }),
            },
            {
                name: "anthropic",
                url: `${base}/bili/${llmUrl}/v1/messages`,
                turn: (ids) => ({
                    model: MODEL, max_tokens: 4096, stream: false,
                    messages: [
                        { role: "user", content: "q" },
                        { role: "assistant", content: [{ type: "text", text: "a" }] },
                        { role: "user", content: "next" },
                    ],
                    biliMsgIds: ids,
                }),
            },
            {
                name: "responses",
                url: `${base}/bili/${llmUrl}/v1/responses`,
                turn: (ids) => ({
                    model: MODEL, max_output_tokens: 4096,
                    input: [
                        { role: "user", content: "q" },
                        { role: "assistant", content: [{ type: "output_text", text: "a" }] },
                        { role: "user", content: "next" },
                    ],
                    biliMsgIds: ids,
                }),
            },
            {
                name: "google",
                url: `${base}/bili/${llmUrl}/v1beta/models/${MODEL}:generateContent`,
                turn: (ids) => ({
                    contents: [
                        { role: "user", parts: [{ text: "q" }] },
                        { role: "model", parts: [{ text: "a" }] },
                        { role: "user", parts: [{ text: "next" }] },
                    ],
                    maxOutputTokens: 4096,
                    biliMsgIds: ids,
                }),
            },
        ];

        for (const lane of lanes) {
            const sid = `c3-${lane.name}`;
            const ids = ["host-0", "host-1", "host-2"];
            // 1. bootstrap the pinned session on the openai wire (openai-shaped body)
            const boot = await call(`${base}/v1/chat/completions`,
                { "x-bili-plugin": "opencode", "x-acp-session": sid },
                { model: MODEL, stream: false, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }, { role: "user", content: "next" }], biliMsgIds: ids });
            assert.equal(boot.status, 200, `${lane.name}: bootstrap turn (got ${boot.status}: ${boot.text.slice(0, 200)})`);
            await settle(sid);

            // 2. damage the log, then hit the session on THIS lane
            await corrupt(sid);
            logs.length = 0;
            const before = upstreamCalls.length;
            const t2 = await call(lane.url, { "x-bili-plugin": "opencode", "x-acp-session": sid }, lane.turn(ids));

            // 3. the turn fails loudly, never on the client's bytes
            assert.equal(t2.status, 500, `${lane.name}: damaged authority log must 500 (got ${t2.status}: ${t2.text.slice(0, 200)})`);
            assert.equal(t2.egressHeader, "unreadable", `${lane.name}: the 500 carries x-bili-egress: unreadable`);
            assert.ok(
                logs.some((l) => l.includes(sid) && l.includes("refusing to run on client bytes")),
                `${lane.name}: the rejection is logged (log: ${logs.filter((l) => l.includes(sid)).slice(-4).join(" | ")})`,
            );
            assert.equal(upstreamCalls.length, before, `${lane.name}: the client's bytes were NOT forwarded to the upstream`);
        }
    } finally {
        setLogCapture(null);
        store?.closeQuietly();
        srv?.closeAllConnections?.();
        await new Promise<void>((r) => { if (srv) srv.close(() => r()); else r(); });
        await new Promise<void>((r) => { if (upstream) upstream.close(() => r()); else r(); });
    }
});
