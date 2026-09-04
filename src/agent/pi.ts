// Thin agent extension for pi and omp ("内外呼应", issue #1). Loaded by pi
// via the package.json `pi` manifest (dist/agent/pi.js) or by omp via the
// config.yml `extensions:` list (dist/agent/omp.js). pi and omp share the
// ExtensionFactory API shape, so one factory serves both; types below are
// minimal structural declarations — the bundled artifact imports NOTHING
// from the host at runtime (the host duck-types us in).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFetchInterceptor } from "./intercept.js";
import { detectProxyBase, fetchManifest, forwardTool, fetchStatus, fetchProxyVersion, type ManifestTool } from "./shared.js";

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
};

function agentName(override: string | undefined): string {
    if (override) return override;
    return process.env.BILLION_CONTEXT_PLUGIN_AGENT === "omp" ? "omp" : "pi";
}

function proxyBaseForCtx(ctx: Ctx): string | undefined {
    return detectProxyBase(ctx.model?.baseUrl);
}

// --- Native mode (#519): no launcher in front — the plugin itself starts a
// per-session proxy (`bili daemon --fresh --json`) and intercepts outgoing
// provider traffic in-process so the user's plain `pi`/`omp` works unmodified.
// Enabled only by an explicit marker file (written by
// `bili plugin install <agent> --native`); without it this whole section is
// inert and behavior is byte-identical to before. A launcher-provided proxy
// (detectProxyBase hit) always wins over native spawning.

type DaemonInfo = { origin: string; port: number; pid?: number };

const DAEMON_TIMEOUT_MS = 20000;

function packageEntryPath(): string | undefined {
    try {
        // Bundled artifact lives at <root>/dist/agent/<name>.js — two levels up
        // is the package root whose dist/index.js is the bili CLI entry.
        const here = fileURLToPath(import.meta.url);
        const root = path.resolve(path.dirname(here), "..", "..");
        const entry = path.join(root, "dist", "index.js");
        return fs.existsSync(entry) ? entry : undefined;
    } catch {
        return undefined;
    }
}

function readNativeMarker(agent: string): boolean {
    try {
        const stateDir = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
        const raw = fs.readFileSync(path.join(stateDir, "billion-context", "native.json"), "utf8");
        const obj: unknown = JSON.parse(raw);
        return obj !== null && typeof obj === "object" && (obj as Record<string, unknown>)[agent] === true;
    } catch {
        return false;
    }
}

// Local copy of launcher.ts' stripInheritedProxy: importing it would pull the
// server-side module graph into this thin agent bundle (tsup inlines per-entry).
const INHERITED_PROXY_VARS = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];

function stripInheritedProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const cleaned = { ...env };
    for (const key of INHERITED_PROXY_VARS) delete cleaned[key];
    return cleaned;
}

function spawnDaemon(entry: string, parentPid: number, agent: string): Promise<DaemonInfo | undefined> {
    return new Promise((resolve) => {
        let out = "";
        let settled = false;
        const finish = (v: DaemonInfo | undefined): void => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(v);
            }
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(process.execPath, [entry, "daemon", "--parent-pid", String(parentPid)], {
                stdio: ["ignore", "pipe", "inherit"],
                env: stripInheritedProxy(process.env),
            });
        } catch (err) {
            console.error(`bili-plugin(${agent}): daemon spawn failed: ${err instanceof Error ? err.message : String(err)}`);
            finish(undefined);
            return;
        }
        const timer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                // child already gone
            }
            console.error(`bili-plugin(${agent}): daemon start timed out after ${DAEMON_TIMEOUT_MS / 1000}s`);
            finish(undefined);
        }, DAEMON_TIMEOUT_MS);
        child.stdout?.on("data", (d: Buffer) => {
            out += d.toString("utf8");
        });
        child.on("error", (err) => {
            console.error(`bili-plugin(${agent}): daemon spawn error: ${err.message}`);
            finish(undefined);
        });
        child.on("close", (code) => {
            if (code !== 0) {
                console.error(`bili-plugin(${agent}): daemon exited with code ${code} — native mode unavailable`);
                finish(undefined);
                return;
            }
            const line = out.trim().split("\n").pop()?.trim();
            if (line !== undefined) {
                try {
                    const j: unknown = JSON.parse(line);
                    if (j !== null && typeof j === "object") {
                        const rec = j as { origin?: unknown; port?: unknown; pid?: unknown };
                        if (typeof rec.origin === "string" && typeof rec.port === "number") {
                            finish({ origin: rec.origin, port: rec.port, pid: typeof rec.pid === "number" ? rec.pid : undefined });
                            return;
                        }
                    }
                } catch {
                    // fall through to unparseable
                }
            }
            console.error(`bili-plugin(${agent}): daemon output unparseable — native mode unavailable`);
            finish(undefined);
        });
    });
}

function startDaemon(state: RegisterState, agent: string): void {
    if (state.daemon !== undefined) return;
    // BILLION_CONTEXT_PLUGIN=0 is the global plugin kill switch (shared.ts
    // honors it); native spawning must honor it too or a disabled plugin would
    // silently start proxies. NODE_ENV=test keeps unit tests from spawning real
    // daemons on machines that have a live marker file.
    if (process.env.BILLION_CONTEXT_PLUGIN === "0" || process.env.NODE_ENV === "test") return;
    if (!readNativeMarker(agent)) return;
    const entry = packageEntryPath();
    if (entry === undefined) {
        console.error(`bili-plugin(${agent}): native mode enabled but package entry not found — staying disabled`);
        return;
    }
    state.daemon = spawnDaemon(entry, process.pid, agent);
}

