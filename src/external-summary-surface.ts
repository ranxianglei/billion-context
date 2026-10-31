import { FUNCTION_ACP_TAGS_TIMESTAMPED, LEAN_HOW_TO_COMPRESS, LEAN_HOW_TO_COMPRESS_TIMESTAMPED, type CompressPromptSections } from "acp-kernel";
import type { ResolvedKernelConfig } from "./compress-settings.js";
import { AUTO_FOLD_TARGET_MIN } from "./external-summary-settings.js";
import { loadConfigFile, resolveMessageTimestamps } from "./config.js";

export const EXTERNAL_SUMMARY_NOTE = "\n\n[External summary mode: the conversation model selects consumed ranges; the configured independent summary service generates the authoritative summary. Use object-form content: [{startId, endId, topic?}]. summary is optional and, if supplied, only a non-authoritative hint, not the committed summary. Selected source text and read-only context are sent to the configured service using its separate credentials. All candidates failing leaves originals unchanged. This mode overrides instructions above requiring you to write the final summary.]";

/** External-summary mode for one request, decided by the request's own
 *  resolved Config (three-level cascade, same as every other compress field):
 *  `config.externalSummary?.enabled === true`. The settings ride the
 *  ResolvedKernelConfig rail from resolveRequestConfig → storeEffectiveConfig,
 *  so no consumer re-reads the config file. */
export function externalSummaryEnabled(config: unknown): boolean {
    return (config as ResolvedKernelConfig | undefined)?.externalSummary?.enabled === true;
}

/** #4460: section overrides for the CONVERSATION-side compress prompt. In
 *  external-summary mode the conversation model only selects ranges; the
 *  independent service writes the committed summary and gets the rules in its
 *  own request (session.meta.summaryInstructions). The summary-writing rules
 *  (howToCompress, ~1.5K tokens) are then dead weight on every conversation
 *  request, so the section is dropped there. Philosophy (when to compress)
 *  stays. Never apply this to the summary request's own instructions. */
export function conversationPromptSections(sections: CompressPromptSections | undefined, external: boolean): CompressPromptSections | undefined {
    return external ? { ...sections, howToCompress: null } : sections;
}

/** #4313 (PR #5236): host-exit selection of the timestamped prompt variants.
 *  Flag OFF (the default) ⇒ returns the input BY REFERENCE — pre-#4313 bytes,
 *  zero drift. Flag ON ⇒ copies `sections` and fills exactly the gaps the
 *  pre-feature defaults used to carry the stamped wording in: the function-
 *  builder acpTags slot when unclaimed (custom/lean/pack strings and explicit
 *  `null` deletions win over the variant — same priority as every
 *  SectionOverride) and the lean-pack how-to-compress block by identity match
 *  (the full default never carried the diary-line rule, so nothing else
 *  swaps). Hybrid builders keep their plain one-line ACP TAGS in both states. */
export function messageTimestampSections(
    sections: CompressPromptSections | undefined,
    kind: "function" | "hybrid" = "function",
): CompressPromptSections | undefined {
    if (!resolveMessageTimestamps(loadConfigFile().compress)) return sections;
    const out: CompressPromptSections = { ...sections };
    if (kind === "function" && out.acpTags === undefined) out.acpTags = FUNCTION_ACP_TAGS_TIMESTAMPED;
    if (out.howToCompress === LEAN_HOW_TO_COMPRESS) out.howToCompress = LEAN_HOW_TO_COMPRESS_TIMESTAMPED;
    return out;
}

/** Upper bound (ms) on how long the proxy needs to execute a summary-producing
 *  tool call while the external chain is active: the chain's totalTimeoutMs batch
 *  deadline. The executor's per-batch deadline bounds the whole batch to it, so one
 *  compress call cannot run longer. Advertised in the plugin manifest so agent-side
 *  tool bridges size their HTTP wait to the ACTUAL server ceiling instead of a fixed
 *  constant that silently starves any budget raised above it (#2652). Undefined when
 *  the chain is disabled: classic model-written summaries commit locally and are fast,
 *  so bridges keep their base timeout then. */
export function externalSummaryMaxToolDurationMs(config: unknown): number | undefined {
    const ext = (config as ResolvedKernelConfig | undefined)?.externalSummary;
    const total = ext?.budget?.totalTimeoutMs;
    return ext?.enabled === true && typeof total === "number" && Number.isFinite(total) && total > 0 ? total : undefined;
}

/** [#autoFold] Growth folding is active for a request when the rail carries
 *  an ENABLED external chain that switched autoFold on. An unresolvable
 *  target collapses the chain to enabled=false (expandExternalSummaryChain
 *  -Tolerant), so this flips false and classic nudges come back — the
 *  fail-open path. */
function autoFoldActive(config: unknown): boolean {
    const ext = (config as ResolvedKernelConfig | undefined)?.externalSummary;
    return ext?.enabled === true && ext.autoFold === true;
}

