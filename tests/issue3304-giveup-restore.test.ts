// #3304 — give-up restore guard. When the bili proxy dies mid-session the
// fetch intercept degrades to a DIRECT send of the model request. If an
// incremental lane had already swapped that request's body into its envelope
// (seed/delta/resync), the bare upstream cannot parse it — the old code
// shipped the rewritten body anyway (silent content corruption). This suite
// pins the fix at every layer:
//   1. intercept level — every direct-send exit consults state.directGuard:
//      a restored pair travels verbatim, "refuse" and a throwing guard both
//      fail closed with a local 503 (x-bili-gate:giveup-restore-refusal),
//      and an unswapped request is byte-identical to pre-fix behavior;
//   2. lane level — omp / opencode / pi capture their originals at swap time
//      and their armed guards restore them (consumed on read).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { V2HttpRequestEvent, V2State } from "../src/agent/opencode-v2.ts";

process.env.NODE_TEST_CONTEXT = "1";

const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue3304-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const DEAD_ORIGIN = "http://127.0.0.1:40001";
const UPSTREAM_URL = "http://127.0.0.1:8199/v1/messages";
// Captured BEFORE any withIntercept cycle: each cycle's reset re-anchors the
// fetch property against ITS OWN fake downstream, so the lanes' probes (real
// HTTP to the fake lane server) must run against this pristine fetch.
const PRISTINE_FETCH = globalThis.fetch;

/** Undo the last intercept cycle's residual fetch state for the lane-level
 *  tests below (their probes use real HTTP). */
async function ensureRealFetch(): Promise<void> {
    const ni = await import("../src/agent/native-intercept.ts");
    ni._resetForTest();
    globalThis.fetch = PRISTINE_FETCH;
}

interface Hit { url: string; bodyText?: string; headerRecord: Record<string, string> }

/** Downstream fake: proxy-origin URLs die with a connection TypeError (the
 *  dead proxy); everything else lands on the "upstream" sink verbatim. */
function fakeFetch(sinks: { proxy: Hit[]; upstream: Hit[] }): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const recordHeaders = (src: unknown): Record<string, string> => {
            if (src === undefined) return {};
            try {
                const out: Record<string, string> = {};
                for (const [k, v] of new Headers(src as string[][] | Record<string, string> | Headers)) out[k.toLowerCase()] = v;
                return out;
            } catch {
                return {};
            }
        };
        const bodyText = async (): Promise<string | undefined> => {
            if (init?.body !== undefined && typeof init.body === "string") return init.body;
            if (input instanceof Request) {
                try { return await input.clone().text(); } catch { return undefined; }
            }
            return undefined;
        };
        if (u.startsWith(DEAD_ORIGIN)) {
            sinks.proxy.push({ url: u, bodyText: await bodyText(), headerRecord: recordHeaders(init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined) });
            throw new TypeError("fetch failed");
        }
        sinks.upstream.push({ url: u, bodyText: await bodyText(), headerRecord: recordHeaders(init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined) });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

