import type { Session } from "./session.js";
import { peekRegistryCostRow, scanRegistryCostRow, type CostRow, type CostsShape } from "./registry.js";

/**
 * #4899: per-model billing prices ($ per million tokens).
 *
 * Two faces share this module:
 *  - SPEND accounting: every upstream usage report settles a running USD
 *    ledger on `session.stats.costUsd` (input / cacheRead / cacheWrite /
 *    output), billed at the price stamped on the session by the request
 *    that produced the report (latest-wins, like `activePack`).
 *  - SAVINGS estimate: the web panel prices fold economics with the same
 *    `{w,r,q}` profile the cache report already uses
 *    (`metadata.cachePriceProfile`) — see `savedUsdFromFolds`.
 *
 * Resolution priority: user overrides (`billing.prices` in the config file)
 * win over the models.dev registry snapshot. Overrides resolve through the
 * SAME name matching as the registry (roots/variants/case-fold/host
 * provider namespace), so `"anthropic/claude-sonnet-4-5"`, a bare
 * `"claude-sonnet-4-5"`, and case drift all hit.
 *
 * Billing fallbacks are deliberately CONSERVATIVE and differ from the
 * economics-profile fallbacks (kernel ratios r=0.1w, q=4w): a spend
 * estimate must never invent a discount — absent cacheRead/cacheWrite/output
 * bill at the input rate, and a row without a usable input price yields no
 * price at all (the session shows tokens only, never fake dollars).
 */

export interface BillingPrice {
    /** $ per 1M input tokens. Required — a price anchored on nothing bills nothing honestly. */
    input: number;
    /** $ per 1M output tokens. Defaults to the input rate when absent. */
    output?: number;
    /** $ per 1M cache-READ tokens. Defaults to the input rate when absent. */
    cacheRead?: number;
    /** $ per 1M cache-WRITE tokens. Defaults to the input rate when absent. */
    cacheWrite?: number;
}

interface BillingSettings {
    prices: Record<string, BillingPrice>;
}

interface ResolvedBillingPrice {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    source: "config" | "registry";
}

/** Parse the root `billing` block. Returns undefined on ANY shape violation —
 *  the caller drops the whole block (loud-reject discipline, #155): a typo'd
 *  field must never silently no-op into "no pricing". */
export function parseBillingSettings(value: unknown): BillingSettings | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) return undefined;
    const root = value as Record<string, unknown>;
    if (root["prices"] === undefined) {
        for (const k of Object.keys(root)) if (k !== "prices") return undefined;
        return { prices: {} };
    }
    if (typeof root["prices"] !== "object" || Array.isArray(root["prices"])) return undefined;
    const prices: Record<string, BillingPrice> = {};
    for (const [key, entry] of Object.entries(root["prices"] as Record<string, unknown>)) {
        if (!key || key.length > 256) return undefined;
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
        const o = entry as Record<string, unknown>;
        for (const k of Object.keys(o)) {
            if (k !== "input" && k !== "output" && k !== "cacheRead" && k !== "cacheWrite") return undefined;
        }
        const input = posNum(o.input);
        if (input === undefined) return undefined;
        const p: BillingPrice = { input };
        // Present-but-invalid optional values reject the whole block (loud,
        // #155): `output: -1` is a typo, not "use the default".
        const out = nonNegNumStrict(o.output);
        if (out === REJECT) return undefined;
        if (out !== undefined) p.output = out;
        const cacheRead = nonNegNumStrict(o.cacheRead);
        if (cacheRead === REJECT) return undefined;
        if (cacheRead !== undefined) p.cacheRead = cacheRead;
        const cacheWrite = nonNegNumStrict(o.cacheWrite);
        if (cacheWrite === REJECT) return undefined;
        if (cacheWrite !== undefined) p.cacheWrite = cacheWrite;
        prices[key] = p;
    }
    return { prices };
}

