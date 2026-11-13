import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// #5548 P3: remote announcements (GitHub raw feed). Hermetic: XDG_CACHE_HOME
// isolates throttle + snapshot files, BILI_CONFIG_FILE/XDG_STATE_HOME isolate
// the local-source and dismissal-store interplay; feed endpoints are local
// http servers on OS-assigned ports (no fixed-port assumptions, #360).

const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-ann-"));
process.env.BILI_CONFIG_FILE = path.join(root, "cfg.json"); // absent ⇒ defaults
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");
const annDir = path.join(root, "announcements");
const snapshotFile = path.join(root, "cache", "billion-context", ".remote-notices-snapshot.json");

const { resolveAnnouncementsUrl, parseRemoteDoc, runRemoteNoticesCheck, visibleRemoteRecords, remoteAnnouncementPayloads, remoteDismissMode, getRemoteNoticesState, _resetRemoteNoticesForTest } = await import("../src/remote-notices.ts");
const { mergedNotices } = await import("../src/announcements.ts");

const REC = (over: Record<string, unknown> = {}): Record<string, unknown> => Object.assign({
    id: "team-note",
    kind: "suggestion",
    title: { "zh-CN": "提示", en: "Note" },
    desc: { "zh-CN": "说明文字", en: "Description text" },
}, over);
const doc = (entries: unknown[]): string => JSON.stringify({ v: 1, entries });

function serve(handler: (res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
    const srv = http.createServer((req, res) => handler(res));
    return new Promise((resolve) => {
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            resolve({ url: `http://127.0.0.1:${port}/feed`, close: async () => { srv.closeAllConnections(); await new Promise<void>((r) => srv.close(() => r())); } });
        });
    });
}

test("resolveAnnouncementsUrl: official default, override verbatim", () => {
    assert.equal(resolveAnnouncementsUrl(undefined), "https://raw.githubusercontent.com/ranxianglei/billion-context/master/announcements/remote.json");
    assert.equal(resolveAnnouncementsUrl(""), resolveAnnouncementsUrl(undefined));
    const relay = "http://relay.internal/bili/remote.json";
    assert.equal(resolveAnnouncementsUrl(relay), relay);
});

test("parseRemoteDoc: shape matrix, per-entry isolation, version gate", () => {
    // The source contract: parse takes the PARSED object; callers (fetch path,
    // snapshot restore, CI validator) do the JSON.parse themselves.
    assert.deepEqual(parseRemoteDoc(JSON.parse(doc([REC()]))), { entries: [{ ...REC(), tone: "info", dismiss: "persistent", priority: 50 }] });
    assert.ok(parseRemoteDoc(JSON.parse(doc([]))).entries.length === 0 && !parseRemoteDoc(JSON.parse(doc([]))).error, "empty entries is a valid document (retraction)");
    assert.match(parseRemoteDoc({ ...JSON.parse(doc([REC()])), v: 2 }).error ?? "", /unsupported version 2/, "higher version skips the WHOLE doc");
    assert.match(parseRemoteDoc({ entries: [REC()] }).error ?? "", /missing integer v/);
    assert.match(parseRemoteDoc({ v: 1 }).error ?? "", /not an array/);
    assert.match(parseRemoteDoc("oops").error ?? "", /not a JSON object/, "raw strings are not documents (that is the caller's job)");
    const many = Array.from({ length: 51 }, (_, i) => REC({ id: `n${String(i).padStart(2, "0")}` }));
    assert.match(parseRemoteDoc(JSON.parse(doc(many))).error ?? "", /too many entries/, "document cap before per-entry work");
    const mixed = [REC(), { id: "BAD_ID" }, null, REC({ id: "second-entry" })];
    const r = parseRemoteDoc(JSON.parse(doc(mixed)));
    assert.equal(r.error, undefined);
    assert.deepEqual(r.entries.map((e) => e.id), ["team-note", "second-entry"], "bad individual entries are skipped, good ones survive");
    assert.match(parseRemoteDoc(JSON.parse(doc([{ id: "BAD_ID" }]))).error ?? "", /no valid entries/);
    const dupes = [REC(), REC()];
    assert.equal(parseRemoteDoc(JSON.parse(doc(dupes))).entries.length, 1, "duplicate ids dedupe to first");
});

