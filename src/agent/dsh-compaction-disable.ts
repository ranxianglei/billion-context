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
// #7190: runtime-registered presets (a plugin calling
// ctx.agentPresets.register(definition) from JS after boot) bypass EVERY
// config layer: dsh's registry mounts the definition's nested rows straight
// into its in-memory PresetTree without the internal/config transform the
// loader runs, and no boot-time file can name a row that does not exist yet.
// The register() wrap extends the SAME disable verdict to that birth point —
// definition.plugins rows carrying compaction packages are rewritten to
// disabled:true before the registry mounts them. Without it the preset's
// compaction engine is fully armed (per-step pressure + model-switch
// pre-compaction + overflow recovery) while bili's wire guard refuses every
// call: the #7062 refusal storm, the #7178 model-switch dead-end, and the
// #7169 landed-checkpoint rebase clobber are all that engine firing.

/** The two dsh packages whose backends must not instantiate while bili owns the lane. */
const DSH_COMPACTION_BASIC_PACKAGE = "@deepseek-ai/dsh-compaction-basic";
const DSH_COMMAND_COMPACT_PACKAGE = "@deepseek-ai/dsh-command-compact";
/** The agent-preset entry whose resolved config carries the plugin rows. */
const DSH_AGENT_PRESET_PACKAGE = "@deepseek-ai/dsh-agent-preset";
/** Gate service name the bundle patch and the launcher overlay used to gate
 *  the four Web presets on. #7111: that gate is gone — an entry-level inject is
 *  fail-closed (no optional dependency, no timeout, no fallback), so a missing
 *  service bricked session creation instead of degrading compression. The name
 *  is still published as a presence marker (see `dsh-compaction-gate.ts`), so
 *  older profiles keep activating and external diagnostics keep resolving it.
 *  Coexistence with the upstream plugin is safe: its service name differs and
 *  both overlays are idempotent (disabled:true twice = disabled:true). */
export const BILI_COMPACTION_DISABLE_SERVICE = "biliBasicCompactionPolicy";

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
    /** #7190: runtime preset registrations rewritten at register(). */
    runtime?: Array<{ entry: string; rows: number }>;
    /** #7190: the register() wrap is installed — from here a runtime zero is
     *  a covered zero, not an unknown. */
    runtimeWrapped?: boolean;
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

/** #7190: record a runtime preset registration rewritten at register()
 *  (same max-across-calls discipline as the load-time coverage). */
function noteRuntimePresetCoverage(entry: string, rows: number): void {
    if (rows === 0) return;
    const store = globalThis as Record<string, unknown>;
    const current = store[DSH_COMPACTION_GATE_TELEMETRY_KEY] as DshCompactionGateTelemetry | undefined;
    const telemetry: DshCompactionGateTelemetry = current ?? { covered: [], sawFactoryPreset: false };
    const runtime = telemetry.runtime ?? [];
    const existing = runtime.find((r) => r.entry === entry);
    if (existing === undefined) telemetry.runtime = [...runtime, { entry, rows }];
    else if (rows > existing.rows) existing.rows = rows;
    store[DSH_COMPACTION_GATE_TELEMETRY_KEY] = telemetry;
}

