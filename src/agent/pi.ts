// Thin agent extension for pi and omp ("内外呼应", issue #1). Loaded by pi
// via the package.json `pi` manifest (dist/agent/pi.js) or by omp via the
// config.yml `extensions:` list (dist/agent/omp.js). pi and omp share the
// ExtensionFactory API shape, so one factory serves both; types below are
// minimal structural declarations — the bundled artifact imports NOTHING
// from the host at runtime (the host duck-types us in).

import { detectProxyBase, fetchManifest, forwardTool, fetchStatus, type ManifestTool } from "./shared.js";

type Ctx = {
    sessionManager?: { getSessionId?: () => string } | undefined;
    model?: { contextWindow?: number; baseUrl?: string } | undefined;
    cwd?: string;
};

type TextBlock = { type: "text"; text: string };
type ToolResult = { content: TextBlock[]; isError?: boolean };

type ToolDefinition = {
    name: string;
    description?: string;
    parameters: unknown;
    execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: ((u: unknown) => void) | undefined, ctx: Ctx) => Promise<ToolResult>;
};

type CommandCtx = {
    sessionManager?: { getSessionId?: () => string } | undefined;
    model?: { contextWindow?: number; baseUrl?: string } | undefined;
    ui?: { notify?: (message: string, type?: string) => void } | undefined;
};

type ExtensionAPI = {
    on: (event: string, handler: (event: never, ctx: Ctx) => unknown) => void;
    registerTool: (tool: ToolDefinition) => void;
    registerCommand?: (name: string, options: { description?: string; handler: (args: string, ctx: CommandCtx) => void | Promise<void> }) => void;
};

function agentName(override: string | undefined): string {
    if (override) return override;
    return process.env.BILLION_CONTEXT_PLUGIN_AGENT === "omp" ? "omp" : "pi";
}

function proxyBaseForCtx(ctx: Ctx): string | undefined {
    return detectProxyBase(ctx.model?.baseUrl);
}

function sessionIdOf(ctx: Ctx): string | undefined {
    try {
        const sid = ctx.sessionManager?.getSessionId?.();
        return typeof sid === "string" ? sid : undefined;
    } catch {
        return undefined;
    }
}

function fmtTok(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}

function renderAcpStatus(s: Record<string, unknown>): string {
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const contextTokens = num(s.contextTokens);
    const contextLimit = num(s.contextLimit);
    const inputTokens = num(s.inputTokens);
    const outputTokens = num(s.outputTokens);
    const cachedTokens = num(s.cachedTokens);
    const requests = num(s.requests);
    const blocks = Array.isArray(s.blocks) ? (s.blocks as Array<{ tier?: number; active?: boolean }>) : [];
    const activeBlocks = blocks.filter((b) => b.active === true).length;
    const lines: string[] = ["📊 ACP status"];
    if (contextTokens !== null) {
        const pct = contextLimit !== null && contextLimit > 0 ? ` (${((contextTokens / contextLimit) * 100).toFixed(1)}%)` : "";
        lines.push(`  context: ${fmtTok(contextTokens)}${contextLimit !== null ? ` / ${fmtTok(contextLimit)}` : ""}${pct}`);
    }
    if (inputTokens !== null || outputTokens !== null || cachedTokens !== null) {
        lines.push(`  in/out/cached: ${fmtTok(inputTokens ?? 0)} / ${fmtTok(outputTokens ?? 0)} / ${fmtTok(cachedTokens ?? 0)}`);
    }
    if (requests !== null) lines.push(`  requests: ${requests}`);
    if (blocks.length > 0) lines.push(`  blocks: ${blocks.length} (${activeBlocks} active)`);
    return lines.join("\n");
}

