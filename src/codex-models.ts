import snapshot from "./codex-models-snapshot.json" with { type: "json" };
import fs from "node:fs";
import path from "node:path";
import { readCodexConfig, resolveCodexHome } from "./client-config.js";
import { isCodexClient } from "./codex-compact.js";

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

/** Emulates codex's table lookup (models-manager/src/manager.rs
 *  `construct_model_info_from_candidates`): longest-prefix match where the
 *  REQUESTED model starts with the table slug, then a single namespaced-suffix
 *  retry (`custom/gpt-5.3-codex` → match on `gpt-5.3-codex`) for provider-like
 *  namespaces. The live and bundled tables use the same matching rules. */
function lookupModel(model: string, table: CodexModelEntry[]): CodexModelEntry | undefined {
    const direct = longestPrefixMatch(model, table);
    if (direct) return direct;
    const slash = model.indexOf("/");
    if (slash > 0) {
        const namespace = model.slice(0, slash);
        const suffix = model.slice(slash + 1);
        if (!suffix.includes("/") && /^[A-Za-z0-9_-]+$/.test(namespace)) {
            const m = longestPrefixMatch(suffix, table);
            if (m) return m;
        }
    }
    return undefined;
}

function longestPrefixMatch(model: string, table: CodexModelEntry[]): CodexModelEntry | undefined {
    let best: CodexModelEntry | undefined;
    for (const m of table) {
        if (!model.startsWith(m.slug)) continue;
        if (!best || m.slug.length > best.slug.length) best = m;
    }
    return best;
}

/** 发布时的 Codex 模型表及 272K 回退；有当前客户端信息时不能把它当作硬上限。 */
export function codexWindowForModel(model: string): number {
    const entry = lookupModel(model, TABLE);
    return entry ? resolvedWindow(entry) : CODEX_FALLBACK_CONTEXT_WINDOW;
}

/** Which source determined a codex client's aligned window — surfaced in the
 *  clamp/warn log lines so triage sees what actually won (#5246 piece 3). */
export type CodexWindowSource =
    | "client-report"          // a fresher client report (plugin/runtime/launcher)
    | "catalog-json"           // config.toml model_catalog_json live table
    | "models-cache"           // <CODEX_HOME>/models_cache.json live table
    | "config-context-window"  // no live table — sized from config.toml model_context_window
    | "bundled-snapshot"       // release-time bundled model table entry
    | "flat-fallback";         // CODEX_FALLBACK_CONTEXT_WINDOW (unknown model)

interface LiveResolution {
    window: number;
    source: "catalog-json" | "models-cache" | "config-context-window";
}

let liveTable: { key: string; models: CodexModelEntry[] } | undefined;

