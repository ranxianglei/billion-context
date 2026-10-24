/**
 * #3013 / #3022 (A1 + A3): the dsh compaction refusal storm.
 *
 * Field report: one long session burned 5069 refused compaction calls
 * (5038 retries after the first, median interval 328ms, 0 outbound) because
 * (a) the refusal body carried no machine-readable terminal marker a client
 * could latch (`retryable:false` did not stop dsh's own pressure-ledger
 * driven retry loop), and (b) after the once-warn, every further refusal was
 * silent — the user stared at a stuck "生成中" for hours with zero log lines.
 *
 * This pins the two halves of the fix:
 *  - A1: every refusal body carries `bili_final: true` (top level on both
 *    protocol shapes; inside `error` on the openai envelope where
 *    `retryable` lives). Consumption by dsh upstream is a cross-project
 *    follow-up — bili's side of the contract is stable here.
 *  - A3: the pipeline lane logs an info every DSH_REFUSAL_STORM_LOG_EVERY-th
 *    refusal with the running count and the levers; the passthrough lane
 *    (previously warn-per-refusal — the spam direction) warns on the first
 *    refusal in the process and then follows the same cadence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX, DSH_REFUSAL_STORM_LOG_EVERY, dshCompactionRefusal, dshPassthroughGuardStats } from "../src/server/dsh-compaction-guard.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

const INSTRUCTION = `${DSH_COMPACTION_INSTRUCTION_PREFIX} Summarize the conversation above.`;

function startUpstream(captured: string[]): Promise<http.Server> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    return once(upstream, "listening").then(() => upstream);
}

async function startBili(upstreamPort: number): Promise<{ port: number; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        promptCache: { routing: "auto" },
        compress: { injectTool: false, injectNudge: false },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return {
        port: (proxy.address() as AddressInfo).port,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
        },
    };
}

test("A1: refusal bodies carry the bili_final terminal marker on both protocol shapes", () => {
    const anthropic = dshCompactionRefusal("anthropic");
    const body = anthropic.body as Record<string, unknown>;
    assert.equal(body.bili_final, true, "anthropic shape: top-level bili_final");
    assert.equal((body.error as Record<string, unknown>).type, "invalid_request_error");

    const openai = dshCompactionRefusal("openai");
    const ob = openai.body as Record<string, unknown>;
    assert.equal(ob.bili_final, true, "openai shape: top-level bili_final");
    const err = ob.error as Record<string, unknown>;
    assert.equal(err.retryable, false);
    assert.equal(err.bili_final, true, "openai shape: error.bili_final (where retryable lives)");
    assert.equal(err.code, "dsh_compaction_refused");

    // the message must state the terminal semantics + the levers (#3013)
    assert.match(String(err.message), /terminal for the session/);
    assert.match(String(err.message), /stop retrying/);
    assert.match(String(err.message), /#2474/);
    assert.match(String(err.message), /allowDshCompaction/);
});

test("A3: pipeline storm — first refusal warns once, then every DSH_REFUSAL_STORM_LOG_EVERY-th logs an info with the levers", async () => {
    const captured: string[] = [];
    const upstream = await startUpstream(captured);
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const bili = await startBili(upstreamPort);

    const lines: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => lines.push({ level, msg }));
    try {
        let sawTerminal = false;
        for (let i = 0; i < DSH_REFUSAL_STORM_LOG_EVERY; i++) {
            const resp = await fetch(`http://127.0.0.1:${bili.port}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "s-3013" },
                body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: INSTRUCTION }] }),
            });
            assert.equal(resp.status, 422, `refusal ${i + 1} must stay 422`);
            const parsed = JSON.parse(await resp.text()) as Record<string, unknown>;
            assert.equal(parsed.bili_final, true, `refusal ${i + 1} carries bili_final on the wire`);
            sawTerminal = true;
        }
        assert.ok(sawTerminal);

        assert.equal(captured.length, 0, "no refusal may ever reach the upstream");

        const warns = lines.filter((l) => l.level === "warn" && l.msg.includes("dsh native compaction call identified"));
        assert.equal(warns.length, 1, "exactly one identification warn (the once-warn)");

        const storm = lines.filter((l) => l.level === "info" && l.msg.includes("dsh native compaction refusal #"));
        assert.equal(storm.length, 1, `exactly one storm info in ${DSH_REFUSAL_STORM_LOG_EVERY} refusals`);
        assert.match(storm[0].msg, new RegExp(`refusal #${DSH_REFUSAL_STORM_LOG_EVERY}\\b`));
        assert.match(storm[0].msg, /never shrinks \(#2490\)/);
        assert.match(storm[0].msg, /#2474/);
        assert.match(storm[0].msg, /allowDshCompaction/);
        assert.match(storm[0].msg, /#3013/);
    } finally {
        setLogCapture(null);
        await bili.close();
        upstream.close();
        await once(upstream, "close");
    }
});

test("A3: passthrough storm — first-in-process warns, then the same cadence (no per-refusal spam)", async () => {
    const captured: string[] = [];
    const upstream = await startUpstream(captured);
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const bili = await startBili(upstreamPort);

    const lines: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => lines.push({ level, msg }));
    const before = dshPassthroughGuardStats.refusals;
    // any 100 consecutive refusals cross exactly one multiple of
    // DSH_REFUSAL_STORM_LOG_EVERY; the warn fires only when this process's
    // first passthrough refusal happens to land inside the loop.
    const firstInLoop = before === 0;
    try {
        for (let i = 0; i < DSH_REFUSAL_STORM_LOG_EVERY; i++) {
            const resp = await fetch(`http://127.0.0.1:${bili.port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
                body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: INSTRUCTION }] }),
            });
            assert.equal(resp.status, 422);
            assert.equal((JSON.parse(await resp.text()) as Record<string, unknown>).bili_final, true, "passthrough refusal also carries bili_final");
        }
        assert.equal(captured.length, 0, "nothing forwarded");

        const lane = lines.filter((l) => l.msg.includes("[passthrough] dsh native compaction call identified"));
        const warns = lane.filter((l) => l.level === "warn");
        const infos = lane.filter((l) => l.level === "info");
        if (firstInLoop) {
            assert.equal(warns.length, 1, "process-first refusal warns");
            assert.equal(infos.length, 1, "and the 100th logs one cadence info");
            assert.match(infos[0].msg, /terminal; #3013/);
        } else {
            assert.equal(infos.length, 1, "exactly one cadence info per 100 consecutive refusals");
        }
        assert.ok(lane.length <= 2, `no per-refusal spam: ${lane.length} lines for ${DSH_REFUSAL_STORM_LOG_EVERY} refusals`);
    } finally {
        setLogCapture(null);
        await bili.close();
        upstream.close();
        await once(upstream, "close");
    }
});