test("fresh fetch success: state populated, snapshot written, gates reused", async () => {
    _resetRemoteNoticesForTest();
    fs.rmSync(snapshotFile, { force: true });
    const fed = [REC(), REC({ id: "old-only", kind: "warning", versions: ["<0.1.100"] })];
    const s = await serve((res) => { res.setHeader("content-type", "application/json"); res.end(doc(fed)); });
    try {
        await runRemoteNoticesCheck({ remoteAnnouncementsUrl: s.url, log: () => {} }, true);
    } finally {
        await s.close();
    }
    const st = getRemoteNoticesState();
    assert.equal(st.lastError, undefined);
    assert.ok(st.lastCheckAt);
    assert.equal(fs.readFileSync(snapshotFile, "utf8"), doc(fed), "last-known-good snapshot persisted");
    const vis = visibleRemoteRecords();
    assert.deepEqual(vis.map((r) => r.id), ["team-note"], "versions gate hides old-only (shared with source B)");
    const payloads = remoteAnnouncementPayloads();
    assert.equal(payloads[0].source, "remote");
    assert.equal(payloads[0].tone, "info");
    assert.deepEqual(remoteDismissMode("team-note"), "persistent");
});

test("fetch failure: first-ever is silent-empty, later failures serve memory then snapshot", async () => {
    _resetRemoteNoticesForTest();
    fs.rmSync(snapshotFile, { force: true });
    const opts = { remoteAnnouncementsUrl: "http://127.0.0.1:1/feed", timeoutMs: 500, log: () => {} };
    await runRemoteNoticesCheck(opts, true);
    assert.equal(visibleRemoteRecords().length, 0, "no snapshot yet → no remote source (fail open, no error surface)");

    const fed = [REC()];
    let s = await serve((res) => res.end(doc(fed)));
    await runRemoteNoticesCheck({ ...opts, remoteAnnouncementsUrl: s.url, timeoutMs: 500 }, true);
    await s.close();
    assert.deepEqual(visibleRemoteRecords().map((r) => r.id), ["team-note"], "healthy fetch populates state");

    // Process still up: fetch fails again → memory stays authoritative.
    await runRemoteNoticesCheck(opts, true);
    assert.deepEqual(visibleRemoteRecords().map((r) => r.id), ["team-note"], "failure does not clobber in-memory good state");

    // Restart simulation: state cleared, disk snapshot serves offline installs.
    _resetRemoteNoticesForTest();
    await runRemoteNoticesCheck(opts, true);
    assert.deepEqual(visibleRemoteRecords().map((r) => r.id), ["team-note"], "snapshot file survives restart + outage");
    getRemoteNoticesState().lastError; // state records the error for diagnostics
    assert.ok(getRemoteNoticesState().lastError !== undefined);
});

test("malformed fresh doc keeps last-good; oversized doc rejected the same way", async () => {
    _resetRemoteNoticesForTest();
    fs.rmSync(snapshotFile, { force: true });
    const good = [REC()];
    let s = await serve((res) => res.end(doc(good)));
    await runRemoteNoticesCheck({ remoteAnnouncementsUrl: s.url, log: () => {} }, true);
    await s.close();

    s = await serve((res) => res.end("{ not json"));
    await runRemoteNoticesCheck({ remoteAnnouncementsUrl: s.url, log: () => {} }, true);
    assert.equal(visibleRemoteRecords().length, 1, "bad JSON keeps last good copy");
    assert.ok(fs.readFileSync(snapshotFile, "utf8") === doc(good), "snapshot untouched by a bad push");
    await s.close();

    const huge = doc([REC({ desc: { en: "x".repeat(512 * 1024) } })]);
    s = await serve((res) => res.end(huge));
    await runRemoteNoticesCheck({ remoteAnnouncementsUrl: s.url, log: () => {} }, true);
    assert.equal(visibleRemoteRecords().length, 1, ">512KB document rejected, last good survives");
    await s.close();
});

