import assert from "node:assert/strict";
import http from "node:http";
import { test, type TestContext } from "node:test";
import { Agent } from "undici";
import {
    _resetKeepaliveForTest,
    _setKeepaliveSchedulerForTest,
    keepaliveStatusFor,
    noteSuccessfulForward,
    type KeepaliveArmInput,
} from "../src/cache-keepalive.ts";
import { _resetSessionsForTest, getSession } from "../src/session.ts";

const ENV_KEYS = [
    "BILI_CACHE_KEEPALIVE", "BILI_CACHE_KEEPALIVE_TTL_FACTOR", "BILI_CACHE_KEEPALIVE_MAX_DURATION_MS",
    "BILI_CACHE_KEEPALIVE_MAX_PINGS", "BILI_CACHE_KEEPALIVE_ASSUME_TTL",
    "BILI_CACHE_KEEPALIVE_ARM_WITHOUT_BREAKPOINTS", "BILI_CACHE_KEEPALIVE_INTERVAL_MS",
] as const;
const HIT = JSON.stringify({ usage: { input_tokens: 1, cache_read_input_tokens: 1234 } });
const BODY = JSON.stringify({
    model: "keepalive-test", max_tokens: 32, stream: true,
    system: [{ type: "text", text: "cached prefix", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hello" }],
});
const NO_BREAKPOINT = JSON.stringify({ model: "keepalive-test", messages: [{ role: "user", content: "hello" }] });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    return { promise: new Promise<T>(r => { resolve = r; }), resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 2000); }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function setup(t: TestContext, phase: "headers" | "body") {
    const env = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.BILI_CACHE_KEEPALIVE = "1";
    process.env.BILI_CACHE_KEEPALIVE_MAX_PINGS = "1";
    _resetKeepaliveForTest();
    _resetSessionsForTest();
    const timers = new Map<number, () => void>();
    let timerId = 0;
    _setKeepaliveSchedulerForTest({
        schedule(fn) { const id = ++timerId; timers.set(id, fn); return id; },
        cancel(id) { timers.delete(id as number); },
    });
    const received = deferred<void>();
    const consumingBody = deferred<void>();
    const oldClosed = deferred<void>();
    let held: http.ServerResponse;
    let pingCount = 0;
    const requests: Array<{ url: string; body: string }> = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            requests.push({ url: req.url ?? "", body });
            if (req.url === "/ping" && ++pingCount === 1) {
                held = res;
                res.once("close", () => oldClosed.resolve());
                if (phase === "body") {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.write(HIT.slice(0, 9));
                }
                received.resolve();
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(req.url === "/ping" ? HIT : JSON.stringify({ normal: true }));
        });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const dispatcher = new Agent({ connections: 1, pipelining: 1 });
    const realFetch = globalThis.fetch;
    let pingSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (input, init) => {
        if (input === `${origin}/ping`) pingSignal = init?.signal;
        const response = await realFetch(input, init);
        if (input === `${origin}/ping`) {
            const readText = response.text.bind(response);
            Object.defineProperty(response, "text", {
                value: () => { consumingBody.resolve(); return readText(); },
            });
        }
        return response;
    };
    const sessionId = `keepalive-7142-${phase}-${t.name}`;
    getSession(sessionId, { protocol: "anthropic" });
    const input: KeepaliveArmInput = {
        sessionId, protocol: "anthropic", reqMethod: "POST", sidePassthrough: false, resignLane: false,
        wireBody: BODY, upstreamUrl: `${origin}/ping`, headers: { "content-type": "application/json", "x-api-key": "old-test-key" },
        dispatcher, routes: undefined,
    };
    t.after(async () => {
        _resetKeepaliveForTest();
        globalThis.fetch = realFetch;
        await dispatcher.destroy();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        _resetSessionsForTest();
        for (const key of ENV_KEYS) {
            if (env[key] === undefined) delete process.env[key];
            else process.env[key] = env[key];
        }
    });
    const fire = () => {
        assert.equal(timers.size, 1);
        const [id, callback] = timers.entries().next().value!;
        timers.delete(id);
        callback();
    };
    noteSuccessfulForward(input);
    fire();
    await within(phase === "headers" ? received.promise : consumingBody.promise, "ping stage");
    return {
        input, timers, fire, requests, oldClosed, getSignal: () => pingSignal,
        finishOld() {
            if (phase === "headers") held.writeHead(200, { "content-type": "application/json" });
            held.end(phase === "body" ? HIT.slice(9) : HIT);
        },
        async normalRequest() {
            const init: Omit<RequestInit, "dispatcher"> & { dispatcher: object } = {
                dispatcher, signal: AbortSignal.timeout(1000),
            };
            const response = await realFetch(`${origin}/normal`, init as RequestInit);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { normal: true });
        },
    };
}

