// #7176: a pinned attach target that is PROVEN dead must release the
// interceptor's fast-path origin plane. readyOrigin() short-circuits on
// state.origin (native-intercept), so a dead origin left bound there rewrites
// every later model request onto it — the documented "goes direct
// (uncompressed)" degradation is unreachable and the session fails turn after
// turn until the proxy returns. The spawn-fallback tail already clears the
// field; the pinned branch must do the same WITHOUT spawning (#1365: a second
// instance serves tools while the model channel stays pinned, so every bili
// tool call would 404).
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { verifyAttachAndRecover, _nativeStateForTest, _resetRegisterForTest, _setSpawnForTest } from "../src/agent/dsh-native.ts";
import { readyOrigin } from "../src/agent/native-intercept.ts";

const ENV_KEYS = ["BILLION_CONTEXT_ATTACH", "BILLION_CONTEXT_PROXY", "BILI_ATTACH_HEALTH_DEADLINE_MS", "BILI_ATTACH_EVIDENCE_GRACE_MS"] as const;

/** A loopback origin nothing listens on: bind :0, read the port, close, reuse
 *  the number. Hermetic — no fixed port to collide with a zone band or another
 *  suite in the same shard. */
async function deadOrigin(): Promise<string> {
    const server = http.createServer();
    const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${port}`;
}

function saveEnv(): Record<string, string | undefined> {
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k]!;
    }
}

test("#7176 a proven-dead pinned attach target releases the fast-path origin plane (no second instance)", async () => {
    const dead = await deadOrigin();
    const saved = saveEnv();
    // the verdict must land inside the test, not after the suite times out
    process.env.BILLION_CONTEXT_ATTACH = dead;
    process.env.BILLION_CONTEXT_PROXY = dead;
    process.env.BILI_ATTACH_HEALTH_DEADLINE_MS = "300";
    process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = "10";
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return dead;
    });
    try {
        _resetRegisterForTest(dead);
        const state = _nativeStateForTest();
        // apply() primes the fast path with the attach origin before the health
        // verdict exists — this is the state under test
        state.origin = dead;

        const landed = await verifyAttachAndRecover(dead);
        assert.equal(landed, undefined, "a dead pinned target resolves to no origin");
        assert.equal(spawnCalls, 0, "#1365: never spawn a second instance behind a pinned channel");

        assert.equal(state.origin, undefined, "the dead origin must leave the fast path");
        assert.equal(await readyOrigin(state), undefined, "later requests take the no-origin direct lane");
        assert.equal(await readyOrigin(state), undefined, "and stay there for the rest of the process");
    } finally {
        _setSpawnForTest(undefined);
        _resetRegisterForTest(undefined);
        restoreEnv(saved);
    }
});

test("#7176 a live pinned attach target keeps the fast path bound", async () => {
    // control arm: the release above must not fire when the target answers.
    let manifestRequests = 0;
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            manifestRequests += 1;
            // a NEWER version so the #3544 rotation path stays out of this arm
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "999.0.0", tools: {} }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    const origin = await new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve(`http://127.0.0.1:${addr.port}`);
        });
    });
    const saved = saveEnv();
    process.env.BILLION_CONTEXT_ATTACH = origin;
    process.env.BILLION_CONTEXT_PROXY = origin;
    process.env.BILI_ATTACH_HEALTH_DEADLINE_MS = "2000";
    _setSpawnForTest(async () => {
        throw new Error("a healthy pinned target must never spawn");
    });
    try {
        _resetRegisterForTest(origin);
        const state = _nativeStateForTest();
        state.origin = origin;

        const landed = await verifyAttachAndRecover(origin);
        assert.equal(landed, origin, "healthy target attaches as-is");
        assert.equal(state.origin, origin, "the live origin stays on the fast path");
        assert.ok(manifestRequests >= 1, "the manifest/version probe ran");
    } finally {
        _setSpawnForTest(undefined);
        _resetRegisterForTest(undefined);
        restoreEnv(saved);
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
