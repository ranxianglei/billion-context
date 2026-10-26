// #3756 follow-up: snapshot render SHADOW mode — default-on observability lane.
//
// The render engine ships inactive (rollout 0%). Shadow flips the default the
// OTHER way: every proxy turn with an armed fold ALSO computes the snapshot
// view, classifies the diff against the legacy outbound, records counters in
// session metadata — and DISCARDS the view (outbound bytes untouched).
//
// Contract staked BEFORE the implementation (打桩):
//
//  1. knob resolution: env BILI_SNAPSHOT_SHADOW > file `snapshot.shadow` >
//     default ON; garbage spellings fall back, never throw.
//  2. shadow observes without emitting: with shadow on + rollout off, the
//     outbound bytes are IDENTICAL to a shadow-off baseline run; the session
//     gains metadata.snapshotShadow with turns counted and zero errors.
//  3. classifier (pure): the #3812 misjoin shape (view drops non-covered
//     client messages) reports lostTail errors; duplicated non-anchor ids
//     report; same-input/different-view reports unstablePrefix; the clean
//     shape reports none of them.
//  4. degrade accounting: a seam-too-short session records lastClass
//     "degraded" + reason, with ZERO error-class entries (known cost, not a
//     bug — the alert bar must NOT light up for it).
//  5. surfacing: /__bili/status aggregates snapshotShadow {enabled, watching,
//     errors}; /__bili/sessions entries carry the per-session counters; the
//     `snapshot-shadow` diagnostics topic names erroring sessions.
//  6. opt-out: BILI_SNAPSHOT_SHADOW=0 writes no shadow metadata at all.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "shadow";
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-shadow-hermetic-")), "no-config.json");
delete process.env.BILI_ROLLOUT_SNAPSHOT_RENDER; // render stays OFF — shadow must observe via the legacy outbound

import { defaultConfig } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { resolveSnapshotShadow } from "../src/knobs.ts";
import { classifyShadowForTest } from "../src/server/snapshot-render.ts";
import { rmrf } from "./tmp-rm.ts";

const SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function conversation(tail: { role: string; content: string }[] = []): { role: string; content: string }[] {
    const out: { role: string; content: string }[] = [];
    for (let i = 0; i < 23; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(88) });
    }
    return [...out, ...tail];
}

type Harness = {
    proxy: http.Server;
    upstream: http.Server;
    bodies: string[];
    url: string;
    statusUrl: string;
    sessionsUrl: string;
    diagUrl: (topic: string) => string;
    store: { unifiedTailSeqs(sessionId: string): number[] | null } | null;
    sessionOf: (label: string) => { meta: { label: string }; state: { blocks: { id: string; active: boolean }[] }; metadata: Record<string, unknown> } | undefined;
};

async function withHarness(fn: (h: Harness) => Promise<void>, storeEnabled: boolean): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            const n = bodies.length;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (n === 1) {
                const args = JSON.stringify({ content: [{ startId: "m00001", endId: "m00008", topic: "setup", summary: SUMMARY }] });
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "compress", arguments: args } }] } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
            } else {
                const text = n === 2 ? "done compressing" : `ok ${n}`;
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
            }
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const dir = mkdtempSync(path.join(tmpdir(), "bili-shadow-store-"));
    const store = storeEnabled ? new SessionStore({ enabled: true, dir, debounceMs: 0 }) : new SessionStore({ enabled: false });
    _setStoreForTest(store);
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 15_000 } } } },
        modelContextLimit: 15_000,
        kernelConfig: defaultConfig(15_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: Boolean(process.env.SNAP_DEBUG),
        debug: Boolean(process.env.SNAP_DEBUG),
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as unknown as ProxyOptions);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    const h: Harness = {
        proxy,
        upstream,
        bodies,
        url: `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        statusUrl: `http://127.0.0.1:${port}/__bili/status`,
        sessionsUrl: `http://127.0.0.1:${port}/__bili/sessions`,
        diagUrl: (topic) => `http://127.0.0.1:${port}/__bili/diagnostics?topic=${topic}`,
        store: storeEnabled ? store : null,
        sessionOf: (label) => listSessions().find((x) => x.meta.label === label) as never,
    };
    try {
        await fn(h);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        delete process.env.BILI_SNAPSHOT_SHADOW;
        delete process.env.BILI_ROLLOUT_SNAPSHOT_RENDER;
        store.closeQuietly();
        void rmrf(dir);
    }
}

