// #3354: stand dsh's native basic compaction down at LOAD TIME — vendored from
// deshark42/dsh-compaction-basic-disable v0.1.1 (MIT © 2026 deshark42,
// https://github.com/deshark42/dsh-compaction-basic-disable), ported into
// bili's own bundle layer at the author's suggestion (their repo issue #1).
// The overlay marks the preset rows disabled instead of copying or overwriting
// the official preset configs, so upstream preset updates keep working without
// re-copying a frozen snapshot — the #2474 full-snapshot recipe stays as the
// fallback for dsh builds whose internal 'internal/config' hook moved.
//
// Why it exists: when bili carries a dsh conversation it owns compression
// (#1729); a dsh compaction checkpoint landing outside bili's knowledge
// durably shadows the raw history and destroys the compression substrate.
// Non-web profiles already stand down the host-plane row via the bundle patch
// (auto:false); web profiles run their instance INSIDE an agent preset whose
// nested rows no patch layer can address by id (#1772/#2360) — this module is
// what reaches them.
// #3662: the overlay lives in its OWN always-on entry (dsh-compaction-gate.ts)
// rather than in bili-native — disabling or kill-switching bili-native must
// leave the gate service alive so the presets fall back to STOCK dsh
// compaction instead of pending forever (the old wiring bricked session
// creation on exactly that path). The transform honors the process verdict
// declared by bili-native's apply(); an absent declaration means bili-native
// never ran and every row passes through stock.
// #4147: the transform matches STRUCTURALLY — any entry whose resolved config
// nests compaction-basic/command-compact rows in a plugins tree gets them
// disabled, not just the factory @deepseek-ai/dsh-agent-preset entry. Custom
// presets (preset-general, profile-local rosters, …) run their compaction
// inside their own nested rows no patch layer can address by id (#1772), so
// the row-name match is the only coverage that does not rot when a profile
// ships ids the bundle patch never knew about (#3962).
// #3962: every rewrite is recorded in a process-global telemetry record so
// bili-native can surface which entries the overlay actually covered (the
// bundle-patch gate rows may target ids a profile does not ship — their miss
// is otherwise visible only in the host loader log).

import { logHostEvent } from "./host-log.js";

/** The two dsh packages whose backends must not instantiate while bili owns the lane. */
const DSH_COMPACTION_BASIC_PACKAGE = "@deepseek-ai/dsh-compaction-basic";
const DSH_COMMAND_COMPACT_PACKAGE = "@deepseek-ai/dsh-command-compact";
/** The agent-preset entry whose resolved config carries the plugin rows. */
const DSH_AGENT_PRESET_PACKAGE = "@deepseek-ai/dsh-agent-preset";
/** Gate service name referenced by the preset `inject:` entries in
 *  dsh.bundle.patch.yml and the launcher overlay patch. A preset cannot
 *  register until this service is provided, so the middleware below is
 *  guaranteed registered before any protected preset resolves its config even
 *  when sibling imports finish out of order. #3662: the provider is the
 *  always-on gate entry (dsh-compaction-gate.ts), NOT bili-native — disabling
 *  or kill-switching bili-native must keep the latch satisfiable so the
 *  presets fall back to stock instead of pending forever; only disabling the
 *  gate entry itself leaves them pending (see the bundle patch header).
 *  Coexistence with the upstream plugin is safe: its service name differs and
 *  both overlays are idempotent (disabled:true twice = disabled:true). */
export const BILI_COMPACTION_DISABLE_SERVICE = "biliBasicCompactionPolicy";
/** The four Web agent presets the overlay must reach (dsh-web-app roster;
 *  preset-minimal ships no compaction group today — the row is a no-op there
 *  and future-proofs it if one lands). */
const DSH_WEB_PRESET_IDS = ["preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"] as const;

/** The bundle-patch rows gating each Web preset on the overlay service — the
 *  single source of truth shared by the launcher overlay string and pinned
 *  against dsh.bundle.patch.yml by tests (the two layers must stay in sync,
 *  cf. #2605). Entry inject lists are REPLACED by patches, not concatenated —
 *  if a future dsh ships its own inject list on these entries, merge manually
 *  here AND in both patch layers. */
export function compactionDisablePatchRows(): string {
    return DSH_WEB_PRESET_IDS.map((id) => `- id: ${id}\n  inject: [${BILI_COMPACTION_DISABLE_SERVICE}]\n`).join("");
}

