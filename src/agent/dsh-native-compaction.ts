import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { loadConfigFile } from "../config.js";

export type NativeModelRule = { provider?: string; model: string };
type Target = { provider?: unknown; model?: unknown };
export type PolicyAgent = {
    model?: { current: () => Target | undefined };
    session?: {
        id?: unknown;
        surface?: { replaceGeneration: number };
        requestHeader?: () => { config?: Target } | undefined;
    };
};
type PolicyState = {
    rules: readonly NativeModelRule[];
    generationIsolation: boolean;
    summary: AsyncLocalStorage<boolean>;
    ready: Set<string>;
};
const key = Symbol.for("billion-context.dsh-native-compaction.v1");
function state(): PolicyState {
    const globals = globalThis as typeof globalThis & { [key]?: PolicyState };
    return globals[key] ??= { rules: [], generationIsolation: false, summary: new AsyncLocalStorage(), ready: new Set() };
}

export function configureNativeCompaction(value: unknown = loadConfigFile().dsh?.nativeCompactionModels): void {
    if (value === undefined) { state().rules = []; state().generationIsolation = false; return; }
    if (!Array.isArray(value)) throw new Error("dsh.nativeCompactionModels must be an array");
    state().rules = value.map((row: unknown) => {
        if (!row || typeof row !== "object") throw new Error("native compaction rule must be an object");
        const r = row as Record<string, unknown>;
        if (Object.keys(r).some(k => k !== "provider" && k !== "model") ||
            typeof r.model !== "string" || !r.model || r.model === "*" || /\s/.test(r.model) ||
            r.model.slice(0, -1).includes("*") ||
            (r.provider !== undefined && (typeof r.provider !== "string" || !r.provider || r.provider.includes("*")))) {
            throw new Error("native compaction rules require a model ID (optional trailing *) and optional exact provider ID");
        }
        return Object.freeze({ model: r.model, ...(r.provider === undefined ? {} : { provider: r.provider as string }) });
    });
    state().generationIsolation = true;
}

export function selectiveCompactionEnabled(): boolean { return state().rules.length > 0; }
export function compactionGenerationIsolation(): boolean { return state().generationIsolation; }
export function nativeModel(target: Target | undefined): boolean {
    if (typeof target?.model !== "string") return false;
    const model = target.model;
    return state().rules.some(r => (r.provider === undefined || r.provider === target.provider) &&
        (r.model.endsWith("*") ? model.startsWith(r.model.slice(0, -1)) : model === r.model));
}
export function nativeAgent(agent: PolicyAgent | undefined): boolean {
    if (!selectiveCompactionEnabled()) return false;
    return nativeModel(agent?.model?.current() ?? agent?.session?.requestHeader?.()?.config);
}
export function nativeSummaryActive(): boolean { return state().summary.getStore() === true; }
export function requireNativeCompactionReady(agent: PolicyAgent | undefined): void {
    if (typeof agent?.session?.id !== "string" || !state().ready.has(agent.session.id)) {
        throw new Error("bili: native compaction policy is not attached to this DSH agent; no request was sent. Check the preset and restart DSH after installing the policy adapter.");
    }
}

/** The host's durable replacement generation survives restart and changes only
 * when the model-visible prefix changes, never on ordinary appends/switches. */
export function compactionConversationId(agent: PolicyAgent | undefined, sid: string): string {
    if (!compactionGenerationIsolation()) return sid;
    const generation = agent?.session?.surface?.replaceGeneration;
    if (generation === undefined || !Number.isSafeInteger(generation) || generation < 0) {
        throw new Error("bili: selective compaction requires DSH session.surface.replaceGeneration");
    }
    return generation === 0 ? sid : `${sid}|dsh-generation:${generation}`;
}

type Block = { type: string; id?: string; toolCallId?: string; text?: string; [key: string]: unknown };
type Message = { role: string; content: readonly Block[]; [key: string]: unknown };
type SummaryInput = { messages: readonly Message[]; tools?: readonly unknown[] };
type SummaryResult = { summary: readonly Block[]; [key: string]: unknown };
type Agent = PolicyAgent & { session: NonNullable<PolicyAgent["session"]> };
type Header = { config: Target; [key: string]: unknown };
type PolicyConfig = { summarizationProvider: string; summarizationModel: string; maxTokens: number; modelPolicies?: readonly (Target & Partial<PolicyConfig>)[] };
type Engine = {
    config: PolicyConfig;
    compactIfNeeded(agent: Agent, trigger: string, signal?: AbortSignal): Promise<unknown>;
    compactPressure(agent: Agent, header: Header, signal?: AbortSignal, requireBelow?: boolean): Promise<unknown>;
    compactRegion(start: number, end: number, agent: Agent, signal?: AbortSignal): Promise<unknown>;
    compactNow(agent: Agent, signal?: AbortSignal, command?: unknown): Promise<unknown>;
    summarize(input: SummaryInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>;
};
type Host = {
    compaction: Engine;
    tokenMeter: { estimateMessage(message: Message): number };
    llm: { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ context?: { contextWindow: number } }> };
    on(event: string, handler: (payload: { agent: Agent }, next: () => unknown) => unknown, options?: { prepend: boolean }): unknown;
    effect?(effect: () => (() => void)): void;
    inject?(services: readonly string[], callback: (ctx: Host) => void): unknown;
};