async function withIntercept<T>(state: Record<string, unknown>, fn: (ctx: { proxy: Hit[]; upstream: Hit[]; gaveUp: () => boolean }) => Promise<T>): Promise<{ result: T; proxy: Hit[]; upstream: Hit[]; gaveUp: boolean }> {
    const saved = globalThis.fetch;
    const proxy: Hit[] = [];
    const upstream: Hit[] = [];
    let giveUps = 0;
    const fullState = { ...state, onGiveUp: () => { giveUps++; }, respawn: async () => undefined } as never;
    const { _resetForTest, installNativeFetchIntercept } = await import("../src/agent/native-intercept.ts");
    _resetForTest();
    globalThis.fetch = fakeFetch({ proxy, upstream });
    try {
        assert.equal(installNativeFetchIntercept(fullState), true);
        const result = await fn({ proxy, upstream, gaveUp: () => giveUps > 0 });
        return { result, proxy, upstream, gaveUp: giveUps > 0 };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

const ORIGINAL_BODY = JSON.stringify({ model: "claude-test", max_tokens: 512, system: "be terse", messages: [{ role: "user", content: "hello" }] });
const ENVELOPE_BODY = JSON.stringify({ conversationId: "conv-1", sinceSeq: 0, path: "/v1/messages", resync: true, request: { model: "claude-test" }, messages: [{ role: "user", content: "hello" }] });
const MARKER = "x-bili-plugin-turn";

test("#3304 rewrite give-up: swapped body is restored before the direct send", async () => {
    const originals = new WeakMap<object, { body: string; headers: Headers }>();
    const state: Record<string, unknown> = {
        origin: DEAD_ORIGIN,
        ready: Promise.resolve(DEAD_ORIGIN),
        beforeSend: (_url: string, init: RequestInit | undefined) => {
            if (init === undefined || typeof init.body !== "string") return Promise.resolve();
            originals.set(init, { body: init.body, headers: new Headers(init.headers) });
            init.body = ENVELOPE_BODY;
            const h = new Headers(init.headers);
            h.set(MARKER, "1");
            init.headers = h;
            return Promise.resolve();
        },
        directGuard: (url: string, _input: string | URL | Request, guardInit?: RequestInit) => {
            if (guardInit === undefined) return undefined;
            const orig = originals.get(guardInit);
            if (orig === undefined) return undefined;
            originals.delete(guardInit);
            return { input: url, init: { ...guardInit, method: "POST", body: orig.body, headers: orig.headers } };
        },
    };
    const init: RequestInit = { method: "POST", headers: { authorization: "Bearer sk-test", "content-type": "application/json" }, body: ORIGINAL_BODY };
    const { result, proxy, upstream, gaveUp } = await withIntercept(state, async ({ proxy: p, upstream: u }) => ({ res: await globalThis.fetch(UPSTREAM_URL, init), p, u }));
    assert.equal(gaveUp, true, "give-up fired");
    assert.equal(proxy.length, 1, "the dead proxy saw the routed attempt");
    assert.equal(proxy[0].url, `${DEAD_ORIGIN}/bili/${UPSTREAM_URL}`);
    assert.equal(proxy[0].bodyText, ENVELOPE_BODY, "the proxy attempt carried the swapped envelope");
    assert.equal(upstream.length, 1, "exactly one direct send reached the upstream");
    assert.equal(upstream[0].url, UPSTREAM_URL);
    assert.equal(upstream[0].bodyText, ORIGINAL_BODY, "the ORIGINAL payload traveled, not the envelope");
    assert.equal(upstream[0].headerRecord["authorization"], "Bearer sk-test", "original headers survive the restore");
    assert.equal(upstream[0].headerRecord[MARKER], undefined, "no marker header on the restored request");
    void result;
});

test("#3304 unswapped request: byte-identical to pre-fix behavior (regression anchor)", async () => {
    const state: Record<string, unknown> = {
        origin: DEAD_ORIGIN,
        ready: Promise.resolve(DEAD_ORIGIN),
        directGuard: () => undefined,
    };
    const init: RequestInit = { method: "POST", headers: { authorization: "Bearer sk-test" }, body: ORIGINAL_BODY };
    const { upstream, gaveUp } = await withIntercept(state, async () => globalThis.fetch(UPSTREAM_URL, init));
    assert.equal(gaveUp, true);
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].url, UPSTREAM_URL);
    assert.equal(upstream[0].bodyText, ORIGINAL_BODY);
    assert.equal(upstream[0].headerRecord["authorization"], "Bearer sk-test");
});

test("#3304 refuse verdict: local protocol-shaped 503, nothing ships", async () => {
    const state: Record<string, unknown> = {
        origin: DEAD_ORIGIN,
        ready: Promise.resolve(DEAD_ORIGIN),
        directGuard: () => "refuse",
    };
    const { result, upstream } = await withIntercept(state, async () => globalThis.fetch(UPSTREAM_URL, { method: "POST", body: ENVELOPE_BODY }));
    const res = result as Response;
    assert.equal(res.status, 503, "retryable class — transient infrastructure failure, not a request error");
    assert.equal(res.headers.get("x-bili-gate"), "giveup-restore-refusal");
    assert.equal(res.headers.get("retry-after"), "1");
    const json = (await res.json()) as { type?: string; error?: { type?: string; message?: string } };
    assert.equal(json.type, "error", "anthropic envelope for a /messages URL");
    assert.equal(json.error?.type, "api_error");
    assert.match(json.error?.message ?? "", /#3304/);
    assert.equal(upstream.length, 0, "nothing left the process");
});

test("#3304 refusing guard throws: fails closed with the same local 503", async () => {
    const state: Record<string, unknown> = {
        origin: DEAD_ORIGIN,
        ready: Promise.resolve(DEAD_ORIGIN),
        directGuard: () => { throw new Error("boom"); },
    };
    const { result, upstream } = await withIntercept(state, async () => globalThis.fetch(UPSTREAM_URL, { method: "POST", body: ENVELOPE_BODY }));
    const res = result as Response;
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("x-bili-gate"), "giveup-restore-refusal");
    assert.equal(upstream.length, 0, "an unknown state never resolves by shipping the possibly-rewritten body");
});

