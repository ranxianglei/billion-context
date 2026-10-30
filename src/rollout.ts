// Feature-rollout gating (#3062): canary percentages over a stable
// per-install identity. The mechanism this module owns:
//
//   1. IDENTITY — every install gets ONE random UUID, persisted under the
//      machine-global state dir the first time any gated feature resolves
//      ("安装后不变"). All lanes and copies on one machine (global install,
//      dsh profile copy, pi tree) share the id, so a machine is exactly one
//      cohort member — in or out consistently everywhere.
//   2. BUCKETING — bucket = sha256(salt + "\n" + id) % 10000 (basis points);
//      enabled ⇔ bucket < percent × 100. Prefix-stable: raising the percent
//      never drops an already-enabled install (monotonic rollout, 灰度只进
//      不出). To re-randomize the cohort, change the salt.
//   3. NESTING — a feature may declare `base`: it is evaluated only inside
//      the base feature's enabled cohort (灰度 A 的用户里再灰度 B; C→D the
//      same), so a nested percent is relative to the base population, not
//      everyone. Base chains of any depth; cycles fail closed (off).
//   4. PRECEDENCE — env `BILI_ROLLOUT_<FEATURE>` ("0"/"false" = off, any
//      other value = on) > config `rollout.features.<name>.enabled` >
//      bucketing over percent (config `percent` override > registry default).
//      A feature absent from the registry AND from the config block is OFF.
//
// A release that wants to canary a feature adds one entry to ROLLOUT_FEATURES
// (percent 0–100, optional salt/base); GA = bump to 100, or move the default
// into the feature's own knob and drop the entry. The registry ships EMPTY —
// no behavior change rides along with the mechanism itself; every adopter
// declares its own entry in its own PR.

import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";
import { loadConfigFile, type RolloutFeatureOverride, type RolloutFileConfig } from "./config.js";
import { log as loggerLog } from "./logger.js";

/** One feature's baked-in rollout plan (version-owned, set at release time). */
export interface RolloutPlan {
    /** Percent of installs, 0–100 (fractional allowed, e.g. 0.5 = 50 bp). */
    percent: number;
    /** Hash salt; defaults to the feature name. Changing it re-randomizes the cohort. */
    salt?: string;
    /** Nested rollout: evaluate this feature only inside `base`'s enabled cohort. */
    base?: string;
}

/** Registry of features currently under rollout. EMPTY by default — adding an
 *  entry is a per-feature decision (issue + PR), never mechanical. */
export const ROLLOUT_FEATURES: Record<string, RolloutPlan> = {
    // #3248 incremental turns: lets a native extension send only the delta of
    // a conversation (marker `x-bili-plugin-turn` on ordinary model requests)
    // once enabled for this install. Default 0% — every client keeps the
    // byte-identical full-resend behavior. Operators force it on with
    // `rollout.features.pluginIncrementalTurns: true` (or a percent), or
    // `BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS=1`.
    pluginIncrementalTurns: { percent: 0 },
    // #4804 WS delta continuation: codex/opencode WebSocket clients that keep a
    // previous_response_id checkpoint stop reconstructing full history on every
    // turn — the session augments the delta with the server-committed previous
    // output and the outbound prefix renders from the unified transcript
    // (anchored snapshot render). Every verification miss degrades to the
    // legacy full-reconstruction path or the 400 the client answers with a
    // full replay (lossless). Requires storage.unified=full (reads); default
    // 0% — force on with `rollout.features.wsDeltaContinuation: true` or
    // `BILI_ROLLOUT_WS_DELTA_CONTINUATION=1`.
    wsDeltaContinuation: { percent: 0 },
    // #2926 anthropic Threads reforge: when the mirrored thread history
    // crosses the window on a `continue`, swap it for a fresh `create`
    // carrying [summary, tail ring, delta]. Default 0% — threads traffic
    // stays byte-faithful passthrough. Mirror capture itself is always on
    // wherever the unified sidecar is available. Force on with
    // `rollout.features.anthropicThreadsReforge: true` or
    // `BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE=1`.
    anthropicThreadsReforge: { percent: 0 },
    // #3756 snapshot render: assemble the outbound prefix from the server-side
    // canonical transcript (unified storage) instead of re-deriving message
    // identity from client-resent bytes, making folded sessions immune to
    // codec/identity upgrades (#3752) and to client-side head
    // deletion/checkpointing (#3723). Degrades to the legacy path whenever the
    // rollout is off or the unified transcript cannot resolve. Default 0% —
    // force on with `BILI_ROLLOUT_SNAPSHOT_RENDER=1`.
    snapshotRender: { percent: 0 },
    // #4491 plugin-lane server history: pin message identity to client-supplied
    // message ids (the `biliMsgIds` body field on plugin-wire traffic) and
    // serve the outbound prefix from the server-owned transcript
    // (POST /__bili/plugin/render). The id-set algebra classifies vanishing
    // cohorts (compressed vs deleted) and detects generation switches.
    // Default 0% — force on with `BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY=1`.
    pluginLaneServerHistory: { percent: 0 },
};