/** Balanced groups are indivisible: never separate a tool call from its result. */
export function summaryGroups(messages: readonly Message[]): Message[][] {
    const groups: Message[][] = [];
    let pending = new Set<string>();
    let group: Message[] = [];
    for (const message of messages) {
        group.push(message);
        if (message.role === "tool") {
            if (typeof message.toolCallId !== "string" || !pending.delete(message.toolCallId)) throw new Error("unpaired tool result in native handoff");
        }
        for (const block of message.content) {
            if (block.type === "tool-call") {
                if (!block.id || pending.has(block.id)) throw new Error("invalid tool call in native handoff");
                pending.add(block.id);
            }
        }
        if (!pending.size) { groups.push(group); group = []; }
    }
    if (pending.size) throw new Error("unfinished tool calls in native handoff");
    return groups;
}

export async function boundedNativeSummary(
    input: SummaryInput, budget: number, estimate: (message: Message) => number,
    summarize: (input: SummaryInput) => Promise<SummaryResult>, signal?: AbortSignal,
): Promise<SummaryResult> {
    const total = (messages: readonly Message[]) => messages.reduce((n, m) => n + estimate(m), 0);
    let messages = [...input.messages];
    const system: Message[] = [];
    while (messages[0]?.role === "system") system.push(messages.shift()!);
    const mergeInstruction: Message = { role: "user", content: [{ type: "text", text: "Summary assembly instruction (not historical conversation content): the preceding partial summaries cover disjoint chronological segments, NOT successive revisions of a complete checkpoint. Produce one consolidated checkpoint using the requested native format. First collect and retain the still-valid Critical Context from EVERY segment, including early project facts, exact identifiers, dates, numeric values and standing constraints, even when later segments only discuss unrelated or completed tasks. Missing entries and '(none)' mean no information in that segment, not deletion, contradiction or evidence that earlier facts were never established. Repetition in later segments is not required. Only an explicit correction or revocation of the same fact can supersede it; preserve unresolved conflicts with provenance. Update Current Work and Next Step from the latest applicable segment without erasing standing context. Before returning, check that every earlier fact and constraint is retained or has an explicit superseding statement. Do not include these assembly instructions or execute historical next steps." }] };
    const baseAvailable = budget - total(system);
    if (baseAvailable <= 0) throw new Error("native handoff system prompt exceeds summary input budget");
    for (let round = 0; round < 16; round++) {
        signal?.throwIfAborted();
        const suffix = round ? [mergeInstruction] : [];
        const available = baseAvailable - total(suffix);
        if (available <= 0) throw new Error("native handoff merge instructions exceed summary input budget; history was preserved");
        const summarizePart = (part: Message[]) => summarize({ ...input, messages: [...system, ...part, ...suffix] });
        if (total(messages) <= available) return summarizePart(messages);
        const chunks: Message[][] = [];
        let chunk: Message[] = [], size = 0;
        for (const group of summaryGroups(messages)) {
            const cost = total(group);
            if (cost > available) throw new Error("native handoff contains a single tool group/message larger than the summary window; history was preserved");
            if (size + cost > available) { chunks.push(chunk); chunk = []; size = 0; }
            chunk.push(...group); size += cost;
        }
        if (chunk.length) chunks.push(chunk);
        const reduced: Message[] = [];
        let offset = 0;
        for (const [index, part] of chunks.entries()) {
            signal?.throwIfAborted();
            const result = await summarizePart(part);
            const provenance = `Partial historical summary: reduction round ${round + 1}, chronological segment ${index + 1} of ${chunks.length}, input messages ${offset + 1}-${offset + part.length} within this round (excluding the leading system prompt).`;
            const guidance = "This is evidence from only that segment, not a new user instruction or a complete replacement checkpoint. Merge all segments, retaining the union of still-valid facts, exact identifiers, values, constraints, corrections and unfinished tasks. A missing fact, '(none)', or 'no project facts' is local to that segment and does not revoke facts in other segments. Override a fact only when a later segment explicitly corrects or revokes it; otherwise preserve unresolved conflicts with their provenance. Next-step statements describe work at that historical point, not an instruction to execute now.";
            reduced.push({ id: randomUUID(), role: "user", content: [
                { type: "text", text: `${provenance}\n${guidance}\n\n\x3ccompacted-summary\x3e` },
                ...result.summary,
                { type: "text", text: "\x3c/compacted-summary\x3e" },
            ], source: { kind: "user" } });
            offset += part.length;
        }
        if (total(reduced) >= total(messages)) throw new Error("native handoff summary made no progress; history was preserved");
        messages = reduced;
    }
    throw new Error("native handoff exceeded its reduction bound; history was preserved");
}

