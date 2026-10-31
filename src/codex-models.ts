import snapshot from "./codex-models-snapshot.json" with { type: "json" };
import fs from "node:fs";
import path from "node:path";
import { readCodexConfig, resolveCodexHome, type CodexConfig } from "./client-config.js";
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

let liveTable: { key: string; models: CodexModelEntry[] } | undefined;

function positiveWindow(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** #5243: which surface produced a codex-aligned window — named in the clamp
 *  log so "window clamped" stops claiming client metadata when no client
 *  metadata existed. */
export type CodexWindowSource =
    | "client-metadata"
    | "codex-catalog"
    | "codex-models-cache"
    | "codex-config-window"
    | "bundled-snapshot"
    | "codex-fallback";

function parseModelTable(raw: unknown): CodexModelEntry[] {
    const obj = raw as { models?: unknown } | null;
    const list = obj && Array.isArray(obj.models) ? obj.models : undefined;
    if (!list) return [];
    const models: CodexModelEntry[] = [];
    for (const v of list) {
        if (!v || typeof v !== "object") continue;
        const value = v as Record<string, unknown>;
        if (typeof value.slug !== "string" || !value.slug) continue;
        const contextWindow = positiveWindow(value.context_window);
        const maxContextWindow = positiveWindow(value.max_context_window);
        if (contextWindow === undefined && maxContextWindow === undefined) continue;
        const percent = value.effective_context_window_percent ?? 95;
        if (typeof percent !== "number" || !Number.isInteger(percent) || percent <= 0 || percent > 100) continue;
        models.push({ slug: value.slug, contextWindow, maxContextWindow, effectiveContextWindowPercent: percent });
    }
    return models;
}

/** #5243: files that may hold codex's live model table, best first — the
 *  catalog file `config.toml`'s `model_catalog_json` points at (the catalog
 *  install writes ONLY this; `models_cache.json` may be absent entirely),
 *  then the default cache location. A relative catalog path resolves against
 *  $CODEX_HOME. */
function liveTableCandidates(cfg: CodexConfig, codexHome: string): Array<{ file: string; source: "codex-catalog" | "codex-models-cache" }> {
    const out: Array<{ file: string; source: "codex-catalog" | "codex-models-cache" }> = [];
    const raw = cfg.modelCatalogJson?.trim();
    if (raw) out.push({ file: path.isAbsolute(raw) ? raw : path.resolve(codexHome, raw), source: "codex-catalog" });
    out.push({ file: path.join(codexHome, "models_cache.json"), source: "codex-models-cache" });
    return out;
}

/** 本机 Codex 的模型元数据（catalog / models_cache）比发布时的模型表更新；只读模型元数据，不读取认证或会话。#5243：返回产生窗口的来源面（诊断用）。 */
export function readCodexLiveModelWindow(model: string, codexHome: string): { window: number; source: "codex-catalog" | "codex-models-cache" | "codex-config-window" } | undefined {
    const cfg = readCodexConfig(codexHome);
    const configured = positiveWindow(cfg.contextWindow);
    for (const candidate of liveTableCandidates(cfg, codexHome)) {
        let models: CodexModelEntry[];
        try {
            const stat = fs.statSync(candidate.file);
            const key = `${candidate.file}|${stat.ino}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.size}`;
            if (liveTable?.key !== key) liveTable = { key, models: parseModelTable(JSON.parse(fs.readFileSync(candidate.file, "utf8"))) };
            models = liveTable.models;
        } catch {
            continue;
        }
        const entry = lookupModel(model, models);
        if (entry) {
            const window = configured === undefined ? resolvedWindow(entry) : Math.min(configured, entry.maxContextWindow ?? configured);
            return { window: Math.floor(window * (entry.effectiveContextWindowPercent ?? 95) / 100), source: candidate.source };
        }
        // A readable table IS codex's authority even when the model is absent
        // from it (#5243) — no fall-through to the other file.
        break;
    }
    // #5243 item 2: no readable table at all, but config.toml declared a
    // context window — size from the operator's own number instead of the
    // flat 272K fallback (which is what made nudge bands fire at ~35% real
    // usage). Used verbatim: without a table entry nothing caps it.
    if (configured !== undefined) return { window: configured, source: "codex-config-window" };
    return undefined;
}

/** Backwards-compatible accessor (tests / legacy call sites). */
export function readCodexModelWindow(model: string, codexHome: string): number | undefined {
    return readCodexLiveModelWindow(model, codexHome)?.window;
}

function alignedResult(limit: number, w: number, source: CodexWindowSource): { limit: number; clamped: boolean; source: CodexWindowSource } {
    return limit > w ? { limit: w, clamped: true, source } : { limit, clamped: false, source };
}

export function codexAlignedWindow(
    limit: number,
    model: string,
    headers: Record<string, string | string[] | undefined>,
    clientWindow?: number,
): { limit: number; clamped: boolean; source?: CodexWindowSource } {
    if (!isCodexClient(headers)) return { limit, clamped: false };
    const cw = positiveWindow(clientWindow);
    if (cw !== undefined) return alignedResult(limit, cw, "client-metadata");
    const live = readCodexLiveModelWindow(model, resolveCodexHome(process.env));
    if (live !== undefined) return alignedResult(limit, live.window, live.source);
    return alignedResult(limit, codexWindowForModel(model), lookupModel(model, TABLE) ? "bundled-snapshot" : "codex-fallback");
}

/** Test hook: replace the bundled table (mirrors registry._setForTest). */
export function _setCodexTableForTest(models: CodexModelEntry[]): void {
    TABLE = models.map((m) => ({ ...m }));
}

export function _resetCodexTableForTest(): void {
    TABLE = PRISTINE.map((m) => ({ ...m }));
}
