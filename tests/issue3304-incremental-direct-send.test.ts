// #3304 — proxy-death direct fallback must never forward a lane-mutated
// (incremental) payload to the real upstream. The pre-fix behavior sent the
// delta envelope verbatim → upstream 400. Now every fall-back send goes
// through state.prepareDirectSend: lanes that swapped the body restore the
// stashed original (availability), and when the original is gone the direct
// send is refused locally (safety — the host's retry re-runs the decision).
// Lanes without the hook keep today's byte-identical fall-back behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { installNativeFetchIntercept, withRestoredBody, _resetForTest, type NativeInterceptState } from "../src/agent/native-intercept.ts";
import { createPrepareDirectSend, incrementalEnvelopeConversationId, INCREMENTAL_TURN_ID_HEADER, rememberOriginalBody, originalBodyForTurn, __resetIncrementalClientForTests } from "../src/agent/incremental-client.ts";

const ORIGINAL_BODY = JSON.stringify({ model: "claude-test", max_tokens: 1024, messages: [{ role: "user", content: "hello" }] });
const DELTA_BODY = JSON.stringify({ conversationId: "conv-1", sinceSeq: 3, path: "/v1/messages", request: { model: "claude-test" }, messages: [{ role: "assistant", content: "hi" }] });

// Captured before any intercept install in this file — the install replaces
// globalThis.fetch with an accessor and _resetForTest only restores the
// descriptor that existed AT INSTALL TIME, so a per-test "saved" value
// poisons every later test (the probe would hit a dead proxy stub).
const REAL_FETCH: typeof fetch = globalThis.fetch;

// ── A. strict shared hook (dsh / omp / opencode) ────────────────────────────