test("#3304 routed give-up: overlay-baked URLs restore too", async () => {
    const originals = new WeakMap<object, { body: string; headers: Headers }>();
    const state: Record<string, unknown> = {
        origin: DEAD_ORIGIN,
        ready: Promise.resolve(DEAD_ORIGIN),
        beforeSend: (_url: string, init: RequestInit | undefined) => {
            if (init === undefined || typeof init.body !== "string") return Promise.resolve();
            originals.set(init, { body: init.body, headers: new Headers(init.headers) });
            init.body = ENVELOPE_BODY;
            return Promise.resolve();
        },
        directGuard: (url: string, _input: string | URL | Request, guardInit?: RequestInit) => {
            if (guardInit === undefined) return undefined;
            const orig = originals.get(guardInit);
            if (orig === undefined) return undefined;
            originals.delete(guardInit);
            return { input: url, init: { ...guardInit, method: "POST", body: orig.body, headers: orig.headers } };
        },
    };
    const init: RequestInit = { method: "POST", headers: { authorization: "Bearer sk-routed" }, body: ORIGINAL_BODY };
    const { upstream, gaveUp } = await withIntercept(state, async () => globalThis.fetch(`${DEAD_ORIGIN}/bili/${UPSTREAM_URL}`, init));
    assert.equal(gaveUp, true);
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].url, UPSTREAM_URL, "the embedded upstream target travels");
    assert.equal(upstream[0].bodyText, ORIGINAL_BODY);
    assert.equal(upstream[0].headerRecord["authorization"], "Bearer sk-routed");
});

test("#3304 bootstrap-failure exit: pre-swapped (opencode shape) request restores", async () => {
    // opencode swaps BEFORE fetch (V2 hook chain), so the body is already the
    // envelope when the intercept sees a not-ready origin.
    const originals = new WeakMap<object, { body: string; headers: Headers }>();
    const state: Record<string, unknown> = {
        origin: undefined,
        ready: Promise.resolve(undefined),
        directGuard: (url: string, _input: string | URL | Request, guardInit?: RequestInit) => {
            if (guardInit === undefined) return undefined;
            const orig = originals.get(guardInit);
            if (orig === undefined) return undefined;
            originals.delete(guardInit);
            return { input: url, init: { ...guardInit, method: "POST", body: orig.body, headers: orig.headers } };
        },
    };
    const init: RequestInit = { method: "POST", headers: { authorization: "Bearer sk-boot", [MARKER]: "1" }, body: ENVELOPE_BODY };
    originals.set(init, { body: ORIGINAL_BODY, headers: new Headers({ authorization: "Bearer sk-boot" }) });
    const { upstream } = await withIntercept(state, async () => globalThis.fetch(UPSTREAM_URL, init));
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].bodyText, ORIGINAL_BODY);
    assert.equal(upstream[0].headerRecord[MARKER], undefined);
});

test("#3304 unattributed gate-fail exit: pre-swapped (opencode shape) request restores", async () => {
    // Same shape as the bootstrap failure, but the origin IS up and the
    // attribution gate refuses the caller — the third direct-send exit that
    // can carry a pre-swapped envelope (opencode swaps before fetch).
    const originals = new WeakMap<object, { body: string; headers: Headers }>();
    const state: Record<string, unknown> = {
        origin: DEAD_ORIGIN,
        ready: Promise.resolve(DEAD_ORIGIN),
        takeoverGate: async () => false,
        directGuard: (url: string, _input: string | URL | Request, guardInit?: RequestInit) => {
            if (guardInit === undefined) return undefined;
            const orig = originals.get(guardInit);
            if (orig === undefined) return undefined;
            originals.delete(guardInit);
            return { input: url, init: { ...guardInit, method: "POST", body: orig.body, headers: orig.headers } };
        },
    };
    const init: RequestInit = { method: "POST", headers: { authorization: "Bearer sk-unattr", [MARKER]: "1" }, body: ENVELOPE_BODY };
    originals.set(init, { body: ORIGINAL_BODY, headers: new Headers({ authorization: "Bearer sk-unattr" }) });
    const { proxy, upstream } = await withIntercept(state, async () => globalThis.fetch(UPSTREAM_URL, init));
    assert.equal(proxy.length, 0, "the gate refused attribution — nothing rode the proxy");
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].bodyText, ORIGINAL_BODY);
    assert.equal(upstream[0].headerRecord[MARKER], undefined);
});

