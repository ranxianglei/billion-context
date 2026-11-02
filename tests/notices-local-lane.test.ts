// #5548 P2 (lane B): validator / targeting gates / dismissal hashing / local
// loader / store — the full negative suite required by §七 exit criteria
// (bad JSON / version miss / percent out-of-window / expired / always-no-button
// (client-side, P1 web suite) / instance-restart-reshow).
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    BUILTIN_NOTICES,
    NOTICE_KINDS,
    PCK_NOTICE_ID,
    dismissKeyOf,
    dismissModeOf,
    mergeNoticeLayers,
    noticeHash16,
    noticeVisible,
    normalizeRecord,
    parseVersion,
    parseVersionMatcher,
    percentBucket,
    passesTargeting,
    priorityOf,
    registerDynamicNoticeIds,
    sortNotices,
    toneOf,
    validateNoticeRecord,
    versionMatches,
    type NoticeRecord,
    type TargetingContext,
} from "../src/notices.ts";
import { LOCAL_FILE_CAP_BYTES, loadLocalAnnouncements } from "../src/local-announcements.ts";
import {
    dismissedUpgradeNotices,
    dismissPersistentNotice,
    dismissUpgradeNotice,
    instanceDismissedNotices,
    pckNoticeActive,
    recordInstanceNoticeDismissal,
} from "../src/pck-notice.ts";
import { installIdOf } from "../src/install-id.ts";

function rec(over: Partial<NoticeRecord> & { id?: string } = {}): NoticeRecord {
    return { id: over.id ?? "n1", kind: "other", title: "t", ...over };
}

// ---- validator -------------------------------------------------------------

test("validateNoticeRecord accepts a minimal record and drops unknown fields", () => {
    const res = validateNoticeRecord({ id: "my-notice", kind: "warning", title: "T", desc: "D", bogus: 1, otherField: "x" });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.deepEqual(res.droppedFields.sort(), ["bogus", "otherField"]);
    assert.equal(res.rec.id, "my-notice");
    assert.equal(res.rec.kind, "warning");
    assert.equal((res.rec as unknown as Record<string, unknown>)["bogus"], undefined);
});

test("validateNoticeRecord rejects bad values one field at a time", () => {
    const base = { id: "ok-id", kind: "other", title: "T" };
    const cases: Array<[string, unknown]> = [
        ["non-object root", null],
        ["array root", [1]],
        ["missing id", { kind: "other", title: "T" }],
        ["uppercase id", { ...base, id: "My-Id" }],
        ["dash-leading id", { ...base, id: "-x" }],
        ["too-long id", { ...base, id: "a".repeat(65) }],
        ["missing kind", { id: "ok-id", title: "T" }],
        ["bad kind", { ...base, kind: "promo" }],
        ["missing title", { id: "ok-id", kind: "other" }],
        ["title over limit", { ...base, title: "x".repeat(121) }],
        ["desc over limit", { ...base, desc: "x".repeat(601) }],
        ["hint over limit", { ...base, hint: "x".repeat(301) }],
        ["empty locale object", { ...base, title: {} }],
        ["locale value not a string", { ...base, title: { en: 42 } }],
        ["ctaUrl non-http", { ...base, ctaUrl: "ftp://x" }],
        ["ctaUrl too long", { ...base, ctaUrl: "https://" + "a".repeat(200) }],
        ["bad tone", { ...base, tone: "loud" }],
        ["bad dismiss", { ...base, dismiss: "sometimes" }],
        ["priority 101", { ...base, priority: 101 }],
        ["priority -1", { ...base, priority: -1 }],
        ["priority float", { ...base, priority: 1.5 }],
        ["percent string", { ...base, percent: "50" }],
        ["percent 101", { ...base, percent: 101 }],
        ["versions not array", { ...base, versions: ">=1.0.0" }],
        ["versions non-string element", { ...base, versions: [1] }],
        ["versions unparseable element", { ...base, versions: ["banana"] }],
        ["bad since", { ...base, since: "yesterday" }],
        ["bad until", { ...base, until: 1700000000000 }],
    ];
    for (const [label, raw] of cases) {
        const res = validateNoticeRecord(raw);
        assert.ok(!res.ok, `${label} must be rejected`);
    }
});