test("#3304 createPrepareDirectSend: no turn id ⇒ as-is (init headers)", async () => {
    const hook = createPrepareDirectSend();
    const prep = await hook("http://x/v1/messages", "http://x/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: DELTA_BODY });
    assert.deepEqual(prep, { outcome: "as-is" });
});

test("#3304 createPrepareDirectSend: no turn id on bare string input ⇒ as-is", async () => {
    const hook = createPrepareDirectSend();
    const prep = await hook("http://x/v1/messages", "http://x/v1/messages", undefined);
    assert.deepEqual(prep, { outcome: "as-is" });
});

test("#3304 createPrepareDirectSend: turn id + stashed original ⇒ restored (init headers)", async () => {
    try {
        __resetIncrementalClientForTests();
        rememberOriginalBody("t-init", ORIGINAL_BODY);
        const hook = createPrepareDirectSend();
        const prep = await hook("http://x/v1/messages", "http://x/v1/messages", { method: "POST", headers: { [INCREMENTAL_TURN_ID_HEADER]: "t-init" }, body: DELTA_BODY });
        assert.deepEqual(prep, { outcome: "restored", body: ORIGINAL_BODY });
        // non-consuming: a host-level retry of the SAME request reads again
        const again = await hook("http://x/v1/messages", "http://x/v1/messages", { method: "POST", headers: { [INCREMENTAL_TURN_ID_HEADER]: "t-init" }, body: DELTA_BODY });
        assert.deepEqual(again, { outcome: "restored", body: ORIGINAL_BODY });
    } finally {
        __resetIncrementalClientForTests();
    }
});

test("#3304 createPrepareDirectSend: turn id on a Request-object input ⇒ restored", async () => {
    try {
        __resetIncrementalClientForTests();
        rememberOriginalBody("t-req", ORIGINAL_BODY);
        const req = new Request("http://x/v1/messages", { method: "POST", headers: { [INCREMENTAL_TURN_ID_HEADER]: "t-req" }, body: DELTA_BODY });
        const prep = await createPrepareDirectSend()("http://x/v1/messages", req, undefined);
        assert.deepEqual(prep, { outcome: "restored", body: ORIGINAL_BODY });
    } finally {
        __resetIncrementalClientForTests();
    }
});

test("#3304 createPrepareDirectSend: turn id WITHOUT stashed original ⇒ unrestorable", async () => {
    try {
        __resetIncrementalClientForTests();
        const prep = await createPrepareDirectSend()("http://x/v1/messages", "http://x/v1/messages", { method: "POST", headers: { [INCREMENTAL_TURN_ID_HEADER]: "t-missing" }, body: DELTA_BODY });
        assert.deepEqual(prep, { outcome: "unrestorable" });
    } finally {
        __resetIncrementalClientForTests();
    }
});

test("#3304 originalBodyForTurn: unknown id ⇒ null", () => {
    __resetIncrementalClientForTests();
    assert.equal(originalBodyForTurn("never-stashed"), null);
});

// ── B. envelope shape test (pi correlation) ─────────────────────────────────

test("#3304 incrementalEnvelopeConversationId: accepts the buildBody envelope", () => {
    assert.equal(incrementalEnvelopeConversationId(JSON.parse(DELTA_BODY)), "conv-1");
    assert.equal(incrementalEnvelopeConversationId({ conversationId: "c", sinceSeq: 0, path: "/v1/messages", request: {}, messages: [], resync: true }), "c");
});

test("#3304 incrementalEnvelopeConversationId: rejects ordinary anthropic bodies and malformed envelopes", () => {
    assert.equal(incrementalEnvelopeConversationId(JSON.parse(ORIGINAL_BODY)), undefined, "a top-level model disqualifies it");
    assert.equal(incrementalEnvelopeConversationId({ conversationId: "c", sinceSeq: 1, path: "/v1/messages", request: {}, messages: [], model: "m" }), undefined, "a top-level model means it is not an envelope");
    assert.equal(incrementalEnvelopeConversationId({ conversationId: "c", path: "/v1/messages", request: {}, messages: [] }), undefined, "missing sinceSeq is load-bearing");
    assert.equal(incrementalEnvelopeConversationId({ conversationId: "", sinceSeq: 1, path: "/v1/messages", request: {}, messages: [] }), undefined, "empty conversationId");
    assert.equal(incrementalEnvelopeConversationId({ conversationId: "c", sinceSeq: 1.5, path: "/v1/messages", request: {}, messages: [] }), undefined, "non-integer sinceSeq");
    assert.equal(incrementalEnvelopeConversationId({ conversationId: "c", sinceSeq: -1, path: "/v1/messages", request: {}, messages: [] }), undefined, "negative sinceSeq");
    assert.equal(incrementalEnvelopeConversationId({ conversationId: "c", sinceSeq: 1, path: "/v1/messages", request: {} }), undefined, "missing messages array");
    assert.equal(incrementalEnvelopeConversationId(["conversationId"]), undefined);
    assert.equal(incrementalEnvelopeConversationId(null), undefined);
    assert.equal(incrementalEnvelopeConversationId("nope"), undefined);
});

// ── C. withRestoredBody ─────────────────────────────────────────────────────

test("#3304 withRestoredBody: string input keeps the url, body rides init", () => {
    const out = withRestoredBody("http://up/v1/messages", { method: "POST", headers: { a: "1" } }, ORIGINAL_BODY);
    assert.equal(out.input, "http://up/v1/messages");
    assert.equal(out.init?.body, ORIGINAL_BODY);
    assert.equal((out.init?.method ?? "GET"), "POST");
});

test("#3304 withRestoredBody: an existing init.body (the delta) is overridden", () => {
    const out = withRestoredBody("http://up/v1/messages", { method: "POST", body: DELTA_BODY }, ORIGINAL_BODY);
    assert.equal(out.init?.body, ORIGINAL_BODY);
});

test("#3304 withRestoredBody: Request input keeps url/method/headers, body rides init", async () => {
    const req = new Request("http://up/v1/messages", { method: "POST", headers: { "x-bili-turn-id": "t9", authorization: "Bearer sk" }, body: DELTA_BODY });
    const out = withRestoredBody(req, undefined, ORIGINAL_BODY);
    assert.ok(out.input instanceof Request);
    assert.equal(out.input.url, "http://up/v1/messages");
    assert.equal(out.input.method, "POST");
    assert.equal(out.input.headers.get("x-bili-turn-id"), "t9");
    assert.equal(out.input.headers.get("authorization"), "Bearer sk");
    assert.equal(out.init?.body, ORIGINAL_BODY);
});

// ── D. integration: installNativeFetchIntercept fall-back sites ─────────────

interface Call {
    url: string;
    body: string | null;
    headers: Record<string, string>;
}

function fakeFetchRecording(sink: Call[]) {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        let body: string | null = null;
        try {
            if (typeof init?.body === "string") body = init.body;
            else if (input instanceof Request && !input.bodyUsed) body = await input.clone().text();
        } catch {}
        const headers: Record<string, string> = {};
        try {
            const src = init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined;
            if (src !== undefined) for (const [k, v] of new Headers(src).entries()) headers[k] = v;
        } catch {}
        sink.push({ url, body, headers });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

async function withIntercept<T>(state: NativeInterceptState, inner: typeof fetch, fn: () => Promise<T>): Promise<{ result?: T; error?: unknown }> {
    _resetForTest();
    __resetIncrementalClientForTests();
    globalThis.fetch = inner;
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        let result: T | undefined;
        let error: unknown;
        try {
            result = await fn();
        } catch (err) {
            error = err;
        }
        return { result, error };
    } finally {
        // reset FIRST (restores the pre-install descriptor), then pin the
        // pristine fetch — the reverse order would resurrect the stub.
        _resetForTest();
        globalThis.fetch = REAL_FETCH;
        __resetIncrementalClientForTests();
    }
}

const PROXY_ORIGIN = "http://127.0.0.1:40001";
const UPSTREAM_URL = "http://127.0.0.1:8199/v1/messages";

/** Records every call; proxy-bound attempts die with a network-level
 *  TypeError (the observed death) instead of returning a response. */
function deadProxyFetch(sink: Call[]) {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(`${PROXY_ORIGIN}/bili/`)) {
            sink.push({ url, body: null, headers: {} });
            throw new TypeError("fetch failed");
        }
        let body: string | null = null;
        try {
            if (typeof init?.body === "string") body = init.body;
            else if (input instanceof Request && !input.bodyUsed) body = await input.clone().text();
        } catch {}
        const headers: Record<string, string> = {};
        try {
            const src = init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined;
            if (src !== undefined) for (const [k, v] of new Headers(src).entries()) headers[k] = v;
        } catch {}
        sink.push({ url, body, headers });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

/** State whose held proxy is dead and whose respawn yields nothing — the
 *  give-up condition of #3304 (probe said alive ≤30s earlier, adapter
 *  swapped, then the proxy died). */
function deadProxyState(extra: Partial<NativeInterceptState> = {}): NativeInterceptState {
    return {
        origin: PROXY_ORIGIN,
        ready: Promise.resolve(PROXY_ORIGIN),
        respawn: () => Promise.resolve(undefined),
        ...extra,
    };
}

test("#3304 rewrite give-up: swapped payload is RESTORED before the direct send", async () => {
    const state = deadProxyState({
        prepareDirectSend: createPrepareDirectSend(),
        onGiveUp: () => {},
        onDispatch: () => {},
    });
    const calls: Call[] = [];
    const { result } = await withIntercept(state, deadProxyFetch(calls), async () => {
        rememberOriginalBody("t-giveup", ORIGINAL_BODY);
        const res = await globalThis.fetch(UPSTREAM_URL, {
            method: "POST",
            headers: { "content-type": "application/json", [INCREMENTAL_TURN_ID_HEADER]: "t-giveup" },
            body: DELTA_BODY,
        });
        return res.status;
    });
    assert.equal(result, 200);
    assert.equal(calls.length, 2, "one proxy attempt + one restored direct send");
    assert.ok(calls[0].url.startsWith(`${PROXY_ORIGIN}/bili/${UPSTREAM_URL}`));
    assert.equal(calls[1].url, UPSTREAM_URL);
    assert.equal(calls[1].body, ORIGINAL_BODY, "the direct send carries the ORIGINAL bytes, not the delta");
    assert.equal(calls[1].headers["x-bili-turn-id"], "t-giveup", "lane headers ride along untouched");
});

test("#3304 routed give-up: makeTarget(routedTarget) fall-back is restored too", async () => {
    const state = deadProxyState({
        prepareDirectSend: createPrepareDirectSend(),
        onGiveUp: () => {},
        onDispatch: () => {},
    });
    const calls: Call[] = [];
    const { result } = await withIntercept(state, deadProxyFetch(calls), async () => {
        rememberOriginalBody("t-routed", ORIGINAL_BODY);
        const res = await globalThis.fetch(`${PROXY_ORIGIN}/bili/${UPSTREAM_URL}`, {
            method: "POST",
            headers: { "content-type": "application/json", [INCREMENTAL_TURN_ID_HEADER]: "t-routed" },
            body: DELTA_BODY,
        });
        return res.status;
    });
    assert.equal(result, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, UPSTREAM_URL, "degrades to the embedded upstream");
    assert.equal(calls[1].body, ORIGINAL_BODY);
});

test("#3304 give-up with a turn id but NO stashed original refuses instead of sending the delta", async () => {
    const state = deadProxyState({
        prepareDirectSend: createPrepareDirectSend(),
        onGiveUp: () => {},
        onDispatch: () => {},
    });
    const calls: Call[] = [];
    const { error } = await withIntercept(state, deadProxyFetch(calls), async () => {
        await globalThis.fetch(UPSTREAM_URL, {
            method: "POST",
            headers: { "content-type": "application/json", [INCREMENTAL_TURN_ID_HEADER]: "t-ghost" },
            body: DELTA_BODY,
        });
    });
    assert.ok(error instanceof TypeError, "the request fails locally for the host to retry");
    assert.match(String(error), /retry the turn/);
    assert.equal(calls.length, 1, "NO direct send reached the upstream");
    assert.ok(calls[0].url.startsWith(`${PROXY_ORIGIN}/bili/`));
});

test("#3304 a throwing prepareDirectSend hook fails safe (refusal, not send)", async () => {
    const state = deadProxyState({
        prepareDirectSend: async () => {
            throw new Error("boom");
        },
        onGiveUp: () => {},
        onDispatch: () => {},
    });
    const calls: Call[] = [];
    const { error } = await withIntercept(state, deadProxyFetch(calls), async () => {
        await globalThis.fetch(UPSTREAM_URL, { method: "POST", body: DELTA_BODY });
    });
    assert.ok(error instanceof TypeError);
    assert.equal(calls.length, 1, "hook failure ⇒ no direct send");
});

test("#3304 bootstrap-fail (origin never landed) restores a swapped Request-object input (opencode shape)", async () => {
    // opencode replaces e.request BEFORE the intercept sees it: at
    // bootstrap-fail time the input IS the swapped Request.
    const state: NativeInterceptState = {
        origin: undefined,
        ready: Promise.resolve(undefined),
        prepareDirectSend: createPrepareDirectSend(),
        onDispatch: () => {},
    };
    const calls: Call[] = [];
    const { result } = await withIntercept(state, deadProxyFetch(calls), async () => {
        rememberOriginalBody("t-boot", ORIGINAL_BODY);
        const req = new Request(UPSTREAM_URL, {
            method: "POST",
            headers: { "content-type": "application/json", [INCREMENTAL_TURN_ID_HEADER]: "t-boot" },
            body: DELTA_BODY,
        });
        const res = await globalThis.fetch(req);
        return res.status;
    });
    assert.equal(result, 200);
    assert.equal(calls.length, 1, "bootstrap-fail goes straight to the direct send");
    assert.equal(calls[0].url, UPSTREAM_URL);
    assert.equal(calls[0].body, ORIGINAL_BODY);
});

test("#3304 no hook armed ⇒ fall-back is byte-identical to pre-fix (unswapped lanes unaffected)", async () => {
    const state = deadProxyState({ onGiveUp: () => {}, onDispatch: () => {} });
    const plainBody = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] });
    const calls: Call[] = [];
    const { result } = await withIntercept(state, deadProxyFetch(calls), async () => {
        const res = await globalThis.fetch(UPSTREAM_URL, { method: "POST", headers: { "content-type": "application/json" }, body: plainBody });
        return res.status;
    });
    assert.equal(result, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, UPSTREAM_URL);
    assert.equal(calls[1].body, plainBody, "sent exactly as the host built it");
});