/** [#autoFold] Backoff: when a growth-armed fold cannot reach its target
 *  (external chain down), pausing auto-fold for a while restores BOTH the
 *  classic overflow-only preflight AND the wire nudges — without this, a
 *  dead chain would leave the session with no compression channel at all
 *  (nudges suppressed, folds failing). Structural session type keeps this
 *  module import-leaf clean. */
export const AUTO_FOLD_BACKOFF_MS = 10 * 60_000;

function autoFoldBackoffActive(session: { metadata?: Record<string, unknown> } | undefined): boolean {
    const until = session?.metadata?.autoFoldBackoffUntil;
    return typeof until === "number" && until > Date.now();
}

export function armAutoFoldBackoff(session: { metadata?: Record<string, unknown> } | undefined): void {
    if (!session) return;
    (session.metadata ?? (session.metadata = {})).autoFoldBackoffUntil = Date.now() + AUTO_FOLD_BACKOFF_MS;
}

/** [#3444] Measured irreducible floor of this session (system prompt + tool
 *  schemas + live tail), recorded by an exhausted growth pass that could not
 *  reach its target. Latest measurement wins (tracks baseline drift both ways);
 *  a fresh session id starts unmeasured. Undefined until measured or invalid. */
export function autoFoldFloor(session: { metadata?: Record<string, unknown> } | undefined): number | undefined {
    const value = session?.metadata?.autoFoldFloorTokens;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** #2662: every external-summary batch of this invocation was dropped by the
 *  shared pool before a single candidate call dispatched. That shape is
 *  scheduler congestion (transient by nature), NOT evidence the summary chain
 *  failed — arming the full backoff on it would cost the session 10 minutes
 *  of auto-fold for a problem the pool itself will clear. */
export function externalQueueDroppedAll(dispatch: { calls: number; attempts: number } | undefined): boolean {
    return dispatch !== undefined && dispatch.calls > 0 && dispatch.attempts === 0;
}

/** Nudge suppression + growth trigger share this gate: auto-fold is only
 *  "engaged" while the chain is on AND not in backoff. */
export function autoFoldEngaged(config: unknown, session: { metadata?: Record<string, unknown> } | undefined): boolean {
    return autoFoldActive(config) && !autoFoldBackoffActive(session);
}

/** [#autoFold] Is growth folding actually ARMED for this request's window?
 *  The wire prepares suppress classic nudges while auto-fold is engaged —
 *  but on degenerate windows the rail folds nothing: the AUTO_FOLD_TARGET_MIN
 *  clamp pushes the target up to the overflow target (window <= MIN, or the
 *  codex-intercept lane's lowered bar below ~2xMIN), and an explicit
 *  autoFoldTargetTokens >= the overflow target clamps the same way. Leaving
 *  suppression keyed on engagement alone would silence nudges forever with
 *  no fold and no backoff able to arm (PR #2581 review) — suppression must
 *  require a target strictly below the overflow bar. overflowTarget:
 *  preflight's effective bar (the codex lane lowers it); omit to use
 *  config.modelContextLimit. measuredFloor: the session's measured
 *  irreducible floor (#3444) — a floor at/above the bar means even an
 *  exhausted fold cannot reach the target, so the bar itself is unreachable
 *  and suppression must release (classic nudges are the remaining channel).
 *  Mirrors the target math in server.ts's preflight — keep the two in sync. */
export function growthFoldingArmed(config: unknown, overflowTarget?: number, measuredFloor?: number): boolean {
    const resolved = config as ResolvedKernelConfig | undefined;
    const ext = resolved?.externalSummary;
    if (ext?.enabled !== true || ext.autoFold !== true) return false;
    const overflow = overflowTarget ?? resolved?.modelContextLimit ?? 0;
    if (!(overflow > 0)) return false;
    const configured = ext.autoFoldTargetTokens ?? Math.round(overflow / 2);
    const target = Math.max(AUTO_FOLD_TARGET_MIN, Math.min(configured, overflow), measuredFloor ?? 0);
    return target < overflow;
}

function adaptSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(adaptSchema);
    if (!value || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        result[key] = key === "required" && Array.isArray(child) ? child.filter((name) => name !== "summary") : adaptSchema(child);
    }
    const properties = result.properties as Record<string, unknown> | undefined;
    if (properties?.summary) properties.summary = { type: "string", description: "Optional non-authoritative hint; the independent service generates the committed summary." };
    return result;
}

/** Preserve protocol wrappers and unrelated tools; never mutate shared kernel constants. */
export function withExternalSummaryTools<T>(tools: readonly T[], enabled: boolean): T[] {
    if (!enabled) return [...tools];
    return tools.map((tool) => {
        const copy = structuredClone(tool) as T & { name?: string; description?: string; parameters?: unknown; input_schema?: unknown; function?: { name?: string; description?: string; parameters?: unknown } };
        const declaration = copy.function ?? copy;
        if (declaration.name !== "compress") return tool;
        declaration.description = "Compress selected consumed ranges using the configured independent summary service." + EXTERNAL_SUMMARY_NOTE;
        if (declaration.parameters) declaration.parameters = adaptSchema(declaration.parameters);
        if (copy.input_schema) copy.input_schema = adaptSchema(copy.input_schema);
        return copy;
    });
}
