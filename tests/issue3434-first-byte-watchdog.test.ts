import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
    _resetFirstByteWarnStateForTest,
    _setFirstByteWarnCooldownMsForTest,
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
    _resetFirstByteWarnStateForTest();
    _setFirstByteWarnMsForTest(THRESHOLD_MS);
    _setFirstByteWarnCooldownMsForTest(undefined);
});

test("warns when the fetch is still pending past the threshold", async () => {
    const { log, calls } = makeLog();
    const ac = new AbortController();
    const timer = armFirstByteWatchdog({ url: "https://api.example.com/v1/messages", method: "POST", lane: "side", sessionId: "sess-1", log, signal: ac.signal });
    assert.notEqual(timer, undefined);
    await sleep(WAIT_MS);
    if (timer) clearTimeout(timer);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].level, "warn");
    assert.ok(calls[0].msg.startsWith("[sess-1] upstream awaiting first byte ≥"), calls[0].msg);
    // #5164: the line carries the ACTUAL pending duration — under a post-wedge
    // late fire that far exceeds the nominal threshold and is the number triage
    // needs (the incident turns were held ~300s while the line said "≥30s").
    assert.ok(calls[0].msg.includes("(pending "), calls[0].msg);
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

test("same origin+session warns again after the cooldown passes (no permanent quota, #5164)", async () => {
    // Acceptance ②/④: a LATER stalled turn on the same origin+session — the
    // host-timeout retry in the #5139 incident shape — must get its own line.
    // The decision is fire-time vs last-warn-time (a decaying timestamp), never
    // a permanent per-origin claim, so a post-wedge late fire after a quiet
    // interval can no longer be silently swallowed by a burned quota.
    _setFirstByteWarnCooldownMsForTest(80);
    const { log, calls } = makeLog();
    const acA = new AbortController();
    const tA = armFirstByteWatchdog({ url: "https://dup.example.com/x", method: "POST", lane: "main", sessionId: "sess-1", log, signal: acA.signal });
    await sleep(WAIT_MS);
    if (tA) clearTimeout(tA);
    assert.equal(calls.length, 1);
    const acB = new AbortController();
    const tB = armFirstByteWatchdog({ url: "https://dup.example.com/y", method: "POST", lane: "main", sessionId: "sess-1", log, signal: acB.signal });
    await sleep(WAIT_MS + 100);
    if (tB) clearTimeout(tB);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].msg.startsWith("[sess-1] upstream awaiting first byte ≥"), calls[1].msg);
});

test("same origin+session within the cooldown stays silent (anti-spam negative direction, #3434 intent kept)", async () => {
    // A pathological fast stall loop on one origin+session must not log one line
    // per request: the second stall inside the cooldown window is suppressed.
    _setFirstByteWarnCooldownMsForTest(2000);
    const { log, calls } = makeLog();
    const acA = new AbortController();
    const tA = armFirstByteWatchdog({ url: "https://spam.example.com/x", method: "POST", lane: "main", sessionId: "sess-1", log, signal: acA.signal });
    await sleep(WAIT_MS);
    if (tA) clearTimeout(tA);
    assert.equal(calls.length, 1);
    const acB = new AbortController();
    const tB = armFirstByteWatchdog({ url: "https://spam.example.com/y", method: "POST", lane: "main", sessionId: "sess-1", log, signal: acB.signal });
    assert.notEqual(tB, undefined); // arming never consults warn history
    await sleep(WAIT_MS);
    if (tB) clearTimeout(tB);
    assert.equal(calls.length, 1);
});

test("different sessions on the same origin each warn (no cross-session suppression, #5164)", async () => {
    // One session's stall must not silence another session's stall on the same
    // upstream (the old per-origin Set did exactly that at arm time).
    _setFirstByteWarnCooldownMsForTest(2000);
    const { log, calls } = makeLog();
    const acA = new AbortController();
    const acB = new AbortController();
    const tA = armFirstByteWatchdog({ url: "https://x.example.com/", method: "GET", lane: "main", sessionId: "sess-a", log, signal: acA.signal });
    const tB = armFirstByteWatchdog({ url: "https://x.example.com/", method: "GET", lane: "main", sessionId: "sess-b", log, signal: acB.signal });
    assert.notEqual(tA, undefined);
    assert.notEqual(tB, undefined);
    await sleep(WAIT_MS);
    if (tA) clearTimeout(tA);
    if (tB) clearTimeout(tB);
    assert.equal(calls.length, 2);
});

test("different origins each warn (key includes origin, not session only)", async () => {
    const { log, calls } = makeLog();
    const acA = new AbortController();
    const acB = new AbortController();
    const tA = armFirstByteWatchdog({ url: "https://a.example.com/", method: "GET", lane: "main", sessionId: "a", log, signal: acA.signal });
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

test("_resetFirstByteWarnStateForTest lets a previously-warned key warn again", async () => {
    const { log, calls } = makeLog();
    const ac1 = new AbortController();
    const t1 = armFirstByteWatchdog({ url: "https://rs.example.com/", method: "POST", lane: "main", sessionId: "a", log, signal: ac1.signal });
    await sleep(WAIT_MS);
    if (t1) clearTimeout(t1);
    assert.equal(calls.length, 1);
    _resetFirstByteWarnStateForTest();
    const ac2 = new AbortController();
    const t2 = armFirstByteWatchdog({ url: "https://rs.example.com/", method: "POST", lane: "main", sessionId: "a", log, signal: ac2.signal });
    assert.notEqual(t2, undefined);
    await sleep(WAIT_MS);
    if (t2) clearTimeout(t2);
    assert.equal(calls.length, 2);
});
