import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOCKED_REF, defaultConfig } from "acp-kernel";
import { planForkAdoption, applyForkAdoption, seedTimestampsFromParent, maybeAdoptResume, incomingCoreMessages } from "../src/fork-adoption.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, getSession, type Session } from "../src/session.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { prefixAffinity } from "../src/prefix-affinity.ts";
import { flushPrefixAffinity } from "../src/affinity-persist.ts";
import { closeServers } from "./server-close-guard.ts";

process.env.NODE_ENV = "test";

// #5608 CI triage (windows-latest node-22 shard): both e2e subtests below depend
// on the phase-1 affinity snapshot surviving into the phase-2 server start
// (sync flushPrefixAffinity write + hydrate-on-listening read). On a Windows
// runner the round-trip lost the "old" chain once (#4264-style EMPTY candidate
// set ⇒ no weak adoption, no named rejection — both assertions fail the same
// way) without a diagnosable trace. These failure messages therefore carry the
// exact checkpoint state: what the tracker holds in memory, whether the
// snapshot file exists, and the captured log lines that name hydrate/miss.
function phase2Diag(dir: string, logs: string[]): string {
    const snap = prefixAffinity.exportSnapshot();
    let snapFile: string;
    try {
        const p = join(dir, "billion-context", "prefix-affinity.json");
        snapFile = existsSync(p) ? `${readFileSync(p, "utf8").length}B` : "<missing>";
    } catch (e) {
        snapFile = `ERR ${String(e)}`;
    }
    return `[diag] in-memory-chains=${JSON.stringify(snap.map((e) => `${e.sessionId}:${e.depth}`))} snapshot-file=${snapFile} captured-logs=${JSON.stringify(logs.filter((l) => l.includes("resume-inheritance") || l.includes("hydrated")).slice(-6))}`;
}

/**
 * #5608/#4313 regression pins for the resume-inheritance ledger carry. A stamp
 * is keyed by raw id (SHA-256 of message identity) and renders into the ACP
 * tag's time= attribute — cache-relevant bytes. Three paths used to drop the
 * byte-stable state:
 *  1. resume/fork ADOPTION seeded refs/blocks/latches but never tsStamps, so
 *     the first replay rendered time-less tags where the original process
 *     rendered time-stamped ones (byte flip at every tagged message);
 *  2. a resume-inheritance MISS started FRESH state — new ref numbers, minted
 *     "now" times, RAW ranges where the old process sent FOLDED carriers —
 *     flipping every tagged byte and re-billing the whole prefix for one
 *     generation (the 1–12% one-generation cache collapse in #5608);
 *  3. the weak miss path must log its relationship honestly, or a future
 *     triage reads a byte-exact-MISS adoption as a clean resume.
 * 1+2 ride seedTimestampsFromParent + set-semantics adoption; 3 pins the
 * maybeAdoptResume `via` phrasing (strong-path output stays byte-identical).
 */

type MinimalSession = { state: { tsStamps?: Record<string, number> } };

function freshChild(): Session {
    return { state: {} } as unknown as Session;
}

test("seedTimestampsFromParent: empty child inherits the whole parent ledger", () => {
    const parent = { state: { tsStamps: { rawA: 1000, rawB: 2000 } } } as unknown as Session;
    const child = freshChild();
    const n = seedTimestampsFromParent(child, parent);
    assert.equal(n, 2);
    assert.deepEqual((child.state as MinimalSession["state"]).tsStamps, { rawA: 1000, rawB: 2000 });
});

test("seedTimestampsFromParent: child entries win on conflict (its own first-sight beats the parent's)", () => {
    const parent = { state: { tsStamps: { rawA: 1000, rawC: 3000 } } } as unknown as Session;
    const child = { state: { tsStamps: { rawA: 4242 } } } as unknown as Session;
    const n = seedTimestampsFromParent(child, parent);
    assert.equal(n, 1, "only the absent id is seeded");
    const stamps = (child.state as MinimalSession["state"]).tsStamps!;
    assert.equal(stamps.rawA, 4242, "child value preserved");
    assert.equal(stamps.rawC, 3000);
});