// ── E. pi guard (envelope sniffing) ─────────────────────────────────────────

const { createPiDirectSendGuard, __stashPiIncrementalOriginalForTests, __resetPiIncrementalOriginalsForTests } = await import("../src/agent/pi.ts");

test("#3304 pi guard: envelope body + stashed original ⇒ restored", async () => {
    try {
        __resetPiIncrementalOriginalsForTests();
        __stashPiIncrementalOriginalForTests("conv-1", JSON.parse(ORIGINAL_BODY));
        const guard = createPiDirectSendGuard();
        const prep = await guard(UPSTREAM_URL, UPSTREAM_URL, { method: "POST", body: DELTA_BODY });
        assert.deepEqual(prep, { outcome: "restored", body: ORIGINAL_BODY });
    } finally {
        __resetPiIncrementalOriginalsForTests();
    }
});

test("#3304 pi guard: envelope body WITHOUT stashed original ⇒ unrestorable", async () => {
    try {
        __resetPiIncrementalOriginalsForTests();
        const prep = await createPiDirectSendGuard()(UPSTREAM_URL, UPSTREAM_URL, { method: "POST", body: DELTA_BODY });
        assert.deepEqual(prep, { outcome: "unrestorable" });
    } finally {
        __resetPiIncrementalOriginalsForTests();
    }
});