export const BP_MAX = 10_000;

export type RolloutSource = "env" | "config" | "bucket" | "off";

export interface RolloutDecision {
    feature: string;
    enabled: boolean;
    /** Which tier decided: env override | config enabled | bucket math | not under rollout at all. */
    source: RolloutSource;
    /** The install's bucket for this feature's salt, [0, 10000). */
    bucket: number;
    /** The percent actually applied (basis points), for diagnostics. */
    percentBp: number;
    salt: string;
    base?: string;
}

/** Env var for one feature: `BILI_ROLLOUT_` + name as UPPER_SNAKE
 *  (camelCase / kebab-case both fold: "simhashV2" and "fold-guard" →
 *  BILI_ROLLOUT_SIMHASH_V2 / BILI_ROLLOUT_FOLD_GUARD). */
export function rolloutEnvName(feature: string): string {
    return "BILI_ROLLOUT_" + feature
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[-\s]+/g, "_")
        .replace(/[^A-Za-z0-9_]/g, "")
        .toUpperCase();
}

/** Deterministic bucket for (salt, id): sha256 → uint32 → [0, 10000). */
export function rolloutBucket(salt: string, id: string): number {
    return createHash("sha256").update(`${salt}\n${id}`).digest().readUInt32BE(0) % BP_MAX;
}

/** Clamp a user/config percent into basis points; invalid → undefined. */
function percentBp(v: unknown): number | undefined {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) return undefined;
    return Math.min(BP_MAX, Math.round(v * 100));
}

export interface RolloutCtx {
    /** Bucketing identity (the install id, or an explicit test override). */
    id: string;
    env?: NodeJS.ProcessEnv;
    /** Config tier; defaults to loadConfigFile().rollout. */
    file?: RolloutFileConfig;
}

function overrideFor(feature: string, file: RolloutFileConfig | undefined): RolloutFeatureOverride {
    const features = file?.features;
    if (!features || typeof features !== "object" || Array.isArray(features)) return {};
    const o = features[feature];
    // Shorthand forms users naturally write first: `x: true/false` = force
    // on/off, `x: 20` = percent 20. Dropping these silently (the object-only
    // read) left users believing they had forced a feature while the bucket
    // math still decided — flagged in #3062 review; keep every shorthand
    // meaningful instead of erroring.
    if (o === true) return { enabled: true };
    if (o === false) return { enabled: false };
    if (typeof o === "number" && Number.isFinite(o)) return { percent: o };
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
}

