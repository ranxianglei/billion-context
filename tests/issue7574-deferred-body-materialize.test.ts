// #7574 item 1 — a request of 1 MiB or more that carries a watermark
// handshake header (x-bili-pf-count / x-bili-pf-delta / x-bili-pf-tail-ids)
// used to crash with 502 "wireMessages is not iterable" whenever the
// watermark fast path could NOT answer it: plain proxy sessions, plugin
// sessions on a title-generation turn, sessions under proxy compression,
// and every session while the watermark rollout is off. The upstream was
// never reached.
//
// Cause: handle.ts skips JSON.parse of the big body for such requests and
// hands prepareOpenai a top-level object whose `messages` is null. The
// decode back into a full body lived INSIDE the fast path's own gate, so
// every request that gate turned away went on with `messages: null`.
//
// Same root, second symptom: on a fast-path HIT the old code rebuilt the
// whole top-level object from the RAW wire text, resurrecting fields the
// proxy had deliberately removed for this turn (the dsh_* extensions that
// #7168/#7439 strip so they are never forwarded). The rebuilt body must
// carry exactly what the ordinary path would have forwarded.
//
// Method: one proxy with the rollout on (env force) serves every "was 502"
// shape; a second proxy with the rollout off serves the plugin shapes that
// used to crash while the feature was off. Every answer must be 200 and the
// upstream must receive the full conversation.

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
import { setLogCapture } from "../src/logger.ts";
import { closeServers } from "./server-close-guard.ts";

const ENV = "BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK";
const MODEL = "model-test";

