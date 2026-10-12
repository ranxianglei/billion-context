// #2920: pool-outside caches bypassed the resident byte budget. (a) src/plugin.ts
// kept processed/original plugin histories in a module-level Map keyed by session
// id, cleaned only on the NEXT remember call — an evicted session's history
// lingered. (b) src/cache-ledger.ts kept seam-forensics slots in WeakMaps keyed
// by Session (invisible to object-graph metering) whose str/full strings were
// views/aliases pinning the FULL backing store of large outbound bodies behind
// their 512 KiB diagnostic heads. Contract pinned here: both caches anchor on
// explicit in-memory-only Session fields (eviction frees them, #2803 metering
// counts them); retained strings are independent UTF-16 code-unit-faithful copies
// (lone surrogates survive — no utf8 round-trip) bounded by SEAM_BODY_CAP; the
// SHA-256 still hashes the full original body; nothing new reaches disk or wire.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { noteForwardedBody, settleUsageReport, getCacheLedger } from "../src/cache-ledger.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { rememberPluginMessages, _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, getStore, _setStoreForTest, relPathFor } from "../src/persist.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const CAP = 512 * 1024; // mirrors SEAM_BODY_CAP (src/cache-ledger.ts)
const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// Deterministic body with lone high/low surrogates and an astral pair scattered
// every 65536 code units — a utf8 round-trip would replace the lone surrogates
// with U+FFFD; a code-unit-faithful copy keeps them verbatim.
function synthBody(len: number): string {
    const codes = new Array<number>(len);
    for (let i = 0; i < len; i++) {
        const m = i % 65536;
        if (m === 0) codes[i] = 0xd800;
        else if (m === 4096) codes[i] = 0xdc00;
        else if (m === 8192) codes[i] = 0xd83d;
        else if (m === 8193) codes[i] = 0xde29;
        else codes[i] = 0x78;
    }
    let s = "";
    for (let o = 0; o < len; o += 65536) s += String.fromCharCode(...codes.slice(o, o + 65536));
    return s;
}

test("#2920: retained seam strings are code-unit-faithful across all size regimes", () => {
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const cases: Array<[string, number]> = [
        ["under-cap", 100_000],
        ["at-cap", CAP],
        ["over-cap", CAP + 1],
        ["four-mib", 4 * 1024 * 1024],
    ];
    for (const [label, len] of cases) {
        const s = getSession(`t1-${label}`);
        const body = synthBody(len);
        noteForwardedBody(s, body, 3, "sha256:test");
        const slot = s.seamLastSent;
        assert.ok(slot, `${label}: slot present on the session`);
        assert.equal(slot!.digest, sha256(body), `${label}: digest hashes the FULL original body`);
        assert.equal(slot!.msgs, 3);
        assert.equal(slot!.keyFp, "sha256:test");
        if (len <= CAP) {
            assert.equal(slot!.str, body, `${label}: whole body retained verbatim`);
            assert.equal(slot!.full, body, `${label}: full === body under the cap`);
        } else {
            assert.equal(slot!.str.length, CAP, `${label}: retained head capped`);
            assert.equal(slot!.str, body.slice(0, CAP), `${label}: head copy code-unit identical (lone surrogates intact)`);
            assert.equal(slot!.full, null, `${label}: no full-body retention above the cap`);
        }
        // Non-streaming settle re-notes the identical payload without msgs/keyFp:
        // the samePayload branch must inherit them.
        noteForwardedBody(s, body);
        assert.equal(s.seamLastSent!.msgs, 3, `${label}: samePayload inherits msgs`);
        assert.equal(s.seamLastSent!.keyFp, "sha256:test", `${label}: samePayload inherits keyFp`);
    }
    _resetSessionsForTest();
});

