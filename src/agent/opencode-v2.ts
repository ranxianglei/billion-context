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
import { forwardTool, proxyBaseFromEnv, proxyBaseFromUrl, reportCompactionBoundary } from "./shared.js";

type V2Registration = { dispose?: () => void | Promise<void> };

interface V2Headers {
    set(name: string, value: string): void;
}

export interface V2HttpRequestEvent {
    sessionID?: unknown;
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

interface V2CatalogModelEntry {
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
    windowsAt?: number;
}

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

export interface OpencodeV2SetupOptions {
    /** Native mode only: called for EVERY outgoing provider request before
     *  stamping. Owns proxy discovery and URL rewriting to the self-spawned
     *  proxy (idempotent on already-routed URLs) and sets state.proxyBase
     *  when traffic is routed. Absent in launcher mode (no routing). */
    route?: (e: V2HttpRequestEvent, state: V2State) => void | Promise<void>;
}

export function createOpencodeV2Setup(options: OpencodeV2SetupOptions = {}): (ctx: V2PluginContext) => Promise<() => void> {
    return async (ctx: V2PluginContext): Promise<() => void> => {
        const ac = new AbortController();
        const state: V2State = {};
        const registrations: V2Registration[] = [];

        const stampHeaders = (e: V2HttpRequestEvent): void => {
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

        const subscription = ctx.event?.subscribe?.({ signal: ac.signal });
        if (subscription && typeof subscription[Symbol.asyncIterator] === "function") {
            void (async () => {
                try {
                    for await (const evt of subscription) {
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
