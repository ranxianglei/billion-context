/**
 * #5874 T9 — long-session growth curve (the #3752 unbounded-growth red line).
 *
 * The snapshot foundation must NOT grow a per-session artifact without bound.
 * The decisive mechanism: the CKPT cadence physically DELETES absorbed
 * snap_log entries (seq <= ckptSeq) — the event journal is a bounded ring,
 * not an append-only log. #3752's failure was exactly this: the legacy ledger
 * appended every turn and never shrank, so a long session's index grew
 * linearly forever.
 *
 * Over N turns the PHYSICAL snap_log depth must stay O(ckpt cadence) — a few
 * multiples of the cadence — NOT O(N). The row ledger is one row per pos
 * (the content mirror), bounded by the session's distinct elements, and its
 * inactive rows ride the block lifecycle (ruling B).
 *
 * Hermetic: a scratch UnifiedStore, no server, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UnifiedStore } from "../src/storage/store.ts";

const CKPT_EVERY_N = 8;
const N = 100;

test("T9: over 100 turns the physical snap_log depth stays O(ckpt cadence), not O(N)", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "t9-"));
    const dbPath = join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const sid = "t9";
    const now = Date.now();

    // Simulate the commit primitive's shape: every turn appends one row + one
    // log entry; every CKPT_EVERY_Nth turn a fold deactivates the oldest live
    // row and folds a ckpt (absorbing the log up to the frontier).
    for (let turn = 1; turn <= N; turn++) {
        const rows: Array<{ pos: number; coreIds: string; postJson: string; tokensEst: number; active: boolean; coverRef?: string | null }> = [
            { pos: turn, coreIds: JSON.stringify([`c${turn}`]), postJson: JSON.stringify([{ id: `c${turn}`, role: "user", contentType: "text", text: `turn ${turn} ${"x".repeat(64)}` }]), tokensEst: 8, active: true, coverRef: null },
        ];
        const logEntries: Array<{ kind: string; payload: string; createdAt: number }> = [
            { kind: turn === 1 ? "cast" : "append", payload: JSON.stringify({ pos: turn }), createdAt: now },
        ];
        let ckpt;
        if (turn % CKPT_EVERY_N === 0) {
            const oldest = 1;
            rows.push({ pos: oldest, coreIds: JSON.stringify([`c${oldest}`]), postJson: JSON.stringify([{ id: `c${oldest}`, role: "user", contentType: "text", text: `turn ${oldest} ${"x".repeat(64)}` }]), tokensEst: 8, active: false, coverRef: `blk-${turn}` });
            logEntries.push({ kind: "compact", payload: JSON.stringify({ pos: oldest, blockId: `blk-${turn}` }), createdAt: now });
            ckpt = { ckptSeq: turn, metaJson: JSON.stringify({ v: 1, kernelState: {}, stateChecksum: "g", coverage: { [String(oldest)]: { lo: oldest, hi: oldest, blockId: `blk-${turn}` } }, s4: "g" }), checksum: "g", updatedAt: now };
        }
        store.commitSnapshot({ sessionId: sid, rows, logEntries, ...(ckpt ? { ckpt } : {}), now });
    }

    // No lost events: the committed frontier reaches N.
    const frontier = store.snapLogMaxSeq(sid);
    assert.ok(frontier >= N, `frontier ${frontier} must reach ${N} (no lost events)`);

    // The decisive #3752 assertion: the PHYSICAL snap_log depth is bounded by
    // the ckpt cadence, not by N. The last ckpt fired at turn 96 and absorbed
    // every entry with seq <= 96, so only turns 97..100 remain in the ring.
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    let logDepth = -1;
    let rowTotal = -1;
    try {
        logDepth = (raw.prepare("SELECT COUNT(*) AS n FROM snap_log WHERE sid = ?").get(sid) as { n: number }).n;
        rowTotal = (raw.prepare("SELECT COUNT(*) AS n FROM snap_rows WHERE sid = ?").get(sid) as { n: number }).n;
    } finally {
        raw.close();
    }
    const bound = CKPT_EVERY_N * 3; // generous: a few events per turn since the last ckpt
    assert.ok(logDepth <= bound, `physical snap_log depth ${logDepth} must stay <= ${bound} (bounded ring), not grow with N=${N}`);
    // The row ledger is one row per distinct pos (+ fold re-covers): never more
    // than N + number of folds.
    assert.ok(rowTotal <= N + Math.ceil(N / CKPT_EVERY_N), `row count ${rowTotal} must be <= N + folds`);

    // A linear (unbounded) log would have ~N + N/8 entries still present.
    assert.ok(logDepth < N / 2, `log depth ${logDepth} must be sublinear in N=${N}`);
});
