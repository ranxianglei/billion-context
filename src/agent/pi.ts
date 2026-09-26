// Thin agent extension for pi and omp ("内外呼应", issue #1). Loaded by pi
// via the package.json `pi` manifest (dist/agent/pi.js) or by omp via the
// config.yml `extensions:` list (dist/agent/omp.js). pi and omp share the
// ExtensionFactory API shape, so one factory serves both; types below are
// minimal structural declarations — the bundled artifact imports NOTHING
// from the host at runtime (the host duck-types us in).

import fs from "node:fs";
import path from "node:path";
import { wrapCacheReport, wrapRuleReport } from "../acp-panel.js";
import { awaitNativeProxyOrigin } from "./native-bootstrap.js";
import { detectProxyBase, destinationRoutedThroughProxy, fetchManifest, forwardTool, fetchStatus, fetchProxyVersion, postIdentityRegister, reportRuntimeInfoOnChange, armedIdleNotice, noSessionWarning, type ManifestTool } from "./shared.js";

type Ctx = {
    sessionManager?: { getSessionId?: () => string; getHeader?: () => unknown } | undefined;
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
    // Persistent transcript output (rendered by TUI and web hosts like
    // pi-web); notify() is a transient toast — only the fallback for hosts
    // without sendMessage (issue #359).
    sendMessage?: (message: { customType: string; content: string; display: boolean }) => void;
};

function agentName(override: string | undefined): string {
    if (override) return override;
    return process.env.BILLION_CONTEXT_PLUGIN_AGENT === "omp" ? "omp" : "pi";
}

function proxyBaseForCtx(ctx: Ctx | undefined): string | undefined {
    return detectProxyBase(ctx?.model?.baseUrl);
}

function sessionIdOf(ctx: Ctx): string | undefined {
    try {
        const sid = ctx.sessionManager?.getSessionId?.();
        return typeof sid === "string" ? sid : undefined;
    } catch {
        return undefined;
    }
}

/** [#1333/#1362] Session files declare derivation in their header: the header
 *  of a spawned/forked child carries parentSession. The value has TWO shapes
 *  across hosts — pi RLM inline spawns write the PATH of the parent session
 *  file, while omp fork() writes the PARENT'S BARE SESSION ID directly. The
 *  parent's conversation id is that file's own header id for paths (one bounded
 *  read — 64KB covers any header these hosts write; headers are the first JSONL
 *  line), and the bare value itself when it is an id. The path-vs-id split
 *  mirrors omp's own gc-cli discriminator: only an absolute path or a *.jsonl
 *  suffix is treated as a file reference; anything else is an id (fail-safe —
 *  an ambiguous alias resolves to nothing rather than guessing). Returns
 *  undefined for root sessions, unreadable parents, or hosts without getHeader
 *  — derivation reporting is strictly best-effort and never blocks registration. */