test("validateNoticeRecord accepts boundary values", () => {
    const res = validateNoticeRecord({
        id: "a".repeat(64),
        kind: "incident",
        title: "x".repeat(120),
        desc: "x".repeat(600),
        hint: "x".repeat(300),
        ctaLabel: "go",
        ctaUrl: "https://github.com/ranxianglei/billion-context",
        tone: "warn",
        dismiss: "always",
        priority: 100,
        publishedAt: "2026-11-02T00:00:00Z",
        versions: ["^0.1.212"],
        percent: 0,
        since: "2026-01-01T00:00:00Z",
        until: "2027-01-01T00:00:00Z",
    });
    assert.ok(res.ok, res.ok ? undefined : res.reason);
});

// ---- versions matcher --------------------------------------------------------

test("parseVersion takes the numeric body and ignores suffixes", () => {
    assert.deepEqual(parseVersion("0.1.212"), [0, 1, 212]);
    assert.deepEqual(parseVersion("0.1.212-dirty"), [0, 1, 212]);
    assert.equal(parseVersion("nope"), null);
    assert.equal(parseVersion("1.2"), null);
});

test("matcher element forms: exact / comparators / caret / interval lists", () => {
    // exact
    assert.ok(versionMatches(["0.1.212"], "0.1.212"));
    assert.ok(!versionMatches(["0.1.212"], "0.1.211"));
    // comparator list — >= inclusive, < exclusive
    assert.ok(versionMatches([">=0.1.210 <0.2.0"], "0.1.210"));
    assert.ok(!versionMatches([">=0.1.210 <0.2.0"], "0.2.0"));
    assert.ok(versionMatches([">=0.1.210 <0.2.0"], "0.1.999"));
    // caret bounds
    assert.ok(!versionMatches(["^0.1.212"], "0.1.211"));
    assert.ok(versionMatches(["^0.1.212"], "0.1.212"));
    assert.ok(versionMatches(["^0.1.212"], "0.1.999"));
    assert.ok(!versionMatches(["^0.1.212"], "0.2.0"));
    assert.ok(versionMatches(["^0.0.3"], "0.0.3"));
    assert.ok(!versionMatches(["^0.0.3"], "0.0.4"));
    assert.ok(versionMatches(["^1.2.3"], "1.9.9"));
    assert.ok(!versionMatches(["^1.2.3"], "2.0.0"));
    // interval list: OR of AND-constraint brackets
    const iv = "[>=0.1.200 <0.1.210] || [0.1.215]";
    assert.ok(versionMatches([iv], "0.1.205"));
    assert.ok(versionMatches([iv], "0.1.215"));
    assert.ok(!versionMatches([iv], "0.1.214"));
    assert.ok(!versionMatches([iv], "0.1.216"));
    // two bare versions inside brackets = inclusive range
    assert.ok(versionMatches(["[0.1.200 0.1.210]"], "0.1.200"));
    assert.ok(versionMatches(["[0.1.200 0.1.210]"], "0.1.210"));
    assert.ok(!versionMatches(["[0.1.200 0.1.210]"], "0.1.211"));
    // elements AND together
    assert.ok(versionMatches(["[0.1.200 0.1.210]", "[0.1.205 0.1.208]"], "0.1.206"));
    assert.ok(!versionMatches(["[0.1.200 0.1.210]", "[0.1.205 0.1.208]"], "0.1.209"));
});

test("matcher rejects ambiguous or malformed elements", () => {
    assert.equal(parseVersionMatcher(""), null);
    assert.equal(parseVersionMatcher("banana"), null);
    assert.equal(parseVersionMatcher("[1.0]"), null);
    assert.equal(parseVersionMatcher("[]"), null);
    assert.equal(parseVersionMatcher("[>=1.0.0"), null);
    assert.equal(parseVersionMatcher(">=1.0.0 1.2.0"), null); // mixed bare + op
    assert.equal(parseVersionMatcher("[1.0.0 1.1.0 1.2.0]"), null);
});

test("versionMatches: empty list matches all; unparseable local version hides gated records", () => {
    assert.ok(versionMatches([], "anything-goes"));
    assert.ok(versionMatches([], null));
    assert.ok(!versionMatches(["0.1.212"], null));
    assert.ok(!versionMatches(["0.1.212"], "dev"));
    assert.ok(versionMatches([], "dev"));
});

// ---- percent bucketing -------------------------------------------------------

test("percentBucket is deterministic and in-range", () => {
    const a = percentBucket("install-a", "some-notice");
    assert.equal(a, percentBucket("install-a", "some-notice"));
    assert.ok(Number.isInteger(a) && a >= 0 && a <= 99);
    const spread = new Set<number>();
    for (let i = 0; i < 200; i++) spread.add(percentBucket(`install-${i}`, "some-notice"));
    assert.ok(spread.size > 50, `expected spread, got ${spread.size}`);
});

