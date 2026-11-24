// #7366 (PR #6785 family): on a watermark-HIT turn in a pinned (2x2)
// session, the rows written for the NEW tail messages must carry the
// CLIENT-DECLARED host msgids — not the content-hash ids minted when the
// tail fragment is re-converted by openaiToCore. Pre-fix, snapshotMessages
// took wpHit.windowCores (fresh h_… ids) and ingest (INSERT OR IGNORE on
// (session_id, seq) — msg_id write-once) wrote h_… into the ledger for
// every post-seed row. The next turn's KDD#22 tail-overlap check then
// compared declared host ids against h_… rows → guaranteed drift → the
// session was locked into permanent full/incremental alternation and the
// tail-only steady state was unreachable.

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
function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const msg = (role: "user" | "assistant", i: number) =>
    ({ role, content: `${role}-message-${i} ${"x".repeat(64)}-${i}` });

test("pinned watermark-HIT turns ledger the DECLARED tail ids (#7366)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-hit-ledger-ids-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";
    const savedWm = process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK;
    const savedInc = process.env.BILI_ROLLOUT_PLUGIN_MSG_ID_INCREMENTAL;
    process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = "1";
    process.env.BILI_ROLLOUT_PLUGIN_MSG_ID_INCREMENTAL = "1";
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    try {
        setRegistryForTest({});
        const store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        const upstream = http.createServer((req, res) => {
            req.resume();
            req.on("end", () => {
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
            log: true, debug: true, passthrough: false, autoUpdate: false,
            compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
            autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        const srv = await startServer(opts);
        await listen(srv);
        try {
            const proxyPort = (srv.address() as { port: number }).port;
            const sessionId = "conv-pf-hit-ledger-ids";
            const post = async (
                messages: unknown[],
                headers: Record<string, string> = {},
                extraBody: Record<string, unknown> = {},
            ): Promise<Map<string, string>> => {
                const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-acp-session": sessionId, ...headers },
                    body: JSON.stringify({ model: MODEL, stream: false, messages, ...extraBody }),
                });
                assert.equal(resp.status, 200, `expected 200, headers=${JSON.stringify(headers)}`);
                await resp.text();
                return new Map([...resp.headers].map(([k, v]) => [k.toLowerCase(), v]));
            };
            const settle = async () => {
                const ok = await store.afterNextFlush(sessionId);
                assert.ok(ok, "first debounced flush landed");
                assert.ok(await store.afterNextFlush(sessionId), "second flush settled");
            };
            const idRows = () => {
                const db = new DatabaseSync(join(dir, "sessions", "index.db"), { readOnly: true });
                try {
                    const stmt = db.prepare("SELECT seq, msg_id, retired_at FROM messages WHERE session_id = ? ORDER BY seq");
                    return (stmt.all(sessionId) as unknown as { seq: number; msg_id: string; retired_at: number | null }[]);
                } finally {
                    db.close();
                }
            };

            const hostId = (i: number) => `host-id-${i}`;
            const seed = [msg("user", 0), msg("assistant", 1), msg("user", 2), msg("assistant", 3), msg("user", 4), msg("assistant", 5)];

            // Turn 1: seed — full msgid list in the body (bootstrap form).
            const h1 = await post(seed, {}, { biliMsgIds: [0, 1, 2, 3, 4, 5].map(hostId) });
            assert.equal(h1.get("x-bili-pf-seq"), "6", "seed turn stamps the watermark seq");
            await settle();
            const r1 = idRows();
            assert.equal(r1.length, 6, "seed rows ingested");
            assert.deepEqual(
                r1.map((r) => r.msg_id),
                [0, 1, 2, 3, 4, 5].map(hostId),
                "seed rows carry the declared host ids",
            );

            // Turn 2: +1 message, KDD#22 tail form (count + anchor/new ids).
            // Must be a fastpath HIT — and the NEW row must land with the
            // declared id, not a content-hash mint.
            logs.length = 0;
            const h2 = await post([...seed, msg("user", 6)], {
                "x-bili-pf-count": "6",
                "x-bili-pf-tail-ids": `${hostId(5)},${hostId(6)}`,
            });
            assert.equal(h2.get("x-bili-pf-seq"), "7", "hit turn re-stamps the watermark");
            assert.ok(
                logs.some((l) => l.includes("fastpath HIT") && l.includes(sessionId)),
                `turn 2 must be a fastpath HIT (log: ${logs.filter((l) => l.includes("fastpath")).slice(0, 4).join(" | ")})`,
            );
            await settle();
            const r2 = idRows();
            assert.equal(r2.length, 7, "all 7 rows present after the window save");
            assert.ok(r2.every((r) => r.retired_at === null), "the window save retires nothing");
            assert.equal(r2[6].msg_id, hostId(6), `the HIT-turn new row must carry the DECLARED id (got ${r2[6].msg_id})`);
            assert.deepEqual(
                r2.slice(0, 6).map((r) => r.msg_id),
                [0, 1, 2, 3, 4, 5].map(hostId),
                "prefix rows keep their declared ids",
            );

            // Turn 3: the STEADY state — the overlap check compares the
            // declared anchor (host-id-6) against the ledger. Pre-fix the
            // ledger held h_… here and this turn degraded to the full form.
            logs.length = 0;
            const h3 = await post([...seed, msg("user", 6), msg("assistant", 7)], {
                "x-bili-pf-count": "7",
                "x-bili-pf-tail-ids": `${hostId(6)},${hostId(7)}`,
            });
            assert.equal(h3.get("x-bili-pf-seq"), "8", "steady turn re-stamps the watermark");
            assert.ok(
                logs.some((l) => l.includes("fastpath HIT") && l.includes(sessionId)),
                `turn 3 must be a fastpath HIT (log: ${logs.filter((l) => l.includes("fastpath")).slice(0, 4).join(" | ")})`,
            );
            assert.ok(
                !logs.some((l) => l.includes(sessionId) && l.includes("tail drift")),
                `turn 3 must not log a tail drift (log: ${logs.filter((l) => l.includes(sessionId)).slice(-6).join(" | ")})`,
            );
            await settle();
            const r3 = idRows();
            assert.equal(r3[7].msg_id, hostId(7), `steady-turn new row carries the declared id (got ${r3[7].msg_id})`);

            // Negative direction (#3617): an UNPINNED session keeps the
            // legacy behavior — the HIT-turn window cores land with their
            // content-hash ids and no pin mode is advertised.
            const logs2 = logs;
            const unseed = [msg("user", 0), msg("assistant", 1), msg("user", 2)];
            const h4 = await post(unseed, { "x-acp-session": "conv-unpinned" } as Record<string, string>);
            void h4;
            logs2.length = 0;
            const h5 = await post([...unseed, msg("assistant", 3)], { "x-acp-session": "conv-unpinned" } as Record<string, string>, {});
            void h5;
            const unrows = (() => {
                const db = new DatabaseSync(join(dir, "sessions", "index.db"), { readOnly: true });
                try {
                    const stmt = db.prepare("SELECT seq, msg_id FROM messages WHERE session_id = ? ORDER BY seq");
                    return (stmt.all("conv-unpinned") as unknown as { seq: number; msg_id: string }[]);
                } finally {
                    db.close();
                }
            })();
            assert.equal(unrows.length, 4, "unpinned rows ingested");
            assert.ok(
                unrows[3].msg_id.startsWith("h_"),
                `unpinned sessions keep the legacy content-hash ids (got ${unrows[3].msg_id})`,
            );
        } finally {
            srv.closeAllConnections?.();
            await close(srv);
            store.closeQuietly();
            await close(upstream);
        }
    } finally {
        setLogCapture(null);
        if (savedWm === undefined) delete process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK;
        else process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = savedWm;
        if (savedInc === undefined) delete process.env.BILI_ROLLOUT_PLUGIN_MSG_ID_INCREMENTAL;
        else process.env.BILI_ROLLOUT_PLUGIN_MSG_ID_INCREMENTAL = savedInc;
    }
});
