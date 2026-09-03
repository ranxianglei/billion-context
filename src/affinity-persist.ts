import fs from "node:fs";
import path from "node:path";
import { prefixAffinity } from "./prefix-affinity.js";
import { stateDir } from "./paths.js";
import { log } from "./logger.js";

/**
 * #499 P1a: prefix-affinity persistence. The anonymous affinity chains were
 * pure in-memory (#309), so a proxy restart orphaned every anonymous session:
 * the next replay forked a fresh session with zero compression state and
 * resent the raw history (#351 — 458K tokens, 0% cache). The chains are
 * small (≤256 sessions × ≤128 hashes); persist them to the state dir with a
 * debounced atomic write and hydrate on boot.
 */

const PERSIST_DEBOUNCE_MS = 5_000;

function affinityFile(): string {
    return path.join(stateDir(), "prefix-affinity.json");
}

let timer: NodeJS.Timeout | null = null;
let writing = false;

function writeSnapshot(): void {
    if (writing) return;
    writing = true;
    try {
        const file = affinityFile();
        const snapshot = { version: 1, entries: prefixAffinity.exportSnapshot() };
        const tmp = `${file}.tmp`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(snapshot));
        fs.renameSync(tmp, file);
    } catch (e) {
        log("warn", `[prefix-affinity] persist failed (${e instanceof Error ? e.message : String(e)}); affinity survives in memory`);
    } finally {
        writing = false;
    }
}

/** Debounced snapshot write — call after every affinity mutation. */
export function scheduleAffinityPersist(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        writeSnapshot();
    }, PERSIST_DEBOUNCE_MS);
    timer.unref?.();
}

/** Immediate snapshot write — shutdown path. */
export function flushPrefixAffinity(): void {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    writeSnapshot();
}

/** Load the snapshot a previous process left behind. Call once on boot. */
export function hydratePrefixAffinity(): void {
    try {
        const file = affinityFile();
        if (!fs.existsSync(file)) return;
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        const imported = prefixAffinity.importSnapshot(parsed.entries);
        if (imported > 0) log("info", `[prefix-affinity] hydrated ${imported} chain(s) from ${path.basename(file)} — anonymous sessions reattach across restarts`);
    } catch (e) {
        log("warn", `[prefix-affinity] hydrate failed (${e instanceof Error ? e.message : String(e)}); starting with empty affinity`);
    }
}