/** #7190: the register() wrap installed in this process. */
function noteRuntimeWrapped(): void {
    const store = globalThis as Record<string, unknown>;
    const current = store[DSH_COMPACTION_GATE_TELEMETRY_KEY] as DshCompactionGateTelemetry | undefined;
    const telemetry: DshCompactionGateTelemetry = current ?? { covered: [], sawFactoryPreset: false };
    if (telemetry.runtime === undefined) telemetry.runtime = [];
    telemetry.runtimeWrapped = true;
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

/** #6770: one-line coverage summary shared by the durable profile notes (#3962)
 *  and bili-native's first-request log line. Pure over the record; "no entry
 *  rewritten" is the honest frame because preset configs resolve lazily. */
export function compactionCoverageText(telemetry: DshCompactionGateTelemetry | null = dshCompactionGateTelemetry()): string {
    let base: string;
    if (telemetry === null || telemetry.covered.length === 0) {
        base = "no preset entry rewritten in this process (preset configs resolve lazily — zero at this point does not mean zero later)";
    } else {
        const entries = telemetry.covered.map((c) => `${c.entry}\u00d7${c.rows}`).join(", ");
        base = `${telemetry.covered.length} preset ${telemetry.covered.length === 1 ? "entry" : "entries"} rewritten (${entries})`;
    }
    // #7190: the runtime dimension is stated only once the wrap is known to be
    // installed — an absent runtimeWrapped key (older gate, or a host without
    // the registry) means "unknown", never "gap".
    if (telemetry?.runtimeWrapped) {
        const runtime = telemetry.runtime ?? [];
        const fragment = runtime.length === 0
            ? "register() covered — no runtime preset registrations so far"
            : `${runtime.length} runtime preset ${runtime.length === 1 ? "registration" : "registrations"} rewritten (${runtime.map((r) => `${r.entry}\u00d7${r.rows}`).join(", ")})`;
        base = `${base}; ${fragment}`;
    }
    return base;
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

// #7190: registered symbol so the wrap marker survives the bundle/host realm
// split and a re-apply never double-wraps the same registry instance.
const PRESET_REGISTER_WRAP_MARK = Symbol.for("bili.dshPresetRegisterWrapped");

type PresetRegistry = { register?: (definition: unknown) => Promise<unknown> } & Record<string, unknown>;

function presetRegistryOf(ctx: CompactionDisableHost): PresetRegistry | undefined {
    if (ctx.agentPresets !== undefined) return ctx.agentPresets;
    if (typeof ctx.get !== "function") return undefined;
    const candidate = ctx.get("agentPresets");
    return candidate === null || typeof candidate !== "object" ? undefined : candidate as PresetRegistry;
}

/**
 * #7190: extend the #4147 disable verdict to a RUNTIME-registered preset
 * definition. Pure and identity-preserving: no compaction row — or the lane
 * not declared owned — returns the definition byte-for-byte untouched, so the
 * registry's own validation and mount see exactly what they would without the
 * wrap.
 */
export function disableRuntimePresetCompaction(definition: unknown): unknown {
    if (definition === null || typeof definition !== "object") return definition;
    const def = definition as { id?: unknown; plugins?: unknown };
    if (typeof def.id !== "string" || !Array.isArray(def.plugins)) return definition;
    if (!isDshCompactionActive()) return definition;
    const rows = countCompactionRows(def.plugins as readonly unknown[]);
    if (rows === 0) return definition;
    noteRuntimePresetCoverage(def.id.slice(0, 120), rows);
    return { ...def, plugins: disableBasicCompaction(def.plugins as readonly unknown[]) };
}

/**
 * #7190: wrap agentPresets.register() so a preset definition born AFTER boot
 * (the only path a runtime preset takes) carries the same disabled compaction
 * rows the load-time overlay writes for stock presets. Idempotent per instance
 * (Symbol-for mark); degrades silently when the host exposes no registry —
 * a host without it cannot runtime-register presets, so nothing is uncovered.
 */
export function installRuntimePresetCoverage(ctx: CompactionDisableHost): void {
    const registry = presetRegistryOf(ctx);
    if (registry === undefined || typeof registry.register !== "function") return;
    if ((registry as Record<PropertyKey, unknown>)[PRESET_REGISTER_WRAP_MARK] === true) return;
    const original = registry.register;
    registry.register = (definition: unknown) => original.call(registry, disableRuntimePresetCompaction(definition));
    (registry as Record<PropertyKey, unknown>)[PRESET_REGISTER_WRAP_MARK] = true;
    noteRuntimeWrapped();
}

export type CompactionDisableHost = {
    on?: (event: string, listener: (raw: unknown, next: () => unknown) => unknown, options?: { global?: boolean }) => void;
    reflect?: { provide?: (name: string, value: unknown) => void } | undefined;
    // #7190: dsh's preset registry (service 'agentPresets') — present only on
    // profiles that ship it; optional like every other host surface here.
    agentPresets?: PresetRegistry | undefined;
    // #7190: cordis' generic service accessor (returns undefined for a
    // non-provided service, per dsh's own tool-subagent usage).
    get?: (name: string) => unknown;
};
type MiddlewareSelf = { entry?: { options?: { name?: unknown } } | undefined };

/** Entry option name carried by the fiber that owns a config resolution.
 *  The host dispatches `internal/config` as `waterfall('internal/config',
 *  fiber, next)` — the first argument is the event NAME, so cordis binds no
 *  `this` (vendor/cordis/src/events.ts:163 → thisArg null) and the listener
 *  receives `(fiber, next)`. Reading `this` therefore always yields
 *  undefined; the name lives on the first argument. */
export function entryNameOf(fiber: unknown): string | undefined {
    const name = (fiber as MiddlewareSelf | undefined)?.entry?.options?.name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
}

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
        ctx.on("internal/config", function (fiber: unknown, next: () => unknown): unknown {
            const resolved = next();
            // #3662: honor the process verdict — without an active declaration
            // from bili-native every row passes through stock.
            if (!isDshCompactionActive()) return resolved;
            // #4147: match STRUCTURALLY, not by entry name — custom presets run
            // their compaction inside nested rows under their own entry, and a
            // name filter leaves exactly those armed. Rewrite only when the
            // tree actually nests a compaction row, so unrelated entries keep
            // their resolved config object identity.
            const config = (resolved ?? {}) as { plugins?: unknown };
            if (!Array.isArray(config.plugins)) return resolved;
            const compactionRows = countCompactionRows(config.plugins);
            if (compactionRows === 0) return resolved;
            const rawName = entryNameOf(fiber);
            const entryName = typeof rawName === "string" ? rawName : "unnamed-entry";
            noteGateCoverage(entryName.slice(0, 120), compactionRows, entryName === DSH_AGENT_PRESET_PACKAGE);
            return { ...config, plugins: disableBasicCompaction(config.plugins) };
        }, { global: true });
    }
    // Publish only after the middleware is registered; the host owns both lifetimes.
    ctx.reflect?.provide?.(BILI_COMPACTION_DISABLE_SERVICE, Object.freeze({ owner: "billion-context", issue: "#3354" }));
    // #7190: the register() wrap covers the one row population no config layer
    // can reach — runtime preset definitions. Bundles apply in composition
    // order (this entry is inserted before profile plugins), so the wrap is in
    // place before a plugin's register() runs; the verdict is honored per call,
    // and the wrap is idempotent across re-apply.
    installRuntimePresetCoverage(ctx);
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
type HostPlaneEntry = {
    options?: { id?: unknown; name?: unknown; disabled?: unknown; config?: unknown } | undefined;
};

/** Rows whose `auto:false` the bundle patch no longer owns in the COMPOSED
 *  tree: a dsh patch replaces a row's whole `config`, and `compaction-basic`
 *  defaults `auto` to true, so any later layer that restates this row (a hand
 *  written profile patch, a later bundle, a partial #2474 snapshot) silently
 *  re-arms native auto-compaction. Disabled rows are stock web-profile
 *  behaviour and are not reported. Returns the offending entry ids so the
 *  caller can alarm; empty = the declaration survived. */
export function hostPlaneRowsMissingAutoFalse(entries: Iterable<unknown>): string[] {
    const lost: string[] = [];
    for (const raw of entries) {
        if (raw === null || typeof raw !== "object") continue;
        const options = (raw as HostPlaneEntry).options;
        if (options === undefined || options.name !== DSH_COMPACTION_BASIC_PACKAGE) continue;
        if (options.disabled === true) continue;
        const config = options.config;
        const auto = config !== null && typeof config === "object" && !Array.isArray(config)
            ? (config as { auto?: unknown }).auto
            : undefined;
        if (auto === false) continue;
        lost.push(typeof options.id === "string" && options.id.length > 0 ? options.id : DSH_COMPACTION_BASIC_PACKAGE);
    }
    return lost;
}

/** One-line alarm for the rows hostPlaneRowsMissingAutoFalse reported. */
export function hostPlaneOverrideLostWarning(entryIds: readonly string[]): string {
    const rows = entryIds.map((id) => JSON.stringify(id)).join(", ");
    return `bili: the host-plane compaction-basic override is GONE (entry ${rows}): a later patch layer replaced that row's whole config, so "auto" fell back to its default true and dsh native auto-compaction is ARMED again. Restate "auto: false" in the LAST patch row that touches id compaction-basic, or remove that override (a landed checkpoint destroys the fold base).`;
}

type ReconcileEntry = {
    options?: { id?: unknown; name?: unknown; config?: unknown } | undefined;
    update?: (options: { config: unknown }, create?: boolean, force?: boolean) => unknown;
};

/** #7111: fail-open replacement for the retired preset inject gate. The four
 *  Web presets are mounted before this entry activates, so their resolved
 *  config already carries live compaction rows; re-submitting that config
 *  restarts each entry and the `internal/config` middleware above rewrites the
 *  rows exactly as it does on a cold resolve. Entries that never nest a
 *  compaction row, and hosts whose entries expose no `update`, are left alone.
 *  Returns how many entries were re-submitted (0 = nothing to do, which is the
 *  only outcome a missing gate service can now produce). */
export function reconcileLoadedPresets(entries: Iterable<unknown>): number {
    let touched = 0;
    for (const raw of entries) {
        if (raw === null || typeof raw !== "object") continue;
        const entry = raw as ReconcileEntry;
        const config = entry.options?.config;
        if (config === null || typeof config !== "object" || Array.isArray(config)) continue;
        const plugins = (config as { plugins?: unknown }).plugins;
        if (!Array.isArray(plugins) || countCompactionRows(plugins) === 0) continue;
        if (typeof entry.update !== "function") continue;
        const next = { ...(config as Record<string, unknown>), plugins: disableBasicCompaction(plugins) };
        try {
            entry.update({ config: next });
            touched += 1;
        } catch {
            // A failing reconcile must never take the gate entry down with it.
        }
    }
    return touched;
}
