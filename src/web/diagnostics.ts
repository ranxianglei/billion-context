/**
 * Generic diagnostics report builder (#3040).
 *
 * One reusable facility behind every web warning: assemble a ready-to-paste
 * diagnostic blob (environment facts + host client versions + sanitized bili
 * config + one topic-specific section) plus a prefilled GitHub issue link, so
 * any future warning can offer "copy diagnostics / report on GitHub" without
 * inventing its own plumbing. Consumers: the SQLite legacy-only degradation
 * banner (topic `storage-legacy-only`) and the compression-conflict banner
 * (topic `conflict-banner`, #3235).
 *
 * #3611 enrichment: the first field reports showed the blob was not
 * diagnosable as-is — no client version, no config, no log evidence. Every
 * report now appends `--- host client versions ---` (the dsh profile bundle
 * packages, incl. compaction-basic whose framing bytes bili pins, #2432) and
 * `--- bili config (secrets masked) ---`; the conflict-banner topic also gets
 * `--- recent conflict-related log lines ---` (the exact signatures a
 * maintainer greps to adjudicate a native-compaction episode).
 *
 * PUBLISH DISCIPLINE: the blob lands in a PUBLIC GitHub issue body. The single
 * publish boundary is buildDiagnostics itself: before serialization it runs the
 * whole blob through redactForPublish (secrets → non-public hosts → $HOME paths),
 * so EVERY topic's section is scrubbed uniformly and the copied blob plus the
 * prefilled issue body derive from one string (they can never diverge). Secret
 * values are also replaced structurally (maskSecretValues) for the config block,
 * and only profile NAMES are included, never absolute paths (a $HOME prefix is
 * rewritten to `~` at the boundary instead). The scrubbing is unconditional — it
 * ignores BILI_LOG_MASK_HOSTS, so the local host-visibility preference can never
 * weaken the publish boundary (#3811/#4499).
 *
 * Contract: NEVER throws — every fs/listSessions access is guarded so a
 * broken log file or an unbuilt store degrades the blob, not the endpoint.
 */

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { summarizeConflicts } from "../conflict-watch.js";
import { snapshotShadowStatusWire } from "../server/snapshot-render.js";
import { dshProfileDirs } from "../dsh-channel.js";
import { resolveDshHome } from "../client-config.js";
import { safeReadJson } from "../config.js";
import { redactForPublish } from "../log-mask.js";
import { getLogPath } from "../logger.js";
import { configFile, defaultLogFile } from "../paths.js";
import { listSessions } from "../session.js";
import { safeSuffix } from "../text-safe.js";
import { storageDiagnosticsLines } from "../storage/runtime-status.js";
import { BUILD_COMMIT, PACKAGE_NAME, VERSION } from "../version.js";

const GITHUB_NEW_ISSUE_URL = "https://github.com/ranxianglei/billion-context/issues/new";
const STORAGE_LOG_TAIL_LINES = 12;
// #3611: budgets keep the blob pasteable. The copy button carries it
// verbatim and is the reliable channel; the prefilled issues/new URL embeds
// the same blob in its query string, which on worst-case (full-budget,
// CJK-heavy) logs can still outgrow conservative proxy request-line limits.
const CONFIG_SECTION_MAX_CHARS = 1600;
const CONFLICT_LOG_TAIL_LINES = 20;
const LOG_LINE_MAX_CHARS = 240;
const DSH_PROFILE_CAP = 8;
const DSH_REPORT_PACKAGES = ["@deepseek-ai/dsh", "@deepseek-ai/dsh-compaction-basic", "@deepseek-ai/dsh-web-app"] as const;

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

// #3813: count full-pair scans so tests pin the single-read-per-report
// contract (a regression to per-tail reads would re-double the cost).
let candidateLogReads = 0;

/** All non-empty lines across the rotated log pair; [] on any fs failure. */
function candidateLogLines(): string[] {
    candidateLogReads += 1;
    try {
        const logFile = getLogPath() ?? defaultLogFile();
        const dir = logFile ? path.dirname(logFile) + path.sep : "";
        const candidates = [dir + "bili.log.old", dir + "bili.log"];
        let lines: string[] = [];
        for (const f of candidates) {
            try { if (!statSync(f).isFile()) continue; } catch { continue; }
            try {
                lines = lines.concat(readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0));
            } catch { continue; }
        }
        return lines;
    } catch {
        return [];
    }
}

/** #4499: per-line publish treatment shared by BOTH log tails — scrub with
 * redactForPublish (secrets → non-public hosts → $HOME paths), then bound to
 * LOG_LINE_MAX_CHARS so one long error line can't blow out the pasteable blob.
 * Idempotent with the boundary scrub in buildDiagnostics (defense in depth). */
function publishRedactLine(line: string): string {
    const masked = redactForPublish(line);
    return masked.length > LOG_LINE_MAX_CHARS ? masked.slice(0, LOG_LINE_MAX_CHARS - 1) + "…" : masked;
}

