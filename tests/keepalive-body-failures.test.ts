import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, test } from "node:test";
import {
    keepaliveStatusFor,
    noteSuccessfulForward,
    _resetKeepaliveForTest,
    _setKeepaliveClockForTest,
    _setKeepaliveSchedulerForTest,
    type FakeScheduler,
} from "../src/cache-keepalive.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";

const sid = "keepalive-body-failures";
const cadence = 270_000;
const hit = JSON.stringify({ usage: { input_tokens: 1, cache_read_input_tokens: 1234 } });

class Timers implements FakeScheduler {
    now = 0;
    pending = new Map<number, { fn: () => void; ms: number }>();
    private next = 0;
    schedule(fn: () => void, ms: number): number {
        const id = ++this.next;
        this.pending.set(id, { fn, ms });
        return id;
    }
    cancel(id: unknown): void {
        if (typeof id === "number") this.pending.delete(id);
    }
    fire(): void {
        assert.equal(this.pending.size, 1);
        const [id, timer] = this.pending.entries().next().value!;
        this.pending.delete(id);
        this.now += timer.ms;
        timer.fn();
    }
}

let timers: Timers;
let server: http.Server;
let upstreamUrl: string;
let requests: string[];
let reply: (res: http.ServerResponse) => void;
let receivedStatuses: number[];
let completedReads: number;
const envKeys = [
    "BILI_CACHE_KEEPALIVE", "BILI_CACHE_KEEPALIVE_TTL_FACTOR", "BILI_CACHE_KEEPALIVE_MAX_DURATION_MS",
    "BILI_CACHE_KEEPALIVE_MAX_PINGS", "BILI_CACHE_KEEPALIVE_ASSUME_TTL",
    "BILI_CACHE_KEEPALIVE_ARM_WITHOUT_BREAKPOINTS", "BILI_CACHE_KEEPALIVE_INTERVAL_MS",
];
let originalEnv: Map<string, string | undefined>;

async function settle(check: () => boolean): Promise<void> {
    const start = Date.now();
    while (!check()) {
        assert.ok(Date.now() - start < 5000, "the real HTTP response did not settle");
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
}

function arm(ttl: "5m" | "1h" = "5m"): void {
    noteSuccessfulForward({
        sessionId: sid,
        protocol: "anthropic",
        reqMethod: "POST",
        sidePassthrough: false,
        resignLane: false,
        wireBody: JSON.stringify({
            model: "claude-test",
            max_tokens: 100,
            stream: true,
            system: [{ type: "text", text: "cached prefix", cache_control: { type: "ephemeral", ttl } }],
            messages: [{ role: "user", content: "hello" }],
        }),
        upstreamUrl,
        headers: { "content-type": "application/json" },
        dispatcher: undefined,
        routes: undefined,
    });
}

function brokenBody(status: number, kind: "truncated" | "gzip"): (res: http.ServerResponse) => void {
    return (res) => {
        res.writeHead(status, {
            "content-type": "application/json",
            connection: "close",
            ...(kind === "truncated"
                ? { "content-length": String(Buffer.byteLength(hit) + 32) }
                : { "content-encoding": "gzip" }),
        });
        res.end(hit);
    };
}

beforeEach(async (t) => {
    assert.ok("mock" in t);
    _resetKeepaliveForTest();
    _resetSessionsForTest();
    originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    process.env.BILI_CACHE_KEEPALIVE = "1";
    timers = new Timers();
    requests = [];
    receivedStatuses = [];
    completedReads = 0;
    _setKeepaliveClockForTest(() => timers.now);
    _setKeepaliveSchedulerForTest(timers);
    getSession(sid, { protocol: "anthropic" });
    reply = (res) => res.end(hit);
    server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
            requests.push(body);
            reply(res);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    upstreamUrl = `http://127.0.0.1:${address.port}/v1/messages`;
    const nativeFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
        const response = await nativeFetch(...args);
        receivedStatuses.push(response.status);
        const readText = response.text.bind(response);
        t.mock.method(response, "text", async () => {
            try {
                return await readText();
            } finally {
                completedReads += 1;
            }
        });
        return response;
    });
});