const rowsSeen = new Map<string, number>();
async function settleRows(h: Harness, label: string): Promise<void> {
    if (!h.store) {
        await new Promise((res) => setTimeout(res, 60));
        return;
    }
    const prev = rowsSeen.get(label) ?? 0;
    for (let i = 0; i < 200; i++) {
        const n = h.store.unifiedTailSeqs(label)?.length ?? 0;
        if (n !== prev && n > 0) {
            rowsSeen.set(label, n);
            return;
        }
        await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`settleRows: store tail view never changed for ${label}`);
}

type Msg = { role: string; content: string };

async function turn(h: Harness, label: string, messages: unknown[], history: Msg[] | null = null): Promise<{ status: number; body: string; idx: number }> {
    const r = await fetch(h.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": label },
        body: JSON.stringify({ model: "gpt-test", messages, stream: true }),
    });
    const body = await r.text();
    await settleRows(h, label);
    if (history) {
        const t = body;
        const matches = [...t.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].reverse();
        if (matches.length > 0) {
            const raw = JSON.parse(`"${matches[0][1]}"`);
            if (raw) history.push({ role: "assistant", content: String(raw) });
        }
    }
    return { status: r.status ?? 0, body, idx: h.bodies.length - 1 };
}

function sentMessages(h: Harness, i: number): { role: string; content: unknown }[] {
    return JSON.parse(h.bodies[i]).messages;
}

/** stake 1 — knob resolution matrix. */
test("snapshot shadow knob: env > file > default-on, garbage never throws", () => {
    assert.equal(resolveSnapshotShadow({} as NodeJS.ProcessEnv, undefined), true, "default on");
    assert.equal(resolveSnapshotShadow({} as NodeJS.ProcessEnv, false), false, "file false honored");
    assert.equal(resolveSnapshotShadow({} as NodeJS.ProcessEnv, true), true, "file true honored");
    assert.equal(resolveSnapshotShadow({ BILI_SNAPSHOT_SHADOW: "0" } as NodeJS.ProcessEnv, true), false, "env off wins over file on");
    assert.equal(resolveSnapshotShadow({ BILI_SNAPSHOT_SHADOW: "false" } as NodeJS.ProcessEnv, undefined), false, "env false");
    assert.equal(resolveSnapshotShadow({ BILI_SNAPSHOT_SHADOW: "off" } as NodeJS.ProcessEnv, undefined), false, "env off");
    assert.equal(resolveSnapshotShadow({ BILI_SNAPSHOT_SHADOW: "1" } as NodeJS.ProcessEnv, false), true, "env on wins over file off");
    assert.equal(resolveSnapshotShadow({ BILI_SNAPSHOT_SHADOW: "on" } as NodeJS.ProcessEnv, undefined), true, "env on");
    assert.equal(resolveSnapshotShadow({ BILI_SNAPSHOT_SHADOW: "garbage" } as NodeJS.ProcessEnv, false), false, "garbage env degrades to file value");
});

