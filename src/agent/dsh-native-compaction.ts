import { AsyncLocalStorage } from "node:async_hooks";
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
type Engine = {
    compactIfNeeded(agent: Agent, trigger: string, signal?: AbortSignal): Promise<unknown>;
    compactPressure(agent: Agent, header: Header, signal?: AbortSignal, requireBelow?: boolean): Promise<unknown>;
    compactRegion(start: number, end: number, agent: Agent, signal?: AbortSignal): Promise<unknown>;
    compactNow(agent: Agent, signal?: AbortSignal, command?: unknown): Promise<unknown>;
    summarize(input: SummaryInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>;
};
type Host = {
    compaction: Engine;
    on(event: string, handler: (payload: { agent: Agent }, next: () => unknown) => unknown, options?: { prepend: boolean }): unknown;
    effect?(effect: () => (() => void)): void;
    inject?(services: readonly string[], callback: (ctx: Host) => void): unknown;
};

export const name = "bili-native-compaction";
export const inject = [];
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
        return state().summary.run(true, () => originals.summarize.call(engine, input, agent, signal));
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
