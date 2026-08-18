// Shared thin-plugin core for agent-side extensions ("内外呼应", issue #1).
// The agent plugin is a PURE PROTOCOL CLIENT: no acp-kernel import, no
// compression logic. The proxy stays the single compression authority; the
// plugin only (1) detects the proxy, (2) fetches the tool manifest (single
// source of truth), (3) forwards tool executes, (4) reads status. Same
// package as the proxy ⇒ same version ⇒ no kernel-skew bug class.

export type ManifestTool = {
    name: string;
    description?: string;
    inputSchema: unknown;
};

const MANIFEST_TIMEOUT_MS = 5000;
const TOOL_TIMEOUT_MS = 60000;
const STATUS_TIMEOUT_MS = 5000;

export const PLUGIN_AGENT_NAMES = ["pi", "omp", "opencode"] as const;

/** Detect the proxy from a provider baseUrl's `/bili/` zero-config prefix.
 *  Returns the proxy origin (scheme//host) the request will actually hit. */
export function proxyBaseFromUrl(baseUrl: string | undefined): string | undefined {
    if (!baseUrl) return undefined;
    try {
        const url = new URL(baseUrl);
        const segments = url.pathname.split("/").filter((s) => s.length > 0);
        if (!segments.includes("bili")) return undefined;
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

async function fetchJson(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<{ ok: boolean; status: number; json: unknown }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...init, signal: ac.signal });
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
    }
}

export async function fetchManifest(proxyBase: string): Promise<ManifestTool[]> {
    const { ok, status, json } = await fetchJson(`${proxyBase}/__bili/plugin/manifest`, undefined, MANIFEST_TIMEOUT_MS);
    if (!ok || !json || typeof json !== "object") throw new Error(`manifest fetch failed: ${status}`);
    const data = json as { tools?: { anthropic?: { name?: string; description?: string; input_schema?: unknown }[] } };
    const tools = (data.tools?.anthropic ?? []).filter((t): t is { name: string; description?: string; input_schema?: unknown } => typeof t.name === "string");
    if (tools.length === 0) throw new Error("manifest served no anthropic tools");
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema ?? { type: "object", properties: {} } }));
}

export async function forwardTool(proxyBase: string, conversationId: string, tool: string, args: unknown): Promise<string> {
    const { ok, status, json } = await fetchJson(`${proxyBase}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, tool, args }),
    }, TOOL_TIMEOUT_MS);
    const data = json as { ok?: boolean; result?: string; error?: string } | undefined;
    if (!ok || !data?.ok) {
        throw new Error(`bili proxy tool ${tool} failed (${status}): ${data?.error ?? "unknown error"}`);
    }
    return data.result ?? "";
}

export async function fetchStatus(proxyBase: string, conversationId: string): Promise<Record<string, unknown> | undefined> {
    const { ok, json } = await fetchJson(`${proxyBase}/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId)}`, undefined, STATUS_TIMEOUT_MS);
    if (!ok || !json || typeof json !== "object") return undefined;
    return json as Record<string, unknown>;
}
