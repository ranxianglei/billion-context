// #5757 review fix: unified-store flushes await sqlite; a wedged volume must
// not hold a graceful exit (or a restart hand-over) hostage forever. The
// pre-migration world flushed to files synchronously and always returned.
// The in-memory view plus whatever landed already is the documented fallback
// on timeout (next boot re-hydrates).
//
// This helper lives in its own module ON PURPOSE: src/restart.ts must not be
// an import target of src/server.ts (withExitDeadline used to be exported
// from restart.js). That edge dragged restart.ts into the STATIC import
// phase of every server consumer — tests/auto-restart.test.ts relies on
// restart.ts being evaluated by its DYNAMIC import, AFTER the test re-points
// XDG_CACHE_HOME, because MARKER_FILE is frozen at module load ("MARKER_FILE
// is frozen at module load", auto-restart.test.ts top comment). Evaluating
// restart.ts during the statics froze MARKER_FILE under the preload root and
// broke the marker round-trip tests.
import { log } from "./logger.js";

export const EXIT_FLUSH_DEADLINE_MS = 5000;

/**
 * Await `op` but never longer than EXIT_FLUSH_DEADLINE_MS. On deadline the
 * warning fires and we proceed anyway (the caller is about to call
 * process.exit() / spawn the replacement); an `op` rejection is logged the
 * same way. The timer is unref'd so it never holds the loop open.
 */
export function withExitDeadline(label: string, op: Promise<unknown>): Promise<void> {
    return new Promise<void>((resolve) => {
        let settled = false;
        const t = setTimeout(() => {
            if (settled) return;
            settled = true;
            log("warn", `[restart] ${label} still pending after ${EXIT_FLUSH_DEADLINE_MS}ms — proceeding`);
            resolve();
        }, EXIT_FLUSH_DEADLINE_MS);
        t.unref?.();
        void Promise.resolve(op)
            .catch((err) => log("warn", `[restart] ${label} failed: ${err instanceof Error ? err.message : String(err)}`))
            .then(() => {
                if (settled) return;
                settled = true;
                clearTimeout(t);
                resolve();
            });
    });
}
