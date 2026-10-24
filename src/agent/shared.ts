// Shared thin-plugin core for agent-side extensions ("内外呼应", issue #1).
// The agent plugin is a PURE PROTOCOL CLIENT: no acp-kernel import, no
// compression logic. The proxy stays the single compression authority; the
// plugin only (1) detects the proxy, (2) fetches the tool manifest (single
// source of truth), (3) forwards tool executes, (4) reads status. Same
// package as the proxy ⇒ same version ⇒ no kernel-skew bug class.

import { envMillis } from "./native-bootstrap.js";
import { parseBlocksCreated, parseToolOutcome, partialOutcomeNote } from "../proxy-tool-result.js";
import type { ToolOutcomeKind } from "../proxy-tool-result.js";

export type ManifestTool = {
    name: string;
    description?: string;
    inputSchema: unknown;
};

const MANIFEST_TIMEOUT_MS = 5000;
const TOOL_TIMEOUT_MS = 60000;
// #2652: slack added on top of a proxy-advertised summary budget when sizing the
// compress-call HTTP wait — covers the non-budgeted work around the batch (preflight
// split / token count / kernel apply / serialize) outside the totalTimeoutMs clock.
const TOOL_TIMEOUT_OVERHEAD_MARGIN_MS = 30_000;
const STATUS_TIMEOUT_MS = 5000;
const ATTACH_HEALTH_DEADLINE_MS = 15000;
const ATTACH_HEALTH_POLL_MS = 250;

// #2455: HTTP header values are ByteStrings — a char above U+00FF (e.g. a
// Chinese provider/model id like "浮生云算/gpt-6.1-sol") makes undici throw a
// TypeError when the host BUILDS the request, so the whole turn dies locally
// before it ever reaches the proxy. Guard every user/host-controllable string
// we stamp into an x-bili-plugin-* header through this one gate. Returns the
// value unchanged only when it is stamp-safe: printable ASCII (VCHAR, no
// whitespace/control) within the 1..256 span the proxy's own reader honors
// (/^\S{1,256}$/ in pluginReportedModel). Anything else yields undefined so the
// caller SKIPS the header — the proxy then falls back to the body model /
// registry table with no side effect (a missing header is explicitly trusted
// by pluginHeadersMatchModel). Deliberately stricter than raw latin1: a value
// with whitespace would pass a bare ByteString check yet be rejected by the
// proxy's \S gate anyway, so excluding it here changes nothing observable.
export function asciiHeaderValue(value: string): string | undefined {
    return /^[\x21-\x7e]{1,256}$/.test(value) ? value : undefined;
}

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
        if (!/^\/(?:responses\/)?https?:\/\//.test(rest)) return undefined;
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
function mitmHostsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
    const out = new Set<string>();
    for (const raw of env.BILI_MITM_HOSTS?.split(",") ?? []) {
        const host = raw.trim().toLowerCase();
        if (host.length > 0) out.add(host);
    }
    return out;
}

/** #1392: opted-in non-http(s) baseUrl providers (BILI_NON_HTTP_PROVIDERS, set by
 *  buildPiEnv or native-mode users). Provider ids are case-sensitive identifiers —
 *  unlike the hostnames in mitmHostsFromEnv above, these are NOT lowercased. */
export function nonHttpProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
    const out = new Set<string>();
    for (const raw of env.BILI_NON_HTTP_PROVIDERS?.split(",") ?? []) {
        const id = raw.trim();
        if (id.length > 0) out.add(id);
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

// #2652: per-proxy advertised ceiling for a summary-producing tool call, learned from
// the manifest at bootstrap. forwardTool sizes its compress-call HTTP wait from it so
// the client never times out a fold the proxy is still legitimately running.
const manifestToolDurations = new Map<string, number>();

function recordManifestToolDuration(proxyBase: string, json: unknown): void {
    const caps = (json as { capabilities?: { externalSummary?: { maxToolDurationMs?: unknown } } })?.capabilities?.externalSummary;
    const value = caps?.maxToolDurationMs;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) manifestToolDurations.set(proxyBase, value);
}

/** Effective HTTP wait (ms) for a forwarded tool call. Only compress invokes the
 *  external summary executor (bounded by totalTimeoutMs), so only it grows past the
 *  base floor — and only when the proxy advertised a budget. Everything else, and any
 *  proxy that advertises nothing (chain off / older build), keeps the historical floor. */