function resolveInternal(feature: string, ctx: RolloutCtx, visited: Set<string>): RolloutDecision {
    const env = ctx.env ?? process.env;
    const file = ctx.file ?? loadConfigFile().rollout;
    const o = overrideFor(feature, file);
    const plan = ROLLOUT_FEATURES[feature];
    const salt = typeof o.salt === "string" && o.salt.length > 0 ? o.salt : plan?.salt ?? feature;
    const base = typeof o.base === "string" && o.base.length > 0 ? o.base : plan?.base;
    const bucket = rolloutBucket(salt, ctx.id);
    const percent = percentBp(o.percent) ?? (plan ? percentBp(plan.percent) : undefined);

    const decided = (enabled: boolean, source: RolloutSource): RolloutDecision => ({
        feature, enabled, source, bucket,
        percentBp: percent ?? 0, salt, base,
    });

    // Tier 1: env force. "0"/"false" = off, anything else set = on (same
    // family as BILI_PERSIST / ACP_PASSTHROUGH).
    const envRaw = env[rolloutEnvName(feature)];
    if (envRaw !== undefined) return decided(envRaw !== "0" && envRaw !== "false", "env");

    // Tier 2: explicit config boolean — overrides any percentage.
    if (o.enabled === true) return decided(true, "config");
    if (o.enabled === false) return decided(false, "config");

    // Tier 3: bucketing. No percent from anywhere → the feature is not under
    // rollout → OFF (fail closed; unknown features never leak on).
    if (percent === undefined) return decided(false, "off");

    // Nested rollout: only installs already inside `base`'s cohort are
    // candidates. Cycles fail closed instead of looping.
    if (base !== undefined) {
        if (visited.has(base)) return decided(false, "off");
        const baseDecision = resolveInternal(base, ctx, visited.add(feature));
        if (!baseDecision.enabled) return decided(false, "off");
    }
    return decided(bucket < percent, "bucket");
}

/** Resolve one feature's rollout decision (pure over its ctx). */
export function resolveRollout(feature: string, ctx: RolloutCtx): RolloutDecision {
    return resolveInternal(feature, ctx, new Set());
}

/** Decisions for every registered feature (startup log / diagnostics). */
export function rolloutDecisions(id: string): RolloutDecision[] {
    return Object.keys(ROLLOUT_FEATURES).sort().map((f) => resolveRollout(f, { id }));
}

// --- stable per-install identity --------------------------------------------

/** Resolve+create the install id file. Cached per resolved path so test seams
 *  relocating XDG_STATE_HOME get independent ids within one process. */
const idCache = new Map<string, string>();

function rolloutIdFile(): string {
    return path.join(stateDir(), "rollout-id.json");
}

function readIdFile(file: string): string | undefined {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: unknown };
        return typeof parsed.id === "string" && /^[0-9a-f-]{8,}$/i.test(parsed.id) ? parsed.id : undefined;
    } catch {
        return undefined;
    }
}

/** The stable rollout identity for this machine: config `rollout.installId`
 *  when pinned (support/testing), else the persisted state-dir UUID. On an
 *  unwritable state dir the fallback derives from the home+host — stable
 *  across restarts even when nothing can be persisted. */
export function rolloutInstallId(): string {
    const pinned = loadConfigFile().rollout?.installId;
    if (typeof pinned === "string" && pinned.trim().length > 0) return pinned.trim();
    const file = rolloutIdFile();
    const cached = idCache.get(file);
    if (cached !== undefined) return cached;
    const existing = readIdFile(file);
    if (existing !== undefined) {
        idCache.set(file, existing);
        return existing;
    }
    const generated = randomUUID();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // "wx": concurrent processes race to create exactly one file; losers
        // keep the winner's id, so the identity stays single-valued. A file
        // that EXISTS but does not parse (hand-mangled) is healed in place with
        // the fresh id — next boot is stable again on whichever write won.
        try {
            fs.writeFileSync(file, JSON.stringify({ id: generated }, null, 2) + "\n", { flag: "wx" });
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            if (readIdFile(file) === undefined) {
                loggerLog("warn", `[rollout] install id file ${file} is unreadable — regenerating`);
                fs.writeFileSync(file, JSON.stringify({ id: generated }, null, 2) + "\n");
            }
        }
    } catch (e) {
        loggerLog("warn", `[rollout] cannot persist install id (${String(e)}) — falling back to a derived id`);
        // os lookups can throw on exotic hosts (uid with no passwd entry,
        // ENOSYS hostname) — the fallback itself must never take boot down.
        let hostname = "";
        let username = "";
        try { hostname = os.hostname(); } catch { /* degraded: "" */ }
        try { username = os.userInfo().username; } catch { /* degraded: "" */ }
        const derived = derivedInstallId(process.env.HOME ?? process.env.USERPROFILE ?? "", hostname, username);
        idCache.set(file, derived);
        return derived;
    }
    const settled = readIdFile(file) ?? generated;
    idCache.set(file, settled);
    return settled;
}

