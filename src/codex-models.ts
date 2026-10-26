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

let liveTable: { key: string; models: CodexModelEntry[] } | undefined;

function positiveWindow(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 本机 Codex 的缓存比发布时的模型表更新；只读模型元数据，不读取认证或会话。 */
export function readCodexModelWindow(model: string, codexHome: string): number | undefined {
    const file = path.join(codexHome, "models_cache.json");
    try {
        const stat = fs.statSync(file);
        const key = `${file}|${stat.ino}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.size}`;
        if (liveTable?.key !== key) {
            const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
            if (!parsed || typeof parsed !== "object" || !("models" in parsed) || !Array.isArray(parsed.models)) return undefined;
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
        const entry = lookupModel(model, liveTable.models);
        if (!entry) return undefined;
        const configured = positiveWindow(readCodexConfig(codexHome).contextWindow);
        const window = configured === undefined ? resolvedWindow(entry) : Math.min(configured, entry.maxContextWindow ?? configured);
        return Math.floor(window * (entry.effectiveContextWindowPercent ?? 95) / 100);
    } catch {
        return undefined;
    }
}

export function codexAlignedWindow(
    limit: number,
    model: string,
    headers: Record<string, string | string[] | undefined>,
    clientWindow?: number,
): { limit: number; clamped: boolean } {
    if (!isCodexClient(headers)) return { limit, clamped: false };
    const w = positiveWindow(clientWindow) ?? readCodexModelWindow(model, resolveCodexHome(process.env)) ?? codexWindowForModel(model);
    if (limit > w) return { limit: w, clamped: true };
    return { limit, clamped: false };
}

/** Test hook: replace the bundled table (mirrors registry._setForTest). */
export function _setCodexTableForTest(models: CodexModelEntry[]): void {
    TABLE = models.map((m) => ({ ...m }));
}

export function _resetCodexTableForTest(): void {
    TABLE = PRISTINE.map((m) => ({ ...m }));
}
