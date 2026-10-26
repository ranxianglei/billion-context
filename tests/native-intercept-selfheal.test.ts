import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { installNativeFetchIntercept, type NativeInterceptState } from "../src/agent/native-intercept.js";

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

test("#1158 self-heal: third-party reset to a frozen bare fetch re-chains and keeps routing through bili", async () => {
    const bareSink: string[] = [];
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        rearm(fakeFetch(bareSink));
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
        // A re-read of the global yields a stable callable (accessor works).
        assert.equal(typeof fetch(), "function");
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

test("#1158 self-heal: non-function and self writes are ignored by the guard", async () => {
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        rearm(undefined as unknown as typeof globalThis.fetch);
        const mine = fetch();
        rearm(mine);
        const res = await mine("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
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
        scope.open(); // captures bili's top as its base; the write re-arms (#1158) onto its wrapper
        scope.close(); // guard fails (bili's chain on top) → wrapper torn down behind our back
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        await globalThis.fetch("https://registry.npmjs.org/billion-context");
    });
    assert.deepEqual(nativeSink, [
        "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
        "https://registry.npmjs.org/billion-context",
    ]);
});

test("#1410: writing back our OWN stale chain link is recognized as ours — no re-arm, top unchanged", async () => {
    const foreignSink: string[] = [];
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        const link1 = fetch();
        const foreign = fakeFetch(foreignSink);
        rearm(foreign); // genuine third-party evict → new top
        const topAfter = fetch();
        assert.notEqual(topAfter, link1);
        rearm(link1); // our own stale link written back — must be ignored
        assert.equal(fetch(), topAfter);
        const res = await fetch()("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
    });
    // Routing still flows through the third-party downstream adopted at re-arm.
    assert.deepEqual(foreignSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
    assert.deepEqual(sink, []);
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
            // A plain writable data property again (no accessor guard).
            assert.equal(Object.getOwnPropertyDescriptor(globalThis, "fetch")?.writable, true);
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

test("#1662: thousands of foreign re-wraps of the current top cannot grow request depth", async () => {
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
        // depending on Node/platform stack limits); the fixed code's cost is
        // O(1) per request regardless of history length.
        for (let i = 0; i < 16000; i++) {
            const base = globalThis.fetch;
            const wrapped = (async (input: string | URL | Request, init?: RequestInit) => base(input, init)) as typeof fetch;
            globalThis.fetch = wrapped;
        }
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
        const web = webAccessProxy();
        web.install();
        await web.run(async () => {
            const base = globalThis.fetch;
            globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => base(input, init)) as typeof fetch;
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
            globalThis.fetch = mark(globalThis.fetch); // second marked → must warn
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
            // First proxy use installs the wrapper → the adopt event fires here.
            assert.equal(await web.run(() => globalThis.fetch("https://example.invalid/article")).then(r => r.text()), "via-web-proxy");
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