for (const phase of ["headers", "body"] as const) {
    for (const change of ["replace", "disable", "rotate", "evict"] as const) {
        test(`${change} releases an in-flight keepalive waiting for ${phase}`, async t => {
            const f = await setup(t, phase);
            let currentSession: string | undefined;
            if (change === "replace") {
                noteSuccessfulForward({ ...f.input, wireBody: BODY.replace("hello", "new turn") });
                currentSession = f.input.sessionId;
            } else if (change === "disable") {
                process.env.BILI_CACHE_KEEPALIVE = "0";
                noteSuccessfulForward(f.input);
            } else if (change === "rotate") {
                noteSuccessfulForward({ ...f.input, wireBody: NO_BREAKPOINT, headers: { ...f.input.headers, "x-api-key": "new-test-key" } });
            } else {
                currentSession = `${f.input.sessionId}-other`;
                getSession(currentSession, { protocol: "anthropic" });
                noteSuccessfulForward({ ...f.input, sessionId: currentSession });
            }
            await f.normalRequest();
            await within(f.oldClosed.promise, "invalidated ping close");
            assert.equal(f.getSignal()?.aborted, true);
            assert.equal(f.requests.filter(request => request.url === "/normal").length, 1);
            assert.equal(f.requests[0]!.body, JSON.stringify({ ...JSON.parse(BODY), max_tokens: 1, stream: false }));
            if (currentSession) {
                assert.equal(keepaliveStatusFor(currentSession)?.failStreak, 0);
                assert.equal(keepaliveStatusFor(currentSession)?.pingCount, 0);
                f.fire();
                await f.normalRequest();
                assert.equal(keepaliveStatusFor(currentSession)?.pingCount, 1);
                assert.equal(keepaliveStatusFor(currentSession)?.failStreak, 0);
                assert.equal(f.timers.size, 1);
            } else {
                assert.equal(keepaliveStatusFor(f.input.sessionId), undefined);
                assert.equal(f.timers.size, 0);
            }
        });
    }

    test(`an unmodified snapshot keeps its live ${phase} request and records the hit`, async t => {
        const f = await setup(t, phase);
        noteSuccessfulForward({ ...f.input, wireBody: NO_BREAKPOINT });
        assert.equal(f.getSignal()?.aborted, false);
        assert.ok(keepaliveStatusFor(f.input.sessionId));
        f.finishOld();
        await f.normalRequest();
        assert.equal(keepaliveStatusFor(f.input.sessionId)?.pingCount, 1);
        assert.equal(keepaliveStatusFor(f.input.sessionId)?.failStreak, 0);
        assert.equal(f.timers.size, 1);
    });
}

test("keepalive cancellation works without AbortSignal.any on early Node 20", async t => {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, "any");
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true, writable: true });
    t.after(() => {
        if (original) Object.defineProperty(AbortSignal, "any", original);
        else Reflect.deleteProperty(AbortSignal, "any");
    });
    const f = await setup(t, "body");
    process.env.BILI_CACHE_KEEPALIVE = "0";
    noteSuccessfulForward(f.input);
    await f.normalRequest();
    await within(f.oldClosed.promise, "invalidated ping close");
    assert.equal(f.getSignal()?.aborted, true);
    assert.equal(keepaliveStatusFor(f.input.sessionId), undefined);
});
