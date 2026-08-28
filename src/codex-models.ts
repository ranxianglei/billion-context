import snapshot from "./codex-models-snapshot.json" with { type: "json" };

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
const TABLE: CodexModelEntry[] = SNAPSHOT.models;

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
 *  namespaces, then the 272K fallback. Config overrides are intentionally NOT
 *  emulated — a user's `model_context_window` override can only clamp the
 *  perception DOWN (to max_context_window), never raise it, so the table
 *  value is the safe upper bound for alignment. */
function lookupWindow(model: string): number {
    const direct = longestPrefixMatch(model);
    if (direct) return resolvedWindow(direct);
    const slash = model.indexOf("/");
    if (slash > 0) {
        const namespace = model.slice(0, slash);
        const suffix = model.slice(slash + 1);
        if (!suffix.includes("/") && /^[A-Za-z0-9_-]+$/.test(namespace)) {
            const m = longestPrefixMatch(suffix);
            if (m) return resolvedWindow(m);
        }
    }
    return CODEX_FALLBACK_CONTEXT_WINDOW;
}

function longestPrefixMatch(model: string): CodexModelEntry | undefined {
    let best: CodexModelEntry | undefined;
    for (const m of TABLE) {
        if (!model.startsWith(m.slug)) continue;
        if (!best || m.slug.length > best.slug.length) best = m;
    }
    return best;
}

/** The context window codex BELIEVES a model has (its own bundled table +
 *  272K fallback). codex auto-compacts at 90% of this and hard-stops at 95%,
 *  so bili must never budget a codex client above it (#321 PR-E1). */
export function codexWindowForModel(model: string): number {
    return lookupWindow(model);
}

/** True when the request carries codex CLI's User-Agent. codex sets
 *  `{originator}/{version} (...)` with DEFAULT_ORIGINATOR = `codex_cli_rs`
 *  (login/src/auth/default_client.rs) on every request. */
export function isCodexClient(headers: Record<string, unknown>): boolean {
    const ua = headers["user-agent"];
    const list = Array.isArray(ua) ? ua : ua === undefined ? [] : [ua];
    return list.some((h) => typeof h === "string" && h.startsWith("codex_cli_rs/"));
}

/** E1 min() alignment: cap bili's effective window at codex's own perception
 *  when the client is codex. Non-codex clients and limits already at or below
 *  the perception pass through untouched. */
export function codexAlignedWindow(
    limit: number,
    model: string,
    headers: Record<string, unknown>,
): { limit: number; clamped: boolean } {
    if (!isCodexClient(headers)) return { limit, clamped: false };
    const w = codexWindowForModel(model);
    if (limit > w) return { limit: w, clamped: true };
    return { limit, clamped: false };
}

/** Test hook: replace the bundled table (mirrors registry._setForTest). */
export function _setCodexTableForTest(models: CodexModelEntry[]): void {
    TABLE.length = 0;
    TABLE.push(...models);
}

export function _resetCodexTableForTest(): void {
    _setCodexTableForTest([...SNAPSHOT.models]);
}
