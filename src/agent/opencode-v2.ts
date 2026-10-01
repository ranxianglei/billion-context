// Shared OpenCode 2.x (V2 plugin API) setup factory — one implementation of
// tool registration / header stamping / context-window refresh / compaction
// boundary reporting used by BOTH deployment modes:
//   - launcher mode: src/agent/opencode.ts (proxy pointed at by config/env)
//   - native mode:   src/agent/opencode-native.ts (self-spawned proxy)
// Keeping the protocol logic here means the two modes cannot drift apart.
//
// No acp-kernel, no compression logic — the proxy is the single compression
// authority. Structural types only (no @opencode/plugin import) so this file
// stays loadable under both host generations via the object exports above it
// (V2 validates `{ id, setup }`; V1 >= 1.18.29 calls `.server()`).
//
// Runtime API facts — VERSION-SPECIFIC (the 2.x plugin surface changes between
// builds; do not generalize beyond the build named):
// - next-17444 pre-release (probed live by the author): model.request registers
//   but NEVER FIRES; http.request fires per outgoing provider request with a
//   fetch Request at e.request (mutating e.request.headers reaches the wire);
//   NO ctx.tool.reload(); command editor list/get/update/remove only (no ADD —
//   hence no /acp under V2; acp_status tool is the in-host equivalent).
// - @opencode/cli 2.0.x stable (provenance confirmed during #754 review;
//   probed live on 2.0.1 + 2.0.3): setup() is chosen over server(); BOTH
//   model.request and http.request hooks fire (e.request mutation reaches the
//   wire); ctx.tool = {reload, transform, hook} (reload EXISTS here);
//   ctx.command.transform(editor.add) CAN add commands (TUI invocation needs
//   Tab+Enter completion accept; `run` mode dispatches no slash commands at
//   all); configured `plugin` entries must be DIRECTORIES (file paths are
//   rejected with WARN "configured plugin path must be a directory"; the
//   directory's index.js is the entrypoint) — the launcher wraps this single
//   file accordingly (src/launcher.ts opencodeMajorVersion). End-to-end
//   verified on 2.0.3: true plugin mode, native tools via the plugin tool
//   endpoint, zero wire-level injection.
// - @opencode/cli 2.0.18 (probed live during #1569 triage): Context exposes
//   model/provider domains and NO ctx.catalog key at all — the
//   catalog.model.list seam below is dead on every stable build, which is why
//   x-bili-plugin-context-window never got stamped and the proxy silently
//   fell back to registry windows (#1569). The live seam is ctx.model.list()
//   → { location, data: ModelInfo[] } with ModelInfo.limit = { context,
//   output } sourced from opencode.json's provider model config; the old
//   catalog seam is kept as a hedge for builds that expose it.
// - npm dev builds 2026-09-13 / 2026-09-14 (probed live during #754 review):
//   first loads plugins via V1 server() only; second exposes setup() but has
//   no ctx.session / ctx.tool at all. Adjacent dev builds disagree with each
//   other and with both of the above.
// Consequence: every registration below uses optional chaining so the plugin
// is inert-safe on any surface; when no seam fires, sessions transparently run
// in proxy mode (wire-level tool injection) instead of failing. Tools stay
// registered synchronously from bundled schemas (exact parity with the proxy's
// openai tool list, src/compress-tool.ts) because reload-based refresh is not
// available on all observed surfaces.

import { ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI } from "../compress-tool.js";
import { fetchProxyVersion, fetchStatus, fitNoticeDescription, forwardTool, postIdentityRegister, proxyBaseFromEnv, proxyBaseFromUrl, reportCompactionBoundary, reportRuntimeInfoOnChange, V2_SYNTHETIC_TEXT } from "./shared.js";

// OpenCode V2 TUI renders a synthetic message as a visible Notice row only when its display text fits the
// timeline cap (~1KB): longer text renders nothing (#880). Under the cap, panels go to description verbatim;
// over it, fitNoticeDescription hoists the Web UI deep link to line one and keeps whole leading lines (#1602) —
// the full panel stays reachable through that link.
const V2_SYNTHETIC_VISIBLE_MAX = 1024;
// /acp-cache renders a report the user explicitly asked to read — unlike the
// status panel whose leading lines carry the essence, its tail (LINE ITEMS)
// is the payload, so it gets a wider visible cap than V2_SYNTHETIC_VISIBLE_MAX.
const V2_CACHE_REPORT_VISIBLE_MAX = 8192;

