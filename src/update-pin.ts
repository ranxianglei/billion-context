/**
 * Local version pin (#6804): per-machine user intent to HOLD the installed
 * version. While a pin is live the auto-updater keeps CHECKING for newer
 * versions and reporting them (panel state, log, `bili update` output) but
 * never auto-installs; an explicit `bili update` (force) still goes through
 * and clears the pin on success.
 *
 * State lives in the cache dir (`.pin.json`) alongside the other updater
 * state files (throttle, stagger, backoff, last-install): a pin is runtime
 * STATE, not a config key (Configuration Surface Discipline), and its
 * per-machine scope is exactly right — the fleet-wide upgrade ceiling is the
 * #3619 remote policy `pinned`, a different feature with a different owner.
 *
 * Import-leaf discipline: this module touches only fs + paths + duration, so
 * update.ts / cli.ts / server/update-actions.ts can all consume it without a
 * cycle. Reads NEVER throw (absent/corrupt file = no pin — fail-open, like
 * every other updater state file); writes surface real fs errors to the
 * caller so the CLI/panel can say what failed.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheDir } from "./paths.js";
import { parseDurationField } from "./duration.js";

/** #7806: where a held version came from. Only set by `bili install <ref>`
 *  (a source build from a git ref) so the panel/status can say WHAT is
 *  installed, not just that it is held. Absent on manual pins. */
export interface PinSource {
    kind: "git";
    /** The git ref spec the build came from (branch, tag, or pull/N/head). */
    ref: string;
    /** The exact commit that was installed. */
    sha: string;
}

export interface PinRecord {
    v: 1;
    /** The installed version being held in place. */
    version: string;
    /** Epoch ms when the pin was set. */
    setAt: number;
    /** Epoch ms when the pin expires and auto-upgrade resumes; absent =
     *  held until cleared manually (`bili unpin`). */
    until?: number;
    /** #7806: provenance for `bili install` pins (absent on manual pins). */
    source?: PinSource;
}

const PIN_FILE_NAME = ".pin.json";

/** Machine-level pin file path (per cache dir, next to the throttle file). */
export function pinFilePath(): string {
    return path.join(cacheDir(), PIN_FILE_NAME);
}

/** Read + shape-check the pin file. Absent/unreadable/corrupt/unshaped =
 *  undefined; the file is left in place (never destroy user state on a read). */
export async function readPin(): Promise<PinRecord | undefined> {
    try {
        const raw = await readFile(pinFilePath(), "utf-8");
        const doc = JSON.parse(raw) as { v?: unknown; version?: unknown; setAt?: unknown; until?: unknown; source?: unknown };
        if (doc && doc.v === 1 && typeof doc.version === "string" && doc.version.length > 0 && typeof doc.setAt === "number" && Number.isFinite(doc.setAt)) {
            const pin: PinRecord = { v: 1, version: doc.version, setAt: doc.setAt };
            if (typeof doc.until === "number" && Number.isFinite(doc.until) && doc.until > doc.setAt) pin.until = doc.until;
            // #7806: keep provenance when it is well-shaped; a malformed
            // source is dropped (the pin itself stays valid).
            const src = doc.source as { kind?: unknown; ref?: unknown; sha?: unknown } | undefined;
            if (src && src.kind === "git" && typeof src.ref === "string" && src.ref.length > 0 && typeof src.sha === "string" && /^[0-9a-f]{7,40}$/i.test(src.sha)) {
                pin.source = { kind: "git", ref: src.ref, sha: src.sha };
            }
            return pin;
        }
        return undefined;
    } catch {
        return undefined; // absent or unreadable = no pin
    }
}

/** Persist a pin (creates the cache dir when missing). Throws on real fs
 *  errors — the CLI/panel caller decides how to surface them. */
export async function writePin(pin: PinRecord): Promise<void> {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(pinFilePath(), JSON.stringify(pin, null, 1) + "\n", "utf-8");
}

/** Remove the pin file; `true` when a file was actually present. */
export async function clearPin(): Promise<boolean> {
    const p = pinFilePath();
    try {
        await stat(p);
    } catch {
        return false;
    }
    await rm(p, { force: true });
    return true;
}

type PinState =
    | { kind: "none" }
    | { kind: "active"; pin: PinRecord }
    | { kind: "expired"; pin: PinRecord }
    | { kind: "stale"; pin: PinRecord };

/** Resolve the on-disk pin against the installed version. Self-sweeping: an
 *  EXPIRED or STALE record (version mismatch) is deleted on the spot so the
 *  next cycle starts clean. When `installedVersion` is undetectable the file
 *  is left alone and the answer is "none" — never destroy state we can't
 *  verify. */
export async function resolvePinState(installedVersion: string | undefined, now: number = Date.now()): Promise<PinState> {
    const pin = await readPin();
    if (!pin) return { kind: "none" };
    if (installedVersion === undefined) return { kind: "none" };
    if (pin.version !== installedVersion) {
        await clearPin();
        return { kind: "stale", pin };
    }
    if (pin.until !== undefined && now >= pin.until) {
        await clearPin();
        return { kind: "expired", pin };
    }
    return { kind: "active", pin };
}

/** Parse a pin-duration argument. ""/undefined/"forever" = indefinite pin;
 *  otherwise a #3619-style duration ("1h", "12h", "1d12h", "7d"). Anything
 *  else (zero, garbage) is an error — never guess a hold time. */
export function parsePinDuration(text: string | undefined): { ms?: number } | { error: string } {
    const t = (text ?? "").trim().toLowerCase();
    if (t === "" || t === "forever") return {};
    const ms = parseDurationField(t);
    if (ms === undefined || ms <= 0) {
        return { error: `invalid pin duration "${text ?? ""}" (examples: 1h, 12h, 1d, 7d, forever)` };
    }
    return { ms };
}

/** One-line human expiry for logs/panel: "indefinite" or "until <iso>". */
export function formatPinUntil(pin: Pick<PinRecord, "until">): string {
    return pin.until === undefined ? "indefinite" : `until ${new Date(pin.until).toISOString()}`;
}
