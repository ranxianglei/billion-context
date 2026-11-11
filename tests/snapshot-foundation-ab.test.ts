// #5874 T4 — A/B byte parity: snapshot-table foundation vs legacy pipeline.
//
// Two identical proxies receive an IDENTICAL scripted request loop:
//   PHASE A: foundation OFF (rollout env force) → legacy full-resend path
//   PHASE B: foundation ON (master+lane env force) → the six-stage flow:
//      world issue (arm) → per-turn reconcile + single-tx commit → the
//      outbound prefix renders from the ACTIVE ROWS (table bytes) → a
//      plugin-endpoint fold (the §4.2 first scene) → post-fold resend.
//
// Invariants pinned:
//   1. OUTBOUND byte equality: every upstream body is byte-identical
//      modulo kernel time="…" attributes (the sanctioned normalization).
//   2. x-bili-snapshot decision header is client-visible in Phase B
//      (arm/hit) and absent upstream in BOTH phases.
//   3. R3: an enrolled session without the msgid envelope is hard-rejected
//      with 400 SNAPSHOT_ENVELOPE_FAULT (zero side effects) and the NEXT
//      well-formed turn arms normally.
//   4. /__bili/status carries the per-session plane: green, rows for every
//      surviving element + the fold pair, and a checkpoint from the fold.
//
// The corpus: five stable-resend growth turns (system + u0..u4 with acks),
// then a compress fold of m00001–m00004 (u0,a0,u1,a1) through the plugin
// endpoint, then the post-fold resend [u2,a2,u3,a3,u4, tool-call, tool-result]
// — pi's real post-fold shape. Phase A runs the identical scripted sequence
// on the legacy path (its plugin fold is the pre-existing behavior), so the
// fold turn is compared too: the summary content rides the host's own
// tool-result element in both phases.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { closeServers } from "./server-close-guard.ts";
// The CI test baseline pins BILI_STORAGE_UNIFIED=legacy (tests/preload-storage-baseline.mjs,
// #4011 lesson): a suite whose assertions depend on a specific storage mode MUST pin its own
// mode. The unified sqlite sidecar is the substrate both phases run on.
process.env.BILI_STORAGE_UNIFIED = "full";


const ENV_MASTER = "BILI_ROLLOUT_SNAPSHOT_FOUNDATION";
const ENV_LANE = "BILI_ROLLOUT_SNAPSHOT_LANE";
const ENV_WP = "BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK";

// Windows can still hold an ephemeral handle on index.db/-wal right after a
// store closes (Defender scan, delayed close), so a bare rmSync throws EBUSY
// and fails an otherwise green run. Retry, then give up quietly: the dir lives
// under the OS temp root, which the after hook cannot hold hostage.
function rmrf(p: string): void {
    try {
        rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* Windows stray handle */
    }
}

function closePhase(s: { store: { cancelAll(): void; closeQuietly(): void } }): void {
    s.store.cancelAll();
    s.store.closeQuietly();
}
const ENV_SR = "BILI_ROLLOUT_SNAPSHOT_RENDER";

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

interface Harness2 { root: string; store: SessionStore; captured: Capture[]; upstream: http.Server }