test("passesTargeting: percent gate edges and missing installId", () => {
    const now = Date.now();
    const ctx: TargetingContext = { version: "0.1.212", installId: "install-x", now };
    assert.ok(passesTargeting(rec({ percent: 100 }), ctx)); // bucket < 100 always
    assert.ok(!passesTargeting(rec({ percent: 0 }), ctx)); // bucket < 0 never
    const hit = percentBucket("install-x", "n1");
    assert.ok(passesTargeting(rec({ percent: hit + 1 }), ctx));
    assert.ok(!passesTargeting(rec({ percent: hit }), ctx));
    // missing install identity → percent-gated records hide (宁缺毋滥)
    assert.ok(!passesTargeting(rec({ percent: 100 }), { ...ctx, installId: "" }));
    // version gate composes
    assert.ok(!passesTargeting(rec({ percent: 100, versions: ["0.9.9"] }), ctx));
});

// ---- time window --------------------------------------------------------------

test("passesTargeting: since inclusive, until exclusive", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const ctx: TargetingContext = { version: null, installId: "", now };
    assert.ok(passesTargeting(rec({ since: "2026-11-02T12:00:00Z" }), ctx)); // boundary shows
    assert.ok(!passesTargeting(rec({ since: "2026-11-02T12:00:01Z" }), ctx)); // future hides
    assert.ok(!passesTargeting(rec({ until: "2026-11-02T12:00:00Z" }), ctx)); // boundary hides
    assert.ok(passesTargeting(rec({ until: "2026-11-02T12:00:01Z" }), ctx));
    assert.ok(passesTargeting(rec({ since: "2026-01-01T00:00:00Z", until: "2027-01-01T00:00:00Z" }), ctx));
});

// ---- dismissal hashing ---------------------------------------------------------

test("normalizeRecord is key-order independent; hash16 is stable 16-hex", () => {
    const r1 = { id: "h1", kind: "other" as const, title: "T", desc: { en: "e", "zh-CN": "c" }, hint: "H" };
    const r2 = { id: "h1", desc: { "zh-CN": "c", en: "e" }, kind: "other" as const, title: "T", hint: "H" };
    assert.equal(normalizeRecord(r1), normalizeRecord(r2));
    const h = noticeHash16(r1);
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.equal(dismissKeyOf(r1), `h1@${h}`);
    assert.notEqual(noticeHash16(r1), noticeHash16({ ...r1, title: "T2" })); // content edit → new hash
});

test("noticeVisible: persistent honors hash key AND legacy bare id", () => {
    const r = rec({ id: "pv" });
    const key = dismissKeyOf(r);
    assert.ok(noticeVisible(r, new Set()));
    assert.ok(!noticeVisible(r, new Set([key])));
    assert.ok(!noticeVisible(r, new Set(["pv"]))); // pre-P2 stores keep working
    assert.ok(!noticeVisible(r, new Set([key, "pv"])));
    assert.ok(noticeVisible(r, new Set(["other-id@abc"])));
});

test("noticeVisible: instance mode ignores the persistent set; always never hides", () => {
    const inst = rec({ id: "im", dismiss: "instance" });
    const pers = rec({ id: "pm", dismiss: "persistent" });
    const always = rec({ id: "am", dismiss: "always" });
    const persistSet = new Set([dismissKeyOf(inst), "im", dismissKeyOf(pers), "pm", dismissKeyOf(always), "am"]);
    assert.ok(noticeVisible(inst, persistSet, new Set())); // persistent set irrelevant
    assert.ok(!noticeVisible(inst, persistSet, new Set(["im"])));
    assert.ok(!noticeVisible(pers, persistSet, new Set()));
    assert.ok(noticeVisible(always, persistSet, new Set(["am"]))); // even fully dismissed
    assert.equal(dismissModeOf(rec({})), "persistent"); // default mode
});

// ---- layer merging ---------------------------------------------------------------

test("mergeNoticeLayers: earlier layers win on id collision", () => {
    const local = [rec({ id: "dup", title: "local copy" })];
    const remote = [rec({ id: "dup", title: "remote copy" }), rec({ id: "r-only" })];
    const builtin = [rec({ id: "dup", title: "builtin copy" }), rec({ id: "b-only" })];
    const merged = mergeNoticeLayers([local, remote, builtin]);
    assert.deepEqual(merged.map((r) => r.id), ["dup", "r-only", "b-only"]);
    assert.equal(merged[0].title, "local copy");
});

