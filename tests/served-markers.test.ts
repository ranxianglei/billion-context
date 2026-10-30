import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServedMarkerWriter, findContestedWriters, reapStaleWriterMarkers, writerMarkerDir, type WriterIdentity } from "../src/served-markers.ts";

// #3923: per-session writer markers — session-level split-brain visibility.
// Two live bili processes sharing one sessions directory already warn at
// MACHINE level (#394 registration, #2401 slow tick); these tests pin the
// SESSION level: who committed what when, both sides named, verdicts
// throttled, dead peers reaped, and the whole surface best-effort (no throw
// into the save chain).

const SELF: WriterIdentity = { instanceId: "self-1", pid: process.pid, origin: "http://127.0.0.1:18802", version: "0.1.202" };
const PEER: WriterIdentity = { instanceId: "peer-1", pid: process.pid, origin: "http://127.0.0.1:8787", version: "0.1.201" };
// Beyond any sane pid_max (Linux default 4194304) — provably dead.
const DEAD_PID = 999_999_999;

function freshDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePeerMarker(dir: string, peer: WriterIdentity, servedAt: Record<string, number>): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${peer.instanceId}.json`);
    fs.writeFileSync(file, JSON.stringify({ v: 1, ...peer, servedAt }));
    return file;
}

function backdate(file: string, ageMs: number): void {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, t, t);
}

test("marker file lands with identity + served sessions after flush", () => {
    const dir = writerMarkerDir(freshDir("bili-3923-marker-"));
    const logs: Array<[string, string]> = [];
    const w = createServedMarkerWriter(SELF, dir, (level, msg) => logs.push([level, msg]));
    w.noteServed("sess-a");
    w.__flushForTest();
    const body = JSON.parse(fs.readFileSync(path.join(dir, "self-1.json"), "utf8")) as Record<string, unknown>;
    assert.equal(body.v, 1);
    assert.equal(body.instanceId, "self-1");
    assert.equal(body.pid, process.pid);
    assert.equal(body.origin, "http://127.0.0.1:18802");
    assert.equal(body.version, "0.1.202");
    const servedAt = body.servedAt as Record<string, number>;
    assert.equal(typeof servedAt["sess-a"], "number");
    assert.deepEqual(w.__servedForTest(), { "sess-a": servedAt["sess-a"] });
    assert.equal(logs.length, 0, "no contention — no log lines");
    w.dispose();
});

test("dispose flushes pending entries; noteServed after dispose is a no-op", () => {
    const dir = writerMarkerDir(freshDir("bili-3923-dispose-"));
    const w = createServedMarkerWriter(SELF, dir, () => {});
    w.noteServed("sess-late");
    w.dispose();
    const body = JSON.parse(fs.readFileSync(path.join(dir, "self-1.json"), "utf8")) as Record<string, unknown>;
    assert.ok((body.servedAt as Record<string, number>)["sess-late"] !== undefined, "final flush persisted the entry");
    w.noteServed("sess-after-dispose");
    assert.ok((w.__servedForTest()["sess-after-dispose"]) === undefined, "disposed writer records nothing");
});

test("contested session logs [split-brain] with both sides named, once per verdict window", () => {
    const dir = writerMarkerDir(freshDir("bili-3923-contest-"));
    const logs: Array<[string, string]> = [];
    writePeerMarker(dir, PEER, { "sess-a": Date.now() - 1000 });
    const w = createServedMarkerWriter(SELF, dir, (level, msg) => logs.push([level, msg]));
    w.noteServed("sess-a");
    assert.equal(logs.length, 1, "first commit of a contested session names the conflict");
    assert.equal(logs[0][0], "error");
    assert.match(logs[0][1], /\[split-brain\] session sess-a/);
    assert.ok(logs[0][1].includes("http://127.0.0.1:18802") && logs[0][1].includes("v0.1.202"), "names THIS side");
    assert.ok(logs[0][1].includes("http://127.0.0.1:8787") && logs[0][1].includes("v0.1.201"), "names the PEER side");
    assert.match(logs[0][1], /#3923/);
    w.noteServed("sess-a");
    assert.equal(logs.length, 1, "verdict TTL suppresses repeats inside the window");
    w.dispose();
});

test("non-contested session stays silent even while another session is contested", () => {
    const dir = writerMarkerDir(freshDir("bili-3923-solo-"));
    const logs: Array<[string, string]> = [];
    writePeerMarker(dir, PEER, { "other-session": Date.now() - 1000 });
    const w = createServedMarkerWriter(SELF, dir, (level, msg) => logs.push([level, msg]));
    w.noteServed("solo-session");
    assert.equal(logs.length, 0, "peer activity on a DIFFERENT session does not contest this one");
    w.dispose();
});

test("peer commit outside the contest window is not contested", () => {
    const dir = writerMarkerDir(freshDir("bili-3923-stale-window-"));
    const logs: Array<[string, string]> = [];
    writePeerMarker(dir, PEER, { "sess-a": Date.now() - 11 * 60_000 });
    const w = createServedMarkerWriter(SELF, dir, (level, msg) => logs.push([level, msg]));
    w.noteServed("sess-a");
    assert.equal(logs.length, 0, "an 11-minute-old peer commit is not concurrent activity");
    w.dispose();
});

test("dead-pid peer counts while its marker is fresh, stops counting once stale", () => {
    const dir = writerMarkerDir(freshDir("bili-3923-freshness-"));
    const deadPeer: WriterIdentity = { ...PEER, pid: DEAD_PID };
    const file = writePeerMarker(dir, deadPeer, { "sess-fresh": Date.now() - 1000 });
    let found = findContestedWriters(dir, SELF.instanceId, "sess-fresh", Date.now());
    assert.equal(found.length, 1, "fresh mtime covers platforms where the pid check cannot see the peer");
    backdate(file, 40_000);
    found = findContestedWriters(dir, SELF.instanceId, "sess-fresh", Date.now());
    assert.equal(found.length, 0, "dead pid + stale mtime = gone");
});

test("graceful dispose records stoppedAt and never contests a fresh predecessor (#4982 gate restart)", () => {
    const dir = writerMarkerDir(freshDir("bili-3923-stop-"));
    const logs: Array<[string, string]> = [];
    // predecessor committed sess-a, then shut down gracefully (SIGTERM → dispose)
    const pred = createServedMarkerWriter({ ...PEER }, dir, () => {});
    pred.noteServed("sess-a");
    pred.__flushForTest();
    pred.dispose();
    const body = JSON.parse(fs.readFileSync(path.join(dir, "peer-1.json"), "utf8")) as Record<string, unknown>;
    assert.equal(typeof body.stoppedAt, "number", "dispose records a graceful stop");
    // successor rebinds seconds later and commits the same session — the
    // predecessor's marker is still FRESH, but a known-dead instance must not
    // raise an alarm
    const w = createServedMarkerWriter(SELF, dir, (level, msg) => logs.push([level, msg]));
    w.noteServed("sess-a");
    assert.equal(logs.length, 0, "a gracefully-stopped predecessor is not a concurrent writer");
    w.dispose();
});

test("stoppedAt skips even when the peer pid is alive", () => {
    const dir = writerMarkerDir(freshDir("bili-3923-stopped-pid-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "peer-1.json"), JSON.stringify({
        v: 1, ...PEER, servedAt: { "sess-x": Date.now() - 1_000 }, stoppedAt: Date.now() - 2_000,
    }));
    assert.deepEqual(findContestedWriters(dir, SELF.instanceId, "sess-x", Date.now()), [], "stoppedAt outranks liveness — a recorded stop is positively-known death");
});

test("malformed or foreign-shape marker files are skipped, never fatal", () => {
    const dir = writerMarkerDir(freshDir("bili-3923-malformed-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "garbage.json"), "{not json");
    writePeerMarker(dir, { ...PEER, instanceId: "peer-v2" }, {});
    // v mismatch — future format must not be misread as v1
    fs.writeFileSync(path.join(dir, "peer-v2.json"), JSON.stringify({ v: 2, instanceId: "peer-v2", pid: process.pid, origin: "x", version: "y", servedAt: { "sess-m": Date.now() } }));
    assert.deepEqual(findContestedWriters(dir, SELF.instanceId, "sess-m", Date.now()), []);
});

test("own marker file never contests itself", () => {
    const dir = writerMarkerDir(freshDir("bili-3923-self-"));
    const w = createServedMarkerWriter(SELF, dir, () => {});
    w.noteServed("sess-s");
    w.__flushForTest();
    assert.deepEqual(findContestedWriters(dir, SELF.instanceId, "sess-s", Date.now()), [], "self-instance excluded from its own scan");
    w.dispose();
});

test("reapStaleWriterMarkers removes dead+stale files, keeps live and recent ones", () => {
    const dir = writerMarkerDir(freshDir("bili-3923-reap-"));
    const deadFile = writePeerMarker(dir, { ...PEER, instanceId: "peer-dead", pid: DEAD_PID }, {});
    backdate(deadFile, 2 * 60 * 60_000);
    const liveFile = writePeerMarker(dir, { ...PEER, instanceId: "peer-live", pid: process.pid }, {});
    backdate(liveFile, 2 * 60 * 60_000);
    reapStaleWriterMarkers(dir, Date.now());
    assert.equal(fs.existsSync(deadFile), false, "provably-dead + beyond reap horizon → removed");
    assert.equal(fs.existsSync(liveFile), true, "live pid → kept regardless of age");
});