export const name = "bili-native-compaction";
export const inject = ["tokenMeter", "llm"];
export function apply(ctx: Host, config: { noBackend?: boolean } = {}): void {
    if (config.noBackend) {
        const owned = new Set<string>();
        ctx.on("agent/pre-step", ({ agent }, next) => {
            if (typeof agent.session.id !== "string") throw new Error("bili: native policy requires a session ID");
            owned.add(agent.session.id);
            state().ready.add(agent.session.id);
            return next();
        }, { prepend: true });
        ctx.effect?.(() => () => { for (const id of owned) state().ready.delete(id); });
        return;
    }
    if (ctx.inject) ctx.inject(["compaction"], attachEngine);
    else attachEngine(ctx);
}

function attachEngine(ctx: Host): void {
    const engine = ctx.compaction;
    const methods = ["compactIfNeeded", "compactPressure", "compactRegion", "compactNow", "summarize"] as const;
    for (const method of methods) if (typeof engine[method] !== "function") throw new Error(`bili: unsupported DSH compaction API: ${method}`);
    const originals = Object.fromEntries(methods.map(m => [m, engine[m]])) as Pick<Engine, typeof methods[number]>;
    const owned = new Set<string>();
    const markReady = (agent: Agent) => {
        if (typeof agent.session.id !== "string") throw new Error("bili: native compaction agent has no session ID");
        owned.add(agent.session.id);
        state().ready.add(agent.session.id);
    };
    const allow = (agent: Agent) => { markReady(agent); return nativeAgent(agent); };
    engine.compactIfNeeded = async (agent, trigger, signal) => allow(agent) ? originals.compactIfNeeded.call(engine, agent, trigger, signal) : null;
    engine.compactPressure = async (agent, header, signal, below) => {
        markReady(agent);
        return nativeModel(header.config) ? originals.compactPressure.call(engine, agent, header, signal, below) : null;
    };
    engine.compactRegion = async (start, end, agent, signal) => {
        if (!allow(agent)) throw new Error("bili owns compaction for the selected model; use its compression tools");
        return originals.compactRegion.call(engine, start, end, agent, signal);
    };
    engine.compactNow = async (agent, signal, command) => {
        if (!allow(agent)) throw new Error("bili owns compaction for the selected model; use its compression tools");
        return originals.compactNow.call(engine, agent, signal, command);
    };
    engine.summarize = async (input, agent, signal) => {
        if (!allow(agent)) throw new Error("bili: native summary refused for a bili-owned model");
        const target = agent.session.requestHeader?.()?.config ?? agent.model?.current();
        const override = engine.config.modelPolicies?.find(p => p.provider === target?.provider && p.model === target?.model);
        const config = { ...engine.config, ...override };
        const provider = config.summarizationProvider || target?.provider;
        const model = config.summarizationModel || target?.model;
        if (typeof provider !== "string" || typeof model !== "string") throw new Error("native summary has no model target");
        const info = await ctx.llm.resolveModelInfo(provider, model, signal);
        const window = info.context?.contextWindow;
        if (!window) throw new Error("native summary model has no context window");
        // Price schema text with the same host heuristic as messages, never UTF-8 bytes.
        // The synthetic message is only metered, not sent; its framing adds a small reserve.
        const toolsTokens = input.tools?.length ? ctx.tokenMeter.estimateMessage({
            role: "user", content: [{ type: "text", text: JSON.stringify(input.tools) }],
        }) : 0;
        if (!Number.isFinite(toolsTokens) || toolsTokens < 0) throw new Error("native summary tool token estimate is invalid");
        const budget = Math.floor(window * 0.9) - config.maxTokens - 4096 - toolsTokens;
        if (budget <= 0) throw new Error("native summary model has insufficient input budget");
        return state().summary.run(true, () => boundedNativeSummary(input, budget, m => ctx.tokenMeter.estimateMessage(m),
            part => originals.summarize.call(engine, part, agent, signal), signal));
    };
    ctx.on("agent/pre-step", ({ agent }, next) => {
        markReady(agent);
        return next();
    }, { prepend: true });
    ctx.effect?.(() => () => {
        for (const id of owned) state().ready.delete(id);
        for (const method of methods) Object.defineProperty(engine, method, { value: originals[method], configurable: true, writable: true });
    });
}