type V2Registration = { dispose?: () => void | Promise<void> };

interface V2Headers {
    set(name: string, value: string): void;
}

export interface V2HttpRequestEvent {
    sessionID?: unknown;
    agent?: unknown;
    model?: { providerID?: unknown; id?: unknown };
    request?: { url?: unknown; headers?: V2Headers | null };
}

interface V2ToolEditor {
    add(tool: {
        name: string;
        description?: string;
        input: unknown;
        options?: { namespace?: string; permission?: string; codemode?: boolean; pinned?: boolean };
        execute: (input: Record<string, unknown>, ctx: { sessionID: string }) => Promise<{ content: string }>;
    }): void;
}

interface V2CommandInvocation {
    sessionID?: unknown;
    [key: string]: unknown;
}

interface V2CommandEditor {
    add(def: {
        name: string;
        description?: string;
        execute: (input: V2CommandInvocation) => Promise<void>;
    }): void;
}

interface V2CatalogModelEntry {
    providerID?: unknown;
    id?: unknown;
    limit?: { context?: unknown; output?: unknown };
}

export interface V2PluginContext {
    session?: {
        hook?: (name: string, cb: (e: V2HttpRequestEvent) => void | Promise<void>) => void | Promise<V2Registration | undefined>;
        synthetic?: (input: { sessionID: string; text: string; description?: string; resume?: boolean }) => Promise<unknown>;
    };
    tool?: {
        transform?: (cb: (editor: V2ToolEditor) => void) => void | Promise<V2Registration | undefined>;
    };
    command?: {
        transform?: (cb: (editor: V2CommandEditor) => void) => void | Promise<V2Registration | undefined>;
    };
    event?: { subscribe?: (opts?: { signal?: AbortSignal }) => AsyncIterable<{ type?: unknown; data?: Record<string, unknown> }> | undefined };
    /** v2.0.x stable (probed @opencode/cli 2.0.18): ModelApi.list() →
     *  { location, data: ModelInfo[] } with limit = { context, output }.
     *  These builds expose NO ctx.catalog at all (#1569). */
    model?: { list?: () => Promise<{ data?: V2CatalogModelEntry[] }> | undefined };
    catalog?: {
        model?: { list?: () => Promise<{ data?: V2CatalogModelEntry[] }> | undefined };
        /** Newer dev builds: provider records carrying per-model maps (a Map,
         *  or a plain object once serialized across an RPC boundary). */
        provider?: {
            list?: () => Array<{ provider?: { id?: unknown }; models?: Map<string, V2CatalogModelEntry> | Record<string, V2CatalogModelEntry> }> | undefined;
        };
    };
}

const WINDOW_REFRESH_MS = 60000;

// Kill switch = fully inert (same semantics as detectProxyBase): gates header stamping, tool forwarding, compaction reporting.
const pluginDisabled = (): boolean => process.env.BILLION_CONTEXT_PLUGIN === "0";

const V2_BILI_TOOLS = [...ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI].map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input: t.function.parameters,
}));

export interface V2State {
    proxyBase?: string;
    windows?: Map<string, number>;
    outputs?: Map<string, number>;
    windowsAt?: number;
    windowsWarned?: boolean;
}

