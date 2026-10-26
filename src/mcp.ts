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
// #4661: hosts that pin a STATIC id (ZCode's BILI_CONVERSATION_ID config pin)
// go stale the moment the host starts a new session or restarts — every tool
// then answers from the frozen old session. The proxy detects the shape with
// runtime traffic evidence (bound session quiet >15 min while another session
// receives model requests), says so in the tool result, and names the live
// candidate in an additive `staleBinding` body field; this shim adopts that
// candidate for subsequent calls (and retries once when the answered call ran
// against the old session). Opt out with BILI_MCP_NO_STALE_ADOPT=1.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive, isProxyInstanceFile, readProxyInstanceFile } from "./instance.js";
import { parseBlocksCreated, parseToolOutcome, partialOutcomeNote } from "./proxy-tool-result.js";
import type { ToolOutcomeKind } from "./proxy-tool-result.js";

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
// #2652: slack added on top of a proxy-advertised summary budget when sizing the
// compress-call HTTP wait — covers the non-budgeted work around the batch outside the
// totalTimeoutMs clock (same rationale as src/agent/shared.ts).
const TOOL_TIMEOUT_OVERHEAD_MARGIN_MS = 30_000;
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
// #4661: adopt the proxy-named live conversation when it proves our binding
// is stale (evidence-based, unlike ORPHAN_ADOPT's recency guess) — armed for
// every global binding kind; opt out with BILI_MCP_NO_STALE_ADOPT=1.
const STALE_ADOPT = process.env.BILI_MCP_NO_STALE_ADOPT !== "1";
// #4661: a static config pin (ZCode's BILI_CONVERSATION_ID) is the one binding
// kind ORPHAN_ADOPT never arms for — extend #4168's 409 self-rebind to it.
const STATIC_PIN = !IDENTITY_BINDING && Boolean(process.env.BILI_CONVERSATION_ID?.trim());
let manifestTools: McpToolDef[] = [];
let manifestMaxToolDurationMs: number | undefined;
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
    const data = (await res.json()) as {
        tools?: Record<string, { name: string; description?: string; input_schema?: unknown }[]>;
        capabilities?: { externalSummary?: { maxToolDurationMs?: unknown } };
    };
    // #2652: learn the summary budget ceiling so compress calls wait for it.
    const advertised = data.capabilities?.externalSummary?.maxToolDurationMs;
    if (typeof advertised === "number" && Number.isFinite(advertised) && advertised > 0) manifestMaxToolDurationMs = advertised;
    // Anthropic wire shape is the canonical MCP-compatible schema source.
    const anthropic = data.tools?.anthropic ?? [];
    manifestTools = anthropic.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
    if (manifestTools.length === 0) throw new Error("manifest served no anthropic tools");
}

/** #2652: only compress invokes the external summary executor (bounded by
 *  totalTimeoutMs), so only it grows past the base floor — and only when the proxy
 *  advertised a budget. Everything else keeps the historical floor. */
function effectiveToolTimeoutMs(tool: string): number {
    if (tool !== "compress") return TOOL_TIMEOUT_MS;
    if (manifestMaxToolDurationMs === undefined) return TOOL_TIMEOUT_MS;
    return Math.max(TOOL_TIMEOUT_MS, manifestMaxToolDurationMs + TOOL_TIMEOUT_OVERHEAD_MARGIN_MS);
}

let manifestPromise: Promise<void> | null = null;
function ensureManifest(): Promise<void> {
    manifestPromise ??= fetchManifest().catch((err) => {
        manifestPromise = null;
        throw err;
    });
    return manifestPromise;
}

// #2752: same contract as agent/shared.ts's ForwardedToolResult — the endpoint's
// machine-readable outcome/blocksCreated ride through (defensively parsed) so
// the shim can expose them as MCP structuredContent; `text` carries the appended
// partial note for clients that only render content text.
export type McpForwardedToolResult = { text: string; failed: boolean; outcome?: ToolOutcomeKind; blocksCreated?: number };

