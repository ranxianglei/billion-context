import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
    fetchWithTimeout,
    fetchWithTransportRetry,
} from "../src/fetch-util.ts";
import {
    classifyUpstreamFailure,
    isFailFastUpstreamKind,
    UPSTREAM_FIRST_BYTE_TIMEOUT_CODE,
} from "../src/upstream-fail.ts";
import { replayMaxAttempts } from "../src/knobs.ts";
import { setLogCapture } from "../src/logger.ts";

function listen(server: http.Server): Promise<void> {
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const FIRST_BYTE_ENV = "BILI_UPSTREAM_FIRST_BYTE_MS";
const IDLE_ENV = "BILI_UPSTREAM_TIMEOUT_MS";
const REPLAY_BASE_ENV = "BILI_REPLAY_RETRY_BASE_MS";

function envGuard(pairs: Array<[string, string | undefined]>): () => void {
    const prev = pairs.map(([k]) => [k, process.env[k]] as [string, string | undefined]);
    for (const [k, v] of pairs) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return () => {
        for (const [k, v] of prev) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
}

function markerError(message = "The operation was aborted"): Error {
    const e = new Error(message) as Error & { code: string };
    e.name = "AbortError";
    e.code = UPSTREAM_FIRST_BYTE_TIMEOUT_CODE;
    return e;
}

function codeError(code: string, message: string, name = "Error"): Error {
    const e = new Error(message) as Error & { code: string };
    e.name = name;
    e.code = code;
    return e;
}

// ---------------------------------------------------------------------------
// Pure classification: the marker is a distinct, fail-fast kind; everything
// else (plain abort, undici headers/body timeouts) stays "upstream-timeout".
// ---------------------------------------------------------------------------

test("classification: the first-byte marker is its own fail-fast kind; timeouts stay upstream-timeout (#5807)", () => {
    // The marker — stamped only by fetchWithTimeout when a TIGHTENED phase-1
    // budget fires — classifies to the new, replayable kind.
    assert.equal(classifyUpstreamFailure(markerError()), "upstream-headers-timeout");
    // The marker rides the OUTER error with the real AbortError as cause — the
    // classifier must still surface it (chainOf walks outer-first).
    const wrapped = markerError();
    const inner = new Error("The operation was aborted") as Error;
    inner.name = "AbortError";
    (wrapped as Error & { cause?: unknown }).cause = inner;
    assert.equal(classifyUpstreamFailure(wrapped), "upstream-headers-timeout");
    assert.ok(isFailFastUpstreamKind("upstream-headers-timeout"), "first-byte timeout is fail-fast (replayable)");

    // Plain internal abort (no marker) — the pre-#5807 default shape — stays
    // non-replayed "upstream-timeout".
    const plainAbort = new Error("The operation was aborted") as Error;
    plainAbort.name = "AbortError";
    assert.equal(classifyUpstreamFailure(plainAbort), "upstream-timeout");
    assert.equal(isFailFastUpstreamKind("upstream-timeout"), false, "upstream-timeout must stay non-replayed");

    // undici's own transport timeouts are distinct sources and must NOT be
    // swept into the new kind (they are the full-budget transport caps, #551).
    assert.equal(classifyUpstreamFailure(codeError("UND_ERR_BODY_TIMEOUT", "timeout")), "upstream-timeout");
    assert.equal(classifyUpstreamFailure(codeError("UND_ERR_HEADERS_TIMEOUT", "timeout")), "upstream-timeout");
});

// ---------------------------------------------------------------------------
// e2e: tightened first-byte budget → the rejection carries the marker and is
// classified as the new kind (fetchWithTimeout, single attempt).
// ---------------------------------------------------------------------------

test("phase-1 trip under a TIGHTENED first-byte budget is marked upstream-headers-timeout (#5807)", async (t) => {
    const restore = envGuard([[FIRST_BYTE_ENV, "400"], [IDLE_ENV, undefined]]);
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    t.after(() => { setLogCapture(null); restore(); });

    let hits = 0;
    const server = http.createServer((req, res) => {
        hits += 1;
        req.resume();
        res.socket?.pause(); // accept, then go silent: no response byte ever
    });
    await listen(server);
    t.after(() => close(server));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/messages`;

    const started = Date.now();
    let rejected: unknown;
    try {
        await fetchWithTimeout(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        throw new Error("expected fetchWithTimeout to reject");
    } catch (e) {
        rejected = e;
    }
    assert.ok(Date.now() - started < 5000, "must fail at the 400ms phase-1 budget, not minutes later");
    const err = rejected as Error & { code?: string };
    assert.equal(err.code, UPSTREAM_FIRST_BYTE_TIMEOUT_CODE, "rejection must carry the first-byte marker");
    assert.equal(err.name, "AbortError", "name stays AbortError for downstream sniffers");
    assert.equal(classifyUpstreamFailure(err), "upstream-headers-timeout");
    assert.ok(logs.some((m) => m.includes("first-byte phase")), "watchdog must log the phase it tripped");
    assert.equal(hits, 1, "fetchWithTimeout is single-attempt");
});

// ---------------------------------------------------------------------------
// e2e: the new kind is fail-fast → the main transport path replays it in-proxy
// (the whole point: a wedged upstream no longer costs the host a 35s+/12min
// single-shot stall, it fails fast within the bounded replay budget).
// ---------------------------------------------------------------------------

test("fetchWithTransportRetry replays a tightened first-byte timeout in-proxy (#5807)", async (t) => {
    const restore = envGuard([[FIRST_BYTE_ENV, "400"], [IDLE_ENV, undefined], [REPLAY_BASE_ENV, "1"]]);
    t.after(() => restore());

    let hits = 0;
    const server = http.createServer((req, res) => {
        hits += 1;
        req.resume();
        res.socket?.pause();
    });
    await listen(server);
    t.after(() => close(server));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/messages`;

    let rejected: unknown;
    try {
        await fetchWithTransportRetry(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        throw new Error("expected fetchWithTransportRetry to reject");
    } catch (e) {
        rejected = e;
    }
    const err = rejected as Error & { code?: string };
    assert.equal(classifyUpstreamFailure(err), "upstream-headers-timeout", "final error keeps the marker kind");
    const expected = replayMaxAttempts(); // default 3
    assert.equal(hits, expected, `must replay within the bounded budget (${expected} attempts), not fail once`);
    assert.ok(expected >= 2, "default replay budget must be >1 for the replay to be observable");
});

// ---------------------------------------------------------------------------
// e2e: DEFAULT (first-byte budget NOT tightened) → the marker is NEVER stamped
// → a first-byte timeout still classifies as upstream-timeout and is NOT
// replayed. This is the byte-identical-default guarantee the #5831 decision
// demanded (no 3×12-min stacking on dead endpoints unless opted in).
// ---------------------------------------------------------------------------

test("DEFAULT (budget not tightened) first-byte timeout stays unmarked upstream-timeout, no replay", async (t) => {
    // No first-byte knob; an explicit short per-call timeout keeps the test
    // fast AND makes firstByteBudget === effective (not a split), exactly the
    // legacy single-phase shape.
    const restore = envGuard([[FIRST_BYTE_ENV, undefined], [IDLE_ENV, undefined], [REPLAY_BASE_ENV, "1"]]);
    t.after(() => restore());

    let hits = 0;
    const server = http.createServer((req, res) => {
        hits += 1;
        req.resume();
        res.socket?.pause();
    });
    await listen(server);
    t.after(() => close(server));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

    const started = Date.now();
    let rejected: unknown;
    try {
        await fetchWithTransportRetry(url, { method: "POST", body: "{}" }, 500);
        throw new Error("expected fetchWithTransportRetry to reject");
    } catch (e) {
        rejected = e;
    }
    assert.ok(Date.now() - started < 5000, "explicit 500ms timeout must cap phase 1");
    const err = rejected as Error & { code?: string };
    assert.notEqual(err.code, UPSTREAM_FIRST_BYTE_TIMEOUT_CODE, "default path must NOT stamp the marker");
    assert.equal(classifyUpstreamFailure(err), "upstream-timeout", "default stays upstream-timeout");
    assert.equal(hits, 1, "no replay on the default (non-split) first-byte timeout");
});

// ---------------------------------------------------------------------------
// e2e: BODY-phase (mid-stream) timeout is NEVER the new kind, even with the
// first-byte budget tightened — the #1706/#1714 guarantee that a healthy-but-
// slow stream is not truncated (and not replayed, which would double-deliver).
// ---------------------------------------------------------------------------

test("body-phase timeout under a tightened first-byte budget stays unmarked upstream-timeout (#1706/#1714)", async (t) => {
    // Split enabled: first-byte 300ms (won't fire — first byte is immediate),
    // idle/body 2000ms (the mid-stream silence that will trip).
    const restore = envGuard([[FIRST_BYTE_ENV, "300"], [IDLE_ENV, "2000"], [REPLAY_BASE_ENV, "1"]]);
    t.after(() => restore());

    let hits = 0;
    const server = http.createServer((req, res) => {
        hits += 1;
        req.resume();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: chunk 0\n\n"); // immediate first byte → phase 1 ends
        // then go silent: the 2000ms BODY budget (not the 300ms first-byte
        // budget) is what governs from here.
    });
    await listen(server);
    t.after(() => close(server));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/messages`;

    const started = Date.now();
    let rejected: unknown;
    try {
        const { response, clearTimer } = await fetchWithTimeout(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        // Phase 1 succeeded (we got the response headers + first byte). Now
        // consume the body; the silent gap trips the 2000ms body budget.
        await response.text();
        clearTimer();
        throw new Error("expected the body read to reject on the idle budget");
    } catch (e) {
        rejected = e;
    }
    assert.ok(Date.now() - started >= 1500, "body-phase trip must come from the ~2000ms body budget, not the 300ms first-byte budget");
    const err = rejected as Error & { code?: string };
    assert.notEqual(err.code, UPSTREAM_FIRST_BYTE_TIMEOUT_CODE, "body-phase timeout must NOT carry the first-byte marker");
    assert.equal(classifyUpstreamFailure(err), "upstream-timeout", "body-phase stays non-replayed upstream-timeout");
    assert.equal(hits, 1, "body-phase timeout must not replay (would double-deliver)");
});
