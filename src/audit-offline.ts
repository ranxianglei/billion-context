// #2504 switch A (owner-approved 2026-10-09): the metrics-only offline
// re-review lane of the abuse audit lane. Default OFF — it runs only when
// audit.offline.enabled / BILI_AUDIT_OFFLINE_ENABLED is set.
//
// It walks the SAME files SessionStore persists (plain JSON / BILIZSTD1 /
// BILIENC1, via the same codec stack) and reports COUNTS ONLY: no
// conversation content ever reaches the log line or the admin readout. The
// scan is fire-and-forget from boot (never delays startup) and degrades to a
// warn log on any failure — an audit lane must never break the proxy.
//
// Coverage model (validated in #2504 P0): once a session has been compressed
// at least once, blockContents holds VERBATIM originals of every folded
// range; never-compressed sessions retain only the bounded recent tail
// (persist.tailTokens). This report surfaces exactly what is recoverable
// offline and makes no capture-of-all-history claim.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultCountTokens } from "acp-kernel";
import type { StateStoreCodec } from "acp-kernel/persist";
import { createStorageCodec, parseEncryptionKey } from "./encrypt.js";
import { sessionsDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";
import { isValidRecord } from "./persist.js";
import { contentStoreTokens } from "./session-gc.js";
import { persistZstdEnabled } from "./knobs.js";

interface AuditOfflineFileStats {
    /** Path relative to the sessions dir (hash-named; never absolute). */
    file: string;
    readable: boolean;
    /** Any block or blockContents entry exists (same predicate as session GC). */
    everCompressed?: boolean;
    /** Verbatim originals of folded ranges retained in blockContents. */
    blockContentsTokens?: number;
    /** Recent-window snapshot tokens (raw + summary mix, newest end). */
    tailMessagesTokens?: number;
    tailMessageCount?: number;
    savedAt?: number | null;
}

export interface AuditOfflineReport {
    scannedAt: number;
    durationMs: number;
    /** Every .json file walked (session records + CCR companions). */
    filesScanned: number;
    filesReadable: number;
    filesUnreadable: number;
    ccrCompanionFiles: number;
    ccrCompanionTokens: number;
    sessionsTotal: number;
    sessionsEverCompressed: number;
    sessionsNeverCompressed: number;
    /** Sum over readable sessions: verbatim folded-range originals on disk. */
    blockContentsTokens: number;
    /** Sum over readable sessions: persisted recent-tail snapshot tokens. */
    tailMessagesTokens: number;
    oldestSavedAt: number | null;
    newestSavedAt: number | null;
    perFile: AuditOfflineFileStats[];
}

let lastReport: AuditOfflineReport | null = null;
let scanning = false;

/** Last completed boot-scan result (null until it finishes). Counts only. */
export function getAuditOfflineReport(): AuditOfflineReport | null {
    return lastReport;
}

/** Fire-and-forget scan for boot wiring. Safe to call repeatedly (a second
 *  call while one is running is a no-op). Never throws. */
export function runAuditOfflineScan(): void {
    if (scanning) return;
    scanning = true;
    void scanSessionsDir().then((report) => {
        lastReport = report;
        loggerLog("info", `[audit] offline scan (#2504): ${report.filesReadable}/${report.filesScanned} files readable (${report.filesUnreadable} unreadable), ${report.sessionsEverCompressed} ever-compressed / ${report.sessionsNeverCompressed} never-compressed | folded-originals=${report.blockContentsTokens} tok, tail=${report.tailMessagesTokens} tok, ccr-companions=${report.ccrCompanionFiles} (${report.ccrCompanionTokens} tok)`);
    }).catch((err) => {
        loggerLog("warn", `[audit] offline scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
        scanning = false;
    });
}

/** Test hook: drop the cached report so tests observe fresh scans. */
export function _resetAuditOfflineForTest(): void {
    lastReport = null;
    scanning = false;
}

/** Same storage policy as SessionStore (#708/#1080): env key + opt-in zstd.
 *  An invalid key can only exist if boot itself would have failed first, but
 *  the scan still degrades to plain-JSON reading instead of throwing. */
function buildCodec(): StateStoreCodec | undefined {
    let key: Buffer | null = null;
    const keyEnv = process.env.BILI_ENCRYPTION_KEY;
    if (keyEnv) {
        try {
            key = parseEncryptionKey(keyEnv);
        } catch (err) {
            loggerLog("warn", `[audit] offline scan: ignoring invalid BILI_ENCRYPTION_KEY (${err instanceof Error ? err.message : String(err)})`);
        }
    }
    return createStorageCodec({ key, compress: persistZstdEnabled() });
}

async function walkJsonFiles(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            // Hidden dirs are never part of the session tree (mirrors the
            // kernel walk's .tmp- discipline; the dir itself is dedicated).
            if (!e.name.startsWith(".")) await walkJsonFiles(full, out);
        } else if (e.isFile() && e.name.endsWith(".json") && !e.name.startsWith(".tmp-")) {
            out.push(full);
        }
    }
}

/** Decode order mirrors SessionStore.readRawFile: plain JSON first, codec
 *  fallback. Returns decoded text or null when neither yields valid JSON. */
function decodeText(buf: Buffer, codec: StateStoreCodec | undefined): string | null {
    const text = buf.toString("utf8");
    try {
        JSON.parse(text);
        return text;
    } catch {
        if (!codec) return null;
        try {
            const framed = codec.decode(buf);
            JSON.parse(framed);
            return framed;
        } catch {
            return null;
        }
    }
}

function numOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The scan core (exported for tests): one non-blocking pass over the
 *  sessions dir, counts only. Never throws for per-file problems — they
 *  count as unreadable. A missing root dir yields an empty report. */
export async function scanSessionsDir(): Promise<AuditOfflineReport> {
    const startedAt = Date.now();
    const root = sessionsDir();
    const codec = buildCodec();
    const files: string[] = [];
    await walkJsonFiles(root, files);

    const report: AuditOfflineReport = {
        scannedAt: startedAt,
        durationMs: 0,
        filesScanned: 0,
        filesReadable: 0,
        filesUnreadable: 0,
        ccrCompanionFiles: 0,
        ccrCompanionTokens: 0,
        sessionsTotal: 0,
        sessionsEverCompressed: 0,
        sessionsNeverCompressed: 0,
        blockContentsTokens: 0,
        tailMessagesTokens: 0,
        oldestSavedAt: null,
        newestSavedAt: null,
        perFile: [],
    };

    for (const file of files) {
        const rel = path.relative(root, file);
        let buf: Buffer;
        try {
            buf = await readFile(file);
        } catch {
            report.filesScanned++;
            report.filesUnreadable++;
            report.perFile.push({ file: rel, readable: false });
            continue;
        }
        report.filesScanned++;
        const isCcrCompanion = file.endsWith(".content-store.json");
        const text = decodeText(buf, codec);
        let parsed: unknown;
        if (text === null) parsed = null;
        else {
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = null;
            }
        }
        if (parsed === null || typeof parsed !== "object") {
            report.filesUnreadable++;
            report.perFile.push({ file: rel, readable: false });
            continue;
        }
        if (isCcrCompanion) {
            const toks = contentStoreTokens(parsed);
            if (toks !== null) {
                report.filesReadable++;
                report.ccrCompanionFiles++;
                report.ccrCompanionTokens += toks;
            } else {
                report.filesUnreadable++;
                report.perFile.push({ file: rel, readable: false });
            }
            continue;
        }
        const obj = parsed as Record<string, unknown>;
        const rec = (obj.payload && typeof obj.payload === "object" ? obj.payload : obj) as Record<string, unknown>;
        if (!isValidRecord(rec)) {
            report.filesUnreadable++;
            report.perFile.push({ file: rel, readable: false });
            continue;
        }
        report.filesReadable++;
        report.sessionsTotal++;

        const state = rec.state as unknown as Record<string, unknown>;
        const blocks = Array.isArray(state.blocks) ? state.blocks.length : 0;
        const bcRaw = rec.blockContents;
        const bc = bcRaw && typeof bcRaw === "object" && !Array.isArray(bcRaw) ? bcRaw as Record<string, unknown> : {};
        let bcTokens = 0;
        let bcEntries = 0;
        for (const v of Object.values(bc)) {
            const entry = v as { full?: { text?: unknown } } | null;
            if (entry && typeof entry.full?.text === "string") {
                bcEntries++;
                bcTokens += defaultCountTokens(entry.full.text);
            }
        }
        const messages = Array.isArray(rec.messages) ? rec.messages as Array<{ text?: unknown }> : [];
        let tailTokens = 0;
        for (const m of messages) {
            if (m && typeof m.text === "string") tailTokens += defaultCountTokens(m.text);
        }
        const everCompressed = blocks > 0 || bcEntries > 0;
        const savedAt = numOrNull(obj.savedAt) ?? numOrNull(rec.savedAt);

        report.blockContentsTokens += bcTokens;
        report.tailMessagesTokens += tailTokens;
        if (everCompressed) report.sessionsEverCompressed++;
        else report.sessionsNeverCompressed++;
        if (savedAt !== null) {
            if (report.oldestSavedAt === null || savedAt < report.oldestSavedAt) report.oldestSavedAt = savedAt;
            if (report.newestSavedAt === null || savedAt > report.newestSavedAt) report.newestSavedAt = savedAt;
        }
        report.perFile.push({
            file: rel,
            readable: true,
            everCompressed,
            blockContentsTokens: bcTokens,
            tailMessagesTokens: tailTokens,
            tailMessageCount: messages.length,
            savedAt,
        });
    }

    report.durationMs = Date.now() - startedAt;
    return report;
}