function makeHarness(tag: string): Harness2 {
    _resetStoreForTest();
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const root = mkdtempSync(path.join(os.tmpdir(), `snapab-${tag}-`));
    for (const k of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[k] = root;
    // enabled:true in BOTH phases: the unified sqlite sidecar is the
    // foundation's substrate; the A/B contrast is the rollout env only.
    const store = new SessionStore({ dir: path.join(root, "sessions"), enabled: true });
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
        // The hermetic corpus is far below the kernel's fold floors
        // (minCompressRange 5000 chars / preserveRecentTokens 5000): disable
        // both so the scripted fold m00001–m00004 is eligible (production
        // defaults untouched — the gates are per-install config).
        kernelConfig: {
            ...defaultConfig(200_000),
            compress: { ...defaultConfig(200_000).compress, minCompressRange: 0 },
            preserveRecentTokens: 0,
        },
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

const LINES = ["line-1", "line-2", "line-3", "line-4", "line-5"];
const SYSTEM = { role: "system", content: "You are TestBuddy v2." };
// Filler so the folded range (4 msgs) comfortably beats the kernel's
// net-shrink gate (summary < range, in tokens): ~800 chars / ~200 tokens
// per user msg, ~420 chars / ~105 tokens per assistant msg, vs an ~110-char
// summary.
const elUser = (i: number) => ({ role: "user", content: `${LINES[i]} ` + "payload ".repeat(100) });
const elAsst = (i: number) => ({ role: "assistant", content: `ack ${i} ` + "confirmation ".repeat(30) });
// pi's post-fold history tail: the model's own compress tool-call + the tool
// result carrying the summary (the carrier — stripKernelSummaries pairs it
// with the block's compressCallId via the explicit toolCallId below).
const FOLD_ARGS = '{"content":"m00001\\u2013m00004 warmup\\nThe first two exchanges were a warm-up (line-1 / line-2 and the acks); the rest is the real work."}';
const FOLD_CALL = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_fold_1", type: "function", function: { name: "compress", arguments: FOLD_ARGS } }],
};
const FOLD_RESULT = { role: "tool", tool_call_id: "call_fold_1", content: "Compressed m00001\u2013m00004 (1 block, 4 messages folded)." };

type Turn = { messages: unknown[]; max_tokens: number; stream: boolean };

function growthTurn(t: number): Turn {
    const messages: unknown[] = [SYSTEM];
    for (let i = 0; i <= t; i++) {
        messages.push(elUser(i));
        if (i < t) messages.push(elAsst(i));
    }
    return { messages, max_tokens: 64_000, stream: false };
}

/** Turn 5: post-fold resend — pi's history is APPEND-ONLY: the covered
 *  messages stay and the fold pair is appended. The kernel view = [u0 (pinned
 *  first-user core, never hidden), u2..u4, FOLD_CALL, FOLD_RESULT] — a0/u1/a1
 *  hidden by the block, no rendered summary (the compress call is visible in
 *  the resend → the tool result carries the fold). */
function foldTurn(): Turn {
    return {
        messages: [SYSTEM, elUser(0), elAsst(0), elUser(1), elAsst(1), elUser(2), elAsst(2), elUser(3), elAsst(3), elUser(4), FOLD_CALL, FOLD_RESULT],
        max_tokens: 64_000,
        stream: false,
    };
}

// The only sanctioned normalization: kernel time="…" attributes carry wall
// clock (space between date and time per the tag contract); nothing else may
// differ. (Same clause as the #5418 golden.)
function normalize(raw: string): string {
    return raw.replace(/\stime=\\?"[0-9T:.Z+\- ]+\\?"/g, ' time="X"');
}

// Hermetic stand-in for host-minted msgids: FNV-1a of the element BYTES
// (same element ⇒ same id — the stable-resend assumption the foundation
// exists for).
function idOf(el: unknown): string {
    const s = JSON.stringify(el);
    let h = 0x811c9dc5;
    for (let k = 0; k < s.length; k++) {
        h ^= s.charCodeAt(k);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `eid-${h.toString(16)}`;
}

async function sendModel(origin: string, upstreamUrl: string, sid: string, turn: Turn, withIds: boolean): Promise<{ status: number; snap: string | null; text: string }> {
    const nonSys = (turn.messages as Array<{ role?: string }>).filter((m) => m.role !== "system");
    const payload: Record<string, unknown> = { messages: turn.messages, max_tokens: turn.max_tokens, stream: turn.stream };
    if (withIds) payload["biliMsgIds"] = nonSys.map(idOf);
    const res = await fetch(`${origin}/bili/${upstreamUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-acp-session": sid,
            "x-bili-plugin": "pi",
        },
        body: JSON.stringify(payload),
    });
    const snap = res.headers.get("x-bili-snapshot");
    const text = await res.text();
    return { status: res.status, snap, text };
}

async function callCompress(origin: string, sid: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${origin}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            conversationId: sid,
            tool: "compress",
            // The explicit host call id becomes the block's compressCallId —
            // the carrier pairing stripKernelSummaries checks on the
            // post-fold resend (the synthetic plugin_<ts> id could never be
            // echoed by a scripted client).
            toolCallId: "call_fold_1",
            args: {
                content: "m00001\u2013m00004 warmup\nThe first two exchanges were a warm-up (line-1 / line-2 and the acks); the rest is the real work.",
            },
        }),
    });
    const text = await res.text();
    return { status: res.status, text };
}

test("#5874 T4: foundation vs legacy A/B byte parity (hermetic dual-proxy + fold)", async () => {
    const saved: Record<string, string | undefined> = {
        [ENV_MASTER]: process.env[ENV_MASTER],
        [ENV_LANE]: process.env[ENV_LANE],
        [ENV_WP]: process.env[ENV_WP],
        [ENV_SR]: process.env[ENV_SR],
    };
    const roots: string[] = [];
    const turns: Turn[] = [growthTurn(0), growthTurn(1), growthTurn(2), growthTurn(3), growthTurn(4), foldTurn()];
    try {
        // ---------- PHASE A: foundation OFF (legacy) ----------
        process.env[ENV_MASTER] = "0";
        process.env[ENV_LANE] = "0";
        process.env[ENV_WP] = "0"; // isolate the watermark fastpath (5% default could hit)
        process.env[ENV_SR] = "0"; // isolate the #3756 snapshot-render lane
        const ha0 = makeHarness("phase-a");
        roots.push(ha0.root);
        const ha = await bringUp(ha0);
        for (let i = 0; i < 5; i++) {
            const r = await sendModel(ha.origin, ha.upstreamUrl, "snapab-a", turns[i], true);
            assert.equal(r.status, 200, `A turn ${i}: proxy answers 200 (${r.text.slice(0, 300)})`);
            assert.equal(r.snap, null, `A turn ${i}: legacy must not emit x-bili-snapshot`);
        }
        const cfA = await callCompress(ha.origin, "snapab-a");
        assert.equal(cfA.status, 200, `A fold: 200 (${cfA.text.slice(0, 300)})`);
        assert.equal(JSON.parse(cfA.text)["ok"], true, `A fold: ok=true (${cfA.text.slice(0, 300)})`);
        {
            const r = await sendModel(ha.origin, ha.upstreamUrl, "snapab-a", turns[5], true);
            assert.equal(r.status, 200, `A turn 5: 200 (${r.text.slice(0, 300)})`);
            assert.equal(r.snap, null, "A turn 5: no foundation header");
        }
        closePhase(ha0);
        await closeServers([ha.proxy, ha0.upstream], "snapab phase-a");

        // ---------- PHASE B: foundation ON ----------
        process.env[ENV_MASTER] = "1";
        process.env[ENV_LANE] = "1";
        process.env[ENV_WP] = "0";
        process.env[ENV_SR] = "0";
        const hb0 = makeHarness("phase-b");
        roots.push(hb0.root);
        const hb = await bringUp(hb0);
        const bTokens: string[] = [];
        for (let i = 0; i < 5; i++) {
            const r = await sendModel(hb.origin, hb.upstreamUrl, "snapab-b", turns[i], true);
            assert.equal(r.status, 200, `B turn ${i}: proxy answers 200 (${r.text.slice(0, 300)})`);
            bTokens.push(r.snap ?? "");
        }
        const cfB = await callCompress(hb.origin, "snapab-b");
        assert.equal(cfB.status, 200, `B fold: 200 (${cfB.text.slice(0, 300)})`);
        assert.equal(JSON.parse(cfB.text)["ok"], true, `B fold: ok=true (${cfB.text.slice(0, 300)})`);
        {
            const r = await sendModel(hb.origin, hb.upstreamUrl, "snapab-b", turns[5], true);
            assert.equal(r.status, 200, `B turn 5: 200 (${r.text.slice(0, 300)})`);
            bTokens.push(r.snap ?? "");
        }
        // R3 on a SEPARATE enrolled session: no envelope → hard 400, zero
        // side effects; the next well-formed turn arms normally (1 fault <
        // the 3-fault breaker window).
        {
            const bad = await sendModel(hb.origin, hb.upstreamUrl, "snapab-b-r3", turns[0], false);
            assert.equal(bad.status, 400, `R3: enrolled session without envelope → 400 (${bad.text.slice(0, 200)})`);
            const e = JSON.parse(bad.text) as { error?: { code?: string } };
            assert.equal(e.error?.code, "SNAPSHOT_ENVELOPE_FAULT");
            assert.equal(bad.snap, "SNAPSHOT_ENVELOPE_FAULT", "R3: the code rides the decision header");
            const good = await sendModel(hb.origin, hb.upstreamUrl, "snapab-b-r3", turns[0], true);
            assert.equal(good.status, 200, `R3: next well-formed turn arms (${good.text.slice(0, 300)})`);
            assert.equal(good.snap, "arm");
        }
        const status = (await (await fetch(`${hb.origin}/__bili/status`)).json()) as { snapshotFoundation?: Record<string, any> };
        closePhase(hb0);
        await closeServers([hb.proxy, hb0.upstream], "snapab phase-b");

        // ---------- invariants ----------
        assert.equal(ha0.captured.length, 6, "legacy served all 6 model turns");
        // 7 in Phase B: the 6 main turns + the R3 session's good turn
        // (its 400 turn never reached upstream — zero side effects).
        assert.equal(hb0.captured.length, 7, "foundation served 6 model turns + the R3 good turn");
        for (let i = 0; i < 6; i++) {
            const a = ha0.captured[i]!;
            const b = hb0.captured[i]!;
            if (normalize(b.raw) !== normalize(a.raw)) {
                writeFileSync(path.join(os.tmpdir(), `snapab-diff-${process.pid}-${Date.now()}.txt`),
                    `=== turn ${i} A(legacy) ===\n${a.raw.slice(0, 6000)}\n\n=== turn ${i} B(foundation) ===\n${b.raw.slice(0, 6000)}\n`);
            }
            assert.equal(normalize(b.raw), normalize(a.raw), `turn ${i}: outbound bytes diverge between foundation and legacy`);
            assert.ok(!a.headerKeys.includes("x-bili-snapshot"), "A: x-bili-snapshot leaked upstream");
            assert.ok(!b.headerKeys.includes("x-bili-snapshot"), "B: x-bili-snapshot leaked upstream");
        }
        // The R3 session's good turn (fresh session, same corpus turn 0)
        // must be byte-identical to the main session's turn 0: same
        // content, same FNV ids, fresh ledger ⇒ same m-refs.
        assert.equal(normalize(hb0.captured[6]!.raw), normalize(hb0.captured[0]!.raw), "R3 good turn re-baselines byte-identically");
        assert.deepEqual(bTokens, ["arm", "hit", "hit", "hit", "hit", "hit"], "decision tokens: arm then steady hits");

        const sf = status.snapshotFoundation;
        assert.ok(sf, "/__bili/status carries the snapshotFoundation section");
        assert.equal(sf.enrolled, true, "install-level enrollment is on");
        assert.equal(sf.master, true);
        assert.equal(sf.lane, true);
        const mine = ((sf.sessions ?? []) as Array<Record<string, any>>).find((s) => s.sessionId === "snapab-b");
        assert.ok(mine, "status lists the foundation session");
        assert.equal(mine.plane, "green");
        // After the fold: 5 survivors + 2 fold-pair elements = 7 active rows.
        assert.ok(mine.rowsActive >= 8, `active rows after fold: pinned head + 5 survivors + fold pair (got ${mine.rowsActive})`);
        assert.ok(mine.ckptSeq > 0, `fold committed a checkpoint (ckptSeq ${mine.ckptSeq})`);
        assert.ok(mine.envelopeElements >= 11, `world canon spans the full-resend fold turn (${mine.envelopeElements})`);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        for (const root of roots) rmrf(root);
    }
});

// #5874 T5 — scattered-NEW byte pin: a brand-new element inserted in the
// MIDDLE of the resent envelope (not the tail). The foundation must issue a
// fresh pos for it, keep every stored row's pos unchanged (prefix stability),
// and render the outbound prefix in HOST ENVELOPE ORDER — so the bytes stay
// identical to the legacy path, which simply forwards the resent history.
// This is the §4.1 span-parse hazard pinned at the byte level: a middle
// insertion must never shift a stored row.
test("#5874 T5: scattered NEW element (middle insertion) — outbound bytes stay pinned", async () => {
    const saved: Record<string, string | undefined> = {
        [ENV_MASTER]: process.env[ENV_MASTER],
        [ENV_LANE]: process.env[ENV_LANE],
        [ENV_WP]: process.env[ENV_WP],
        [ENV_SR]: process.env[ENV_SR],
    };
    const roots: string[] = [];
    const X = { role: "user", content: "INSERTED mid-history note " + "pad ".repeat(50) };
    const scatterTurn: Turn = {
        // u0 (known@1), X (NEW, inserted before a0), a0 (known@2 — its index
        // shifted but its pos must NOT).
        messages: [SYSTEM, elUser(0), X, elAsst(0)],
        max_tokens: 64_000,
        stream: false,
    };
    const turns: Turn[] = [growthTurn(0), growthTurn(1), scatterTurn];
    try {
        // ---------- PHASE A: foundation OFF (legacy) ----------
        process.env[ENV_MASTER] = "0";
        process.env[ENV_LANE] = "0";
        process.env[ENV_WP] = "0";
        process.env[ENV_SR] = "0";
        const ha0 = makeHarness("phase-a5");
        roots.push(ha0.root);
        const ha = await bringUp(ha0);
        for (let i = 0; i < turns.length; i++) {
            const r = await sendModel(ha.origin, ha.upstreamUrl, "snapab-a5", turns[i], true);
            assert.equal(r.status, 200, `A5 turn ${i}: 200 (${r.text.slice(0, 300)})`);
            assert.equal(r.snap, null, `A5 turn ${i}: legacy emits no x-bili-snapshot`);
        }
        closePhase(ha0);
        await closeServers([ha.proxy, ha0.upstream], "snapab phase-a5");

        // ---------- PHASE B: foundation ON ----------
        process.env[ENV_MASTER] = "1";
        process.env[ENV_LANE] = "1";
        process.env[ENV_WP] = "0";
        process.env[ENV_SR] = "0";
        const hb0 = makeHarness("phase-b5");
        roots.push(hb0.root);
        const hb = await bringUp(hb0);
        const bTokens: string[] = [];
        for (let i = 0; i < turns.length; i++) {
            const r = await sendModel(hb.origin, hb.upstreamUrl, "snapab-b5", turns[i], true);
            assert.equal(r.status, 200, `B5 turn ${i}: 200 (${r.text.slice(0, 300)})`);
            bTokens.push(r.snap ?? "");
        }
        closePhase(hb0);
        await closeServers([hb.proxy, hb0.upstream], "snapab phase-b5");

        // ---------- invariants ----------
        assert.equal(ha0.captured.length, turns.length, "legacy served all turns");
        assert.equal(hb0.captured.length, turns.length, "foundation served all turns");
        for (let i = 0; i < turns.length; i++) {
            const a = ha0.captured[i]!;
            const b = hb0.captured[i]!;
            if (normalize(b.raw) !== normalize(a.raw)) {
                writeFileSync(path.join(os.tmpdir(), `snapab5-diff-${process.pid}-${Date.now()}.txt`),
                    `=== turn ${i} A(legacy) ===\n${a.raw.slice(0, 6000)}\n\n=== turn ${i} B(foundation) ===\n${b.raw.slice(0, 6000)}\n`);
            }
            assert.equal(normalize(b.raw), normalize(a.raw), `turn ${i}: scattered-NEW outbound bytes diverge between foundation and legacy`);
            assert.ok(!a.headerKeys.includes("x-bili-snapshot"), "A5: x-bili-snapshot leaked upstream");
            assert.ok(!b.headerKeys.includes("x-bili-snapshot"), "B5: x-bili-snapshot leaked upstream");
        }
        // arm (turn 0) then hit (turns 1..2): the scatter turn is a steady hit,
        // not a resync/degrade — the middle insertion is a legal extend.
        assert.deepEqual(bTokens, ["arm", "hit", "hit"], `T5 decision tokens: arm then hits (got ${bTokens.join(",")})`);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        for (const root of roots) rmrf(root);
    }
});
