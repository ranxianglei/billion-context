/**
 * #5188/#5140 open-side — re-pinned to the FINAL owner policy (2026-10-30).
 *
 * Master's original story ("a first synchronous open that dies on a transient
 * OS error degrades the process to legacy-only, then the demand-driven reopen
 * heals it without a restart") was superseded twice over: round 3 says ANY
 * failed open at boot makes bili REFUSE TO START loudly (silent lifetime
 * degradation of any kind is withdrawn), and round 5 says a proven-corrupt
 * index alarms and boots WITHOUT the index, with an operator hand-fix — never
 * moved, copied or rebuilt automatically. So in the sqlite world a live
 * process no longer ever sits in "sidecar wanted but missing because of a
 * transient open failure": the two reachable no-sidecar states are the
 * intentional opt-outs (legacy/persist-off/encryption) and the proven-corrupt
 * alarm. The reopen machinery survives as the defensive net behind
 * tryRecoverSidecar()'s new catch (its docstring explains why), plus the
 * mysql async-attach path — and this suite pins the two policy edges around
 * it instead of the retired heal story:
 *   1. an unlucky FIRST open (no engine available) refuses to start:
 *      construction throws, the pre-death status wire names the cause, no
 *      index.db debris is left behind;
 *   2. a proven-corrupt index alarms ONCE per boot and the demand-driven
 *      reopen hooks respect the integrity flag — no re-scan storm, no second
 *      alarm, replicas stay honestly unavailable, while envelope service
 *      continues.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, setShadowReopenCooldownMsForTests, setShadowReopenReadCheckMsForTests } from "../src/persist.ts";
import { UnifiedShadow, hadIntegrityQuickCheckFailure } from "../src/storage/shadow.ts";
import { setSqliteEnginesUnavailableForTests } from "../src/storage/driver.ts";
import { _resetStorageRuntimeStatusForTest, storageStatusWire } from "../src/storage/runtime-status.ts";
import { setLogCapture } from "../src/logger.ts";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.js";

const HERMETIC = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5188-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(HERMETIC, "no-config.json");
delete process.env.BILI_STORAGE_UNIFIED;
delete process.env.BILI_ENCRYPTION_KEY;

function mkSess(id = "rec-s1"): Session {
    return { id, meta: { protocol: "anthropic" }, metadata: {}, stats: { requests: 1 }, state: createInitialState() } as unknown as Session;
}

test("an unlucky FIRST open (no engine) refuses to start — loud throw, wire names the cause (#5188 final)", () => {
    const dir = fs.mkdtempSync(path.join(HERMETIC, "bootrefuse-"));
    _resetStorageRuntimeStatusForTest();
    setSqliteEnginesUnavailableForTests(true);
    try {
        assert.throws(
            () => new SessionStore({ dir, enabled: true }),
            /no SQLite engine available/i,
            "round-3 policy: a failed first open is a refusal to start, not a silent lifetime degradation",
        );
        const wire = storageStatusWire();
        assert.equal(wire.degraded, true, "the pre-death diagnostic surface still reports it");
        assert.match(String(wire.reason), /SQLite engine/i, "the wire names the missing engine as the cause");
        assert.ok(!fs.existsSync(path.join(dir, "index.db")), "a refused boot leaves no index.db debris");
    } finally {
        setSqliteEnginesUnavailableForTests(false);
    }
});

test("a proven-corrupt index alarms ONCE and the reopen hooks never re-scan it (#5188 guard)", () => {
    const dir = fs.mkdtempSync(path.join(HERMETIC, "corrupt-"));
    _resetStorageRuntimeStatusForTest();
    // Build a valid index, close it, then truncate it past its midpoint —
    // the canonical quick_check-provable corruption from the #4816 family.
    let s1: SessionStore | undefined;
    try {
        s1 = new SessionStore({ dir, debounceMs: 1, enabled: true });
        s1!.loadSync("corpus-folded", { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
    } finally {
        s1?.closeQuietly();
    }
    const idx = path.join(dir, "index.db");
    const sz = fs.statSync(idx).size;
    const fd = fs.openSync(idx, "r+");
    fs.ftruncateSync(fd, Math.floor(sz / 2));
    fs.closeSync(fd);

    const errors: string[] = [];
    setLogCapture((level, msg) => { if (level === "error") errors.push(String(msg)); });
    const alarms = () => errors.filter((m) => m.includes("FAILED its integrity quick_check")).length;
    const store: SessionStore | undefined = (() => {
        // Direct probe: the alarm fires and the integrity latch trips.
        const sh = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "full" }, () => null);
        assert.equal(sh, null, "proven-corrupt index comes back as 'no sidecar'");
        assert.equal(hadIntegrityQuickCheckFailure(), true, "integrity latch tripped");
        // Now the actual boot: fresh in-boot scan (every boot decides from
        // fresh evidence), ONE more alarm, then the process runs anyway.
        return new SessionStore({ dir, debounceMs: 1, enabled: true });
    })();
    try {
        assert.ok(store !== undefined, "round-5 policy: boot proceeds envelope-served");
        const atBoot = alarms();
        assert.ok(atBoot >= 1, "the boot's own scan alarmed");
        // Demand-driven reopen hooks, unthrottled: every single read asks
        // "are replicas available?" and every save would ask again. Without
        // the integrity guard each of them would re-open, re-run quick_check
        // against the same broken bytes and re-alarm — a permanent log storm
        // with zero chance of success (only an operator hand-fix helps).
        setShadowReopenCooldownMsForTests(0);
        setShadowReopenReadCheckMsForTests(0);
        for (let i = 0; i < 6; i++) {
            assert.equal(store!.replicasAvailable(), false, `replicas honestly unavailable on attempt ${i}`);
        }
        store!.flushSync(mkSess("r5188-guard"));
        assert.equal(alarms(), atBoot, "no re-scan storm: the boot-time alarm stands alone");
        const wire = storageStatusWire();
        assert.match(String(wire.reason ?? ""), /left UNTOUCHED/i, "the wire keeps naming the manual fix");
    } finally {
        setShadowReopenCooldownMsForTests(null);
        setShadowReopenReadCheckMsForTests(null);
        setLogCapture(null);
        store?.closeQuietly();
    }
});