test("slow response trips the fetch timeout and falls back", async () => {
    _resetRemoteNoticesForTest();
    fs.rmSync(snapshotFile, { force: true });
    const slow = await serve((res) => setTimeout(() => res.end(doc([REC()])), 30_000));
    const t0 = Date.now();
    try {
        await runRemoteNoticesCheck({ remoteAnnouncementsUrl: slow.url, timeoutMs: 300, log: () => {} }, true);
    } finally {
        await slow.close();
    }
    assert.ok(Date.now() - t0 < 30_000, "aborted well before the server would have answered");
    assert.equal(visibleRemoteRecords().length, 0);
    assert.match(getRemoteNoticesState().lastError ?? "", /\S+/, "timeout surfaced as a recorded error");
});

test("oversized feed is bounded while STREAMING, not after full buffering", async () => {
    _resetRemoteNoticesForTest();
    fs.rmSync(snapshotFile, { force: true });
    // Seed a last-good copy so the oversized push has something to fall back to.
    const good = [REC()];
    let s = await serve((res) => res.end(doc(good)));
    await runRemoteNoticesCheck({ remoteAnnouncementsUrl: s.url, log: () => {} }, true);
    await s.close();

    // A hostile/lying feed: ~4 MiB of junk with NO Content-Length, dripped in
    // 64 KiB chunks one every 15 ms. Pre-fix, res.text() materialized ALL of
    // it before the 512 KiB bound could fire; the capped reader must abandon
    // the stream shortly past the budget instead.
    const CHUNK = 64 * 1024;
    const TOTAL_CHUNKS = 64; // 4 MiB
    const BUDGET_BYTES = 512 * 1024;
    let sentBytes = 0;
    s = await serve(async (res) => {
        let open = true;
        res.on("close", () => { open = false; });
        const chunk = "x".repeat(CHUNK);
        for (let i = 0; i < TOTAL_CHUNKS && open; i++) {
            res.write(chunk);
            sentBytes += CHUNK;
            if (i < TOTAL_CHUNKS - 1) await new Promise((r) => setTimeout(r, 15));
        }
        if (open) res.end();
    });
    try {
        await runRemoteNoticesCheck({ remoteAnnouncementsUrl: s.url, timeoutMs: 8000, log: () => {} }, true);
        assert.equal(visibleRemoteRecords().length, 1, "oversized push keeps last-good copy");
        assert.match(getRemoteNoticesState().lastError ?? "", /exceeds/, "size bound surfaced as a recorded error");
    } finally {
        await s.close();
    }
    // The drip (15 ms/chunk) keeps the server within a few chunks of the
    // client's read position, so "sent" is an honest proxy for what was
    // transferred: pre-fix this equals 4 MiB; post-fix it stops just past
    // the 512 KiB budget plus in-flight/chunk-detection slack (~6 chunks).
    assert.ok(sentBytes <= BUDGET_BYTES + 6 * CHUNK,
        `client abandoned the stream early (server sent ${sentBytes} of ${TOTAL_CHUNKS * CHUNK} bytes)`);
});

