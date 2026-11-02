// #5548 P3: hermetic tests for remote lane C (§五) — the §七 exit-criterion
// injections (offline / slow response / bad JSON / oversized) plus doc
// validation, the last-known-good snapshot chain, and watcher seeding.
// No network: globalThis.fetch is stubbed per test; cache dir via XDG_CACHE_HOME
// (src/paths.ts xdg() re-reads env per call, so per-test dirs are safe).
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyRemoteDoc, REMOTE_DOC_CAP_BYTES, type NoticeRecord } from "../src/notices.js";
import {
    DEFAULT_REMOTE_ANNOUNCEMENTS_URL,
    loadRemoteSnapshot,
    remoteAnnouncementEntries,
    resolveRemoteUrl,
    runRemoteCheck,
    startRemoteAnnouncementWatcher,
    _resetRemoteAnnouncementsForTest,
    _stopRemoteAnnouncementWatcherForTest,
} from "../src/remote-announcements.js";

function rec(id: string): NoticeRecord {
    return { id, kind: "suggestion", title: `t-${id}`, publishedAt: "2026-11-02T00:00:00Z" };
}

function snapshotPath(dir: string): string {
    return path.join(dir, "billion-context", "announcements-remote-snapshot.json");
}

let tmp: string;
const realFetch = globalThis.fetch;
const realCacheEnv = process.env.XDG_CACHE_HOME;

beforeEach(() => {
    _stopRemoteAnnouncementWatcherForTest();
    _resetRemoteAnnouncementsForTest();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remote-notice-"));
    process.env.XDG_CACHE_HOME = tmp;
});

