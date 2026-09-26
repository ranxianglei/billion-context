// Shared thin-plugin core for agent-side extensions ("内外呼应", issue #1).
// The agent plugin is a PURE PROTOCOL CLIENT: no acp-kernel import, no
// compression logic. The proxy stays the single compression authority; the
// plugin only (1) detects the proxy, (2) fetches the tool manifest (single
// source of truth), (3) forwards tool executes, (4) reads status. Same
// package as the proxy ⇒ same version ⇒ no kernel-skew bug class.

import { envMillis } from "./native-bootstrap.js";

export type ManifestTool = {
    name: string;
    description?: string;
    inputSchema: unknown;
};

const MANIFEST_TIMEOUT_MS = 5000;
const TOOL_TIMEOUT_MS = 60000;
const STATUS_TIMEOUT_MS = 5000;
const ATTACH_HEALTH_DEADLINE_MS = 15000;
const ATTACH_HEALTH_POLL_MS = 250;

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

// #1403: the launcher exports the proxy's MITM whitelist here so the extension
// can tell which destinations the proxy will actually decrypt. Without it the
// extension cannot distinguish "proxy will see this request" from "blind
// tunnel — the field I inject reaches the upstream verbatim".
export function mitmHostsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
    const out = new Set<string>();
    for (const raw of env.BILI_MITM_HOSTS?.split(",") ?? []) {
        const host = raw.trim().toLowerCase();
        if (host.length > 0) out.add(host);
    }
    return out;
}

/** True iff requests to baseUrl will be SEEN by the bili proxy (and thus its
 *  stamped prompt_cache_key consumed + stripped): a /bili/-wrapped URL, the
 *  BILLION_CONTEXT_PROXY origin itself, or a host on the exported MITM
 *  whitelist. Anything else rides a blind tunnel (or no proxy at all), where
 *  the stamp is pure noise that strict-schema upstreams reject (#1403). */
export function destinationRoutedThroughProxy(baseUrl: string | undefined): boolean {
    if (!baseUrl) return false;
    const viaBiliPath = proxyBaseFromUrl(baseUrl) !== undefined;
    if (viaBiliPath) return true;
    let origin: string | undefined;
    let host: string;
    try {
        const url = new URL(baseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") return false;
        origin = `${url.protocol}//${url.host}`;
        host = url.hostname.toLowerCase();
    } catch {
        return false;
    }
    if (origin === proxyBaseFromEnv()) return true;
    const mitmHosts = mitmHostsFromEnv();
    if (mitmHosts.size === 0) return false;
    for (const d of mitmHosts) {
        if (host === d || host.endsWith(`.${d}`)) return true;
    }
    return false;
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

/** Identity register (#162/#1333/#1362): tell the proxy which conversation
 *  this host session is (identity: true), optionally declaring the
 *  conversation it was derived from (parentConversationId). The proxy binds
 *  any request carrying that id into plugin mode and records a read-only
 *  parent link for derived sessions (decompress/search_context fall back to
 *  the parent chain — no state is copied). Throws on non-ok so callers can
 *  retry with their own throttle. */
export async function postIdentityRegister(proxyBase: string, conversationId: string, agent: string, parentConversationId?: string): Promise<void> {
    const res = await fetch(`${proxyBase}/__bili/plugin/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, agent, identity: true, ...(parentConversationId ? { parentConversationId } : {}) }),
        signal: AbortSignal.timeout(COMPACT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`register HTTP ${res.status}`);
}

export type RuntimeInfoReport = {
    agent: string;
    model: string;
    contextWindow?: number;
    maxOutput?: number;
    baseURL?: string;
    source?: string;
};

/** Runtime-info protocol (#955): push the client's OWN model config (what
 *  the plugin read from the host's config) to the proxy at bootstrap and on
 *  model switch, before any model request. Fire-and-forget by design — the
 *  proxy treats a missing report as "guess like before" (registry/table). */
export async function reportRuntimeInfo(proxyBase: string, info: RuntimeInfoReport): Promise<void> {
    const { ok, status } = await fetchJson(`${proxyBase}/__bili/plugin/runtime-info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(info),
    }, STATUS_TIMEOUT_MS);
    if (!ok) throw new Error(`runtime-info report failed (${status})`);
}

// Per-agent last report (model id): a stamp fires at most one POST per model
// switch, not per request. Failed reports roll back so the next stamp retries.
const lastRuntimeReport = new Map<string, string>();

/** Stamp-time runtime-info report (#955): no-op unless the agent's reported
 *  model changed (or this is the first stamp after proxy attach/spawn).
 *  Soft-fail — an unreachable proxy keeps wire mode exactly as before. */
export function reportRuntimeInfoOnChange(proxyBase: string | undefined, info: RuntimeInfoReport): void {
    if (proxyBase === undefined || proxyBase.length === 0) return;
    if (lastRuntimeReport.get(info.agent) === info.model) return;
    lastRuntimeReport.set(info.agent, info.model);
    void reportRuntimeInfo(proxyBase, info).catch(() => {
        lastRuntimeReport.delete(info.agent);
    });
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

/** #1365: poll the attach liveness probe until it answers or the deadline
 *  passes. Returns the origin when it is (or comes back) healthy, undefined
 *  on timeout — callers must fail LOUDLY then, never spawn a replacement the
 *  pinned model channel cannot follow. BILI_ATTACH_HEALTH_DEADLINE_MS keeps
 *  slow lifeline restarts from tripping a hard-coded bound; unset = default. */
export async function waitForProxyVersion(proxyBase: string): Promise<string | undefined> {
    const limit = envMillis(process.env, "BILI_ATTACH_HEALTH_DEADLINE_MS", ATTACH_HEALTH_DEADLINE_MS);
    const startedAt = Date.now();
    for (;;) {
        const version = await fetchProxyVersion(proxyBase).catch(() => undefined);
        if (version !== undefined) return proxyBase;
        const elapsed = Date.now() - startedAt;
        if (elapsed >= limit) return undefined;
        await new Promise((r) => setTimeout(r, Math.min(ATTACH_HEALTH_POLL_MS, limit - elapsed)));
    }
}

// Model-facing body for /acp status renders: the visible panel goes to the synthetic message's
// description (TUI Notice cap ~1KB); this inert one-liner keeps the model context clean.
export const V2_SYNTHETIC_TEXT = "[bili-acp-status] ACP status panel was displayed in your terminal; this line is not an instruction.";

/** Armed-but-idle /acp notice (proxy live, no model request sent yet). One
 *  source of truth for pi / dsh / opencode (#883). */
export function armedIdleNotice(version: string): string {
    return `billion-context@${version} — proxy connected, compression armed. No model request yet; send one, then run /acp again.`;
}

/** Fallback when the version probe also fails — a warning, not an info notice. */
export function noSessionWarning(): string {
    return "bili: no ACP session yet (send a model request first, then run /acp)";
}
