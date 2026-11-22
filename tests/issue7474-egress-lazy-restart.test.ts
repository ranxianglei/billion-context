/**
 * #7474 P2b-envelope (ruling 7439, comment-19805485): for the egress-on
 * session the op log is the SOLE transcript authority, so the per-turn
 * projection writes stop — the JSON envelope freezes (no per-turn rewrite
 * of the growing kernel state) and the unified messages projection is
 * skipped (P2b). The critical consequence: a RESTARTED process has neither
 * a growing envelope nor a growing projection — boot must rebuild the
 * session from the egress flow alone (recoverEgressBase on the B base ops).
 *
 * This suite proves exactly that: turns on a live server, full store close,
 * reopen in the same XDG dir, then the next turn must serve the SAME
 * canonical prefix from the flow table, and the envelope file must not
 * have grown between steady turns.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
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
const SID = "lazy-restart-R";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

const msg = (role: "user" | "assistant", i: number) =>
    ({ role, content: `${role}-message-${i} ${"x".repeat(64)}-${i}` });

function history(n: number): unknown[] {
    const out: unknown[] = [];
    for (let i = 1; i <= n; i++) out.push(msg(i % 2 === 1 ? "user" : "assistant", i));
    return out;
}

async function turn(base: string, n: number): Promise<unknown[]> {
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer k", "x-acp-session": SID },
        body: JSON.stringify({ model: MODEL, stream: false, messages: history(n) }),
    });
    const body = await res.text();
    assert.equal(res.status, 200, `turn ${n} failed: ${res.status} ${body.slice(0, 200)}`);
    return (JSON.parse(body) as { messages?: unknown[] }).messages ?? [];
}

/** Every *.json envelope under the sessions dir, keyed by name — size map. */
function envelopeSizes(sessionsDir: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of fs.readdirSync(sessionsDir)) {
        if (!f.endsWith(".json")) continue;
        out[f] = fs.statSync(join(sessionsDir, f)).size;
    }
    return out;
}

function maxEnvelope(sessionsDir: string): number {
    return Math.max(0, ...Object.values(envelopeSizes(sessionsDir)));
}

async function boot(opts: ProxyOptions): Promise<{ srv: http.Server; base: string }> {
    opts.port = 0;
    const srv = await startServer(opts);
    await listen(srv);
    return { srv, base: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test("egress-on lazy projection: envelope frozen, restart serves the canonical prefix from the flow alone (#7474 P2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-lazy-restart-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    // Envelope posture: shadow mode = JSON envelope ACTIVE + unified index
    // (the default is pure-sqlite, where no envelope is written at all —
    // then the freeze would be unobservable). egressPlane on from start.
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    setRegistryForTest({});

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
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r(undefined)));
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

    let srv: http.Server | undefined;
    let store: SessionStore | undefined;
    const sessionsDir = join(dir, "sessions");
    try {
        store = new SessionStore({ dir: sessionsDir, enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        const b1 = await boot(opts);
        const base1 = b1.base;
        srv = b1.srv;

        // Three steady turns on the live process.
        await turn(base1, 1);
        await new Promise((r) => setTimeout(r, 250));
        await turn(base1, 3);
        await new Promise((r) => setTimeout(r, 250));
        const sizeAfterT2 = maxEnvelope(sessionsDir);
        await turn(base1, 5);
        await new Promise((r) => setTimeout(r, 250));

        assert.ok(logs.some((l) => l.includes("egress-serve: served") && l.includes(SID)),
            "the session must actually be served from the op-log");
        // Frozen envelope: the steady saves after the latch must NOT rewrite
        // it (a growing kernel state would grow the file on every save).
        const sizeAfterT3 = maxEnvelope(sessionsDir);
        assert.equal(sizeAfterT3, sizeAfterT2,
            `egress-on envelope must stay frozen across steady saves (grew ${sizeAfterT2} -> ${sizeAfterT3})`);

        // Full process boundary: close server + store, boot fresh in the
        // SAME XDG dir. The restarted process sees only the flow table for
        // this session (frozen envelope + skipped projection).
        srv!.closeAllConnections?.();
        await new Promise<void>((r) => srv!.close(() => r(undefined)));
        store!.closeQuietly();
        store = undefined; srv = undefined;

        store = new SessionStore({ dir: sessionsDir, enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        const b2 = await boot(opts);
        const base2 = b2.base;
        srv = b2.srv;

        // The client resends ITS OWN history (5 messages + the new 6th);
        // the served prefix must be the CANONICAL flow bytes — byte-equal
        // to what the pre-restart turn put on the wire.
        const t4 = await turn(base2, 6);
        await new Promise((r) => setTimeout(r, 250));
        void t4;

        assert.ok(logs.filter((l) => l.includes("egress-serve: served") && l.includes(SID)).length >= 2,
            "the restarted process must serve from the op-log too");
        const pre = JSON.parse(seenBodies[2]) as { messages: unknown[] };
        const post = JSON.parse(seenBodies[3]) as { messages: unknown[] };
        assert.equal(post.messages.length, pre.messages.length + 1,
            "post-restart turn = same served prefix + the one new client message");
        for (let i = 0; i < pre.messages.length; i++) {
            assert.deepEqual(post.messages[i], pre.messages[i],
                `served prefix element ${i} must be byte-identical across the restart (flow-only boot)`);
        }
    } finally {
        srv?.closeAllConnections?.();
        await new Promise<void>((r) => { if (srv) srv.close(() => r(undefined)); else r(undefined); });
        upstream.closeAllConnections?.();
        await new Promise<void>((r) => upstream.close(() => r(undefined)));
        store?.closeQuietly();
        delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
        delete process.env.BILI_STORAGE_UNIFIED;
        setLogCapture(null);
    }
});