export function effectiveToolTimeoutMs(proxyBase: string, tool: string): number {
    if (tool !== "compress") return TOOL_TIMEOUT_MS;
    const advertised = manifestToolDurations.get(proxyBase);
    if (advertised === undefined) return TOOL_TIMEOUT_MS;
    return Math.max(TOOL_TIMEOUT_MS, advertised + TOOL_TIMEOUT_OVERHEAD_MARGIN_MS);
}

export async function fetchManifest(proxyBase: string, format: "anthropic" | "openai" = "anthropic"): Promise<ManifestTool[]> {
    const { ok, status, json } = await fetchJson(`${proxyBase}/__bili/plugin/manifest`, undefined, MANIFEST_TIMEOUT_MS);
    if (!ok || !json || typeof json !== "object") throw new Error(`manifest fetch failed: ${status}`);
    recordManifestToolDuration(proxyBase, json);
    if (format === "openai") {
        // The proxy serves OpenAI entries NESTED — {type:"function",
        // function:{name,description,parameters}} — mirroring the wire injector
        // (#2656). A flat {name,description,parameters} entry is accepted too so
        // either manifest layout parses; read whichever location carries each field.
        const data = json as { tools?: { openai?: Array<{ name?: string; description?: string; parameters?: unknown; function?: { name?: string; description?: string; parameters?: unknown } }> } };
        const tools: ManifestTool[] = [];
        for (const t of data.tools?.openai ?? []) {
            const name = t.name ?? t.function?.name;
            if (typeof name !== "string" || name.length === 0) continue;
            tools.push({ name, description: t.description ?? t.function?.description, inputSchema: t.parameters ?? t.function?.parameters ?? { type: "object", properties: {} } });
        }
        if (tools.length === 0) throw new Error("manifest served no openai tools");
        return tools;
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
    /** The conversation this report belongs to (#1531): lets the proxy keep
     *  one session's entry isolated from sibling sessions in the same process
     *  (main + subagents share the agent name but run different models). */
    conversationId?: string;
    source?: string;
};

// #2943: SessionStart hooks (zcode/kimi) are short-lived child processes the
// client waits on. The old tail `void main().finally(() => process.exit(0))`
// force-exited while an async handle was still open/mid-close — on Windows
// Node 24.14.x that races libuv's win async-handle close path and aborts with
// `assert(!(handle->flags & UV_HANDLE_CLOSING))` (src/win/async.c) BEFORE any
// stdout is written, silently killing the whole integration (newer Node ships
// the libuv endgame restructure that removed this race, which is why only
// 24.14.x hit it). Never call process.exit() on the normal path: tear down the
// one handle we always open (stdin) and let the loop drain to a NATURAL exit
// 0. An unref'd backstop force-exits ONLY if something unexpected keeps the
// loop alive — by then every handle has long since settled, so the forced exit
// cannot re-trigger the race. Injectable deps keep the real wiring testable
// without spawning a child. Fails open: always exits 0.
const HOOK_EXIT_BACKSTOP_MS = 5_000;

interface SessionStartHookDeps {
    readonly input?: { destroy?: () => void };
    readonly exit?: (code: number) => void;
    readonly backstopMs?: number;
}

export function runSessionStartHook(main: () => Promise<void>, deps: SessionStartHookDeps = {}): void {
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    const input = deps.input ?? process.stdin;
    void main().finally(() => {
        try {
            (input as { destroy?: () => void }).destroy?.();
        } catch {
            // already closed
        }
        process.exitCode = 0;
        const backstop = setTimeout(() => exit(0), deps.backstopMs ?? HOOK_EXIT_BACKSTOP_MS);
        backstop.unref?.();
    });
}

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

// Per-(agent, conversation) fingerprint of the last successfully reported
// config: at most one POST per distinct config, not per request. #1531: the
// old key was the bare model id, so a changed contextWindow/maxOutput/baseURL
// was never re-reported, and sibling sessions sharing an agent name masked
// each other. Keying by agent+conversation keeps interleaved sessions quiet
// while any field change (including a proxy-origin switch) re-reports.
const lastRuntimeReport = new Map<string, string>();

function runtimeReportFingerprint(proxyBase: string, info: RuntimeInfoReport): string {
    return [proxyBase, info.agent, info.conversationId ?? "", info.model, String(info.contextWindow ?? ""), String(info.maxOutput ?? ""), info.baseURL ?? ""].join("\u0000");
}

/** Stamp-time runtime-info report (#955): no-op unless the reported config
 *  changed since the last successful stamp (or this is the first stamp after
 *  proxy attach/spawn). Soft-fail — an unreachable proxy keeps wire mode
 *  exactly as before; a failed report rolls back so the next stamp retries. */
export async function reportRuntimeInfoOnChange(proxyBase: string | undefined, info: RuntimeInfoReport): Promise<void> {
    if (proxyBase === undefined || proxyBase.length === 0) return;
    const key = `${info.agent}\u0000${info.conversationId ?? ""}`;
    const fingerprint = runtimeReportFingerprint(proxyBase, info);
    if (lastRuntimeReport.get(key) === fingerprint) return;
    lastRuntimeReport.set(key, fingerprint);
    try {
        await reportRuntimeInfo(proxyBase, info);
    } catch {
        lastRuntimeReport.delete(key);
    }
}

type AttributionHealthReport = {
    agent: string;
    state: "ok" | "none" | "threw";
    /** Model requests refused direct in the current degraded episode (0 after recovery). */
    refusals: number;
    /** Epoch ms of the first refusal in the current episode (0 while healthy). */
    since: number;
    /** #3651: last thrown attribution error text — the report only fires for
     *  diagnosable failures (`threw`), so this is what makes the banner name
     *  the actual problem instead of a generic "takeover broken". */
    error?: string;
    /** #3651: masked endpoint (origin+pathname) of the last refused request. */
    endpoint?: string;
};

/** Takeover-attribution health report (#3581, contract reworked by #3651):
 *  when the host plugin's gate refuses model traffic because its attribution
 *  lookup THREW (disposed injection after a version swap — #3578), the proxy
 *  must learn about it or the silent-direct degradation stays invisible in
 *  /__bili/status and the panel. By-design agentless lanes (`none`) are normal
 *  interceptions and NEVER report (#3651 owner contract) — so any report on
 *  this route is either a diagnosable failure or a recovery notice. Sent on
 *  threw-episode events (first refusal, state change to threw, count doubling,
 *  give-up latch) plus recovery — fire-and-forget at call sites; a missed
 *  report delays visibility, never touches the request path. */
export async function reportAttributionHealth(proxyBase: string, health: AttributionHealthReport): Promise<void> {
    const { ok, status } = await fetchJson(`${proxyBase}/__bili/plugin/attribution`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(health),
    }, STATUS_TIMEOUT_MS);
    if (!ok) throw new Error(`attribution report failed (${status})`);
}