test("merging: local shadows remote on equal id; both shadow builtins; priority orders", () => {
    _resetRemoteNoticesForTest();
    fs.rmSync(snapshotFile, { force: true });
    const fed = [REC({ id: "wm-fastpath-intro" }), REC({ id: "urgent-thing", kind: "incident" }), REC({ id: "quiet-thing", kind: "other" })];
    return (async () => {
        const s = await serve((res) => res.end(doc(fed)));
        try {
            await runRemoteNoticesCheck({ remoteAnnouncementsUrl: s.url, log: () => {} }, true);
            const list = mergedNotices(process.env, remoteAnnouncementPayloads());
            const ids = list.map((n) => n.id);
            assert.equal(ids.filter((i) => i === "wm-fastpath-intro").length, 1, "same id renders exactly once");
            assert.ok(!list.some((n) => n.id === "wm-fastpath-intro" && n.source === "builtin"), "the BUILTIN copy is shadowed by the remote one");
            assert.deepEqual(ids[0], "urgent-thing", "incident priority 90 sorts first");
            assert.ok(ids.includes("quiet-thing"), "lowest-priority entry still rendered");
            // Local shadowing: drop a local file with the remote id → remote drops out.
            fs.mkdirSync(annDir, { recursive: true });
            fs.writeFileSync(path.join(annDir, "a.json"), JSON.stringify(REC({ id: "quiet-thing" })));
            try {
                const list2 = mergedNotices(process.env, remoteAnnouncementPayloads());
                assert.ok(!list2.some((n) => n.id === "quiet-thing" && n.source === "remote"), "local shadows remote on equal id");
                assert.ok(list2.some((n) => n.id === "quiet-thing" && (n as { source?: string }).source === "local"), "the local copy is what renders");
            } finally {
                fs.rmSync(path.join(annDir, "a.json"), { force: true });
            }
        } finally {
            await s.close();
        }
    })();
});

// #5984: requiresScan live-scan gate — a broadcast record is visible only
// while the flagged client's plugin registry actually reports the plugin.
// Hermetic: DSH_HOME points at a fixture (never the machine's real ~/.dsh);
// the rest of env keeps the temp XDG roots set at file top so the
// persistent-dismissal store stays inside the sandbox. The scan cache is
// keyed by client+cwd (NOT env), so each case clears it first.
const { validateRecord, noticePassesGates } = await import("../src/announcements.ts");
const { clearScanCache } = await import("../src/thirdparty-scan.ts");

const SCAN_ENV: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: path.join(root, "dsh-scan") };
const SCAN_PROFILE = path.join(SCAN_ENV.DSH_HOME!, "profiles", "work");
fs.mkdirSync(SCAN_PROFILE, { recursive: true });

function gatedRecord(id = "dsh-live-compact-conflict") {
    const rec = validateRecord(REC({
        id,
        kind: "warning",
        requiresScan: { client: "dsh", knownId: "dsh-live-compact" },
    }));
    if (!rec || !rec.requiresScan) throw new Error("fixture record must validate");
    return rec;
}

test("requiresScan gate: hidden unless the scan reports the plugin (#5984)", () => {
    const now = new Date("2026-11-13T00:00:00Z");
    const rec = gatedRecord();

    clearScanCache();
    assert.equal(noticePassesGates(rec, now, SCAN_ENV), false, "plugin not installed → hidden");

    fs.writeFileSync(path.join(SCAN_PROFILE, "package.json"),
        JSON.stringify({ name: "work", dependencies: { "dsh-live-compact": "*" } }));
    clearScanCache();
    assert.equal(noticePassesGates(rec, now, SCAN_ENV), true, "plugin detected → shown");

    clearScanCache();
    const other = validateRecord(REC({
        id: "dsh-other-conflict", kind: "warning",
        requiresScan: { client: "dsh", knownId: "some-other-plugin" },
    }));
    assert.ok(other);
    assert.equal(noticePassesGates(other, now, SCAN_ENV), false, "different knownId → still hidden");

    clearScanCache();
    const anyDsh = validateRecord(REC({ id: "dsh-any-finding", kind: "suggestion", requiresScan: { client: "dsh" } }));
    assert.ok(anyDsh);
    assert.equal(noticePassesGates(anyDsh, now, SCAN_ENV), true, "no knownId → any dsh finding shows it");

    clearScanCache();
});

test("requiresScan: validation matrix (bad shapes rejected, per-entry isolation kept)", () => {
    assert.ok(validateRecord(REC({ requiresScan: { client: "dsh" } })), "client alone is valid (any-finding)");
    assert.equal(validateRecord(REC({ requiresScan: { client: "nope" } })), null, "unknown client rejected");
    assert.equal(validateRecord(REC({ requiresScan: { knownId: "x" } })), null, "missing client rejected");
    assert.equal(validateRecord(REC({ requiresScan: { client: 7 } })), null, "non-string client rejected");
    assert.equal(validateRecord(REC({ requiresScan: { client: "dsh", knownId: "" } })), null, "empty knownId rejected");
    assert.equal(validateRecord(REC({ requiresScan: { client: "dsh", knownId: 7 } })), null, "non-string knownId rejected");
    assert.equal(validateRecord(REC({ requiresScan: "dsh" })), null, "non-object rejected");
    const r = parseRemoteDoc(JSON.parse(doc([REC({ requiresScan: { client: "nope" } }), REC({ id: "second-entry" })])));
    assert.deepEqual(r.entries.map((e) => e.id), ["second-entry"], "one bad entry never blanks its siblings");
});

