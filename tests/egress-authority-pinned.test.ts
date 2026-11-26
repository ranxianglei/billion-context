// #7439 ruling 3+5 (PR #6785): the PINNED plugin lane is server-authoritative
// on the OpenAI wire. Direction asserts (#3617, all directions):
//   1. bootstrap: turn 1 of a pinned session has an EMPTY flow — the client
//      bytes are recorded once (full +I batch), the legacy outbound serves,
//      and the log says "egress-authority: bootstrap". The session must NOT
//      hard-fail on its first turn (the pre-fix seam threw on the empty flow
//      and a pinned session was dead on arrival);
//   2. steady: turn 2 onward the inbound kernel input is the op-log replay —
//      "egress-authority: N existing row(s) served from the op-log" AND the
//      served outbound contains the NEW client message (record-first serve);
//   3. unpinned control: a plain proxy session never logs egress-authority
//      (the seam is pinned-lane only) while egress-serve still runs;
//   4. hard-fail: a pinned session whose flow table is UNREADABLE (every row
//      corrupt, but rows PRESENT) must FAIL the request — whole-flow-unreadable
//      is a hard fail per the ruling, never client bytes, never legacy — and
//      latch egressFlowUnreadable. A row-less session is the only legitimate
//      empty flow (scenario 1) and must not trip this.

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
// KDD #25: this suite mixes an egress-on session and a LEGACY control session
// in one database (unpinned control leg) — it simulates a pre-gate DB, so
// force the full table set even where egressPlane=1 is set below.
process.env.BILI_TEST_FORCE_FULL_DDL = "1";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

const msg = (role: "user" | "assistant", i: number) =>
    ({ role, content: `${role}-message-${i} ${"x".repeat(64)}-${i}` });

