import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { installNativeFetchIntercept, type NativeInterceptState } from "../src/agent/native-intercept.js";
import { installFetchChain, resetFetchChainForTest, runFetchIntegrityCheckForTest } from "../src/agent/fetch-chain/index.js";

// #2827: the fetch-chain diagnostics now land in the shared bili.log instead
// of the terminal. Keep this whole suite hermetic: point XDG_STATE_HOME at a
// throwaway dir for the life of the file (node --test runs each file in its
// own process) so no test event ever reaches a developer's real log file.
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-selfheal-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
const CHAIN_LOG_FILE = path.join(STATE_ROOT, "billion-context", "bili.log");
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

function fakeFetch(sink: string[]) {
    return (async (input: string | URL | Request, _init?: RequestInit) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

/** #5959: drive one integrity-watchdog check synchronously. The data-property
 *  guard heals evictions on the next tick instead of in a setter, so suites
 *  that simulate a third-party write steer the seam explicitly. */
function tick(): void {
    assert.equal(runFetchIntegrityCheckForTest(), true, "integrity watchdog must be armed");
}

async function withHeal<T>(fn: (ctx: { sink: string[]; rearm: (v: typeof fetch) => void; fetch: () => typeof fetch }) => Promise<T>): Promise<{ sink: string[]; result: T }> {
    const saved = globalThis.fetch;
    const sink: string[] = [];
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest();
    globalThis.fetch = fakeFetch(sink);
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const result = await fn({
            sink,
            rearm: (v) => {
                globalThis.fetch = v;
            },
            fetch: () => globalThis.fetch,
        });
        return { sink, result };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

test("native headersFor stamps a host recovery owner on the routed proxy request", async () => {
    const captured: Headers[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        captured.push(new Headers(init?.headers));
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        headersFor: () => ({ "x-bili-host-recovery-owner": "omp" }),
    };
    _resetForTest();
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        await globalThis.fetch("http://127.0.0.1:8199/v1/chat/completions", { method: "POST", body: "{}" });
        assert.equal(captured[0]?.get("x-bili-host-recovery-owner"), "omp");
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("#1158 self-heal: third-party reset to a frozen bare fetch re-chains and keeps routing through bili", async () => {
    const bareSink: string[] = [];
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        rearm(fakeFetch(bareSink));
        tick(); // the data-property guard adopts the evictor on the next check
        const res = await fetch()("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(bareSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
    assert.deepEqual(sink, []);
});

test("#1158 self-heal: third-party wrapper becomes the downstream (dsh-http-proxy apply shape)", async () => {
    const downstreamSeen: string[] = [];
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        const wrapper = (async (input: string | URL | Request, init?: RequestInit) => {
            downstreamSeen.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
            return fakeFetch([])(input, init);
        }) as typeof globalThis.fetch;
        rearm(wrapper);
        tick(); // adopt the wrapper as downstream before the next request
        const res = await fetch()("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        // Non-model URL still passes through to the third-party wrapper untouched.
        await fetch()("https://registry.npmjs.org/billion-context");
    });
    assert.deepEqual(downstreamSeen, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages", "https://registry.npmjs.org/billion-context"]);
    assert.deepEqual(sink, []);
    assert.equal(downstreamSeen.length, 2);
});

test("#1158 self-heal: guarded property is transparent when nobody fights it", async () => {
    const { sink } = await withHeal(async ({ fetch }) => {
        const res = await fetch()("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        // A healthy slot survives a check untouched, and a re-read of the
        // global yields a stable callable (data property works).
        tick();
        assert.equal(fetch(), globalThis.fetch);
        assert.equal(typeof fetch(), "function");
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

test("#1158 self-heal: a non-function write heals onto the module anchor; an own-link write-back resyncs quietly", async () => {
    const nativeSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    await withScope(nativeFetch, async () => {
        installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
        globalThis.fetch = undefined as unknown as typeof globalThis.fetch;
        tick(); // heals: nothing usable in the slot → re-anchor on the module anchor
        assert.equal(typeof globalThis.fetch, "function");
        const mine = globalThis.fetch;
        globalThis.fetch = mine; // our own link written back — resync, no repair
        tick();
        assert.equal(globalThis.fetch, mine);
        const res = await mine("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
    });
    assert.deepEqual(nativeSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

// #1410: a coexisting network-scope plugin (dsh-codex-subscription shape)
// wraps globalThis.fetch while its scope is open and, on scope end, restores
// ONLY if its wrapper still sits on top — then unconditionally nulls its own
// closure locals. If bili had adopted that transient wrapper as downstream,
// every later request died with "baseFetch is not a function". These suites
// pin the interleave outcomes: the chain must survive either teardown order.

function foreignScope() {
    let baseFetch: typeof fetch | undefined;
    let scopedFetch: typeof fetch | undefined;
    return {
        open: (): void => {
            baseFetch = globalThis.fetch;
            scopedFetch = (async (input: string | URL | Request, init?: RequestInit) => baseFetch!(input, init)) as typeof fetch;
            globalThis.fetch = scopedFetch;
        },
        close: (): void => {
            if (globalThis.fetch === scopedFetch) globalThis.fetch = baseFetch as typeof fetch;
            baseFetch = undefined;
            scopedFetch = undefined;
        },
    };
}

async function withScope<T>(anchor: typeof fetch, fn: (ctx: { scope: ReturnType<typeof foreignScope>; sink: string[] }) => Promise<T>): Promise<{ sink: string[]; result: T }> {
    const saved = globalThis.fetch;
    const sink: string[] = [];
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest({ anchor });
    globalThis.fetch = anchor;
    const scope = foreignScope();
    try {
        const result = await fn({ scope, sink });
        return { sink, result };
    } finally {
        // Reset BEFORE restoring ambient fetch: otherwise the restore routes
        // through the live #1158 guard and emits a spurious third-party-install
        // diagnostic for pure test teardown (#2685).
        _resetForTest();
        globalThis.fetch = saved;
    }
}

test("#1410: install inside a foreign network scope survives scope teardown (re-anchor)", async () => {
    const nativeSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    await withScope(nativeFetch, async ({ scope }) => {
        scope.open();
        assert.equal(installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") }), true);
        // While the scope is still open, routing rides the live wrapper.
        await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.deepEqual(nativeSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
        scope.close(); // its guard sees bili's chain on top → skips restore, nulls its locals
        tick(); // healthy slot — the check stays quiet across the teardown
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        await globalThis.fetch("https://registry.npmjs.org/billion-context");
    });
    assert.deepEqual(nativeSink, [
        "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
        "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
        "https://registry.npmjs.org/billion-context",
    ]);
});

test("#1410: foreign scope opening AFTER install — re-arm adopts its wrapper; teardown re-anchors", async () => {
    const nativeSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    await withScope(nativeFetch, async ({ scope }) => {
        const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
        assert.equal(installNativeFetchIntercept(state), true);
        scope.open(); // captures bili's top as its base; the write evicts bili's top from the slot
        scope.close(); // sees its own wrapper on top → restores bili's top; the wrapper is dropped
        tick(); // healthy slot — the check stays quiet across the teardown
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        await globalThis.fetch("https://registry.npmjs.org/billion-context");
    });
    assert.deepEqual(nativeSink, [
        "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
        "https://registry.npmjs.org/billion-context",
    ]);
});

test("#1410: writing back our OWN stale chain link resyncs top to it (no wrap, no budget)", async () => {
    const nativeSink: string[] = [];
    const foreignSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    await withScope(nativeFetch, async () => {
        installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
        const link1 = globalThis.fetch; // T1 (ds = module anchor)
        globalThis.fetch = fakeFetch(foreignSink); // genuine third-party evict
        tick(); // adopts the evictor → new top over foreign
        const topAfter = globalThis.fetch;
        assert.notEqual(topAfter, link1);
        globalThis.fetch = link1; // our own stale link written back to the slot
        tick(); // resync: top follows the written-back link instead of wrapping it
        assert.equal(globalThis.fetch, link1);
        const res = await link1("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
    });
    // Routing follows the written-back link's downstream (the module anchor),
    // not the evictor that was adopted in between.
    assert.deepEqual(nativeSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
    assert.deepEqual(foreignSink, []);
});

test("#1410: _resetForTest leaves a third-party redefined descriptor alone", async () => {
    const saved = globalThis.fetch;
    const nativeFetch = fakeFetch([]);
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest({ anchor: nativeFetch });
    globalThis.fetch = nativeFetch;
    try {
        const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
        assert.equal(installNativeFetchIntercept(state), true);
        const hostile = fakeFetch([]);
        Object.defineProperty(globalThis, "fetch", { value: hostile, writable: true, configurable: true, enumerable: true });
        _resetForTest();
        // The third party's legal redefine stands — a blind restore clobbers it.
        assert.equal(Object.getOwnPropertyDescriptor(globalThis, "fetch")?.value, hostile);
    } finally {
        Object.defineProperty(globalThis, "fetch", { value: saved, writable: true, configurable: true, enumerable: true });
        _resetForTest();
    }
});

test("#1410: every observed fetch torn down → loud failure, no silent corruption", async () => {
    const saved = globalThis.fetch;
    let inner: typeof fetch | undefined = fakeFetch([]);
    const doomed = (async (input: string | URL | Request, init?: RequestInit) => inner!(input, init)) as typeof fetch;
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest({ anchor: doomed });
    globalThis.fetch = doomed;
    try {
        const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
        assert.equal(installNativeFetchIntercept(state), true);
        inner = undefined; // the owner tears down the only path this process ever saw
        await assert.rejects(
            () => globalThis.fetch("http://127.0.0.1:8199/v1/messages"),
            (err: unknown) => err instanceof TypeError && /is not a function$/.test(err.message),
        );
    } finally {
        inner = fakeFetch([]);
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("#1158 escape hatch: BILI_RECLAIM_FETCH_PATCH=0 keeps the classic direct install", async () => {
    process.env.BILI_RECLAIM_FETCH_PATCH = "0";
    try {
        const saved = globalThis.fetch;
        const { _resetForTest } = await import("../src/agent/native-intercept.js");
        _resetForTest();
        const sink: string[] = [];
        globalThis.fetch = fakeFetch(sink);
        const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
        try {
            assert.equal(installNativeFetchIntercept(state), true);
            // A plain writable data property again (no accessor guard), and no
            // watchdog armed — the escape hatch is a full opt-out of self-heal.
            assert.equal(Object.getOwnPropertyDescriptor(globalThis, "fetch")?.writable, true);
            assert.equal(runFetchIntegrityCheckForTest(), false, "escape hatch arms no watchdog");
            const thirdParty = fakeFetch([]);
            globalThis.fetch = thirdParty;
            // The third party wins: direct send, no bili rewrite.
            assert.equal(globalThis.fetch, thirdParty);
            const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
            assert.equal(res.status, 200);
        } finally {
            globalThis.fetch = saved;
            _resetForTest();
        }
    } finally {
        delete process.env.BILI_RECLAIM_FETCH_PATCH;
    }
});

// #1662: dsh-codex-subscription's full churn shape — the plugin reads the
// CURRENT top (bili's chain), wraps it, writes it back, and repeats per
// operation. bili re-adopts each wrapper as downstream, so the chain
// accumulates one (wrapper, bili-link) pair per wrap:
// C_n → w_n → C_{n-1} → w_{n-1} → … . Pre-fix, every request walked the
// entire accumulated chain (each stacked link re-running the full dispatch),
// so stack depth grew with session lifetime until dsh web died with
// "RangeError: Maximum call stack size exceeded". The re-entry termination
// must keep request depth constant no matter how many wraps happened.

test("#1662: thousands of foreign re-wraps, drained tick-by-tick, cannot grow request depth", async () => {
    const nativeSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    const saved = globalThis.fetch;
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest({ anchor: nativeFetch });
    globalThis.fetch = nativeFetch;
    try {
        const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
        assert.equal(installNativeFetchIntercept(state), true);
        // 16000 sits well past the measured overflow threshold (~4-8K cycles
        // depending on Node/platform stack limits). The wraps land one per
        // operation (the #1662 dsh-codex-subscription shape) and the watchdog
        // drains each one as it lands — interleave a tick per wrap to model
        // that cadence across time. A single synchronous burst of ≥~10K wraps
        // inside one watchdog period (≤1 s) is an adversarial/host-crash
        // shape the data-property slot no longer masks (the old accessor's
        // setter laundered every write through a fresh top); see the #5959
        // PR notes.
        for (let i = 0; i < 16000; i++) {
            const base = globalThis.fetch;
            const wrapped = (async (input: string | URL | Request, init?: RequestInit) => base(input, init)) as typeof fetch;
            globalThis.fetch = wrapped;
            tick(); // drain this wrap as it lands (per-operation cadence)
        }
        const settled = globalThis.fetch;
        tick(); // quiescent: idle checks must not accumulate further layers
        assert.equal(globalThis.fetch, settled);
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
        await globalThis.fetch("https://registry.npmjs.org/billion-context");
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
    assert.deepEqual(nativeSink, [
        "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
        "https://registry.npmjs.org/billion-context",
    ]);
});

test("#1662: concurrent top-level requests are both fully dispatched (no false re-entry)", async () => {
    const nativeSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    const saved = globalThis.fetch;
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest({ anchor: nativeFetch });
    globalThis.fetch = nativeFetch;
    try {
        const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
        assert.equal(installNativeFetchIntercept(state), true);
        const [a, b] = await Promise.all([
            globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" }),
            globalThis.fetch("http://127.0.0.1:8199/v1/chat/completions"),
        ]);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
    assert.deepEqual(nativeSink, [
        "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
        "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/chat/completions",
    ]);
});

test("#1662: a steady-state foreign wrapper wrapping bili's chain stays in the chain (its hook still runs)", async () => {
    const nativeSink: string[] = [];
    const seenByWrapper: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    const saved = globalThis.fetch;
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest({ anchor: nativeFetch });
    globalThis.fetch = nativeFetch;
    try {
        const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
        assert.equal(installNativeFetchIntercept(state), true);
        const base = globalThis.fetch;
        const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
            seenByWrapper.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
            return base(input, init);
        }) as typeof fetch;
        globalThis.fetch = wrapped;
        tick(); // adopt the wrapper as downstream before the next request
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
    // The wrapper ran exactly once, saw the REWRITTEN url (it sits below the
    // top link), and the request reached the native fetch exactly once.
    assert.deepEqual(seenByWrapper, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
    assert.deepEqual(nativeSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

// Mirrors pi-web-access's marker, install guard, scoped proxy and loopback bypass.
function webAccessProxy() {
    const proxy = new AsyncLocalStorage<boolean>();
    let installs = 0;
    let calls = 0;
    return {
        get installs() { return installs; },
        get calls() { return calls; },
        install() {
            const base = globalThis.fetch;
            if (Reflect.get(base, "__piWebAccessProxyFetch") === true) return;
            const wrapper = (async (input: string | URL | Request, init?: RequestInit) => {
                calls++;
                const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
                if (proxy.getStore() && url.hostname !== "127.0.0.1") return new Response("via-web-proxy");
                return base(input, init);
            }) as typeof fetch;
            Object.defineProperty(wrapper, "__piWebAccessProxyFetch", { value: true });
            installs++;
            globalThis.fetch = wrapper;
        },
        run<T>(fn: () => T): T {
            this.install();
            return proxy.run(true, fn);
        },
    };
}

for (const first of ["bili", "web-access"]) {
    test(`pi-web-access: ${first} installs first, 1000 proxy scopes keep one wrapper and routing`, async () => {
        const nativeSink: string[] = [];
        await withScope(fakeFetch(nativeSink), async () => {
            const web = webAccessProxy();
            if (first === "web-access") web.install();
            const decisions: string[] = [];
            installNativeFetchIntercept({
                origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001"),
                onDispatch: (_url, action) => { decisions.push(action); },
            });
            web.install();
            tick(); // adopt the marked wrapper (or confirm a healthy slot) before asserting on the top
            const top = globalThis.fetch;
            assert.equal(Reflect.get(top, "__piWebAccessProxyFetch"), true);
            for (let i = 0; i < 1000; i++) {
                assert.equal(await web.run(() => globalThis.fetch("https://example.invalid/article")).then(r => r.text()), "via-web-proxy");
                assert.equal(globalThis.fetch, top);
            }
            await web.run(() => globalThis.fetch("https://api.example.invalid/v1/messages", { method: "POST" }));
            await globalThis.fetch("https://example.invalid/direct");
            assert.equal(web.installs, 1);
            assert.equal(web.calls, 1002);
            assert.deepEqual(decisions.filter(action => action === "rewrite"), ["rewrite"]);
        });
        assert.deepEqual(nativeSink, [
            "http://127.0.0.1:40001/bili/https://api.example.invalid/v1/messages",
            "https://example.invalid/direct",
        ]);
    });
}

test("pi-web-access: preserve an older proxy wrapper and still truncate unknown history beneath it", async () => {
    const nativeSink: string[] = [];
    await withScope(fakeFetch(nativeSink), async () => {
        installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
        let unknownCalls = 0;
        for (let i = 0; i < 16000; i++) {
            const base = globalThis.fetch;
            globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
                unknownCalls++;
                return base(input, init);
            }) as typeof fetch;
        }
        tick(); // adopt the topmost unknown wrap so the proxy wraps a bili link, not the raw history
        const web = webAccessProxy();
        web.install();
        tick(); // adopt the marked proxy wrapper
        await web.run(async () => {
            const base = globalThis.fetch;
            globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => base(input, init)) as typeof fetch;
            tick(); // adopt the transient write before it is read back
            const response = await globalThis.fetch("https://example.invalid/article");
            assert.equal(await response.text(), "via-web-proxy");
            assert.equal(web.installs, 1);
            await globalThis.fetch("https://api.example.invalid/v1/messages", { method: "POST" });
        });
        assert.equal(web.calls, 2);
        assert.equal(unknownCalls, 0);
    });
    assert.deepEqual(nativeSink, ["http://127.0.0.1:40001/bili/https://api.example.invalid/v1/messages"]);
});

test("pi-web-access: the marker follows the live downstream after a dead closure is re-anchored", async () => {
    const nativeSink: string[] = [];
    await withScope(fakeFetch(nativeSink), async ({ scope }) => {
        scope.open();
        Object.defineProperty(globalThis.fetch, "__piWebAccessProxyFetch", { value: true });
        let respawns = 0;
        installNativeFetchIntercept({
            origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001"),
            respawn: async () => { respawns++; return undefined; },
        });
        const top = globalThis.fetch;
        assert.equal(Reflect.get(top, "__piWebAccessProxyFetch"), true);
        scope.close();
        await top("https://api.example.invalid/v1/messages", { method: "POST" });
        assert.notEqual(Reflect.get(top, "__piWebAccessProxyFetch"), true);
        const web = webAccessProxy();
        web.install();
        assert.equal(await web.run(() => globalThis.fetch("https://example.invalid/article")).then(r => r.text()), "via-web-proxy");
        assert.equal(web.installs, 1);
        assert.equal(respawns, 0);
    });
    assert.deepEqual(nativeSink, ["http://127.0.0.1:40001/bili/https://api.example.invalid/v1/messages"]);
});

// #2685/#2827: diagnostics-only refinement of the #1158 third-party-install
// notice. A recognized pi-web-access FIRST install is a supported coexistence
// handshake (its own guard makes it the only one, #2435) — it must not read as
// an "evict attempt" fault. Unknown wrappers and any LATER (repeat/abnormal)
// marked install keep the full diagnostic.
// #2827 moved EVERY one of these events off stdout/stderr: they fire inside
// the host agent process where the terminal IS the interactive TUI, so a
// console write lands on the physical screen and pollutes the input box until
// the next redraw. The events now go to the shared bili.log — severity +
// wording are pinned against the FILE below, and TUI safety is pinned as zero
// bili bytes on console AND on the raw process streams. The routing machinery
// itself is covered by the suites above.
function withDiagnosticsCapture<T>(fn: () => Promise<T> | T): Promise<{ result: T; warns: string[]; logs: string[]; errors: string[]; out: string[]; err: string[]; lines: string[] }> {
    const warns: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    const origError = console.error;
    const origOutWrite = process.stdout.write;
    const origErrWrite = process.stderr.write;
    fs.mkdirSync(path.dirname(CHAIN_LOG_FILE), { recursive: true });
    fs.writeFileSync(CHAIN_LOG_FILE, "");
    console.warn = (...args: unknown[]) => { warns.push(args.map((a) => String(a)).join(" ")); };
    console.log = (...args: unknown[]) => { logs.push(args.map((a) => String(a)).join(" ")); };
    console.error = (...args: unknown[]) => { errors.push(args.map((a) => String(a)).join(" ")); };
    process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
    return Promise.resolve(fn()).then((result) => ({
        result, warns, logs, errors, out, err,
        lines: fs.readFileSync(CHAIN_LOG_FILE, "utf8").split("\n").filter((l) => l.length > 0),
    })).finally(() => {
        console.warn = origWarn;
        console.log = origLog;
        console.error = origError;
        process.stdout.write = origOutWrite;
        process.stderr.write = origErrWrite;
    });
}

/** #2827 TUI-safety assertion: no bili diagnostic may reach the host terminal
 *  through ANY channel (console methods or raw stream writes). */
function assertNoTerminalBili(out: string[], err: string[]): void {
    const terminal = [...out, ...err].join("");
    assert.ok(!terminal.includes("[bili-native]"), `terminal streams received bili diagnostics: ${terminal}`);
}

test("#2685: bili-first — supported first web-access install is quietly adopted (proxy runs, model routed once)", async () => {
    const nativeSink: string[] = [];
    const decisions: string[] = [];
    const { warns, logs, errors, out, err, lines } = await withDiagnosticsCapture(async () => {
        await withScope(fakeFetch(nativeSink), async () => {
            installNativeFetchIntercept({
                origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001"),
                onDispatch: (_url, action) => { decisions.push(action); },
            });
            const web = webAccessProxy();
            web.install();
            tick(); // the supported first adopt fires on the check, not in a setter
            assert.equal(web.installs, 1);
            assert.equal(await web.run(() => globalThis.fetch("https://example.invalid/article")).then(r => r.text()), "via-web-proxy");
            await globalThis.fetch("https://api.example.invalid/v1/messages", { method: "POST" });
        });
    });
    assert.equal(warns.length, 0);
    assert.equal(logs.length, 0);
    assert.equal(errors.length, 0);
    assertNoTerminalBili(out, err);
    assert.ok(lines.some(l => l.includes("[info]") && l.includes("[native-client]") && l.includes("adopted pi-web-access proxy fetch as downstream")));
    assert.deepEqual(decisions.filter(a => a === "rewrite"), ["rewrite"]);
    assert.deepEqual(nativeSink, ["http://127.0.0.1:40001/bili/https://api.example.invalid/v1/messages"]);
});

test("#2685: web-access-first — normal first coexistence emits no third-party-install warning", async () => {
    const nativeSink: string[] = [];
    const { warns, logs, errors, out, err, lines } = await withDiagnosticsCapture(async () => {
        await withScope(fakeFetch(nativeSink), async () => {
            const web = webAccessProxy();
            web.install();
            installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
            assert.equal(web.installs, 1);
            // bili adopts the existing marked wrapper as its initial downstream
            // (no setter write happens), so no third-party-install notice fires.
            await globalThis.fetch("https://api.example.invalid/v1/messages", { method: "POST" });
        });
    });
    assert.equal(warns.length, 0);
    assert.equal(logs.length, 0);
    assert.equal(errors.length, 0);
    assertNoTerminalBili(out, err);
    assert.equal(lines.filter(l => l.includes("[native-client]")).length, 0);
    assert.deepEqual(nativeSink, ["http://127.0.0.1:40001/bili/https://api.example.invalid/v1/messages"]);
});

test("#2685: unknown third-party install still warns, with neutral 'install N' wording (no 'evict')", async () => {
    const nativeSink: string[] = [];
    const { warns, logs, errors, out, err, lines } = await withDiagnosticsCapture(async () => {
        await withScope(fakeFetch(nativeSink), async () => {
            installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
            globalThis.fetch = fakeFetch([]);
            tick(); // the warn fires on the check that adopts the write
        });
    });
    assert.equal(warns.length, 0);
    assert.equal(logs.length, 0);
    assert.equal(errors.length, 0);
    assertNoTerminalBili(out, err);
    const diag = lines.filter(l => l.includes("[native-client]"));
    assert.equal(diag.length, 1);
    assert.match(diag[0], /\[warn\]/);
    assert.match(diag[0], /third-party globalThis\.fetch install detected \(#1158\)/);
    assert.match(diag[0], /install 1/);
    assert.doesNotMatch(diag[0], /evict/i);
});

test("#2685: a SECOND marked install still warns — the compat marker never blanket-suppresses the diagnostic", async () => {
    const nativeSink: string[] = [];
    const { warns, logs, errors, out, err, lines } = await withDiagnosticsCapture(async () => {
        await withScope(fakeFetch(nativeSink), async () => {
            installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
            const mark = (base: typeof fetch) => {
                const w = (async (input: string | URL | Request, init?: RequestInit) => base(input, init)) as typeof fetch;
                Object.defineProperty(w, "__piWebAccessProxyFetch", { value: true });
                return w;
            };
            globalThis.fetch = mark(globalThis.fetch); // first marked → quiet adopt note
            tick();
            globalThis.fetch = mark(globalThis.fetch); // second marked → must warn
            tick();
        });
    });
    assert.equal(warns.length, 0);
    assert.equal(logs.length, 0);
    assert.equal(errors.length, 0);
    assertNoTerminalBili(out, err);
    const diags = lines.filter(l => l.includes("[native-client]"));
    assert.equal(diags.length, 2);
    assert.ok(diags.some(l => l.includes("[info]") && l.includes("adopted pi-web-access proxy fetch as downstream")));
    const warnLine = diags.find(l => l.includes("[warn]"));
    assert.notEqual(warnLine, undefined);
    assert.match(warnLine!, /third-party globalThis\.fetch install detected \(#1158\)/);
    assert.doesNotMatch(warnLine!, /evict/i);
});

test("#2827: first web-access adoption writes nothing to the host terminal and repeat proxy scopes stay quiet", async () => {
    const nativeSink: string[] = [];
    const { out, err, lines } = await withDiagnosticsCapture(async () => {
        await withScope(fakeFetch(nativeSink), async () => {
            installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
            const web = webAccessProxy();
            // First proxy use installs the wrapper → the adopt event fires on the check.
            assert.equal(await web.run(() => globalThis.fetch("https://example.invalid/article")).then(r => r.text()), "via-web-proxy");
            tick();
            // Repeat ordinary proxy-scope calls must not re-emit anything.
            for (let i = 0; i < 3; i++) {
                assert.equal(await web.run(() => globalThis.fetch("https://example.invalid/article")).then(r => r.text()), "via-web-proxy");
            }
            await globalThis.fetch("https://api.example.invalid/v1/messages", { method: "POST" });
        });
    });
    assertNoTerminalBili(out, err);
    const diags = lines.filter(l => l.includes("[native-client]"));
    assert.equal(diags.length, 1);
    assert.match(diags[0], /\[info\] \[v=[^\]]+\] \[native-client\] \[bili-native\] adopted pi-web-access proxy fetch as downstream \(supported coexistence, #2435\)/);
    assert.deepEqual(nativeSink, ["http://127.0.0.1:40001/bili/https://api.example.invalid/v1/messages"]);
});

// #5959: the guarded install used to be a getter/setter accessor, which the
// DSH experimental-inspector's fetch observer refuses ("globalThis.fetch is an
// accessor and cannot be observed safely"). The install is now a plain
// writable data property; evictions (delete / redefine / third-party writes)
// are healed by the integrity watchdog on its next tick instead of in a setter.

test("#5959: default install is a plain writable data property — the DSH inspector guard passes verbatim", async () => {
    const nativeSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    await withScope(nativeFetch, async () => {
        installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
        // Verbatim from @deepseek-ai/dsh-experimental-inspector (network.js installFetchObserver):
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
        const original = globalThis.fetch;
        if (typeof original !== "function") throw new Error("inspector: globalThis.fetch is unavailable");
        if (descriptor !== void 0 && !("value" in descriptor))
            throw new Error("inspector: globalThis.fetch is an accessor and cannot be observed safely");
        assert.ok(descriptor !== undefined);
        if (!("value" in descriptor)) throw new Error("expected a data property descriptor");
        assert.equal(descriptor.writable, true);
        assert.equal(descriptor.configurable, true);
        assert.equal(descriptor.enumerable, true);
    });
});

test("#5959: delete and redefine evictions heal within one tick (#2791 shapes)", async () => {
    const nativeSink: string[] = [];
    const foreignSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    await withScope(nativeFetch, async () => {
        installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
        const installed = globalThis.fetch;
        Reflect.deleteProperty(globalThis, "fetch"); // eviction shape 1: the slot vanishes
        tick();
        assert.equal(typeof globalThis.fetch, "function");
        assert.notEqual(globalThis.fetch, installed); // re-anchored over the remaining fetch
        const foreign = fakeFetch(foreignSink);
        // Eviction shape 2: a getter-only accessor — a strict-mode plain assign
        // throws, so the heal must fall back to a configurable redefine.
        Object.defineProperty(globalThis, "fetch", { get: () => foreign, configurable: true, enumerable: true });
        tick();
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    });
    // The evictor becomes the adopted downstream (#1158 policy), not bypassed.
    assert.deepEqual(foreignSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
    assert.deepEqual(nativeSink, []);
});

test("#5959: a hostile accessor that swallows every write gives up loudly — and re-arms when the slot heals", async () => {
    const saved = globalThis.fetch;
    const foreignSink: string[] = [];
    const foreign = fakeFetch(foreignSink);
    let ours: typeof globalThis.fetch | undefined;
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    Object.defineProperty(globalThis, "fetch", { value: foreign, writable: true, configurable: true, enumerable: true });
    try {
        const { lines } = await withDiagnosticsCapture(async () => {
            installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
            ours = globalThis.fetch; // our chain link, before the hostile takeover
            assert.ok(ours !== undefined);
            Object.defineProperty(globalThis, "fetch", {
                get: () => foreign,
                set: () => { /* swallows every write — the readback never matches */ },
                configurable: true,
                enumerable: true,
            });
            for (let i = 0; i < 3; i++) tick(); // WATCHDOG_MAX_FAILURES consecutive unproductive repairs
            tick(); // the slot still resolves to a function → givenUp clears; the retry fails again and re-triggers the give-up (failures keeps counting)
            assert.equal(globalThis.fetch, foreign); // the slot still resolves through the hostile getter
            // The hostile plugin stands down: the slot holds our link again → recovery.
            Object.defineProperty(globalThis, "fetch", { value: ours as typeof globalThis.fetch, writable: true, configurable: true, enumerable: true });
            tick();
            assert.equal(globalThis.fetch, ours);
        });
        assert.ok(lines.some(l => l.includes("[error]") && l.includes("[native-client]") && l.includes("cannot take back globalThis.fetch")),
            `expected a give-up error line, got: ${lines.join(" | ")}`);
        assert.ok(lines.some(l => l.includes("[info]") && l.includes("[native-client]") && l.includes("re-armed after the give-up")),
            `expected a recovery info line, got: ${lines.join(" | ")}`);
    } finally {
        // A plain restore assignment would be swallowed by the hostile setter —
        // force the slot back to a data property first (the leak that broke #D/#E).
        Object.defineProperty(globalThis, "fetch", { value: saved, writable: true, configurable: true, enumerable: true });
        _resetForTest();
    }
});

test("#5959 review: a throwing getter eviction cannot escape the watchdog timer", async () => {
    const saved = globalThis.fetch;
    const preSink: string[] = [];
    const preFake = fakeFetch(preSink);
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    Object.defineProperty(globalThis, "fetch", { value: preFake, writable: true, configurable: true, enumerable: true });
    _resetForTest({ anchor: preFake }); // deterministic heal target below
    try {
        const { lines } = await withDiagnosticsCapture(async () => {
            installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
            const installed = globalThis.fetch;
            // Hostile shape beyond the swallowing setter: the GETTER itself throws.
            Object.defineProperty(globalThis, "fetch", {
                get: () => { throw new TypeError("fetch observer disabled"); },
                configurable: true,
                enumerable: true,
            });
            // Pre-fix the throw escaped the check into the setInterval callback
            // (uncaughtException → host process death).
            assert.doesNotThrow(() => tick());
            const d = Object.getOwnPropertyDescriptor(globalThis, "fetch");
            assert.ok(d !== undefined && "value" in d, "the heal converts the slot back to a data property");
            assert.notEqual(globalThis.fetch, installed); // re-anchored over the surviving fetch
            const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
            assert.equal(res.status, 200); // the healed chain routes model traffic
        });
        assert.deepEqual(preSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
        assert.ok(lines.some(l => l.includes("[warn]") && l.includes("lost the bili install (#2791)")),
            `expected the eviction warn line, got: ${lines.join(" | ")}`);
    } finally {
        Object.defineProperty(globalThis, "fetch", { value: saved, writable: true, configurable: true, enumerable: true });
        _resetForTest();
    }
});

// #5907: the no-guard postures (env escape hatch / non-configurable host
// property) are exactly where a third-party replacement silently un-routes
// model traffic — pin that each one names the degraded posture in bili.log
// instead of staying silent. The env-hatch case is fully reversible; the
// non-configurable case LOCKS the slot for the rest of this process
// (configurable:false can never be undone), so it must stay LAST in this file.
test("#5907: BILI_RECLAIM_FETCH_PATCH=0 keeps classic install and logs the disabled self-heal once", async () => {
    const saved = globalThis.fetch;
    const sink: string[] = [];
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40003", ready: Promise.resolve("http://127.0.0.1:40003") };
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    const savedEnv = process.env.BILI_RECLAIM_FETCH_PATCH;
    process.env.BILI_RECLAIM_FETCH_PATCH = "0";
    globalThis.fetch = fakeFetch(sink);
    _resetForTest();
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        // Classic install still routes on a normal host...
        await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.deepEqual(sink, ["http://127.0.0.1:40003/bili/http://127.0.0.1:8199/v1/messages"]);
        // ...and the disabled self-heal posture is named in bili.log.
        const log = fs.readFileSync(CHAIN_LOG_FILE, "utf8").split("\n");
        const warns = log.filter(l => l.includes("#5907") && l.includes("BILI_RECLAIM_FETCH_PATCH=0"));
        assert.equal(warns.length, 1);
    } finally {
        globalThis.fetch = saved;
        if (savedEnv === undefined) delete process.env.BILI_RECLAIM_FETCH_PATCH;
        else process.env.BILI_RECLAIM_FETCH_PATCH = savedEnv;
        _resetForTest();
    }
});

test("#5959: idle ticks never accumulate layers — at most one per external wrap", async () => {
    const nativeSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    await withScope(nativeFetch, async () => {
        installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") });
        for (let i = 0; i < 10; i++) {
            const base = globalThis.fetch;
            const wrapped = (async (input: string | URL | Request, init?: RequestInit) => base(input, init)) as typeof fetch;
            globalThis.fetch = wrapped;
            tick(); // adopt this one wrap
            const settled = globalThis.fetch;
            tick(); // an idle check must not re-adopt or nest another layer
            assert.equal(globalThis.fetch, settled);
        }
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(nativeSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

test("#5959: the real watchdog timer drives the check (eviction heals without a manual tick)", async () => {
    const saved = globalThis.fetch;
    const nativeSink: string[] = [];
    const foreignSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    resetFetchChainForTest({ anchor: nativeFetch });
    globalThis.fetch = nativeFetch;
    try {
        installFetchChain((send) => async (input, init) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            return url.includes("/v1/messages") ? send(`http://127.0.0.1:40001/bili/${url}`, init) : send(input, init);
        }, { watchdogIntervalMs: 5 });
        const foreign = fakeFetch(foreignSink);
        globalThis.fetch = foreign;
        await new Promise((resolve) => setTimeout(resolve, 100)); // ~20 watchdog periods
        assert.notEqual(globalThis.fetch, foreign, "the timer must have healed the eviction");
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    } finally {
        globalThis.fetch = saved;
        resetFetchChainForTest();
    }
    assert.deepEqual(foreignSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
    assert.deepEqual(nativeSink, []);
});

test("#5907: non-configurable globalThis.fetch degrades to classic install with a loud one-time warning", async () => {
    // NOTE: this test permanently locks globalThis.fetch (configurable:false is
    // irreversible within a process). node --test runs each file in its own
    // process, so nothing after this point can be affected — keep it last.
    const sink: string[] = [];
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40004", ready: Promise.resolve("http://127.0.0.1:40004") };
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest();
    Object.defineProperty(globalThis, "fetch", { value: fakeFetch(sink), writable: false, configurable: false });
    let threw: unknown = null;
    try {
        installNativeFetchIntercept(state);
    } catch (e) {
        threw = e; // strict-mode write to the non-writable slot — acceptable, the diagnostic below already fired
    }
    if (threw !== null) assert.match(String(threw), /fetch/i);
    // The call goes out UNROUTED (no /bili/ rewrite, proxy never sees it)...
    await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
    assert.deepEqual(sink, ["http://127.0.0.1:8199/v1/messages"]);
    // ...and the degraded posture is named in bili.log exactly once.
    const log = fs.readFileSync(CHAIN_LOG_FILE, "utf8").split("\n");
    const warns = log.filter(l => l.includes("#5907") && l.includes("not configurable"));
    assert.equal(warns.length, 1);
    assert.match(warns[0], /\/bili\//);
});
