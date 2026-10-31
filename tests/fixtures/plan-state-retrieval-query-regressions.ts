/**
 * Reviewed adversarial supplement discovered after the initial 28-case run.
 * These are regression cases, not an independent held-out quality estimate.
 * Query/labels were recorded before replacing the full-query boolean guard.
 */
import { PLAN_RETRIEVAL_CASES, type PlanRetrievalCase } from "./plan-state-retrieval-cases.ts";

const variants = [
    { id: "jwt-question-mark", baseId: "explicit-completed-jwt", query: "token JWT issuer?", initialStatusAwareTop1: "b2", rationale: "A question mark does not change the explicit request for JWT issuer history; token and JWT still identify that block." },
    { id: "jwt-unmatched-modifier", baseId: "explicit-completed-jwt", query: "token JWT issuer behavior", initialStatusAwareTop1: "b2", rationale: "The unmatched word behavior must not erase the explicit JWT issuer terms and let the current rate limiter replace the requested evidence." },
    { id: "cdn-unmatched-modifier", baseId: "explicit-completed-cdn", query: "cache CDN purge details", initialStatusAwareTop1: "b3", rationale: "The generic request for details still names the completed CDN purge work, not the current database cache task." },
    { id: "chinese-question-mark", baseId: "explicit-completed-gateway", query: "网关 超时 截止时间？", initialStatusAwareTop1: "b4", rationale: "句末问号不改变回查网关设计的意图；网关和超时这两个完整查询词仍能区分数据库任务。" },
] as const;

export const PLAN_QUERY_REGRESSION_CASES: readonly (PlanRetrievalCase & { initialStatusAwareTop1: string })[] = variants.map((variant) => {
    const base = PLAN_RETRIEVAL_CASES.find((fixture) => fixture.id === variant.baseId);
    if (!base) throw new Error(`Missing regression base fixture: ${variant.baseId}`);
    return { ...base, id: variant.id, query: variant.query, rationale: variant.rationale, initialStatusAwareTop1: variant.initialStatusAwareTop1 };
});
