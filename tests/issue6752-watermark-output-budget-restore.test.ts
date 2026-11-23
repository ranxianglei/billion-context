// #6752 — output-budget restore lost on watermark hits.
//
// A dsh plugin-native turn with a client-shrunk output budget (max_tokens: 1)
// is rescued by restoreOutputBudget in handle.ts (log: "output budget
// restored 1 -> 32768"), but on a watermark-fastpath HIT prepareOpenai
// rebinds `parsed` from the RAW wire text (bodyText) — re-parsing every
// scalar field, including max_tokens — so the restored value never reaches
// the upstream while the log still reports success.
//
// A/B golden: the same two scripted turns run through two proxies —
//   PHASE A: pluginFullResendWatermark OFF → legacy full-resend path
//   PHASE B: rollout ON (env force)      → fastpath (stamped hits)
// Turn 0 seeds the high-water (healthy 64000 budget) and the watermark;
// turn 1 carries the starved budget (max_tokens: 1) with tools present.
// Both phases must forward the RESTORED budget (32768, the declared output
// ceiling) on turn 1. Before the fix, phase B forwards max_tokens: 1.
//
// The residency check proves phase B actually HIT on turn 1 (a miss would
// take the legacy path and forward the restored value vacuously).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import {
    SessionStore,
    _setStoreForTest,
    _resetStoreForTest,
} from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { closeServers } from "./server-close-guard.ts";

const ENV = "BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK";

interface Capture {
    raw: string;
}
interface Harness2 {
    root: string;
    captured: Capture[];
    upstream: http.Server;
    store: SessionStore;
}

function makeUpstream(sink: Capture[]) {
    return http.createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            sink.push({ raw: data });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    id: "chatcmpl-test",
                    object: "chat.completion",
                    created: 1,
                    model: "model-test",
                    choices: [
                        {
                            index: 0,
                            message: { role: "assistant", content: "answer" },
                            finish_reason: "stop",
                        },
                    ],
                    usage: {
                        prompt_tokens: 100,
                        completion_tokens: 4,
                        total_tokens: 104,
                    },
                }),
            );
        });
    });
}

function makeHarness(tag: string): Harness2 {
    _resetStoreForTest();
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const root = mkdtempSync(path.join(os.tmpdir(), `obw-${tag}-`));
    for (const k of [
        "HOME",
        "APPHOME",
        "HERMES_HOME",
        "XDG_STATE_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
    ])
        process.env[k] = root;
    const store = new SessionStore({
        dir: path.join(root, "sessions"),
        enabled: false,
    });
    _setStoreForTest(store);
    const captured: Capture[] = [];
    return { root, store, captured, upstream: makeUpstream(captured) };
}

async function bringUp(h: Harness2) {
    h.upstream.listen(0, "127.0.0.1");
    await once(h.upstream, "listening");
    const uaddr = h.upstream.address();
    assert(uaddr && typeof uaddr === "object");
    const upstreamUrl = `http://127.0.0.1:${uaddr.port}`;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: upstreamUrl,
        routes: {
            [upstreamUrl]: {
                models: { "model-test": { context: 64_000, output: 32_768 } },
            },
        },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: true,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    return { proxy, origin: `http://127.0.0.1:${paddr.port}`, upstreamUrl };
}

function idOf(el: unknown): string {
    const s = JSON.stringify(el);
    let h = 0x811c9dc5;
    for (let k = 0; k < s.length; k++) {
        h ^= s.charCodeAt(k);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `eid-${h.toString(16)}`;
}

const TOOL = {
    type: "function",
    function: {
        name: "test_tool",
        description: "test tool",
        parameters: { type: "object", properties: {} },
    },
};

function scriptTurns(): Array<{
    model: string;
    messages: unknown[];
    tools: unknown[];
    max_tokens: number;
    stream: boolean;
}> {
    // Turn 0: healthy budget + tools — main turn, seeds the high-water and
    // the watermark. Turn 1: same history + one more exchange, starved
    // budget (max_tokens: 1) + tools — restore must raise it to the declared
    // output ceiling (32768) on BOTH paths.
    const history: unknown[] = [
        { role: "system", content: "You are TestBuddy v2." },
    ];
    const lines = ["alpha", "beta", "gamma", "delta"];
    for (let i = 0; i < lines.length; i++) {
        history.push({ role: "user", content: lines[i] });
        history.push({ role: "assistant", content: `ack ${i}` });
    }
    const turn1 = [
        ...history,
        { role: "user", content: "epsilon" },
        { role: "assistant", content: "ack 4" },
        { role: "user", content: "zeta" },
    ];
    return [
        {
            model: "model-test",
            messages: history,
            tools: [TOOL],
            max_tokens: 64_000,
            stream: false,
        },
        {
            model: "model-test",
            messages: turn1,
            tools: [TOOL],
            max_tokens: 1,
            stream: false,
        },
    ];
}

async function runClient(
    origin: string,
    upstreamUrl: string,
    sid: string,
    turns: ReturnType<typeof scriptTurns>,
): Promise<(number | null)[]> {
    const stamps: (number | null)[] = [];
    for (let i = 0; i < turns.length; i++) {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": sid,
            "x-bili-plugin": "dsh",
        };
        const prev = stamps[stamps.length - 1];
        if (prev !== null && prev !== undefined)
            headers["x-bili-pf-count"] = String(prev);
        const ids = (turns[i].messages as unknown[]).map(idOf);
        if (prev !== null && prev !== undefined && ids.length >= prev) {
            headers["x-bili-pf-tail-ids"] = ids
                .slice(prev - 1)
                .map(encodeURIComponent)
                .join(",");
        }
        const res = await fetch(
            `${origin}/bili/${upstreamUrl}/v1/chat/completions`,
            {
                method: "POST",
                headers,
                body: JSON.stringify(turns[i]),
            },
        );
        assert.equal(res.status, 200, `turn ${i}: proxy answers 200`);
        const s = res.headers.get("x-bili-pf-seq");
        stamps.push(s !== null && /^\d+$/.test(s) ? Number(s) : null);
        await res.arrayBuffer();
    }
    return stamps;
}

