/** #6181 B3 (pure-chain continuation) × egress plane (PR #7857 review F2 →
 *  fix). The B3 fast path forwards the client's chained Responses round
 *  verbatim and skips prepareResponses — and with it the egress
 *  record/authority seam. A bare-string input on that path is NEW user
 *  content the provider keeps in its retained chain and the client may
 *  never resend; without the fix it is missing from the op log (the
 *  egress transcript, ruling 7439-5) forever. The fix composes an
 *  append-only core (flow view + this turn's fresh cores) and runs the
 *  shared record-only seam; it must:
 *    1. record the string input as exactly ONE new row (deterministic
 *       kernel id), preserving the system row and every prior row;
 *    2. leave the flow untouched for empty-continuation turns;
 *    3. be idempotent — an identical resend (the preflight re-prepare
 *       shape) finds the row already in the flow and records nothing;
 *    4. keep the fast path verbatim (previous_response_id + raw string
 *       input reach the upstream — #6181's whole point);
 *    5. be inert with the egress plane off (default). */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "acp-kernel";
import { responsesToCore, type ResponsesRequestBody } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { setLogCapture } from "../src/logger.ts";
import { elementOfCore } from "../src/msgid-pin.ts";
import { EGRESS_SYSTEM_MSGID, type EgressViewRow } from "../src/storage/egress-state.ts";

const MODEL = "gpt-test";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function freshDir(): string {
    return mkdtempSync(join(tmpdir(), "b3-egress-record-"));
}

