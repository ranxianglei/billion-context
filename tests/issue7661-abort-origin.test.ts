import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ABORT_ORIGIN, abortMidStreamLine, getAbortOrigin, setAbortOrigin } from "../src/logger.ts";

// #7661: DSH on 0.1.216 aborted ~20% of streaming requests mid-stream, but the
// "client aborted mid-stream" log line fired for BOTH a client that hung up
// AND a bili-initiated abort (runaway guard / upstream watchdog), because both
// surface as a generic AbortError on a destroyed/ended response. Triage could
// not tell who initiated the abort. This test pins the observability fix: the
// per-response abort-origin tag plus the log line that attributes it.

test("abortMidStreamLine attributes the line by origin (client vs bili)", () => {
    // No origin set (unknown) → the legacy client phrase, grep-stable.
    assert.equal(abortMidStreamLine("boom", undefined), "client aborted mid-stream: boom");
    // A client that hung up → the legacy client phrase, byte-identical to before.
    assert.equal(abortMidStreamLine("boom", "client-disconnect"), "client aborted mid-stream: boom");
    // A bili-initiated abort is no longer mislabeled "client"; the origin tag
    // rides the tail so the base phrase stays grep-stable.
    assert.equal(abortMidStreamLine("boom", "runaway-guard"), "bili-initiated abort mid-stream: boom [origin: runaway-guard]");
    assert.equal(abortMidStreamLine("boom", "upstream-watchdog"), "bili-initiated abort mid-stream: boom [origin: upstream-watchdog]");
    assert.equal(abortMidStreamLine("boom", "bili-internal"), "bili-initiated abort mid-stream: boom [origin: bili-internal]");
    // The plugin pipe sites log the bare phrase (no error message attached).
    assert.equal(abortMidStreamLine(undefined, undefined), "client aborted mid-stream");
    assert.equal(abortMidStreamLine(undefined, "client-disconnect"), "client aborted mid-stream");
    assert.equal(abortMidStreamLine(undefined, "runaway-guard"), "bili-initiated abort mid-stream [origin: runaway-guard]");
});

test("setAbortOrigin / getAbortOrigin round-trip on a real ServerResponse", async () => {
    let fresh: unknown;
    let tagged: unknown;
    let retagged: unknown;
    const server = http.createServer((req, res) => {
        fresh = getAbortOrigin(res);
        setAbortOrigin(res, "runaway-guard");
        tagged = getAbortOrigin(res);
        setAbortOrigin(res, "client-disconnect");
        retagged = getAbortOrigin(res);
        res.writeHead(200, { "content-type": "text/plain", connection: "close" });
        res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
        await new Promise<void>((resolve, reject) => {
            http.get({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
                res.resume();
                res.on("end", () => resolve());
            }).on("error", reject);
        });
    } finally {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.equal(fresh, undefined, "a fresh response carries no abort origin");
    assert.equal(tagged, "runaway-guard", "a tagged response reads back its origin");
    assert.equal(retagged, "client-disconnect", "the origin is re-writable");
});

test("ABORT_ORIGIN is the global symbol readable across module boundaries", () => {
    // Symbol.for lives in the global registry — a second reference to the same
    // key resolves to the very same symbol. That is what lets the tag be read
    // by a catch site in a different module without an import cycle.
    assert.equal(ABORT_ORIGIN, Symbol.for("bili.abortOrigin"));
});