after(() => {
    globalThis.fetch = realFetch;
    if (realCacheEnv === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = realCacheEnv;
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
    globalThis.fetch = impl as typeof fetch;
}
function okJson(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("#5548 P3: applyRemoteDoc (§五.5 compat)", () => {
    it("accepts a well-formed v1 doc", () => {
        const res = applyRemoteDoc({ v: 1, entries: [rec("a"), rec("b")] });
        assert.equal(res.ok, true);
        if (!res.ok) return;
        assert.deepEqual(res.entries.map((r) => r.id), ["a", "b"]);
        assert.equal(res.warnings.length, 0);
    });

    it("rejects an unknown doc version wholesale (no partial parse)", () => {
        const res = applyRemoteDoc({ v: 2, entries: [rec("a")] });
        assert.equal(res.ok, false);
    });

    it("rejects non-object docs and non-array entries", () => {
        assert.equal(applyRemoteDoc(null).ok, false);
        assert.equal(applyRemoteDoc({ entries: [] }).ok, false);
        assert.equal(applyRemoteDoc({ v: 1, entries: rec("a") }).ok, false);
    });

    it("skips invalid entries with a warning, keeps the valid ones", () => {
        const res = applyRemoteDoc({ v: 1, entries: [{ id: "BAD_ID", kind: "other", title: "x" }, rec("good")] });
        assert.equal(res.ok, true);
        if (!res.ok) return;
        assert.deepEqual(res.entries.map((r) => r.id), ["good"]);
        assert.equal(res.warnings.length, 1);
        assert.match(res.warnings[0], /BAD_ID|id/);
    });

    it("reports dropped unknown fields as warnings without killing the record", () => {
        const res = applyRemoteDoc({ v: 1, entries: [{ ...rec("a"), bogusField: 1 }] });
        assert.equal(res.ok, true);
        if (!res.ok) return;
        assert.deepEqual(res.entries.map((r) => r.id), ["a"]);
        assert.equal(res.warnings.length, 1);
        assert.match(res.warnings[0], /bogusField/);
    });
});

describe("#5548 P3: resolveRemoteUrl precedence (§五.3)", () => {
    it("defaults to the official raw URL", () => {
        assert.equal(resolveRemoteUrl(undefined, undefined), DEFAULT_REMOTE_ANNOUNCEMENTS_URL);
    });
    it("explicit url wins over the default", () => {
        assert.equal(resolveRemoteUrl(undefined, "https://relay.example/raw.json"), "https://relay.example/raw.json");
    });
    it("BILI_ANNOUNCEMENTS_URL wins over everything (firewall escape hatch)", () => {
        assert.equal(resolveRemoteUrl("https://env.example/raw.json", "https://opts.example/raw.json"), "https://env.example/raw.json");
    });
});

describe("#5548 P3: runRemoteCheck — the four §七 injections", () => {
    async function seedSuccess(): Promise<void> {
        stubFetch(async () => okJson({ v: 1, entries: [rec("r-one")] }));
        await runRemoteCheck({ timeoutMs: 500 });
        assert.deepEqual(remoteAnnouncementEntries().map((r) => r.id), ["r-one"]);
    }

    it("success: entries appear AND the last-known-good snapshot lands on disk", async () => {
        await seedSuccess();
        const snap = JSON.parse(fs.readFileSync(snapshotPath(tmp), "utf8")) as { v: number; entries: NoticeRecord[] };
        assert.equal(snap.v, 1);
        assert.deepEqual(snap.entries.map((r) => r.id), ["r-one"]);
    });

    it("offline: fetch rejection keeps the previous good set (never red)", async () => {
        await seedSuccess();
        stubFetch(async () => { throw new Error("ECONNREFUSED"); });
        await runRemoteCheck({ timeoutMs: 500 });
        assert.deepEqual(remoteAnnouncementEntries().map((r) => r.id), ["r-one"]);
    });

    it("slow response: the 8s-class timeout aborts and keeps the previous set", async () => {
        await seedSuccess();
        stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
            const late = setTimeout(() => reject(new Error("resolved too late")), 400);
            init?.signal?.addEventListener("abort", () => { clearTimeout(late); reject(new Error("aborted")); });
        }));
        const t0 = Date.now();
        await runRemoteCheck({ timeoutMs: 30 });
        assert.ok(Date.now() - t0 < 350, "must give up at the timeout, not wait for the slow body");
        assert.deepEqual(remoteAnnouncementEntries().map((r) => r.id), ["r-one"]);
    });

    it("bad JSON: unparseable body keeps the previous set", async () => {
        await seedSuccess();
        stubFetch(async () => new Response("{not json", { status: 200 }));
        await runRemoteCheck({ timeoutMs: 500 });
        assert.deepEqual(remoteAnnouncementEntries().map((r) => r.id), ["r-one"]);
    });

    it(`oversized body (> ${REMOTE_DOC_CAP_BYTES} bytes) keeps the previous set`, async () => {
        await seedSuccess();
        const pad = "x".repeat(REMOTE_DOC_CAP_BYTES);
        stubFetch(async () => okJson({ v: 1, entries: [{ ...rec("big"), desc: pad }] }));
        await runRemoteCheck({ timeoutMs: 500 });
        assert.deepEqual(remoteAnnouncementEntries().map((r) => r.id), ["r-one"]);
    });

    it("HTTP error status keeps the previous set", async () => {
        await seedSuccess();
        stubFetch(async () => new Response("", { status: 500 }));
        await runRemoteCheck({ timeoutMs: 500 });
        assert.deepEqual(remoteAnnouncementEntries().map((r) => r.id), ["r-one"]);
    });

    it("wrong-v doc is rejected wholesale, not partially parsed", async () => {
        await seedSuccess();
        stubFetch(async () => okJson({ v: 2, entries: [rec("new-v2-entry")] }));
        await runRemoteCheck({ timeoutMs: 500 });
        assert.deepEqual(remoteAnnouncementEntries().map((r) => r.id), ["r-one"]);
    });

    it("retraction: pushing an empty entries list removes the entries", async () => {
        await seedSuccess();
        stubFetch(async () => okJson({ v: 1, entries: [] }));
        await runRemoteCheck({ timeoutMs: 500 });
        assert.deepEqual(remoteAnnouncementEntries(), []);
        const snap = JSON.parse(fs.readFileSync(snapshotPath(tmp), "utf8")) as { entries: unknown[] };
        assert.deepEqual(snap.entries, []);
    });

    it("warnOnce: repeated same-class failures log once, not per poll", async () => {
        const lines: string[] = [];
        const log = (level: string, msg: string) => lines.push(`${level} ${msg}`);
        stubFetch(async () => { throw new Error("ECONNREFUSED"); });
        await runRemoteCheck({ timeoutMs: 500, log });
        await runRemoteCheck({ timeoutMs: 500, log });
        const netLines = lines.filter((l) => l.includes("ECONNREFUSED"));
        assert.equal(netLines.length, 1);
    });
});

describe("#5548 P3: last-known-good snapshot chain", () => {
    it("absent snapshot → no entries", () => {
        assert.deepEqual(loadRemoteSnapshot(), []);
    });

    it("valid snapshot loads; corrupt or wrong-v snapshots degrade to none", () => {
        const dir = path.join(tmp, "billion-context");
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, "announcements-remote-snapshot.json");
        fs.writeFileSync(f, JSON.stringify({ v: 1, entries: [rec("snap-a")] }));
        assert.deepEqual(loadRemoteSnapshot().map((r) => r.id), ["snap-a"]);
        fs.writeFileSync(f, "{corrupt");
        assert.deepEqual(loadRemoteSnapshot(), []);
        fs.writeFileSync(f, JSON.stringify({ v: 2, entries: [rec("snap-b")] }));
        assert.deepEqual(loadRemoteSnapshot(), []);
    });
});

describe("#5548 P3: watcher seeding", () => {
    it("seeds entries from the snapshot immediately, before the first fetch", () => {
        const dir = path.join(tmp, "billion-context");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "announcements-remote-snapshot.json"), JSON.stringify({ v: 1, entries: [rec("seeded")] }));
        stubFetch(async () => okJson({ v: 1, entries: [rec("should-not-arrive-yet")] }));
        startRemoteAnnouncementWatcher({ timeoutMs: 60_000 });
        assert.deepEqual(remoteAnnouncementEntries().map((r) => r.id), ["seeded"]);
        // double-start must not stack timers
        startRemoteAnnouncementWatcher({ timeoutMs: 60_000 });
    });
});