// --- lane level: the real adapters' capture + armed guards -----------------

async function fakeLane(enabled: boolean): Promise<{ base: string; close: () => Promise<void> }> {
    const srv = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/__bili/plugin/turn") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocol: 1, feature: "pluginIncrementalTurns", enabled }));
            return;
        }
        res.writeHead(404); res.end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test("#3304 omp lane: swap captures the original; the armed guard restores and consumes", async () => {
    const { __resetIncrementalClientForTests } = await import("../src/agent/incremental-client.ts");
    const mod = await import("../src/agent/omp-native.ts");
    await ensureRealFetch();
    __resetIncrementalClientForTests();
    mod.__resetOmpIncrementalForTests();
    const lane = await fakeLane(true);
    try {
        mod._setOmpOriginForTest(lane.base);
        const original = { model: "claude-test", max_tokens: 512, prompt_cache_key: "omp-3304-a", messages: [{ role: "user", content: "hi omp" }] };
        const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(original) };
        await mod.ompIncrementalBeforeSend(UPSTREAM_URL, init);
        const swappedJson = JSON.parse(init.body as string) as { conversationId?: string };
        assert.equal(swappedJson.conversationId, "omp-3304-a", "swap happened (lane envelope replaces the body)");
        assert.equal((init.headers as Headers).get(MARKER), "1");

        const guard = mod._directGuardForTest();
        assert.notEqual(guard, undefined, "guard armed");
        const verdict = await guard!(UPSTREAM_URL, UPSTREAM_URL, init);
        if (verdict === undefined || verdict === "refuse") throw new Error(`expected a restored pair, got ${String(verdict)}`);
        const restoredBody = verdict.init?.body as string;
        assert.deepEqual(JSON.parse(restoredBody), original, "original payload restored byte-for-byte");
        const restoredHeaders = new Headers(verdict.init?.headers);
        assert.equal(restoredHeaders.get(MARKER), null, "marker stripped by the restore");
        assert.equal(restoredHeaders.get("content-type"), "application/json");
        assert.equal(await guard!(UPSTREAM_URL, UPSTREAM_URL, init), undefined, "consumed on read");
    } finally {
        mod._setOmpOriginForTest(undefined);
        await lane.close();
    }
});

test("#3304 opencode lane: pre-fetch swap restores the original Request", async () => {
    const { __resetIncrementalClientForTests } = await import("../src/agent/incremental-client.ts");
    const mod = await import("../src/agent/opencode-native.ts");
    await ensureRealFetch();
    __resetIncrementalClientForTests();
    mod.__resetOpencodeIncrementalForTests();
    const lane = await fakeLane(true);
    try {
        const original = { model: "claude-test", max_tokens: 512, system: "s", messages: [{ role: "user", content: "hi oc" }] };
        const req = new Request(UPSTREAM_URL, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-oc" }, body: JSON.stringify(original) });
        const e = { request: req, sessionID: "oc-3304-a" } as unknown as V2HttpRequestEvent;
        await mod.maybeIncrementalOpencode(e, { proxyBase: lane.base } as unknown as V2State);
        const swapped = e.request as Request;
        assert.notEqual(swapped, req, "the request object was replaced");
        const swappedJson = JSON.parse(await swapped.clone().json().then((j) => JSON.stringify(j))) as { conversationId?: string };
        assert.equal(swappedJson.conversationId, "oc-3304-a", "swap happened (lane envelope)");

        const guard = mod._directGuardForTest();
        assert.notEqual(guard, undefined);
        const verdict = await guard!(swapped.url, swapped);
        if (verdict === undefined || verdict === "refuse") throw new Error(`expected a restored pair, got ${String(verdict)}`);
        const stream = verdict.init?.body as unknown as ReadableStream<Uint8Array>;
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
            const r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
        }
        const restoredBody = Buffer.concat(chunks).toString("utf8");
        assert.deepEqual(JSON.parse(restoredBody), original, "original payload restored");
        const restoredHeaders = new Headers(verdict.init?.headers);
        assert.equal(restoredHeaders.get("authorization"), "Bearer sk-oc", "original headers preserved");
        assert.equal(restoredHeaders.get(MARKER), null);
        assert.equal(await guard!(swapped.url, swapped), undefined, "consumed on read");
    } finally {
        await lane.close();
    }
});