test("#3304 pi guard: ordinary anthropic body (full resend) ⇒ as-is", async () => {
    __resetPiIncrementalOriginalsForTests();
    const prep = await createPiDirectSendGuard()(UPSTREAM_URL, UPSTREAM_URL, { method: "POST", body: ORIGINAL_BODY });
    assert.deepEqual(prep, { outcome: "as-is" });
});

test("#3304 pi guard: unreadable/stream body ⇒ as-is (cannot inspect, treat as standalone)", async () => {
    __resetPiIncrementalOriginalsForTests();
    const req = new Request(UPSTREAM_URL, {
        method: "POST",
        body: ReadableStream.from([new TextEncoder().encode(DELTA_BODY)]),
        duplex: "half",
    } as RequestInit & { duplex?: string });
    // consume the stream so clone().text() cannot read it
    await req.arrayBuffer();
    const prep = await createPiDirectSendGuard()(UPSTREAM_URL, req, undefined);
    assert.deepEqual(prep, { outcome: "as-is" });
});

// ── F. adapter instance wiring: the swap stashes the exact original ────────

process.env.NODE_TEST_CONTEXT = "1";
import { after } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const { maybeIncrementalOpencode } = await import("../src/agent/opencode-native.ts");
const { ompIncrementalBeforeSend, _setOmpOriginForTest, __resetOmpIncrementalForTests } = await import("../src/agent/omp-native.ts");