/** stake 3 — pure classifier: mechanical error classes. */
test("snapshot shadow classifier: misjoin/duplicate/unstable are mechanical errors", () => {
    const row = (id: string, text: string): BiliMessage => ({ id, role: "user", contentType: "text", text } as BiliMessage);
    // #3812 misjoin shape: the view chains against an OLD "继续" row and drops
    // the middle of the conversation. Covered = the two ids the block owns.
    {
        const view = [row("h_r1", "old question"), row("h_r2", "old answer")];
        const clientMsgs = [row("h_r1", "old question"), row("h_r2", "old answer"), row("h_m1", "middle 1"), row("h_m2", "middle 2"), row("h_t1", "final question")];
        const r = classifyShadowForTest({ view, clientMsgs, coveredClientIds: new Set(["h_r1", "h_r2"]) });
        assert.equal(r.lostTail, 3, "three non-covered client messages vanish from the view");
        assert.deepEqual(r.duplicateIds, []);
        assert.equal(r.unstablePrefix, false);
    }
    // duplicate: the same non-anchor id renders twice (upgrade twin misrender).
    {
        const view = [row("h_a", "x"), row("h_a", "x"), row("h_t1", "t")];
        const clientMsgs = [row("h_a", "x"), row("h_t1", "t")];
        const r = classifyShadowForTest({ view, clientMsgs, coveredClientIds: new Set() });
        assert.deepEqual(r.duplicateIds, ["h_a"]);
        assert.equal(r.lostTail, 0);
    }
    // unstable: identical resent input, different view prefix.
    {
        const base = { inputDigest: undefined as string | undefined, viewDigest: undefined as string | undefined };
        const first = classifyShadowForTest({ view: [row("h_a", "stable"), row("h_t1", "t")], clientMsgs: [row("h_a", "stable"), row("h_t1", "t")], coveredClientIds: new Set() });
        const second = classifyShadowForTest({ view: [row("h_a", "CHANGED"), row("h_t1", "t")], clientMsgs: [row("h_a", "stable"), row("h_t1", "t")], coveredClientIds: new Set(), prev: { inputDigest: first.inputDigest, viewDigest: first.viewDigest } });
        void base;
        assert.equal(second.unstablePrefix, true, "same input must yield the same view");
        const stable = classifyShadowForTest({ view: [row("h_a", "stable"), row("h_t1", "t")], clientMsgs: [row("h_a", "stable"), row("h_t1", "t")], coveredClientIds: new Set(), prev: { inputDigest: first.inputDigest, viewDigest: first.viewDigest } });
        assert.equal(stable.unstablePrefix, false);
    }
    // clean shape: suppression of covered messages is NOT an error.
    {
        const view = [row("h_new", "fresh tail")];
        const clientMsgs = [row("h_old1", "folded"), row("h_old2", "folded"), row("h_new", "fresh tail")];
        const r = classifyShadowForTest({ view, clientMsgs, coveredClientIds: new Set(["h_old1", "h_old2"]) });
        assert.equal(r.lostTail, 0);
        assert.deepEqual(r.duplicateIds, []);
        assert.equal(r.unstablePrefix, false);
        assert.equal(r.suppressed, 2, "covered messages the view drops are counted as info");
    }
});

/** stakes 2+5 — observe-without-emit + surfacing. */
test("snapshot shadow: observes armed folds, outbound identical to baseline, surfaces counters", async (t) => {
    // baseline FIRST (shadow off) so the comparison lives in one process.
    let baseline: string[] = [];
    await withHarness(async (h) => {
        process.env.BILI_SNAPSHOT_SHADOW = "0";
        const history = conversation();
        await turn(h, "s-base", history.map((m) => ({ ...m })));
        await turn(h, "s-base", [...history.map((m) => ({ ...m })), { role: "user", content: "TAIL_A follow up question about the work" }]);
        baseline = [...h.bodies];
        const s = h.sessionOf("s-base");
        assert.equal(s?.metadata.snapshotShadow, undefined, "opt-out writes no shadow metadata");
    }, true);
    assert.ok(baseline.length >= 3, "baseline captured both requests");

    await withHarness(async (h) => {
        delete process.env.BILI_SNAPSHOT_SHADOW; // default ON
        const history = conversation();
        await turn(h, "s-obs", history.map((m) => ({ ...m })));
        await turn(h, "s-obs", [...history.map((m) => ({ ...m })), { role: "user", content: "TAIL_A follow up question about the work" }]);
        // outbound identical to the shadow-off baseline (same deterministic turns)
        assert.equal(h.bodies.length, baseline.length);
        for (let i = 0; i < baseline.length; i++) {
            assert.equal(h.bodies[i], baseline[i], `upstream body ${i} must be byte-identical with shadow on`);
        }
        const s = h.sessionOf("s-obs");
        const meta = s?.metadata.snapshotShadow as { turns: number; errors: number; lastClass: string } | undefined;
        assert.ok(meta, "shadow metadata recorded");
        assert.ok((meta.turns ?? 0) >= 1, "at least one turn observed");
        assert.equal(meta.errors, 0, "healthy session reports zero errors");
        assert.equal(s?.metadata.snapshotRenderTurns, undefined, "render latch stays off (rollout 0%)");

        // surfacing: status aggregate
        const st = await (await fetch(h.statusUrl)).json() as { snapshotShadow?: { enabled: boolean; watching: number; errors: number } };
        assert.equal(st.snapshotShadow?.enabled, true);
        assert.ok((st.snapshotShadow?.watching ?? 0) >= 1, "one session under watch");
        assert.equal(st.snapshotShadow?.errors, 0, "no error sessions");

        // surfacing: sessions list carries per-session counters
        const list = await (await fetch(h.sessionsUrl)).json() as { sessions: { id: string; snapshotShadow?: { turns: number; errors: number } }[] };
        const entry = list.sessions.find((x) => x.snapshotShadow && x.snapshotShadow.turns > 0);
        assert.ok(entry, "sessions list exposes snapshotShadow counters");

        // surfacing: diagnostics topic names watching sessions
        const diag = await (await fetch(h.diagUrl("snapshot-shadow"))).json() as { blob: string };
        assert.match(diag.blob, /snapshot-shadow/);
    }, true);
});

