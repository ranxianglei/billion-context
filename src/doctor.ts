// `bili doctor` (#1235): one read-only command that audits every install lane
// (global + per-host) and every registered proxy process: which copy each lane
// loads, who owns its updates, and how fresh it is against the registry. Turns
// the #991/#1196 single-writer & install-lane contract into an auditable
// output; never writes to any lane. The sole exception is `--fix` (#3496):
// an explicit user-triggered pass that converges drifted dsh-profile ledgers
// (manifest spec / lockfile record / on-disk copy) and prints every change.

import fs from "node:fs";
import path from "node:path";
import { isPidAlive, listInstances, procMainScript } from "./instance.js";
import { PLUGIN_AGENTS, UPDATE_CHANNEL, claudeDesktopPresent, inspectLanePresence, type PluginAgent } from "./plugin-install.js";
import { findInstallDir, fetchRegistryVersion, hostManagedInstall, isGitWorkingTree, isVersionNewer, lastUpdateCheckTime, normalizeUpdateTag, staleInstallStatus } from "./update.js";
import { describeAdvisory, evaluateAdvisories, type AdvisoryEvaluation } from "./advisory.js";
import { claudeRoutingWarningFile } from "./paths.js";
import { dshProfileDirs } from "./dsh-channel.js";
import { convergeDshLedger, dshProfileLedgerFindings, readDshLedgerState, type LedgerChangeDetail, type LedgerFinding } from "./dsh-ledger.js";

type LaneVerdict = "ok" | "stale" | "frozen" | "broken" | "absent";

interface DoctorGlobalInfo {
    installDir?: string;
    form: "npm" | "checkout" | "host-managed" | "unknown";
    owner?: string;
    channel?: string;
    diskVersion?: string;
    runningVersion: string;
    registryVersion?: string;
    updateTag: string;
    lastCheckTime?: number;
    verdict: LaneVerdict;
    reason?: string;
    /** Read-only advisory evaluation against the on-disk version (#1577). */
    advisory?: AdvisoryEvaluation;
}

export interface DoctorLane {
    agent: string;
    kind: "reference" | "host-managed";
    installed: boolean;
    detail: string;
    targetExists?: boolean;
    copyVersion?: string;
    registryVersion?: string;
    channel?: string;
    verdict: LaneVerdict;
    reason?: string;
    /** Advisory notes that do not affect the verdict — e.g. #2290: the claude
     *  lane is healthy, but a co-installed Claude Desktop will bypass it. */
    warnings?: string[];
}

export interface DoctorProcess {
    instanceId: string;
    pid: number;
    port: number;
    origin: string;
    startedAt: number;
    alive: boolean;
    runningFrom?: string;
    staleCopy?: boolean;
}

interface DshLedgerFixRow {
    profile: string;
    findingsBefore: LedgerFinding[];
    changed: string[];
    details: LedgerChangeDetail[];
    notes: string[];
    error?: string;
    residualFindings: LedgerFinding[];
}

export interface DoctorReport {
    generatedAt: number;
    packageName: string;
    global: DoctorGlobalInfo;
    lanes: DoctorLane[];
    processes: DoctorProcess[];
    /** #3496: set only when `--fix` ran — what the repair pass changed per profile. */
    ledgerFixes?: DshLedgerFixRow[];
}

interface DoctorOpts {
    packageName: string;
    runningVersion: string;
    resolveProxy?: (url: string) => string | undefined;
    updateTag?: string;
    advisoryUrl?: string;
}

interface LaneCtx {
    packageName: string;
    global: DoctorGlobalInfo;
}

const REFERENCE_LANES = new Set<PluginAgent>(["omp", "claude", "codex", "kimi", "zcode", "hermes"]);

function pkgVersionAt(rootDir: string): string | undefined {
    try {
        const v = (JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version?: unknown }).version;
        return typeof v === "string" ? v : undefined;
    } catch {
        return undefined;
    }
}

/** Pure verdict logic (#1235): absent < broken < frozen < stale < ok. A
 *  missing target beats a local pin because a dead entry means the host is
 *  currently broken, not merely un-updatable. */
export function laneVerdict(args: { installed: boolean; targetMissing: boolean; frozen: boolean; copyVersion?: string; registryVersion?: string }): LaneVerdict {
    if (!args.installed) return "absent";
    if (args.targetMissing) return "broken";
    if (args.frozen) return "frozen";
    if (args.copyVersion !== undefined && args.registryVersion !== undefined && isVersionNewer(args.registryVersion, args.copyVersion)) return "stale";
    return "ok";
}

