import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import snapshot from "./codex-models-snapshot.json" with { type: "json" };
import { isCodexClient } from "./codex-compact.js";
import { readCodexConfig, resolveCodexHome } from "./client-config.js";

export { isCodexClient };

/** One entry of codex's bundled model table (slim form — see
 *  scripts/update-codex-models-snapshot.mjs). Mirrors the window fields of
 *  codex-rs `protocol/src/openai_models.rs` ModelInfo that drive its budget. */
export interface CodexModelEntry {
    slug: string;
    contextWindow?: number;
    maxContextWindow?: number;
    autoCompactTokenLimit?: number;
    effectiveContextWindowPercent?: number;
}

interface CodexModelsSnapshot {
    source: string;
    fetchedAt: string;
    count: number;
    models: CodexModelEntry[];
}

const SNAPSHOT = snapshot as CodexModelsSnapshot;
// #1953: the live table owns its own array AND its entries — aliased from
// SNAPSHOT it would be mutated by _setCodexTableForTest, leaving reset with
// nothing original to restore. Entries are all scalars today; a nested field
// would need a deeper copy here and in the setter.
const PRISTINE: CodexModelEntry[] = SNAPSHOT.models.map((m) => ({ ...m }));
let TABLE: CodexModelEntry[] = PRISTINE.map((m) => ({ ...m }));

/** codex's unknown-model fallback window (codex-rs
 *  models-manager/src/model_info.rs `model_info_from_slug`:
 *  context_window = max_context_window = 272_000). A model that matches NO
 *  table slug is NOT "unperceived" by codex — it auto-compacts at 90% of
 *  this, so the min() alignment must treat it as perceived at 272K. */
export const CODEX_FALLBACK_CONTEXT_WINDOW = 272_000;

/** codex's perceived window for a model = resolved_context_window() =
 *  context_window.or(max_context_window) (openai_models.rs). */
function resolvedWindow(m: CodexModelEntry): number {
    return m.contextWindow ?? m.maxContextWindow ?? CODEX_FALLBACK_CONTEXT_WINDOW;
}

/** Longest-prefix match of `model` against an explicit entry list (the slug
 *  must prefix the requested model). Shared by the bundled-table lookup and the
 *  live-CODEX_HOME lookup so both use identical match discipline. */
function longestPrefixMatchIn(entries: CodexModelEntry[], model: string): CodexModelEntry | undefined {
    let best: CodexModelEntry | undefined;
    for (const m of entries) {
        if (!model.startsWith(m.slug)) continue;
        if (!best || m.slug.length > best.slug.length) best = m;
    }
    return best;
}

/** codex's table lookup (models-manager/src/manager.rs
 *  `construct_model_info_from_candidates`) over one entry list: longest-prefix
 *  match where the REQUESTED model starts with the slug, then a single
 *  namespaced-suffix retry (`custom/gpt-5.3-codex` → match on `gpt-5.3-codex`)
 *  for provider-like namespaces. Returns the matched entry or undefined. */
function matchEntry(entries: CodexModelEntry[], model: string): CodexModelEntry | undefined {
    const direct = longestPrefixMatchIn(entries, model);
    if (direct) return direct;
    const slash = model.indexOf("/");
    if (slash > 0) {
        const namespace = model.slice(0, slash);
        const suffix = model.slice(slash + 1);
        if (!suffix.includes("/") && /^[A-Za-z0-9_-]+$/.test(namespace)) {
            return longestPrefixMatchIn(entries, suffix);
        }
    }
    return undefined;
}

/** Emulates codex's perception from the BUNDLED snapshot only (no per-user
 *  override source exists there): the matched entry's resolved window, else the
 *  272K fallback. The live-CODEX_HOME base-config override is applied
 *  separately in localCodexPerceivedWindow (#2593). */
function lookupWindow(model: string): number {
    const m = matchEntry(TABLE, model);
    return m ? resolvedWindow(m) : CODEX_FALLBACK_CONTEXT_WINDOW;
}

/** The context window codex BELIEVES a model has (its own bundled table +
 *  272K fallback). codex auto-compacts at 90% of this and hard-stops at 95%,
 *  so bili must never budget a codex client above it (#321 PR-E1). */
export function codexWindowForModel(model: string): number {
    return lookupWindow(model);
}

interface CodexAlignOptions {
    /** #2593: true when the peer is the LOCAL codex (loopback) and no fresher
     *  window report reached the native chain — then align to this proxy's OWN
     *  CODEX_HOME live cache/base-config instead of only the bundled snapshot.
     *  Remote peers never set this (their host's cache is not this client's). */
    localPeer?: boolean;
}

export function codexAlignedWindow(
    limit: number,
    model: string,
    headers: Record<string, string | string[] | undefined>,
    options: CodexAlignOptions = {},
): { limit: number; clamped: boolean } {
    if (!isCodexClient(headers)) return { limit, clamped: false };
    const w = options.localPeer
        ? (localCodexPerceivedWindow(model) ?? codexWindowForModel(model))
        : codexWindowForModel(model);
    if (limit > w) return { limit: w, clamped: true };
    return { limit, clamped: false };
}

