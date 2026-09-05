/**
 * Layer 2 of the #362 fix: watch the acp-kernel StateStore `log` callback for
 * repeated write failures on one session id and emit a single actionable
 * "add this dir to Defender exclusions" alert.
 *
 * The log callback is the ONLY place that sees a hot-path failure: `scheduleSave`
 * (debounced) is swallowed internally by the kernel, so its sole failure signal
 * is this log line. We depend on its format (acp-kernel 0.0.47):
 *   [persist] write failed for <id> (total <N>x): <err>; data spilled to <rel>
 * `<N>` is the kernel's per-id CONSECUTIVE failure count (reset on any success).
 * We read it directly rather than counting lines: the kernel rate-limits these
 * logs (N = 1, 2, 4, 8, …), so a line count would under-count and see a fresh
 * "id" every line. The Defender/OneDrive wording lives here, not in the generic
 * kernel, because it is Windows/billion-context specific.
 */
import { log as loggerLog } from "./logger.js";

const LOCK_CODES = /\b(EPERM|EBUSY|EACCES)\b/;

// Non-greedy id capture up to " (total ": ids are client-provided verbatim
// (no " (total " substring), and the count is the kernel's consecutive total.
const WRITE_FAIL_RE = /^\[persist\] write failed for (.+?) \(total (\d+)x\): (.+)$/;

export type PersistEpermAlertOptions = {
    dir: string;
    threshold?: number;
    repeatMs?: number;
    platform?: NodeJS.Platform;
    now?: () => number;
    onAlert?: (dir: string, count: number) => void;
};

export class PersistEpermAlert {
    private readonly dir: string;
    private readonly threshold: number;
    private readonly repeatMs: number;
    private readonly platform: NodeJS.Platform;
    private readonly now: () => number;
    private readonly onAlert: (dir: string, count: number) => void;
    private hasAlerted = false;
    private alertedAt = 0;

    constructor(opts: PersistEpermAlertOptions) {
        this.dir = opts.dir;
        // threshold: kernel-reported consecutive failures on one id before alerting (default 5).
        // repeatMs: 0 = alert once then silent; >0 = re-alert at most every repeatMs.
        this.threshold = opts.threshold ?? 5;
        this.repeatMs = opts.repeatMs ?? 0;
        this.platform = opts.platform ?? process.platform;
        this.now = opts.now ?? Date.now;
        this.onAlert = opts.onAlert ?? ((d, c) => loggerLog("warn", buildAlertMessage(d, c)));
    }

    // Returns true iff an alert was emitted. Runs on every kernel log line, so
    // the non-matching cases bail before any allocation.
    observe(level: string, msg: string): boolean {
        if (this.platform !== "win32") return false;
        if (level !== "error" && level !== "warn") return false;
        const m = WRITE_FAIL_RE.exec(msg);
        if (!m) return false;
        const count = Number(m[2]);
        if (count < this.threshold) return false;
        if (!LOCK_CODES.test(m[3])) return false;
        if (!this.shouldAlert()) return false;
        this.hasAlerted = true;
        this.alertedAt = this.now();
        this.onAlert(this.dir, count);
        return true;
    }

    private shouldAlert(): boolean {
        if (!this.hasAlerted) return true;
        if (this.repeatMs <= 0) return false;
        return this.now() - this.alertedAt >= this.repeatMs;
    }
}

export function buildAlertMessage(dir: string, count: number): string {
    return [
        `[persist] session dir ${dir} failed ${count} consecutive writes (EPERM — rename is locked).`,
        "Likely cause: Windows Defender / antivirus / indexer / a sync tool is locking the directory.",
        `Fix: add ${dir} to Windows Defender exclusions (Settings → Virus & threat protection → Manage settings → Exclusions → Add an exclusion),`,
        "and make sure no OneDrive / sync tool is syncing this path.",
    ].join("\n");
}
