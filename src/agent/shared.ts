// Shared thin-plugin core for agent-side extensions ("内外呼应", issue #1).
// The agent plugin is a PURE PROTOCOL CLIENT: no acp-kernel import, no
// compression logic. The proxy stays the single compression authority; the
// plugin only (1) detects the proxy, (2) fetches the tool manifest (single
// source of truth), (3) forwards tool executes, (4) reads status. Same
// package as the proxy ⇒ same version ⇒ no kernel-skew bug class.

import path from "node:path";
import { existsSync } from "node:fs";

export type ManifestTool = {
    name: string;
    description?: string;
    inputSchema: unknown;
};

const MANIFEST_TIMEOUT_MS = 5000;
const TOOL_TIMEOUT_MS = 60000;
const STATUS_TIMEOUT_MS = 5000;

/** Detect the proxy from a provider baseUrl's `/bili/` zero-config prefix.
 *  The real prefix embeds the full upstream URL (`/bili/https://…`), so the
 *  check requires `bili` as the first path segment followed by an http(s)
 *  URL — a plain `/foo/bili/` path segment is NOT a bili proxy.
 *  Returns the proxy origin (scheme//host) the request will actually hit. */
export function proxyBaseFromUrl(baseUrl: string | undefined): string | undefined {
    if (!baseUrl) return undefined;
    try {
        const url = new URL(baseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
        const segments = url.pathname.split("/").filter((s) => s.length > 0);
        if (segments[0] !== "bili") return undefined;
        const rest = url.pathname.slice(url.pathname.indexOf("bili") + "bili".length);
        if (!/^\/https?:\/\//.test(rest)) return undefined;
        return `${url.protocol}//${url.host}`;
    } catch {
        return undefined;
    }
}

/** MITM transparent mode has no `/bili/` prefix; the proxy's launcher exports
 *  BILLION_CONTEXT_PROXY. A stale value surfaces as a tool-forward error. */
export function proxyBaseFromEnv(): string | undefined {
    const raw = process.env.BILLION_CONTEXT_PROXY?.trim();
    if (!raw) return undefined;
    try {
        const url = new URL(raw);
        return url.protocol === "http:" || url.protocol === "https:" ? `${url.protocol}//${url.host}` : undefined;
    } catch {
        return undefined;
    }
}

export function detectProxyBase(baseUrl: string | undefined): string | undefined {
    if (process.env.BILLION_CONTEXT_PLUGIN === "0") return undefined;
    return proxyBaseFromUrl(baseUrl) ?? proxyBaseFromEnv();
}

async function fetchJson(url: string, init: RequestInit | undefined, timeoutMs: number, externalSignal?: AbortSignal): Promise<{ ok: boolean; status: number; json: unknown }> {
    const ac = new AbortController();
    // An already-aborted external signal never fires its "abort" event, so
    // forward the state directly — otherwise only the timeout could stop
    // the request, turning an instant cancel into a timeout wait.
    if (externalSignal?.aborted) ac.abort();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onExternalAbort = () => ac.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
        let res: Response;
        try {
            res = await fetch(url, { ...init, signal: ac.signal });
        } catch (err) {
            if (ac.signal.aborted && !externalSignal?.aborted) throw new Error(`timeout after ${timeoutMs}ms: ${url}`);
            throw err;
        }
        const text = await res.text();
        let json: unknown = undefined;
        try {
            json = JSON.parse(text);
        } catch {
            json = undefined;
        }
        return { ok: res.ok, status: res.status, json };
    } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onExternalAbort);
    }
}

export async function fetchManifest(proxyBase: string, format: "anthropic" | "openai" = "anthropic"): Promise<ManifestTool[]> {
    const { ok, status, json } = await fetchJson(`${proxyBase}/__bili/plugin/manifest`, undefined, MANIFEST_TIMEOUT_MS);
    if (!ok || !json || typeof json !== "object") throw new Error(`manifest fetch failed: ${status}`);
    if (format === "openai") {
        // OpenAI function style: {name, description, parameters} (plain JSON Schema).
        const data = json as { tools?: { openai?: { name?: string; description?: string; parameters?: unknown }[] } };
        const tools = (data.tools?.openai ?? []).filter((t): t is { name: string; description?: string; parameters?: unknown } => typeof t.name === "string");
        if (tools.length === 0) throw new Error("manifest served no openai tools");
        return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters ?? { type: "object", properties: {} } }));
    }
    const data = json as { tools?: { anthropic?: { name?: string; description?: string; input_schema?: unknown }[] } };
    const tools = (data.tools?.anthropic ?? []).filter((t): t is { name: string; description?: string; input_schema?: unknown } => typeof t.name === "string");
    if (tools.length === 0) throw new Error("manifest served no anthropic tools");
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema ?? { type: "object", properties: {} } }));
}

const COMPACT_TIMEOUT_MS = 5000;

/** Report a host-native compaction boundary to the proxy archive (#395):
 *  hosts that compact natively (opencode) cannot cancel it, so the proxy
 *  marks the boundary and archives unreachable blocks. Fire-and-forget at
 *  call sites — a missed report degrades to stale blocks, not broken turns. */
