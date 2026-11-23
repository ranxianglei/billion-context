// #5509: opencode UI user forks never reached fork adoption — their session
// rows carry parent_id NULL, so the V2 lane's session.created-derived lineage
// map stayed empty and maybeAdopt was never called (zero log lines, zero
// inherited folds, full-history replay on every turn). These tests pin:
//   - the V2 lane learns user-fork lineage from the session.forked event
//     (data.sessionID + data.parentID + data.boundary) and adopts the child
//     before its first request reaches the proxy;
//   - branch-point resolution survives fold-state drift between a folded
//     parent ledger and a fresh child replay (positional role+text prefix
//     instead of identity hash — the #5122 zero-fold collapse), with the
//     host-declared boundary capping the count when its message is locatable
//     by rawId (#3464 future-proofs the lookup).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { createOpencodeV2Setup } from "../src/agent/opencode-v2.ts";
import { resetForkCapabilityCacheForTest, normalizeForkBoundary, matchForkPrefix, matchForkTextPrefix, resolveForkBranchPoint, forkIdentityHashOf } from "../src/agent/fork-adopt.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-oc-ufk-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    resetForkCapabilityCacheForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    return { dir, store, upstreamUrl, origin: `http://127.0.0.1:${paddr.port}`, close: async () => { store.cancelAll(); proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); } };
}

async function seedParent(h: Awaited<ReturnType<typeof harness>>, conversationId: string) {
    const seed = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": conversationId },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "first original ".repeat(250) },
            { role: "assistant", content: "second original ".repeat(250) },
            { role: "user", content: "tail original" },
        ] }),
    });
    assert.equal(seed.status, 200, await seed.text());
}

type HookCb = (e: Record<string, unknown>) => void | Promise<void>;

function makeV2Ctx() {
    const hooks = new Map<string, HookCb>();
    const eventQueue: Array<{ type?: unknown; data?: Record<string, unknown> }> = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let consumed = 0;
    const ctx = {
        session: {
            hook: async (name: string, cb: HookCb) => { hooks.set(name, cb); return { dispose: () => undefined }; },
            synthetic: async () => ({}),
        },
        tool: { transform: async () => ({ dispose: () => undefined }) },
        command: { transform: async () => ({ dispose: () => undefined }) },
        event: {
            subscribe: (opts?: { signal?: AbortSignal }) => {
                opts?.signal?.addEventListener("abort", () => { closed = true; wake?.(); }, { once: true });
                return {
                    [Symbol.asyncIterator]: (): AsyncIterator<{ type?: unknown; data?: Record<string, unknown> }> => ({
                        next: async () => {
                            while (eventQueue.length === 0 && !closed) await new Promise<void>((r) => (wake = r));
                            wake = undefined;
                            const v = eventQueue.shift();
                            if (v === undefined) return { done: true as const, value: undefined };
                            consumed += 1;
                            return { done: false as const, value: v };
                        },
                    }),
                };
            },
        },
        catalog: { model: { list: async () => ({ data: [] }) } },
    };
    return {
        ctx,
        fire: async (name: string, e: Record<string, unknown>) => { const cb = hooks.get(name); assert.ok(cb, `hook ${name} registered`); await cb(e); },
        pushEvent: (evt: { type?: unknown; data?: Record<string, unknown> }) => { eventQueue.push(evt); wake?.(); },
        untilConsumed: async (n: number) => {
            const deadline = Date.now() + 3000;
            while (consumed < n) {
                if (Date.now() > deadline) throw new Error(`only ${consumed} events consumed, wanted ${n}`);
                await new Promise((r) => setTimeout(r, 10));
            }
        },
    };
}

const childBody = { model: "claude-test", max_tokens: 1024, stream: false, messages: [
    { role: "system", content: "system prompt" },
    { role: "user", content: "first original ".repeat(250) },
    { role: "assistant", content: "second original ".repeat(250) },
    { role: "user", content: "tail original" },
    { role: "user", content: "new fork tail" },
] };

test("v2 lane adopts a UI user fork announced via session.forked (#5509)", async () => {
    const h = await harness();
    try {
        await seedParent(h, "oc-parent");
        const fake = makeV2Ctx();
        const dispose = await createOpencodeV2Setup()(fake.ctx as never);
        // User forks store parent_id NULL — session.created never carries them;
        // only session.forked does (boundary included, wire shape verified on
        // @opencode/cli 2.x). Pre-fix this event was ignored: derivedParent
        // stayed empty, no fork was posted, and the snapshot below was 404.
        fake.pushEvent({ type: "session.forked", data: { sessionID: "oc-child-fork", parentID: "oc-parent", boundary: { type: "before", messageID: "msg-not-in-snapshot" } } });
        await fake.untilConsumed(1);
        const url = `${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`;
        const request = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(childBody) });
        await fake.fire("http.request", { sessionID: "oc-child-fork", model: { providerID: "qwen", id: "m1" }, request });
        assert.equal(request.headers.get("x-bili-plugin"), "opencode", "hook stamped the plugin headers");
        assert.equal(request.headers.get("x-bili-plugin-conversation"), "oc-child-fork");
        const snap = await fetch(`${h.origin}/__bili/plugin/snapshot?conversationId=oc-child-fork`);
        const snapText = await snap.text();
        assert.equal(snap.status, 200, snapText);
        const snapBody = JSON.parse(snapText) as { orderedMessages: unknown[] };
        assert.equal(snapBody.orderedMessages.length, 3, "child inherited the parent's three-message prefix");
        const replay = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": "oc-child-fork" },
            body: JSON.stringify(childBody),
        });
        assert.equal(replay.status, 200, await replay.text());
        dispose();
    } finally {
        await h.close();
    }
});

