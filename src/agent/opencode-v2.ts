// Shared OpenCode 2.0 (V2 plugin API) factory for the billion-context proxy.
// Two host deployments share one implementation so their wire behavior cannot
// drift (#809): the launcher entry (src/agent/opencode.ts, activates only when
// BILLION_CONTEXT_PROXY is set) and the no-launcher npm-plugin entry
// (src/agent/opencode-local.ts, spawns its own loopback proxy). Both call
// createOpencodeV2Setup with a mode-specific config; everything else — tool
// registration, header stamping, window refresh, compaction reporting, cleanup
// — lives here once.
//
// Same protocol-client contract as the V1 server in opencode.ts: no acp-kernel,
// no compression logic — the proxy is the single compression authority.
// Structural types only (no @opencode/plugin import) so this stays loadable
// under both host generations.
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
//   directory's index.js is the entrypoint). End-to-end verified on 2.0.3:
//   true plugin mode, native tools via the plugin tool endpoint, zero
//   wire-level injection.
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
import { forwardTool, reportCompactionBoundary } from "./shared.js";

export type V2Registration = { dispose?: () => void | Promise<void> };

// e.request is a WHATWG Request at runtime (OpenCode 2.0.x http.request seam):
// its .url is a readonly getter, so routing rewrites the request REFERENCE
// (which the seam allows swapping wholesale) rather than writing .url (which
// throws TypeError in strict/ESM and fails every session through the hook).
export interface V2HttpRequestEvent {
    sessionID?: unknown;
    model?: { providerID?: unknown; id?: unknown };
    request?: Request;
}

export interface V2ToolEditor {
    add(tool: {
        name: string;
        description?: string;
        input: unknown;
        options?: { namespace?: string; permission?: string; codemode?: boolean; pinned?: boolean };
        execute: (input: Record<string, unknown>, ctx: { sessionID: string }) => Promise<{ content: string }>;
    }): void;
}

export interface V2CatalogModelEntry {
    providerID?: unknown;
    id?: unknown;
    limit?: { context?: unknown };
}

export interface V2PluginContext {
    session?: {
        hook?: (name: string, cb: (e: V2HttpRequestEvent) => void | Promise<void>) => void | Promise<V2Registration | undefined>;
    };
    tool?: {
        transform?: (cb: (editor: V2ToolEditor) => void) => void | Promise<V2Registration | undefined>;
    };
    event?: { subscribe?: (opts?: { signal?: AbortSignal }) => AsyncIterable<{ type?: unknown; data?: Record<string, unknown> }> | undefined };
    catalog?: { model?: { list?: () => Promise<{ data?: V2CatalogModelEntry[] }> | undefined } | undefined };
}

export interface V2State {
    proxyBase?: string;
    windows?: Map<string, number>;
    windowsAt?: number;
}

const WINDOW_REFRESH_MS = 60000;

// Kill switch = fully inert (same semantics as detectProxyBase): gates header stamping, tool forwarding, compaction reporting.
export const pluginDisabled = (): boolean => process.env.BILLION_CONTEXT_PLUGIN === "0";

const V2_BILI_TOOLS = [...ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI].map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input: t.function.parameters,
}));

function refreshWindows(ctx: V2PluginContext, state: V2State): void {
    const now = Date.now();
    if (state.windows && state.windowsAt !== undefined && now - state.windowsAt < WINDOW_REFRESH_MS) return;
    state.windowsAt = now;
    void (async () => {
        try {
            const res = await ctx.catalog?.model?.list?.();
            const map = new Map<string, number>();
            for (const m of res?.data ?? []) {
                const pid = typeof m.providerID === "string" ? m.providerID : "";
                const id = typeof m.id === "string" ? m.id : "";
                const c = m.limit?.context;
                if (pid && id && typeof c === "number" && Number.isFinite(c) && c > 0) map.set(`${pid}/${id}`, Math.floor(c));
            }
            if (map.size > 0) state.windows = map;
        } catch {
            // catalog unavailable — window header simply goes unstamped
        }
    })();
}

function stampHeaders(e: V2HttpRequestEvent, state: V2State): void {
    const headers = e.request?.headers;
    const sid = typeof e.sessionID === "string" ? e.sessionID : "";
    if (!headers || typeof headers.set !== "function" || !sid || !state.proxyBase) return;
    headers.set("x-bili-plugin-conversation", sid);
    headers.set("x-bili-plugin", "opencode");
    const model = e.model;
    if (model && typeof model.providerID === "string" && typeof model.id === "string") {
        const window = state.windows?.get(`${model.providerID}/${model.id}`);
        if (window !== undefined) headers.set("x-bili-plugin-context-window", String(window));
    }
}

// The proxy and this plugin ship as one package, so protocol skew is rare; the
// check is a safety net for the skew window where a stale cached copy pairs a
// new proxy with an old plugin (or vice versa). An UNKNOWN or MISSING
// protocolVersion disables native tool registration (the embedded schemas may
// not match) while still letting header-stamped requests route through the
// proxy — fail closed on compatibility we cannot confirm.
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([1]);

export function isProtocolSupported(version: number | undefined): boolean {
    return typeof version === "number" && SUPPORTED_PROTOCOL_VERSIONS.has(version);
}