// #3662: process-level verdict between the two entries. They are SEPARATE
// bundles in the dsh host (separate module instances — module state cannot
// cross them), and globalThis is the only surface both share. bili-native's
// apply() declares active once its plan says bili owns the lane; an ABSENT
// declaration means bili-native never ran in this process (entry disabled,
// kill-switched before the declaration, or its module failed to load) and the
// transform leaves every row stock. Availability over fail-safe-brick: a dead
// bili-native hands the lane back to stock dsh compaction, with the wire-level
// refusal guard (#1729) as backstop.
const DSH_COMPACTION_VERDICT_KEY = "__BILI_DSH_COMPACTION_VERDICT__";

/** bili-native calls this from apply() when its plan keeps the lane owned. */
export function declareDshCompactionActive(): void {
    (globalThis as Record<string, unknown>)[DSH_COMPACTION_VERDICT_KEY] = "active";
}

export function isDshCompactionActive(): boolean {
    return (globalThis as Record<string, unknown>)[DSH_COMPACTION_VERDICT_KEY] === "active";
}

/** Test hook: forget any declaration (back to "bili-native never ran"). */
export function _resetDshCompactionVerdictForTest(): void {
    delete (globalThis as Record<string, unknown>)[DSH_COMPACTION_VERDICT_KEY];
}

// #3962: the gate entry and bili-native are SEPARATE bundles (module state
// cannot cross them), so the rewrite telemetry rides the same globalThis
// channel as the verdict. bili-native reads it when composing its durable
// coverage note; an absent record means the transform has not rewritten
// anything yet in this process.
const DSH_COMPACTION_GATE_TELEMETRY_KEY = "__BILI_DSH_COMPACTION_GATE_TELEMETRY__";

export type DshCompactionGateTelemetry = {
    /** Entry option names whose resolved config the transform rewrote, with
     *  the compaction row count disabled per entry (max across resolutions). */
    covered: Array<{ entry: string; rows: number }>;
    /** True once at least one covered entry is the factory agent-preset
     *  package (the only entry the pre-#4147 name filter ever reached). */
    sawFactoryPreset: boolean;
};

function noteGateCoverage(entryName: string, rows: number, isFactory: boolean): void {
    const store = globalThis as Record<string, unknown>;
    const current = store[DSH_COMPACTION_GATE_TELEMETRY_KEY] as DshCompactionGateTelemetry | undefined;
    const telemetry: DshCompactionGateTelemetry = current ?? { covered: [], sawFactoryPreset: false };
    const existing = telemetry.covered.find((c) => c.entry === entryName);
    if (existing === undefined) {
        telemetry.covered = [...telemetry.covered, { entry: entryName, rows }];
    } else if (rows > existing.rows) {
        existing.rows = rows;
    }
    if (isFactory) telemetry.sawFactoryPreset = true;
    store[DSH_COMPACTION_GATE_TELEMETRY_KEY] = telemetry;
}

/** Coverage record of the #3354 load-time overlay in this process (null =
 *  the transform has not rewritten any entry yet). */
export function dshCompactionGateTelemetry(): DshCompactionGateTelemetry | null {
    const record = (globalThis as Record<string, unknown>)[DSH_COMPACTION_GATE_TELEMETRY_KEY];
    return record === undefined ? null : record as DshCompactionGateTelemetry;
}

/** Test hook: forget any recorded coverage. */
export function _resetDshCompactionGateTelemetryForTest(): void {
    delete (globalThis as Record<string, unknown>)[DSH_COMPACTION_GATE_TELEMETRY_KEY];
}

type PresetRow = { name?: unknown; group?: unknown; config?: unknown };

/** Count compaction-basic/command-compact rows the disable walk would mark
 *  (recursing through group rows with the SAME shape gate as
 *  disableBasicCompaction, so telemetry counts never drift from what the
 *  rewrite actually did). Zero = nothing to rewrite here. */
function countCompactionRows(rows: readonly unknown[]): number {
    let n = 0;
    for (const row of rows) {
        if (row === null || typeof row !== "object") continue;
        const r = row as PresetRow;
        if (r.name === DSH_COMPACTION_BASIC_PACKAGE || r.name === DSH_COMMAND_COMPACT_PACKAGE) n += 1;
        else if (r.group && Array.isArray(r.config)) n += countCompactionRows(r.config);
    }
    return n;
}

/** Mark every compaction row of a preset plugins tree disabled. Pure: returns
 *  detached copies and never mutates the input rows (the resolved config may
 *  be shared with other consumers). */
export function disableBasicCompaction(rows: readonly unknown[]): unknown[] {
    return rows.map((row) => {
        if (row === null || typeof row !== "object") return row;
        const r = row as PresetRow & Record<string, unknown>;
        if (r.name === DSH_COMPACTION_BASIC_PACKAGE || r.name === DSH_COMMAND_COMPACT_PACKAGE) {
            return { ...r, disabled: true };
        }
        if (r.group && Array.isArray(r.config)) {
            return { ...r, config: disableBasicCompaction(r.config) };
        }
        return row;
    });
}