test("seedTimestampsFromParent: no aliasing — child gets its own map", () => {
    const parent = { state: { tsStamps: { rawA: 1000 } } } as unknown as Session;
    const child = freshChild();
    seedTimestampsFromParent(child, parent);
    (child.state as MinimalSession["state"]).tsStamps!.rawA = 9999;
    assert.equal((parent.state as MinimalSession["state"]).tsStamps!.rawA, 1000, "parent ledger untouched");
});

test("seedTimestampsFromParent: undefined parent or missing ledger is a no-op returning 0", () => {
    const child = freshChild();
    assert.equal(seedTimestampsFromParent(child, undefined), 0);
    const bareParent = { state: {} } as unknown as Session;
    assert.equal(seedTimestampsFromParent(child, bareParent), 0);
    assert.equal((child.state as MinimalSession["state"]).tsStamps, undefined, "no empty map materialized when nothing seeded");
});

test("applyForkAdoption carries the timestamp ledger into the adopted child (#5608)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const parent = {
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: { r1: "m00001" }, byRef: { m00001: "r1" } },
            tsStamps: { r1: 1730000000 },
        },
    } as unknown as Session;
    const child = {
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: {} as Record<string, string>, byRef: {} as Record<string, string> },
        },
        blockContents: new Map(),
    } as unknown as Session;
    const plan = planForkAdoption(parent, new Set(["r1"]), { seedAllRefs: true, includeBlocks: false });
    applyForkAdoption(child, plan, parent);
    assert.deepEqual((child.state as MinimalSession["state"]).tsStamps, { r1: 1730000000 }, "stamp rides the adoption — first replay re-renders the provider-cached time attr");
});

test("applyForkAdoption without a parent ledger leaves the child stamp-free (honest NULL, node mints on arrival)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const parent = {
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: { p1: BLOCKED_REF, r1: "m00001" }, byRef: { m00001: "r1" } },
        },
    } as unknown as Session;
    const child = {
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: {} as Record<string, string>, byRef: {} as Record<string, string> },
        },
        blockContents: new Map(),
    } as unknown as Session;
    const plan = planForkAdoption(parent, new Set(["p1", "r1"]), { seedAllRefs: true, includeBlocks: false });
    applyForkAdoption(child, plan, parent);
    assert.equal((child.state as MinimalSession["state"]).tsStamps, undefined);
});

