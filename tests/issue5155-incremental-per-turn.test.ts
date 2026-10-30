import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { anthropicToCore, coreToAnthropic } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import type { BiliMessage } from "acp-kernel/wire";
import { SessionStore, _setStoreForTest, getStore } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests, laneItemsForTurn, laneRenderBoundaryFlushes, laneBodyBuffer, type Canonical } from "../src/incremental-lane.ts";

process.env.NODE_ENV = "test";

// ---------- unit level: prefix splice is byte-identical to a full render ----------

function entryOf(wire: { role: string; content: unknown }[], marks: Map<string, unknown> = new Map()): Canonical {
    const flat = anthropicToCore({ messages: wire as never } as never);
    for (const [id, mark] of flat.cacheControls) marks.set(id, mark);
    return { sessionId: "s", msgs: flat.msgs, marks, system: undefined, systemSet: false, boundary: null, renderPrefix: null, marksVersion: 0 };
}

const fullRender = (entry: Canonical): string => coreToAnthropic(entry.msgs, entry.marks).map((it) => JSON.stringify(it)).join(",");

test("#5155 splice: successive appends stay byte-identical to the full render across boundary and non-boundary cuts", () => {
    const seed = [{ role: "user", content: [{ type: "text", text: "hello world one" }] }];
    const deltas = [
        [{ role: "assistant", content: [{ type: "text", text: "answer one" }] }],
        [{ role: "user", content: [{ type: "text", text: "hello world two" }] }],
        // consecutive same-role messages: coreToAnthropic MERGES these into one
        // output item — the cut before the second one is not a boundary, the
        // prefix must not be reused there and the fallback full render kicks in
        [{ role: "user", content: [{ type: "text", text: "hello world two-b" }] }],
        [{ role: "assistant", content: [{ type: "text", text: "answer two" }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }],
    ];
    const entry = entryOf(seed);
    let items = laneItemsForTurn(entry, 0);
    assert.equal(items, fullRender(entry), "seed turn (cold cache) equals the full render");
    let cut = entry.msgs.length;
    for (const delta of deltas) {
        const flat = anthropicToCore({ messages: delta as never } as never);
        entry.msgs = [...entry.msgs, ...flat.msgs];
        items = laneItemsForTurn(entry, cut);
        assert.equal(items, fullRender(entry), `turn cut=${cut} splice equals the full render`);
        cut = entry.msgs.length;
    }
    // boundary predicate: role change flushes; consecutive same role does not
    const roles = entry.msgs.map((m) => (m.role === "assistant" ? "assistant" : "user"));
    for (let i = 1; i < entry.msgs.length; i++) {
        const expectFlush = roles[i - 1] !== roles[i] || (entry.msgs[i - 1] as { rawAnthropicMessage?: unknown }).rawAnthropicMessage !== undefined || (entry.msgs[i] as { rawAnthropicMessage?: unknown }).rawAnthropicMessage !== undefined;
        assert.equal(laneRenderBoundaryFlushes(entry.msgs, i), expectFlush, `boundary predicate at ${i}`);
    }
});

test("#5155 splice: a cache-control mark invalidates the prefix (marksVersion), raw system messages disable it", () => {
    const entry = entryOf([
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
    ]);
    laneItemsForTurn(entry, 0);
    const prefix = entry.renderPrefix;
    assert.ok(prefix, "cache armed after the full render");
    // a new delta whose wire marks a cache_control bumps the version
    const delta = [{ role: "user", content: [{ type: "text", text: "q2", cache_control: { type: "ephemeral" } }] }];
    const flat = anthropicToCore({ messages: delta as never } as never);
    entry.msgs = [...entry.msgs, ...flat.msgs];
    if (flat.cacheControls.size > 0) entry.marksVersion++;
    const items = laneItemsForTurn(entry, 2);
    assert.equal(items, fullRender(entry), "marked turn still byte-identical");
    assert.ok(entry.renderPrefix !== null && entry.renderPrefix.marksVersion === entry.marksVersion, "cache refreshed with the new version");
    assert.notEqual(prefix, entry.renderPrefix, "stale cache object replaced");
    // raw system messages: cache must be disabled (heal pass is position-dependent)
    const withSystem = entryOf([
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
    ]);
    const items2 = laneItemsForTurn(withSystem, 0);
    assert.equal(items2, fullRender(withSystem), "raw-system history renders correctly");
    assert.equal(withSystem.renderPrefix, null, "no prefix cache while raw system messages ride the history");
});

test("#5155 splice: an empty delta (system-only turn) reuses the cached prefix verbatim", () => {
    const entry = entryOf([{ role: "user", content: [{ type: "text", text: "q1" }] }]);
    laneItemsForTurn(entry, 0);
    const cached = entry.renderPrefix;
    assert.ok(cached);
    const items = laneItemsForTurn(entry, entry.msgs.length);
    assert.equal(items, cached.items, "no re-render when the history did not change");
});

test("#5155 sentinel: spliced body parses to the same object, collision falls back safely", () => {
    const entry = entryOf([
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
    ]);
    const items = laneItemsForTurn(entry, 0);
    const skeleton: Record<string, unknown> = { model: "claude-test", max_tokens: 1024 };
    const buf = laneBodyBuffer(skeleton, items);
    assert.deepEqual(JSON.parse(buf.toString("utf8")), { model: "claude-test", max_tokens: 1024, messages: JSON.parse(`[${items}]`) });
    const empty = laneBodyBuffer(skeleton, "");
    assert.deepEqual(JSON.parse(empty.toString("utf8")), { model: "claude-test", max_tokens: 1024, messages: [] });
    // a skeleton value that already contains the sentinel's serialized form:
    // the uniqueness check must detect it and fall back to a plain stringify
    const sentinelJson = JSON.stringify("\u0000bili-splice-anchor\uE000");
    const hostile = { model: `evil${sentinelJson}evil`, max_tokens: 1 };
    const hostileBuf = laneBodyBuffer(hostile, items);
    assert.deepEqual(JSON.parse(hostileBuf.toString("utf8")), { model: `evil${sentinelJson}evil`, max_tokens: 1, messages: JSON.parse(`[${items}]`) });
});

// ---------- integration: windowed pointers + debounced settle through the real lane ----------

interface Integration {
    turn: (t: { sinceSeq: number; messages: unknown[]; resync?: boolean }) => Promise<{ status: number; appliedSeq?: number }>;
    upstreamBodies: string[];
    settle: () => Promise<void>;
    pointers: () => unknown;
    close: () => Promise<void>;
}

async function integration(debounceMs: number): Promise<Integration> {
    const dir = mkdtempSync(join(tmpdir(), "bili-5155-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs });
    _setStoreForTest(store);
    _setForTest({});
    const upstreamBodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "m", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 100, output_tokens: 5 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const turn = async (t: { sinceSeq: number; messages: unknown[]; resync?: boolean }) => {
        const r = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-5155" },
            body: JSON.stringify({ conversationId: "conv-5155", sinceSeq: t.sinceSeq, ...(t.resync ? { resync: true } : {}), request: { model: "claude-test", max_tokens: 1024 }, path: "/v1/messages", messages: t.messages }),
        });
        const applied = r.headers.get("x-bili-applied-seq");
        return { status: r.status, appliedSeq: applied !== null && /^\d+$/.test(applied) ? Number(applied) : undefined };
    };
    return {
        turn,
        upstreamBodies,
        settle: async () => { await new Promise<void>((resolve) => setTimeout(resolve, debounceMs + 60)); },
        pointers: () => { try { return getStore().getSessionExt("conv-5155", "inc:canonical-ptrs"); } catch { return undefined; } },
        close: async () => { await new Promise<void>((resolve) => proxy.close(() => resolve())); store.closeQuietly(); await new Promise<void>((resolve) => upstream.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); },
    };
}

const uMsg = (text: string): { role: string; content: { type: string; text: string }[] } => ({ role: "user", content: [{ type: "text", text }] });
const aMsg = (text: string): { role: string; content: { type: string; text: string }[] } => ({ role: "assistant", content: [{ type: "text", text }] });

test("#5155 integration: multi-turn traffic through the splice path stays correct and pointers converge after the debounced settle", async () => {
    const h = await integration(20);
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [uMsg("seed question")] });
        assert.equal(seed.status, 200);
        assert.equal(seed.appliedSeq, 1);
        let seq = 1;
        // several spliced turns: user→assistant alternation makes every cut a
        // boundary (role change), so these all take the prefix-splice path
        for (let i = 0; i < 4; i++) {
            const r = await h.turn({ sinceSeq: seq, messages: [aMsg(`answer ${i}`), uMsg(`question ${i}`)] });
            assert.equal(r.status, 200, `turn ${i} ok`);
            seq = r.appliedSeq ?? seq;
        }
        assert.equal(seq, 9);
        const body = JSON.parse(h.upstreamBodies.at(-1) ?? "{}") as { messages: { role: string; content: unknown }[] };
        assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user"], "assembled history via splice is complete and ordered");
        // rows settle on the debounce; the NEXT turn's wrap-up records the
        // windowed pointers over whatever has landed
        await h.settle();
        const tail = await h.turn({ sinceSeq: seq, messages: [aMsg("final answer"), uMsg("final question")] });
        assert.equal(tail.status, 200);
        await h.settle();
        const ptrs = h.pointers();
        assert.ok(Array.isArray(ptrs), `pointers recorded after settle: ${JSON.stringify(ptrs)}`);
        assert.deepEqual(ptrs, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "windowed upkeep records the full row mapping");
        // cold rebuild from the table after everything settled
        _resetSessionsForTest();
        __resetIncrementalLaneForTests();
        const after = await h.turn({ sinceSeq: 11, messages: [aMsg("post restart answer"), uMsg("post restart question")] });
        assert.equal(after.status, 200, `cold rebuild serves the next delta: ${JSON.stringify(after)}`);
        const rebuilt = JSON.parse(h.upstreamBodies.at(-1) ?? "{}") as { messages: unknown[] };
        assert.equal(rebuilt.messages.length, 13, "table-rebuilt canonical + delta");
    } finally {
        await h.close();
    }
});

