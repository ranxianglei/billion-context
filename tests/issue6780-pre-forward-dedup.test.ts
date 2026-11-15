import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { snapshotMessages, type Session } from "../src/session.ts";
import type { CoreMessage } from "acp-kernel";

/**
 * #6780 P0: with the pure-SQLite default (#6480, JSON writer off) the prepare
 * phase runs TWO full unified-index ingests per turn BEFORE the model call —
 * the synchronous durability ingest (#6326, ingestRowsNow) and the coalesced
 * writer-off save armed by prepare's own markDirty (5a80e2b8 removed the
 * debounce on this lane). The second one is a no-op delta (the watermark was
 * already advanced) that still pays the three-table full reads, the
 * whole-record re-serialization and a second commit round-trip — ~1.3s of
 * #6780's pre-forward cost on the reporter's 23k-message session.
 *
 * Pinned here (writer-off mode, exactly what the prepare phase does):
 *   1. When nothing changed between ingestRowsNow and the coalesced build,
 *      the build SKIPS the heavy legs — the sidecar record() is not called a
 *      second time — but the settle protocol still lands (lastSaveLanded).
 *   2. When the state DID change after the arm (re-snapshot + markDirty),
 *      the full build still runs — the arm is a hint, never a commitment.
 *   3. (review F6) A lastMessages re-snapshot ALONE (no kernel mutation, one
 *      markDirty) defeats the skip — isolating the ref-swap gate condition.
 *   4. (review F1) A fold-turn ledger align consumed during scheduleSave
 *      restamps refs AFTER the arm; the coalesced build must take the full
 *      path (the #4733 same-record invariant), i.e. the align path consumes
 *      the arm.
 *   5. (review F2) The arm is single-shot: once the coalesced build has made
 *      its decision, a LATER standalone markDirty must not be able to skip on
 *      the stale arm.
 */

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: pin BOTH tiers so every
// leg controls its own mode explicitly (absent now defaults to full, #3818).
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6780-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "golden/storage-corpus");

function loadCorpusCase(dir: string, name: string, id: string, protocol: string) {
    fs.cpSync(path.join(CORPUS_ROOT, name), path.join(dir, name), { recursive: true });
    const loader = new SessionStore({ dir: path.join(dir, name), debounceMs: 1, enabled: true });
    const loaded = loader.loadSync(id, { protocol, upstreamOrigin: "http://127.0.0.1:8199" });
    loader.cancelAll();
    loader.closeQuietly();
    assert.ok(loaded, `${name}: corpus loadSync returned null`);
    return loaded as Session;
}

/** Windows: an ephemeral stray handle must not fail CI — best-effort delete
 *  with bounded retries, swallowed on persistent EBUSY/EPERM. */
function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

type Count = () => number;

interface Harness {
    session: Session;
    /** The synchronous pre-forward durability ingest (prepare phase step). */
    ingestRowsNow: () => void;
    /** Arm the sidecar record() spy (call right after the first
     *  ingestRowsNow). Returns the ingest counter. */
    spy: () => Count;
    /** Bump the epoch exactly like session.ts markDirty does and schedule the
     *  save (calling session.markDirty would hit the module-singleton store,
     *  not the harness store). */
    markDirty: () => void;
    /** The writer-off lane's scheduleSave without an epoch bump (e.g. the
     *  incremental-lane close-out shape). */
    scheduleSave: () => void;
    lastSaveLanded: Map<string, boolean>;
    /** Let the coalesced microtask run. */
    settle: () => Promise<void>;
}

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    const prevWriter = process.env.BILI_STORAGE_JSON_WRITER;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_STORAGE_JSON_WRITER = "off"; // no envelope — the writer-off coalesced lane
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6780-seed-"));
    const session = loadCorpusCase(seed, "folded", "corpus-folded", "anthropic");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6780-dedup-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 60_000, enabled: true });
        const anyStore = store as unknown as {
            shadow: { record: (...args: unknown[]) => unknown };
            scheduleSave: (s: Session) => void;
            lastSaveLanded: Map<string, boolean>;
            ingestRowsNow: (s: Session) => void;
        };
        let ingests = 0;
        const harness: Harness = {
            session,
            ingestRowsNow: () => anyStore.ingestRowsNow(session),
            spy: () => {
                const real = anyStore.shadow.record.bind(anyStore.shadow);
                anyStore.shadow.record = (...args: unknown[]) => { ingests++; return real(...args); };
                return () => ingests;
            },
            markDirty: () => {
                session.revisionEpoch = (session.revisionEpoch ?? 0) + 1;
                anyStore.scheduleSave(session);
            },
            scheduleSave: () => anyStore.scheduleSave(session),
            lastSaveLanded: anyStore.lastSaveLanded,
            settle: () => new Promise((r) => setTimeout(r, 50)),
        };
        await run(harness);
        store.cancelAll();
        store.closeQuietly();
    } finally {
        rmBestEffort(dir);
        rmBestEffort(seed);
        process.env.BILI_STORAGE_UNIFIED = prevUnified;
        process.env.BILI_STORAGE_JSON_WRITER = prevWriter;
    }
}

