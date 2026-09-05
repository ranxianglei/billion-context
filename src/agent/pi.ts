// Thin agent extension for pi and omp ("内外呼应", issue #1). Loaded by pi
// via the package.json `pi` manifest (dist/agent/pi.js) or by omp via the
// config.yml `extensions:` list (dist/agent/omp.js). pi and omp share the
// ExtensionFactory API shape, so one factory serves both; types below are
// minimal structural declarations — the bundled artifact imports NOTHING
// from the host at runtime (the host duck-types us in).

import { detectProxyBase, fetchManifest, forwardTool, fetchStatus, fetchProxyVersion, type ManifestTool } from "./shared.js";

type Ctx = {
    sessionManager?: { getSessionId?: () => string } | undefined;
    model?: { contextWindow?: number; baseUrl?: string; provider?: string; id?: string; [key: string]: unknown } | undefined;
    cwd?: string;
};

type TextBlock = { type: "text"; text: string };
type ToolResult = { content: TextBlock[]; isError?: boolean };

type ToolDefinition = {
    name: string;
    description?: string;
    parameters: unknown;
    // omp 17.x mounts extension tools that omit loadMode under xd:// devices
    // (invisible to the main turn's tools array — only title requests see
    // them). Declaring "essential" keeps ACP tools top-level; pi upstream
    // ignores the field.
    loadMode?: string;
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
    // #535: launcher passes provider URL rewrites via env; the extension
    // overrides each provider's baseUrl at load (file-free routing — no
    // models.json overlay). Optional because older hosts may lack it.
    registerProvider?: (name: string, config: { baseUrl: string }) => void;
    // #535 omp-only: omp pins the session's Model object from the static
    // catalog BEFORE extensions load, and its registerProvider — unlike
    // pi's _refreshCurrentModelFromRegistry — never re-resolves the live
    // session model, so the extension must re-pin it via setModel (see the
    // session_start handler below). Optional because pi hosts lack it.
    setModel?: (model: Record<string, unknown> & { baseUrl?: string }) => Promise<boolean | void> | boolean | void;
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

// omp's chat-completions payloads carry NO conversation signal (no
// prompt_cache_key / session / user, and no session header — verified by dump),
// so the proxy's openai identity falls to a content fingerprint that never
// matches the session id this plugin registered (the identity register is keyed
// by the omp session uuid). The before_provider_request return value REPLACES
// the whole outgoing payload (omp onPayload chain, verified in the omp 17.3.8
// dist), so stamp prompt_cache_key with the omp session id: the proxy binds
// pluginMode by that identity and /acp finds the session by it.
// Chat shape = messages array, no responses `input`, no native prompt_cache_key.
// max_tokens is NOT a discriminator: omp's openai-compat providers send it in
// every chat-completions body (maxTokensField:"max_tokens") exactly like the
// anthropic wire — excluding it meant the target shape was never stamped
// (#268). The anthropic wire gets stamped too: the proxy records the mapping
// from the body pck there as well and strips the field before forwarding to
// the real Anthropic. pi is untouched (it stamps x-bili-plugin-conversation in
// before_provider_headers, which outranks the body field).
function stampPromptCacheKey(event: unknown, ctx: Ctx, agent: string): Record<string, unknown> | undefined {
    if (agent !== "omp") return undefined;
    const payload = (event as { payload?: unknown } | undefined)?.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const p = payload as Record<string, unknown>;
    if (!Array.isArray(p.messages)) return undefined;
    if (p.input !== undefined) return undefined;
    if (typeof p.prompt_cache_key === "string" && p.prompt_cache_key.trim().length > 0) return undefined;
    const sid = sessionIdOf(ctx);
    if (sid === undefined || sid.length === 0) return undefined;
    return { ...p, prompt_cache_key: sid };
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
        loadMode: "essential",
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

function parseProviderRewrites(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
    const raw = env.BILI_PROVIDER_REWRITES;
    if (raw === undefined || raw.trim().length === 0) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.error("bili-plugin: BILI_PROVIDER_REWRITES is not valid JSON — provider URLs left untouched");
        return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== "string" || !/^https?:\/\//i.test(value)) continue;
        out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

const RETRY_INTERVAL_MS = 10000;

type RegisterState = { sid?: string; toolsFor?: string; toolsReady?: boolean; pending?: Promise<void>; retryAt?: number; identityAt?: string; retryIntervalMs: number };

// omp never emits before_provider_headers, so the x-bili-plugin marker cannot
// be stamped per request. Register the conversation id once (after tools are
// ready): the proxy binds any request carrying that id into plugin mode —
// same launcher path claude/codex use (#162).
async function postIdentityRegister(proxyBase: string, conversationId: string, agent: string): Promise<void> {
    const res = await fetch(`${proxyBase}/__bili/plugin/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, agent, identity: true }),
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`register HTTP ${res.status}`);
}

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
    const wait = state.retryIntervalMs;
    state.pending = (async () => {
        let tools: ManifestTool[];
        try {
            tools = await fetchManifest(proxyBase);
        } catch (err) {
            state.retryAt = Date.now() + wait;
            console.error(`bili-plugin(${agent}): manifest fetch failed: ${err instanceof Error ? err.message : String(err)} — retrying in ${wait / 1000}s`);
            return;
        }
        try {
            // toolsFor (not sid) guards the register loop: a retry after a
            // failed identity register re-fetches the manifest but must NOT
            // re-register the tools (the host may not dedupe by name).
            if (state.toolsFor !== sid) {
                for (const t of tools) pi.registerTool(manifestToTool(proxyBase, t, agent));
                state.toolsFor = sid;
            }
            state.toolsReady = true;
            state.retryAt = undefined;
            if (agent === "omp" && sid !== "" && state.identityAt !== sid) {
                try {
                    await postIdentityRegister(proxyBase, sid, agent);
                    state.identityAt = sid;
                } catch (err) {
                    // Leave state.sid UNSET so the next per-request event
                    // re-enters (throttled by retryAt) and retries ONLY the
                    // register — setting sid here would wedge the session in
                    // wire mode forever (the early return above blocks every
                    // retry).
                    state.retryAt = Date.now() + wait;
                    console.error(`bili-plugin(${agent}): identity register failed (${err instanceof Error ? err.message : String(err)}) — retrying in ${wait / 1000}s`);
                    return;
                }
            }
            state.sid = sid;
        } catch (err) {
            state.sid = undefined;
            state.toolsFor = undefined;
            state.retryAt = Date.now() + wait;
            console.error(`bili-plugin(${agent}): tool registration deferred (${err instanceof Error ? err.message : String(err)}) — retrying in ${wait / 1000}s`);
        }
    })();
    try {
        await state.pending;
    } finally {
        state.pending = undefined;
    }
}

export function createBiliPlugin(agentOverride?: string, opts?: { retryIntervalMs?: number }): (pi: ExtensionAPI) => void {
    return function biliPlugin(pi: ExtensionAPI): void {
        const agent = agentName(agentOverride);
        const state: RegisterState = { retryIntervalMs: opts?.retryIntervalMs ?? RETRY_INTERVAL_MS };
        // #535: file-free routing — override provider baseUrls at load from
        // the launcher-passed manifest (see buildPiEnv). registerProvider is
        // queued during initial extension load and applied before any model
        // traffic, so every request (including round 1) rides the proxy.
        const rewrites = parseProviderRewrites(process.env);
        if (rewrites !== undefined && typeof pi.registerProvider !== "function") {
            console.error(
                "bili-plugin: BILI_PROVIDER_REWRITES is set but this pi build has no registerProvider API — " +
                    "provider traffic goes DIRECT (uncompressed). Update pi, or reinstall the bili plugin: `bili plugin install pi`.",
            );
        }
        if (rewrites !== undefined && typeof pi.registerProvider === "function") {
            for (const [key, url] of Object.entries(rewrites)) {
                try {
                    pi.registerProvider(key, { baseUrl: url });
                } catch (err) {
                    console.error(`bili-plugin: registerProvider(${key}) failed: ${err instanceof Error ? err.message : String(err)} — traffic for this provider goes direct`);
                }
            }
        }
        // #535: cancel the host's NATIVE compaction so its summarizer never
        // fires alongside bili's ACP compression — the in-extension
        // replacement for the old compaction-off config injection. pi's event
        // carries `reason`: cancel only threshold + overflow so manual
        // /compact stays user-owned. omp's event has no reason field, so omp
        // cancels ALL compaction — under bili, manual native /compact is
        // equally harmful (the native summarizer would destroy the
        // ACP-tagged context), the host shows "Compaction cancelled", and
        // the user should reach for /acp instead. Only armed under `bili`
        // launch: plain pi/omp with the plugin installed stays fully native.
        if ((agent === "pi" || agent === "omp") && process.env.BILLION_CONTEXT_PROXY !== undefined) {
            pi.on("session_before_compact", (event) => {
                if (agent === "pi") {
                    const reason = (event as unknown as { reason?: unknown }).reason;
                    if (reason === "threshold" || reason === "overflow") return { cancel: true };
                    return undefined;
                }
                return { cancel: true };
            });
        }
        // #535 omp-only: omp resolves modelRoles.default into options.model
        // from the PRE-extension static catalog (main.ts: "scope is resolved
        // before extensions register their providers"), and omp's fork lacks
        // pi's registerProvider → _refreshCurrentModelFromRegistry hop — the
        // registry gets the rewritten baseUrl but the live session keeps the
        // direct one, so every request bypasses the proxy (fetch trace →
        // http://127.0.0.1:8197/v1/responses with zero proxy forwards). Re-pin
        // the session model at load + on every session switch: spread the
        // current model with the rewritten baseUrl through the host setModel
        // (keyed-provider-gated; local providers carry dummy keys). Mid-session
        // /model picks resolve from the already-overridden registry, so only
        // session start/restore need this.
        if (agent === "omp" && rewrites !== undefined && typeof pi.setModel === "function") {
            const repin = async (ctx: Ctx): Promise<void> => {
                const model = ctx?.model;
                if (model === null || typeof model !== "object") return;
                const provider = model.provider;
                if (typeof provider !== "string" || provider === "") return;
                const rewritten = rewrites[provider];
                if (rewritten === undefined || model.baseUrl === rewritten) return;
                try {
                    const switched = await pi.setModel?.({ ...model, baseUrl: rewritten });
                    if (switched === false) {
                        console.error(`bili-plugin: omp setModel(${provider}/${String(model.id)}) rejected (no API key) — traffic for this provider goes direct`);
                    }
                } catch (err) {
                    console.error(`bili-plugin: omp setModel failed: ${err instanceof Error ? err.message : String(err)} — traffic goes direct`);
                }
            };
            pi.on("session_start", (_event, ctx) => repin(ctx));
            pi.on("session_switch", (_event, ctx) => repin(ctx));
        }
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
                        // 404 from a live proxy = this conversation has sent no
                        // model request yet (e.g. /acp right after startup).
                        // Probe the manifest to confirm liveness + version and
                        // show an armed/idle notice instead of a scary warning.
                        let version: string | undefined;
                        try {
                            version = await fetchProxyVersion(proxyBase);
                        } catch {
                            version = undefined;
                        }
                        if (version !== undefined) {
                            notify(
                                `billion-context@${version} — proxy connected, compression armed. No model request in this conversation yet; send one, then run /acp again.`,
                                "info",
                            );
                        } else {
                            notify("bili: no ACP session yet (send a model request first, then run /acp)", "warning");
                        }
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
                // The x-bili-plugin marker tells the proxy "the client owns the
                // ACP tools natively — skip wire-level injection". Stamping it
                // before registerTools() finishes would send round 1 out with
                // NO ACP tools (the first provider request races the manifest
                // fetch). Claim ownership only once tools are registered;
                // until then the request rides the proxy's wire mode. A
                // permanently failing manifest fetch keeps us in wire mode —
                // a graceful fallback rather than a tool-less session.
                if (state.toolsReady === true) {
                    const sid = sessionIdOf(ctx);
                    if (sid !== undefined) headers["x-bili-plugin-conversation"] = sid;
                    headers["x-bili-plugin"] = agent;
                    const window = ctx.model?.contextWindow;
                    if (typeof window === "number" && Number.isFinite(window) && window > 0) {
                        headers["x-bili-plugin-context-window"] = String(Math.floor(window));
                    }
                }
            } catch (err) {
                console.error(`bili-plugin(${agent}): header stamp skipped (${err instanceof Error ? err.message : String(err)})`);
            }
            void registerTools(pi, ctx, state, agent).catch((err: unknown) => console.error(`bili-plugin(${agent}): ${err instanceof Error ? err.message : String(err)}`));
        });
        pi.on("before_provider_request", (event, ctx) => {
            // omp emits this per model request (but never before_provider_headers);
            // it doubles as the retry driver when the session_start manifest
            // fetch raced the proxy startup. Cached by sid, throttled by retryAt.
            void registerTools(pi, ctx, state, agent).catch((err: unknown) => console.error(`bili-plugin(${agent}): ${err instanceof Error ? err.message : String(err)}`));
            return stampPromptCacheKey(event, ctx, agent);
        });
        pi.on("session_start", (_event, ctx) => {
            state.sid = undefined;
            void registerTools(pi, ctx, state, agent).catch((err: unknown) => console.error(`bili-plugin(${agent}): ${err instanceof Error ? err.message : String(err)}`));
        });
        // omp fires session_compact on in-session native compaction (sid does
        // not rotate), so the proxy reuses stale state — notify it to archive
        // the now-unreachable blocks (#395). Fire-and-forget: a failed
        // notification must never break the agent's compaction.
        pi.on("session_compact", (_event, ctx) => {
            const proxyBase = proxyBaseForCtx(ctx);
            if (proxyBase === undefined) return;
            const sid = sessionIdOf(ctx);
            if (sid === undefined || sid.length === 0) return;
            fetch(`${proxyBase}/__bili/plugin/compact`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ conversationId: sid }),
                signal: AbortSignal.timeout(5000),
            }).catch(() => {});
        });
    };
}

export default createBiliPlugin();

export { fetchStatus };