function manifestToTool(proxyBase: string, tool: ManifestTool, agent: string): ToolDefinition {
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
            const conversationId = sessionIdOf(ctx) ?? "unknown";
            try {
                const output = await forwardTool(proxyBase, conversationId, tool.name, params, signal);
                return { content: [{ type: "text", text: output }] };
            } catch (err) {
                return { content: [{ type: "text", text: `bili tool error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
            }
        },
    };
}

const RETRY_INTERVAL_MS = 10000;

type RegisterState = { sid?: string; pending?: Promise<void>; retryAt?: number };

async function registerTools(pi: ExtensionAPI, ctx: Ctx, state: RegisterState, agent: string): Promise<void> {
    const proxyBase = proxyBaseForCtx(ctx);
    if (proxyBase === undefined) return;
    // Cache on the session id; "" (host has no sessionManager) still caches,
    // so a successful registration is not re-fetched on every provider
    // request — the manifest is session-independent anyway.
    const sid = sessionIdOf(ctx) ?? "";
    if (sid === state.sid) return;
    if (state.pending !== undefined) return state.pending;
    if (state.retryAt !== undefined && Date.now() < state.retryAt) return;
    state.pending = (async () => {
        let tools: ManifestTool[];
        try {
            tools = await fetchManifest(proxyBase);
        } catch (err) {
            state.retryAt = Date.now() + RETRY_INTERVAL_MS;
            console.error(`bili-plugin(${agent}): manifest fetch failed: ${err instanceof Error ? err.message : String(err)} — retrying in ${RETRY_INTERVAL_MS / 1000}s`);
            return;
        }
        try {
            for (const t of tools) pi.registerTool(manifestToTool(proxyBase, t, agent));
            state.sid = sid;
            state.retryAt = undefined;
        } catch (err) {
            state.sid = undefined;
            state.retryAt = Date.now() + RETRY_INTERVAL_MS;
            console.error(`bili-plugin(${agent}): tool registration deferred (${err instanceof Error ? err.message : String(err)}) — retrying in ${RETRY_INTERVAL_MS / 1000}s`);
        }
    })();
    try {
        await state.pending;
    } finally {
        state.pending = undefined;
    }
}

export function createBiliPlugin(agentOverride?: string): (pi: ExtensionAPI) => void {
    return function biliPlugin(pi: ExtensionAPI): void {
        const agent = agentName(agentOverride);
        const state: RegisterState = {};
        if (typeof pi.registerCommand === "function") {
            pi.registerCommand("acp", {
                description: "Show ACP context-compression status for this session",
                handler: async (_args, ctx) => {
                    const notify = (message: string, type?: string): void => {
                        try {
                            ctx.ui?.notify?.(message, type);
                        } catch {
                            // host UI unavailable — the command is best-effort
                        }
                    };
                    const proxyBase = detectProxyBase(ctx.model?.baseUrl);
                    if (proxyBase === undefined) {
                        notify("bili: no proxy detected (run via `bili <client>` or set a /bili/ baseURL)", "warning");
                        return;
                    }
                    const conversationId = sessionIdOf(ctx) ?? "unknown";
                    let status: Record<string, unknown> | undefined;
                    try {
                        status = await fetchStatus(proxyBase, conversationId);
                    } catch (err) {
                        notify(`bili: status fetch failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                        return;
                    }
                    if (status === undefined) {
                        notify("bili: no ACP session yet (send a model request first, then run /acp)", "warning");
                        return;
                    }
                    const panel = typeof status.panel === "string" ? status.panel : undefined;
                    notify(panel ?? renderAcpStatus(status), "info");
                },
            });
        }
        pi.on("before_provider_headers", (event, ctx) => {
            try {
                if (proxyBaseForCtx(ctx) === undefined) return;
                const headers = (event as unknown as { headers?: Record<string, string> }).headers;
                if (headers === undefined || typeof headers !== "object" || Array.isArray(headers)) return;
                const sid = sessionIdOf(ctx);
                if (sid !== undefined) headers["x-bili-plugin-conversation"] = sid;
                headers["x-bili-plugin"] = agent;
                const window = ctx.model?.contextWindow;
                if (typeof window === "number" && Number.isFinite(window) && window > 0) {
                    headers["x-bili-plugin-context-window"] = String(Math.floor(window));
                }
            } catch (err) {
                console.error(`bili-plugin(${agent}): header stamp skipped (${err instanceof Error ? err.message : String(err)})`);
            }
            void registerTools(pi, ctx, state, agent).catch((err: unknown) => console.error(`bili-plugin(${agent}): ${err instanceof Error ? err.message : String(err)}`));
        });
        pi.on("session_start", (_event, ctx) => {
            state.sid = undefined;
            void registerTools(pi, ctx, state, agent).catch((err: unknown) => console.error(`bili-plugin(${agent}): ${err instanceof Error ? err.message : String(err)}`));
        });
    };
}

export default createBiliPlugin();

export { fetchStatus };