test("#2920: divergence classification invariant under the cap-bounded regime", () => {
    _resetSessionsForTest();
    const settleCall = (s: Parameters<typeof settleUsageReport>[0]) =>
        settleUsageReport(s, { total: 100_000, reportedCached: 90_000, output: 0, protocol: "openai", upstream: "http://u" });
    // Both bodies fit under the cap: precise offset + class preserved (#2131 behavior unchanged).
    // Divergence sits deep mid-history (not within 64 bytes of the tail, which
    // would classify as "append").
    const s1 = getSession("t5-small");
    const mid1 = "a".repeat(50_000) + "M" + "c".repeat(50_000);
    const mid2 = "a".repeat(50_000) + "N" + "c".repeat(50_000);
    noteForwardedBody(s1, mid1);
    settleCall(s1);
    noteForwardedBody(s1, mid2);
    settleCall(s1);
    let line = getCacheLedger(s1).lines[getCacheLedger(s1).lines.length - 1]!;
    assert.equal(line.be, 0);
    assert.equal(line.bl, 50_000, "mid-history offset measured exactly under the cap");
    assert.equal(line.bs, "mid");
    // Both bodies above the cap: digest proves inequality, offset unavailable.
    const s2 = getSession("t5-big");
    const head = "q".repeat(600 * 1024);
    noteForwardedBody(s2, head + "AAA");
    settleCall(s2);
    noteForwardedBody(s2, head + "BBB");
    settleCall(s2);
    line = getCacheLedger(s2).lines[getCacheLedger(s2).lines.length - 1]!;
    assert.equal(line.be, 0, "inequality still proven by digest above the cap");
    assert.equal(line.bl, undefined, "no byte offset above the cap");
    assert.equal(line.bs, "unknown");
    _resetSessionsForTest();
});

test("#2920: transient caches never reach the persisted record", () => {
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const base = process.env.TMPDIR ?? path.join(process.cwd(), ".tmp");
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, "bili-2920-"));
    const prev = getStore();
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        const s = getSession("iso-2920-persist");
        const msg = { id: "raw-1", role: "user", contentType: "text", text: "w".repeat(10_000) } as const;
        s.pluginRemembered = { processed: [msg], original: [msg] };
        s.seamLastSent = { str: "y".repeat(10_000), msgs: 1, digest: sha256("y"), full: null };
        s.seamLastSettled = { str: "z".repeat(10_000), msgs: 1, digest: sha256("z"), full: null };
        assert.ok(store.flushSync(s), "flush succeeds");
        // Session files are named by a hash of the id — address it via relPathFor.
        const file = path.join(dir, relPathFor(s.id));
        assert.ok(fs.existsSync(file), "session file written");
        const raw = fs.readFileSync(file, "utf8");
        const rec = JSON.parse(raw) as Record<string, unknown>;
        assert.ok(!("pluginRemembered" in rec), "pluginRemembered stays out of the persisted record");
        assert.ok(!("seamLastSent" in rec), "seamLastSent stays out of the persisted record");
        assert.ok(!("seamLastSettled" in rec), "seamLastSettled stays out of the persisted record");
        assert.ok(!raw.includes("y".repeat(50)), "diagnostic payload text absent from disk");
    } finally {
        _setStoreForTest(prev);
        fs.rmSync(dir, { recursive: true, force: true });
        _resetSessionsForTest();
        _resetPluginStateForTest();
    }
});

