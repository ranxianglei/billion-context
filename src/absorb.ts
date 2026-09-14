import {
    ABSORB_TOOL_NAME,
    applyAbsorb,
    appendAbsorbPrompts,
    defaultCountTokens,
    hideAbsorbedMessages,
    parseAbsorbInput,
    type AbsorbConfig,
    type AbsorbOutcome,
    type CompressionState,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { PROXY_TOOL_NAMES, RULE_TOOL_NAME } from "./compress-tool.js";
import { effectiveRulesConfig } from "./rules-feature.js";
import { log as loggerLog } from "./logger.js";
import type { Session } from "./session.js";

const EFFECTIVE_ABSORB_KEY = "effectiveAbsorb";

export function absorbEnabled(config: Config): boolean {
    return config.absorb?.enabled === true;
}

export function absorbToolName(config: Config): string {
    return config.absorb?.toolName ?? ABSORB_TOOL_NAME;
}

// The kernel's ACP_TOOL_NAMES deliberately excludes absorb (hosts register it
// opt-in), so adjudication must check the resolved config alongside the static
// set. Two config sources exist: wire paths carry the per-request resolved
// Config, while the plugin tool API resolves sessions without a request
// context and falls back to the base kernel Config — prepare* therefore stores
// the last resolved absorb block per session for that path to read.
export function effectiveAbsorbConfig(session: Session | undefined, fallback: Config): AbsorbConfig | undefined {
    const meta = session?.metadata[EFFECTIVE_ABSORB_KEY];
    if (meta && typeof meta === "object" && typeof (meta as AbsorbConfig).enabled === "boolean") {
        return meta as AbsorbConfig;
    }
    return fallback.absorb;
}

export function storeEffectiveAbsorb(session: Session, config: Config): void {
    session.metadata[EFFECTIVE_ABSORB_KEY] = config.absorb ?? null;
}

export function isProxyToolFor(name: string, session: Session | undefined, config: Config): boolean {
    if (PROXY_TOOL_NAMES.has(name)) return true;
    const absorb = effectiveAbsorbConfig(session, config);
    if (absorb?.enabled === true && name === (absorb.toolName ?? ABSORB_TOOL_NAME)) return true;
    return effectiveRulesConfig(session, config)?.enabled === true && name === RULE_TOOL_NAME;
}

// Per-turn view transform: drop absorbed tool-call/result pairs, then append
// the forced [ACP absorb] instruction to every eligible large tool result.
// Hiding is unconditional so recorded absorptions stay hidden even if the
// feature is disabled mid-session; prompting self-gates inside the kernel on
// config.absorb.enabled (processTurn already injects markers from the same
// config — the append here is an idempotent safety net). Returns a new array
// that shares message refs with the input.
export function applyAbsorbView(messages: CoreMessage[], state: CompressionState, config: Config, tokenCount: number): CoreMessage[] {
    const hidden = hideAbsorbedMessages(messages, state);
    const prompted = appendAbsorbPrompts(hidden, state, config, tokenCount, defaultCountTokens);
    return prompted.messages;
}

export type AbsorbExecCtx = {
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log?: (msg: string) => void;
};

// Execute one absorb call against the session (streaming loop, JSON rewrite
// and the plugin tool API share this). Returns model-facing result text;
// failures carry FAILED so visibility markers render ❌ and the loop's
// repeat-failure guard reasons about them uniformly with compress failures.
export function executeAbsorb(args: unknown, callId: string | undefined, absorb: AbsorbConfig, ctx: AbsorbExecCtx): string {
    const log = ctx.log ?? ((msg: string) => loggerLog("info", msg));
    const parsed = parseAbsorbInput(args, callId, (w) => log(`[acp-absorb] ${w}`));
    if (!parsed) {
        return '[absorb FAILED: invalid input — expected { ref: "mNNNNN", summary: "..." }]';
    }
    const before = ctx.session.state.absorbed?.length ?? 0;
    let outcome: AbsorbOutcome;
    try {
        outcome = applyAbsorb({
            ref: parsed.ref,
            summary: parsed.summary,
            absorbCallId: parsed.absorbCallId,
            messages: ctx.messages,
            state: ctx.session.state,
            config: { ...ctx.config, absorb },
        });
    } catch (err) {
        log(`[acp-absorb] error: ${String(err)}`);
        return `[absorb FAILED: ${String(err)}]`;
    }
    ctx.session.state = outcome.state;
    if (!outcome.ok) {
        log(`[acp-absorb] ${outcome.resultText}`);
        return `[absorb FAILED: ${outcome.resultText}]`;
    }
    // ok=true also covers the no-op re-absorb ("already absorbed"); detect a
    // real absorption by the appended record so credits net exactly once.
    const records = outcome.state.absorbed ?? [];
    const record = records.length > before ? records[records.length - 1] : undefined;
    if (record) {
        // Same credit netting as compress (#252): the re-request re-sends the
        // unfolded history, so usage reports over-report until the next
        // prepare hides the pair.
        ctx.session.stats.compressCreditTokens = (ctx.session.stats.compressCreditTokens ?? 0) + record.tokensReclaimed;
        ctx.session.stats.lastInputTokens = Math.max(0, ctx.session.stats.lastInputTokens - record.tokensReclaimed);
        log(`[acp-absorb] ${outcome.resultText} (credit -${record.tokensReclaimed} tok)`);
    } else {
        log(`[acp-absorb] ${outcome.resultText}`);
    }
    return outcome.resultText;
}