function posNum(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function nonNegNum(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Tri-state for optional fields: undefined = absent, REJECT = present but invalid. */
const REJECT = Symbol("reject");
function nonNegNumStrict(v: unknown): number | undefined | typeof REJECT {
    if (v === undefined) return undefined;
    return nonNegNum(v) !== undefined ? (v as number) : REJECT;
}

/** Module-level override table — set by loadOptions (startup + every config
 *  reload path funnels through it) and by nothing else. Keeps deep settle
 *  sites free of options plumbing, mirroring the registry costCache pattern. */
let overridePrices: Record<string, BillingPrice> = {};

export function setBillingOverrides(prices: Record<string, BillingPrice> | undefined): void {
    overridePrices = prices ?? {};
}

export function billingOverrides(): Record<string, BillingPrice> {
    return overridePrices;
}

function overrideCosts(): CostsShape | null {
    const keys = Object.keys(overridePrices);
    if (keys.length === 0) return null;
    const costs: CostsShape = {};
    for (const k of keys) {
        const v = overridePrices[k];
        if (v === undefined) continue;
        costs[k] = { input: v.input, output: v.output, cache_read: v.cacheRead, cache_write: v.cacheWrite };
    }
    return costs;
}

export function resolveBillingPrice(model: string | undefined, host?: string): ResolvedBillingPrice | undefined {
    if (!model) return undefined;
    const costs = overrideCosts();
    if (costs !== null) {
        const hit = scanRegistryCostRow(costs, model, host, { conflictHint: "billing.prices" });
        if (hit) return finalize(hit.row, "config");
    }
    const row = peekRegistryCostRow(model, host);
    return row !== undefined ? finalize(row, "registry") : undefined;
}

function finalize(row: CostRow, source: "config" | "registry"): ResolvedBillingPrice {
    const input = row.input;
    return {
        input,
        output: row.output ?? input,
        cacheRead: row.cache_read ?? input,
        cacheWrite: row.cache_write ?? input,
        source,
    };
}

/** Stamp the resolved price on the session (per request, latest-wins) so
 *  settle-time billing never re-resolves and always matches the model that
 *  produced the report — a mid-session model switch reprices immediately.
 *  Model-less requests keep the previous stamp. */
export function stampBillingPrice(session: Session, model: string | undefined, host?: string): void {
    if (model === undefined || model === "") return;
    const p = resolveBillingPrice(model, host);
    if (p !== undefined) {
        session.metadata.billingPrice = { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite, source: p.source, model };
    } else {
        delete session.metadata.billingPrice;
    }
}

/** Metadata is persisted user-editable JSON — re-validate on read (same
 *  discipline as stampedPriceProfile): only finite non-negative numbers
 *  survive; a corrupt stamp disables billing for the session instead of
 *  poisoning the ledger. */
export function stampedBillingPrice(session: Session): ResolvedBillingPrice | undefined {
    const v = session.metadata?.billingPrice;
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const o = v as Record<string, unknown>;
    const input = posNum(o.input);
    if (input === undefined) return undefined;
    const out: ResolvedBillingPrice = { input, source: o.source === "config" ? "config" : "registry", output: nonNegNum(o.output) ?? input, cacheRead: nonNegNum(o.cacheRead) ?? input, cacheWrite: nonNegNum(o.cacheWrite) ?? input };
    return out;
}

/** Bill one settled usage report's input side: fresh input at the input
 *  rate, cache reads at cacheRead, cache writes (anthropic-style creation)
 *  at cacheWrite. `total` is the normalized prompt total (split semantics:
 *  fresh + read + creation; inclusive semantics: cached folded in). */
export function billInputUsage(session: Session, s: { total: number; cached: number | null; creation?: number }): void {
    const price = stampedBillingPrice(session);
    if (price === undefined || !(s.total > 0)) return;
    const st = session.stats.costUsd ?? (session.stats.costUsd = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    const cached = Math.max(0, s.cached ?? 0);
    const creation = Math.max(0, s.creation ?? 0);
    const fresh = Math.max(0, s.total - cached - creation);
    st.input += (fresh * price.input) / 1e6;
    st.cacheRead += (Math.min(cached, Math.max(0, s.total)) * price.cacheRead) / 1e6;
    st.cacheWrite += (creation * price.cacheWrite) / 1e6;
}

/** Bill output tokens — called exactly where stats.outputTokens accumulates. */
export function billOutputUsage(session: Session, out: number): void {
    if (!(out > 0)) return;
    const price = stampedBillingPrice(session);
    if (price === undefined) return;
    const st = session.stats.costUsd ?? (session.stats.costUsd = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    st.output += (out * price.output) / 1e6;
}

/** Money mirror of the fold economics (#4899): the same `{w,r,q}` profile the
 *  cache report prices with, applied to the same per-fold decomposition the
 *  panel already shows in tokens (netSaved = Σ[(S−σ)·ra − T − σ]).
 *  per-fold $ = (S−σ)·ra·r − [(w−r)·T + q·σ − r·S] — avoided turns priced at
 *  the cache-read rate, the fold re-upload at the write premium, the summary
 *  at the output rate (kernel/cache-report.ts computeFoldEconomics). Can go
 *  negative for folds that have not paid back yet — honest, like the token
 *  display. Returns undefined when no profile is stamped: never priced on
 *  fabricated defaults. */
export function savedUsdFromFolds(
    folds: Array<{ S?: number; sigma?: number; T?: number; requestsAfter?: number }>,
    profile: { w?: number; r?: number; q?: number } | undefined,
): number | undefined {
    if (!profile || typeof profile !== "object") return undefined;
    const w = typeof profile.w === "number" && Number.isFinite(profile.w) && profile.w >= 0 ? profile.w : undefined;
    const r = typeof profile.r === "number" && Number.isFinite(profile.r) && profile.r >= 0 ? profile.r : undefined;
    const q = typeof profile.q === "number" && Number.isFinite(profile.q) && profile.q >= 0 ? profile.q : undefined;
    if (w === undefined || r === undefined || q === undefined) return undefined;
    let total = 0;
    let seen = false;
    for (const f of folds) {
        const S = f.S ?? 0, sig = f.sigma ?? 0, T = f.T ?? 0, ra = f.requestsAfter ?? 0;
        seen = true;
        const perTurn = (S - sig) * ra * r;
        const oneTime = (w - r) * T + q * sig - r * S;
        total += (perTurn - oneTime) / 1e6;
    }
    return seen ? total : undefined;
}
