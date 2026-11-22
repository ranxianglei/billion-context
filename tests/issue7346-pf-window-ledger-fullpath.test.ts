// #7346 full-path regression: a watermark-HIT turn must not retire the
// verified prefix.
//
// The sibling test (issue7346-pf-window-ledger.test.ts) pins the #3285
// sweep/no-sweep contract by calling shadow.record directly with the two
// rawTail shapes (undefined = the fix, window = pre-fix). It simulates the
// fix's downstream effect (rawTail=undefined => no sweep) but never drives
// prepareOpenai, so it would not fail if the fix line
// `if (wpHit !== undefined) session.lastMessagesFolded = true`
// (src/server/prepare-openai.ts) were removed.
//
// This test drives a REAL watermark-HIT turn through the full proxy in
// shadow mode:
//   turn 0: sidecar (4K budget) -> rides the side lane, never stamped;
//   turn 1: full resend -> the watermark is stamped (x-bili-pf-seq) and the
//           full log is ingested (the verified prefix);
//   turn 2: the client echoes x-bili-pf-count -> a HIT. prepareOpenai pins
//           only this turn's ~2-row window; the fix marks it non-raw so
//           persist's durability ingest (ingestRowsNow) omits the raw tail
//           and the #3285 sweep never fires.
// Asserts the verified prefix survives in the ledger after the HIT turn.
// Fails if the fix line is removed (the window save would then sweep the
// prefix, leaving only the ~2-row window).

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
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { closeServers } from "./server-close-guard.ts";

const ROLLOUT_ENV = "BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK";
const UNIFIED_ENV = "BILI_STORAGE_UNIFIED";

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

interface Harness { root: string; captured: Capture[]; upstream: http.Server; store: SessionStore }

function makeHarness(tag: string): Harness {
    _resetStoreForTest();
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const root = mkdtempSync(path.join(os.tmpdir(), `pfwp-${tag}-`));
    for (const k of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[k] = root;
    // enabled:true so the store opens its shadow (the constructor gates the
    // shadow on this.enabled && !unifiedBlockedByEncryption).
    const store = new SessionStore({ dir: path.join(root, "sessions"), enabled: true });
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

// Three turns: turn 0 is the sidecar (4K budget, unstamped), turn 1 is the
// first full resend (stamped), turn 2 is the HIT (the client echoes the
// stamp). The history grows by one user + one assistant per turn.
function scriptTurns(): Array<{ messages: unknown[]; max_tokens: number; stream: boolean }> {
    const lines = ["alpha", "beta", "gamma"];
    const turns: Array<{ messages: unknown[]; max_tokens: number; stream: boolean }> = [];
    for (let t = 0; t < lines.length; t++) {
        const history: unknown[] = [{ role: "system", content: "You are TestBuddy v2." }];
        for (let i = 0; i <= t; i++) {
            history.push({ role: "user", content: lines[i] });
            if (i < t) history.push({ role: "assistant", content: `ack ${i}` });
        }
        turns.push({ messages: history, max_tokens: t === 0 ? 4_096 : 64_000, stream: false });
    }
    return turns;
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

/** Windows cannot unlink a directory while index.db is open (the shadow
 *  UnifiedStore holds a file lock); rmSync with bounded retries, swallowed on
 *  persistent EBUSY (same pattern as #3397/#4986/#6780). */
function rmBestEffort(p: string): void {
    try {
        rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

test("#7346 full-path: a watermark-HIT window save keeps the verified prefix in the ledger", async () => {
    const savedRollout = process.env[ROLLOUT_ENV];
    const savedUnified = process.env[UNIFIED_ENV];
    const roots: string[] = [];
    const sid = "7346-fullpath-sid";
    let h0: Harness | undefined;
    try {
        process.env[ROLLOUT_ENV] = "1";
        process.env[UNIFIED_ENV] = "shadow";
        h0 = makeHarness("fullpath");
        roots.push(h0.root);
        const h = await bringUp(h0);
        const stamps = await runClient(h.origin, h.upstreamUrl, sid, scriptTurns());
        // Turn 0 is the sidecar (unstamped); turn 1 must stamp the watermark.
        assert.equal(stamps[0], null, "turn 0: side lane must not stamp");
        assert.ok(stamps[1] !== null, "turn 1: full resend must stamp the watermark");
        // Turn 2 echoes the stamp -> a HIT.
        assert.ok(stamps[1]! > 0, "turn 1 stamp is a positive wire total");
        // Let the debounced save settle (the durability ingest already ran
        // synchronously in prepareOpenai; the debounced save is a belt-and-
        // braces second ingest of the same state).
        await new Promise((r) => setTimeout(r, 50));
        h0.store.cancelAll();
        // Query the ledger in a separate reader connection (SQLite WAL allows
        // concurrent readers while the proxy's writer is open).
        const db = UnifiedStore.open(path.join(h0.root, "sessions", "index.db"));
        try {
            const rows = db.getMessages(sid);
            // With the fix: the verified prefix (turn 1's full log) survives
            // the HIT window save -> 6 live rows (system + 2 user + 2
            // assistant + the HIT turn's 2 new). Without the fix: the window
            // save sweeps the prefix -> only the ~2-row window remains.
            assert.ok(rows.length > 2,
                `the verified prefix must survive the HIT window save (got ${rows.length} live rows)`);
        } finally {
            db.close();
        }
        await closeServers([h.proxy, h0.upstream], "7346 fullpath");
    } finally {
        if (savedRollout === undefined) delete process.env[ROLLOUT_ENV];
        else process.env[ROLLOUT_ENV] = savedRollout;
        if (savedUnified === undefined) delete process.env[UNIFIED_ENV];
        else process.env[UNIFIED_ENV] = savedUnified;
        // Release the shadow's index.db handle before cleanup — Windows cannot
        // unlink a directory while the SQLite file is locked (#3397 class).
        h0?.store.closeQuietly();
        for (const root of roots) rmBestEffort(root);
    }
});
