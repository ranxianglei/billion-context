/**
 * Generic diagnostics report builder (#3040).
 *
 * One reusable facility behind every web warning AND the permanent feedback
 * entry (#3299): assemble a ready-to-paste diagnostic blob (environment
 * facts + one topic-specific section, plus an optional user description)
 * plus a prefilled GitHub issue link, so any warning — or a user who hit a
 * problem that never raised one — can get "copy diagnostics / report on
 * GitHub" without inventing its own plumbing. Consumers: the SQLite
 * legacy-only degradation banner (topic `storage-legacy-only`), the
 * compression-conflict banner (`conflict-banner`, #3235) and the always-on
 * topbar feedback modal (`general`, #3299).
 *
 * Contract: NEVER throws — every fs/listSessions access is guarded so a
 * broken log file or an unbuilt store degrades the blob, not the endpoint.
 */

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { summarizeConflicts } from "../conflict-watch.js";
import { getLogPath } from "../logger.js";
import { defaultLogFile } from "../paths.js";
import { listSessions } from "../session.js";
import { safeSuffix } from "../text-safe.js";
import { storageDiagnosticsLines } from "../storage/runtime-status.js";
import { BUILD_COMMIT, PACKAGE_NAME, VERSION } from "../version.js";

const GITHUB_NEW_ISSUE_URL = "https://github.com/ranxianglei/billion-context/issues/new";
const STORAGE_LOG_TAIL_LINES = 12;
// #3299: the always-on feedback modal carries the recent [error]-level tail so a
// report that never raised a warning banner still ships real evidence.
const ERROR_LOG_TAIL_LINES = 15;
// Cap the user description so a pasted wall of text cannot bloat the issue body.
const DESC_MAX_CHARS = 4000;

function humanUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function baseLines(): string[] {
    return [
        `=== ${PACKAGE_NAME} diagnostics ===`,
        `generated: ${new Date().toISOString()}`,
        `bili version: ${VERSION} (commit ${BUILD_COMMIT})`,
        `node: ${process.version}`,
        `platform: ${process.platform} ${process.arch}`,
        `os: ${os.type()} ${os.release()}`,
        `uptime: ${humanUptime(process.uptime())}`,
    ];
}

/** Last N `[storage]` lines across the rotated pair (same candidate recipe as
 *  sendWebLogs); empty on any fs failure. */
function storageLogTail(): string[] {
    try {
        const logFile = getLogPath() ?? defaultLogFile();
        const dir = logFile ? path.dirname(logFile) + path.sep : "";
        const candidates = [dir + "bili.log.old", dir + "bili.log"];
        let lines: string[] = [];
        for (const f of candidates) {
            try { if (!statSync(f).isFile()) continue; } catch { continue; }
            try {
                lines = lines.concat(readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0 && l.includes("[storage]")));
            } catch { continue; }
        }
        return lines.slice(-STORAGE_LOG_TAIL_LINES);
    } catch {
        return [];
    }
}

/** Last N `[error]` lines across the rotated pair (same candidate recipe as
 * storageLogTail); empty on any fs failure. */
function errorLogTail(): string[] {
    try {
        const logFile = getLogPath() ?? defaultLogFile();
        const dir = logFile ? path.dirname(logFile) + path.sep : "";
        const candidates = [dir + "bili.log.old", dir + "bili.log"];
        let lines: string[] = [];
        for (const f of candidates) {
            try { if (!statSync(f).isFile()) continue; } catch { continue; }
            try {
                lines = lines.concat(readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0 && l.includes("[error]")));
            } catch { continue; }
        }
        return lines.slice(-ERROR_LOG_TAIL_LINES);
    } catch {
        return [];
    }
}

function safeSessionCount(): number {
    try { return listSessions().length; } catch { return -1; }
}

/** Conflict-ledger summary for the topic section; null on any failure (the
 * endpoint degrades, never throws). */
function safeConflictSummary(): ReturnType<typeof summarizeConflicts> | null {
    try { return summarizeConflicts(listSessions()); } catch { return null; }
}

/** #3235: the conflict banner's diagnostic section — the aggregated ledger the
 * banner itself renders from, plus the newest events (detail strings are
 * technical evidence lines, e.g. "framing absent [inferred]"; session ids are
 * shortened to their tail so reporters can correlate without pasting full
 * identifiers). */