test("resume-inheritance MISS seeds the timestamp ledger from the closest tracked chain (#5608 wiring)", { timeout: 90_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-miss-seed-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    // defeat the suite's ambient BILI_MESSAGE_TIMESTAMPS=0 pin (#4313 default ON) — without stamp minting there is nothing for the seed rung to carry
    const prevStampEnv = process.env.BILI_MESSAGE_TIMESTAMPS;
    delete process.env.BILI_MESSAGE_TIMESTAMPS;
    _resetSessionsForTest();
    // Eight distinct messages: the miss diagnostics only judge chains at or
    // above MIN_RESUME_PREFIX (8) — shorter chains never produce a closest
    // candidate, so the seed rung would be unreachable below this floor.
    const messages = [
        { role: "user", content: "miss-seed turn one with enough substance to fingerprint" },
        { role: "assistant", content: "miss-seed answer one" },
        { role: "user", content: "miss-seed turn two" },
        { role: "assistant", content: "miss-seed answer two" },
        { role: "user", content: "miss-seed turn three" },
        { role: "assistant", content: "miss-seed answer three" },
        { role: "user", content: "miss-seed turn four" },
        { role: "assistant", content: "miss-seed answer four" },
    ];
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 1000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const uaddr = upstream.address();
    assert(uaddr && typeof uaddr === "object");
    const upstreamUrl = `http://127.0.0.1:${uaddr.port}`;
    const options = { port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions;

    // Phase 1: build the old chain under id "old" and persist everything (session + affinity snapshot).
    const store1 = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60_000 });
    _setStoreForTest(store1);
    _setForTest({});
    const proxy1 = await startServer(options);
    await once(proxy1, "listening");
    const paddr1 = proxy1.address();
    assert(paddr1 && typeof paddr1 === "object");
    let oldStamps: Record<string, number> | undefined;
    try {
        const r1 = await fetch(`http://127.0.0.1:${paddr1.port}/bili/${upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "old" }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages }) });
        assert.equal(r1.status, 200, await r1.text());
        oldStamps = getSession("old").state.tsStamps;
        assert.ok(oldStamps && Object.keys(oldStamps).length >= 8, "phase 1 minted stamps for the tagged history");
        flushPrefixAffinity();
        prefixAffinity.forget("old");
        assert.ok(store1.flushSync(getSession("old")), "phase 1 session persisted");
    } finally {
        store1.closeQuietly();
        await closeServers([proxy1], "miss-seed phase 1");
    }

    // Phase 2: fresh process state, NEW id. #5608 v3 reshaped this replay into the REAL
    // production shape (dsh desktop restart): the whole old history BYTE-IDENTICAL plus
    // ONE genuinely new turn — strictly deeper than the tracked chain, fully verified
    // common prefix. That is the only shape the weak-adoption gate accepts; the old
    // fixture was an equal-depth verbatim replay, which v2 adopted unconditionally and
    // which #1486 rules out by design (two unrelated sessions may legally resend the
    // same bytes under different ids — adopting there smuggles foreign blocks across
    // lanes, measured on #3686 in CI).
    _resetSessionsForTest();
    const store2 = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60_000 });
    _setStoreForTest(store2);
    const logs: string[] = [];
    setLogCapture((level, msg) => { if (level === "info") logs.push(msg); });
    const proxy2 = await startServer(options);
    await once(proxy2, "listening");
    const paddr2 = proxy2.address();
    assert(paddr2 && typeof paddr2 === "object");
    // #5608 Windows-CI race (run 42066002804): startServer's listening callback
    // awaits resolvePortClaim BEFORE announceListening runs hydrate-on-listening
    // (src/server.ts), so the first request can land against an EMPTY tracker —
    // diagnoseResumeMiss then has no candidate and its diagnostic is debug-level
    // (invisible to the info capture), silently skipping the whole miss path.
    // Awaiting hydration here mirrors production (a restarted desktop re-sends
    // well after startup settled) and makes the race impossible:
    for (let i = 0; i < 400 && !prefixAffinity.exportSnapshot().some((e) => e.sessionId === "old"); i++) {
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(prefixAffinity.exportSnapshot().some((e) => e.sessionId === "old"), "phase-2 tracker must hold the phase-1 chain before the first request (hydrate-on-listening, #309)");
    try {
        const beforeT2 = Date.now();
        // v3 continuation shape — mirrors the production telemetry (#5608): the
        // desktop re-sends the SAME history with recent-tail drift (it re-renders
        // tool outputs/markers/session bits differently on reload) and appends
        // the new turn. The drifted tail defeats byte-exact matching (the strong
        // path needs an exact match), so this request lands on the WEAK rung.
        // Had the client replayed faithfully, findResumeParent above would have
        // adopted via the strong #1486 path instead — both rungs must carry the
        // ledger; this test pins the miss fallback specifically.
        const drifted = [
            ...messages.slice(0, 7),
            { role: "assistant", content: "miss-seed answer four (re-rendered by the desktop on reload)" },
            { role: "user", content: "miss-seed turn five — the new turn after the restart" },
        ];
        const r2 = await fetch(`http://127.0.0.1:${paddr2.port}/bili/${upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "new" }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: drifted }) });
        assert.equal(r2.status, 200, await r2.text());
        const fresh = getSession("new");
        const childStamps = fresh.state.tsStamps;
        assert.ok(childStamps && Object.keys(childStamps).length > 0, "phase 2 session has a stamp ledger");
        // The days-old ledger rides over wholesale (seed copies every parent
        // entry, orphaned ids included): no days-old value is re-minted:
        for (const [key, val] of Object.entries(oldStamps!)) {
            assert.equal(childStamps[key], val, `days-old stamp ${key} must ride over from the closest chain, not be re-minted now ${phase2Diag(dir, logs)}`);
        }
        // #5608-B: the weak path's uncovered ids (the re-rendered drifted line
        // AND the genuinely appended turn) sit in one undsplittable first
        // batch, so the adoption arms honest-NULL: NO id of that batch mints
        // "today" — fabricating would seed false values into future lineage
        // stamps, while NULL costs only the attribute on ≤2 display lines.
        const newKeys = Object.keys(childStamps!).filter((k) => !(k in oldStamps!));
        assert.equal(newKeys.length, 0, `the armed boundary pass mints nothing (${newKeys.length} new keys: ${JSON.stringify(newKeys)}) — honest NULL, not fabricated today (#5608-B)`);
        assert.ok(Object.keys(oldStamps!).every((k) => k in childStamps!), "every inherited entry rides over");
        // #5608: the miss path runs full weak adoption from the closest chain, so the
        // proof line is the adoption log naming the weak relationship (seeding is logged, not silent).
        assert.ok(logs.some((l) => l.includes("weakly resumed closest chain after byte-exact miss") && l.includes("old")), `weak adoption is logged, not silent ${phase2Diag(dir, logs)}`);
    } finally {
        setLogCapture(null);
        store2.closeQuietly();
        // shared singleton hygiene: leave no chain behind for later tests in this file
        prefixAffinity.forget("new");
        await closeServers([proxy2, upstream], "miss-seed phase 2");
        if (prevStampEnv === undefined) delete process.env.BILI_MESSAGE_TIMESTAMPS;
        else process.env.BILI_MESSAGE_TIMESTAMPS = prevStampEnv;
    }
});