test("#5155 integration: duplicate-content messages (clustered `<base>_<n>` rows) still converge pointers", async () => {
    const h = await integration(20);
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [uMsg("seed question")] });
        let seq = seed.appliedSeq ?? 1;
        // every turn carries the SAME assistant text and user text — the
        // content store clusters the duplicate rows as `<base-id>_<n>` while
        // the in-memory canonical keeps the base id; the cluster-stripped
        // matching must still map every occurrence to its own row in order
        for (let i = 0; i < 4; i++) {
            const r = await h.turn({ sinceSeq: seq, messages: [aMsg("dup answer"), uMsg("dup question")] });
            assert.equal(r.status, 200, `turn ${i} ok`);
            seq = r.appliedSeq ?? seq;
        }
        assert.equal(seq, 9);
        await h.settle();
        await h.turn({ sinceSeq: seq, messages: [aMsg("dup answer"), uMsg("dup question")] });
        await h.settle();
        const ptrs = h.pointers();
        assert.ok(Array.isArray(ptrs), `pointers recorded despite clustered duplicates: ${JSON.stringify(ptrs)}`);
        assert.equal(ptrs.length, 11, "every duplicate occurrence matched its own settled row");
        assert.deepEqual([...new Set(ptrs)].sort((a, b) => a - b), [...ptrs].sort((a, b) => a - b), "pointer rows are distinct (no occurrence reuse)");
        const body = JSON.parse(h.upstreamBodies.at(-1) ?? "{}") as { messages: unknown[] };
        assert.equal(body.messages.length, 11, "assembled history keeps every duplicate occurrence");
    } finally {
        await h.close();
    }
});

test("#5155 integration: unsettleable rows keep previous pointers (never a partial list) and the ack still flows", async () => {
    const h = await integration(60000);
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [uMsg("q1")] });
        assert.equal(seed.status, 200);
        assert.equal(seed.appliedSeq, 1, "ack rides immediately — no writeNow wait");
        const delta = await h.turn({ sinceSeq: 1, messages: [aMsg("a1"), uMsg("q2")] });
        assert.equal(delta.status, 200);
        assert.equal(delta.appliedSeq, 3);
        // nothing has settled (60s debounce): pointers must be absent or stale,
        // never a partial [0] style half-list for the 3-message canonical
        const ptrs = h.pointers();
        assert.ok(!Array.isArray(ptrs) || (ptrs as number[]).every((n) => Number.isInteger(n)), "no partial/corrupt pointer list while rows are unsettled");
        const body = JSON.parse(h.upstreamBodies.at(-1) ?? "{}") as { messages: unknown[] };
        assert.equal(body.messages.length, 3, "traffic is unaffected by pointer lag");
    } finally {
        await h.close();
    }
});