test("#6780 P0: the writer-off coalesced save skips the duplicate ingest when ingestRowsNow already covered this tick's state", async () => {
    await withHarness(async ({ session, ingestRowsNow, spy, markDirty, lastSaveLanded, settle }) => {
        // Exactly what the prepare phase does before the model call: the
        // synchronous durability ingest, then the plain markDirty.
        ingestRowsNow();
        const ingests = spy();

        markDirty();
        await settle();
        assert.equal(ingests(), 0, "state unchanged since ingestRowsNow — the coalesced save must NOT re-run the full rebuild + full delta-ingest");
        assert.equal(lastSaveLanded.get(session.id), true, "the settle protocol must still land on the skip path");

        // Counterfactual: the state changes AFTER the arm (a re-snapshot
        // swaps lastMessages without bumping the epoch; the follow-up
        // markDirty bumps it) → the full build must still run.
        snapshotMessages(session, [...(session.lastMessages ?? []), { id: "m-dedup-probe", role: "user", contentType: "text", text: "probe" } as unknown as CoreMessage]);
        markDirty();
        await settle();
        assert.equal(ingests(), 1, "a changed state must still take the full build (the arm never commits)");
    });
});

test("#6780 P0 (F6): a lastMessages re-snapshot alone (single markDirty) defeats the skip", async () => {
    await withHarness(async ({ session, ingestRowsNow, spy, markDirty, settle }) => {
        ingestRowsNow();
        const ingests = spy();

        // A fresh client request re-snapshots the raw messages: a NEW array
        // reference, no kernel mutation, no epoch bump — then only
        // prepare's own markDirty. The ref-swap condition must alone force
        // the full build (epoch is exactly armed.epoch + 1, so every other
        // gate condition passes).
        snapshotMessages(session, [...(session.lastMessages ?? []), { id: "m-ref-swap", role: "user", contentType: "text", text: "ref swap" } as unknown as CoreMessage]);
        markDirty();
        await settle();
        assert.equal(ingests(), 1, "a re-snapshotted lastMessages (same epoch delta) must take the full build");
    });
});

test("#6780 P0 (F1): a fold-turn ledger align consumed during scheduleSave forces the full build", async () => {
    await withHarness(async ({ session, ingestRowsNow, spy, markDirty, lastSaveLanded, settle }) => {
        ingestRowsNow();
        const ingests = spy();

        // A fold commit between the previous save and this prepare set the
        // align flag. ingestRowsNow does NOT consume it — scheduleSave's
        // entry does, and the restamp mutates state (ref renumbering + CCR
        // re-key) AFTER the arm was set.
        session.pendingLedgerAlign = true;
        markDirty();
        await settle();
        assert.equal(ingests(), 1, "the restamped state must take the full build — the align path consumes the arm (the #4733 same-record invariant)");
        assert.equal(lastSaveLanded.get(session.id), true, "the settle protocol must land on the forced full build");
        assert.equal(session.pendingLedgerAlign, undefined, "the align flag is consumed exactly once");
    });
});

test("#6780 P0 (F2): the arm is single-shot — a later standalone markDirty cannot skip on the consumed arm", async () => {
    await withHarness(async ({ session, ingestRowsNow, spy, markDirty, scheduleSave, settle }) => {
        ingestRowsNow(); // arms at epoch E
        const ingests = spy();

        // A scheduleSave WITHOUT the epoch bump (the incremental-lane
        // close-out shape): the gate fails (E !== E + 1) → full build, and
        // the arm is consumed by this run's decision.
        scheduleSave();
        await settle();
        assert.equal(ingests(), 1, "epoch unchanged since the arm → full build");

        // Now a single non-metadata mutation + markDirty reaches E+1 — the
        // OLD (never-consumed) arm would match the whole gate and wrongly
        // skip this one. The single-shot arm must not allow that.
        session.stats.outputTokens += 1;
        markDirty();
        await settle();
        assert.equal(ingests(), 2, "a stale arm must not justify skipping a save it never covered");
    });
});
