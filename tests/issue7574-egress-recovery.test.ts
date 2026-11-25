// #7574 (review of PR #6785), end to end with a live proxy:
//   - a plain session (no plugin lane) whose op-log rows are damaged keeps
//     answering — before, the next turn was failed with 500 on the anthropic,
//     gemini and responses wires, although the log is not that session's
//     authority and nothing was lost;
//   - a session whose log IS the authority still fails (ruling 7439-5), and
//     the operator now has a way out: `GET /__bili/egress/latches` lists the
//     stuck sessions, `POST /__bili/egress/reset` drops the damaged log, and
//     the next turn starts a fresh one from the client's conversation.

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

const msg = (role: "user" | "assistant", i: number) =>
    ({ role, content: `${role}-message-${i} ${"x".repeat(64)}-${i}` });

test("#7574 a damaged op log costs a turn only where it is the authority; the operator can reset it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-recovery-7574-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    let store: SessionStore | null = null;
    let srv: http.Server | null = null;
    let upstream: http.Server | null = null;
    try {
        setRegistryForTest({});
        store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        upstream = http.createServer((req, res) => {
            req.on("data", () => undefined);
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
        ): Promise<{ status: number; text: string; json: unknown }> => {
            const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
            const text = await resp.text();
            let json: unknown = null;
            try { json = JSON.parse(text); } catch { /* not json */ }
            return { status: resp.status, text, json };
        };
        // pinned plugin turn on the OpenAI wire
        const post = (sessionId: string, messages: unknown[]) =>
            call(`${base}/v1/chat/completions`, { "x-bili-plugin": "opencode", "x-acp-session": sessionId },
                { model: MODEL, stream: false, messages, biliMsgIds: messages.map((_, i) => `host-id-${i}`) });
        // plain proxy turn on the anthropic wire (no plugin lane, no ids; a
        // normal output budget, so it is not taken for a title request)
        const postAnthropic = (sessionId: string, messages: Array<{ role: string; content: string }>) =>
            call(`${base}/bili/${llmUrl}/v1/messages`, { "x-acp-session": sessionId },
                { model: MODEL, max_tokens: 4096, stream: false, messages });
        const admin = async (method: "GET" | "POST", route: string, body?: unknown): Promise<{ status: number; json: any }> => {
            const resp = await fetch(`${base}${route}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
            return { status: resp.status, json: await resp.json() as unknown };
        };
        const settle = async (sessionId: string): Promise<void> => {
            const race = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
            assert.equal(await race(store!.afterNextFlush(sessionId), 10_000), true, "first debounced flush landed");
            assert.equal(await race(store!.afterNextFlush(sessionId), 10_000), true, "second flush settled");
        };
        const dbPath = join(dir, "sessions", "index.db");
        const flowRows = (sid: string): number => {
            const db = new DatabaseSync(dbPath, { readOnly: true });
            try {
                return (db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(sid) as { n: number }).n;
            } finally {
                db.close();
            }
        };
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
        };

        // 1. a plain session on the anthropic wire: the log is recorded but is
        //    not its authority — a damaged log must not cost the turn.
        const a1 = await postAnthropic("an-plain", [msg("user", 0)]);
        assert.equal(a1.status, 200, `plain anthropic turn (got ${a1.status}: ${a1.text.slice(0, 200)})`);
        await settle("an-plain");
        assert.ok(flowRows("an-plain") >= 1, "the plain turn was recorded");
        await corrupt("an-plain");
        logs.length = 0;
        const a2 = await postAnthropic("an-plain", [msg("user", 0), msg("assistant", 1), msg("user", 2)]);
        assert.equal(a2.status, 200, `the plain session keeps answering after its log was damaged (got ${a2.status}: ${a2.text.slice(0, 200)})`);
        assert.ok(logs.some((l) => l.includes("an-plain") && l.includes("turn not recorded")), `the skip is logged (log: ${logs.filter((l) => l.includes("an-plain")).slice(-4).join(" | ")})`);
        const list0 = await admin("GET", "/__bili/egress/latches");
        assert.equal(list0.status, 200);
        assert.deepEqual(list0.json.latched, [], "a plain session is never stuck on its log");

        // 2. a pinned session: the log IS its authority — the turn fails and
        //    the session shows up on the operator's list.
        const seed = [msg("user", 0), msg("assistant", 1), msg("user", 2)];
        const p1 = await post("conv-latched", seed);
        assert.equal(p1.status, 200, `bootstrap turn (got ${p1.status}: ${p1.text.slice(0, 200)})`);
        assert.ok(logs.some((l) => l.includes("conv-latched") && l.includes("egress-authority: bootstrap")), "turn 1 bootstraps the log");
        await settle("conv-latched");
        await corrupt("conv-latched");
        logs.length = 0;
        const p2 = await post("conv-latched", [...seed, msg("user", 3)]);
        assert.notEqual(p2.status, 200, `the pinned turn on a damaged log fails (got ${p2.status})`);
        assert.ok(logs.some((l) => l.includes("conv-latched") && l.includes("refusing to run on client bytes")), "and says why");
        const list1 = await admin("GET", "/__bili/egress/latches");
        assert.equal(list1.status, 200);
        assert.deepEqual(list1.json.latched.map((l: { sessionId: string }) => l.sessionId), ["conv-latched"], "the stuck session is listed for the operator");

        // 3. the operator resets the damaged log: the session starts over.
        const reset = await admin("POST", "/__bili/egress/reset", { sessionId: "conv-latched" });
        assert.equal(reset.status, 200, JSON.stringify(reset.json));
        assert.deepEqual(reset.json, { ok: true, hadLog: true, sessionLoaded: true });
        assert.equal(flowRows("conv-latched"), 0, "the damaged rows are gone");
        const list2 = await admin("GET", "/__bili/egress/latches");
        assert.deepEqual(list2.json.latched, [], "nothing is stuck any more");
        logs.length = 0;
        const p3 = await post("conv-latched", [...seed, msg("user", 3)]);
        assert.equal(p3.status, 200, `the turn after the reset succeeds (got ${p3.status}: ${p3.text.slice(0, 200)})`);
        // (the reset itself cleared the latch of the loaded session; a session
        // that was not loaded clears it on its next turn — seam test)
        assert.ok(logs.some((l) => l.includes("conv-latched") && l.includes("egress-authority: bootstrap")), "and the log is rebuilt from the client's conversation");
        await settle("conv-latched");
        assert.ok(flowRows("conv-latched") >= 4, "the new log holds the whole conversation");

        // 4. a reset without a session id is refused
        const bad = await admin("POST", "/__bili/egress/reset", {});
        assert.equal(bad.status, 400);
        const unknown = await admin("POST", "/__bili/egress/reset", { sessionId: "never-seen" });
        assert.deepEqual(unknown.json, { ok: true, hadLog: false, sessionLoaded: false }, "resetting a session without a log is harmless");
    } finally {
        setLogCapture(null);
        store?.closeQuietly();
        srv?.closeAllConnections?.();
        await new Promise<void>((resolve) => { if (srv) srv.close(() => resolve()); else resolve(); });
        upstream?.closeAllConnections?.();
        await new Promise<void>((resolve) => { if (upstream) upstream.close(() => resolve()); else resolve(); });
    }
});