/** Weak-path fixtures: a parent whose refs/stamps/block all match what an
 *  incoming (re)send of the same conversation carries — computed through the
 *  SAME incomingCoreMessages pipeline the server hook uses, so the ids agree. */
function weakFixtures() {
    const parsed = {
        model: "m",
        max_tokens: 1,
        messages: [
            { role: "user", content: "hello world 5608" },
            { role: "assistant", content: "hi there 5608" },
        ],
    };
    const msgs = incomingCoreMessages("anthropic", parsed)!;
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    const tsStamps: Record<string, number> = {};
    msgs.forEach((m, i) => {
        const ref = `m${String(i + 1).padStart(5, "0")}`;
        byRaw[m.id] = ref;
        byRef[ref] = m.id;
        tsStamps[m.id] = 1730000000 + i;
    });
    const blocks = [
        { blockId: "b1", active: true, effectiveMessageIds: [msgs[0].id], directBlockIds: [], compressedTokens: 42 },
    ];
    const meta = { protocol: "anthropic", upstreamOrigin: "test" };
    const parent = {
        id: "parent-weak",
        meta,
        blockContents: new Map(),
        state: { blocks, tokenSnapshot: {}, nextBlockId: 2, nextRunId: 1, messageRefs: { byRaw, byRef }, tsStamps },
    } as unknown as Session;
    const child = {
        id: "child-weak",
        meta,
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: {} as Record<string, string>, byRef: {} as Record<string, string> },
        },
        blockContents: new Map(),
    } as unknown as Session;
    return { parsed, msgs, parent, child };
}

