import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";

/**
 * #3049: persistence write-amplification pins. Production hosts with large
 * active sessions measured terabytes of cumulative writes because every
 * debounced save rewrites the ENTIRE JSON envelope (O(session size)) for an
 * O(delta) change, and the unified-storage modes layer an index mirror on top.
 * These tests pin the CURRENT cost shape so the fix that changes it
 * (incremental/append-only persistence, #2671) flips them on purpose:
 *
 *  1. legacy shape — per save, bytes written ≈ full current file size
 *     (amplification factor ≈ session_size / delta_size, far above 1).
 *  2. mode ordering at production scale — composite bytes (envelope rewrites
 *     + index footprint): full+jsonWriter=off < legacy < shadow. Shadow pays
 *     EXACTLY the legacy envelope PLUS the index mirror; index-only pays
 *     neither envelope. Asserted with a padded (~800 KB) session because the
 *     ordering has a crossover: each index save dirties a fixed number of
 *     b-tree pages regardless of delta size (SQLite rewrites whole 4 KB WAL
 *     frames), so BELOW roughly 100–200 KB of session size the index-only
 *     leg can cost MORE than the envelope rewrite. Production sessions are
 *     tens of MB, where the ordering holds by orders of magnitude.
 *
 * Measurement: after each save we stat the leg directory. Envelope bytes are
 * exact (one tmp write + rename per save, tmp size = final size, the file
 * grows monotonically). SQLite bytes are a footprint lower bound (peak of
 * index.db/-wal/-shm sizes sampled per save) — native writes bypass node:fs,
 * so WAL churn beyond the sampled peaks is not counted; within one
 * checkpoint-free window the WAL grows monotonically, so the peak equals the
 * cumulative append. No exact-byte pins: timestamps and WAL internals make
 * them flaky.
 */

process.env.BILI_PERSIST_ZSTD = "0";
// Hermeticity pin (same pattern as the other storage suites): pin BOTH tiers
// so every leg controls its own mode explicitly (absent defaults to full, #3818).
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-wa-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");
const DELTAS = 16;

/** Windows: an ephemeral stray handle must not fail CI — best-effort delete
 *  with bounded retries, swallowed on persistent EBUSY/EPERM. */
function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

function loadCorpusSession(): Session {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-wa-seed-"));
    try {
        fs.cpSync(path.join(CORPUS_ROOT, "folded"), path.join(seed, "folded"), { recursive: true });
        const loader = new SessionStore({ dir: path.join(seed, "folded"), debounceMs: 1, enabled: true });
        try {
            const loaded = loader.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
            assert.ok(loaded, "corpus loadSync returned null");
            assert.ok((loaded.lastMessages?.length ?? 0) > 0, "corpus case must carry a non-empty tail");
            return loaded;
        } finally {
            loader.cancelAll();
            loader.closeQuietly();
        }
    } finally {
        rmBestEffort(seed);
    }
}

function jsonFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, ent.name);
            if (ent.isDirectory()) walk(p);
            else if (ent.isFile() && p.endsWith(".json")) out.push(p);
        }
    };
    walk(dir);
    return out;
}

function jsonBytes(dir: string): number {
    return jsonFiles(dir).reduce((sum, p) => sum + fs.statSync(p).size, 0);
}

/** Peak-tracked footprint of the SQLite sidecar (native writes bypass
 *  node:fs, so this is a lower bound on true index-side bytes). */
function indexFootprint(dir: string): number {
    let sum = 0;
    for (const name of ["index.db", "index.db-wal", "index.db-shm"]) {
        try {
            sum += fs.statSync(path.join(dir, name)).size;
        } catch {
            /* absent = not created yet */
        }
    }
    return sum;
}

function engineAvailable(): boolean {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "bili-wa-probe-"));
    try {
        const opened = openSqliteDatabase(path.join(probe, "probe.db"));
        opened.db.close();
        return true;
    } catch {
        return false;
    } finally {
        rmBestEffort(probe);
    }
}