test("remote lane end-to-end: gated entry absent until the scan reports the plugin", async () => {
    _resetRemoteNoticesForTest();
    fs.rmSync(snapshotFile, { force: true });
    clearScanCache();
    fs.rmSync(path.join(SCAN_PROFILE, "package.json"), { force: true });
    const fed = [gatedRecord()];
    const s = await serve((res) => { res.setHeader("content-type", "application/json"); res.end(doc(fed)); });
    try {
        await runRemoteNoticesCheck({ remoteAnnouncementsUrl: s.url, log: () => {} }, true);
        assert.equal(visibleRemoteRecords(new Date("2026-11-13T00:00:00Z"), SCAN_ENV).length, 0,
            "feed delivered but plugin absent → no banner");

        fs.writeFileSync(path.join(SCAN_PROFILE, "package.json"),
            JSON.stringify({ name: "work", dependencies: { "dsh-live-compact": "*" } }));
        clearScanCache();
        const vis = visibleRemoteRecords(new Date("2026-11-13T00:00:00Z"), SCAN_ENV);
        assert.deepEqual(vis.map((r) => r.id), ["dsh-live-compact-conflict"], "plugin installed → banner appears");
        assert.equal(remoteAnnouncementPayloads(new Date("2026-11-13T00:00:00Z"), SCAN_ENV)[0]?.source, "remote");
    } finally {
        await s.close();
        clearScanCache();
    }
});

test("shipped remote.json validates end-to-end", () => {
    const fed = JSON.parse(fs.readFileSync(path.join(process.cwd(), "announcements", "remote.json"), "utf8"));
    const r = parseRemoteDoc(fed);
    assert.equal(r.error, undefined);
    // The dsh-live-compact-conflict entry was retracted from the feed (#6508):
    // until instances upgrade to a build that understands requiresScan, a gated
    // entry still shows unconditionally on old versions — so the broadcast stays
    // empty and the conflict scan (dsh lane → knownId "dsh-live-compact") remains
    // the live surfacing mechanism. Re-adding the entry is safe once the gated
    // build is deployed (or sooner, accepting the transient over-broadcast).
    assert.ok(!r.entries.some((e) => e.id === "dsh-live-compact-conflict"), "retracted entry must stay out of the feed");
});

test("dismiss routing follows the remote record's declared mode", async () => {
    _resetRemoteNoticesForTest();
    fs.rmSync(snapshotFile, { force: true });
    const fed = [REC(), REC({ id: "pinned-alert", dismiss: "always" }), REC({ id: "once-per-run", dismiss: "instance" })];
    const s = await serve((res) => res.end(doc(fed)));
    try {
        await runRemoteNoticesCheck({ remoteAnnouncementsUrl: s.url, log: () => {} }, true);
        assert.deepEqual(remoteDismissMode("team-note"), "persistent");
        assert.deepEqual(remoteDismissMode("pinned-alert"), "always", "admin endpoint will accept-and-ignore this");
        assert.deepEqual(remoteDismissMode("once-per-run"), "instance");
        assert.deepEqual(remoteDismissMode("never-on-feed"), "absent", "unknown ids fall through to builtin handling");
        const payloads = remoteAnnouncementPayloads();
        assert.ok(payloads.find((p) => p.id === "pinned-alert")?.suppressDismiss === true, "always-mode renders without a dismiss button");
        assert.ok(payloads.find((p) => p.id === "team-note")?.suppressDismiss !== true, "default mode keeps its button");
    } finally {
        await s.close();
    }
});