test("pinned lane: bootstrap, steady serve, unpinned control, hard-fail (#7439-5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-authority-pinned-"));
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
        const seenBodies: string[] = [];
        upstream = http.createServer((req, res) => {
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
            modelContextLimit: 400_000, kernelConfig: defaultConfig( 400_000),
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
        const post = async (
            sessionId: string,
            messages: unknown[],
            ids?: string[],
        ): Promise<{ status: number; headers: Map<string, string>; body: string }> => {
            const body: Record<string, unknown> = { model: MODEL, stream: false, messages };
            if (ids) body.biliMsgIds = ids;
            const resp = await fetch(`${base}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-acp-session": sessionId },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
            const text = await resp.text();
            return { status: resp.status, headers: new Map([...resp.headers].map(([k, v]) => [k.toLowerCase(), v])), body: text };
        };
        const settle = async (sessionId: string): Promise<void> => {
            // Two egress-sync flushes: the record lands after the FIRST, the
            // second proves the queue is quiet before the DB assertions read.
            const race = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
            assert.equal(await race(store!.afterNextFlush(sessionId), 10_000), true, "first debounced flush landed");
            assert.equal(await race(store!.afterNextFlush(sessionId), 10_000), true, "second flush settled");
        };
        const seed = [msg("user", 0), msg("assistant", 1), msg("user", 2)];
        const hostId = (i: number) => `host-id-${i}`;

        // 1. Bootstrap turn: pinned, empty flow. Must NOT fail.
        const r1 = await post("conv-armed", seed, seed.map((_, i) => hostId(i)));
        assert.equal(r1.status, 200, `bootstrap turn must succeed (got ${r1.status}: ${r1.body.slice(0, 200)})`);
        assert.ok(
            logs.some((l) => l.includes("conv-armed") && l.includes("egress-authority: bootstrap")),
            `turn 1 must log the bootstrap (log: ${logs.filter((l) => l.includes("egress-authority")).slice(0, 3).join(" | ")})`,
        );
        await settle("conv-armed");
        const dbPath = join(dir, "sessions", "index.db");
        const flowRows = (sid: string): number => {
            const db = new DatabaseSync(dbPath, { readOnly: true });
            try {
                return (db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(sid) as { n: number }).n;
            } finally {
                db.close();
            }
        };
        assert.ok(flowRows("conv-armed") >= 4, `bootstrap recorded the full +I batch (flow rows: ${flowRows("conv-armed")})`);
        const flowAfterBootstrap = flowRows("conv-armed");

        // 2. Steady turn: +1 message. Kernel input must be the op-log replay
        //    and the served outbound must contain the new message.
        logs.length = 0;
        const seed2 = [...seed, msg("user", 3)];
        const r2 = await post("conv-armed", seed2, seed2.map((_, i) => hostId(i)));
        assert.equal(r2.status, 200, `steady turn must succeed (got ${r2.status}: ${r2.body.slice(0, 200)})`);
        assert.ok(
            logs.some((l) => l.includes("conv-armed") && l.includes("existing row(s) served from the op-log")),
            `turn 2 must log the op-log swap (log: ${logs.filter((l) => l.includes("egress-authority")).slice(0, 3).join(" | ")})`,
        );
        assert.ok(
            logs.some((l) => l.includes("conv-armed") && l.includes("egress-serve: served")),
            `turn 2 must serve from the op-log`,
        );
        const lastUpstream = JSON.parse(seenBodies[seenBodies.length - 1]) as { messages: Array<{ content: unknown }> };
        assert.ok(
            lastUpstream.messages.some((m) => JSON.stringify(m).includes("user-message-3")),
            "the served outbound must contain the NEW client message (record-first serve)",
        );
        await settle("conv-armed");
        assert.ok(flowRows("conv-armed") > flowAfterBootstrap, "the flow keeps appending (the view is not frozen)");

        // 2b. #7474 P2 (ruling 7439): with the projection frozen the PIN
        //     ledger moves to the op log. The messages rows stop growing at
        //     bootstrap while the flow keeps every turn — and the NEXT pinned
        //     turn still resolves incrementally (its tail-overlap check runs
        //     against the FLOW, not the frozen messages ledger).
        const msgsLedgerAfterT2 = store!.snapMsgIdLiveIds("conv-armed").length;
        const flowLedgerAfterT2 = store!.snapPinLiveIds("conv-armed");
        assert.ok(flowLedgerAfterT2.length >= 4, `the flow ledger carries the pinned ids (got ${flowLedgerAfterT2.length})`);
        assert.ok(!flowLedgerAfterT2.includes("egress-system"), "the constant system row is not part of the pin ledger");
        const seed3 = [...seed2, msg("user", 4)];
        logs.length = 0;
        const r2b = await post("conv-armed", seed3, seed3.map((_, i) => hostId(i)));
        assert.equal(r2b.status, 200, `the post-freeze pinned turn must succeed (got ${r2b.status}: ${r2b.body.slice(0, 200)})`);
        assert.ok(
            logs.some((l) => l.includes("conv-armed") && l.includes("existing row(s) served from the op-log")),
            "the post-freeze turn still serves from the op-log",
        );
        await settle("conv-armed");
        assert.equal(
            store!.snapMsgIdLiveIds("conv-armed").length,
            msgsLedgerAfterT2,
            "the messages projection is FROZEN for the egress-on session (no per-turn ingest)",
        );
        assert.ok(store!.snapPinLiveIds("conv-armed").length > flowLedgerAfterT2.length, "the flow ledger kept growing while the projection froze");

        // 3. Unpinned control: the seam never logs egress-authority.
        const r3 = await post("conv-plain", [msg("user", 0)], undefined);
        assert.equal(r3.status, 200);
        const r3b = await post("conv-plain", [msg("user", 0), msg("assistant", 1)], undefined);
        assert.equal(r3b.status, 200);
        assert.ok(
            !logs.some((l) => l.includes("conv-plain") && l.includes("egress-authority")),
            "the authority seam is pinned-lane only — no egress-authority log for an unpinned session",
        );
        assert.ok(
            logs.some((l) => l.includes("conv-plain") && l.includes("egress-serve: served")),
            "egress-serve still runs for the unpinned session",
        );

        // 4. Hard-fail: corrupt EVERY egress row (state + flow) while the
        //    server is live. The store holds no persistent read snapshot, so
        //    the writer can always land — retry through transient WAL
        //    contention instead of racing it.
        await settle("conv-armed");
        const corruptEgress = async (sid: string): Promise<void> => {
            for (let attempt = 1; attempt <= 50; attempt++) {
                const db = new DatabaseSync(dbPath);
                try {
                    db.exec("PRAGMA busy_timeout = 15000");
                    // 7773: the state plane carries no payload — damage it
                    // structurally (the serving read notices) and make the
                    // flow unreplayable (the rebuild and the walk-back hit it)
                    const st = db.prepare("DELETE FROM egress_state WHERE session_id = ?").run(sid);
                    const fl = db.prepare("UPDATE egress_flow SET payload = ? WHERE session_id = ?").run('{"x":1}', sid);
                    if (st.changes > 0 && fl.changes > 0) {
                        assert.ok(fl.changes >= flowAfterBootstrap, `corruption covered the flow rows (changed ${fl.changes}, expected >= ${flowAfterBootstrap})`);
                        return;
                    }
                    throw new Error(`no rows changed yet (state=${st.changes} flow=${fl.changes})`);
                } catch (err) {
                    if (attempt === 50) throw err;
                } finally {
                    db.close();
                }
                await new Promise((r) => setTimeout(r, 100));
            }
        };
        await corruptEgress("conv-armed");
        logs.length = 0;
        const r4 = await post("conv-armed", [...seed2, msg("user", 4)], seed2.map((_, i) => hostId(i)).concat(hostId(4)));
        assert.notEqual(r4.status, 200, `the unreadable-flow pinned turn must FAIL (got ${r4.status})`);
        assert.ok(
            logs.some((l) => l.includes("conv-armed") && l.includes("refusing to run on client bytes")),
            `turn 4 must log the refusal (log: ${logs.filter((l) => l.includes("conv-armed")).slice(-4).join(" | ")})`,
        );
        assert.ok(
            logs.some((l) => l.includes("conv-armed") && l.includes("egressFlowUnreadable")),
            "the session must latch the egressFlowUnreadable marker (the latch is in-memory by design: a failed turn is not persisted, and the next pinned turn re-derives the refusal from the corrupt flow)",
        );
    } finally {
        setLogCapture(null);
        store?.closeQuietly();
        srv?.closeAllConnections?.();
        await new Promise<void>((resolve) => { if (srv) srv.close(() => resolve()); else resolve(); });
        upstream?.closeAllConnections?.();
        await new Promise<void>((resolve) => { if (upstream) upstream.close(() => resolve()); else resolve(); });
    }
});