/** Deterministic fallback id for hosts where the state dir cannot be written.
 * Cross-platform on purpose: os.hostname() (NOT process.env.HOSTNAME, which
 * is a bash-ism and is absent on Windows — every such Windows box used to
 * collide on one shared derived id and move through cohorts in lockstep),
 * the OS home (USERPROFILE on Windows), and the local user name. Same inputs
 * → same id across restarts, so the cohort stays sticky even on this path. */
export function derivedInstallId(home: string, hostname: string, username: string): string {
    return "derived-" + createHash("sha256").update(`${username}\n${hostname}\n${home}`).digest("hex").slice(0, 32);
}

/** One feature's effective gate, against the real install id. Call sites use
 *  this exactly where the feature's default would otherwise be a plain
 *  boolean. Resolves per call: env/config hot-edits flip without a restart. */
export function featureEnabled(feature: string): boolean {
    return resolveRollout(feature, { id: rolloutInstallId() }).enabled;
}

// #2607-style warn-once for rollout config that silently does nothing:
// unknown features with no resolvable force, non-object entries the resolver
// must ignore, and wrong-typed enabled/percent that fail strict equality /
// percentBp and fall back to the bucket without a word ("enabled": "true").
// Every one of these used to no-op silently — the user believed the force
// had taken hold while the bucket still decided (#3062 review).
let warnedInertSignature: string | null = null;
export function warnRolloutConfigProblems(): void {
    const file = loadConfigFile().rollout;
    const features = file?.features;
    if (!features || typeof features !== "object" || Array.isArray(features)) return;
    const problems: string[] = [];
    for (const [name, raw] of Object.entries(features).sort(([a], [b]) => a.localeCompare(b))) {
        // Shorthands accepted by overrideFor are real config — except a
        // number outside 0–100, which percentBp rejects: the value would be
        // dropped with zero feedback (silent OFF, or silent fall-back to the
        // baked-in plan), so name it like every other ignored entry.
        if (raw === true || raw === false) continue;
        if (typeof raw === "number") {
            if (percentBp(raw) !== undefined) continue;
            problems.push(`${name} (ignored: must be a number 0–100, got ${JSON.stringify(raw)})`);
            continue;
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            problems.push(`${name} (ignored: not an override object — use {enabled: true}, {percent: 20}, true, false, or a bare number)`);
            continue;
        }
        if (ROLLOUT_FEATURES[name] === undefined && raw.enabled === undefined && percentBp(raw.percent) === undefined) {
            problems.push(`${name} (no effect: feature not under rollout in this version — typo? not yet shipped here?)`);
            continue;
        }
        if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
            problems.push(`${name}.enabled (ignored: must be a boolean, got ${typeof raw.enabled} — quotes around true/false?)`);
        }
        if (raw.percent !== undefined && percentBp(raw.percent) === undefined) {
            problems.push(`${name}.percent (ignored: must be a number 0–100, got ${JSON.stringify(raw.percent)})`);
        }
    }
    if (problems.length === 0) return;
    const signature = problems.join("\u0000");
    if (warnedInertSignature === signature) return;
    warnedInertSignature = signature;
    loggerLog("warn", `[rollout] config problems — these entries do nothing until fixed: ${problems.join("; ")}`);
}