export function globalVerdict(g: Pick<DoctorGlobalInfo, "form" | "diskVersion" | "registryVersion">): LaneVerdict {
    if (g.form === "checkout") return "frozen";
    if (g.diskVersion !== undefined && g.registryVersion !== undefined && isVersionNewer(g.registryVersion, g.diskVersion)) return "stale";
    return "ok";
}

/** #2891 (#953/#1803): dsh resolves bare bundle names installation-anchor-first, so a
 *  machine-global copy silently shadows a divergent profile-local one — surfaced nowhere
 *  before. Pure decision (no fs). Returns the warning, or undefined when there is no
 *  profile copy, no global copy, or both versions match (harmless). */
export function dshBundleShadowWarning(args: {
    packageName: string;
    globalInstallDir?: string;
    globalDiskVersion?: string;
    profileName: string;
    bundleInstalled: boolean;
    profileCopyVersion?: string;
}): string | undefined {
    if (!args.bundleInstalled || args.profileCopyVersion === undefined) return undefined;
    if (args.globalInstallDir === undefined) return undefined;
    if (args.globalDiskVersion !== undefined && args.globalDiskVersion === args.profileCopyVersion) return undefined;
    const gv = args.globalDiskVersion !== undefined ? `v${args.globalDiskVersion}` : "version unreadable";
    return `shadowed copy: a machine-global ${args.packageName} (${args.globalInstallDir}, ${gv}) coexists with this profile's own copy (v${args.profileCopyVersion}); dsh resolves bare bundle names installation-anchor-first (#953/#1803) and loads whichever sits in its own install tree — with divergent versions you may be running a build different from what the profile declares (e.g. a pre-#1590 global lacks the dsh.client web face, so the settings-page menu silently vanishes). Verify which copy dsh actually loads: 'dsh --profile ${args.profileName} --dump-config' (read the bundle 'name:' line)`;
}

export async function runDoctor(opts: DoctorOpts): Promise<DoctorReport> {
    const tag = normalizeUpdateTag(opts.updateTag);
    const [installDir, registryVersion, lastCheck] = await Promise.all([
        findInstallDir(opts.packageName),
        fetchRegistryVersion({ resolveProxy: opts.resolveProxy, updateTag: tag }, opts.packageName).catch(() => undefined),
        lastUpdateCheckTime(),
    ]);
    const gitTree = installDir !== undefined ? await isGitWorkingTree(installDir) : false;
    const managed = installDir !== undefined ? hostManagedInstall(installDir) : undefined;
    const diskVersion = installDir !== undefined ? pkgVersionAt(installDir) : undefined;
    const form: DoctorGlobalInfo["form"] = installDir === undefined ? "unknown" : gitTree ? "checkout" : managed !== undefined ? "host-managed" : "npm";
    // #1577: read-only advisory check against the on-disk version (what a next
    // start would load), independent of the advisoryCheck opt-out — doctor is a
    // diagnostic, not the auto-updater. Fail-open: a failed source yields
    // { error }, never a throw.
    const advisory = await evaluateAdvisories({
        version: diskVersion ?? opts.runningVersion,
        advisoryUrl: opts.advisoryUrl,
        resolveProxy: opts.resolveProxy,
    });
    const g: DoctorGlobalInfo = {
        installDir,
        form,
        owner: managed?.owner,
        channel: managed?.channel,
        diskVersion,
        runningVersion: opts.runningVersion,
        registryVersion,
        updateTag: tag,
        lastCheckTime: lastCheck,
        verdict: globalVerdict({ form, diskVersion, registryVersion }),
        advisory,
    };
    if (g.verdict === "frozen") g.reason = "source checkout — rebuild manually (npm run build); bili refuses to auto-update a working tree (#580)";
    else if (g.verdict === "stale") g.reason = managed !== undefined ? `newer on registry ${tag}: update through ${managed.owner}'s updater` : `newer on registry ${tag}: run 'bili update'`;
    else if (form !== "unknown" && staleInstallStatus(diskVersion, opts.runningVersion) === "restart") g.reason = `running process is behind the on-disk install (v${opts.runningVersion} → v${diskVersion}) — restart bili`;
    if (registryVersion === undefined) g.reason = g.reason ? `${g.reason}; registry unreachable — freshness unknown` : "registry unreachable — freshness unknown";

    const lanes: DoctorLane[] = [];
    for (const agent of PLUGIN_AGENTS) {
        try {
            lanes.push(...laneRowsFor(agent, inspectLanePresence(agent), registryVersion, { packageName: opts.packageName, global: g }));
        } catch (err) {
            lanes.push({
                agent,
                kind: REFERENCE_LANES.has(agent) ? "reference" : "host-managed",
                installed: false,
                detail: `probe failed: ${err instanceof Error ? err.message : String(err)}`,
                channel: UPDATE_CHANNEL[agent],
                verdict: "broken",
            });
        }
    }

    const processes = listInstances().map((e) => {
        const alive = isPidAlive(e.pid);
        const runningFrom = alive ? procMainScript(e.pid) : undefined;
        return {
            instanceId: e.instanceId,
            pid: e.pid,
            port: e.port,
            origin: e.origin,
            startedAt: e.startedAt,
            alive,
            runningFrom,
            staleCopy: runningFrom !== undefined && installDir !== undefined && !runningFrom.startsWith(installDir + path.sep),
        };
    });

    return { generatedAt: Date.now(), packageName: opts.packageName, global: g, lanes, processes };
}