export interface EnsureProxyResult {
    connected: boolean;
    identityOk?: boolean;
    protocolSupported?: boolean;
    version?: string;
}

export interface OpencodeV2Config {
    /** false → fully inert (no hooks, no tools, no spawn). Local uses this to
     *  stand down when the launcher owns the proxy or the kill switch is set. */
    active?: () => boolean;
    /** Eagerly resolve the proxy base at setup time (local: options → default). */
    resolveInitialProxyBase?: () => string | undefined | Promise<string | undefined>;
    /** Confirm the resolved base is a live bili proxy, spawning one on miss
     *  (local only). Launcher omits this — it assumes the launcher started it. */
    ensureProxy?: (base: string) => Promise<EnsureProxyResult>;
    /** Rewrite the outgoing request URL to route through the proxy (local:
     *  idempotent `/bili/` prefix). Must be idempotent — the hook re-runs per
     *  request. */
    rewriteRequestUrl?: (url: string, proxyBase: string) => string | undefined;
    /** Lazily resolve the proxy base on first request (launcher: `/bili/` URL
     *  or env detection). Mutually exclusive in practice with eager resolution. */
    lazyResolveProxyBase?: (url: string) => string | undefined;
}

export function createOpencodeV2Setup(config: OpencodeV2Config): (ctx: V2PluginContext) => Promise<() => void> {
    return async (ctx: V2PluginContext): Promise<() => void> => {
        if (config.active && !config.active()) return () => {};
        const ac = new AbortController();
        const state: V2State = {};
        const registrations: V2Registration[] = [];
        let registerTools = true;

        if (config.resolveInitialProxyBase) {
            const base = await config.resolveInitialProxyBase();
            if (base) {
                if (config.ensureProxy) {
                    const ensured = await config.ensureProxy(base);
                    if (!ensured.connected) {
                        // Loud by design (v1): a local deployment that cannot reach
                        // or start its proxy degrades to inert passthrough rather
                        // than silently claiming compression it never performs.
                        console.error("[bili-opencode-local] proxy unreachable at " + base + " — running inert (requests pass through uncompressed)");
                    } else {
                        state.proxyBase = base;
                        registerTools = ensured.protocolSupported !== false;
                        if (!registerTools) console.warn("[bili-opencode-local] proxy protocol unsupported — native tools disabled");
                    }
                } else {
                    state.proxyBase = base;
                }
            }
        }

        const httpRequestHook = async (e: V2HttpRequestEvent): Promise<void> => {
            if (pluginDisabled()) return;
            try {
                const url = e.request?.url;
                if (typeof url !== "string") return;
                if (!state.proxyBase && config.lazyResolveProxyBase) {
                    state.proxyBase = config.lazyResolveProxyBase(url);
                }
                if (!state.proxyBase) return;
                if (config.rewriteRequestUrl) {
                    const next = config.rewriteRequestUrl(url, state.proxyBase);
                    // Swap the request REFERENCE to one targeting the proxy; never
                    // write e.request.url (readonly getter -> TypeError -> dead session).
                    // method/headers/body carry over from the original Request.
                    if (next && next !== url && e.request) {
                        try {
                            e.request = new Request(next, e.request);
                        } catch {
                            // body not reconstructible (e.g. consumed stream) — leave
                            // the request untouched so it proceeds direct (uncompressed)
                            // rather than crashing the host session.
                        }
                    }
                }
                refreshWindows(ctx, state);
                stampHeaders(e, state);
            } catch {
                // A throwing hook rejects the host's outgoing request and fails the
                // whole session. billion-context must never take the host down —
                // swallow and let the request proceed uncompressed.
            }
        };

        const hookReg = await ctx.session?.hook?.("http.request", httpRequestHook);
        if (hookReg) registrations.push(hookReg);

        if (registerTools) {
            const toolReg = await ctx.tool?.transform?.((editor) => {
                for (const t of V2_BILI_TOOLS) {
                    editor.add({
                        name: t.name,
                        description: t.description,
                        input: t.input,
                        options: { codemode: false, permission: "allow" },
                        execute: async (args, tctx) => {
                            if (pluginDisabled()) return { content: "bili: disabled (BILLION_CONTEXT_PLUGIN=0)" };
                            const base = state.proxyBase ?? process.env.BILLION_CONTEXT_PROXY;
                            if (!base) return { content: "bili: no proxy detected (launch opencode through `bili opencode`, or point the provider baseURL at the bili proxy)" };
                            try {
                                const result = await forwardTool(base, tctx.sessionID, t.name, args);
                                return { content: result };
                            } catch (err) {
                                return { content: err instanceof Error ? err.message : String(err) };
                            }
                        },
                    });
                }
            });
            if (toolReg) registrations.push(toolReg);
        }

        const subscription = ctx.event?.subscribe?.({ signal: ac.signal });
        if (subscription && typeof subscription[Symbol.asyncIterator] === "function") {
            void (async () => {
                try {
                    for await (const evt of subscription) {
                        if (evt?.type !== "session.compaction.ended" || pluginDisabled()) continue;
                        const data = evt.data;
                        const cid = data && typeof data.sessionID === "string" ? data.sessionID : "";
                        const base = state.proxyBase ?? process.env.BILLION_CONTEXT_PROXY;
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