function conflictDiagnosticsLines(summary: ReturnType<typeof summarizeConflicts> | null): string[] {
    const lines: string[] = ["--- compression conflict ledger ---"];
    if (!summary) {
        lines.push("(conflict summary unavailable)");
        return lines;
    }
    lines.push(`sessions with events: ${summary.sessions}`);
    lines.push(`events: ${summary.events} (active ${summary.active}, historical ${summary.historical})`);
    lines.push(`kinds: ${JSON.stringify(summary.kinds)}`);
    lines.push(`classification: sibling ${summary.sibling}, suspected ${summary.suspected}, displayOnly ${summary.displayOnly}, activeConfirmed ${summary.activeConfirmed}`);
    lines.push(`clients: ${summary.clients.length ? summary.clients.join(", ") : "(none resolved)"}`);
    if (summary.latest.length > 0) {
        lines.push("newest event per session:");
        for (const e of summary.latest.slice(0, 8)) {
            const sid = e.sessionId.length > 12 ? "…" + safeSuffix(e.sessionId, 8) : e.sessionId;
            lines.push(`  [${new Date(e.at).toISOString()}] ${sid} ${e.kind}: ${e.detail.slice(0, 160)}`);
        }
    }
    lines.push("banner policy (#3235): only landed-unrecovered evidence alarms — recovered (intercepted+rebased) and");
    lines.push("suspected/sibling/display-only stock stay recorded but quiet; dismissal re-arms on any newer event.");
    return lines;
}

/** #3299: the always-on feedback modal's section — no banner evidence exists by
 * definition, so the blob carries what every report benefits from: how many
 * sessions are on disk plus the recent [error]-level log tail (the logger already
 * masks secret values; conversation content never reaches this file). */
function generalDiagnosticsLines(ctx: TopicContext): string[] {
    const lines: string[] = ["--- reported problem ---", `sessions on disk: ${ctx.sessions}`];
    if (ctx.errorLines.length > 0) {
        lines.push(`recent [error] log lines (last ${ctx.errorLines.length}):`);
        lines.push(...ctx.errorLines);
    } else {
        lines.push("(no recent [error] log lines)");
    }
    return lines;
}

interface TopicContext {
    sessions: number;
    storageLogLines: string[];
    conflicts: ReturnType<typeof summarizeConflicts> | null;
    errorLines: string[];
}

interface TopicDef {
    title: () => string;
    section: (ctx: TopicContext) => string[];
}

const TOPICS: Record<string, TopicDef> = {
    "storage-legacy-only": {
        title: () => `SQLite unified storage degraded to legacy-only (bili v${VERSION}, node ${process.version}, ${process.platform}-${process.arch})`,
        section: (ctx) => storageDiagnosticsLines(ctx),
    },
    // #3235: the compression-conflict banner rides the same #3040 facility —
    // "copy diagnostics / report on GitHub" buttons straight on the banner.
    "conflict-banner": {
        title: () => `Compression conflict banner (bili v${VERSION}, node ${process.version}, ${process.platform}-${process.arch})`,
        section: (ctx) => conflictDiagnosticsLines(ctx.conflicts),
    },
    // #3299: the permanent topbar feedback entry — usable for ANY problem, with or
    // without a banner; opts.desc carries the user's own description.
    "general": {
        title: () => `User report via web UI (bili v${VERSION}, node ${process.version}, ${process.platform}-${process.arch})`,
        section: (ctx) => generalDiagnosticsLines(ctx),
    },
};

interface DiagnosticsReport {
    blob: string;
    title: string;
    url: string;
}

interface DiagnosticsOptions {
    /** #3299: the user's own problem description from the feedback modal. */
    desc?: string;
    /** Include the [error] log tail in the `general` topic (default true). */
    includeErrors?: boolean;
}

export function buildDiagnostics(topic?: string, opts?: DiagnosticsOptions): DiagnosticsReport {
    const t = topic?.trim().slice(0, 64) ?? "";
    const def = t ? TOPICS[t] : undefined;
    const ctx: TopicContext = {
        sessions: safeSessionCount(),
        storageLogLines: def ? storageLogTail() : [],
        conflicts: def ? safeConflictSummary() : null,
        errorLines: def && t === "general" && opts?.includeErrors !== false ? errorLogTail() : [],
    };
    const lines = baseLines();
    const desc = opts?.desc?.trim().slice(0, DESC_MAX_CHARS) ?? "";
    if (desc) {
        lines.push("--- user description ---");
        lines.push(desc);
    }
    if (t && !def) lines.push(`topic: ${t} (no topic-specific section registered)`);
    if (def) lines.push(...def.section(ctx));
    const blob = lines.join("\n");
    const title = def
        ? def.title()
        : `bili diagnostics report (v${VERSION}, node ${process.version}, ${process.platform}-${process.arch})`;
    const url = `${GITHUB_NEW_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(blob)}`;
    return { blob, title, url };
}
