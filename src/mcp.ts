// MCP stdio thin shell for launcher mode (#162): a single "bili" MCP server
// the hosts load via --mcp-config / -c mcp_servers.bili. It fetches the
// proxy's plugin manifest (single source of truth — zero schema drift),
// exposes the 4 ACP tools over stdio JSON-RPC, and forwards executes to
// POST /__bili/plugin/tool. Claude Code passes its session id via the MCP
// initialize request's _meta.ui.sessionId (documented SessionStart context);
// we also accept BILI_CONVERSATION_ID env (codex spawn-time registration).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive, isProxyInstanceFile, readProxyInstanceFile } from "./instance.js";

const VERSION = (() => {
    try {
        const here = fileURLToPath(import.meta.url);
        const pkg = path.join(path.dirname(here), "..", "package.json");
        return (JSON.parse(fs.readFileSync(pkg, "utf8")).version as string) ?? "dev";
    } catch {
        return "dev";
    }
})();
type JsonRpcId = string | number | null;

type McpToolDef = {
    name: string;
    description?: string;
    inputSchema: unknown;
};
// Claude Code passes the session id as an env var to MCP children (verified
// against claude 2.1.227: CLAUDE_CODE_SESSION_ID) — and puts the SAME id on
// every model request (x-claude-code-session-id), so binding is by identity.
// BILI_CONVERSATION_ID (launcher-spawned hosts like codex) has no matching
// request id — binding is headless (next NEW session).
const DEFAULT_PROXY_ORIGIN = "http://127.0.0.1:8787";
let warnedStaleRecord = false;

export function resolveProxyOrigin(): string {
    const fromEnv = process.env.BILI_MCP_PROXY?.trim();
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    const discovered = readProxyInstanceFile();
    if (discovered && /^https?:\/\/\S+$/.test(discovered.origin)) {
        // #405: a JSON record naming a dead writer pid points at a port nothing
        // listens on — skip it for the default origin instead of dialing it
        // forever. The `pid > 0` guard is deliberate: pid 0 (foreign writer)
        // and legacy plain-URL pointers make no liveness claim and keep the
        // old trust semantics (unlike plugin-install, which refuses them).
        if (isProxyInstanceFile(discovered) && discovered.pid > 0 && !isPidAlive(discovered.pid)) {
            if (!warnedStaleRecord) {
                warnedStaleRecord = true;
                process.stderr.write(`[bili-mcp] recorded bili proxy (${discovered.origin}, pid ${discovered.pid}) is not running — falling back to ${DEFAULT_PROXY_ORIGIN}; set BILI_MCP_PROXY if your proxy listens elsewhere\n`);
            }
            return DEFAULT_PROXY_ORIGIN;
        }
        return discovered.origin;
    }
    return DEFAULT_PROXY_ORIGIN;
}