interface Capture {
    raw: string;
}
interface Harness {
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
                    model: MODEL,
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

function makeHarness(tag: string): Harness {
    _resetStoreForTest();
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const root = mkdtempSync(path.join(os.tmpdir(), `dfr-${tag}-`));
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

async function bringUp(h: Harness) {
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
                models: { [MODEL]: { context: 400_000, output: 32_768 } },
            },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
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

/** A conversation of `count` messages, well past the 1 MiB deferral line. */
function bigHistory(count: number): unknown[] {
    const filler = "x".repeat(220_000);
    const history: unknown[] = [{ role: "system", content: "You are TestBuddy v2." }];
    for (let i = 0; i < count - 1; i++) {
        history.push({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `message-${i} ${filler}`,
        });
    }
    return history;
}

interface Sent {
    status: number;
    body: string;
    pfSeq: number | null;
}

async function send(
    origin: string,
    upstreamUrl: string,
    sid: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
): Promise<Sent> {
    const res = await fetch(`${origin}/bili/${upstreamUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-acp-session": sid,
            ...headers,
        },
        body: JSON.stringify(body),
    });
    const s = res.headers.get("x-bili-pf-seq");
    const out: Sent = {
        status: res.status,
        body: await res.text(),
        pfSeq: s !== null && /^\d+$/.test(s) ? Number(s) : null,
    };
    return out;
}

function upstreamBody(h: Harness, index: number): Record<string, unknown> {
    const parsed = JSON.parse(h.captured[index].raw) as Record<string, unknown>;
    return parsed;
}

test("#7574 a deferred big body is always decoded back before it is forwarded", async () => {
    const savedEnv = process.env[ENV];
    const roots: string[] = [];
    const lines: string[] = [];
    setLogCapture((_level, msg) => {
        lines.push(msg);
    });
    try {
        // ---------- proxy 1: watermark rollout ON ----------
        process.env[ENV] = "1";
        const on0 = makeHarness("on");
        roots.push(on0.root);
        const on = await bringUp(on0);
        try {
            // (1) plain proxy session + stamped count.
            const a = await send(
                on.origin,
                on.upstreamUrl,
                "dfr-plain-count",
                { model: MODEL, stream: false, messages: bigHistory(6) },
                { "x-bili-pf-count": "4" },
            );
            assert.equal(a.status, 200, `plain + pf-count: ${a.body}`);
            assert.equal(
                (upstreamBody(on0, 0).messages as unknown[]).length,
                6,
                "plain + pf-count: upstream got the whole conversation",
            );

            // (2) plain proxy session + tail ids.
            const hist2 = bigHistory(6);
            const ids2 = hist2.map(idOf);
            const b = await send(
                on.origin,
                on.upstreamUrl,
                "dfr-plain-tail",
                { model: MODEL, stream: false, messages: hist2 },
                { "x-bili-pf-tail-ids": ids2.slice(4).map(encodeURIComponent).join(",") },
            );
            assert.equal(b.status, 200, `plain + pf-tail-ids: ${b.body}`);
            assert.equal(
                (upstreamBody(on0, 1).messages as unknown[]).length,
                6,
                "plain + pf-tail-ids: upstream got the whole conversation",
            );

            // (3) plugin session that asked for the proxy compression channel.
            const c = await send(
                on.origin,
                on.upstreamUrl,
                "dfr-plugin-proxy",
                { model: MODEL, stream: false, messages: bigHistory(6) },
                {
                    "x-bili-plugin": "hermes",
                    "x-bili-plugin-compression": "proxy",
                    "x-bili-pf-count": "4",
                },
            );
            assert.equal(c.status, 200, `plugin + proxy compression + pf-count: ${c.body}`);
            assert.equal(
                (upstreamBody(on0, 2).messages as unknown[]).length,
                6,
                "plugin + proxy compression: upstream got the whole conversation",
            );

            // (4) plugin title-generation turn (max_tokens <= 200).
            const d = await send(
                on.origin,
                on.upstreamUrl,
                "dfr-plugin-title",
                { model: MODEL, stream: false, max_tokens: 100, messages: bigHistory(6) },
                { "x-bili-plugin": "opencode", "x-bili-pf-count": "4" },
            );
            assert.equal(d.status, 200, `plugin title-gen + pf-count: ${d.body}`);
            assert.equal(
                (upstreamBody(on0, 3).messages as unknown[]).length,
                6,
                "plugin title-gen: upstream got the whole conversation",
            );

            // (5) fast-path HIT keeps the proxy's top-level decisions: the
            // dsh_* extension fields of turn 0 are gone on turn 1 too.
            const t0 = {
                model: MODEL,
                stream: false,
                messages: bigHistory(6),
                dsh_session_log: "x".repeat(300_000),
                dsh_foo: { a: 1 },
            };
            assert.ok(JSON.stringify(t0).length >= 1_048_576, "turn 0 is past the deferral line");
            const e0 = await send(on.origin, on.upstreamUrl, "dfr-hit", t0, {
                "x-bili-plugin": "dsh",
            });
            assert.equal(e0.status, 200, `hit turn 0: ${e0.body}`);
            assert.equal(e0.pfSeq, 6, "turn 0 stamps the wire total");
            assert.deepEqual(
                Object.keys(upstreamBody(on0, 4)),
                ["model", "stream", "messages"],
                "turn 0 (no handshake header) forwards no dsh_* field",
            );

            const t1Hist = [...t0.messages, { role: "user", content: "tail question" }];
            const t1Ids = t1Hist.map(idOf);
            lines.length = 0;
            const e1 = await send(
                on.origin,
                on.upstreamUrl,
                "dfr-hit",
                { ...t0, messages: t1Hist },
                {
                    "x-bili-plugin": "dsh",
                    "x-bili-pf-count": "6",
                    "x-bili-pf-tail-ids": t1Ids.slice(5).map(encodeURIComponent).join(","),
                },
            );
            assert.equal(e1.status, 200, `hit turn 1: ${e1.body}`);
            assert.ok(
                lines.some((l) => l.includes("[dfr-hit]") && l.includes("fastpath HIT")),
                "turn 1 was answered by the fast path",
            );
            const up1 = upstreamBody(on0, 5);
            assert.deepEqual(
                Object.keys(up1),
                ["model", "stream", "messages"],
                "the rebuilt body carries exactly the ordinary path's fields, in wire order",
            );
            assert.equal(
                Object.keys(up1).filter((k) => k.startsWith("dsh_")).length,
                0,
                "a hit never resurrects the stripped dsh_* extensions",
            );
            assert.equal(
                (up1.messages as unknown[]).length,
                7,
                "hit turn 1: upstream got the whole conversation",
            );
        } finally {
            on0.store.cancelAll();
            await closeServers([on.proxy, on0.upstream], "dfr rollout-on");
        }

        // ---------- proxy 2: watermark rollout OFF ----------
        process.env[ENV] = "0";
        const off0 = makeHarness("off");
        roots.push(off0.root);
        const off = await bringUp(off0);
        try {
            const hist = bigHistory(6);
            const f = await send(off.origin, off.upstreamUrl, "dfr-off-count", {
                model: MODEL,
                stream: false,
                messages: hist,
            }, { "x-bili-plugin": "dsh", "x-bili-pf-count": "4" });
            assert.equal(f.status, 200, `rollout off, plugin + pf-count: ${f.body}`);
            assert.equal(
                (upstreamBody(off0, 0).messages as unknown[]).length,
                6,
                "rollout off, plugin + pf-count: upstream got the whole conversation",
            );

            const g = await send(off.origin, off.upstreamUrl, "dfr-off-tail", {
                model: MODEL,
                stream: false,
                messages: hist,
            }, {
                "x-bili-plugin": "dsh",
                "x-bili-pf-tail-ids": hist.map(idOf).slice(4).map(encodeURIComponent).join(","),
            });
            assert.equal(g.status, 200, `rollout off, plugin + pf-tail-ids: ${g.body}`);
            assert.equal(
                (upstreamBody(off0, 1).messages as unknown[]).length,
                6,
                "rollout off, plugin + pf-tail-ids: upstream got the whole conversation",
            );
        } finally {
            off0.store.cancelAll();
            await closeServers([off.proxy, off0.upstream], "dfr rollout-off");
        }
    } finally {
        setLogCapture(null);
        if (savedEnv === undefined) delete process.env[ENV];
        else process.env[ENV] = savedEnv;
        for (const r of roots) rmSync(r, { recursive: true, force: true });
    }
});