/** #2204: business outcome of a forwarded tool call. ok:true means the tool
 *  RAN; whether it achieved its effect rides the endpoint's machine-readable
 *  `outcome` field (#1875). `failed` mirrors mcp.ts's mapping so every host
 *  lane renders the same receipt the same way. #2752: the structured state now
 *  rides through (defensively parsed) — hosts with a metadata channel expose it
 *  (pi `details`, MCP `structuredContent`); string-only lanes read the appended
 *  partial note in `text`. Absent on legacy envelopes without the fields. */
export type ForwardedToolResult = { text: string; failed: boolean; outcome?: ToolOutcomeKind; blocksCreated?: number };

export async function forwardTool(proxyBase: string, conversationId: string, tool: string, args: unknown, signal?: AbortSignal, nativeCaller: boolean = false, toolCallId?: string): Promise<ForwardedToolResult> {
    const body: { conversationId: string; tool: string; args: unknown; nativeCaller?: boolean; toolCallId?: string } = { conversationId, tool, args: args ?? {} };
    if (toolCallId !== undefined) body.toolCallId = toolCallId;
    // #2072: host-native agents (pi / dsh / opencode) stamp a per-call id minted
    // by the host's own session manager — declare it so a stale sibling witness
    // can neither redirect nor fail-closed the call (ladder rung 0, #2024/#2016).
    // Truthiness guard (not .length): a host passing a non-string id degrades to
    // the legacy id-less wire instead of throwing (same shape as src/mcp.ts).
    if (nativeCaller && conversationId) body.nativeCaller = true;
    const { ok, status, json } = await fetchJson(`${proxyBase}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    }, effectiveToolTimeoutMs(proxyBase, tool), signal);
    const data = json as { ok?: boolean; result?: string; error?: string; outcome?: unknown; blocksCreated?: unknown } | undefined;
    if (!ok || !data?.ok) {
        throw new Error(`bili proxy tool ${tool} failed (${status}): ${data?.error ?? "unknown error"}`);
    }
    const outcome = parseToolOutcome(data.outcome);
    const blocksCreated = parseBlocksCreated(data.blocksCreated);
    let text = data.result ?? "";
    // #2752: a partial fold must stay distinguishable on lanes whose host shape
    // carries no structured state — the note rides the text. Applied/refused/
    // failure envelopes keep their exact historical bytes (no note).
    if (outcome === "partial") text += `\n${partialOutcomeNote(blocksCreated)}`;
    const out: ForwardedToolResult = { text, failed: outcome === "failure" || outcome === "refused" };
    if (outcome !== undefined) out.outcome = outcome;
    if (blocksCreated !== undefined) out.blocksCreated = blocksCreated;
    return out;
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
    const m = json as { version?: unknown; commit?: unknown };
    const version = m.version;
    if (typeof version !== "string" || version.length === 0) return undefined;
    // Append the build commit so status surfaces show WHICH build answers,
    // matching /__bili/status and `--version` (they all include it). Consumers
    // only display or liveness-check this string — none parses it.
    const commit = m.commit;
    if (typeof commit === "string" && commit.length > 0) return `${version} (${commit})`;
    return version;
}

/** #1603: one-line staleness warning for status UIs — the on-disk install is
 *  newer than the running process, so a host restart is needed to activate the
 *  new code. Soft-fail by design (same contract as fetchStatus): undefined when
 *  not stale OR the proxy can't be reached — a failed probe must never break /acp. */
export async function fetchStaleNotice(proxyBase: string): Promise<string | undefined> {
    const { ok, json } = await fetchJson(`${proxyBase}/__bili/status`, undefined, STATUS_TIMEOUT_MS);
    if (!ok || !json || typeof json !== "object") return undefined;
    const s = json as { stale?: unknown; version?: unknown; diskVersion?: unknown; autoRestartOnUpdate?: unknown; commit?: unknown };
    if (s.stale !== true) return undefined;
    const running = typeof s.version === "string" ? s.version : "?";
    const installed = typeof s.diskVersion === "string" ? s.diskVersion : "?";
    // Same-version builds can differ (dev vs released); the running side gets
    // its commit so users can tell which build is actually answering.
    const runningCommit = typeof s.commit === "string" && s.commit.length > 0 ? s.commit : undefined;
    const tail = s.autoRestartOnUpdate === true
        ? " — auto-restart is enabled but did not fire this cycle; check the bili log"
        : " — restart the host to activate (or enable --auto-restart-on-update)";
    return `⚠️ billion-context is stale: running v${running}${runningCommit ? ` (${runningCommit})` : ""} but v${installed} is installed${tail}.`;
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

// The OpenCode V2 TUI renders a synthetic message as a visible Notice row only while its display
// text fits the timeline cap (~1KB); longer rows render nothing (#880). bili cannot change the
// host cap, so overflow is handled at render time (#1602): the Web UI deep link is hoisted to
// line one so it always survives truncation (the full panel stays reachable through the Web UI),
// and leading WHOLE lines are kept within a budget that reserves room for the marker.

/** Fit report/panel text into a V2 synthetic notice description: verbatim under the hard cap;
 *  over it, hoist `webUrl` (the status endpoint's deep link; for cache reports the proxy already
 *  leads the result with it) to line one, keep leading whole lines (no mid-line cuts), and append
 *  a truncation marker sized so the total never exceeds `max`. */
export function fitNoticeDescription(text: string, max: number, kind: "panel" | "report", webUrl?: string): string {
    if (text.length <= max) return text;
    const lines = text.split("\n");
    if (webUrl !== undefined && webUrl.length > 0) {
        const body = lines.filter((l) => !/^Web UI: \S/.test(l));
        lines.length = 0;
        lines.push(`Web UI: ${webUrl}`, ...body);
    }
    if (lines.length === 1) {
        const marker = `\n\n[${kind} truncated]`;
        return lines[0].slice(0, Math.max(0, max - marker.length)) + marker;
    }
    // Budget against the widest-plausible marker (max dropped-count digits) so the real one
    // can only be shorter — the result is guaranteed ≤ max without a second pass.
    const probeMarker = `\n\n[${kind} truncated] ${lines.length} more lines`;
    const budget = max - probeMarker.length;
    const kept: string[] = [];
    let acc = 0;
    for (const line of lines) {
        const next = acc + (kept.length > 0 ? 1 : 0) + line.length;
        if (next > budget && kept.length > 0) break;
        kept.push(line);
        acc = next;
    }
    const dropped = lines.length - kept.length;
    const desc = kept.join("\n") + `\n\n[${kind} truncated] ${dropped} more line${dropped === 1 ? "" : "s"}`;
    return desc.length <= max ? desc : desc.slice(0, max);
}