afterEach(async () => {
    _resetKeepaliveForTest();
    _resetSessionsForTest();
    for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

for (const kind of ["truncated", "gzip"] as const) {
    test(`a 200 ${kind} body failure retries at the normal cadence and recovers`, async () => {
        reply = brokenBody(200, kind);
        arm();
        timers.fire();
        await settle(() => completedReads === 1);
        assert.deepEqual(receivedStatuses, [200], "fetch returned headers before body consumption failed");
        assert.equal(keepaliveStatusFor(sid)?.failStreak, 1);
        assert.equal(keepaliveStatusFor(sid)?.pingCount, 0);
        assert.equal(keepaliveStatusFor(sid)?.lastHitAt, undefined);
        assert.equal(timers.pending.size, 1);
        assert.equal([...timers.pending.values()][0].ms, cadence);

        reply = (res) => res.end(hit);
        timers.fire();
        await settle(() => completedReads === 2);
        assert.equal(keepaliveStatusFor(sid)?.failStreak, 0);
        assert.equal(keepaliveStatusFor(sid)?.pingCount, 1);
        assert.equal(keepaliveStatusFor(sid)?.lastHitAt, 2 * cadence);
        assert.equal(timers.pending.size, 1);
        assert.equal(requests[0], requests[1], "the retry preserves the same cached prefix");
    });

    test(`three consecutive 200 ${kind} body failures exhaust the existing budget`, async () => {
        reply = brokenBody(200, kind);
        arm();
        for (let count = 1; count <= 3; count++) {
            timers.fire();
            await settle(() => completedReads === count);
            if (count < 3) assert.equal(keepaliveStatusFor(sid)?.failStreak, count);
        }
        assert.equal(keepaliveStatusFor(sid), undefined);
        assert.equal(timers.pending.size, 0);
        assert.deepEqual(receivedStatuses, [200, 200, 200]);
    });

    test(`a 429 ${kind} body still disarms after its first response`, async () => {
        reply = brokenBody(429, kind);
        arm();
        timers.fire();
        await settle(() => completedReads === 1);
        assert.deepEqual(receivedStatuses, [429]);
        assert.equal(keepaliveStatusFor(sid), undefined);
        assert.equal(timers.pending.size, 0);
    });
}

test("an unreadable 500 body uses the same failure budget", async () => {
    reply = brokenBody(500, "truncated");
    arm();
    timers.fire();
    await settle(() => completedReads === 1);
    assert.deepEqual(receivedStatuses, [500]);
    assert.equal(keepaliveStatusFor(sid)?.failStreak, 1);
    assert.equal(keepaliveStatusFor(sid)?.pingCount, 0);
    assert.equal(timers.pending.size, 1);
});

test("a failed old response body cannot spend the replacement snapshot's budget", async () => {
    let pendingResponse: http.ServerResponse | undefined;
    reply = (res) => {
        pendingResponse = res;
        res.writeHead(200, { "content-type": "application/json", "content-length": "4096" });
        res.write('{"usage":');
    };
    arm();
    timers.fire();
    await settle(() => receivedStatuses.length === 1);
    arm("1h");
    const replacement = keepaliveStatusFor(sid);
    assert.equal(replacement?.tierLabel, "1h");
    assert.ok(pendingResponse);
    pendingResponse.destroy();
    await settle(() => completedReads === 1);
    assert.deepEqual(keepaliveStatusFor(sid), replacement);
    assert.equal(timers.pending.size, 1);
    assert.equal([...timers.pending.values()][0].ms, 3_240_000);
});

for (const body of ["{}", '{"usage":{"cache_read_input_tokens":0}}', "not json"]) {
    test(`a completely received cache miss still disarms: ${body}`, async () => {
        reply = (res) => res.end(body);
        arm();
        timers.fire();
        await settle(() => completedReads === 1);
        assert.deepEqual(receivedStatuses, [200]);
        assert.equal(keepaliveStatusFor(sid), undefined);
        assert.equal(timers.pending.size, 0);
    });
}
