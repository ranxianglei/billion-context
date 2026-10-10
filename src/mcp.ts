// MCP stdio thin shell for launcher mode (#162): a single "bili" MCP server
// the hosts load via --mcp-config / -c mcp_servers.bili. It fetches the
// proxy's plugin manifest (single source of truth — zero schema drift),
// exposes the manifest's ACP tools over stdio JSON-RPC, and forwards executes to
// POST /__bili/plugin/tool. Claude Code passes its session id via the MCP
// initialize request's _meta.ui.sessionId (documented SessionStart context);
// we also accept BILI_CONVERSATION_ID env (codex spawn-time registration).
// #760: a fourth channel for hosts that share ONE shim across several
// concurrent conversations (no env/meta session at all): every tool accepts an
// optional conversation_id argument the model copies from the proxy's notes,
// which overrides the default binding for that one call only. No registration
// is issued for per-call ids — the proxy resolves them directly and flips the
// target session to plugin mode on successful execution.
// #2024: a fifth channel for hosts that stamp per-call MACHINE metadata —
// Codex ≥0.160 puts the real thread id on every tools/call at _meta.threadId
// (codex-rs core/src/mcp_tool_call.rs with_mcp_tool_call_ids_meta; its
// sessionId is a transient run id and is deliberately NOT consumed). A valid
// non-empty native id overrides BOTH the model-transcribed conversation_id
// and any stale env/default binding for that one call only, is flagged to the
// proxy as host-stamped (body field nativeCaller), and is NEVER written back
// to this shim's global conversationId — main/sub-agent threads sharing one
// MCP process must not clobber each other's binding. Absent or malformed
// metadata leaves the legacy channels untouched.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive, isProxyInstanceFile, readProxyInstanceFile } from "./instance.js";
import { resolveToolTimeoutMs } from "./agent/native-bootstrap.js";

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

const TOOL_TIMEOUT_MS = resolveToolTimeoutMs(process.env); // shared knob with the pi shim — see agent/native-bootstrap.ts
const CONVERSATION_FROM_ENV = process.env.CLAUDE_CODE_SESSION_ID?.trim() || process.env.BILI_CONVERSATION_ID?.trim() || undefined;
const IDENTITY_BINDING = Boolean(process.env.CLAUDE_CODE_SESSION_ID?.trim());
// #656: hosts that resume a session (claude --resume forks a NEW session id)
// do so after MCP children were spawned — the env-captured id goes stale and
// every tool call 404s forever. When that exact failure is seen, adopt the
// proxy's most-recent active conversation (status?fallback=latest) and retry
// once. Only armed for identity-bound hosts (claude code); opt out with
// BILI_MCP_NO_ORPHAN_ADOPT=1 when several host sessions share one proxy and
// the resumed one must not adopt a sibling's conversation.
const ORPHAN_ADOPT = IDENTITY_BINDING && process.env.BILI_MCP_NO_ORPHAN_ADOPT !== "1";
let manifestTools: McpToolDef[] = [];
let conversationId = CONVERSATION_FROM_ENV;
// #760: every conversation this shim has ever registered — the default
// binding plus any per-call ids seen so far (issue-once each).
const registeredConversations = new Set<string>();
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

export async function forwardTool(tool: string, args: unknown, timeoutMs: number = TOOL_TIMEOUT_MS, conversationIdOverride: string | undefined = undefined, nativeCaller: boolean = false): Promise<{ text: string; failed: boolean }> {
    const effectiveConversationId = conversationIdOverride ?? conversationId;
    for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
            const body: Record<string, unknown> = { conversationId: effectiveConversationId, tool, args };
            // #2024: flag host-stamped per-call identity (Codex _meta.threadId) so
            // the proxy ranks it above a content-based witness. Static env/meta
            // bindings and model-transcribed ids are NOT flagged — their
            // precedence stays exactly as #1685 wrote it.
            if (nativeCaller && effectiveConversationId) body.nativeCaller = true;
            res = await fetch(`${resolveProxyOrigin()}/__bili/plugin/tool`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            if (err instanceof Error && err.name === "TimeoutError") throw new Error(`tool forward timed out after ${timeoutMs}ms: ${tool}`);
            throw err;
        }
        const data = (await res.json()) as { ok?: boolean; result?: string; error?: string; outcome?: string };
        // #1875: ok:true means the tool RAN; the business effect rides outcome.
        // failure/refusal receipts become MCP isError so hosts surface them to
        // the model — partial still counts as success.
        if (res.ok && data.ok) return { text: data.result ?? "", failed: data.outcome === "failure" || data.outcome === "refused" };
        // #656: the shim's captured id was never registered — the host likely
        // resumed its session and forked a new id after this shim spawned.
        // Adopt the proxy's latest active conversation and retry once. Armed
        // for DEFAULT-bound calls only: a per-call (#760) id naming an unknown
        // session must fail loudly, never adopt a sibling conversation.
        if (
            res.status === 404 && attempt === 0 && ORPHAN_ADOPT && conversationIdOverride === undefined && conversationId &&
            typeof data.error === "string" && data.error.includes("no model request has arrived")
        ) {
            if (await adoptLatestActiveConversation()) continue;
        }
        throw new Error(data.error ?? `tool forward failed: ${res.status}`);
    }
}

