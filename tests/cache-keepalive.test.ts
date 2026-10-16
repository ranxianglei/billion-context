// #3376 hermetic lane: idle prompt-cache keepalive engine. A real loopback
// fake upstream (node:http, listen(0) — deterministic ports per #360) serves
// canned Anthropic responses; clock + timers are injected fakes so cadence,
// stop conditions and caps are asserted exactly without real waiting.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import http from "node:http";

import {
    buildPingBody,
    detectKeepaliveTier,
    keepaliveStatusFor,
    noteSuccessfulForward,
    resolveCacheKeepalive,
    _setKeepaliveClockForTest,
    _setKeepaliveSchedulerForTest,
    _resetKeepaliveForTest,
    _keepaliveArmedForTest,
    _keepaliveEntryForTest,
    type FakeScheduler,
    type KeepaliveArmInput,
    type ResolvedKeepalive,
} from "../src/cache-keepalive.ts";
import { parseRouteEntry, type ProviderRoutes } from "../src/config.ts";
import { acquireInFlight, dropSessionForGc, getSession, releaseInFlight, _resetSessionsForTest } from "../src/session.ts";

// ---- fake upstream -------------------------------------------------------

interface UpstreamReq {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}

const upstreamRequests: UpstreamReq[] = [];
let upstreamServer: http.Server;
let upstreamUrl: string;
let killConnections = false;

const HIT_BODY = {
    id: "msg_ping",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "." }],
    usage: { input_tokens: 1, cache_read_input_tokens: 1234 },
};
const MISS_BODY = { ...HIT_BODY, usage: { input_tokens: 1, cache_read_input_tokens: 0 } };

type CannedReply = { status?: number; body?: unknown };
let nextReply: CannedReply = { status: 200, body: HIT_BODY };

before(async () => {
    upstreamServer = http.createServer((req, res) => {
        if (killConnections) {
            req.socket.destroy();
            return;
        }
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            upstreamRequests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: data });
            const r = nextReply;
            res.writeHead(r.status ?? 200, { "content-type": "application/json" });
            res.end(JSON.stringify(r.body ?? {}));
        });
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const addr = upstreamServer.address();
    if (addr === null || typeof addr !== "object") throw new Error("fake upstream has no address");
    upstreamUrl = `http://127.0.0.1:${addr.port}/v1/messages`;
});