function refreshWindows(ctx: V2PluginContext, state: V2State): void {
    const now = Date.now();
    if (state.windows && state.windowsAt !== undefined && now - state.windowsAt < WINDOW_REFRESH_MS) return;
    state.windowsAt = now;
    // #1569: each seam commits INDEPENDENTLY into one shared map pair, one
    // .then hop from its own settle — the same microtask profile as the
    // original single-await implementation (which the v2 test suite proves
    // stamps by round 2). A shared Promise.all settlement point costs extra
    // hops the client's next request outruns under Node's microtask FIFO,
    // leaving the header unstamped on exactly the round that matters.
    const map = new Map<string, number>();
    const outMap = new Map<string, number>();
    let pending = 0;
    const harvest = (pid: unknown, id: unknown, m: V2CatalogModelEntry | undefined): void => {
        const p = typeof pid === "string" ? pid : "";
        const i = typeof id === "string" ? id : "";
        const c = m?.limit?.context;
        if (p && i && typeof c === "number" && Number.isFinite(c) && c > 0) map.set(`${p}/${i}`, Math.floor(c));
        const o = m?.limit?.output;
        if (p && i && typeof o === "number" && Number.isFinite(o) && o > 0) outMap.set(`${p}/${i}`, Math.floor(o));
    };
    const commit = (): void => {
        if (map.size > 0) state.windows = map;
        if (outMap.size > 0) state.outputs = outMap;
        // #1569: degradation must not be silent — without a usable limit the
        // x-bili-plugin-context-window header goes unstamped and the proxy
        // sizes against registry/configured windows instead of the host's own
        // opencode.json config. Say so once per plugin instance (skipped while
        // an earlier harvest still supplies a window).
        if (--pending === 0 && map.size === 0 && !state.windows && !state.windowsWarned) {
            state.windowsWarned = true;
            console.warn("[bili-opencode] no usable model context limits found (tried ctx.model.list + ctx.catalog seams) — x-bili-plugin-context-window goes unstamped and the bili proxy falls back to registry/configured windows; opencode.json limit.context is NOT reaching the proxy");
        }
    };
    const safeModelList = (fn?: () => Promise<{ data?: V2CatalogModelEntry[] }> | undefined): Promise<{ data?: V2CatalogModelEntry[] }> => {
        try {
            const p = fn ? fn() : undefined;
            return (p ?? Promise.resolve({})).catch(() => ({}));
        } catch {
            return Promise.resolve({});
        }
    };
    const safeProviderList = (): Promise<Array<{ provider?: { id?: unknown }; models?: Map<string, V2CatalogModelEntry> | Record<string, V2CatalogModelEntry> }>> => {
        type Records = Array<{ provider?: { id?: unknown }; models?: Map<string, V2CatalogModelEntry> | Record<string, V2CatalogModelEntry> }>;
        try {
            const raw = ctx.catalog?.provider?.list?.();
            const norm = (v: unknown): Records => (Array.isArray(v) ? v as Records : []);
            const p = raw != null && typeof (raw as { then?: unknown }).then === "function"
                ? Promise.resolve(raw).then(norm)
                : Promise.resolve(norm(raw));
            return p.catch(() => []);
        } catch {
            return Promise.resolve([]);
        }
    };
    // Seam 1 — v2.0.x stable (probed @opencode/cli 2.0.18): ctx.model.list().
    // These builds have no ctx.catalog at all, so seam 2 alone left the window
    // header unstamped on every stable release (#1569).
    // Seam 2 — hedge for builds/tests exposing catalog.model.list().
    pending += 2;
    void safeModelList(ctx.model?.list).then((res) => {
        try {
            for (const m of res.data ?? []) harvest(m.providerID, m.id, m);
        } catch { /* malformed entries */ }
        commit();
    });
    void safeModelList(ctx.catalog?.model?.list).then((res) => {
        try {
            for (const m of res.data ?? []) harvest(m.providerID, m.id, m);
        } catch { /* malformed entries */ }
        commit();
    });
    // Seam 3 — newer dev builds: catalog.provider.list() records. Declared
    // synchronous, but a thenable is normalized too (builds differ).
    pending += 1;
    void safeProviderList().then((records) => {
        try {
            for (const r of records) {
                const models = r?.models;
                if (models instanceof Map) {
                    for (const [mid, m] of models) harvest(typeof m.providerID === "string" ? m.providerID : r?.provider?.id, typeof m.id === "string" ? m.id : mid, m);
                } else if (models && typeof models === "object") {
                    for (const [mid, m] of Object.entries(models)) harvest(typeof m.providerID === "string" ? m.providerID : r?.provider?.id, typeof m.id === "string" ? m.id : mid, m);
                }
            }
        } catch { /* malformed records */ }
        commit();
    });
}

export interface OpencodeV2SetupOptions {
    /** Native mode only: called for EVERY outgoing provider request before
     *  stamping. Owns proxy discovery and URL rewriting to the self-spawned
     *  proxy (idempotent on already-routed URLs) and sets state.proxyBase
     *  when traffic is routed. Absent in launcher mode (no routing). */
    route?: (e: V2HttpRequestEvent, state: V2State) => void | Promise<void>;
    /** #1362: cooldown between failed derived-session register attempts (tests inject). */
    derivedRetryMs?: number;
}