/** #3496: the explicit repair pass behind `bili doctor --fix`. Converges every
 *  DRIFTED dsh profile to its on-disk copy version; healthy profiles and
 *  skip-condition profiles (local pin, no dep, no copy) get ZERO writes. The
 *  desktop profile IS included here — detection excludes it by design (#3224
 *  option A: bili is its in-place writer), but explicit repair must reach the
 *  very profile where the #3160 incident happened. Pure local file ops; never
 *  throws (dsh never ran → []). */
export function fixDshLedgers(env: NodeJS.ProcessEnv = process.env): DshLedgerFixRow[] {
    let dirs: string[];
    try {
        dirs = dshProfileDirs(env);
    } catch {
        return [];
    }
    const rows: DshLedgerFixRow[] = [];
    for (const dir of dirs) {
        const profile = path.basename(dir);
        const findingsBefore = dshProfileLedgerFindings(dir, { includeDesktop: true });
        if (findingsBefore.length === 0) continue;
        const res = convergeDshLedger(dir, readDshLedgerState(dir).copyVersion!);
        rows.push({
            profile,
            findingsBefore,
            changed: res.changed,
            details: res.details,
            notes: res.notes,
            error: res.error,
            residualFindings: dshProfileLedgerFindings(dir, { includeDesktop: true }),
        });
    }
    return rows;
}

