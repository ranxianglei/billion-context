import test from "node:test";
import assert from "node:assert/strict";
import { isTransientConnectionError, withConnectionRetry } from "../src/agent/shared.ts";

// #7758: the /acp & /acp-cache command paths hit a momentarily-dead proxy port during a
// fast respawn. isTransientConnectionError classifies the "socket is dead right now" errors
// (so the command can retry briefly + show a friendly notice) and must NOT misclassify
// timeouts or HTTP-level errors (which keep their historical handling).

function connErr(code: string): Error {
    const e = new Error(`fetch failed`) as Error & { cause?: { code?: string } };
    e.cause = { code };
    return e;
}

function connErrTopLevel(code: string): Error {
    const e = new Error(`connect ${code}`) as Error & { code?: string };
    e.code = code;
    return e;
}

test("#7758 isTransientConnectionError: connection codes are transient (cause.code + top-level code)", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]) {
        assert.equal(isTransientConnectionError(connErr(code)), true, `cause.code=${code} is transient`);
        assert.equal(isTransientConnectionError(connErrTopLevel(code)), true, `top-level code=${code} is transient`);
    }
});

test("#7758 isTransientConnectionError: a bare undici 'fetch failed' with no code is transient", () => {
    assert.equal(isTransientConnectionError(new Error("fetch failed")), true, "bare 'fetch failed' (undici socket wrapper) is transient");
});

test("#7758 isTransientConnectionError: timeouts are NOT transient (no retry, keep historical handling)", () => {
    // fetchJson's own timeout error: no code, message is not 'fetch failed'.
    assert.equal(isTransientConnectionError(new Error("timeout after 2000ms: http://127.0.0.1:18787/__bili/status")), false, "fetchJson timeout is not transient");
    // undici header-timeout: code UND_ERR_HEADERS_TIMEOUT (not in the set).
    assert.equal(isTransientConnectionError(connErr("UND_ERR_HEADERS_TIMEOUT")), false, "UND_ERR_HEADERS_TIMEOUT is not transient");
    assert.equal(isTransientConnectionError(connErrTopLevel("ABORT_ERR")), false, "ABORT_ERR is not transient");
    // A DNS hiccup (EAI_AGAIN) is NOT in the set — it is a name-resolution failure, not a
    // dead-socket-on-a-known-port, so it must not be retried as a fast-respawn.
    assert.equal(isTransientConnectionError(connErr("EAI_AGAIN")), false, "EAI_AGAIN is not transient");
});

test("#7758 isTransientConnectionError: non-Error and HTTP-level values are not transient", () => {
    assert.equal(isTransientConnectionError(undefined), false, "undefined is not transient");
    assert.equal(isTransientConnectionError(null), false, "null is not transient");
    assert.equal(isTransientConnectionError(new Error("some other failure")), false, "arbitrary error is not transient");
});

test("#7758 withConnectionRetry: passes through on first success (no retry)", async () => {
    let calls = 0;
    const out = await withConnectionRetry(async () => {
        calls += 1;
        return "ok";
    });
    assert.equal(out, "ok");
    assert.equal(calls, 1, "no retry on first success");
});

test("#7758 withConnectionRetry: retries a transient connection error then succeeds", async () => {
    let calls = 0;
    const out = await withConnectionRetry(async () => {
        calls += 1;
        if (calls < 3) throw connErr("ECONNREFUSED");
        return "recovered";
    });
    assert.equal(out, "recovered", "recovers after the port comes back");
    assert.equal(calls, 3, "two retries before success");
});

test("#7758 withConnectionRetry: re-throws a non-connection error immediately (no retry)", async () => {
    let calls = 0;
    await assert.rejects(
        withConnectionRetry(async () => {
            calls += 1;
            throw new Error("timeout after 2000ms: http://127.0.0.1:1");
        }),
        /timeout after 2000ms/,
    );
    assert.equal(calls, 1, "a timeout is not retried");
});

test("#7758 withConnectionRetry: a persistent connection error exhausts the budget and re-throws", async () => {
    let calls = 0;
    const started = Date.now();
    await assert.rejects(
        withConnectionRetry(async () => {
            calls += 1;
            throw connErr("ECONNREFUSED");
        }),
        (err: unknown) => isTransientConnectionError(err),
    );
    const elapsed = Date.now() - started;
    // 1 initial + 4 retries = 5 calls; the 4 waits are ~400ms each → ~1.6s (covers the 1.4s
    // fast-respawn window). Assert the call count exactly and the wait is in a sane band.
    assert.equal(calls, 5, "initial + 4 retries");
    assert.ok(elapsed >= 1400 && elapsed < 4000, `waited ~1.6s (got ${elapsed}ms)`);
});