test("#3304 pi ledger: note/consume/clear/expiry semantics", async () => {
    const { notePiIncrementalOriginal, clearPiIncrementalOriginal, consumePiIncrementalOriginal, __resetIncrementalClientForTests } = await import("../src/agent/incremental-client.ts");
    __resetIncrementalClientForTests();
    const payload = { model: "claude-test", messages: [{ role: "user", content: "pi" }] };
    assert.equal(consumePiIncrementalOriginal("sid-a"), undefined, "absent before any note");
    notePiIncrementalOriginal("sid-a", payload);
    assert.deepEqual(consumePiIncrementalOriginal("sid-a"), payload, "consume returns the original");
    assert.equal(consumePiIncrementalOriginal("sid-a"), undefined, "and forgets it");
    notePiIncrementalOriginal("sid-a", payload);
    clearPiIncrementalOriginal("sid-a");
    assert.equal(consumePiIncrementalOriginal("sid-a"), undefined, "clear wins");
    notePiIncrementalOriginal("sid-b", payload);
    const realNow = Date.now;
    try {
        Date.now = () => realNow() + 61_000;
        assert.equal(consumePiIncrementalOriginal("sid-b"), undefined, "expired entries are absent (TTL bounds memory)");
    } finally {
        Date.now = realNow;
    }
});

test("#3304 pi-native guard: sid from x-bili-plugin-conversation restores the noted payload", async () => {
    const { notePiIncrementalOriginal, consumePiIncrementalOriginal, __resetIncrementalClientForTests, INCREMENTAL_TURN_MARKER_HEADER } = await import("../src/agent/incremental-client.ts");
    const mod = await import("../src/agent/pi-native.ts");
    __resetIncrementalClientForTests();
    const guard = mod._directGuardForTest();
    assert.notEqual(guard, undefined, "guard armed at module load (spawn posture)");
    const payload = { model: "claude-test", max_tokens: 512, messages: [{ role: "user", content: "pi wire" }] };
    notePiIncrementalOriginal("pi-sid-3304", payload);
    const init: RequestInit = {
        method: "POST",
        headers: { "x-bili-plugin-conversation": "pi-sid-3304", [INCREMENTAL_TURN_MARKER_HEADER]: "1", "content-type": "application/json" },
        body: ENVELOPE_BODY,
    };
    const verdict = await guard!(UPSTREAM_URL, UPSTREAM_URL, init);
    if (verdict === undefined || verdict === "refuse") throw new Error(`expected a restored pair, got ${String(verdict)}`);
    assert.equal(verdict.input, UPSTREAM_URL);
    assert.equal(verdict.init?.body, JSON.stringify(payload), "original payload re-serialized onto the wire");
    const restoredHeaders = new Headers(verdict.init?.headers);
    assert.equal(restoredHeaders.get(INCREMENTAL_TURN_MARKER_HEADER), null, "marker stripped by the restore");
    assert.equal(restoredHeaders.get("x-bili-plugin-conversation"), "pi-sid-3304", "attribution header untouched");
    assert.equal(await guard!(UPSTREAM_URL, UPSTREAM_URL, init), undefined, "consumed on read");
    assert.equal(consumePiIncrementalOriginal("pi-sid-3304"), undefined, "ledger drained");
    // no conversation header → miss, nothing consumed
    notePiIncrementalOriginal("pi-sid-other", payload);
    assert.equal(await guard!(UPSTREAM_URL, UPSTREAM_URL, { method: "POST", body: ENVELOPE_BODY }), undefined);
    assert.notEqual(consumePiIncrementalOriginal("pi-sid-other"), undefined, "miss consumes nothing");
    __resetIncrementalClientForTests();
});