test("weak-adoption gate: equal-depth replays and truncated subviews start FRESH (#5608 v3)", { timeout: 90_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-miss-gate-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    const prevStampEnv = process.env.BILI_MESSAGE_TIMESTAMPS;
    delete process.env.BILI_MESSAGE_TIMESTAMPS;
    _resetSessionsForTest();
    // Ten distinct messages: the miss diagnostics only judge chains at or above
    // MIN_RESUME_PREFIX (8) — the truncated subview below stays just above that
    // floor so it still produces a closest candidate.
    const messages = [
        { role: "user", content: "gate turn one with enough substance to fingerprint" },
        { role: "assistant", content: "gate answer one" },
        { role: "user", content: "gate turn two" },
        { role: "assistant", content: "gate answer two" },
        { role: "user", content: "gate turn three" },
        { role: "assistant", content: "gate answer three" },
        { role: "user", content: "gate turn four" },
        { role: "assistant", content: "gate answer four" },
        { role: "user", content: "gate turn five" },
        { role: "assistant", content: "gate answer five" },
    ];
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 1000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const uaddr = upstream.address();
    assert(uaddr && typeof uaddr === "object");
    const upstreamUrl = `http://127.0.0.1:${uaddr.port}`;
    const options = { port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions;

    // Phase 1: build the 8-message chain under id "old" and persist it.
    const store1 = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60_000 });
    _setStoreForTest(store1);
    _setForTest({});
    const proxy1 = await startServer(options);
    await once(proxy1, "listening");
    const paddr1 = proxy1.address();
    assert(paddr1 && typeof paddr1 === "object");
    try {
        const r1 = await fetch(`http://127.0.0.1:${paddr1.port}/bili/${upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "old" }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages }) });
        assert.equal(r1.status, 200, await r1.text());
        flushPrefixAffinity();
        prefixAffinity.forget("old");
        assert.ok(store1.flushSync(getSession("old")), "phase 1 session persisted");
    } finally {
        store1.closeQuietly();
        await closeServers([proxy1], "miss-gate phase 1");
    }

    // Phase 2: fresh process state. Two resends that must BOTH stay fresh — the
    // v2 bug shipped exactly these shapes being adopted (#3686 CI red): an
    // equal-depth byte-exact replay under a new id, then a shorter subview of
    // what the replay itself just tracked.
    _resetSessionsForTest();
    const store2 = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60_000 });
    _setStoreForTest(store2);
    const logs: string[] = [];
    setLogCapture((level, msg) => { if (level === "info") logs.push(msg); });
    const proxy2 = await startServer(options);
    await once(proxy2, "listening");
    const paddr2 = proxy2.address();
    assert(paddr2 && typeof paddr2 === "object");
    // #5608 Windows-CI race (run 42066002804): startServer's listening callback
    // awaits resolvePortClaim BEFORE announceListening runs hydrate-on-listening
    // (src/server.ts), so the first request can land against an EMPTY tracker —
    // diagnoseResumeMiss then has no candidate and its diagnostic is debug-level
    // (invisible to the info capture), silently skipping the whole miss path.
    // Awaiting hydration here mirrors production (a restarted desktop re-sends
    // well after startup settled) and makes the race impossible:
    for (let i = 0; i < 400 && !prefixAffinity.exportSnapshot().some((e) => e.sessionId === "old"); i++) {
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(prefixAffinity.exportSnapshot().some((e) => e.sessionId === "old"), "phase-2 tracker must hold the phase-1 chain before the first request (hydrate-on-listening, #309)");
    const post2 = (id: string, msgs: unknown[]) => fetch(`http://127.0.0.1:${paddr2.port}/bili/${upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": id }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: msgs }) });
    try {
        const eq = await post2("eq-replay", messages);
        assert.equal(eq.status, 200, await eq.text());
        const trunc = await post2("trunc-resend", messages.slice(0, 9));
        assert.equal(trunc.status, 200, await trunc.text());
        assert.ok(!logs.some((l) => l.includes("weakly resumed closest chain")), `neither misfire shape may be adopted weakly, saw: ${JSON.stringify(logs.filter((l) => l.includes("resume-inheritance")))} ${phase2Diag(dir, logs)}`);
        assert.ok(logs.some((l) => l.includes("eq-replay") && l.includes("equal-depth shape")), `the equal-depth replay names its rejection reason ${phase2Diag(dir, logs)}`);
        assert.ok(logs.some((l) => l.includes("trunc-resend") && l.includes("truncated shape")), `the truncated resend names its rejection reason ${phase2Diag(dir, logs)}`);
        const eqStamps = getSession("eq-replay").state.tsStamps;
        const truncStamps = getSession("trunc-resend").state.tsStamps;
        // #5608-B final stance: unproven identity = brand-new semantics.
        // These FRESH fallbacks start a NEW conversation as far as bili can
        // tell (below-threshold / non-deeper shapes are exactly what v3's
        // gate refuses adoption for), so their ids mint their own fresh
        // ledger — no inheritance, no arm. (Arming here proved unsound:
        // cross-lane boilerplate prefixes earn positive overlap against
        // genuinely new conversations too, and lanes without a kernel pass
        // could never clear the flag — #554 state deep-equals.)
        assert.ok(eqStamps && Object.keys(eqStamps).length > 0, `the equal-depth replay mints its OWN fresh ledger like any new conversation (keys: ${eqStamps ? Object.keys(eqStamps).length : "none"}) (#5608-B)`);
        assert.ok(truncStamps && Object.keys(truncStamps).length > 0, `the truncated resend mints its OWN fresh ledger like any new conversation (keys: ${truncStamps ? Object.keys(truncStamps).length : "none"}) (#5608-B)`);
    } finally {
        setLogCapture(null);
        store2.closeQuietly();
        // shared singleton hygiene: leave no chain behind for later tests
        prefixAffinity.forget("eq-replay");
        prefixAffinity.forget("trunc-resend");
        await closeServers([proxy2, upstream], "miss-gate phase 2");
        if (prevStampEnv === undefined) delete process.env.BILI_MESSAGE_TIMESTAMPS;
        else process.env.BILI_MESSAGE_TIMESTAMPS = prevStampEnv;
    }
});

test("maybeAdoptResume weak path (via): seeds refs+stamps+blocks and logs the WEAK relationship (#5608)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const { parsed, msgs, parent, child } = weakFixtures();
    const lines: string[] = [];
    const outcome = maybeAdoptResume({
        session: child,
        parent,
        sharedDepth: 0,
        protocol: "anthropic",
        parsed,
        upstreamOrigin: "test",
        blocksEnabled: true,
        via: "weakly resumed closest chain after byte-exact miss (#5608)",
        log: (_level, msg) => { lines.push(msg); },
    });
    assert.equal(outcome.seededRefs, msgs.length, "every present message keeps its PARENT ref — tag bytes stay provider-cached");
    assert.equal(outcome.adoptedActive, 1, "the fully-present block is adopted — the child re-renders the folded carrier, not raw range");
    assert.equal(child.state.messageRefs.byRaw[msgs[0].id], "m00001");
    assert.deepEqual((child.state as MinimalSession["state"]).tsStamps, Object.fromEntries(msgs.map((m) => [m.id, 1730000000 + msgs.indexOf(m)])));
    assert.equal(child.state.blocks.length, 1);
    const adoptLine = lines.find((l) => l.includes("inherited"));
    assert.ok(adoptLine?.includes("weakly resumed closest chain after byte-exact miss"), "log names the weak relationship for future triage");
    assert.ok(!lines.some((l) => l.includes("shared msgs")), "strong-resume phrasing must not leak into the weak path");
});

test("maybeAdoptResume strong path (no via): success-line phrasing unchanged (#1486 regression guard)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const { parsed, parent, child } = weakFixtures();
    const lines: string[] = [];
    maybeAdoptResume({
        session: child,
        parent,
        sharedDepth: 2,
        protocol: "anthropic",
        parsed,
        upstreamOrigin: "test",
        blocksEnabled: true,
        log: (_level, msg) => { lines.push(msg); },
    });
    const adoptLine = lines.find((l) => l.includes("inherited"));
    assert.ok(
        adoptLine?.startsWith("[resume-inheritance] child-weak resumed parent-weak (2 shared msgs): inherited"),
        `strong-path line must stay byte-identical to pre-#5608 wording, got: ${adoptLine}`,
    );
});
