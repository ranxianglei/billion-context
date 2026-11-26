import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
    UPSTREAM_TIMEOUT_MS,
    fetchWithTimeout,
} from "../src/fetch-util.ts";
import { upstreamFirstByteMs } from "../src/knobs.ts";

function listen(server: http.Server): Promise<void> {
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const KNOB_ENV = "BILI_UPSTREAM_FIRST_BYTE_MS";

function restoreEnv(prev: string | undefined): void {
    if (prev === undefined) delete process.env[KNOB_ENV];
    else process.env[KNOB_ENV] = prev;
}

test("upstreamFirstByteMs defaults to the RESOLVED idle budget (follows a raised BILI_UPSTREAM_TIMEOUT_MS) and honors the env knob", () => {
    const prev = process.env[KNOB_ENV];
    const prevIdle = process.env.BILI_UPSTREAM_TIMEOUT_MS;
    try {
        delete process.env[KNOB_ENV];
        delete process.env.BILI_UPSTREAM_TIMEOUT_MS;
        // Default must be byte-identical to the pre-#5904 single-phase watchdog:
        // no shorter phase-1 bound unless the deployment opts in (#1706/#1714
        // guarantee — long silent prefills are legitimate and never truncated).
        assert.equal(upstreamFirstByteMs(), UPSTREAM_TIMEOUT_MS);
        // #5917 review: a deployment that RAISES the idle budget above 12 min
        // (documented: >12-min local-model prefills) must get the same raised
        // first-byte budget — the first cut pinned the fallback to the 720000
        // constant and silently re-capped those deployments at 12 min.
        process.env.BILI_UPSTREAM_TIMEOUT_MS = "3600000";
        assert.equal(upstreamFirstByteMs(), 3600000);
        // An explicit first-byte knob still wins over following the idle budget.
        process.env[KNOB_ENV] = "45000";
        assert.equal(upstreamFirstByteMs(), 45000);
        delete process.env[KNOB_ENV];
        // Garbage values fall back to the RESOLVED idle budget, not a constant.
        for (const bad of ["not-a-number", "0", "-5", "1.5"]) {
            process.env[KNOB_ENV] = bad;
            assert.equal(upstreamFirstByteMs(), 3600000, `bad value ${bad}`);
        }
    } finally {
        restoreEnv(prev);
        if (prevIdle === undefined) delete process.env.BILI_UPSTREAM_TIMEOUT_MS;
        else process.env.BILI_UPSTREAM_TIMEOUT_MS = prevIdle;
    }
});

test("phase-1 watchdog: upstream that accepts the request but never answers fails at the first-byte budget, not the 12-min idle budget (#5904)", async (t) => {
    const prev = process.env[KNOB_ENV];
    process.env[KNOB_ENV] = "400";
    // Never respond: swallow the request body, send nothing, hold the socket.
    const server = http.createServer((req, res) => {
        req.resume();
        res.socket?.pause();
        t.diagnostic(`wedged server saw ${req.method}`);
    });
    await listen(server);
    t.after(() => { restoreEnv(prev); return close(server); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/messages`;

    const started = Date.now();
    await assert.rejects(
        fetchWithTimeout(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
        (err: unknown) => {
            const name = (err as { name?: string }).name ?? String(err);
            t.diagnostic(`rejected after ${Date.now() - started}ms with ${name}`);
            // 400ms phase-1 budget (vs a 12-minute idle budget): the point of the fix.
            assert.ok(Date.now() - started < 5000, "must fail at the phase-1 budget, not minutes later");
            return true;
        },
    );
});

test("phase-2 re-arm: once the first byte arrives, slow chunk gaps are governed by the FULL idle budget, never the first-byte budget (#1706/#1714 guarantee)", async (t) => {
    const prev = process.env[KNOB_ENV];
    // First chunk fast (undici resolves the fetch around the first body data —
    // observed live in #5904 forensics), then stream chunks with gaps LONGER
    // than the first-byte budget: mid-stream silence must not trip the (short)
    // phase-1 timer.
    process.env[KNOB_ENV] = "250";
    const server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: chunk 0\n\n"); // immediate first byte → phase 1 ends
        let chunks = 0;
        const tick = setInterval(() => {
            chunks += 1;
            res.write(`data: chunk ${chunks}\n\n`);
            if (chunks >= 4) {
                clearInterval(tick);
                res.end();
            }
        }, 300); // 4 gaps of 300ms each, each > the 250ms phase-1 budget
        t.after(() => clearInterval(tick));
    });
    await listen(server);
    t.after(() => { restoreEnv(prev); return close(server); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/messages`;

    const { response, clearTimer } = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });
    try {
        const text = await response.text();
        assert.match(text, /chunk 4/);
    } finally {
        clearTimer();
    }
});

test("explicit per-call timeoutMs still caps phase 1 (min semantics)", async (t) => {
    const prev = process.env[KNOB_ENV];
    delete process.env[KNOB_ENV]; // knob default = 12 min
    const server = http.createServer((req, res) => {
        req.resume();
        res.socket?.pause();
    });
    await listen(server);
    t.after(() => { restoreEnv(prev); return close(server); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

    const started = Date.now();
    await assert.rejects(
        fetchWithTimeout(url, { method: "POST", body: "{}" }, 500),
        () => {
            assert.ok(Date.now() - started < 5000, "explicit 500ms timeout must cap phase 1");
            return true;
        },
    );
});