export type CompactionDisableHost = {
    on?: (event: string, listener: (raw: unknown, next: () => unknown) => unknown, options?: { global?: boolean }) => void;
    reflect?: { provide?: (name: string, value: unknown) => void } | undefined;
};
type MiddlewareSelf = { entry?: { options?: { name?: unknown } } | undefined };

/** Register the load-time overlay + publish the gate. Runs from the always-on
 *  gate entry's apply() (dsh-compaction-gate.ts, #3662) — NOT from bili-native,
 *  whose disable/kill-switch must not take the service with it. The provide
 *  happens AFTER the middleware registers so the inject gate can never be
 *  satisfied before the transform is live. Degradation is per-layer and
 *  fail-safe: no `on` → the host predates the internal/config hook, the
 *  wire-level refusal guard (#1729) stays the backstop; no `reflect.provide`
 *  → the presets simply never see the gate and boot as they did pre-#3354. */
export function registerCompactionDisable(ctx: CompactionDisableHost): void {
    if (typeof ctx.on === "function") {
        // Preset entries must carry the gate: sibling imports may finish out of order.
        ctx.on("internal/config", function (this: MiddlewareSelf, _raw: unknown, next: () => unknown): unknown {
            const resolved = next();
            // #3662: honor the process verdict — without an active declaration
            // from bili-native every row passes through stock.
            if (!isDshCompactionActive()) return resolved;
            const rawName = this?.entry?.options?.name;
            const entryName = typeof rawName === "string" ? rawName : "unnamed-entry";
            // #3712: this middleware is global and fires for EVERY package's config
            // resolution — anything other than the factory preset is an expected
            // pass-through (logging it would spam), so only the preset's outcomes
            // below are observable. The genuine silent-miss there: we ARE the preset
            // (gate satisfied) but its resolved shape changed so the overlay cannot
            // reach the nested compaction rows — dsh native compaction would run
            // while bili owns compression, and pre-fix that was indistinguishable
            // from success using only bili.log.
            const isFactoryPreset = entryName === DSH_AGENT_PRESET_PACKAGE;
            const config = (resolved ?? {}) as { plugins?: unknown };
            if (!Array.isArray(config.plugins)) {
                if (isFactoryPreset) logHostEvent("warn", "[dsh-client]", `compaction-disable overlay MISSED on ${DSH_AGENT_PRESET_PACKAGE}: resolved config has no plugins array — nested compaction rows were NOT stood down (#3354)`);
                return resolved;
            }
            // #4147: match STRUCTURALLY, not by entry name — custom presets run
            // their compaction inside nested rows under their own entry, and a
            // name filter leaves exactly those armed. Rewrite only when the
            // tree actually nests a compaction row, so unrelated entries keep
            // their resolved config object identity.
            const compactionRows = countCompactionRows(config.plugins);
            if (compactionRows === 0) {
                if (isFactoryPreset) logHostEvent("warn", "[dsh-client]", `compaction-disable overlay MISSED on ${DSH_AGENT_PRESET_PACKAGE}: resolved plugins tree has no compaction rows — dsh native compaction NOT stood down (#3354)`);
                return resolved;
            }
            noteGateCoverage(entryName.slice(0, 120), compactionRows, isFactoryPreset);
            if (isFactoryPreset) logHostEvent("info", "[dsh-client]", `compaction-disable overlay applied to ${DSH_AGENT_PRESET_PACKAGE}: nested compaction rows stood down (${compactionRows} rows, #3354)`);
            return { ...config, plugins: disableBasicCompaction(config.plugins) };
        }, { global: true });
    }
    // Publish only after the middleware is registered; the host owns both lifetimes.
    ctx.reflect?.provide?.(BILI_COMPACTION_DISABLE_SERVICE, Object.freeze({ owner: "billion-context", issue: "#3354" }));
}

type CompactionOverlayGap = "no-config-hook" | "no-service-provide";

/** Why the #3354 load-time overlay cannot latch on this host (null = latched).
 *  Mirrors registerCompactionDisable's own capability checks: without `on` the
 *  internal/config transform never installs, and without reflect.provide the
 *  preset inject latch never opens — either way dsh native basic compaction
 *  stays ARMED. Exposed so the caller can turn the SILENT fail-safe degradation
 *  into a loud boot-time alarm (#3806) instead of letting the user discover an
 *  armed compactor days later through a destroyed fold base. */
export function detectCompactionOverlayGap(ctx: CompactionDisableHost): CompactionOverlayGap | null {
    if (typeof ctx.on !== "function") return "no-config-hook";
    if (typeof ctx.reflect?.provide !== "function") return "no-service-provide";
    return null;
}
