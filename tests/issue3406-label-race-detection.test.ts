import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "acp-kernel";
import type { CompressionBlock } from "acp-kernel";
import { flatFileNameFor } from "acp-kernel/persist";
import { SessionStore, relPathFor } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #3406 item 3 (detection half of the #3199 race): when a label-based resume
// lands while the post-boot background alias scan is still running, the alias
// does not exist yet, so getSession mints a fresh EMPTY session under the
// label; once the scan reaches the older file the direct-id file wins every
// later lookup and the prior conversation stays unreachable under the label.
// A full fix needs an index/format decision (owner-gated); these tests pin
// the stopgap: at scan completion the store logs ONE loud warn naming both
// states — for BOTH on-disk shapes of the racy direct-id file (flat and
// protocol-namespaced, #1937) — and stays silent for the two look-alike
// shapes that are NOT the race (a healthy alias-resume re-key keeps its
// original createdAt; a plain unrecorded alias has no conflicting direct-id
// file at all).

// Plain JSON session files so seeds and round-trips stay deterministic (#1080)
process.env.BILI_PERSIST_ZSTD = "0";

// Hermetic config: a developer machine's real billion-context.json must not
// leak storage settings into this suite's tmp-dir stores (same discipline as
// tests/issue3199-overview-cold-scan.test.ts).
process.env.BILI_CONFIG_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "bili-3406-hermetic-")),
    "no-config.json",
);
// Absent everywhere resolves to the shadow DEFAULT (#2815 rollout flip); pin
// the explicit legacy baseline — legs flip per test.
process.env.BILI_STORAGE_UNIFIED = "legacy";

interface Stats {
    requests: number;
    tokensSaved: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    cacheSamples: number;
    lastInputTokens: number;
    contextTokens: number;
    retrieveCalls: number;
    retrieveHits: number;
    retrieveMisses: number;
    retrieveDropped: number;
    retrieveDelivered: number;
    storedBytes: number;
    storeBytesSaved: number;
    compressCreditTokens: number;
    rangeRestores: number;
}

function zeroStats(): Stats {
    return { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, retrieveDropped: 0, retrieveDelivered: 0, storedBytes: 0, storeBytesSaved: 0, compressCreditTokens: 0, rangeRestores: 0 };
}

