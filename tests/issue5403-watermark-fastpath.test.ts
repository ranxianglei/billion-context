// #5418 hermetic A/B golden — watermark fastpath vs legacy pipeline parity.
//
// Two identical proxies receive an IDENTICAL request loop through the same
// scripted client:
//   PHASE A: pluginFullResendWatermark rollout OFF  → legacy full-resend path
//   PHASE B: rollout ON (env force)                  → fastpath (stamped hits)
// The client echoes x-bili-pf-seq back as x-bili-pf-count exactly like the dsh
// native interceptor does, so Phase B reaches steady-state HIT turns.
//
// Invariants pinned:
//   1. OUTBOUND byte equality: every upstream body is byte-identical modulo
//      kernel time="…" attributes (the sanctioned normalization clause).
//   2. Watermark headers never leak past the proxy to the model endpoint.
//   3. Phase B stamps accumulate per measured wire length; Phase A emits none.
//   4. RESIDENCY BAND: after steady state the fastpath proxy pins only the
//      tail window while the legacy proxy pins the full working copy
//      (/__bili/memory breakdown.lastMessages < 0.8× legacy).
//   5. The corpus contains repeated base content across turns (ClusterCounter
//      rekey continuation) and a multipart seam tail (K=1 merge guard).
//
// The script runs inside a node:test `test()` registration: bili installs a
// global uncaughtException handler that can swallow top-level rejections on
// plain `node <file>` runs, so failures must attribute to a registered test.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { closeServers } from "./server-close-guard.ts";

const ENV = "BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK";

interface Capture { raw: string; headerKeys: string[] }

function makeUpstream(sink: Capture[]) {
    return http.createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            sink.push({ raw: data, headerKeys: Object.keys(req.headers).map((k) => k.toLowerCase()) });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test", object: "chat.completion", created: 1, model: "model-test",
                choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
            }));
        });
    });
}

interface Harness { root: string; captured: Capture[]; upstream: http.Server }

interface Harness2 extends Harness { store: SessionStore }