// ---- local loader ------------------------------------------------------------------

function makeEnv(prefix: string): { env: NodeJS.ProcessEnv; dir: string; annDir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const annDir = path.join(dir, "billion-context", "announcements");
    fs.mkdirSync(annDir, { recursive: true });
    return { env: { XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv, dir, annDir };
}

test("loadLocalAnnouncements: drop a file → it appears; bad files are skipped individually", () => {
    const { env, annDir } = makeEnv("notices-lane-load-");
    assert.deepEqual(loadLocalAnnouncements(env), { records: [], errors: [] }); // empty dir
    fs.writeFileSync(path.join(annDir, "good.json"), JSON.stringify({ id: "good-one", kind: "new-feature", title: { "zh-CN": "好", en: "Good" } }));
    fs.writeFileSync(path.join(annDir, "broken.json"), "{ not json !!");
    fs.writeFileSync(path.join(annDir, "invalid.json"), JSON.stringify({ id: "Bad Id!", kind: "other", title: "T" }));
    const big = { id: "big-one", kind: "other", title: "T", desc: "x".repeat(LOCAL_FILE_CAP_BYTES) };
    fs.writeFileSync(path.join(annDir, "big.json"), JSON.stringify(big));
    fs.writeFileSync(path.join(annDir, "notes.txt"), "ignored, not *.json");
    const load = loadLocalAnnouncements(env);
    assert.deepEqual(load.records.map((r) => r.id), ["good-one"]);
    assert.equal(load.errors.length, 3);
    const reasons = Object.fromEntries(load.errors.map((e) => [e.file, e.reason]));
    assert.match(reasons["broken.json"] ?? "", /bad JSON/);
    assert.match(reasons["invalid.json"] ?? "", /id must match/);
    assert.match(reasons["big.json"] ?? "", /exceeds/);
    // memoized while the signature is unchanged (log-once-per-change contract)
    assert.equal(loadLocalAnnouncements(env), load);
    // content edit changes the signature → reloaded
    fs.writeFileSync(path.join(annDir, "good.json"), JSON.stringify({ id: "good-two", kind: "other", title: "v2" }));
    assert.deepEqual(loadLocalAnnouncements(env).records.map((r) => r.id), ["good-two"]);
});

test("loadLocalAnnouncements: unknown fields dropped, record still loads", () => {
    const { env, annDir } = makeEnv("notices-lane-drop-");
    fs.writeFileSync(path.join(annDir, "u.json"), JSON.stringify({ id: "u-one", kind: "other", title: "T", surprise: true }));
    const load = loadLocalAnnouncements(env);
    assert.deepEqual(load.records.map((r) => r.id), ["u-one"]);
    assert.equal((load.records[0] as unknown as Record<string, unknown>)["surprise"], undefined);
    assert.equal(load.errors.length, 0);
});

test("loadLocalAnnouncements: absent directory is zero records, not an error", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notices-lane-absent-"));
    const env = { XDG_CONFIG_HOME: dir } as NodeJS.ProcessEnv;
    assert.deepEqual(loadLocalAnnouncements(env), { records: [], errors: [] });
});

// ---- dismissal store ------------------------------------------------------------------

function stateEnv(prefix: string): { env: NodeJS.ProcessEnv; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return {
        env: { XDG_STATE_HOME: dir } as NodeJS.ProcessEnv,
        file: path.join(dir, "billion-context", "upgrade-notices.json"),
    };
}

test("dismissPersistentNotice writes id@hash16 keys; legacy entry writes bare ids", () => {
    registerDynamicNoticeIds(["dyn-store"]);
    const { env, file } = stateEnv("notices-store-");
    const r = rec({ id: "dyn-store", title: "stable copy" });
    assert.ok(dismissPersistentNotice(dismissKeyOf(r), env));
    let doc = JSON.parse(fs.readFileSync(file, "utf8")) as { dismissed: string[] };
    assert.deepEqual(doc.dismissed, [dismissKeyOf(r)]);
    assert.ok(dismissUpgradeNotice(PCK_NOTICE_ID, env)); // legacy bare id
    doc = JSON.parse(fs.readFileSync(file, "utf8")) as { dismissed: string[] };
    assert.deepEqual(doc.dismissed, [dismissKeyOf(r), PCK_NOTICE_ID]);
    // unregistered ids are rejected by the allowlist
    assert.ok(!dismissPersistentNotice("ghost@0000000000000000", env));
    assert.ok(!dismissUpgradeNotice("ghost-bare", env));
    // malformed keys rejected
    assert.ok(!dismissPersistentNotice("@nope", env));
    assert.ok(!dismissPersistentNotice("no-at-sign", env));
});

