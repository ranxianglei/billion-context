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
    const available = budget - total(system);
    if (available <= 0) throw new Error("native handoff system prompt exceeds summary input budget");
    for (let round = 0; round < 16; round++) {
        signal?.throwIfAborted();
        if (total(messages) <= available) return summarize({ ...input, messages: [...system, ...messages] });
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
        for (const part of chunks) {
            signal?.throwIfAborted();
            const result = await summarize({ ...input, messages: [...system, ...part] });
            reduced.push({ id: randomUUID(), role: "user", content: result.summary, source: { kind: "user" } });
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
        // Reserve output, instruction and tool-schema overhead. The meter uses
        // the host's tokenizer; the schema fallback deliberately overestimates.
        const budget = Math.floor(window * 0.9) - config.maxTokens - 4096 - Buffer.byteLength(JSON.stringify(input.tools ?? []));
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