export function parentConversationIdOf(ctx: Ctx): string | undefined {
    try {
        const header = ctx.sessionManager?.getHeader?.() as { parentSession?: unknown } | null | undefined;
        const ref = typeof header?.parentSession === "string" ? header.parentSession.trim() : "";
        if (!ref) return undefined;
        // omp fork records the parent session id verbatim; pi records a path.
        const isFileRef = path.isAbsolute(ref) || ref.endsWith(".jsonl");
        if (!isFileRef) return ref;
        const fd = fs.openSync(ref, "r");
        try {
            const buf = Buffer.alloc(64 * 1024);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
                const text = line.trim();
                if (!text) continue;
                try {
                    const obj = JSON.parse(text) as { type?: unknown; id?: unknown };
                    if (obj?.type === "session" && typeof obj.id === "string" && obj.id) return obj.id;
                } catch {
                    // not JSON — keep scanning
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        // unreadable parent or missing getHeader — no derivation to report
    }
    return undefined;
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
// #1403: stamp ONLY when the destination will actually be seen by the proxy —
// the pck's sole consumer is the proxy itself (identity bind + strip-before-
// forward). A destination the proxy blind-tunnels never sees the field, so the
// stamp rides verbatim into the upstream body, where strict-schema upstreams
// (opencode zen's anthropic endpoint: "prompt_cache_key: Extra inputs are not
// permitted") 400 the whole request. Unrouted destinations degrade to the
// proxy's anonymous prefix-affinity sessions (#309): compression still works,
// /acp lookup by session id does not — acceptable vs a guaranteed 400.
function stampPromptCacheKey(event: unknown, ctx: Ctx, agent: string): Record<string, unknown> | undefined {
    if (agent !== "omp") return undefined;
    if (!destinationRoutedThroughProxy(ctx.model?.baseUrl)) return undefined;
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
    const hostCredit = num(s.hostCredit);
    if (hostCredit !== null && hostCredit > 0) {
        lines.push(`  host baseline: uncompressed (proxy backfilled +${fmtTok(hostCredit)} tok)`);
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

// #788: neutral wording — the plugin also loads under plain pi/omp launches
// where the user never intended proxy mode (e.g. they use billion-context-pi
// in-process instead), so offer both exits instead of assuming proxy intent.
function noProxyWarning(agent: string): string {
    const removeHint = agent === "pi"
        ? ", or remove this plugin (`bili plugin remove pi`) if you use billion-context-pi or don't want a proxy"
        : agent === "omp"
            ? ", or remove this plugin (`bili plugin remove omp`) if you don't want a proxy"
            : "";
    return `bili: no proxy detected — run via \`bili ${agent}\` (or set a /bili/ baseURL) to use proxy mode${removeHint}`;
}

const RETRY_INTERVAL_MS = 10000;

type RegisterState = { sid?: string; toolsFor?: string; toolsReady?: boolean; pending?: Promise<void>; retryAt?: number; identityAt?: string; carriedSids?: Set<string>; retryIntervalMs: number; manifestPrime?: { base: string; tools: Promise<ManifestTool[] | undefined> } };

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
        // #1217: consume the load-time manifest prime (see factory). It is
        // taken exactly once and only for the same proxy origin; a failed
        // prime resolves to undefined and falls through to the normal fetch
        // below (same failure path, same log, then retry-throttled).
        let tools: ManifestTool[] | undefined;
        const prime = state.manifestPrime;
        state.manifestPrime = undefined;
        if (prime !== undefined && prime.base === proxyBase) tools = await prime.tools;
        if (tools === undefined) {
            try {
                tools = await fetchManifest(proxyBase);
            } catch (err) {
                state.retryAt = Date.now() + wait;
                console.error(`bili-plugin(${agent}): manifest fetch failed: ${err instanceof Error ? err.message : String(err)} — retrying in ${wait / 1000}s`);
                return;
            }
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
            // #1333/#1362: a child session (pi RLM inline spawn, omp fork or
            // newSession with a parentSession header) reports its parent
            // conversation so the proxy can record a read-only inheritance
            // link (decompress/search_context fall back to the parent chain —
            // no state is copied). Plain pi sessions never identity-register:
            // their plugin-mode binding rides the x-bili-plugin-conversation
            // header stamped per request below, so the extra register only
            // fires when derivation is actually declared. omp ALWAYS registers
            // (its wire carries no other conversation signal), so it reports
            // the parent whenever the header declares one.
            const parent = agent === "pi" || agent === "omp" ? parentConversationIdOf(ctx) : undefined;
            if ((agent === "omp" || (agent === "pi" && parent !== undefined)) && sid !== "" && state.identityAt !== sid) {
                try {
                    await postIdentityRegister(proxyBase, sid, agent, parent);
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
        // #1217: -p single-shot fires round 1 before session_start's manifest
        // fetch can resolve, leaving the request unmarked → anonymous
        // proxy-mode session. Prime the fetch at load time: the launcher
        // health-checks the proxy before spawning pi, so by session_start the
        // prime has almost always settled and toolsReady flips in microtasks
        // — ahead of round 1. Native mode (#519) sets BILLION_CONTEXT_PROXY
        // only after async bootstrap, so no prime exists there and round 1
        // stays on wire mode (residual; the host would have to await us).
        const primeBase = detectProxyBase(undefined);
        if (primeBase !== undefined) {
            state.manifestPrime = { base: primeBase, tools: fetchManifest(primeBase).then((t) => t, () => undefined) };
        }
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
        // /compact stays user-owned. omp (#851): session_before_compact
        // carries NO reason field, so at hook level manual compaction
        // (/compact, plan-mode "Approve and compact context") is
        // indistinguishable from auto — but every auto pass announces itself
        // first via auto_compaction_start (reason threshold|overflow|idle|
        // incomplete), which omp emits (awaited) before the hook fires;
        // manual paths never do. Track the announcement: announced passes
        // stay cancelled, unannounced ones are left user-owned. A surviving
        // native compaction is safe: the proxy archives the unreachable
        // blocks on session_compact (#395).
        // Whether we own compression is decided at EVENT time, not load time:
        // in native mode (#519) the proxy origin lands in
        // BILLION_CONTEXT_PROXY only after the async bootstrap finishes, so a
        // load-time check would leave the cancel disarmed for the whole
        // session. Plain pi/omp with the plugin installed but NO reachable
        // proxy (incl. a failed bootstrap) stays fully native.
        // #1382: a proxy EXISTING is not enough — the evidence must be that
        // THIS conversation's traffic reaches it. Native mode sets
        // BILLION_CONTEXT_PROXY for the whole process, but extension-provided
        // models like pi-claude-bridge run their own child processes (the
        // model's baseUrl is literally "claude-bridge") and call upstream
        // directly: the fetch intercept never sees those requests, so the
        // proxy never carried the conversation. Cancelling there killed ALL
        // compaction — the bridge disables Claude Code's own auto-compact and
        // takes over Pi's in its own session_before_compact handler, which
        // never runs once an earlier handler returned cancel. Accepted
        // evidence, in order: (1) local — we stamped
        // x-bili-plugin-conversation for this session id (tools registered
        // AND a request routed through the proxy), or omp's identity register
        // succeeded; (2) remote — the proxy confirms it carries the
        // conversation id (/__bili/plugin/status ok). A non-http(s) baseUrl
        // vetoes outright: such providers' traffic cannot reach the proxy by
        // construction. Hosts exposing no stable session id keep the
        // historical cancel (the proxy may carry them under a derived
        // content-hash identity, where avoiding double compression still
        // wins). Probe failure (proxy down/hung) means NO evidence → defer to
        // native compaction: a surviving native pass is safe (#395), a wrong
        // cancel overflows the session. The handlers are async on purpose —
        // pi's runner awaits session_before_compact handlers (verified in
        // pi-coding-agent dist) before consulting .cancel/.compaction.
        const ownsCompaction = async (ctx: Ctx | undefined): Promise<boolean> => {
            const proxyBase = proxyBaseForCtx(ctx);
            if (proxyBase === undefined) return false;
            const baseUrl = ctx?.model?.baseUrl;
            if (typeof baseUrl === "string" && baseUrl.length > 0 && !/^https?:\/\//i.test(baseUrl)) return false;
            const sid = ctx === undefined ? undefined : sessionIdOf(ctx);
            if (sid === undefined || sid.length === 0) return true;
            if (agent === "pi" ? state.carriedSids?.has(sid) === true : state.identityAt === sid) return true;
            try {
                return (await fetchStatus(proxyBase, sid)) !== undefined;
            } catch (err) {
                console.error(`bili-plugin(${agent}): compaction ownership probe failed (${err instanceof Error ? err.message : String(err)}) — leaving native compaction enabled`);
                return false;
            }
        };
        if (agent === "pi" || agent === "omp") {
            if (agent === "pi") {
                pi.on("session_before_compact", async (event, ctx) => {
                    const reason = (event as unknown as { reason?: unknown }).reason;
                    if (reason !== "threshold" && reason !== "overflow") return undefined;
                    if (!(await ownsCompaction(ctx))) return undefined;
                    return { cancel: true };
                });
            } else {
                let autoPending = false;
                pi.on("auto_compaction_start", () => {
                    autoPending = true;
                });
                pi.on("auto_compaction_end", () => {
                    autoPending = false;
                });
                pi.on("session_before_compact", async (event, ctx) => {
                    if (!autoPending) return undefined;
                    if (!(await ownsCompaction(ctx))) return undefined;
                    autoPending = false;
                    return { cancel: true };
                });
            }
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
                        notify(noProxyWarning(agent), "warning");
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
                            notify(armedIdleNotice(version), "info");
                        } else {
                            notify(noSessionWarning(), "warning");
                        }
                        return;
                    }
                    const panel = typeof status.panel === "string" ? status.panel : undefined;
                    const text = panel ?? renderAcpStatus(status);
                    // Persistent transcript output (TUI + web hosts like pi-web).
                    // The proxy strips this message from the model context by
                    // content signature (src/acp-panel.ts), so it never reaches
                    // the LLM; notify() is the fallback for hosts without
                    // sendMessage (older pi).
                    if (typeof pi.sendMessage === "function") {
                        try {
                            pi.sendMessage({ customType: "bili-acp-status", content: text, display: true });
                            return;
                        } catch (err) {
                            console.error(`bili-plugin(${agent}): sendMessage failed (${err instanceof Error ? err.message : String(err)}) — falling back to notify`);
                        }
                    }
                    notify(text, "info");
                },
            });
            // #800: human entry point for the cache-reconciliation feature — the model side
            // already has the acp_cache tool; this command shows humans the identical report
            // (both paths hit handleAcpCache on the proxy). Launcher mode and native mode both
            // load this factory (see pi-native.ts), so one registration covers both.
            pi.registerCommand("acp-cache", {
                description: "Prompt-cache reconciliation for this session (same report as the acp_cache tool). Usage: /acp-cache [full]",
                handler: async (args, ctx) => {
                    const notify = (message: string, type?: string): void => {
                        try {
                            ctx.ui?.notify?.(message, type);
                        } catch {
                            // host UI unavailable — the command is best-effort
                        }
                    };
                    const proxyBase = detectProxyBase(ctx.model?.baseUrl);
                    if (proxyBase === undefined) {
                        notify(noProxyWarning(agent), "warning");
                        return;
                    }
                    const conversationId = sessionIdOf(ctx) ?? "unknown";
                    const toolArgs = /(^|\s)(--)?full(\s|$)/.test(args ?? "") ? { detail: "full" as const } : {};
                    let text: string;
                    try {
                        text = await forwardTool(proxyBase, conversationId, "acp_cache", toolArgs);
                    } catch (err) {
                        notify(`bili: cache report failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                        return;
                    }
                    // Persistent transcript output (TUI + web hosts like pi-web). The proxy strips
                    // the wrapped message from the model context by content signature
                    // (src/acp-panel.ts), so it never reaches the LLM; notify() is the fallback
                    // for hosts without sendMessage (older pi).
                    if (typeof pi.sendMessage === "function") {
                        try {
                            pi.sendMessage({ customType: "bili-acp-cache", content: wrapCacheReport(text), display: true });
                            return;
                        } catch (err) {
                            console.error(`bili-plugin(${agent}): sendMessage failed (${err instanceof Error ? err.message : String(err)}) — falling back to notify`);
                        }
                    }
                    notify(text, "info");
                },
            });
            // #1251: human entry point for the persistent-rules feature — the model side
            // already has the acp_rule tool; this command shows humans the identical list
            // (both paths hit executeRule on the proxy) and lets a human record a rule
            // directly by passing text. Launcher mode and native mode both load this
            // factory (see pi-native.ts), so one registration covers both.
            pi.registerCommand("acp-rule", {
                description: "Persistent rules for this session (same list as the acp_rule tool). Usage: /acp-rule [text to record]",
                handler: async (args, ctx) => {
                    const notify = (message: string, type?: string): void => {
                        try {
                            ctx.ui?.notify?.(message, type);
                        } catch {
                            // host UI unavailable — the command is best-effort
                        }
                    };
                    const proxyBase = detectProxyBase(ctx.model?.baseUrl);
                    if (proxyBase === undefined) {
                        notify(noProxyWarning(agent), "warning");
                        return;
                    }
                    const conversationId = sessionIdOf(ctx) ?? "unknown";
                    const ruleText = (args ?? "").trim();
                    const toolArgs = ruleText.length > 0 ? { rule: ruleText } : {};
                    let text: string;
                    try {
                        text = await forwardTool(proxyBase, conversationId, "acp_rule", toolArgs);
                    } catch (err) {
                        notify(`bili: acp_rule failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                        return;
                    }
                    // #1192 note channel (disabledOptionalToolNote): the feature is off in
                    // this session's effective config — surface the enablement hint instead
                    // of echoing the model-facing note into the transcript.
                    if (text.startsWith("acp_rule is not enabled")) {
                        notify("bili: acp_rule is not enabled on this bili proxy — set compress.rules.enabled: true in your bili config", "warning");
                        return;
                    }
                    // Persistent transcript output (TUI + web hosts like pi-web). The proxy strips
                    // the wrapped message from the model context by content signature
                    // (src/acp-panel.ts), so it never reaches the LLM; notify() is the fallback
                    // for hosts without sendMessage (older pi).
                    if (typeof pi.sendMessage === "function") {
                        try {
                            pi.sendMessage({ customType: "bili-acp-rule", content: wrapRuleReport(text), display: true });
                            return;
                        } catch (err) {
                            console.error(`bili-plugin(${agent}): sendMessage failed (${err instanceof Error ? err.message : String(err)}) — falling back to notify`);
                        }
                    }
                    notify(text, "info");
                },
            });
        }
        pi.on("before_provider_headers", async (event, ctx) => {
            try {
                // #1243: on the native lane the proxy origin lands via an async
                // bootstrap that writes BILLION_CONTEXT_PROXY only after the spawn;
                // a one-shot (-p) fires this event exactly once, inside that
                // window. Await the writer's ready promise instead of racing it —
                // hosts without a native entry register no waiter and fall
                // straight through to wire mode.
                let proxyBase = proxyBaseForCtx(ctx);
                if (proxyBase === undefined) proxyBase = await awaitNativeProxyOrigin();
                if (proxyBase === undefined) return;
                const headers = (event as unknown as { headers?: Record<string, string> }).headers;
                if (headers === undefined || typeof headers !== "object" || Array.isArray(headers)) return;
                // #1214: pi's runner AWAITS async handlers (emitBeforeProviderHeaders),
                // so the ownership claim serializes behind tool registration instead
                // of racing it. A one-shot (`pi -p`) dispatches exactly ONE request —
                // with fire-and-forget registration it rode wire mode forever and
                // bound as an anonymous pfa session. registerTools is idempotent
                // (sid-cached, pending-deduped, retryAt-throttled), so the await is
                // bounded; a permanently failing manifest fetch still degrades to
                // wire mode — a graceful fallback rather than a tool-less session.
                try {
                    await registerTools(pi, ctx, state, agent);
                } catch (err) {
                    console.error(`bili-plugin(${agent}): tool registration failed (${err instanceof Error ? err.message : String(err)}) — riding wire mode for this request`);
                }
                // The x-bili-plugin marker tells the proxy "the client owns the
                // ACP tools natively — skip wire-level injection". Ownership is
                // claimed only once tools are registered (#162). In launcher mode
                // the manifest fetch is primed at extension load time (#1217), so
                // by round 1 registration has almost always completed.
                if (state.toolsReady === true) {
                    const sid = sessionIdOf(ctx);
                    if (sid !== undefined) headers["x-bili-plugin-conversation"] = sid;
                    if (sid !== undefined && sid.length > 0) {
                        state.carriedSids ??= new Set();
                        state.carriedSids.add(sid);
                    }
                    headers["x-bili-plugin"] = agent;
                    const window = ctx.model?.contextWindow;
                    if (typeof window === "number" && Number.isFinite(window) && window > 0) {
                        headers["x-bili-plugin-context-window"] = String(Math.floor(window));
                    }
                    // Runtime-info (#955): model id + configured max output.
                    // pi's model config exposes id / contextWindow / baseUrl;
                    // maxTokens lives on the model object when configured.
                    const modelId = ctx.model?.id;
                    if (typeof modelId === "string" && modelId.length > 0) {
                        headers["x-bili-plugin-model"] = modelId;
                        const maxOut = (ctx.model as { maxTokens?: unknown } | undefined)?.maxTokens;
                        if (typeof maxOut === "number" && Number.isFinite(maxOut) && maxOut > 0) headers["x-bili-plugin-max-output"] = String(Math.floor(maxOut));
                        reportRuntimeInfoOnChange(proxyBase, { agent, model: modelId, contextWindow: typeof window === "number" && window > 0 ? Math.floor(window) : undefined, maxOutput: typeof maxOut === "number" && maxOut > 0 ? Math.floor(maxOut) : undefined, baseURL: ctx.model?.baseUrl, source: "client-config" });
                    }
                }
            } catch (err) {
                console.error(`bili-plugin(${agent}): header stamp skipped (${err instanceof Error ? err.message : String(err)})`);
            }
        });
        // omp never emits before_provider_headers — where pi stamps the
        // x-bili-plugin-* headers and reports runtime info (#955) — so omp's
        // report rides this per-request event instead: POST only, deduped per
        // model switch, gated on toolsReady like pi's header path (ownership
        // claim = ACP tools registered; round 1 rides wire mode).
        function reportOmpRuntimeInfo(ctx: Ctx): void {
            if (state.toolsReady !== true) return;
            const modelId = ctx.model?.id;
            if (typeof modelId !== "string" || modelId.length === 0) return;
            const window = ctx.model?.contextWindow;
            const maxOut = (ctx.model as { maxTokens?: unknown } | undefined)?.maxTokens;
            reportRuntimeInfoOnChange(proxyBaseForCtx(ctx), { agent, model: modelId, contextWindow: typeof window === "number" && window > 0 ? Math.floor(window) : undefined, maxOutput: typeof maxOut === "number" && maxOut > 0 ? Math.floor(maxOut) : undefined, baseURL: ctx.model?.baseUrl, source: "client-config" });
        }
        pi.on("before_provider_request", async (event, ctx) => {
            // omp emits this per model request (but never before_provider_headers);
            // it doubles as the retry driver when the session_start manifest
            // fetch raced the proxy startup. Cached by sid, throttled by retryAt.
            // #1230: omp's runner also AWAITS async handlers (emitBeforeProviderRequest)
            // and uses the resolved value as the outgoing payload — so the plugin-mode
            // claim serializes behind tool registration instead of racing it. For omp
            // the claim is the identity registration that runs INSIDE registerTools
            // (after the manifest fetch): a one-shot (`omp -p`) dispatches exactly ONE
            // request, and with fire-and-forget registration it left before the proxy
            // saw the conversation id — bound as an anonymous pfa session, rode proxy
            // mode forever, no round 2 to self-heal. registerTools is idempotent
            // (sid-cached, pending-deduped, retryAt-throttled), so the await is bounded
            // (worst case = manifest fetch + identity POST timeouts); a permanently
            // failing manifest fetch still degrades to wire mode.
            try {
                await registerTools(pi, ctx, state, agent);
            } catch (err) {
                console.error(`bili-plugin(${agent}): tool registration failed (${err instanceof Error ? err.message : String(err)}) — riding wire mode for this request`);
            }
            if (agent === "omp") reportOmpRuntimeInfo(ctx);
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