export function createOpencodeV2Setup(options: OpencodeV2SetupOptions = {}): (ctx: V2PluginContext) => Promise<() => void> {
    return async (ctx: V2PluginContext): Promise<() => void> => {
        const ac = new AbortController();
        const state: V2State = {};
        const registrations: V2Registration[] = [];

        // #1362: derived-session inheritance for the V2 lane (same register
        // channel as pi/omp/V1, #1333). Parents are learned from
        // session.created events (wire shape probed on @opencode/cli 2.0.3:
        // data.sessionID + optional data.parentID); each derived sid is then
        // identity-registered once by its first stamped request. Fire-and-forget
        // with per-sid cooldown after failure; root sessions never report.
        const derivedParent = new Map<string, string>();
        const derivedReported = new Map<string, "pending" | "done">();
        const derivedRetryAt = new Map<string, number>();
        const derivedRetryMs = options.derivedRetryMs ?? 10000;
        const reportDerived = (sid: string): void => {
            const base = state.proxyBase;
            if (!base || !sid || derivedReported.has(sid)) return;
            const retryAt = derivedRetryAt.get(sid);
            if (retryAt !== undefined && Date.now() < retryAt) return;
            const parent = derivedParent.get(sid);
            if (parent === undefined) return;
            derivedReported.set(sid, "pending");
            void postIdentityRegister(base, sid, "opencode", parent).then(
                () => {
                    derivedReported.set(sid, "done");
                },
                () => {
                    derivedReported.delete(sid);
                    derivedRetryAt.set(sid, Date.now() + derivedRetryMs);
                },
            );
        };

        const stampHeaders = (e: V2HttpRequestEvent): void => {
            const headers = e.request?.headers;
            const sid = typeof e.sessionID === "string" ? e.sessionID : "";
            if (!headers || typeof headers.set !== "function" || !sid || !state.proxyBase) return;
            headers.set("x-bili-plugin-conversation", sid);
            headers.set("x-bili-plugin", "opencode");
            // #1102: one session id per persona (subagents get child ids) —
            // instruction drift (AGENTS.md reconcile) must not fork the
            // compression session.
            headers.set("x-bili-plugin-instructions-mutable", "1");
            // #1699: forward the host's per-request persona so the proxy can classify
            // side requests by intent — opencode v2 title-gen carries no max_tokens, so
            // the budget heuristic alone can never see it. Stamped for every non-empty
            // id; the proxy acts only on known side-request agents (main ids are inert).
            const agentId = typeof e.agent === "string" ? e.agent.trim() : "";
            if (agentId.length > 0) headers.set("x-bili-plugin-agent", agentId);
            const model = e.model;
            if (model && typeof model.providerID === "string" && typeof model.id === "string") {
                const key = `${model.providerID}/${model.id}`;
                const window = state.windows?.get(key);
                if (window !== undefined) headers.set("x-bili-plugin-context-window", String(window));
                const output = state.outputs?.get(key);
                if (output !== undefined) headers.set("x-bili-plugin-max-output", String(output));
                headers.set("x-bili-plugin-model", model.id);
                reportRuntimeInfoOnChange(state.proxyBase, { agent: "opencode", model: model.id, contextWindow: window, maxOutput: output, source: "client-config" });
            }
            reportDerived(sid);
        };

        const httpRequestHook = async (e: V2HttpRequestEvent): Promise<void> => {
            if (pluginDisabled()) return;
            const url = e.request?.url;
            if (typeof url !== "string") return;
            if (options.route !== undefined) {
                // Native mode: route owns discovery + rewriting (it is called
                // per request even once state.proxyBase is known, because the
                // URL rewrite must happen per request and env detection alone
                // would skip it after bootstrap).
                await options.route(e, state);
            } else if (!state.proxyBase) {
                state.proxyBase = proxyBaseFromUrl(url) ?? proxyBaseFromEnv();
            }
            if (!state.proxyBase) return;
            refreshWindows(ctx, state);
            stampHeaders(e);
        };

        const hookReg = await ctx.session?.hook?.("http.request", httpRequestHook);
        if (hookReg) registrations.push(hookReg);

        const toolReg = await ctx.tool?.transform?.((editor) => {
            for (const t of V2_BILI_TOOLS) {
                editor.add({
                    name: t.name,
                    description: t.description,
                    input: t.input,
                    options: { codemode: false, permission: "allow" },
                    execute: async (args, tctx) => {
                        if (pluginDisabled()) return { content: "bili: disabled (BILLION_CONTEXT_PLUGIN=0)" };
                        const base = state.proxyBase ?? proxyBaseFromEnv();
                        if (!base) return { content: "bili: no proxy detected (launch opencode through `bili opencode`, or point the provider baseURL at the bili proxy)" };
                        try {
                            // Panel-first for acp_status: the proxy's status
                            // endpoint renders the same rich panel the /acp
                            // command shows; the forwarded kernel tool returns
                            // the legacy flat report. acp_status is read-only,
                            // so reading the panel changes no state. Fall back
                            // to the tool call when no panel comes back (older
                            // proxy, unknown conversation).
                            if (t.name === "acp_status") {
                                const status = await fetchStatus(base, tctx.sessionID);
                                const panel = status?.["panel"];
                                if (typeof panel === "string" && panel.length > 0) return { content: panel };
                            }
                            const result = await forwardTool(base, tctx.sessionID, t.name, args);
                            return { content: result };
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            if (msg.includes("no model request has arrived with this conversation id yet")) {
                                return { content: "bili: no ACP state for this session yet — no model request has been routed through the proxy. Tell the user to send one normal message first; ACP activates automatically once model traffic flows through the proxy (verify the provider baseURL goes through bili, or launch via `bili opencode` / the installed plugin)." };
                            }
                            return { content: msg };
                        }
                    },
                });
            }
        });
        if (toolReg) registrations.push(toolReg);

        // /acp status command (#809): registered via the V2 command editor where
        // supported (2.0.x stable; inert-safe otherwise) and rendered as a
        // synthetic non-model-turn message; TUI-only (`run` dispatches no slash cmds).
        try {
            const commandReg = await ctx.command?.transform?.((editor) => {
                editor.add({
                    name: "acp",
                    description: "Show ACP status (billion-context proxy)",
                    execute: async (input) => {
                        const sid = typeof input.sessionID === "string" ? input.sessionID : "";
                        if (!sid) {
                            console.warn("[bili-opencode] /acp invoked without a sessionID; cannot render ACP status");
                            return;
                        }
                        let text: string;
                        let webUrl: string | undefined;
                        if (pluginDisabled()) {
                            text = "bili: disabled (BILLION_CONTEXT_PLUGIN=0)";
                        } else {
                            const base = state.proxyBase ?? proxyBaseFromEnv();
                            if (!base) {
                                text = "bili: no proxy detected (set BILLION_CONTEXT_PROXY or point the provider at the proxy's /bili/ URL, then run /acp again)";
                            } else {
                                try {
                                    const status = await fetchStatus(base, sid);
                                    if (status && typeof status.panel === "string" && status.panel.length > 0) {
                                        text = status.panel;
                                        webUrl = typeof status.webUrl === "string" && status.webUrl.length > 0 ? status.webUrl : undefined;
                                    } else if (status && status.ok === false) {
                                        let version: string | undefined;
                                        try {
                                            version = await fetchProxyVersion(base);
                                        } catch {
                                            version = undefined;
                                        }
                                        text = version !== undefined
                                            ? `billion-context@${version} — proxy connected, no ACP session yet. Send a model request, then run /acp again.`
                                            : "bili: no ACP session yet (send a model request first, then run /acp)";
                                    } else if (!status) {
                                        // fetchStatus soft-fails to undefined both when the proxy 404s an absent or
                                        // never-seen conversation and when the proxy is unreachable. Probe the
                                        // manifest to claim "connected" only when it answers.
                                        const version = await fetchProxyVersion(base).catch(() => undefined);
                                        text = version !== undefined
                                            ? `billion-context@${version} — proxy connected, no ACP session yet. Send a model request, then run /acp again.`
                                            : "bili: cannot reach the bili proxy (run `bili start`, then run /acp again)";
                                    } else {
                                        const errText = status?.error;
                                        text = typeof errText === "string" && errText.length > 0
                                            ? `bili: proxy returned no status panel (${errText})`
                                            : "bili: proxy returned no status panel";
                                    }
                                } catch (err) {
                                    text = `bili: /acp failed (${err instanceof Error ? err.message : String(err)})`;
                                }
                            }
                        }
                        try {
                            // resume:false — OpenCode V2 defaults to delivery "steer" + execution.wake(), which would
                            // start a model turn on every /acp invocation with no user input (spurious empty turns).
                            // Short panels become the visible description verbatim; long ones lead with the Web UI
                            // deep link (full panel stays reachable there) and keep their leading whole lines, so
                            // the model-facing body never repeats the whole panel (#1602).
                            const description = fitNoticeDescription(text, V2_SYNTHETIC_VISIBLE_MAX, "panel", webUrl);
                            await ctx.session?.synthetic?.({ sessionID: sid, text: V2_SYNTHETIC_TEXT, description, resume: false });
                        } catch (err) {
                            console.error(`[bili-opencode] /acp render failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    },
                });
                // #1146: human entry point for the cache-reconciliation feature —
                // same report as the acp_cache tool above. The model-facing body
                // stays the inert one-liner (V2_SYNTHETIC_TEXT), so no proxy-side
                // stripping wrap is needed here (unlike the V1 ignored-message path).
                editor.add({
                    name: "acp-cache",
                    description: "Prompt-cache reconciliation for this session (same report as the acp_cache tool). Usage: /acp-cache [full]",
                    execute: async (input) => {
                        const sid = typeof input.sessionID === "string" ? input.sessionID : "";
                        if (!sid) {
                            console.warn("[bili-opencode] /acp-cache invoked without a sessionID; cannot render the cache report");
                            return;
                        }
                        let text: string;
                        if (pluginDisabled()) {
                            text = "bili: disabled (BILLION_CONTEXT_PLUGIN=0)";
                        } else {
                            const base = state.proxyBase ?? proxyBaseFromEnv();
                            const argsText = typeof input.arguments === "string" ? input.arguments : "";
                            const toolArgs = /(^|\s)(--)?full(\s|$)/.test(argsText) ? { detail: "full" as const } : {};
                            if (!base) {
                                text = "bili: no proxy detected (set BILLION_CONTEXT_PROXY or point the provider at the proxy's /bili/ URL, then run /acp-cache again)";
                            } else {
                                try {
                                    text = await forwardTool(base, sid, "acp_cache", toolArgs);
                                } catch (err) {
                                    const msg = err instanceof Error ? err.message : String(err);
                                    text = msg.includes("no model request has arrived")
                                        ? "bili: no ACP session yet for this conversation (send a model request first, then run /acp-cache)"
                                        : `bili: cache report failed (${msg})`;
                                }
                            }
                        }
                        try {
                            const description = fitNoticeDescription(text, V2_CACHE_REPORT_VISIBLE_MAX, "report");
                            await ctx.session?.synthetic?.({ sessionID: sid, text: V2_SYNTHETIC_TEXT, description, resume: false });
                        } catch (err) {
                            console.error(`[bili-opencode] /acp-cache render failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    },
                });
            });
            if (commandReg) registrations.push(commandReg);
        } catch (err) {
            console.warn(`[bili-opencode] /acp command registration unavailable; continuing without it: ${err instanceof Error ? err.message : String(err)}`);
        }

        const subscription = ctx.event?.subscribe?.({ signal: ac.signal });
        if (subscription && typeof subscription[Symbol.asyncIterator] === "function") {
            void (async () => {
                try {
                    for await (const evt of subscription) {
                        // #1362: child sessions announce their parent here
                        // (@opencode/cli 2.0.3 wire shape: data.sessionID +
                        // optional data.parentID); reportDerived registers the
                        // link on the child's first stamped request.
                        if (evt?.type === "session.created") {
                            const data = evt.data;
                            const sid = data && typeof data.sessionID === "string" ? data.sessionID : "";
                            const parent = data && typeof data.parentID === "string" ? data.parentID : "";
                            if (sid && parent && parent !== sid) derivedParent.set(sid, parent);
                            continue;
                        }
                        if (evt?.type !== "session.compaction.ended" || pluginDisabled()) continue;
                        const data = evt.data;
                        const cid = data && typeof data.sessionID === "string" ? data.sessionID : "";
                        const base = state.proxyBase ?? proxyBaseFromEnv();
                        if (!cid || !base) continue;
                        reportCompactionBoundary(base, cid).catch(() => {});
                    }
                } catch {
                    // subscription closed (abort on cleanup)
                }
            })();
        }

        return () => {
            ac.abort();
            for (const r of registrations) {
                try {
                    void r.dispose?.();
                } catch {}
            }
            state.proxyBase = undefined;
            state.windows = undefined;
            state.windowsAt = undefined;
        };
    };
}