export async function forwardTool(tool: string, args: unknown, timeoutMs: number = TOOL_TIMEOUT_MS, conversationIdOverride: string | undefined = undefined, nativeCaller: boolean = false): Promise<McpForwardedToolResult> {
    for (let attempt = 0; ; attempt++) {
        // Recomputed per attempt: an in-loop adoption (#656/#4168/#4661) rewrites the
        // global binding, and the retry must carry the NEW id — capturing it
        // once above the loop would silently re-POST the stale one.
        const effectiveConversationId = conversationIdOverride ?? conversationId;
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
        const data = (await res.json()) as { ok?: boolean; result?: string; error?: string; outcome?: unknown; blocksCreated?: unknown; code?: unknown; witnessSessions?: unknown; namedSessionLastSeen?: unknown; witnessLastSeen?: unknown; staleBinding?: { boundConversationId?: string; candidateSessionId?: string; candidateConversationId?: string; quietMs?: number } };
        // #1875: ok:true means the tool RAN; the business effect rides outcome.
        // failure/refusal receipts become MCP isError so hosts surface them to
        // the model — partial still counts as success.
        if (res.ok && data.ok) {
            // #4661: the proxy proved our binding is stale with runtime traffic
            // evidence and named the live candidate (additive body field). The
            // answered call ran against the OLD session, so adopt the candidate
            // for subsequent calls AND retry once to hand the caller the live
            // session's answer instead of the frozen ledger's zeros. Per-call
            // (#760/#2024) routes never write back to the global binding.
            const sb = data.staleBinding;
            const candidate = (typeof sb?.candidateConversationId === "string" && sb.candidateConversationId.length > 0 ? sb.candidateConversationId : undefined)
                ?? (typeof sb?.candidateSessionId === "string" && sb.candidateSessionId.length > 0 ? sb.candidateSessionId : undefined);
            if (candidate && candidate !== effectiveConversationId && STALE_ADOPT && conversationIdOverride === undefined && !nativeCaller) {
                conversationId = candidate;
                process.stderr.write(`[bili-mcp] proxy reported stale binding "${sb?.boundConversationId ?? effectiveConversationId}" (no model traffic ${typeof sb?.quietMs === "number" ? Math.round(sb.quietMs / 60000) + " min" : "?"}); adopting live conversation ${candidate} (#4661)\n`);
                if (attempt === 0) continue;
            }
            const outcome = parseToolOutcome(data.outcome);
            const blocksCreated = parseBlocksCreated(data.blocksCreated);
            let text = data.result ?? "";
            // #2752: same partial-note contract as agent/shared.ts — only a
            // partial fold gains the appended line; every other envelope keeps
            // its exact historical bytes.
            if (outcome === "partial") text += `\n${partialOutcomeNote(blocksCreated)}`;
            const out: McpForwardedToolResult = { text, failed: outcome === "failure" || outcome === "refused" };
            if (outcome !== undefined) out.outcome = outcome;
            if (blocksCreated !== undefined) out.blocksCreated = blocksCreated;
            return out;
        }
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
        // #4168: the captured id still RESOLVES, but the host moved the
        // conversation to a new session id after this shim spawned (claude's
        // native-compaction continuation / resume) — every call now fails
        // closed on the outbound-witness conflict instead of ever 404ing, so
        // the #656 adoption above never fires and the session is stuck for
        // good. Extend the same one-shot adoption to this failure: adopt the
        // UNIQUE witnessing session only when the proxy's recency facts prove
        // traffic moved there AFTER the bound session's last activity.
        // Multiple witnesses, missing facts (older proxy), or a still-fresh
        // binding all stay on the loud 409 — fail closed, never guess.
        // #4661: armed for static config pins too — ZCode's BILI_CONVERSATION_ID
        // pin hits exactly this shape with ORPHAN_ADOPT off (no identity env).
        if (
            res.status === 409 && attempt === 0 && (ORPHAN_ADOPT || (STATIC_PIN && STALE_ADOPT)) && conversationIdOverride === undefined && conversationId &&
            data.code === "TOOL_CONVERSATION_CONFLICT"
        ) {
            const witnesses = Array.isArray(data.witnessSessions)
                ? data.witnessSessions.filter((x): x is string => typeof x === "string" && x.length > 0)
                : [];
            const namedSeen = typeof data.namedSessionLastSeen === "number" ? data.namedSessionLastSeen : NaN;
            const witnessSeen = typeof data.witnessLastSeen === "number" ? data.witnessLastSeen : NaN;
            if (witnesses.length === 1 && witnesses[0] !== conversationId && Number.isFinite(namedSeen) && Number.isFinite(witnessSeen) && witnessSeen > namedSeen) {
                process.stderr.write(
                    `[bili-mcp] captured conversation id ${conversationId} is stale — the host moved this conversation to ${witnesses[0]} (resume/native compaction?); re-binding\n`,
                );
                conversationId = witnesses[0];
                continue;
            }
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

// Test seam: forwardTool's adoption rewrites the module-level binding, so
// tests need a deterministic way to reset it between cases.
export function _resetMcpBindingForTest(nextConversationId?: string): void {
    conversationId = nextConversationId;
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
                const out = await forwardTool(tool, args, effectiveToolTimeoutMs(tool), routeOverride, nativeThreadId !== undefined);
                // #2752: the business state rides MCP structuredContent (spec
                // field alongside content; clients predating it ignore it).
                // isError semantics are unchanged — partial stays non-error.
                // #3472: some hosts (Claude Code via its MCP bridge) prefer
                // structuredContent when present and drop the content text —
                // with only {outcome, blocksCreated} every success call reached
                // the model as bare {"outcome":"success"} and the whole report
                // was lost. Carry the full report inside structuredContent too
                // (structured.text, byte-identical to content[0].text) so
                // structured-only readers see the complete receipt; the machine
                // fields stay additive alongside it.
                const result: Record<string, unknown> = { content: [{ type: "text", text: out.text }], isError: out.failed };
                if (out.outcome !== undefined || out.blocksCreated !== undefined) {
                    const structured: Record<string, unknown> = { text: out.text };
                    if (out.outcome !== undefined) structured.outcome = out.outcome;
                    if (out.blocksCreated !== undefined) structured.blocksCreated = out.blocksCreated;
                    result.structuredContent = structured;
                }
                sendResult(id, result);
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
    // #4661: a static pin (BILI_CONVERSATION_ID, no CLAUDE_CODE_SESSION_ID)
    // goes stale on every new host session / host restart — say so at startup
    // instead of letting every tool silently answer from the frozen old
    // ledger until someone notices.
    if (!IDENTITY_BINDING && conversationId && process.env.BILI_CONVERSATION_ID?.trim()) {
        process.stderr.write(`[bili-mcp] warning: session binding "${conversationId}" is STATIC (BILI_CONVERSATION_ID) — it goes stale when the host starts a new session or restarts (the id changes). Until rebinded, tools may answer from the frozen old session; the proxy flags suspected stale bindings in tool results and this shim rebinds automatically once it has evidence (#4661). Manual rebind: point BILI_CONVERSATION_ID at the live session id and restart the host.\n`);
    }
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