after(async () => {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

// ---- manual time ---------------------------------------------------------

class FakeTimers implements FakeScheduler {
    private seq = 1;
    now = 0;
    private pending: Array<{ id: number; due: number; fn: () => void }> = [];
    schedule(fn: () => void, ms: number): number {
        const id = this.seq++;
        this.pending.push({ id, due: this.now + ms, fn });
        return id;
    }
    cancel(id: unknown): void {
        this.pending = this.pending.filter((t) => t.id !== id);
    }
    pendingCount(): number {
        return this.pending.length;
    }
    /** Fire every timer whose deadline has arrived, oldest first. Timers
     *  scheduled DURING the advance land in the future and do not fire here. */
    advance(ms: number): void {
        this.now += ms;
        for (;;) {
            const due = this.pending.filter((t) => t.due <= this.now).sort((a, b) => a.due - b.due)[0];
            if (!due) return;
            this.pending = this.pending.filter((t) => t.id !== due.id);
            due.fn();
        }
    }
}

/** Poll until the async ping pipeline reaches a stable observable state
 *  (loopback HTTP completes in well under the timeout). */
async function settle(check: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    for (;;) {
        if (check()) return;
        if (Date.now() - start > timeoutMs) throw new Error(`settle timed out; requests so far: ${upstreamRequests.length}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

// ---- fixtures ------------------------------------------------------------

const ENV_KEYS = [
    "BILI_CACHE_KEEPALIVE",
    "BILI_CACHE_KEEPALIVE_TTL_FACTOR",
    "BILI_CACHE_KEEPALIVE_MAX_DURATION_MS",
    "BILI_CACHE_KEEPALIVE_MAX_PINGS",
    "BILI_CACHE_KEEPALIVE_ASSUME_TTL",
    "BILI_CACHE_KEEPALIVE_ARM_WITHOUT_BREAKPOINTS",
    "BILI_CACHE_KEEPALIVE_INTERVAL_MS",
] as const;

function clearEnv(): void {
    for (const k of ENV_KEYS) delete process.env[k];
}

const BODY_5M = JSON.stringify({
    model: "claude-opus-test",
    max_tokens: 4096,
    stream: true,
    system: [{ type: "text", text: "You are a test assistant.", cache_control: { type: "ephemeral", ttl: "5m" } }],
    messages: [{ role: "user", content: "hi" }],
});
const PING_5M = JSON.stringify({
    model: "claude-opus-test",
    max_tokens: 1,
    stream: false,
    system: [{ type: "text", text: "You are a test assistant.", cache_control: { type: "ephemeral", ttl: "5m" } }],
    messages: [{ role: "user", content: "hi" }],
});
const BODY_1H = JSON.stringify({
    model: "claude-opus-test",
    max_tokens: 1024,
    stream: true,
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: "hi" }],
});
const BODY_NO_BP = JSON.stringify({
    model: "claude-opus-test",
    max_tokens: 1024,
    stream: true,
    system: "plain system",
    messages: [{ role: "user", content: "hi" }],
});

let timers: FakeTimers;
let sid: string;

function armInput(over: Partial<KeepaliveArmInput> = {}): KeepaliveArmInput {
    return {
        sessionId: sid,
        protocol: "anthropic",
        reqMethod: "POST",
        sidePassthrough: false,
        resignLane: false,
        wireBody: BODY_5M,
        upstreamUrl,
        headers: { "content-type": "application/json", "x-api-key": "sk-test-key", authorization: "Bearer client-token" },
        dispatcher: undefined,
        routes: undefined,
        ...over,
    };
}

beforeEach(() => {
    _resetKeepaliveForTest();
    _resetSessionsForTest();
    clearEnv();
    process.env["BILI_CACHE_KEEPALIVE"] = "1";
    upstreamRequests.length = 0;
    nextReply = { status: 200, body: HIT_BODY };
    killConnections = false;
    timers = new FakeTimers();
    _setKeepaliveClockForTest(() => timers.now);
    _setKeepaliveSchedulerForTest(timers);
    sid = `ka-${Math.random().toString(36).slice(2)}`;
    getSession(sid, { protocol: "anthropic" });
});

// ---- pure units ----------------------------------------------------------

test("buildPingBody: byte-exact rewrite of ONLY max_tokens and stream", () => {
    assert.equal(buildPingBody(BODY_5M), PING_5M);
    // a snapshot missing the fields gains them (still valid anthropic shape)
    const minimal = JSON.stringify({ model: "m", messages: [] });
    assert.deepEqual(JSON.parse(buildPingBody(minimal)), { model: "m", messages: [], max_tokens: 1, stream: false });
});

test("detectKeepaliveTier: 5m / 1h / mixed / nested / none", () => {
    assert.equal(detectKeepaliveTier(JSON.parse(BODY_5M)), "5m");
    assert.equal(detectKeepaliveTier(JSON.parse(BODY_1H)), "1h");
    const mixed = {
        system: [{ text: "a", cache_control: { type: "ephemeral", ttl: "5m" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
    };
    assert.equal(detectKeepaliveTier(mixed), "1h");
    assert.equal(detectKeepaliveTier(JSON.parse(BODY_NO_BP)), undefined);
    assert.equal(detectKeepaliveTier(null), undefined);
});

// ---- resolver cascade ----------------------------------------------------

test("resolveCacheKeepalive: defaults when nothing is set", () => {
    clearEnv();
    const r: ResolvedKeepalive = resolveCacheKeepalive(undefined, undefined);
    assert.deepEqual(r, {
        enabled: false,
        ttlFactor: 0.9,
        maxDurationMs: 86_400_000,
        maxConcurrentPings: 4,
        assumeTtl: undefined,
        armWithoutBreakpoints: false,
        intervalMs: undefined,
    });
});

test("resolveCacheKeepalive: provider level applies without env", () => {
    clearEnv();
    const routes: ProviderRoutes = { [upstreamUrl]: { cacheKeepalive: { enabled: true, assumeTtl: "1h", ttlFactor: 0.5 } } };
    const r = resolveCacheKeepalive(routes, upstreamUrl);
    assert.equal(r.enabled, true);
    assert.equal(r.assumeTtl, "1h");
    assert.equal(r.ttlFactor, 0.5);
});

test("resolveCacheKeepalive: env wins over provider; malformed env falls back", () => {
    const routes: ProviderRoutes = { [upstreamUrl]: { cacheKeepalive: { assumeTtl: "5m", intervalMs: 1000, ttlFactor: 0.5, maxConcurrentPings: 2 } } };
    process.env["BILI_CACHE_KEEPALIVE_ASSUME_TTL"] = "1h";
    process.env["BILI_CACHE_KEEPALIVE_INTERVAL_MS"] = "2000";
    let r = resolveCacheKeepalive(routes, upstreamUrl);
    assert.equal(r.assumeTtl, "1h");
    assert.equal(r.intervalMs, 2000);
    process.env["BILI_CACHE_KEEPALIVE_TTL_FACTOR"] = "not-a-number";
    process.env["BILI_CACHE_KEEPALIVE_MAX_PINGS"] = "0";
    r = resolveCacheKeepalive(routes, upstreamUrl);
    assert.equal(r.ttlFactor, 0.5, "malformed factor falls through to the provider tier");
    assert.equal(r.maxConcurrentPings, 2, "non-positive pings fall through to the provider tier");
});

test("resolveCacheKeepalive: model level beats provider; unknown/absent model falls through", () => {
    clearEnv();
    const routes: ProviderRoutes = {
        [upstreamUrl]: {
            cacheKeepalive: { enabled: true, ttlFactor: 0.5, maxConcurrentPings: 2 },
            models: { "claude-opus-4-6": { cacheKeepalive: { ttlFactor: 0.25 } } },
        },
    };
    let r = resolveCacheKeepalive(routes, upstreamUrl, "claude-opus-4-6");
    assert.equal(r.ttlFactor, 0.25, "model tier wins over the provider tier");
    assert.equal(r.maxConcurrentPings, 2, "unset model fields fall through to the provider tier");
    r = resolveCacheKeepalive(routes, upstreamUrl, "other-model");
    assert.equal(r.ttlFactor, 0.5, "unknown model uses the provider tier");
    r = resolveCacheKeepalive(routes, upstreamUrl);
    assert.equal(r.ttlFactor, 0.5, "absent model name uses the provider tier");
});

test("parseRouteEntry: per-model cacheKeepalive validated strictly", () => {
    const ok = parseRouteEntry({ models: { m: { cacheKeepalive: { ttlFactor: 0.25 } } } });
    assert.ok(ok);
    assert.equal(ok!.models?.["m"]?.cacheKeepalive?.ttlFactor, 0.25);
    assert.throws(() => parseRouteEntry({ models: { m: { cacheKeepalive: { bogusKey: 1 } } } }), /cacheKeepalive/);
});

// ---- arm gates ------------------------------------------------------------

test("arm: anthropic POST with 5m breakpoints arms at TTL×0.9", () => {
    noteSuccessfulForward(armInput());
    const e = _keepaliveEntryForTest(sid);
    assert.ok(e, "session armed");
    assert.equal(e!.cadenceMs, 270_000);
    assert.equal(e!.tierLabel, "5m");
    assert.deepEqual(_keepaliveArmedForTest(), [sid]);
    assert.equal(timers.pendingCount(), 1);
});

test("arm: 1h breakpoints arm at 1h×0.9", () => {
    noteSuccessfulForward(armInput({ wireBody: BODY_1H }));
    assert.equal(_keepaliveEntryForTest(sid)?.cadenceMs, 3_240_000);
});

for (const [name, over] of [
    ["non-anthropic protocol never arms", { protocol: "openai" as const }],
    ["GET never arms", { reqMethod: "GET" }],
    ["side passthrough never arms", { sidePassthrough: true }],
    ["re-sign lane never arms", { resignLane: true }],
    ["buffer body never arms", { wireBody: Buffer.from("{}") }],
] as Array<[string, Partial<KeepaliveArmInput>]>) {
    test(`arm: ${name}`, () => {
        noteSuccessfulForward(armInput(over));
        assert.deepEqual(_keepaliveArmedForTest(), []);
        assert.equal(timers.pendingCount(), 0);
    });
}

test("arm: no breakpoints and no override → stays un-armed", () => {
    noteSuccessfulForward(armInput({ wireBody: BODY_NO_BP }));
    assert.deepEqual(_keepaliveArmedForTest(), []);
});

test("arm: assumeTtl override arms a breakpoint-less body at the assumed tier", () => {
    process.env["BILI_CACHE_KEEPALIVE_ASSUME_TTL"] = "1h";
    noteSuccessfulForward(armInput({ wireBody: BODY_NO_BP }));
    const e = _keepaliveEntryForTest(sid);
    assert.equal(e?.cadenceMs, 3_240_000);
    assert.equal(e?.tierLabel, "1h(assumed)");
});

test("arm: armWithoutBreakpoints alone falls back to the 5m tier", () => {
    process.env["BILI_CACHE_KEEPALIVE_ARM_WITHOUT_BREAKPOINTS"] = "1";
    noteSuccessfulForward(armInput({ wireBody: BODY_NO_BP }));
    assert.equal(_keepaliveEntryForTest(sid)?.cadenceMs, 270_000);
});

test("arm: intervalMs wins over everything and implies breakpoint-less arming", () => {
    process.env["BILI_CACHE_KEEPALIVE_INTERVAL_MS"] = "61000";
    noteSuccessfulForward(armInput({ wireBody: BODY_1H }));
    const e = _keepaliveEntryForTest(sid);
    assert.equal(e?.cadenceMs, 61_000);
    assert.equal(e?.tierLabel, "interval:61000ms");
});

test("arm: disabled → nothing armed, stale entry cleared", () => {
    clearEnv();
    noteSuccessfulForward(armInput());
    assert.deepEqual(_keepaliveArmedForTest(), []);
});

test("arm: oversized snapshot is skipped", () => {
    noteSuccessfulForward(armInput({ wireBody: "x".repeat(64 * 1024 * 1024 + 1) }));
    assert.deepEqual(_keepaliveArmedForTest(), []);
});

test("arm: a new forward replaces the snapshot and resets the timer", async () => {
    noteSuccessfulForward(armInput());
    const second = JSON.stringify({ model: "claude-opus-test", max_tokens: 2, stream: true, system: "v2", cache_control: { type: "ephemeral", ttl: "5m" }, messages: [] });
    noteSuccessfulForward(armInput({ wireBody: second }));
    assert.equal(timers.pendingCount(), 1, "only ONE timer survives the re-arm");
    timers.advance(270_000);
    await settle(() => upstreamRequests.length === 1);
    const parsed = JSON.parse(upstreamRequests[0].body) as Record<string, unknown>;
    assert.equal(parsed["system"], "v2", "the NEWEST snapshot is replayed");
});

test("arm: concurrency cap evicts the oldest armed session", () => {
    process.env["BILI_CACHE_KEEPALIVE_MAX_PINGS"] = "2";
    for (const id of ["ka-old", "ka-mid", "ka-new"]) getSession(id, { protocol: "anthropic" });
    noteSuccessfulForward(armInput({ sessionId: "ka-old" }));
    noteSuccessfulForward(armInput({ sessionId: "ka-mid" }));
    noteSuccessfulForward(armInput({ sessionId: "ka-new" }));
    assert.deepEqual(_keepaliveArmedForTest().sort(), ["ka-mid", "ka-new"]);
});

// ---- ping lifecycle --------------------------------------------------------

test("ping: hit refreshes — byte-exact body, reschedule, counter", async () => {
    noteSuccessfulForward(armInput());
    timers.advance(270_000);
    await settle(() => upstreamRequests.length === 1 && timers.pendingCount() === 1);
    const req = upstreamRequests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.body, PING_5M, "ping body is byte-exact except max_tokens/stream");
    assert.equal(req.headers["x-api-key"], "sk-test-key", "stored credentials replayed");
    assert.equal(_keepaliveEntryForTest(sid)?.pingCount, 1);
    assert.deepEqual(_keepaliveArmedForTest(), [sid]);
    timers.advance(270_000);
    await settle(() => upstreamRequests.length === 2 && _keepaliveEntryForTest(sid)?.pingCount === 2);
});

test("ping: cache_read=0 disarms immediately (prefix dead)", async () => {
    nextReply = { status: 200, body: MISS_BODY };
    noteSuccessfulForward(armInput());
    timers.advance(270_000);
    await settle(() => upstreamRequests.length === 1 && _keepaliveArmedForTest().length === 0);
    assert.equal(timers.pendingCount(), 0, "no further pings scheduled");
});

test("ping: 2xx without usage disarms (nothing verifiable)", async () => {
    nextReply = { status: 200, body: { ok: true } };
    noteSuccessfulForward(armInput());
    timers.advance(270_000);
    await settle(() => upstreamRequests.length === 1 && _keepaliveArmedForTest().length === 0);
});

test("ping: HTTP 429 disarms immediately", async () => {
    nextReply = { status: 429, body: { error: { message: "rate limited" } } };
    noteSuccessfulForward(armInput());
    timers.advance(270_000);
    await settle(() => upstreamRequests.length === 1 && _keepaliveArmedForTest().length === 0);
    assert.equal(timers.pendingCount(), 0);
});

test("ping: transient errors back off, three consecutive failures disarm", async () => {
    nextReply = { status: 500, body: { error: "boom" } };
    noteSuccessfulForward(armInput());
    for (let i = 1; i <= 2; i++) {
        timers.advance(270_000);
        await settle(() => _keepaliveEntryForTest(sid)?.failStreak === i && timers.pendingCount() === 1);
    }
    assert.deepEqual(_keepaliveArmedForTest(), [sid], "two consecutive failures stay armed");
    timers.advance(270_000);
    await settle(() => upstreamRequests.length === 3 && _keepaliveArmedForTest().length === 0);
});

test("ping: a success resets the failure streak", async () => {
    nextReply = { status: 500, body: { error: "boom" } };
    noteSuccessfulForward(armInput());
    timers.advance(270_000);
    await settle(() => _keepaliveEntryForTest(sid)?.failStreak === 1 && timers.pendingCount() === 1);
    nextReply = { status: 200, body: HIT_BODY };
    timers.advance(270_000);
    await settle(() => _keepaliveEntryForTest(sid)?.pingCount === 1 && _keepaliveEntryForTest(sid)?.failStreak === 0);
    assert.deepEqual(_keepaliveArmedForTest(), [sid]);
});

test("ping: network failure counts toward the streak", async () => {
    killConnections = true;
    noteSuccessfulForward(armInput());
    for (let i = 1; i <= 2; i++) {
        timers.advance(270_000);
        await settle(() => _keepaliveEntryForTest(sid)?.failStreak === i && timers.pendingCount() === 1, 8000);
    }
    assert.deepEqual(_keepaliveArmedForTest(), [sid], "still armed after two network failures");
    timers.advance(270_000);
    await settle(() => _keepaliveArmedForTest().length === 0, 8000);
});

test("ping: busy session skips the tick and retries shortly", async () => {
    const s = getSession(sid);
    acquireInFlight(s);
    noteSuccessfulForward(armInput());
    timers.advance(270_000);
    await settle(() => timers.pendingCount() === 1);
    assert.equal(upstreamRequests.length, 0, "no ping while a real request is in flight");
    releaseInFlight(s);
    timers.advance(5_000);
    await settle(() => upstreamRequests.length === 1 && _keepaliveEntryForTest(sid)?.pingCount === 1);
});

test("ping: dropped session disarms without touching upstream", async () => {
    noteSuccessfulForward(armInput());
    assert.ok(dropSessionForGc(sid), "session dropped");
    timers.advance(270_000);
    await settle(() => _keepaliveArmedForTest().length === 0);
    assert.equal(upstreamRequests.length, 0);
});

test("ping: max-duration stops the keepalive even while hitting", async () => {
    process.env["BILI_CACHE_KEEPALIVE_MAX_DURATION_MS"] = "1000";
    noteSuccessfulForward(armInput());
    timers.advance(270_000);
    await settle(() => _keepaliveArmedForTest().length === 0);
    assert.equal(upstreamRequests.length, 0, "never fired — the duration check precedes the fetch");
});

test("ping: pings continue until the max duration elapses", async () => {
    process.env["BILI_CACHE_KEEPALIVE_INTERVAL_MS"] = "500";
    process.env["BILI_CACHE_KEEPALIVE_MAX_DURATION_MS"] = "1200";
    noteSuccessfulForward(armInput());
    timers.advance(500);
    await settle(() => _keepaliveEntryForTest(sid)?.pingCount === 1);
    timers.advance(500);
    await settle(() => _keepaliveEntryForTest(sid)?.pingCount === 2);
    timers.advance(500);
    await settle(() => _keepaliveArmedForTest().length === 0);
    assert.equal(upstreamRequests.length, 2, "no third ping past the duration cap");
});

test("keepaliveStatusFor: mirrors armed state, ping history and disarm", async () => {
    assert.equal(keepaliveStatusFor(sid), undefined, "nothing armed yet");
    noteSuccessfulForward(armInput());
    let st = keepaliveStatusFor(sid);
    assert.ok(st);
    assert.equal(st!.tierLabel, "5m");
    assert.equal(st!.cadenceMs, 270_000);
    assert.equal(st!.pingCount, 0);
    assert.equal(st!.failStreak, 0);
    assert.equal(st!.lastPingAt, undefined);
    assert.equal(st!.lastHitAt, undefined);
    timers.advance(270_000);
    await settle(() => keepaliveStatusFor(sid)?.lastHitAt !== undefined);
    st = keepaliveStatusFor(sid);
    assert.equal(st!.pingCount, 1);
    assert.equal(st!.lastPingAt, timers.now);
    assert.equal(st!.lastHitAt, timers.now);
    nextReply = { status: 200, body: MISS_BODY };
    timers.advance(270_000);
    await settle(() => _keepaliveArmedForTest().length === 0);
    assert.equal(keepaliveStatusFor(sid), undefined, "disarmed sessions report no state");
});