// ---- #2593: live CODEX_HOME source (read-only) ------------------------------
// The bundled snapshot goes stale whenever OpenAI ships a new model, so an unknown
// slug falls to the 272K floor even though THIS codex perceives its real (often
// larger) window — under-clamping long sessions into unnecessary preflight
// compaction / 502. For a LOCAL codex peer (loopback) with no fresher report the
// proxy reads its OWN CODEX_HOME (codex's live models_cache.json + base
// config.toml) and aligns to what codex actually believes. Remote proxies keep
// using reports/explicit config — their host's cache is not this client's.

interface LocalCodexSource {
    entries: CodexModelEntry[];
    /** top-level model_context_window from the BASE $CODEX_HOME/config.toml */
    configContextWindow?: number;
}

let injectedSource: LocalCodexSource | null | undefined;   // undefined = not injected
let diskSourceCache: { key: string; source: LocalCodexSource | null } | null = null;

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
}

function parseLocalEntries(raw: unknown): CodexModelEntry[] {
    let arr: unknown[] | null = null;
    if (Array.isArray(raw)) arr = raw;
    else if (raw && typeof raw === "object") {
        const models = (raw as Record<string, unknown>).models;
        if (Array.isArray(models)) arr = models as unknown[];
    }
    if (!arr) return [];
    const out: CodexModelEntry[] = [];
    for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const e0 = item as Record<string, unknown>;
        const slug = e0.slug;
        if (typeof slug !== "string" || slug.length === 0) continue;
        const e: CodexModelEntry = { slug };
        const cw = firstNumber(e0, ["context_window", "contextWindow"]);
        if (cw !== undefined) e.contextWindow = Math.floor(cw);
        const mw = firstNumber(e0, ["max_context_window", "maxContextWindow"]);
        if (mw !== undefined) e.maxContextWindow = Math.floor(mw);
        const pct = firstNumber(e0, ["effective_context_window_percent", "effectiveContextWindowPercent"]);
        if (pct !== undefined) e.effectiveContextWindowPercent = pct;
        out.push(e);
    }
    return out;
}

function loadDiskSource(): LocalCodexSource | null {
    const home = resolveCodexHome(process.env);
    const cachePath = path.join(home, "models_cache.json");
    const cfgPath = path.join(home, "config.toml");
    let cacheMtime = -1;
    let cfgMtime = -1;
    try { cacheMtime = statSync(cachePath).mtimeMs; } catch { /* absent */ }
    try { cfgMtime = statSync(cfgPath).mtimeMs; } catch { /* absent */ }
    if (cacheMtime < 0 && cfgMtime < 0) return null;
    const key = `${home}|${cacheMtime}|${cfgMtime}`;
    if (diskSourceCache && diskSourceCache.key === key) return diskSourceCache.source;
    let entries: CodexModelEntry[] = [];
    if (cacheMtime >= 0) {
        try { entries = parseLocalEntries(JSON.parse(readFileSync(cachePath, "utf8"))); } catch { entries = []; }
    }
    let configContextWindow: number | undefined;
    if (cfgMtime >= 0) configContextWindow = readCodexConfig(home).contextWindow;
    const source: LocalCodexSource | null = (entries.length > 0 || configContextWindow !== undefined)
        ? { entries, ...(configContextWindow !== undefined ? { configContextWindow } : {}) }
        : null;
    diskSourceCache = { key, source };
    return source;
}

function resolveLocalSource(): LocalCodexSource | null {
    if (injectedSource !== undefined) return injectedSource;
    return loadDiskSource();
}

/** #2593: the context window THIS codex perceives for `model`, read from the
 *  proxy's own CODEX_HOME (models_cache.json + base config.toml). Undefined when
 *  the model isn't matched or no valid total derives — callers fall back to the
 *  bundled snapshot then. Mirrors codex's budget math: total = base override ?
 *  min(override, max_context_window) : resolved window, × effective percent. */
export function localCodexPerceivedWindow(model: string): number | undefined {
    const source = resolveLocalSource();
    if (!source || source.entries.length === 0) return undefined;
    const entry = matchEntry(source.entries, model);
    if (!entry) return undefined;
    const ovr = source.configContextWindow;
    const total = ovr !== undefined && Number.isFinite(ovr)
        ? Math.min(ovr, entry.maxContextWindow ?? Number.MAX_SAFE_INTEGER)
        : (entry.contextWindow ?? entry.maxContextWindow);
    if (total === undefined || !Number.isFinite(total) || total <= 0) return undefined;
    const pctRaw = entry.effectiveContextWindowPercent;
    const pct = typeof pctRaw === "number" && Number.isFinite(pctRaw) ? pctRaw : 100;
    return Math.max(1, Math.floor((total * pct) / 100));
}

/** Test hook: replace the bundled table (mirrors registry._setForTest). */
export function _setCodexTableForTest(models: CodexModelEntry[]): void {
    TABLE = models.map((m) => ({ ...m }));
}

export function _resetCodexTableForTest(): void {
    TABLE = PRISTINE.map((m) => ({ ...m }));
}

/** Test hook: inject the live-CODEX_HOME source directly (bypasses disk). Pass
 *  null to simulate "no usable cache/config". */
export function _setLocalCodexSourceForTest(source: LocalCodexSource | null): void {
    injectedSource = source;
}

export function _resetLocalCodexSourceForTest(): void {
    injectedSource = undefined;
    diskSourceCache = null;
}