test("branch point: role+text prefix survives fold-state identity drift (#5509/#5122)", () => {
    const core = [
        { role: "user", text: "alpha" },
        { role: "assistant", text: "beta" },
        { role: "user", text: "gamma" },
    ] as CoreMessage[];
    const rows = [
        { rawId: "r0", role: "user", text: "alpha" },
        { rawId: "r1", role: "assistant", text: "beta" },
        { rawId: "r2", role: "user", text: "gamma" },
    ];
    const identities = core.map((m) => ({ rawId: `r${core.indexOf(m)}`, ref: null, identityHash: forkIdentityHashOf(m) }));
    // Clean state: both paths agree on the full prefix.
    assert.deepEqual(resolveForkBranchPoint(core, { orderedMessages: identities, messages: rows }), { count: 3, via: "text", cappedByBoundary: false });
    // Folded parent ledger: cell 1 carries summaryOfBlockId in its stored
    // identity (the kernel projection of a folded block) while the child
    // replays the original bytes. Identity matching collapses to the first
    // cell (the #5122 "201 but 0 blocks" shape); role+text still spans all
    // three because the replayed bytes are unchanged.
    const drifted = identities.map((id, i) => (i === 1 ? { ...id, identityHash: forkIdentityHashOf({ ...core[1], summaryOfBlockId: "blk_9" } as CoreMessage) } : id));
    assert.equal(matchForkPrefix(core, drifted), 1, "identity matching collapses at the folded cell (old behavior)");
    assert.equal(matchForkTextPrefix(core, rows), 3);
    assert.deepEqual(resolveForkBranchPoint(core, { orderedMessages: drifted, messages: rows }), { count: 3, via: "text", cappedByBoundary: false });
    // Proxies without per-message rows fall back to identity matching.
    assert.deepEqual(resolveForkBranchPoint(core, { orderedMessages: drifted }), { count: 1, via: "identity", cappedByBoundary: false });
    // Zero overlap degrades either way.
    assert.equal(resolveForkBranchPoint([{ role: "user", text: "other" }] as CoreMessage[], { orderedMessages: identities, messages: rows }).count, 0);
});

test("branch point: host-declared boundary caps the count when locatable by rawId (#5509)", () => {
    const core = [
        { role: "user", text: "alpha" },
        { role: "assistant", text: "beta" },
        { role: "user", text: "gamma" },
    ] as CoreMessage[];
    const rows = [
        { rawId: "r0", role: "user", text: "alpha" },
        { rawId: "r1", role: "assistant", text: "beta" },
        { rawId: "r2", role: "user", text: "gamma" },
    ];
    const identities = core.map((m, i) => ({ rawId: `r${i}`, ref: null, identityHash: forkIdentityHashOf(m) }));
    const snap = { orderedMessages: identities, messages: rows };
    // "before" excludes the boundary message; "through" includes it.
    assert.deepEqual(resolveForkBranchPoint(core, snap, { type: "before", messageID: "r1" }), { count: 1, via: "text", cappedByBoundary: true });
    assert.deepEqual(resolveForkBranchPoint(core, snap, { type: "through", messageID: "r1" }), { count: 2, via: "text", cappedByBoundary: true });
    // A cap only bites when the text prefix would overshoot.
    assert.deepEqual(resolveForkBranchPoint(core.slice(0, 1), snap, { type: "before", messageID: "r1" }), { count: 1, via: "text", cappedByBoundary: false });
    // Unknown boundary types and unlocatable message ids contribute nothing —
    // no guessing (rawId == host msgid only lands with #3464).
    assert.deepEqual(resolveForkBranchPoint(core, snap, { type: "midpoint", messageID: "r1" }), { count: 3, via: "text", cappedByBoundary: false });
    assert.deepEqual(resolveForkBranchPoint(core, snap, { type: "before", messageID: "zzz" }), { count: 3, via: "text", cappedByBoundary: false });
    assert.deepEqual(resolveForkBranchPoint(core, snap, undefined), { count: 3, via: "text", cappedByBoundary: false });
});

test("normalizeForkBoundary keeps only non-empty string fields (#5509)", () => {
    assert.equal(normalizeForkBoundary(undefined), undefined);
    assert.equal(normalizeForkBoundary(null), undefined);
    assert.equal(normalizeForkBoundary({}), undefined);
    assert.equal(normalizeForkBoundary({ type: "", messageID: "" }), undefined);
    assert.deepEqual(normalizeForkBoundary({ type: "before" }), { type: "before" });
    assert.deepEqual(normalizeForkBoundary({ type: "through", messageID: 42, junk: { x: 1 } }), { type: "through" });
    assert.deepEqual(normalizeForkBoundary({ messageID: "m1" }), { messageID: "m1" });
});