function makeSession(id: string, meta: Session["meta"] = {}, patch: Partial<Stats> = {}, lastSeen = Date.now()): Session {
    return {
        id,
        meta,
        stats: { ...zeroStats(), ...patch },
        metadata: {},
        state: createInitialState(),
        createdAt: lastSeen,
        lastSeen,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

const mkBlock = (blockId: string, compressedTokens: number, active: boolean, topic = "T"): CompressionBlock => ({
    blockId,
    runId: "r1",
    tier: 1,
    topic,
    summary: "S",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    compressedTokens,
    createdAt: Date.now(),
    survivedCount: 1,
    generation: "young",
    active,
});

/** Full persisted-state shape (kernel initial state + our blocks) so hand-
 *  written records survive both summary extraction AND buildSession's compat
 *  pass in the loadSync legs. */
function stateWith(blocks: CompressionBlock[]): unknown {
    const s = JSON.parse(JSON.stringify(createInitialState())) as { blocks: unknown[] };
    s.blocks = blocks;
    return s;
}

/** id → absolute envelope path, by scanning the corpus (layout-independent —
 *  protocol-namespaced files live in subdirectories, #1937). */
function fileById(root: string, id: string): string | null {
    const walk = (r: string): string[] => {
        const out: string[] = [];
        for (const e of readdirSync(r, { withFileTypes: true })) {
            const p = path.join(r, e.name);
            if (e.isDirectory()) out.push(...walk(p));
            else if (e.name.endsWith(".json")) out.push(p);
        }
        return out;
    };
    for (const p of walk(root)) {
        try {
            const env = JSON.parse(readFileSync(p, "utf8")) as { id?: unknown; payload?: { id?: unknown } };
            if (env.id === id || env.payload?.id === id) return p;
        } catch {
            // non-JSON / unreadable: not our file
        }
    }
    return null;
}

interface LogLine { level: "info" | "warn" | "error"; msg: string }

interface UnderLabelShape { createdAt: number; savedAt: number; mtimeSec: number; namespaced?: boolean }

/** Corpus shared by all legs: 4 filler sessions (newest mtimes — they take
 *  the whole warm window) plus the OLD labeled session outside the window.
 *  `underLabel` adds the conflicting direct-id file when given. Returns every
 *  seeded id with its on-disk path (mtime already stamped). */
async function seedCorpus(dir: string, underLabel?: UnderLabelShape): Promise<Array<{ id: string; file: string }>> {
    const seeder = new SessionStore({ dir, debounceMs: 0, enabled: true });
    assert.ok(seeder.replicasAvailable(), "sidecar must be live for these legs (engine available)");
    const base = Math.floor(Date.now() / 1000) - 5 * 60;
    const entries: Array<{ id: string; file: string }> = [];
    for (let i = 0; i < 4; i++) {
        const id = `s3406-fill-${i}`;
        const s = makeSession(id, { protocol: "openai", title: `Fill ${i}`, label: id }, { requests: i + 1, contextTokens: 100 * (i + 1) });
        s.state.blocks.push(mkBlock(`sf${i}`, 100 * (i + 1), true, `Fill ${i}`));
        await seeder.writeNow(s);
        entries.push({ id, file: "" });
    }
    seeder.closeQuietly();
    for (const e of entries) {
        e.file = fileById(dir, e.id)!;
        assert.ok(e.file, `session file for ${e.id}`);
        utimesSync(e.file, base + Number(e.id.slice(-1)) * 60, base + Number(e.id.slice(-1)) * 60);
    }
    const oldFile = path.join(dir, flatFileNameFor("s3406-old"));
    writeFileSync(oldFile, JSON.stringify({
        version: 2,
        savedAt: (base - 120) * 1000,
        createdAt: (base - 120) * 1000,
        id: "s3406-old",
        meta: { protocol: "openai", title: "Old Conversation", label: "s3406-label" },
        stats: { ...zeroStats(), requests: 7, contextTokens: 700 },
        state: stateWith([]),
    }), "utf8");
    utimesSync(oldFile, base - 120, base - 120);
    entries.push({ id: "s3406-old", file: oldFile });
    if (underLabel) {
        // Production racy sessions carry protocol meta and persist NAMESPACED
        // (proto/<host>_<hash>.json, #1937) — matched by the suffix branch;
        // namespaced:false pins the flat fallback shape.
        const rel = underLabel.namespaced ? relPathFor("s3406-label", "openai") : flatFileNameFor("s3406-label");
        const nFile = path.join(dir, rel);
        mkdirSync(path.dirname(nFile), { recursive: true });
        writeFileSync(nFile, JSON.stringify({
            version: 2,
            savedAt: underLabel.savedAt,
            createdAt: underLabel.createdAt,
            id: "s3406-label",
            meta: { protocol: "openai", title: "Minted Under Label", label: "s3406-label" },
            stats: { ...zeroStats() },
            state: stateWith([]),
        }), "utf8");
        utimesSync(nFile, underLabel.mtimeSec, underLabel.mtimeSec);
        entries.push({ id: "s3406-label", file: nFile });
    }
    return entries;
}

function withShadowMode<T>(name: string, fn: (dir: string) => Promise<T>): void {
    test(name, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-3406-"));
        const prevUnified = process.env.BILI_STORAGE_UNIFIED;
        process.env.BILI_STORAGE_UNIFIED = "shadow";
        try {
            await fn(dir);
        } finally {
            if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevUnified;
            _resetSessionsForTest();
            rmrf(dir);
        }
    });
}

async function bootAndScan(dir: string, logs: LogLine[]): Promise<SessionStore> {
    let maxFileSize = 0;
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
        if (!f.endsWith(".json") || f.endsWith(".content-store.json")) continue;
        try { maxFileSize = Math.max(maxFileSize, statSync(path.join(dir, f)).size); } catch { /* raced deletion */ }
    }
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true, log: (level, msg) => logs.push({ level, msg }) });
    await store.boot({ maxSessions: 4, maxBytes: maxFileSize * 5 });
    await store.backgroundScanComplete();
    return store;
}