function laneRowsFor(agent: PluginAgent, presence: ReturnType<typeof inspectLanePresence>, registryVersion: string | undefined, ctx: LaneCtx): DoctorLane[] {
    const kind = REFERENCE_LANES.has(agent) ? "reference" : "host-managed";
    const base: Omit<DoctorLane, "agent" | "installed" | "detail" | "targetExists" | "copyVersion" | "verdict" | "reason"> = {
        kind,
        registryVersion,
        channel: UPDATE_CHANNEL[agent],
    };
    if (agent === "dsh" && presence.profiles !== undefined) {
        return presence.profiles.map((p) => {
            const missing = p.bundleInstalled && p.copyVersion === undefined;
            const row: DoctorLane = {
                ...base,
                agent: `dsh:${p.name}`,
                installed: true,
                detail: p.spec !== undefined ? `dep spec: ${p.spec}${p.pinned ? " (local pin — dev lane, manual)" : ""}` : "(no dep spec)",
                copyVersion: p.copyVersion,
                verdict: laneVerdict({ installed: true, targetMissing: missing, frozen: p.pinned, copyVersion: p.copyVersion, registryVersion }),
            };
            if (row.verdict === "frozen") row.reason = "local-pin dep spec — no live update path; point it at a registry version or rebuild manually (AGENTS.md install-lane contract)";
            else if (row.verdict === "broken") row.reason = "profile depends on billion-context but the bundle copy is missing — rerun 'bili plugin install dsh'";
            const shadow = dshBundleShadowWarning({ packageName: ctx.packageName, globalInstallDir: ctx.global.installDir, globalDiskVersion: ctx.global.diskVersion, profileName: p.name, bundleInstalled: p.bundleInstalled, profileCopyVersion: p.copyVersion });
            if (shadow !== undefined) row.warnings = [...(row.warnings ?? []), shadow];
            return row;
        });
    }
    const targetsExist = presence.targets.length > 0 ? presence.targets.every((t) => fs.existsSync(t)) : undefined;
    const missingTargets = presence.targets.filter((t) => !fs.existsSync(t));
    let detail = presence.pointers.length > 0 ? presence.pointers.join("; ") : presence.installed ? "installed" : "not installed";
    if (agent === "pi" && presence.form === "npm" && presence.targets.length === 0) detail += "; pi materializes the npm copy on next startup";
    const row: DoctorLane = {
        ...base,
        agent,
        installed: presence.installed,
        detail,
        targetExists: targetsExist,
        copyVersion: presence.copyVersion,
        verdict: laneVerdict({ installed: presence.installed, targetMissing: missingTargets.length > 0, frozen: false, copyVersion: presence.copyVersion, registryVersion }),
    };
    if (row.verdict === "broken") row.reason = missingTargets.map((t) => `target missing: ${t}`).join("; ");
    if (agent === "opencode" && presence.installed && presence.form === "npm") {
        // #1234/#2199: the cache copy is bili-owned in place (self-updates via its
        // own proxy) — show the actual load path + disk version when resolvable so
        // the stale verdict below is honest, not "version not resolvable".
        const cp = presence.copyVersion !== undefined ? ` v${presence.copyVersion}` : "";
        const p = presence.targets[0] !== undefined ? ` (${presence.targets[0]})` : "";
        row.detail += `; cache copy${p}${cp} is bili-owned and self-updates in place via its own proxy (#1234) — reload/restart OpenCode to activate a disk update`;
    }
    if (agent === "claude" && presence.installed) {
        // #2290: the lane itself is healthy, but a co-installed Claude Desktop
        // overrides the managed ANTHROPIC_BASE_URL — desktop sessions then get
        // neither bili compression nor native auto-compact. Advisory only: never
        // change the verdict. Two sources: standing disk evidence + the last
        // hook-detected bypass (its stderr is invisible outside debug mode).
        const warnings: string[] = [];
        if (claudeDesktopPresent()) {
            warnings.push("Claude Desktop detected on this machine: its Code tab overrides ANTHROPIC_BASE_URL, so desktop sessions bypass bili entirely AND lose native auto-compact (managed block sets DISABLE_AUTO_COMPACT=1) — #2290");
        }
        try {
            const rec = JSON.parse(fs.readFileSync(claudeRoutingWarningFile(), "utf8")) as { at?: unknown; reasons?: unknown };
            if (Array.isArray(rec.reasons) && rec.reasons.length > 0 && rec.reasons.every((r) => typeof r === "string")) {
                const at = typeof rec.at === "number" ? ` at ${new Date(rec.at).toISOString()}` : "";
                warnings.push(`last SessionStart hook detected a routing bypass${at}: ${(rec.reasons as string[]).join("; ")}`);
            }
        } catch {
            // no marker or unreadable — nothing to surface
        }
        if (warnings.length > 0) row.warnings = warnings;
    }
    return [row];
}

function fmtTime(ts: number): string {
    return new Date(ts).toISOString();
}

function verdictText(v: LaneVerdict, row: { oldVersion?: string; registryVersion?: string }): string {
    if (v === "stale" && row.oldVersion !== undefined && row.registryVersion !== undefined) return `stale (v${row.oldVersion} → v${row.registryVersion})`;
    return v;
}

