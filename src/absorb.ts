import {
    ABSORB_TOOL,
    ABSORB_TOOL_OPENAI,
    applyAbsorb as kernelApplyAbsorb,
    buildAbsorbSystemPrompt,
    parseAbsorbInput,
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import type { AbsorbSettings, CompressSettings } from "./config.js";
import type { Session } from "./session.js";

export { ABSORB_TOOL, ABSORB_TOOL_OPENAI, ABSORB_TOOL_NAME, buildAbsorbSystemPrompt } from "acp-kernel";

export const ABSORB_TOOL_RESPONSES = {
    type: "function" as const,
    name: ABSORB_TOOL_OPENAI.function.name,
    description: ABSORB_TOOL_OPENAI.function.description,
    parameters: ABSORB_TOOL_OPENAI.function.parameters,
};

export function absorbEnabled(s: CompressSettings): boolean {
    const a = s.absorb;
    return a === true || (typeof a === "object" && a !== null && a.enabled !== false);
}

export function applyAbsorbConfig(base: Config, s: CompressSettings): Config {
    if (!absorbEnabled(s)) return base;
    const a: AbsorbSettings = typeof s.absorb === "object" && s.absorb !== null ? s.absorb : {};
    return {
        ...base,
        absorb: {
            enabled: true,
            toolName: "absorb",
            minToolTokens: a.minToolTokens ?? 1000,
            contextThresholdPct: a.contextThresholdPct !== undefined ? parsePercent(a.contextThresholdPct) : 0,
            excludeTools: a.excludeTools ?? [],
        },
    };
}

export type AbsorbCtx = {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
};

/** Execute an absorb call intercepted from the model stream. Unlike the other
 *  proxy tools the result text MUST carry the model's summary verbatim: the
 *  absorb tool call itself never reaches the agent's history (it is rewritten
 *  into text on the wire), so this text is the only durable record of what the
 *  original tool output contained. */
export function executeAbsorb(args: Record<string, unknown>, ctx: AbsorbCtx, callId?: string): string {
    if (!ctx.config.absorb?.enabled) {
        return "[absorb FAILED: absorb is not enabled for this session]";
    }
    const parsed = parseAbsorbInput(args, callId);
    if (!parsed || !parsed.summary.trim()) {
        return "[absorb FAILED: provide ref (the mNNNNN from the tool result's acp tag) and summary (the distilled key results that replace it)]";
    }
    const outcome = kernelApplyAbsorb({
        ref: parsed.ref,
        summary: parsed.summary,
        absorbCallId: callId,
        messages: ctx.messages,
        state: ctx.session.state,
        config: ctx.config,
    });
    if (!outcome.ok) return `[absorb FAILED: ${outcome.resultText}]`;
    ctx.session.state = outcome.state;
    ctx.log(`[acp-proxy: absorb ${parsed.ref} → summary ${parsed.summary.length} chars, state now has ${outcome.state.absorbed?.length ?? 0} record(s)]`);
    return `${outcome.resultText}\n<absorbed-summary>\n${parsed.summary}\n</absorbed-summary>`;
}

function parsePercent(v: number | string): number {
    if (typeof v === "number") return v;
    const s = v.trim();
    if (s.endsWith("%")) return Number(s.slice(0, -1)) / 100;
    return Number(s);
}
