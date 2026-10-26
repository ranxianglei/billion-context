import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
    _resetFirstByteWarnedOriginsForTest,
    _setFirstByteWarnMsForTest,
    armFirstByteWatchdog,
} from "../src/server/relay.ts";

process.env.NODE_ENV = "test";

const THRESHOLD_MS = 30;
const WAIT_MS = 150;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type LogCall = { level: string; msg: string };
function makeLog(): { log: (level: string, msg: string) => void; calls: LogCall[] } {
    const calls: LogCall[] = [];
    return { log: (level, msg): void => { calls.push({ level, msg }); }, calls };
}

beforeEach(() => {
    _resetFirstByteWarnedOriginsForTest();
    _setFirstByteWarnMsForTest(THRESHOLD_MS);
});

test("warns exactly once when the fetch is still pending past the threshold", async () => {
    const { log, calls } = makeLog();
    const ac = new AbortController();
    const timer = armFirstByteWatchdog({ url: "https://api.example.com/v1/messages", method: "POST", lane: "side", sessionId: "sess-1", log, signal: ac.signal });
    assert.notEqual(timer, undefined);
    await sleep(WAIT_MS);
    if (timer) clearTimeout(timer);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].level, "warn");
    assert.ok(calls[0].msg.startsWith("[sess-1] upstream awaiting first byte ≥"), calls[0].msg);
    // The target goes through maskUrlForLog — a non-allowlisted host is reduced
    // to <private-host>, so the warn line must never leak the real upstream host.
    assert.ok(calls[0].msg.includes(": POST https://<private-host>/v1/messages"), calls[0].msg);
    assert.ok(calls[0].msg.endsWith("(lane=side)"), calls[0].msg);
});

test("does not warn when the fetch settles before the threshold (caller clears)", async () => {
    const { log, calls } = makeLog();
    const ac = new AbortController();
    const timer = armFirstByteWatchdog({ url: "https://fast.example.com/v1/messages", method: "POST", lane: "main", sessionId: "s", log, signal: ac.signal });
    assert.notEqual(timer, undefined);
    clearTimeout(timer);
    await sleep(WAIT_MS);
    assert.equal(calls.length, 0);
});

test("dedupes per origin: a later pending request to the same origin stays silent", async () => {
    const { log, calls } = makeLog();
    const acA = new AbortController();
    const tA = armFirstByteWatchdog({ url: "https://dup.example.com/x", method: "POST", lane: "main", sessionId: "a", log, signal: acA.signal });
    await sleep(WAIT_MS);
    if (tA) clearTimeout(tA);
    assert.equal(calls.length, 1);
    // Same origin (scheme+host+port), different path — disarmed at arm time.
    const acB = new AbortController();
    const tB = armFirstByteWatchdog({ url: "https://dup.example.com/y", method: "POST", lane: "main", sessionId: "b", log, signal: acB.signal });
    assert.equal(tB, undefined);
    await sleep(WAIT_MS);
    assert.equal(calls.length, 1);
});

test("different origins each warn once (dedupe is keyed by origin, not global)", async () => {
    const { log, calls } = makeLog();
    const acA = new AbortController();
    const tA = armFirstByteWatchdog({ url: "https://a.example.com/", method: "GET", lane: "main", sessionId: "a", log, signal: acA.signal });
    const acB = new AbortController();
    const tB = armFirstByteWatchdog({ url: "https://b.example.com/", method: "GET", lane: "main", sessionId: "b", log, signal: acB.signal });
    await sleep(WAIT_MS);
    if (tA) clearTimeout(tA);
    if (tB) clearTimeout(tB);
    assert.equal(calls.length, 2);
});

test("does not warn when the client aborts before the threshold", async () => {
    const { log, calls } = makeLog();
    const ac = new AbortController();
    const timer = armFirstByteWatchdog({ url: "https://ab.example.com/", method: "POST", lane: "main", sessionId: "a", log, signal: ac.signal });
    assert.notEqual(timer, undefined);
    ac.abort();
    await sleep(WAIT_MS);
    assert.equal(calls.length, 0);
});

test("is disarmed when the signal was already aborted before arming", () => {
    const { log, calls } = makeLog();
    const ac = new AbortController();
    ac.abort();
    const timer = armFirstByteWatchdog({ url: "https://ab2.example.com/", method: "POST", lane: "main", sessionId: "a", log, signal: ac.signal });
    assert.equal(timer, undefined);
    assert.equal(calls.length, 0);
});

test("is disarmed when the threshold is disabled (<=0 or non-finite)", () => {
    const { log, calls } = makeLog();
    const ac = new AbortController();
    _setFirstByteWarnMsForTest(0);
    assert.equal(armFirstByteWatchdog({ url: "https://d.example.com/", method: "POST", lane: "main", sessionId: "a", log, signal: ac.signal }), undefined);
    _setFirstByteWarnMsForTest(Number.NaN);
    assert.equal(armFirstByteWatchdog({ url: "https://d.example.com/", method: "POST", lane: "main", sessionId: "a", log, signal: ac.signal }), undefined);
    assert.equal(calls.length, 0);
});

test("_resetFirstByteWarnedOriginsForTest lets a previously-warned origin warn again", async () => {
    const { log, calls } = makeLog();
    const ac1 = new AbortController();
    const t1 = armFirstByteWatchdog({ url: "https://rs.example.com/", method: "POST", lane: "main", sessionId: "a", log, signal: ac1.signal });
    await sleep(WAIT_MS);
    if (t1) clearTimeout(t1);
    assert.equal(calls.length, 1);
    _resetFirstByteWarnedOriginsForTest();
    const ac2 = new AbortController();
    const t2 = armFirstByteWatchdog({ url: "https://rs.example.com/", method: "POST", lane: "main", sessionId: "b", log, signal: ac2.signal });
    assert.notEqual(t2, undefined);
    await sleep(WAIT_MS);
    if (t2) clearTimeout(t2);
    assert.equal(calls.length, 2);
});