function positiveWindow(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

/** Parse ONE live codex model-table file into slim entries. Returns null when
 *  the file is absent/unreadable/malformed — leaving any prior cached table
 *  intact so a transient bad write never reuses stale entries (#2593). */
function parseLiveTable(file: string): CodexModelEntry[] | null {
    try {
        const stat = fs.statSync(file);
        const key = `${file}|${stat.ino}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.size}`;
        if (liveTable?.key !== key) {
            const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
            if (!parsed || typeof parsed !== "object" || !("models" in parsed) || !Array.isArray(parsed.models)) return null;
            const models: CodexModelEntry[] = [];
            for (const value of parsed.models) {
                if (!value || typeof value !== "object" || typeof value.slug !== "string" || !value.slug) continue;
                const contextWindow = positiveWindow(value.context_window);
                const maxContextWindow = positiveWindow(value.max_context_window);
                if (contextWindow === undefined && maxContextWindow === undefined) continue;
                const percent = value.effective_context_window_percent ?? 95;
                if (typeof percent !== "number" || !Number.isInteger(percent) || percent <= 0 || percent > 100) continue;
                models.push({ slug: value.slug, contextWindow, maxContextWindow, effectiveContextWindowPercent: percent });
            }
            liveTable = { key, models };
        }
        return liveTable.models;
    } catch {
        return null;
    }
}

/** The running codex's perceived window for a model, mirroring codex's own
 *  budget math. The live table beats the release-time snapshot — resolved from
 *  config.toml `model_catalog_json` when set, else `<CODEX_HOME>/models_cache.json`
 *  (#5246: custom-catalog installs have NO models_cache.json, which is why they
 *  fell through to the flat 272K floor). A base `model_context_window` override
 *  caps the entry's max_context_window. When NO live table is readable but
 *  config.toml declares model_context_window, size from that capped by the
 *  codex-known ceiling (bundled max_context_window, else the 272K unknown-model
 *  fallback) — never above what codex itself would perceive (#292 discipline).
 *  Read-only model metadata; never touches auth/sessions. */
function resolveLiveCodexWindow(model: string, codexHome: string): LiveResolution | null {
    const cfg = readCodexConfig(codexHome);
    const catalogRaw = cfg.modelCatalogJson;
    const catalogPath = nonEmptyString(catalogRaw)
        ? path.resolve(codexHome, catalogRaw)
        : path.join(codexHome, "models_cache.json");
    const catalogSource: "catalog-json" | "models-cache" = nonEmptyString(catalogRaw) ? "catalog-json" : "models-cache";
    const models = parseLiveTable(catalogPath);
    if (models) {
        const entry = lookupModel(model, models);
        if (entry) {
            const configured = positiveWindow(cfg.contextWindow);
            const window = configured === undefined ? resolvedWindow(entry) : Math.min(configured, entry.maxContextWindow ?? configured);
            return { window: Math.floor(window * (entry.effectiveContextWindowPercent ?? 95) / 100), source: catalogSource };
        }
    }
    const configured = positiveWindow(cfg.contextWindow);
    if (configured !== undefined) {
        const bundled = lookupModel(model, TABLE);
        const ceiling = bundled?.maxContextWindow ?? CODEX_FALLBACK_CONTEXT_WINDOW;
        const total = Math.min(configured, ceiling);
        return { window: Math.floor(total * (bundled?.effectiveContextWindowPercent ?? 95) / 100), source: "config-context-window" };
    }
    return null;
}

/** 本机 Codex 的活表窗口（含 config.toml 兜底）；只读模型元数据，不读取认证或会话。 */
export function readCodexModelWindow(model: string, codexHome: string): number | undefined {
    return resolveLiveCodexWindow(model, codexHome)?.window;
}

/** Detailed alignment: the aligned limit PLUS the source that won, so the
 *  caller can log what actually determined the value (#5246 piece 3). */
export function codexAlignedWindowDetailed(
    limit: number,
    model: string,
    headers: Record<string, string | string[] | undefined>,
    clientWindow?: number,
): { limit: number; clamped: boolean; source: CodexWindowSource | null } {
    if (!isCodexClient(headers)) return { limit, clamped: false, source: null };
    const cw = positiveWindow(clientWindow);
    if (cw !== undefined) {
        const clamped = limit > cw;
        return { limit: clamped ? cw : limit, clamped, source: "client-report" };
    }
    const live = resolveLiveCodexWindow(model, resolveCodexHome(process.env));
    if (live) {
        const clamped = limit > live.window;
        return { limit: clamped ? live.window : limit, clamped, source: live.source };
    }
    const bundled = lookupModel(model, TABLE);
    const w = bundled ? resolvedWindow(bundled) : CODEX_FALLBACK_CONTEXT_WINDOW;
    const clamped = limit > w;
    return { limit: clamped ? w : limit, clamped, source: bundled ? "bundled-snapshot" : "flat-fallback" };
}

/** Backward-compatible shape (pre-#5246): the aligned limit + clamp flag only. */
export function codexAlignedWindow(
    limit: number,
    model: string,
    headers: Record<string, string | string[] | undefined>,
    clientWindow?: number,
): { limit: number; clamped: boolean } {
    const d = codexAlignedWindowDetailed(limit, model, headers, clientWindow);
    return { limit: d.limit, clamped: d.clamped };
}

/** Test hook: replace the bundled table (mirrors registry._setForTest). */
export function _setCodexTableForTest(models: CodexModelEntry[]): void {
    TABLE = models.map((m) => ({ ...m }));
}

export function _resetCodexTableForTest(): void {
    TABLE = PRISTINE.map((m) => ({ ...m }));
}