test("store keeps insertion order under the 200-key FIFO cap", () => {
    const ids = Array.from({ length: 205 }, (_, i) => `cap-${i}`);
    registerDynamicNoticeIds(ids);
    const { env, file } = stateEnv("notices-cap-");
    for (const id of ids) {
        const r = rec({ id, title: `copy ${id}` });
        assert.ok(dismissPersistentNotice(dismissKeyOf(r), env));
    }
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { dismissed: string[] };
    assert.equal(doc.dismissed.length, 200);
    const oldest = dismissKeyOf(rec({ id: "cap-0", title: "copy cap-0" }));
    const newest = dismissKeyOf(rec({ id: "cap-204", title: "copy cap-204" }));
    assert.ok(!doc.dismissed.includes(oldest)); // FIFO eviction dropped the oldest
    assert.ok(doc.dismissed.includes(newest));
    assert.equal(doc.dismissed[0], dismissKeyOf(rec({ id: "cap-5", title: "copy cap-5" })));
});

test("pckNoticeActive honors both key forms; instance mode is memory-only", () => {
    const wire = BUILTIN_NOTICES.find((b) => b.id === PCK_NOTICE_ID)!;
    const { active: _active, ...pckRec } = wire;
    // hash-key dismissal hides it
    const a = stateEnv("notices-pck-hash-");
    assert.ok(pckNoticeActive("disabled", a.env));
    assert.ok(dismissPersistentNotice(dismissKeyOf(pckRec), a.env));
    assert.ok(!pckNoticeActive("disabled", a.env));
    assert.ok(!pckNoticeActive("auto", a.env)); // routing gate still applies (only "disabled" activates)
    // legacy bare-key dismissal hides it too
    const b = stateEnv("notices-pck-legacy-");
    assert.ok(dismissUpgradeNotice(PCK_NOTICE_ID, b.env));
    assert.ok(!pckNoticeActive("disabled", b.env));
    // instance dismissals live in memory only — nothing hits the store file
    recordInstanceNoticeDismissal("inst-probe");
    assert.ok(instanceDismissedNotices().has("inst-probe"));
    assert.equal(fs.existsSync(b.file) ? dismissedUpgradeNotices(b.env).has("inst-probe") : false, false);
});

// ---- install id ---------------------------------------------------------------------

test("installIdOf persists a stable uuid per state dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notices-installid-"));
    const env = { XDG_STATE_HOME: dir } as NodeJS.ProcessEnv;
    const id1 = installIdOf(env);
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(installIdOf(env), id1);
    assert.equal(fs.readFileSync(path.join(dir, "billion-context", "install-id"), "utf8").trim(), id1);
    // a different state dir gets its own identity
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "notices-installid2-"));
    assert.notEqual(installIdOf({ XDG_STATE_HOME: dir2 } as NodeJS.ProcessEnv), id1);
});

// ---- end-to-end-ish: targeting + visibility composition -----------------------------

test("collect pipeline pieces compose: gated-out local records never reach the payload", () => {
    registerDynamicNoticeIds(["expiring", "gated-ver", "gated-pct"]);
    const now = Date.parse("2026-11-02T12:00:00Z");
    const ctx: TargetingContext = { version: "0.1.212", installId: "install-z", now };
    const expiring = rec({ id: "expiring", kind: "incident", publishedAt: "2026-11-01T00:00:00Z", until: "2026-11-02T12:00:00Z" });
    const gatedVer = rec({ id: "gated-ver", kind: "warning", versions: ["0.9.0"] });
    const gatedPct = rec({ id: "gated-pct", kind: "suggestion", percent: percentBucket("install-z", "gated-pct") });
    const open = rec({ id: "open-one", kind: "deprecation" });
    const pool = [expiring, gatedVer, gatedPct, open];
    const visible = sortNotices(pool.filter((r) => passesTargeting(r, ctx) && noticeVisible(r, new Set())));
    assert.deepEqual(visible.map((r) => r.id), ["open-one"]);
    // priority ordering across kinds when several pass
    const multi = sortNotices([rec({ id: "m-low", kind: "other" }), rec({ id: "m-high", kind: "incident" })]);
    assert.deepEqual(multi.map((r) => r.id), ["m-high", "m-low"]);
    assert.equal(priorityOf(multi[0]), 90);
    assert.equal(toneOf(multi[0]), "warn");
    assert.equal(NOTICE_KINDS.length, 7);
});
