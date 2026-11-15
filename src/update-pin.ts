// #6804: per-machine version pin — a user-intent "hold" on the installed
// version that makes the auto-updater check-only (report but never install).
// Distinct from the #3619 remote policy `pinned` (a fleet-wide upgrade
// ceiling): this is local, per-machine, and survives config edits because it
// is runtime state, not a config key (Configuration Surface Discipline).
//
// The #1481 critical-bug advisory force-install lane still overrides a local
// pin (owner-directed repair wins over user convenience) — the advisory
// watcher calls forceInstallVersion directly, bypassing checkForUpdate.
//
// State file: ~/.cache/billion-context/.pin.json
//   { v: 1, version: "0.1.215", setAt: 1700000000000, until?: 1700086400000 }
// `until` absent = indefinite (forever). The pin lifts itself at expiry.

import { readFile, writeFile, mkdir, rm, rename } from "node:fs/promises";
import path from "node:path";
import { cacheDir } from "./paths.js";

export interface PinState {
    v: 1;
    version: string;
    setAt: number;
    until?: number;
}

const PIN_FILE = path.join(cacheDir(), ".pin.json");

/** Parse a duration string ("1h", "12h", "1d", "7d") into milliseconds.
 *  Returns undefined for unrecognized input. "forever" is handled by the
 *  caller (no `until` field). */
export function parsePinDuration(s: string): number | undefined {
    const match = s.trim().match(/^(\d+)\s*([hd])$/i);
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    const unit = match[2].toLowerCase();
    if (unit === "h") return amount * 60 * 60 * 1000;
    return amount * 24 * 60 * 60 * 1000; // "d"
}

/** Best-effort read. `undefined` = absent or unreadable/corrupt. */
export async function readPin(): Promise<PinState | undefined> {
    try {
        const raw = await readFile(PIN_FILE, "utf-8");
        const doc = JSON.parse(raw) as PinState;
        if (!doc || typeof doc !== "object" || doc.v !== 1) return undefined;
        if (typeof doc.version !== "string" || doc.version.length === 0) return undefined;
        if (typeof doc.setAt !== "number" || !Number.isFinite(doc.setAt)) return undefined;
        if (doc.until !== undefined && (typeof doc.until !== "number" || !Number.isFinite(doc.until))) return undefined;
        return doc;
    } catch {
        return undefined;
    }
}

/** Write the pin state atomically (tmp+rename). Never rejects — an
 *  unwritable cache dir degrades to no-op (the pin simply doesn't persist). */
export async function writePin(pin: PinState): Promise<void> {
    try {
        await mkdir(path.dirname(PIN_FILE), { recursive: true });
        const tmp = `${PIN_FILE}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(pin), "utf-8");
        await rename(tmp, PIN_FILE);
    } catch {
        // best-effort: unwritable cache dir → pin not persisted
    }
}

/** Clear the pin state (remove the file). Never rejects. */
export async function clearPin(): Promise<void> {
    try {
        await rm(PIN_FILE, { force: true });
    } catch {
        // best-effort
    }
}

/** Return the active pin (or undefined if absent or expired). */
export async function activePin(): Promise<PinState | undefined> {
    const pin = await readPin();
    if (!pin) return undefined;
    if (pin.until !== undefined && Date.now() > pin.until) return undefined;
    return pin;
}

/** Check if the given version is currently pinned (version matches and the
 *  pin has not expired). */
export async function isVersionPinned(version: string): Promise<boolean> {
    const pin = await activePin();
    if (!pin) return false;
    return pin.version === version;
}

/** Set a pin for the given version. `durationMs` undefined = indefinite.
 *  Returns the pin state that was written. */
export async function setPin(version: string, durationMs?: number): Promise<PinState> {
    const now = Date.now();
    const pin: PinState = { v: 1, version, setAt: now };
    if (durationMs !== undefined) {
        pin.until = now + durationMs;
    }
    await writePin(pin);
    return pin;
}

/** Test-only: remove the pin state file. */
export async function _resetPinForTest(): Promise<void> {
    await rm(PIN_FILE, { force: true });
}