/** One-shot recovery for a stale shim id (#656): resolve the proxy's
 *  most-recent ACTIVE conversation via the status endpoint's fallback=latest
 *  and adopt it for all subsequent tool calls. Returns true when an adoption
 *  happened (caller should retry the tool call). */
async function adoptLatestActiveConversation(): Promise<boolean> {
    try {
        const res = await fetch(
            `${resolveProxyOrigin()}/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId ?? "")}&fallback=latest`,
            { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) return false;
        const data = (await res.json()) as { ok?: boolean; conversationId?: string; fallback?: boolean };
        if (data.ok !== true || data.fallback !== true || !data.conversationId || data.conversationId === conversationId) return false;
        process.stderr.write(
            `[bili-mcp] conversation id no longer known by the proxy (host resumed its session?); adopting latest active conversation ${data.conversationId}\n`,
        );
        conversationId = data.conversationId;
        return true;
    } catch {
        return false;
    }
}

const ERR_TOOL = -32602;

async function handleMessage(msg: {
    id?: JsonRpcId;
    method?: string;
    params?: {
        _meta?: { ui?: { sessionId?: string }; threadId?: unknown };
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
            if (conversationId && !registeredConversations.has(conversationId)) {
                const registerFetch = fetch(`${resolveProxyOrigin()}/__bili/plugin/register`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ conversationId, agent: "mcp", identity: IDENTITY_BINDING }),
                    signal: AbortSignal.timeout(5000),
                });
                registeredConversations.add(conversationId); // issue-once: a repeated initialize must not re-register
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
            if (degradedReason !== undefined) {
                // #1892: idle shim — advertise nothing rather than blocking on
                // (or erroring against) an origin that is not there.
                sendResult(id, { tools: [] });
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
            const rawArgs: Record<string, unknown> = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
            if (!tool) {
                sendError(id, ERR_TOOL, "params.name is required");
                return;
            }
            if (degradedReason !== undefined) {
                sendResult(id, { content: [{ type: "text", text: `bili is idle: ${degradedReason}` }], isError: true });
                return;
            }
            // #760: per-call conversation_id — the model copies the id the
            // proxy printed in its notes ("your bili conversation id: …").
            // Overrides the default binding (env/meta); stripped before
            // forwarding since the proxy routes on the body-level field.
            // #841 exception: search_context's conversation_id doubles as a
            // cross-session READ-ONLY search target. When a default binding
            // exists, keep the param in args (the proxy resolves the target
            // session itself, incl. non-resident ones from disk) and never
            // re-route the call away from the caller's binding — routing to
            // another session would mutate that session's mode/lastSeen. With
            // no default binding, perCall stays the routing fallback and is
            // stripped, exactly as before.
            const perCallRaw = rawArgs.conversation_id;
            const perCall = typeof perCallRaw === "string" ? perCallRaw.trim() : "";
            // #2024: Codex stamps the real thread id on every tools/call via
            // _meta.threadId (see file header). Validated strictly — anything
            // that is not a non-empty string after trim is treated as ABSENT
            // so malformed metadata can never shadow the legacy channels.
            // Per-call only: this value never touches the global
            // `conversationId` below. _meta.sessionId (transient run id) is
            // deliberately not consumed.
            const metaThreadId = params._meta?.threadId;
            const nativeThreadId = typeof metaThreadId === "string" && metaThreadId.trim().length > 0 ? metaThreadId.trim() : undefined;
            // A native caller counts as "bound" for the search-target
            // exception (#841 extended by #2024): the call routes to the
            // native thread while args.conversation_id stays the read-only
            // target — even when no env/default binding exists (previously
            // the target would have been mistaken for the caller).
            const keepForSearch = tool === "search_context" && perCall.length > 0 && (nativeThreadId !== undefined || (typeof conversationId === "string" && conversationId.length > 0));
            const args = { ...rawArgs };
            if (!keepForSearch) delete args.conversation_id;
            const routeOverride = nativeThreadId ?? (keepForSearch ? undefined : perCall || undefined);
            // #1685: with no binding and no per-call id, forward anyway — the
            // proxy routes the id-less POST itself (outbound tool_use witness,
            // else single-active arbitration) and answers a loud 400 when it
            // genuinely cannot tell. The shim no longer hard-fails here.
            try {
                const out = await forwardTool(tool, args, TOOL_TIMEOUT_MS, routeOverride, nativeThreadId !== undefined);
                sendResult(id, { content: [{ type: "text", text: out.text }], isError: out.failed });
            } catch (err) {
                // Protocol failures are results (isError), not JSON-RPC
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

/** Set when this shim serves WITHOUT a live proxy behind it (#1892,
 *  zcode mcp-entry): tools/list answers an empty list instead of timing out
 *  against a dead origin, and tools/call returns a loud isError explaining
 *  why. The process stays a valid MCP server so the host handshake completes
 *  instead of seeing the child die pre-initialize. */
let degradedReason: string | undefined;

/** CLI entry (`bili mcp`): the stdio loop keeps the process alive. */
export function runMcpStdio(opts: { degraded?: string } = {}): void {
    degradedReason = opts.degraded;
    void mcpMain();
}

// Direct entry (dist/mcp.js spawned by the injected MCP config, or the ts
// source under tsx in tests): run only when invoked as the script itself,
// never when imported by the CLI.
if (process.argv[1] && /(?:^|[\\/])mcp\.(?:ts|js)$/.test(process.argv[1])) {
    void mcpMain();
}