function makeHarness(tag: string): Harness2 {
    _resetStoreForTest();
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const root = mkdtempSync(path.join(os.tmpdir(), `pfab-${tag}-`));
    for (const k of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[k] = root;
    const store = new SessionStore({ dir: path.join(root, "sessions"), enabled: false });
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
        port: 0, host: "127.0.0.1", upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { "model-test": { context: 64_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true, debug: true, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    return { proxy, origin: `http://127.0.0.1:${paddr.port}`, upstreamUrl };
}

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function scriptTurns(): Array<{ messages: unknown[]; max_tokens: number; stream: boolean }> {
    // TURN 3 repeats TURN 1's text VERBATIM (repeated-base ClusterCounter rekey
    // continuation); TURN 5 tails with a multipart content array (text + image)
    // exercising the K=1 seam / merge guard when it lands.
    const lines = ["alpha", "beta", "alpha", "gamma", "delta", "epsilon", "zeta", "eta"];
    const turns: Array<{ messages: unknown[]; max_tokens: number; stream: boolean }> = [];
    for (let t = 0; t < lines.length; t++) {
        const history: unknown[] = [{ role: "system", content: "You are TestBuddy v2." }];
        for (let i = 0; i <= t; i++) {
            history.push({ role: "user", content: lines[i] });
            if (i < t) history.push({ role: "assistant", content: `ack ${i}` });
        }
        if (t === 4) {
            const last = history[history.length - 1] as { content: unknown };
            last.content = [
                { type: "text", text: last.content },
                { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
            ];
        }
        turns.push({ messages: history, max_tokens: 64_000, stream: false });
    }
    return turns;
}

// The only sanctioned normalization: kernel time="…" attributes carry wall
// clock and differ run-to-run; nothing else may differ. Captured bodies are
// JSON, so the quotes arrive escaped (time=\"…\"); match both forms (#5471).
function normalize(raw: string): string {
    return raw.replace(/\stime=\\?"[0-9T:.Z+\-]+\\?"/g, ' time="X"');
}

// The v2 identity channel needs the client's own stable msgids per element.
// Hermetic stand-in for host-minted ids: a FNV-1a hash of the element BYTES
// (same message ⇒ same id; edited/minted ⇒ new id — the server treats that
// as a legit prevId break and self-heals, exactly like a real host would).
function idOf(el: unknown): string {
    const s = JSON.stringify(el);
    let h = 0x811c9dc5;
    for (let k = 0; k < s.length; k++) {
        h ^= s.charCodeAt(k);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `eid-${h.toString(16)}`;
}

async function runClient(origin: string, upstreamUrl: string, sid: string, turns: Array<{ messages: unknown[]; max_tokens: number; stream: boolean }>): Promise<(number | null)[]> {
    const stamps: (number | null)[] = [];
    for (let i = 0; i < turns.length; i++) {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": sid,
            "x-bili-plugin": "dsh",
        };
        const prev = stamps[stamps.length - 1];
        if (prev !== null && prev !== undefined) headers["x-bili-pf-count"] = String(prev);
        const ids = (turns[i].messages as unknown[]).map(idOf);
        if (prev !== null && prev !== undefined && ids.length >= prev) {
            headers["x-bili-pf-tail-ids"] = ids.slice(prev - 1).map(encodeURIComponent).join(",");
        }
        const res = await fetch(`${origin}/bili/${upstreamUrl}/v1/chat/completions`, {
            method: "POST", headers, body: JSON.stringify(turns[i]),
        });
        assert.equal(res.status, 200, `turn ${i}: proxy answers 200`);
        const s = res.headers.get("x-bili-pf-seq");
        stamps.push(s !== null && /^\d+$/.test(s) ? Number(s) : null);
        await res.arrayBuffer();
    }
    return stamps;
}

test("#5418 A/B byte-equality + residency band (hermetic dual-proxy)", async () => {
    const savedEnv = process.env[ENV];
    const roots: string[] = [];
    try {
        // ---------- PHASE A: feature OFF (legacy full-resend) ----------
        delete process.env[ENV];
        const ha0 = makeHarness("phase-a"); roots.push(ha0.root);
        const ha = await bringUp(ha0);
        const ra = await runClient(ha.origin, ha.upstreamUrl, "pfab-phase-a", scriptTurns());
        const memA = (await (await fetch(`${ha.origin}/__bili/memory`)).json()) as { breakdown: { lastMessages: number } };
        ha0.store.cancelAll();
        await closeServers([ha.proxy, ha0.upstream], "pfab phase-a");

        // ---------- PHASE B: feature ON (fastpath stamped hits) ----------
        process.env[ENV] = "1";
        const hb0 = makeHarness("phase-b"); roots.push(hb0.root);
        const hb = await bringUp({ ...hb0, debug: true } as typeof hb0);
        const rb = await runClient(hb.origin, hb.upstreamUrl, "pfab-phase-b", scriptTurns());
        const memB = (await (await fetch(`${hb.origin}/__bili/memory`)).json()) as { breakdown: { lastMessages: number } };
        hb0.store.cancelAll();
        await closeServers([hb.proxy, hb0.upstream], "pfab phase-b");

        // ---------- invariants ----------
        assert.equal(ha0.captured.length, 8, "legacy served all 8 turns");
        assert.equal(hb0.captured.length, 8, "fastpath served all 8 turns");
        ra.forEach((s, i) => assert.equal(s, null, `A stamp ${i}: legacy path must not stamp`));
        const corpus = scriptTurns();
        for (let i = 0; i < 8; i++) {
            // The stamp is THIS TURN'S measured wire total (full resends grow
            // monotonically by one appended element).
            assert.equal(rb[i], corpus[i].messages.length, `B stamp ${i}: measured wire total`);
        }
        const diffI = (() => {
            for (let i = 0; i < 8; i++) {
                if (normalize(hb0.captured[i].raw) !== normalize(ha0.captured[i].raw)) return i;
            }
            return -1;
        })();
        if (diffI >= 0) {
            // triage aid: leave the first diverging pair on disk (CI-safe tmpdir)
            writeFileSync(path.join(os.tmpdir(), `pfab-diff-${process.pid}-${Date.now()}.txt`),
                `=== turn ${diffI} A(legacy) ===\n${ha0.captured[diffI].raw.slice(0, 4000)}\n\n=== turn ${diffI} B(fastpath) ===\n${hb0.captured[diffI].raw.slice(0, 4000)}\n`);
        }
        for (let i = 0; i < 8; i++) {
            assert.equal(normalize(hb0.captured[i].raw), normalize(ha0.captured[i].raw),
                `turn ${i}: outbound bytes diverge between fastpath and legacy`);
            for (const o of [ha0.captured[i], hb0.captured[i]]) {
                assert.ok(!o.headerKeys.includes("x-bili-pf-count"), "x-bili-pf-count leaked past the proxy");
                assert.ok(!o.headerKeys.includes("x-bili-pf-seq"), "x-bili-pf-seq leaked past the proxy");
                assert.ok(!o.headerKeys.includes("x-bili-pf-tail-ids"), "x-bili-pf-tail-ids leaked past the proxy");
            }
        }
        assert.ok(memA.breakdown.lastMessages > 0, "legacy pinned resident history");
        assert.ok(memB.breakdown.lastMessages > 0, "fastpath pinned the tail window");
        assert.ok(memB.breakdown.lastMessages < 0.8 * memA.breakdown.lastMessages,
            `residency band violated: fastpath ${memB.breakdown.lastMessages} >= 0.8 x legacy ${memA.breakdown.lastMessages}`);
    } finally {
        if (savedEnv === undefined) delete process.env[ENV];
        else process.env[ENV] = savedEnv;
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
});