export async function reportCompactionBoundary(proxyBase: string, conversationId: string): Promise<void> {
    await fetchJson(`${proxyBase}/__bili/plugin/compact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId }),
    }, COMPACT_TIMEOUT_MS);
}

export async function forwardTool(proxyBase: string, conversationId: string, tool: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const { ok, status, json } = await fetchJson(`${proxyBase}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, tool, args: args ?? {} }),
    }, TOOL_TIMEOUT_MS, signal);
    const data = json as { ok?: boolean; result?: string; error?: string } | undefined;
    if (!ok || !data?.ok) {
        throw new Error(`bili proxy tool ${tool} failed (${status}): ${data?.error ?? "unknown error"}`);
    }
    return data.result ?? "";
}

/** Soft-fail by design: the status read is best-effort UI data; undefined
 *  means "no data" whether the proxy is down or the session is unknown. */
export async function fetchStatus(proxyBase: string, conversationId: string): Promise<Record<string, unknown> | undefined> {
    const { ok, json } = await fetchJson(`${proxyBase}/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId)}`, undefined, STATUS_TIMEOUT_MS);
    if (!ok || !json || typeof json !== "object") return undefined;
    return json as Record<string, unknown>;
}

/** Wire-mode status read (dsh): those clients carry no per-conversation id
 *  the proxy could bind, so ask for the most recently active session instead
 *  (fallback=latest). Same soft-fail contract as fetchStatus. */
export async function fetchStatusLatest(proxyBase: string): Promise<Record<string, unknown> | undefined> {
    // conversationId must be non-empty (server rejects the empty string), but
    // any unknown id is fine: fallback=latest then resolves the most recently
    // active session.
    const { ok, json } = await fetchJson(`${proxyBase}/__bili/plugin/status?conversationId=dsh&fallback=latest`, undefined, STATUS_TIMEOUT_MS);
    if (!ok || !json || typeof json !== "object") return undefined;
    return json as Record<string, unknown>;
}

/** Liveness + version probe for status UIs: same loopback origin as the
 *  status endpoint, so a 404 status + a live manifest means "proxy up,
 *  conversation not seen yet" — an armed-but-idle state, not an error. */
export async function fetchProxyVersion(proxyBase: string): Promise<string | undefined> {
    const { ok, json } = await fetchJson(`${proxyBase}/__bili/plugin/manifest`, undefined, STATUS_TIMEOUT_MS);
    if (!ok || !json || typeof json !== "object") return undefined;
    const version = (json as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
}

/** Identity + protocol probe for lazy local spawn (#809): one manifest GET that
 *  both confirms the origin is OUR proxy (not a foreign service squatting the
 *  port) and reads its protocol/version. Soft-fail by design — `connected:false`
 *  covers both "nothing listening" and "something else answered", so callers can
 *  distinguish adopt-vs-spawn-vs-stand-down without try/catch. */
export interface ProxyProbe {
    connected: boolean;
    identityOk: boolean;
    protocolVersion?: number;
    version?: string;
}

export async function probeProxy(proxyBase: string, timeoutMs = STATUS_TIMEOUT_MS): Promise<ProxyProbe> {
    try {
        const { ok, json } = await fetchJson(`${proxyBase}/__bili/plugin/manifest`, undefined, timeoutMs);
        if (!ok || !json || typeof json !== "object") return { connected: false, identityOk: false };
        const data = json as { proxy?: unknown; protocolVersion?: unknown; version?: unknown };
        return {
            connected: true,
            identityOk: data.proxy === "billion-context",
            protocolVersion: typeof data.protocolVersion === "number" ? data.protocolVersion : undefined,
            version: typeof data.version === "string" ? data.version : undefined,
        };
    } catch {
        return { connected: false, identityOk: false };
    }
}

/** Resolve a real Node runtime for spawning the proxy from INSIDE a host process
 *  (#809). process.execPath is NOT reliable there: under a native host binary
 *  (e.g. the Mach-O arm64 OpenCode CLI) it points at the host executable, not Node,
 *  so spawning it with dist/index.js just prints CLI help and exits. Order:
 *  execPath if it is node -> BILLION_CONTEXT_NODE override -> PATH walk -> undefined
 *  (caller fails loud-and-inert). Preferring an already-running Node keeps the
 *  launcher path byte-identical regardless of env. Dependency-injectable so every
 *  branch is testable. REUSE for ALL in-host proxy spawns (pi-native #706 / #519) —
 *  never assume process.execPath is Node. */
export interface NodeLookupOpts {
    execPath?: string;
    pathEnv?: string;
    exists?: (p: string) => boolean;
}

export function findNodeRuntime(opts: NodeLookupOpts = {}): string | undefined {
    const execPath = opts.execPath ?? process.execPath;
    const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
    const exists = opts.exists ?? existsSync;
    if (/^node(\.exe)?$/i.test(path.basename(execPath))) return execPath;
    const override = process.env.BILLION_CONTEXT_NODE;
    if (override && override.length > 0 && exists(override)) return override;
    for (const dir of pathEnv.split(path.delimiter)) {
        if (!dir) continue;
        for (const name of ["node.exe", "node"]) {
            const candidate = path.join(dir, name);
            if (exists(candidate)) return candidate;
        }
    }
    return undefined;
}