test("B3 × egress plane: string-input continuation is recorded once, empty/duplicate turn record nothing (#7857 review F2)", async () => {
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
    const dir = freshDir();
    test.after(() => {
        rmSync(dir, { recursive: true, force: true });
        delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
    });
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    let store: SessionStore | null = null;
    let srv: http.Server | null = null;
    let upstream: http.Server | null = null;
    try {
        store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                seen.push({ url: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: `resp-${seen.length}`, object: "response", status: "completed", model: MODEL,
                    output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
                    usage: { input_tokens: 10, output_tokens: 5 },
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
        const post = async (path: string, sessionId: string, body: Record<string, unknown>): Promise<{ status: number; body: string }> => {
            const resp = await fetch(`${base}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-acp-session": sessionId },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
            return { status: resp.status, body: await resp.text() };
        };
        const view = (): EgressViewRow[] => {
            const st = store!.egressOpLogStore();
            assert.ok(st, "the egress op-log store must exist (BILI_STORAGE_UNIFIED=full + plane on)");
            return st.egressStateView("b3-egress");
        };

        // 1. Bootstrap: a FULL-form plugin-lane Responses turn — this is
        //    what records the initial flow (record-only: no wire ids).
        const r1 = await post("/v1/responses", "b3-egress", {
            model: MODEL, stream: false, instructions: "you are terse",
            input: [{ type: "message", role: "user", content: "first" }],
        });
        assert.equal(r1.status, 200, `bootstrap turn must succeed (got ${r1.status}: ${r1.body.slice(0, 200)})`);
        const v1 = view();
        assert.ok(v1.some((r) => r.msgid === EGRESS_SYSTEM_MSGID), `the bootstrap turn must record the system row (got: ${JSON.stringify(v1)})`);
        const before = v1.map((r) => r.msgid);

        // 2. B3 round with a BARE-STRING input — the fast path. Upstream
        //    must see the verbatim continuation (#6181), and the op log
        //    must gain exactly one row for the string.
        const r2 = await post("/v1/responses", "b3-egress", {
            model: MODEL, stream: false, previous_response_id: "resp-1", input: "hello continuation",
        });
        assert.equal(r2.status, 200, `B3 string turn must succeed (got ${r2.status}: ${r2.body.slice(0, 200)})`);
        const b3Upstream = seen.at(-1)!;
        assert.equal(b3Upstream.body.previous_response_id, "resp-1", "the fast path keeps previous_response_id verbatim (the full path strips it — #6181)");
        assert.equal(b3Upstream.body.input, "hello continuation", "the fast path forwards the string input verbatim");
        const v2 = view();
        const fresh = responsesToCore({ model: MODEL, stream: false, previous_response_id: "resp-1", input: "hello continuation" } as ResponsesRequestBody);
        const expectedId = elementOfCore(fresh.msgs[0]!.id).element;
        const added = v2.filter((r) => !before.includes(r.msgid));
        assert.equal(added.length, 1, `the B3 string turn must add exactly one flow row (got: ${JSON.stringify(added)}; view: ${JSON.stringify(v2)})`);
        assert.equal(added[0]!.msgid, expectedId, `the new row must carry the deterministic kernel id (got ${added[0]!.msgid}, want ${expectedId})`);
        assert.equal(added[0]!.role, "user");
        for (const id of before) {
            assert.ok(v2.some((r) => r.msgid === id), `the flow must not lose ${id} (append-only) — got: ${JSON.stringify(v2.map((r) => r.msgid))}`);
        }
        const sysBefore = v1.find((r) => r.msgid === EGRESS_SYSTEM_MSGID);
        const sysAfter = v2.find((r) => r.msgid === EGRESS_SYSTEM_MSGID);
        assert.ok(sysBefore && sysAfter, "the system row must survive the B3 turn");

        // 3. B3 round with EMPTY input (pure continuation) — nothing new
        //    to record; the flow must be byte-for-byte the same.
        const r3 = await post("/v1/responses", "b3-egress", {
            model: MODEL, stream: false, previous_response_id: "resp-2",
        });
        assert.equal(r3.status, 200, `B3 empty turn must succeed (got ${r3.status}: ${r3.body.slice(0, 200)})`);
        const b3EmptyUpstream = seen.at(-1)!;
        assert.equal(b3EmptyUpstream.body.previous_response_id, "resp-2");
        assert.equal(b3EmptyUpstream.body.input, undefined, "no input was sent — none may appear");
        assert.deepEqual(v3rows(view()), v3rows(v2), "the empty-continuation turn must not touch the flow");

        // 4. The SAME string again (different chain anchor) — the row is
        //    already in the flow (deterministic id) → records nothing.
        //    This is also the preflight re-prepare shape: same body, the
        //    flow has already advanced.
        const r4 = await post("/v1/responses", "b3-egress", {
            model: MODEL, stream: false, previous_response_id: "resp-3", input: "hello continuation",
        });
        assert.equal(r4.status, 200, `B3 duplicate turn must succeed (got ${r4.status}: ${r4.body.slice(0, 200)})`);
        assert.deepEqual(v3rows(view()), v3rows(v2), "an identical resend must record nothing (idempotent)");

        assert.ok(
            !logs.some((l) => l.includes("b3-egress") && l.includes("pin rejected"))
            && !logs.some((l) => l.includes("b3-egress") && l.includes("probe failed")),
            `the B3 record must stay on the record-only path (log: ${logs.filter((l) => l.includes("b3-egress")).join(" || ")})`,
        );
    } finally {
        await srv?.close();
        await upstream?.close();
        _resetStoreForTest();
    }
});

function v3rows(rows: EgressViewRow[]): Array<string> {
    return rows.map((r) => `${r.msgid}|${r.type}|${r.role}|${r.bytes ?? ""}`);
}

test("B3 × egress plane OFF (default): the fast path is untouched, no op-log rows", async () => {
    delete process.env.BILI_ROLLOUT_EGRESS_PLANE;
    const dir = freshDir();
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    let store: SessionStore | null = null;
    let srv: http.Server | null = null;
    let upstream: http.Server | null = null;
    try {
        store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                seen.push({ url: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: `resp-${seen.length}`, object: "response", status: "completed", model: MODEL,
                    output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
                    usage: { input_tokens: 10, output_tokens: 5 },
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
        const resp = await fetch(`${base}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-acp-session": "b3-off" },
            body: JSON.stringify({ model: MODEL, stream: false, previous_response_id: "resp-9", input: "off-string" }),
            signal: AbortSignal.timeout(30_000),
        });
        assert.equal(resp.status, 200, `B3 turn (plane off) must succeed (got ${resp.status}: ${(await resp.text()).slice(0, 200)})`);
        const b3Upstream = seen.at(-1)!;
        assert.equal(b3Upstream.body.previous_response_id, "resp-9", "plane off: the fast path stays verbatim");
        assert.equal(b3Upstream.body.input, "off-string");
        const st = store.egressOpLogStore();
        const rows = st ? st.egressStateView("b3-off") : [];
        assert.equal(rows.length, 0, `plane off: no egress rows may be recorded (got ${rows.length})`);
    } finally {
        await srv?.close();
        await upstream?.close();
        _resetStoreForTest();
    }
});