const TOOL_TIMEOUT_MS = 60_000;
const CONVERSATION_FROM_ENV = process.env.CLAUDE_CODE_SESSION_ID?.trim() || process.env.BILI_CONVERSATION_ID?.trim() || undefined;
const IDENTITY_BINDING = Boolean(process.env.CLAUDE_CODE_SESSION_ID?.trim());
let manifestTools: McpToolDef[] = [];
let conversationId = CONVERSATION_FROM_ENV;
let registered = false;
let initialized = false;
function send(msg: unknown): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id: JsonRpcId, result: unknown): void {
    if (id === null) return; // notification — no response expected
    send({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcId, code: number, message: string): void {
    if (id === null) return;
    send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function fetchManifest(): Promise<void> {
    const res = await fetch(`${resolveProxyOrigin()}/__bili/plugin/manifest`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
    const data = (await res.json()) as { tools?: Record<string, { name: string; description?: string; input_schema?: unknown }[]> };
    // Anthropic wire shape is the canonical MCP-compatible schema source.
    const anthropic = data.tools?.anthropic ?? [];
    manifestTools = anthropic.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
    if (manifestTools.length === 0) throw new Error("manifest served no anthropic tools");
}

let manifestPromise: Promise<void> | null = null;
function ensureManifest(): Promise<void> {
    manifestPromise ??= fetchManifest().catch((err) => {
        manifestPromise = null;
        throw err;
    });
    return manifestPromise;
}

export async function forwardTool(tool: string, args: unknown, timeoutMs: number = TOOL_TIMEOUT_MS): Promise<string> {
    let res: Response;
    try {
        res = await fetch(`${resolveProxyOrigin()}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId, tool, args }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") throw new Error(`tool forward timed out after ${timeoutMs}ms: ${tool}`);
        throw err;
    }
    const data = (await res.json()) as { ok?: boolean; result?: string; error?: string };
    if (!res.ok || !data.ok) throw new Error(data.error ?? `tool forward failed: ${res.status}`);
    return data.result ?? "";
}

const ERR_TOOL = -32602;

async function handleMessage(msg: {
    id?: JsonRpcId;
    method?: string;
    params?: {
        _meta?: { ui?: { sessionId?: string } };
        [k: string]: unknown;
    };
}): Promise<void> {
    const { id = null, method } = msg;
    const params = typeof msg.params === "object" && msg.params !== null ? msg.params : {};
    switch (method) {
        case "initialize": {
            // Session id arrives as an env var on the child process (claude)
            // or is injected at spawn time (launcher hosts). The MCP spec
            // guarantees the host waits for this response before calling
            // tools, and claude -p fires its first model request around the
            // same time — registering here is still the earliest we can be.
            // Identity-mode registrations bind on any later request, so the
            // race only matters for headless mode.
            const fromMeta = params._meta?.ui?.sessionId?.trim();
            if (fromMeta) conversationId ??= fromMeta;
            initialized = true;
            if (conversationId && !registered) {
                const registerFetch = fetch(`${resolveProxyOrigin()}/__bili/plugin/register`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ conversationId, agent: "mcp", identity: IDENTITY_BINDING }),
                    signal: AbortSignal.timeout(5000),
                });
                registered = true; // issue-once: a repeated initialize must not re-register
                if (IDENTITY_BINDING) {
                    // Identity-mode binding survives any arrival order —
                    // respond immediately so pipelined hosts are not stuck
                    // behind the register round-trip.
                    void registerFetch.catch(() => {});
                } else {
                    // Headless binding is order-sensitive: the register MUST
                    // land before the host's first model request, and hosts
                    // that pipeline tools/list would otherwise race past it.
                    await registerFetch.catch(() => {});
                }
            }
            sendResult(id, {
                protocolVersion: "2025-06-18",
                serverInfo: { name: "bili", version: VERSION },
                capabilities: { tools: {} },
            });
            return;
        }
        case "notifications/initialized":
            return;
        case "tools/list": {
            if (!initialized) {
                sendError(id, -32002, "server not initialized");
                return;
            }
            try {
                await ensureManifest();
                sendResult(id, { tools: manifestTools });
            } catch (err) {
                sendError(id, -32003, `bili proxy unreachable at ${resolveProxyOrigin()} (${err instanceof Error ? err.message : String(err)}) — start bili or set BILI_MCP_PROXY`);
            }
            return;
        }
        case "tools/call": {
            const tool = typeof params.name === "string" ? params.name : "";
            const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
            if (!tool) {
                sendError(id, ERR_TOOL, "params.name is required");
                return;
            }
            if (!conversationId) {
                sendError(id, ERR_TOOL, "no conversation id (set BILI_CONVERSATION_ID or connect via Claude Code MCP session meta)");
                return;
            }
            try {
                const text = await forwardTool(tool, args);
                sendResult(id, { content: [{ type: "text", text }], isError: false });
            } catch (err) {
                // Tool-level failures are results (isError), not JSON-RPC
                // errors, so the host surfaces them to the model.
                sendResult(id, { content: [{ type: "text", text: `bili tool error: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
            }
            return;
        }
        case "ping":
            sendResult(id, {});
            return;
        default:
            if (method?.startsWith("notifications/")) return;
            sendError(id, -32601, `method not found: ${method ?? "(none)"}`);
    }
}
async function mcpMain(): Promise<void> {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                continue;
            }
            if (parsed && typeof parsed === "object") {
                void handleMessage(parsed as Parameters<typeof handleMessage>[0]);
            }
        }
    });
    process.stdin.on("end", () => process.exit(0));
}

/** CLI entry (`bili mcp`): the stdio loop keeps the process alive. */
export function runMcpStdio(): void {
    void mcpMain();
}

// Direct entry (dist/mcp.js spawned by the injected MCP config, or the ts
// source under tsx in tests): run only when invoked as the script itself,
// never when imported by the CLI.
if (process.argv[1] && /(?:^|[\\/])mcp\.(?:ts|js)$/.test(process.argv[1])) {
    void mcpMain();
}