test("#6752 watermark hit must not discard the restored output budget", async () => {
    const savedEnv = process.env[ENV];
    const roots: string[] = [];
    try {
        // ---------- PHASE A: feature OFF (legacy full-resend) ----------
        process.env[ENV] = "0";
        const ha0 = makeHarness("phase-a");
        roots.push(ha0.root);
        const ha = await bringUp(ha0);
        const ra = await runClient(
            ha.origin,
            ha.upstreamUrl,
            "obw-phase-a",
            scriptTurns(),
        );
        const memA = (await (await fetch(`${ha.origin}/__bili/memory`)).json()) as {
            breakdown: { lastMessages: number };
        };
        ha0.store.cancelAll();
        await closeServers([ha.proxy, ha0.upstream], "obw phase-a");

        // ---------- PHASE B: feature ON (fastpath stamped hits) ----------
        process.env[ENV] = "1";
        const hb0 = makeHarness("phase-b");
        roots.push(hb0.root);
        const hb = await bringUp(hb0);
        const rb = await runClient(
            hb.origin,
            hb.upstreamUrl,
            "obw-phase-b",
            scriptTurns(),
        );
        const memB = (await (await fetch(`${hb.origin}/__bili/memory`)).json()) as {
            breakdown: { lastMessages: number };
        };
        hb0.store.cancelAll();
        await closeServers([hb.proxy, hb0.upstream], "obw phase-b");

        assert.equal(ha0.captured.length, 2, "legacy served both turns");
        assert.equal(hb0.captured.length, 2, "fastpath served both turns");
        // Turn 0 stamps (watermark seeded) in phase B; turn 1 must be a HIT,
        // so the fastpath pins only the tail window (residency proof).
        assert.equal(
            rb[0],
            scriptTurns()[0].messages.length,
            "B stamp 0: measured wire total",
        );
        assert.ok(
            memA.breakdown.lastMessages > 0,
            "legacy pinned resident history",
        );
        assert.ok(
            memB.breakdown.lastMessages > 0,
            "fastpath pinned the tail window",
        );
        assert.ok(
            memB.breakdown.lastMessages < memA.breakdown.lastMessages,
            `fastpath did not hit on turn 1: pinned ${memB.breakdown.lastMessages} vs legacy ${memA.breakdown.lastMessages}`,
        );

        const maxTokensOf = (raw: string): unknown =>
            (JSON.parse(raw) as { max_tokens?: unknown }).max_tokens;
        // Turn 0 forwards the healthy budget CLAMPED to the declared output
        // ceiling (32768) in both phases — clampOutgoingOutput caps at the
        // ceiling a provider would accept; the restore is not involved here.
        assert.equal(
            maxTokensOf(ha0.captured[0].raw),
            32_768,
            "A turn 0: healthy budget clamped to the ceiling",
        );
        assert.equal(
            maxTokensOf(hb0.captured[0].raw),
            32_768,
            "B turn 0: healthy budget clamped to the ceiling",
        );
        // Turn 1: the starved budget must be restored to the declared output
        // ceiling (32768) on BOTH paths — the log already claims the restore.
        assert.equal(
            maxTokensOf(ha0.captured[1].raw),
            32_768,
            "A turn 1: starved budget restored to the ceiling",
        );
        assert.equal(
            maxTokensOf(hb0.captured[1].raw),
            32_768,
            "B turn 1: starved budget restored to the ceiling (watermark hit must not discard it)",
        );
        void ra;
    } finally {
        if (savedEnv === undefined) delete process.env[ENV];
        else process.env[ENV] = savedEnv;
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
});
