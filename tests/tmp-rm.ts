import { rmSync } from "node:fs";

// #1646: bare recursive rmSync throws ENOTEMPTY on loaded CI runners when a
// spawned child recreates entries between readdir and rmdir. The delete may
// only re-run on the transient set Node's rimraf retries
// (ENOTEMPTY/EACCES/EPERM/EMFILE/EBUSY); anything else must surface.
//
// #1910 follow-up: a flat 10×50ms budget (~500ms) still lost the race on the
// ubuntu-22 release-gate leg — the failing suite's late debounced session
// flush (5ms debounce recreating <tmp>/<provider>/) kept the tree alive past
// every retry under full-suite load. Escalate with exponential backoff so
// teardown can always outlive a bounded writer burst; the ladder below sums
// the full window and is only paid when a race actually happens.
//
// #2908: #2816's c=4 concurrent test scheduling raised per-runner load, and a
// win-latest leg then lost the race on EBUSY unlinking sessions/index.db — a
// transient Windows AV/indexer lock outlasting the old ~3.2s window (#2799
// family). A probe confirmed the harness holds NO self-handle at rmrf time
// (flushAllSessions closes the store's shadow first), so this is not masking
// an in-process leak: it re-sizes the external-lock budget to the c=4 reality.
//
// #4046 CI lane (win22-1 @ a46fd0d1a): the #2771 corrupt-index proof then
// spent the full ~9.6s ladder on EBUSY unlinking index.db — the same
// external-lock family with a longer-lived lock under shard load; extend the
// flat tail rather than the exponential front (the early rungs exist to win
// cheap races without paying for the slow ones).
const RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1600, 3200, 3200, 3200, 3200] as const;

/** Sync sleep that is legal on any thread in Node (blocks the event loop —
 * exactly what a teardown-path retry wants; no pending I/O ordering to keep). */
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const defaultRm = (target: string | URL): void =>
    rmSync(target, { recursive: true, force: true });

// Test seam (#1915 review): an in-process writer cannot interleave with the
// synchronous delete (one event loop), so tmp-rm.test.ts drives the retry
// loop through here instead of staging a fake race. The real #1910 racer is
// cross-process (a spawned lane's debounced persist flush).
let rmImpl: typeof defaultRm = defaultRm;
export function _setRmImplForTest(impl?: typeof defaultRm): void {
    rmImpl = impl ?? defaultRm;
}

export function rmrf(target: string | URL): void {
    let attempt = 0;
    for (;;) {
        try {
            rmImpl(target);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            const transient =
                code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM" ||
                code === "EACCES" || code === "EMFILE";
            if (!transient || attempt >= RETRY_DELAYS_MS.length) throw err;
            sleepSync(RETRY_DELAYS_MS[attempt++]);
        }
    }
}