function fakeLane(enabled: boolean): Promise<{ base: string; close: () => Promise<void> }> {
    const srv = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/__bili/plugin/turn") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocol: 1, feature: "pluginIncrementalTurns", enabled, storage: enabled ? "unified" : "legacy-only" }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise<void>((done) => srv.close(() => done())) })));
}

after(async () => {
    _setOmpOriginForTest(undefined);
});

test("#3304 opencode adapter: planned turn stashes the ORIGINAL body text under its turn id", async () => {
    try {
        __resetIncrementalClientForTests();
        const lane = await fakeLane(true);
        try {
            const origText = JSON.stringify({ model: "claude-test", max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
            const e = { request: new Request(UPSTREAM_URL, { method: "POST", headers: { "content-type": "application/json" }, body: origText }), sessionID: "oc-sid-1" };
            await maybeIncrementalOpencode(e as never, { proxyBase: lane.base } as never);
            const swapped = (e as { request: Request }).request;
            const turnId = swapped.headers.get(INCREMENTAL_TURN_ID_HEADER);
            assert.ok(turnId, "the swap stamps its per-request turn id");
            assert.notEqual(await swapped.text(), origText, "the request body IS the delta now");
            assert.equal(originalBodyForTurn(turnId), origText, "the stash holds the EXACT pre-swap bytes");
        } finally {
            await lane.close();
        }
    } finally {
        __resetIncrementalClientForTests();
    }
});

test("#3304 omp adapter: planned turn stashes the ORIGINAL init.body under its turn id", async () => {
    try {
        __resetIncrementalClientForTests();
        __resetOmpIncrementalForTests();
        const lane = await fakeLane(true);
        try {
            _setOmpOriginForTest(lane.base);
            const origText = JSON.stringify({ model: "claude-test", max_tokens: 64, prompt_cache_key: "omp-sid-1", messages: [{ role: "user", content: "hi" }] });
            const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: origText };
            await ompIncrementalBeforeSend(UPSTREAM_URL, init);
            const headers = init.headers as Headers;
            const turnId = headers.get(INCREMENTAL_TURN_ID_HEADER);
            assert.ok(turnId, "the swap stamps its per-request turn id");
            assert.notEqual(init.body, origText, "init.body IS the delta now");
            assert.equal(originalBodyForTurn(turnId), origText, "the stash holds the EXACT pre-swap bytes");
        } finally {
            _setOmpOriginForTest(undefined);
            await lane.close();
        }
    } finally {
        __resetIncrementalClientForTests();
    }
});