/** Last N `[storage]` lines from the pre-fetched candidate set ([] when none
 * match). The caller reads the rotated pair once per report (#3813). #4499: each
 * line is publish-redacted and bounded — parity with conflictLogTail — because
 * raw [storage] lines carried credentials, private hosts and absolute paths into
 * the public blob. */
function storageLogTail(lines: string[]): string[] {
    return lines.filter((l) => l.includes("[storage]")).slice(-STORAGE_LOG_TAIL_LINES).map(publishRedactLine);
}

// #3611: the evidence chain of a dsh native-compaction episode, exactly what a
// maintainer greps to adjudicate one — direct-bypass refusals (takeover gate),
// routed-call refusals (#1729), the destruction verdict (#2193), successful
// rebases (#2432), and the web-app preset notice that says whether the #3354
// load-time overlay applies to this machine's profiles.
const CONFLICT_LOG_PATTERNS = [
    "takeover gate refused",
    "dsh native compaction call identified",
    "compression substrate appears destroyed",
    "native compaction boundary",
    "profile bundles include @deepseek-ai/dsh-web-app",
];

function conflictLogTail(lines: string[]): string[] {
    // #4499: same publish treatment as the storage tail — redactForPublish scrubs
    // credentials AND unconditionally masks non-public hosts (so BILI_LOG_MASK_HOSTS=0
    // real hosts in the on-disk log still can't leak, #3811), plus $HOME paths (#4499).
    return lines
        .filter((l) => CONFLICT_LOG_PATTERNS.some((p) => l.includes(p)))
        .slice(-CONFLICT_LOG_TAIL_LINES)
        .map(publishRedactLine);
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

// #3611: the version truth for a plugin-lane host lives in each profile bundle,
// not in any header bili receives. compaction-basic is listed because bili's
// checkpoint-framing pin (#2432) targets its output bytes — a drift there is
// the first suspect when native-compaction-inferred events appear; web-app
// presence decides whether the #3354 load-time disable overlay applies.
function dshPackageVersion(profileDir: string, pkg: string): string | undefined {
    try {
        const doc = JSON.parse(readFileSync(path.join(profileDir, "node_modules", ...pkg.split("/"), "package.json"), "utf8")) as { version?: unknown };
        return typeof doc.version === "string" && doc.version.length > 0 ? doc.version : undefined;
    } catch {
        return undefined;
    }
}

function hostClientVersionLines(): string[] {
    const lines: string[] = ["--- host client versions ---"];
    let dirs: string[] = [];
    try { dirs = dshProfileDirs(process.env); } catch { dirs = []; }
    if (dirs.length === 0) {
        lines.push(`dsh: no profiles under DSH_HOME (${path.basename(resolveDshHome(process.env)) || "?"}/profiles missing — dsh has never run here, or DSH_HOME points elsewhere)`);
        return lines;
    }
    for (const dir of dirs.slice(0, DSH_PROFILE_CAP)) {
        const vers = DSH_REPORT_PACKAGES.map((p) => `${p.split("/")[1]} ${dshPackageVersion(dir, p) ?? "?"}`).join(", ");
        lines.push(`dsh profile ${path.basename(dir)}: ${vers}`);
    }
    if (dirs.length > DSH_PROFILE_CAP) lines.push(`… ${dirs.length - DSH_PROFILE_CAP} more profile(s)`);
    return lines;
}

// #3611/#4499: two-layer config scrubbing. maskSecretValues replaces values under
// secret-NAMED keys with *** (structural); redactForPublish then catches shapes the
// key-based pass cannot see — credential tokens, bare endpoint HOSTS (a providers[]
// upstream or route-prefix key), and any $HOME prefix → `~`. Unconditional: publish
// boundary, ignores BILI_LOG_MASK_HOSTS.
const SECRET_KEY_RE = /key|token|secret|password|passwd|credential|auth/i;

function maskSecretValues(node: unknown, key?: string): unknown {
    // propagate the parent key into elements: an array under a secret-named
    // key holds secrets too ({"apiKey": ["…"]} must never pass through raw)
    if (Array.isArray(node)) return node.map((v) => maskSecretValues(v, key));
    if (node !== null && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = maskSecretValues(v, k);
        return out;
    }
    if (typeof node === "string" && key !== undefined && SECRET_KEY_RE.test(key)) return "***";
    return node;
}

function configSectionLines(): string[] {
    const lines: string[] = ["--- bili config (secrets masked) ---"];
    const file = configFile();
    let exists = false;
    try { exists = statSync(file).isFile(); } catch { exists = false; }
    if (!exists) {
        lines.push("(no config file)");
        return lines;
    }
    const parsed = safeReadJson(file);
    if (parsed === undefined) {
        lines.push("(config file present but unparseable JSON)");
        return lines;
    }
    let text: string;
    try {
        // #3811/#4499: redactForPublish is the outermost sink net — it scrubs
        // credential shapes, masks every non-public endpoint host whether it
        // appears as a VALUE (upstream/proxy) or a providers-table KEY, and
        // rewrites any $HOME prefix to `~`. Always on: the blob is publish-boundary.
        text = redactForPublish(JSON.stringify(maskSecretValues(parsed)));
    } catch {
        lines.push("(config could not be serialized)");
        return lines;
    }
    if (text.length > CONFIG_SECTION_MAX_CHARS) {
        text = text.slice(0, CONFIG_SECTION_MAX_CHARS - 1) + `… (truncated, ${text.length} chars total)`;
    }
    lines.push(text);
    return lines;
}

interface TopicContext {
    sessions: number;
    storageLogLines: string[];
    conflicts: ReturnType<typeof summarizeConflicts> | null;
    conflictLogLines: string[];
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
    // #3611: the ledger section alone was not diagnosable (no client version,
    // no config, no log evidence) — the matching log signatures ride along.
    "snapshot-shadow": {
        title: () => `Snapshot-render shadow mismatch (bili v${VERSION}, node ${process.version}, ${process.platform}-${process.arch})`,
        section: () => snapshotShadowDiagnosticsLines(),
    },
    "conflict-banner": {
        title: () => `Compression conflict banner (bili v${VERSION}, node ${process.version}, ${process.platform}-${process.arch})`,
        section: (ctx) => [
            ...conflictDiagnosticsLines(ctx.conflicts),
            "--- recent conflict-related log lines ---",
            ...(ctx.conflictLogLines.length > 0
                ? ctx.conflictLogLines
                : ["(no matching lines in the current log pair)"]),
        ],
    },
};

interface DiagnosticsReport {
    blob: string;
    title: string;
    url: string;
}

/** #3756 follow-up: snapshot-render shadow lane — the engine computes the
 *  would-be view on every armed turn and classifies the diff against the
 *  legacy outbound. This section lists the watching sessions and the worst
 *  offenders so a user can attach it to a report with one click. */
function snapshotShadowDiagnosticsLines(): string[] {
    const wire = snapshotShadowStatusWire();
    const lines = [
        `snapshot-shadow: enabled=${wire.enabled} watching=${wire.watching} totalErrors=${wire.errors}`,
    ];
    if (wire.worst) {
        lines.push(`worst: ${wire.worst.sessionId}${wire.worst.label ? ` (${wire.worst.label})` : ""} lastErrors=${wire.worst.lastErrors.join("; ") || "(none recorded)"}`);
    } else {
        lines.push("worst: (no session with error-class entries)");
    }
    lines.push("--- per-session shadow blobs ---");
    let listed = 0;
    for (const s of listSessions()) {
        const b = s.metadata["snapshotShadow"] as { turns?: number; errors?: number; lastClass?: string; lastReason?: string; lastErrors?: string[] } | undefined;
        if (!b || typeof b !== "object" || !((b.turns ?? 0) > 0)) continue;
        lines.push(`${s.id}${s.meta.label !== s.id ? ` (${s.meta.label})` : ""}: turns=${b.turns} errors=${b.errors ?? 0} lastClass=${b.lastClass ?? "watch"}${b.lastReason ? ` reason=${b.lastReason}` : ""}${b.lastErrors?.length ? ` lastErrors=${b.lastErrors.join(";")}` : ""}`);
        listed++;
        if (listed >= 40) { lines.push("(…more sessions truncated)"); break; }
    }
    if (listed === 0) lines.push("(no watching sessions in the live pool)");
    return lines;
}

export function buildDiagnostics(topic?: string): DiagnosticsReport {
    const t = topic?.trim().slice(0, 64) ?? "";
    const def = t ? TOPICS[t] : undefined;
    // #3813: read the rotated log pair at most ONCE per report — the storage
    // tail and the conflict banner filter the SAME candidate lines, so a
    // conflict-banner request used to read the whole pair twice (hundreds of MB
    // possible), stalling the event loop synchronously.
    const logLines = def || t === "conflict-banner" ? candidateLogLines() : [];
    const ctx: TopicContext = {
        sessions: safeSessionCount(),
        storageLogLines: def ? storageLogTail(logLines) : [],
        conflicts: def ? safeConflictSummary() : null,
        conflictLogLines: t === "conflict-banner" ? conflictLogTail(logLines) : [],
    };
    const lines = baseLines();
    if (t && !def) lines.push(`topic: ${t} (no topic-specific section registered)`);
    if (def) lines.push(...def.section(ctx));
    lines.push(...hostClientVersionLines());
    lines.push(...configSectionLines());
    // #4499: THE single publish boundary. Scrub every topic's blob uniformly
    // (secrets → non-public hosts → $HOME paths) before serialization; the copied
    // blob and the prefilled issue body both derive from this ONE string, so they
    // can never diverge. Unconditional — ignores BILI_LOG_MASK_HOSTS.
    const blob = redactForPublish(lines.join("\n"));
    const title = def
        ? def.title()
        : `bili diagnostics report (v${VERSION}, node ${process.version}, ${process.platform}-${process.arch})`;
    const url = `${GITHUB_NEW_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(blob)}`;
    return { blob, title, url };
}

export function _candidateLogReadsForTest(): number {
    return candidateLogReads;
}

export function _resetCandidateLogReadsForTest(): void {
    candidateLogReads = 0;
}