/** stake 4 — degrade accounting: known costs never light the error bar. */
test("snapshot shadow: epoch-rewrite degrades without error-class entries", async () => {
    await withHarness(async (h) => {
        const history = conversation();
        await turn(h, "s-seam", history.map((m) => ({ ...m })));
        // The re-sent history shares NOTHING with the transcript (epoch-like
        // rewrite: the client reset the conversation under the same session
        // id). Nothing can chain — the engine must degrade to legacy rather
        // than guess a join point. (Mid-history partial rewrites cannot be
        // exercised through this harness: their store tail view never
        // settles, so settleRows times out.)
        const seen = [
            { role: "user", content: `EPOCH_REWRITE_ONE ${"E1_".repeat(80)}` },
            { role: "assistant", content: `EPOCH_REPLY_TWO ${"E2_".repeat(80)}` },
            { role: "user", content: `EPOCH_REWRITE_THREE ${"E3_".repeat(80)}` },
        ];
        await turn(h, "s-seam", seen);
        const s = h.sessionOf("s-seam");
        const meta = s?.metadata.snapshotShadow as { turns: number; errors: number; lastClass: string; lastReason?: string } | undefined;
        assert.ok(meta, "shadow metadata recorded on the degrade session");
        assert.equal(meta.errors, 0, "degrade is a known cost, not an error");
        assert.equal(meta.lastClass, "degraded");
        assert.equal(meta.lastReason, "chain-not-started");
    }, true);
});

/** stake 6 — status/errors: an erroring session drives the aggregate up. */
test("snapshot shadow: error sessions drive the status aggregate and diagnostics", async () => {
    await withHarness(async (h) => {
        const history = conversation();
        await turn(h, "s-ok", history.map((m) => ({ ...m })));
        await turn(h, "s-ok", [...history.map((m) => ({ ...m })), { role: "user", content: "TAIL_A follow up question" }]);
        // synthesize the error state the classifier would produce (unit-tested
        // above): the aggregate/wire layer must surface whatever the engine
        // recorded — here we inject to prove the surfacing path.
        const s = h.sessionOf("s-ok");
        assert.ok(s);
        (listSessions().find((x) => x.meta.label === "s-ok") as unknown as { metadata: Record<string, unknown> }).metadata.snapshotShadow = {
            turns: 3,
            errors: 2,
            lastClass: "error",
            lastErrors: ["lost-tail:1", "unstable-prefix"],
        };
        const st = await (await fetch(h.statusUrl)).json() as { snapshotShadow?: { enabled: boolean; watching: number; errors: number; worst?: { sessionId: string } } };
        assert.equal(st.snapshotShadow?.errors, 2);
        assert.ok(typeof st.snapshotShadow?.worst?.sessionId === "string" && st.snapshotShadow.worst.sessionId.length > 0, "worst session surfaced");
        const diag = await (await fetch(h.diagUrl("snapshot-shadow"))).json() as { blob: string };
        assert.match(diag.blob, /lost-tail/);
    }, true);
});