withShadowMode("#3406 item 3: racy empty-under-label session gets exactly one loud warn at scan completion", async (dir) => {
    // createdAt/savedAt stamped AFTER the boot below starts (future dates make
    // the "born after bootStartedAtMs" discriminator deterministic — no sleeps).
    const entries = await seedCorpus(dir, { createdAt: Date.now() + 60_000, savedAt: Date.now() + 60_000, mtimeSec: Math.floor(Date.now() / 1000) - 6 * 60 });
    const logs: LogLine[] = [];
    // Byte budget = EXACTLY the four filler sizes: the parse window stops the
    // moment the fillers fill it, so the two late files (racy label + old
    // labeled) both fall through to the background scan — the race shape.
    const fillsTotal = entries.filter((e) => e.id.startsWith("s3406-fill-")).reduce((sum, e) => sum + statSync(e.file).size, 0);
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true, log: (level, msg) => logs.push({ level, msg }) });
    const booted = await store.boot({ maxSessions: 4, maxBytes: fillsTotal });
    assert.deepEqual([...booted.keys()].sort(), ["s3406-fill-0", "s3406-fill-1", "s3406-fill-2", "s3406-fill-3"], "warm set = the 4 fillers only");

    // Symptom pin: while the scan has not recorded the alias, resuming by
    // label hands back the EMPTY session minted under the label.
    const resumed = store.loadSync("s3406-label");
    assert.ok(resumed, "direct-id file resolves under the label");
    assert.equal(resumed!.stats.requests, 0, "the resumed state is the empty racy one");

    await store.backgroundScanComplete();
    const warns = logs.filter((l) => l.level === "warn" && l.msg.includes("label resume raced"));
    assert.equal(warns.length, 1, "exactly one race warning");
    assert.ok(warns[0].msg.includes("s3406-label"), "warn names the label");
    assert.ok(warns[0].msg.includes("s3406-old"), "warn names the surviving conversation id");

    // The prior conversation stays reachable by its real id.
    const old = store.loadSync("s3406-old");
    assert.ok(old, "old state loads by id");
    assert.equal(old!.stats.contextTokens, 700);
    // …and the label still serves the empty state (the stranded shape the warn describes).
    const again = store.loadSync("s3406-label");
    assert.equal(again!.stats.requests, 0, "direct-id file keeps winning lookups under the label");
    store.closeQuietly();
});

withShadowMode("#3406 item 3: namespaced (production-shape) racy session gets exactly one loud warn at scan completion", async (dir) => {
    // Same race as leg 1, but the racy direct-id file sits where real traffic
    // puts it: openai/<host>_<hash>.json — detection must find it through the
    // suffix branch, not just the flat-name match.
    const entries = await seedCorpus(dir, { createdAt: Date.now() + 60_000, savedAt: Date.now() + 60_000, mtimeSec: Math.floor(Date.now() / 1000) - 6 * 60, namespaced: true });
    const logs: LogLine[] = [];
    const fillsTotal = entries.filter((e) => e.id.startsWith("s3406-fill-")).reduce((sum, e) => sum + statSync(e.file).size, 0);
    const store = new SessionStore({ dir, debounceMs: 0, enabled: true, log: (level, msg) => logs.push({ level, msg }) });
    const booted = await store.boot({ maxSessions: 4, maxBytes: fillsTotal });
    assert.deepEqual([...booted.keys()].sort(), ["s3406-fill-0", "s3406-fill-1", "s3406-fill-2", "s3406-fill-3"], "warm set = the 4 fillers only");
    const racyFile = entries.find((e) => e.id === "s3406-label")!.file;
    assert.ok(path.relative(dir, racyFile).includes(path.sep), "racy file is protocol-namespaced, not flat");

    const resumed = store.loadSync("s3406-label");
    assert.ok(resumed, "namespaced direct-id file resolves under the label");
    assert.equal(resumed!.stats.requests, 0, "the resumed state is the empty racy one");

    await store.backgroundScanComplete();
    const warns = logs.filter((l) => l.level === "warn" && l.msg.includes("label resume raced"));
    assert.equal(warns.length, 1, "exactly one race warning");
    assert.ok(warns[0].msg.includes("s3406-label"), "warn names the label");
    assert.ok(warns[0].msg.includes("s3406-old"), "warn names the surviving conversation id");

    const old = store.loadSync("s3406-old");
    assert.ok(old, "old state loads by id");
    assert.equal(old!.stats.contextTokens, 700);
    const again = store.loadSync("s3406-label");
    assert.equal(again!.stats.requests, 0, "namespaced direct-id file keeps winning lookups under the label");
    store.closeQuietly();
});

withShadowMode("#3406 item 3 control: a healthy alias-resume re-key (original createdAt) stays silent", async (dir) => {
    const base = Math.floor(Date.now() / 1000) - 5 * 60;
    await seedCorpus(dir, { createdAt: (base - 60) * 1000, savedAt: (base - 60) * 1000, mtimeSec: base - 60 });
    const logs: LogLine[] = [];
    const store = await bootAndScan(dir, logs);
    assert.equal(logs.filter((l) => l.msg.includes("label resume raced")).length, 0, "re-keyed healthy resume must not warn");
    store.closeQuietly();
});

withShadowMode("#3406 item 3 control: a plain unrecorded alias with no conflicting file stays silent", async (dir) => {
    await seedCorpus(dir);
    const logs: LogLine[] = [];
    const store = await bootAndScan(dir, logs);
    assert.equal(logs.filter((l) => l.msg.includes("label resume raced")).length, 0, "plain alias resolution must not warn");
    const aliased = store.loadSync("s3406-label");
    assert.ok(aliased, "alias still resolves through the scan");
    assert.equal(aliased!.stats.contextTokens, 700, "alias serves the old conversation");
    store.closeQuietly();
});
