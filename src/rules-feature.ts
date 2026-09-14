import {
    addRule,
    formatRulesList,
    listRules,
    resolveRuleLimits,
    type Config,
} from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import type { Session } from "./session.js";

const EFFECTIVE_RULES_KEY = "effectiveRules";

export function rulesEnabled(config: Config): boolean {
    return config.rules?.enabled === true;
}

// Two config sources exist (same split as absorb): wire paths carry the
// per-request resolved Config, while the plugin tool API resolves sessions
// without a request context and falls back to the base kernel Config —
// prepare* therefore stores the last resolved rules block per session for
// that path to read.
export function effectiveRulesConfig(session: Session | undefined, fallback: Config): NonNullable<Config["rules"]> | undefined {
    const meta = session?.metadata[EFFECTIVE_RULES_KEY];
    if (meta && typeof meta === "object" && typeof (meta as Record<string, unknown>).enabled === "boolean") {
        return meta as NonNullable<Config["rules"]>;
    }
    return fallback.rules;
}

export function storeEffectiveRules(session: Session, config: Config): void {
    session.metadata[EFFECTIVE_RULES_KEY] = config.rules ?? null;
}

export type RuleExecCtx = {
    config: Config;
    session: Session;
    log?: (msg: string) => void;
};

// Execute one acp_rule call against the session (streaming loop and plugin
// tool API share this). A `rule` argument records a short principle-level
// reminder; omitting it lists the recorded rules for human review. Validation
// failures are normal outcomes returned verbatim (no FAILED marker) — they
// tell the model how to fix the input, they are not proxy errors.
export function executeRule(args: Record<string, unknown>, ctx: RuleExecCtx): string {
    const log = ctx.log ?? ((msg: string) => loggerLog("info", msg));
    const state = ctx.session.state;
    const raw = args.rule;
    const rule = typeof raw === "string" ? raw.trim() : "";
    if (rule.length === 0) {
        const rules = listRules(state);
        return rules.length === 0 ? "No rules recorded." : formatRulesList(rules);
    }
    const result = addRule(state, rule, resolveRuleLimits(ctx.config));
    if (!result.ok) {
        log(`[acp-rule] ${result.error}`);
        return result.error;
    }
    log(`[acp-rule] added ${result.rule.id}: ${result.rule.text}`);
    return `Recorded ${result.rule.id}: ${result.rule.text}`;
}
