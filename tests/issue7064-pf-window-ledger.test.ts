// #7064 ledger drain (PR #6785 family): on a watermark-HIT turn the persist
// snapshot is the ~2-row tail WINDOW — a verified suffix of the ledger, NOT
// the complete log. If that save claims rawness, the #3285
// authoritative-set sweep retires every prefix row the window omits,
// draining the msgid pin ledger (snapMsgIdLiveIds) to the window: the KDD#21
// tail form then degrades to the full form every turn (full id list in the
// body, full validation, path=full ingest) and the "唯一 id 事实源"
// oscillates between 100k live rows and the 2-row window.
//
// Both directions are asserted (#3617): the window save must NOT sweep, and a
// genuine complete raw-tail save (history truncation) must STILL sweep.

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

test("watermark-HIT window snapshot must not retire the ledger prefix (#7064)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-window-ledger-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const savedRollout = process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK;
    process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = "1";
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
            const sessionId = "conv-pf-window-ledger";
            const post = async (messages: unknown[], headers: Record<string, string> = {}): Promise<Map<string, string>> => {
                const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-acp-session": sessionId, ...headers },
                    body: JSON.stringify({ model: MODEL, stream: false, messages }),
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
            const rows = () => {
                const db = new DatabaseSync(join(dir, "sessions", "index.db"), { readOnly: true });
                try {
                    const stmt = db.prepare("SELECT seq, retired_at FROM messages WHERE session_id = ? ORDER BY seq");
                    return (stmt.all(sessionId) as unknown as { seq: number; retired_at: number | null }[]);
                } finally {
                    db.close();
                }
            };

            // Turn 1: seed — 6 messages, no pf headers. The success response
            // stamps x-bili-pf-seq so the client can send the tail form next.
            const seed = [msg("user", 0), msg("assistant", 1), msg("user", 2), msg("assistant", 3), msg("user", 4), msg("assistant", 5)];
            const h1 = await post(seed);
            assert.equal(h1.get("x-bili-pf-seq"), "6", "seed turn stamps the watermark seq");
            await settle();
            assert.equal(rows().length, 6, "seed rows ingested");

            // Turn 2: +1 message, tail form (count=6, tail = anchor + new).
            // This must be a fastpath HIT — the window snapshot then presents
            // only the tail to the unified ingest.
            logs.length = 0;
            const h2 = await post([...seed, msg("user", 6)], {
                "x-bili-pf-count": "6",
                "x-bili-pf-tail-ids": "seed-anchor-5,seed-new-6",
            });
            assert.equal(h2.get("x-bili-pf-seq"), "7", "hit turn re-stamps the watermark");
            assert.ok(
                logs.some((l) => l.includes("fastpath HIT") && l.includes(sessionId)),
                `turn 2 must be a fastpath HIT (log: ${logs.filter((l) => l.includes("fastpath")).slice(0, 4).join(" | ")})`,
            );
            await settle();
            const r2 = rows();
            assert.equal(r2.length, 7, "all 7 rows present after the window save");
            assert.ok(
                r2.every((r) => r.retired_at === null),
                `the window save must NOT retire the verified prefix — retired: ${JSON.stringify(r2.filter((r) => r.retired_at !== null))}`,
            );

            // Turn 3 (negative direction): a real history truncation is a
            // legacy full turn whose RAW tail is genuinely complete — the
            // #3285 sweep must still retire the dropped prefix.
            await post([msg("user", 5), msg("assistant", 6)], { "x-bili-pf-count": "7", "x-bili-pf-tail-ids": "seed-new-6,dropped" });
            await settle();
            const r3 = rows();
            assert.equal(r3.filter((r) => r.retired_at === null).length, 2, "truncated-away prefix rows are retired by the genuine raw-tail sweep");
        } finally {
            srv.closeAllConnections?.();
            await close(srv);
            store.closeQuietly();
            await close(upstream);
        }
    } finally {
        setLogCapture(null);
        if (savedRollout === undefined) delete process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK;
        else process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = savedRollout;
    }
});