const CHILD_SOURCE = `
declare const gc: () => void;
import { noteForwardedBody } from __CACHE_LEDGER__;
import { getSession, _resetSessionsForTest } from __SESSION__;
import { rememberPluginMessages } from __PLUGIN__;

const K = 8, SIZE = 4 * 1024 * 1024, CAP = __CAP__;
const mem = (): number => process.memoryUsage().heapUsed;
const settle = (): void => { gc(); gc(); };
const body = (i: number): string => {
    const raw = ("b" + i + ".").repeat(Math.ceil(SIZE / 3));
    void raw.charCodeAt(1024); // V8 keeps String.repeat results LAZY (unmeasured rope nodes) until first character access — force materialization so this models a real wire body
    return raw.slice(0, SIZE);
};

// T3: the plugin remembered history is released WITH its session.
settle();
let base = mem();
const hist = Array.from({ length: 128 }, (_, i) => {
    const t = ("h" + i + "-").repeat(4096);
    void t.charCodeAt(64); // force materialization (see body())
    return { id: "h" + i, role: "user", contentType: "text", text: t };
});
let victim = getSession("evict-me");
rememberPluginMessages("evict-me", hist, hist);
settle();
const held = mem() - base;
victim = undefined;
hist.length = 0;
_resetSessionsForTest();
settle();
const freed = mem() - base;

// T2 OLD: the pre-fix retention style — a capped-head slice pins the whole
// backing store (this is the leak; the sanity assert below proves the premise).
settle();
base = mem();
const retained: string[] = [];
for (let i = 0; i < K; i++) retained.push(body(i).slice(0, CAP));
settle();
const oldDelta = mem() - base;
retained.length = 0;
settle();

// T2 NEW: the actual noteForwardedBody on real sessions.
base = mem();
for (let i = 0; i < K; i++) noteForwardedBody(getSession("heap-" + i), body(i));
settle();
const newDelta = mem() - base;

console.log(JSON.stringify({ held, freed, oldDelta, newDelta }));
process.exit(0);
`;

test("#2920: heap footprint follows the diagnostic cap; eviction frees plugin history (spawned child)", function (this: { timeout: number }) {
    this.timeout = 240_000;
    const base = process.env.TMPDIR ?? path.join(process.cwd(), ".tmp");
    fs.mkdirSync(base, { recursive: true });
    const script = path.join(base, `issue2920-child-${process.pid}.ts`);
    const K = 8, SIZE = 4 * 1024 * 1024;
    fs.writeFileSync(script, CHILD_SOURCE
        .replaceAll("__CACHE_LEDGER__", JSON.stringify(path.resolve("src/cache-ledger.ts")))
        .replaceAll("__SESSION__", JSON.stringify(path.resolve("src/session.ts")))
        .replaceAll("__PLUGIN__", JSON.stringify(path.resolve("src/plugin.ts")))
        .replaceAll("__CAP__", String(CAP)));
    try {
        const r = spawnSync(process.execPath, ["--import", "tsx", "--expose-gc", "--max-old-space-size=512", script], {
            encoding: "utf8",
            timeout: 240_000,
            env: { ...process.env, BILI_PERSIST: "0", NODE_ENV: "test" },
        });
        if (r.status !== 0) throw new Error(`child failed (status ${r.status}): ${r.stderr.slice(-2000)}`);
        const last = r.stdout.trim().split("\n").pop()!;
        const m = JSON.parse(last) as { held: number; freed: number; oldDelta: number; newDelta: number };
        // Sanity: the pre-fix style really did pin the backing stores (the issue's
        // measured anchor: 8 x 4 MiB bodies kept ~32 MiB alive via 512 KiB heads).
        assert.ok(m.oldDelta >= K * SIZE * 2 * 0.5, `old-style slices pinned the backing stores (${mb(m.oldDelta)} MB retained)`);
        // Acceptance: footprint tracks the diagnostic cap, not the original length.
        assert.ok(m.newDelta <= K * CAP * 2 * 2.5, `new-style retention tracks the cap (${mb(m.newDelta)} MB)`);
        assert.ok(m.newDelta < m.oldDelta / 3, "footprint no longer scales with original body length");
        // Eviction releases the plugin history together with its session.
        assert.ok(m.held >= 1024 * 1024, `history was actually held pre-eviction (${mb(m.held)} MB)`);
        assert.ok(m.freed < m.held / 2, `eviction freed the history (${mb(m.freed)} MB left of ${mb(m.held)} MB held)`);
    } finally {
        fs.rmSync(script, { force: true });
    }
});