// Installs (or re-points, on model/provider switch) the in-process egress
// interceptor for the given upstream origin. Takes the upstream base URL as a
// plain string (snapshotted by the caller BEFORE any await — pi's ctx is a
// proxy whose getters assert session liveness, so post-await ctx reads throw
// on replaced sessions). Returns false when the upstream cannot be determined
// — in that case nativeBase must NOT be set, because claiming plugin ownership
// while traffic bypasses the proxy would wedge the session in a mode where
// compression never sees its traffic.
function installInterceptorFor(upstreamBaseUrl: string | undefined, state: RegisterState, agent: string, origin: string): boolean {
    if (upstreamBaseUrl === undefined || upstreamBaseUrl.length === 0) return false;
    let upstreamOrigin: string;
    try {
        upstreamOrigin = new URL(upstreamBaseUrl).origin;
    } catch {
        return false;
    }
    if (state.uninstallIntercept !== undefined && state.nativeUpstream === upstreamOrigin) return true;
    try {
        state.uninstallIntercept?.();
        state.uninstallIntercept = installFetchInterceptor({ proxyOrigin: origin, upstreamOrigins: [upstreamOrigin] });
        state.nativeUpstream = upstreamOrigin;
        return true;
    } catch (err) {
        console.error(`bili-plugin(${agent}): interceptor install failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

async function ensureNativeReady(ctx: Ctx, state: RegisterState, agent: string): Promise<void> {
    // pi's ctx getters assert session liveness (reads throw once the session
    // was replaced), so snapshot host data before the first await and touch
    // ctx nowhere below it.
    const baseUrl = ctx.model?.baseUrl;
    if (state.nativeBase !== undefined) {
        installInterceptorFor(baseUrl, state, agent, state.nativeBase);
        return;
    }
    if (proxyBaseForCtx(ctx) !== undefined) return;
    if (state.daemon === undefined) {
        if (state.nativeRetryAt !== undefined && Date.now() < state.nativeRetryAt) return;
        startDaemon(state, agent);
    }
    if (state.daemon === undefined) return;
    const info = await state.daemon;
    if (info === undefined) {
        state.nativeRetryAt = Date.now() + state.retryIntervalMs;
        return;
    }
    if (!installInterceptorFor(baseUrl, state, agent, info.origin)) return;
    state.childPid = info.pid;
    state.nativeBase = info.origin;
}

function shutdownNative(state: RegisterState): void {
    state.uninstallIntercept?.();
    state.uninstallIntercept = undefined;
    state.nativeUpstream = undefined;
    if (state.childPid !== undefined) {
        try {
            process.kill(state.childPid, "SIGTERM");
        } catch {
            // already gone
        }
    }
    state.childPid = undefined;
    state.nativeBase = undefined;
    state.daemon = undefined;
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

const RETRY_INTERVAL_MS = 10000;

type RegisterState = {
    sid?: string;
    toolsFor?: string;
    toolsReady?: boolean;
    pending?: Promise<void>;
    retryAt?: number;
    identityAt?: string;
    retryIntervalMs: number;
    daemon?: Promise<DaemonInfo | undefined>;
    nativeBase?: string;
    nativeUpstream?: string;
    nativeRetryAt?: number;
    uninstallIntercept?: () => void;
    childPid?: number;
};

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
    const proxyBase = proxyBaseForCtx(ctx) ?? state.nativeBase;
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
                    const proxyBase = detectProxyBase(ctx.model?.baseUrl) ?? state.nativeBase;
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
                if (proxyBaseForCtx(ctx) === undefined && state.nativeBase === undefined) return;
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
            arm(ctx);
        });
        const arm = (ctx: Ctx): void => {
            // The two steps must NOT be chained across the daemon-spawn await:
            // pi invalidates captured host references on session replacement
            // (-p print mode replaces the session right after startup), and a
            // registerTool call from the stale continuation throws. Registration
            // is therefore driven by these per-request events, which always
            // carry fresh references; registerTools is a no-op until nativeBase
            // exists, so nothing is out of order. ensureNativeReady resolves
            // immediately in every non-native case, preserving the original
            // registration timing there.
            void ensureNativeReady(ctx, state, agent).catch((err: unknown) => console.error(`bili-plugin(${agent}): ${err instanceof Error ? err.message : String(err)}`));
            void registerTools(pi, ctx, state, agent).catch((err: unknown) => console.error(`bili-plugin(${agent}): ${err instanceof Error ? err.message : String(err)}`));
        };
        pi.on("before_provider_request", (event, ctx) => {
            // omp emits this per model request (but never before_provider_headers);
            // it doubles as the retry driver when the session_start manifest
            // fetch raced the proxy startup. Cached by sid, throttled by retryAt.
            arm(ctx);
            return stampPromptCacheKey(event, ctx, agent);
        });
        pi.on("session_start", (_event, ctx) => {
            state.sid = undefined;
            arm(ctx);
        });
        pi.on("session_shutdown", (_event, _ctx) => {
            shutdownNative(state);
        });
    };
}

export default createBiliPlugin();

export { fetchStatus };
