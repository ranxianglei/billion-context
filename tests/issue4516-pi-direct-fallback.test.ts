import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// #4516: the gateless lanes (pi/omp/opencode-V1) had NO size judgment on their
// degraded direct-fallback path — a 1.06M-token raw history rode straight to
// the provider when the proxy was down. This suite pins the three facets of
// the fix in the SHARED intercept: the local oversize refusal (with #4111
// media-aware math, fail-open without a window header), the cooldown-gated
// respawn retry (no more direct-for-process-lifetime after a failed spawn),
// and the transition logging (every entry into / exit out of the degraded
// state lands in bili.log). Hermetic like native-intercept-selfheal.test.ts:
// XDG_STATE_HOME redirected so no event reaches a real log file.
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4516-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
const CHAIN_LOG_FILE = path.join(STATE_ROOT, "billion-context", "bili.log");
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const UPSTREAM = "http://127.0.0.1:8199/v1/chat/completions";
const PROXY = "http://127.0.0.1:40001";
const ROUTED = `${PROXY}/bili/${UPSTREAM}`;

function fakeFetch(sink: string[]) {
    return (async (input: string | URL | Request, _init?: RequestInit) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

function chatBody(textChars: number): string {
    return JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "x".repeat(textChars) }] });
}

function mediaBody(textChars: number, b64Chars: number): string {
    return JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: [
            { type: "text", text: "x".repeat(textChars) },
            { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(b64Chars)}` } },
        ] }],
    });
}

interface Ctx {
    sink: string[];
    fetch: () => typeof fetch;
    rearm: (v: typeof fetch) => void;
    state: import("../src/agent/native-intercept.js").NativeInterceptState;
}

/** Drive requests through a freshly installed intercept. The respawn stub
 *  fails by default (counts every fire); a test can reassign `state.respawn`
 *  mid-run to land a recovery, since the intercept reads it per request. */
async function withFallback<T>(
    fn: (ctx: Ctx & { respawnCount: () => number }) => Promise<T>,
    opts: { origin?: string; readyTimeoutMs?: number; spawnWaitMs?: number } = {},
): Promise<{ sink: string[]; log: string; result: T }> {
    const saved = globalThis.fetch;
    const sink: string[] = [];
    let respawnCalls = 0;
    const state: import("../src/agent/native-intercept.js").NativeInterceptState = {
        origin: opts.origin,
        ready: Promise.resolve(opts.origin),
        readyTimeoutMs: opts.readyTimeoutMs,
        spawnWaitMs: opts.spawnWaitMs,
        respawn: async () => {
            respawnCalls += 1;
            return undefined;
        },
    };
    const mod = await import("../src/agent/native-intercept.js");
    mod._resetForTest();
    try {
        fs.rmSync(CHAIN_LOG_FILE, { force: true });
    } catch {
        // first test of the file — nothing to clear
    }
    globalThis.fetch = fakeFetch(sink);
    try {
        assert.equal(mod.installNativeFetchIntercept(state), true);
        const result = await fn({
            sink,
            fetch: () => globalThis.fetch,
            rearm: (v) => { globalThis.fetch = v; },
            state,
            respawnCount: () => respawnCalls,
        });
        return { sink, log: fs.existsSync(CHAIN_LOG_FILE) ? fs.readFileSync(CHAIN_LOG_FILE, "utf8") : "", result };
    } finally {
        globalThis.fetch = saved;
        mod._resetForTest();
    }
}

test("#4516 oversize + window header + bootstrap failed → local 422, upstream never hit", async () => {
    const { sink, result } = await withFallback(async ({ fetch }) => {
        const res = await fetch()(UPSTREAM, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-context-window": "500" },
            body: chatBody(4_200_000),
        });
        const body = await res.json() as Record<string, unknown>;
        return { status: res.status, gate: res.headers.get("x-bili-gate"), body };
    });
    assert.equal(result.status, 422);
    assert.equal(result.gate, "oversize-refusal-fallback");
    assert.equal((result.body.error as { type: string }).type, "server_error");
    assert.equal((result.body.error as { code: string }).code, "bili_gate_oversize_refusal_fallback");
    assert.equal((result.body.error as { retryable: boolean }).retryable, true);
    assert.match(String((result.body.error as { message: string }).message), /did not come up/);
    // #4079 contract: the 500-token declaration is printed, but the local bar
    // never assumes below 1M — an undersized declaration cannot false-refuse.
    assert.match(String((result.body.error as { message: string }).message), /500 declared; the local bar never assumes below 1,000,000/);
    assert.deepEqual(sink, [], "the provider must never see an oversized direct send");
});

test("#4516 same refusal, anthropic wire shape (/messages)", async () => {
    const { result } = await withFallback(async ({ fetch }) => {
        const res = await fetch()("http://127.0.0.1:8199/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-context-window": "500" },
            body: chatBody(4_200_000),
        });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
    });
    assert.equal(result.status, 422);
    assert.equal(result.body.type, "error");
    assert.equal((result.body.error as { type: string }).type, "invalid_request_error");
});

test("#4516 fits the window → still goes direct (the refusal must not over-suppress)", async () => {
    const { sink, result } = await withFallback(async ({ fetch }) => {
        const res = await fetch()(UPSTREAM, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-context-window": "500" },
            body: chatBody(200),
        });
        return res.status;
    });
    assert.equal(result, 200);
    assert.deepEqual(sink, [UPSTREAM], "a fitting body keeps #1117-style direct semantics");
});

test("#4516 no window header → fail open to direct (never a false refusal from missing data)", async () => {
    const { sink, result } = await withFallback(async ({ fetch }) => {
        const res = await fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(4_200_000) });
        return res.status;
    });
    assert.equal(result, 200);
    assert.deepEqual(sink, [UPSTREAM]);
});

test("#4516 media-heavy body whose CORE TEXT fits → no false refusal (#4111 direction)", async () => {
    const { sink, result } = await withFallback(async ({ fetch }) => {
        const res = await fetch()(UPSTREAM, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-context-window": "500" },
            body: mediaBody(100, 4_200_000),
        });
        return res.status;
    });
    assert.equal(result, 200);
    assert.deepEqual(sink, [UPSTREAM], "media mass is excluded from the doom math");
});

test("#4516 media-heavy body whose core text is STILL over → refused", async () => {
    const { sink, result } = await withFallback(async ({ fetch }) => {
        const res = await fetch()(UPSTREAM, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-context-window": "500" },
            body: mediaBody(4_200_000, 4_200_000),
        });
        return res.status;
    });
    assert.equal(result, 422);
    assert.deepEqual(sink, []);
});

test("#4516 self-heal: failed bootstrap no longer means direct-for-process-lifetime", async () => {
    const { sink, log, result } = await withFallback(async ({ fetch, state, respawnCount }) => {
        const mod = await import("../src/agent/native-intercept.js");
        mod._setRespawnCooldownForTest(30);
        // Request 1: the armed stub fails → degraded direct send.
        const first = await fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(100) });
        assert.equal(first.status, 200);
        assert.equal(respawnCount(), 1);
        // The proxy comes back on the NEXT attempt (counted here — the
        // replacement stub no longer goes through the harness counter).
        let recoveredFires = 0;
        state.respawn = async () => {
            recoveredFires += 1;
            return PROXY;
        };
        await new Promise((r) => setTimeout(r, 40));
        const second = await fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(100) });
        assert.equal(second.status, 200);
        return respawnCount() + recoveredFires;
    });
    assert.equal(sink[0], UPSTREAM, "first request went direct while the spawn was dead");
    assert.ok(sink.includes(ROUTED), `recovered request must route through bili, got ${JSON.stringify(sink)}`);
    assert.equal(result, 2, "one respawn attempt per cooldown window, then recovery");
    assert.match(log, /proxy not ready — model requests go direct \(uncompressed\)/);
    assert.match(log, /proxy recovered — model requests resume compression \(was direct\)/);
});

test("#4516 cooldown bounds respawn retries: concurrent requests share ONE attempt", async () => {
    const { result } = await withFallback(async ({ fetch, respawnCount }) => {
        const mod = await import("../src/agent/native-intercept.js");
        mod._setRespawnCooldownForTest(5000);
        await Promise.all([
            fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(100) }),
            fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(100) }),
        ]);
        return respawnCount();
    });
    assert.equal(result, 1, "the second concurrent request must NOT stack another spawn attempt");
});

test("#4516 slow cold start: an in-flight spawn outliving the readiness cap is waited out, not refused (#4515 shape)", async () => {
    // Models the field report: bootstrap takes longer than the generic 15s
    // cap but finishes inside the owner's bring-up budget. Pre-fix the turn
    // would have been refused (or sent direct into a guaranteed upstream
    // rejection) at the cap; post-fix it waits out the spawn and routes.
    const slowOrigin = new Promise<string>((resolve) => setTimeout(() => resolve(PROXY), 120));
    const { sink, result } = await withFallback(async ({ fetch, state }) => {
        // Bootstrap already in flight at arm time (pending past the 50ms
        // readiness cap); the retry path must wait out the SAME in-flight
        // attempt under spawnWaitMs instead of refusing at the cap.
        state.ready = slowOrigin;
        state.respawn = () => slowOrigin;
        const res = await fetch()(UPSTREAM, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-context-window": "500" },
            body: chatBody(4_200_000),
        });
        return res.status;
    }, { readyTimeoutMs: 50, spawnWaitMs: 300 });
    assert.equal(result, 200, "the oversized turn must route once the in-flight spawn lands");
    assert.deepEqual(sink, [ROUTED], "waited out the spawn — nothing went direct");
});

test("#4516 transition logging: repeated degraded sends log ONCE per transition", async () => {
    const { log } = await withFallback(async ({ fetch }) => {
        const mod = await import("../src/agent/native-intercept.js");
        mod._setRespawnCooldownForTest(5000);
        for (let i = 0; i < 3; i++) {
            const res = await fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(100) });
            assert.equal(res.status, 200);
        }
        return undefined;
    });
    const directLines = log.split("\n").filter((l) => l.includes("model requests go direct (uncompressed)")).length;
    assert.equal(directLines, 1, `degraded entry logs exactly once, got ${directLines}`);
});

test("#4516 dead-proxy wording: after holding an origin, the refusal says it DIED (not 'did not come up')", async () => {
    const dyingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        throw new TypeError("fetch failed");
    }) as typeof fetch;
    const { sink, result } = await withFallback(async ({ fetch, rearm }) => {
        rearm(dyingFetch);
        const res = await fetch()(UPSTREAM, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-context-window": "500" },
            body: chatBody(4_200_000),
        });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
    }, { origin: PROXY });
    assert.equal(result.status, 422);
    assert.match(String((result.body.error as { message: string }).message), /died and no replacement came up/);
    assert.deepEqual(sink, [], "the direct fallback send is refused before touching the provider");
});