export function renderDoctorReport(report: DoctorReport): string {
    const lines: string[] = [];
    const g = report.global;
    lines.push(`bili doctor — ${report.packageName} (running v${g.runningVersion})`);
    lines.push(`generated ${fmtTime(report.generatedAt)}`);
    lines.push("");
    lines.push("global");
    lines.push(`  form          ${g.form}${g.owner !== undefined ? ` (owned by ${g.owner})` : ""}${g.installDir !== undefined ? ` — ${g.installDir}` : " — install dir not found"}`);
    lines.push(`  versions      disk ${g.diskVersion ?? "?"}   registry[${g.updateTag}] ${g.registryVersion ?? "unreachable"}`);
    lines.push(`  last check    ${g.lastCheckTime !== undefined ? fmtTime(g.lastCheckTime) : "never"}`);
    lines.push(`  verdict       ${verdictText(g.verdict, { oldVersion: g.diskVersion, registryVersion: g.registryVersion })}${g.reason !== undefined ? ` — ${g.reason}` : ""}`);
    if (g.advisory?.active !== undefined) lines.push(`  advisory      ⚠️ ${describeAdvisory(g.advisory.active, g.advisory.error)}`);
    else if (g.advisory?.error !== undefined) lines.push(`  advisory      check failed (${g.advisory.error}) — status unknown`);
    else lines.push(`  advisory      none`);
    lines.push("");
    lines.push("lanes");
    for (const lane of report.lanes) {
        const head = `  ${lane.agent.padEnd(12)} ${verdictText(lane.verdict, { oldVersion: lane.copyVersion, registryVersion: lane.registryVersion }).padEnd(34)} ${lane.kind}`;
        lines.push(head);
        lines.push(`  ${"".padEnd(12)} ${"".padEnd(34)} ${lane.detail}`);
        if (lane.channel !== undefined && lane.installed) lines.push(`  ${"".padEnd(12)} ${"".padEnd(34)} updates via: ${lane.channel}`);
        if (lane.reason !== undefined) lines.push(`  ${"".padEnd(12)} ${"".padEnd(34)} ${lane.reason}`);
        for (const w of lane.warnings ?? []) lines.push(`  ${"".padEnd(12)} ${"".padEnd(34)} ⚠️ ${w}`);
    }
    lines.push("");
    lines.push("processes");
    if (report.processes.length === 0) {
        lines.push("  none registered");
    } else {
        for (const p of report.processes) {
            const state = p.alive ? (p.staleCopy ? "STALE COPY" : "running") : "zombie (process gone, marker left behind)";
            lines.push(`  pid ${String(p.pid).padEnd(7)} port ${String(p.port).padEnd(6)} ${p.origin}  ${state}`);
            if (p.runningFrom !== undefined) lines.push(`  ${"".padEnd(12)} runs from ${p.runningFrom}${p.staleCopy ? " (not the current install dir)" : ""}`);
        }
    }
    const counts: Record<LaneVerdict, number> = { ok: 0, stale: 0, frozen: 0, broken: 0, absent: 0 };
    for (const l of report.lanes) counts[l.verdict]++;
    const zombies = report.processes.filter((p) => !p.alive).length;
    lines.push("");
    lines.push(`summary: ${counts.ok} ok, ${counts.stale} stale, ${counts.frozen} frozen, ${counts.broken} broken, ${counts.absent} absent; processes: ${report.processes.length - zombies} live, ${zombies} zombie`);
    return lines.join("\n") + "\n";
}

/** #3496: render the --fix pass. Explicit-trigger contract: every file touched
 *  and every before→after value is printed; a profile that could not be fully
 *  converged says so with the reason instead of claiming success. */
export function renderLedgerFixReport(rows: DshLedgerFixRow[]): string {
    const lines: string[] = [];
    lines.push("dsh ledger fix (--fix)");
    if (rows.length === 0) {
        lines.push("  no drifted dsh profiles — nothing written");
        return lines.join("\n") + "\n";
    }
    for (const row of rows) {
        const verdict = row.error !== undefined ? "FAILED" : row.residualFindings.length > 0 ? "PARTIAL" : "converged";
        lines.push(`  ${row.profile.padEnd(12)} ${verdict.padEnd(10)} drift was: ${row.findingsBefore.map((f) => f.kind).join(", ")}`);
        for (const d of row.details) lines.push(`  ${"".padEnd(12)} ${d.file}: ${d.field} ${d.before} → ${d.after}`);
        for (const n of row.notes) lines.push(`  ${"".padEnd(12)} note: ${n}`);
        if (row.error !== undefined) lines.push(`  ${"".padEnd(12)} ${row.error}`);
        else if (row.residualFindings.length > 0) {
            for (const f of row.residualFindings) lines.push(`  ${"".padEnd(12)} still drifted: ${f.detail}`);
        }
        if (verdict === "converged" && row.changed.some((c) => c === "pnpm-lock.yaml" || c === "package-lock.json")) {
            lines.push(`  ${"".padEnd(12)} the lockfile now records the on-disk copy's version — if that copy did not come from a normal install/self-update, verify its provenance before the next package-manager run (#3160/#3164)`);
        }
    }
    lines.push("");
    lines.push("rerun 'bili doctor' to confirm every profile is clean");
    return lines.join("\n") + "\n";
}
