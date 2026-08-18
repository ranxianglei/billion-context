// Thin agent extension for pi and omp ("内外呼应", issue #1). Loaded by pi
// via the package.json `pi` manifest (dist/agent/pi.js) or by omp via the
// config.yml `extensions:` list (dist/agent/omp.js). pi and omp share the
// ExtensionFactory API shape, so one factory serves both; types below are
// minimal structural declarations — the bundled artifact imports NOTHING
// from the host at runtime (the host duck-types us in).

import { detectProxyBase, fetchManifest, forwardTool, fetchStatus, type ManifestTool } from "./shared.js";

type Ctx = {
    sessionManager: { getSessionId(): string };
    model?: { contextWindow?: number; baseUrl?: string } | undefined;
    cwd?: string;
};

type ToolResult = { output: string };

type ToolDefinition = {
    name: string;
    description?: string;
    parameters: unknown;
    execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: ((u: unknown) => void) | undefined, ctx: Ctx) => Promise<ToolResult>;
};

type ExtensionAPI = {
    on: (event: string, handler: (event: never, ctx: Ctx) => unknown) => void;
    registerTool: (tool: ToolDefinition) => void;
};

function agentName(): string {
    return process.env.BILLION_CONTEXT_PLUGIN_AGENT === "omp" ? "omp" : "pi";
}

function proxyBaseForCtx(ctx: Ctx): string | undefined {
    return detectProxyBase(ctx.model?.baseUrl);
}

function manifestToTool(proxyBase: string, tool: ManifestTool): ToolDefinition {
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
            const conversationId = ctx.sessionManager.getSessionId();
            try {
                const output = await forwardTool(proxyBase, conversationId, tool.name, params);
                return { output };
            } catch (err) {
                return { output: `bili tool error: ${err instanceof Error ? err.message : String(err)}` };
            }
        },
    };
}

async function registerTools(pi: ExtensionAPI, ctx: Ctx, registeredFor: { sid: string | undefined }): Promise<void> {
    const proxyBase = proxyBaseForCtx(ctx);
    if (proxyBase === undefined) return;
    const sid = ctx.sessionManager.getSessionId();
    if (sid === registeredFor.sid) return;
    let tools: ManifestTool[];
    try {
        tools = await fetchManifest(proxyBase);
    } catch (err) {
        console.error(`bili-plugin(${agentName()}): manifest fetch failed: ${err instanceof Error ? err.message : String(err)} — tools unavailable this session`);
        return;
    }
    try {
        for (const t of tools) pi.registerTool(manifestToTool(proxyBase, t));
        registeredFor.sid = sid;
    } catch (err) {
        registeredFor.sid = undefined;
        console.error(`bili-plugin(${agentName()}): tool registration deferred (${err instanceof Error ? err.message : String(err)})`);
    }
}

export default function biliPlugin(pi: ExtensionAPI): void {
    const registeredFor: { sid: string | undefined } = { sid: undefined };
    pi.on("before_provider_headers", (event, ctx) => {
        if (proxyBaseForCtx(ctx) === undefined) return;
        const headers = (event as unknown as { headers: Record<string, string> }).headers;
        headers["x-bili-plugin"] = agentName();
        headers["x-bili-plugin-conversation"] = ctx.sessionManager.getSessionId();
        const window = ctx.model?.contextWindow;
        if (typeof window === "number" && Number.isFinite(window) && window > 0) {
            headers["x-bili-plugin-context-window"] = String(Math.floor(window));
        }
        void registerTools(pi, ctx, registeredFor);
    });
    pi.on("session_start", (event, ctx) => {
        registeredFor.sid = undefined;
        void registerTools(pi, ctx, registeredFor);
    });
}

export { fetchStatus };