interface LegResult {
    jsonWritten: number;
    firstSize: number;
    lastSize: number;
    deltaBytes: number;
    indexPeak: number;
    ingests: number;
    jsonFileCount: number;
}

/** Pad the tail with filler messages so the persisted envelope reaches a
 *  production-scale size (the ordering pin needs to sit above the index
 *  page-frame crossover). The tail-token budget knob is raised in lockstep so
 *  boundedFoldedSnapshot keeps every padded message verbatim. */
const PAD_MESSAGE_BYTES = 50_000;
const PAD_MESSAGES = 16;
// No underscores: the knob parses with parseInt, which stops at "_" (would
// yield a 10-token budget and silently truncate every padded message).
const PAD_TAIL_TOKENS = "10000000";

async function runLeg(mode: "legacy" | "shadow" | "full-off", pad = false): Promise<LegResult> {
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    const prevWriter = process.env.BILI_STORAGE_JSON_WRITER;
    const prevTail = process.env.BILI_PERSIST_TAIL_TOKENS;
    process.env.BILI_STORAGE_UNIFIED = mode === "full-off" ? "full" : mode;
    if (mode === "full-off") process.env.BILI_STORAGE_JSON_WRITER = "off";
    else delete process.env.BILI_STORAGE_JSON_WRITER;
    if (pad) process.env.BILI_PERSIST_TAIL_TOKENS = PAD_TAIL_TOKENS;
    const session = loadCorpusSession();
    const seedTail = session.lastMessages as NonNullable<typeof session.lastMessages>;
    // #3050 R3: after each successful save the store rebinds session.lastMessages
    // to a fresh bounded-snapshot array, so deltas must be pushed onto the
    // CURRENT array (what a live request path would do), not a captured one.
    const tail = { push: (...msgs: typeof seedTail[number][]) => (session.lastMessages as typeof seedTail).push(...msgs) };
    if (pad) {
        // Identical filler text on purpose: the CAS stores it once, keeping
        // the index side cheap without touching the envelope size (which is
        // what the ordering pin measures). Copy the full message SHAPE from
        // the resident tail (role/contentType included): #3050 R3 drops the
        // resident records after each save and re-materializes them through
        // the store, which rejects shape-less stubs.
        for (let j = 1; j <= PAD_MESSAGES; j++) {
            tail.push({ ...seedTail[0], id: `wa-pad-${j}`, text: "x".repeat(PAD_MESSAGE_BYTES) });
        }
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bili-wa-${mode}-`));
    try {
        const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
        try {
            const sizes: number[] = [];
            let indexPeak = 0;
            for (let i = 1; i <= DELTAS; i++) {
                tail.push({ ...seedTail[0], id: `wa-delta-${i}`, text: `write-amplification delta ${i}` });
                await store.writeNow(session);
                sizes.push(jsonBytes(dir));
                indexPeak = Math.max(indexPeak, indexFootprint(dir));
            }
            const jsonWritten = sizes.reduce((a, b) => a + b, 0);
            // The first save is initial materialization, not a delta: deltas are
            // the growth from save 2 onward, and the rewrites they cost exclude
            // the first file.
            const deltaBytes = sizes[DELTAS - 1] - sizes[0];
            const shadow = (store as unknown as { shadow?: { stats: { ingests: number } } }).shadow;
            return {
                jsonWritten,
                firstSize: sizes[0],
                lastSize: sizes[DELTAS - 1],
                deltaBytes,
                indexPeak,
                ingests: shadow?.stats.ingests ?? 0,
                jsonFileCount: jsonFiles(dir).length,
            };
        } finally {
            store.cancelAll();
            store.closeQuietly();
        }
    } finally {
        process.env.BILI_STORAGE_UNIFIED = prevUnified;
        if (prevWriter === undefined) delete process.env.BILI_STORAGE_JSON_WRITER;
        else process.env.BILI_STORAGE_JSON_WRITER = prevWriter;
        if (prevTail === undefined) delete process.env.BILI_PERSIST_TAIL_TOKENS;
        else process.env.BILI_PERSIST_TAIL_TOKENS = prevTail;
        rmBestEffort(dir);
    }
}

test("legacy shape: every save rewrites the whole envelope (O(session size), not O(delta))", async () => {
    const r = await runLeg("legacy");
    assert.equal(r.jsonFileCount, 1, "exactly one envelope file");
    assert.ok(r.deltaBytes > 0, "deltas must actually grow the file");
    // Per-save fullness: total written sits near K x final file size — one
    // whole-file rewrite per save, no more (pathological duplication) and no
    // less (an unannounced partial-write optimization must update this pin).
    assert.ok(
        r.jsonWritten >= 0.5 * DELTAS * r.lastSize && r.jsonWritten <= 1.5 * DELTAS * r.lastSize,
        `per-save rewrite deviates from whole-file: wrote ${r.jsonWritten}B over ${DELTAS} saves ending at ${r.lastSize}B`,
    );
    // Amplification factor: bytes rewritten per byte actually changed. Whole-
    // file rewrites put this at ~session_size/delta_size (hundreds here);
    // incremental persistence collapses it toward 1 and MUST flip this assertion.
    const amp = (r.jsonWritten - r.firstSize) / r.deltaBytes;
    assert.ok(amp >= 10 && amp <= 100_000, `amplification factor ${amp.toFixed(1)}x outside the pinned whole-rewrite band [10, 100000]`);
    console.log(`[wa] legacy: ${r.jsonWritten - r.firstSize}B rewritten for ${r.deltaBytes}B changed (${amp.toFixed(0)}x)`);
});

test("mode ordering: index-only < legacy < shadow (composite envelope + index bytes)", async () => {
    if (!engineAvailable()) {
        console.log("[wa] SKIP mode ordering: no SQLite engine available in this environment");
        return;
    }
    const legacy = await runLeg("legacy", true);
    const off = await runLeg("full-off", true);
    const shadow = await runLeg("shadow", true);

    assert.ok(legacy.lastSize > 500_000, `padded session must be production-scale, saw ${legacy.lastSize}B`);
    assert.equal(off.jsonFileCount, 0, "jsonWriter=off must not write any envelope file");
    assert.ok(off.indexPeak > 0, "index-only leg must still maintain the index");
    assert.ok(
        off.ingests >= DELTAS,
        `index-only leg lost ingests: ${off.ingests} < ${DELTAS} (coalescing must not drop saves)`,
    );
    assert.ok(shadow.ingests >= DELTAS, `shadow leg lost ingests: ${shadow.ingests} < ${DELTAS}`);
    assert.ok(shadow.indexPeak > 0, "shadow leg must maintain the index mirror");
    assert.equal(shadow.jsonFileCount, 1, "shadow mode keeps writing the envelope");
    // Shadow must pay EXACTLY the legacy envelope cost — same builder, same
    // sizes; any drift means the sidecar changed what the file path persists.
    assert.ok(
        Math.abs(shadow.jsonWritten - legacy.jsonWritten) <= 0.05 * legacy.jsonWritten,
        `shadow envelope writes (${shadow.jsonWritten}B) drifted from legacy (${legacy.jsonWritten}B)`,
    );

    const composite = (r: LegResult): number => r.jsonWritten + r.indexPeak;
    assert.ok(
        composite(off) < composite(legacy),
        `index-only (${composite(off)}B) must cost less than legacy (${composite(legacy)}B)`,
    );
    assert.ok(
        composite(shadow) > composite(legacy),
        `shadow (${composite(shadow)}B) must cost MORE than legacy (${composite(legacy)}B) — it pays the envelope PLUS the mirror`,
    );
    console.log(
        `[wa] composites: index-only=${composite(off)}B legacy=${composite(legacy)}B shadow=${composite(shadow)}B`,
    );
});
