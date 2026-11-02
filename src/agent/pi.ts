// Thin agent extension for pi and omp ("内外呼应", issue #1). Loaded by pi
// via the package.json `pi` manifest (dist/agent/pi.js) or by omp via the
// config.yml `extensions:` list (dist/agent/omp.js). pi and omp share the
// ExtensionFactory API shape, so one factory serves both; types below are
// minimal structural declarations — the bundled artifact imports NOTHING
// from the host at runtime (the host duck-types us in).

import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapCacheReport, wrapRuleReport } from "../acp-panel.js";
import { awaitNativeProxyOrigin } from "./native-bootstrap.js";
import { disposeSubagentSelfReg, selfRegisterForSession, type SubagentSelfRegState } from "./pi-subagent-registry.js";
import { isModelApiUrl, nativeInterceptInstalled } from "./native-intercept.js";
import { wirePiSubagents } from "./pi-subagents.js";
import { wireToolGuardrails } from "./tool-guardrails.js";
import { clearIncrementalProbe, noteHostMsgIdHint, INCREMENTAL_TURN_MARKER_HEADER, incrementalEnvelopeConversationId, incrementalWireHash, noteIncrementalRejection, noteIncrementalAck, planIncrementalTurn, probeIncrementalTurns, pullIncrementalReceipt, sweepStale, wireMessagesLookAnthropic, type HostMsgIdHintEntry, type IncrementalWireMessage } from "./incremental-client.js";
import { laneMsgIdsForWire, lanePinnableContent } from "./pi-msgids.js";
import { validateMsgIds } from "../msgid-pin.js";
import type { DirectSendPrep } from "./native-intercept.js";
import { asciiHeaderValue, detectProxyBase, destinationRoutedThroughProxy, fetchManifest, forwardTool, fetchStatus, fetchProxyVersion, postIdentityRegister, reportRuntimeInfoOnChange, armedIdleNotice, noSessionWarning, nonHttpProvidersFromEnv, type ForwardedToolResult, type ManifestTool } from "./shared.js";
import { createForkAdopter } from "./fork-adopt.js";
import { logHostEvent } from "./host-log.js";
import { plainHttpTrusted } from "../private-host.js";
import { allowPrivateHttpProviders, guardrailBashTimeout, guardrailMaxOutputBytes, guardrailRepetition } from "../knobs.js";
import { hostProfileFor } from "../host-profiles.js";

export type Ctx = {
    sessionManager?: { getSessionId?: () => string; getHeader?: () => unknown; getBranch?: () => unknown } | undefined;
    model?: { contextWindow?: number; baseUrl?: string; provider?: string; id?: string; api?: string; [key: string]: unknown } | undefined;
    // #2186: acp_delegate surface notifies stand-downs through the host toast
    // when present (same channel CommandCtx already declares).
    ui?: { notify?: (message: string, type?: string) => void } | undefined;
    // #1961: pi 0.99+ exposes the live model catalog on the extension ctx;
    // optional because older hosts lack it. The real ModelRegistry surface is
    // find(provider, modelId) — there is no getModel (verified against pi
    // v0.99.1 packages/coding-agent/src/core/model-registry.ts).
    modelRegistry?: {
        find?: (provider: string, modelId: string) => { baseUrl?: unknown } | undefined;
        // #2336 agent-registry fallback: the fuller surface (verified against
        // pi v0.99.1 model-registry.d.ts) — all optional, older hosts lack them.
        getAll?: () => Array<{ id: string; provider: string; api?: unknown; contextWindow?: unknown; maxTokens?: unknown }>;
        getProvider?: (provider: string) => { baseUrl?: unknown; auth?: { oauth?: unknown; apiKey?: unknown } | undefined } | undefined;
        getProviderAuthStatus?: (provider: string) => { configured?: unknown; source?: unknown } | undefined;
        getApiKeyForProvider?: (provider: string) => Promise<string | undefined> | undefined;
    } | undefined;
    cwd?: string;
};

type TextBlock = { type: "text"; text: string };
// #2752: `details` is pi's AgentToolResult metadata channel (persisted with the
// session, excluded from model input) — bili uses it to expose the endpoint's
// machine-readable outcome/blocksCreated to analysis tooling. Older pi hosts
// ignore unknown result fields.
type ToolResult = { content: TextBlock[]; isError?: boolean; details?: unknown };

type ToolDefinition = {
    name: string;
    description?: string;
    parameters: unknown;
    // omp 17.x mounts extension tools that omit loadMode under xd:// devices
    // (invisible to the main turn's tools array — only title requests see
    // them). Declaring "essential" keeps ACP tools top-level; pi upstream
    // ignores the field.
    loadMode?: string;
    execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: ((u: unknown) => void) | undefined, ctx: Ctx) => Promise<ToolResult>;
};

type CommandCtx = {
    sessionManager?: { getSessionId?: () => string } | undefined;
    model?: { contextWindow?: number; baseUrl?: string } | undefined;
    ui?: { notify?: (message: string, type?: string) => void } | undefined;
};

export type { ExtensionAPI, CommandCtx, ToolDefinition };

type ExtensionAPI = {
    on: (event: string, handler: (event: never, ctx: Ctx) => unknown) => void;
    registerTool: (tool: ToolDefinition) => void;
    registerCommand?: (name: string, options: { description?: string; handler: (args: string, ctx: CommandCtx) => void | Promise<void> }) => void;
    registerMessageRenderer?: (customType: string, renderer: MessageRenderer) => void;
    // #2186: acp_delegate (inlined from billion-context-pi-subagents) injects
    // completion notifications through the host's persistent transcript
    // channel; optional because older hosts and non-pi hosts lack it.
    sendUserMessage?: (message: string, options?: { deliverAs?: string }) => void;
    // #2186: delegate fleet-inspector shortcut — TUI nicety, never load-bearing.
    registerShortcut?: (key: string, options: { description?: string; handler: (ctx: CommandCtx) => void | Promise<void> }) => void;
    // #535: launcher passes provider URL rewrites via env; the extension
    // overrides each provider's baseUrl at load (file-free routing — no
    // models.json overlay). Optional because older hosts may lack it.
    registerProvider?: (name: string, config: { baseUrl: string }) => void;
    // #535 omp-only: omp pins the session's Model object from the static
    // catalog BEFORE extensions load, and its registerProvider — unlike
    // pi's _refreshCurrentModelFromRegistry — never re-resolves the live
    // session model, so the extension must re-pin it via setModel (see the
    // session_start handler below). Optional because pi hosts lack it.
    setModel?: (model: Record<string, unknown> & { baseUrl?: string }) => Promise<boolean | void> | boolean | void;
    // Persistent transcript output (rendered by TUI and web hosts like
    // pi-web); notify() is a transient toast — only the fallback for hosts
    // without sendMessage (issue #359).
    sendMessage?: (message: { customType: string; content: string; display: boolean }) => void;
    // #2322: current session name (pi /name); optional because older hosts
    // lack it (the session_info_changed event is the primary channel).
    getSessionName?: () => string | undefined;
    // #3542: the ACTIVE tool loadout — the set pi declares to the model and
    // its dispatcher checks, distinct from the registry (getAllTools). pi's
    // /tree rewind resets it from the transcript, so a registered tool can be
    // missing from it; optional because older hosts lack it.
    getActiveTools?: () => string[];
    setActiveTools?: (toolNames: string[]) => void;
};

function agentName(override: string | undefined): string {
    if (override) return override;
    return process.env.BILLION_CONTEXT_PLUGIN_AGENT === "omp" ? "omp" : "pi";
}

// pi 0.99+ virtual models (`pi.registerVirtualModel`, e.g. router/auto): the
// selection names a ROUTER, not a destination — its baseUrl is "" and it never
// reaches a provider, so detectProxyBase(ctx.model.baseUrl) has nothing to read
// (#1961). The conversation's real traffic went to the PHYSICAL models that
// answered; resolve the proxy from that evidence instead: the latest non-failed
// assistant response's registry entry (launcher httpRewrites and manually
// /bili/-wrapped models.json both land there), then the launcher's
// BILI_PROVIDER_REWRITES manifest entry for its provider, then the plain env
// fallback. Every candidate passes through detectProxyBase so the
// BILLION_CONTEXT_PLUGIN kill switch and URL validation apply uniformly, and
// any shape mismatch degrades to today's behavior. Downstream carriage gates
// (#1382/#1392) still decide ownership — this only fixes WHICH proxy is asked.
const VIRTUAL_MODEL_API = "pi-virtual";

function latestPhysicalResponse(branchEntries: unknown): { provider: string; modelId: string } | undefined {
    if (!Array.isArray(branchEntries)) return undefined;
    for (let i = branchEntries.length - 1; i >= 0; i--) {
        const entry = branchEntries[i] as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; provider?: unknown; model?: unknown } } | null | undefined;
        const msg = entry?.message;
        // Mirrors pi's own findLatestResponse: skip failed/aborted routing attempts.
        if (entry?.type !== "message" || msg?.role !== "assistant") continue;
        if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
        const provider = typeof msg.provider === "string" ? msg.provider : "";
        const modelId = typeof msg.model === "string" ? msg.model : "";
        if (provider.length > 0 && modelId.length > 0) return { provider, modelId };
    }
    return undefined;
}

/** pi KnownApi → summary protocol (#2336). Unmappable apis (bedrock, vertex,
 *  mistral, pi-messages) are skipped — the summary chain only speaks the four
 *  wire protocols bili knows how to dial. */
const AGENT_PROVIDER_API: Record<string, "anthropic" | "openai" | "responses" | "google"> = {
    "anthropic-messages": "anthropic",
    "openai-completions": "openai",
    "openai-responses": "responses",
    "azure-openai-responses": "responses",
    "openai-codex-responses": "responses",
    "google-generative-ai": "google",
};

/** #2336: report the host's own provider dialing recipes — baseUrl + api +
 *  the RESOLVED api key, in memory only — so summary chains can reference
 *  them ("glm/glm-5") without duplicating the dialing config in bili's
 *  file. Skips OAuth providers, auth.json credentials ("stored" — never
 *  collected by design), unmappable apis, baseUrls that point back at this
 *  proxy, and plain-HTTP non-loopback baseUrls (#2585 — the server would
 *  refuse them). Returns true when done (or permanently unavailable) so the
 *  caller can stop retrying; throws on transient failures. */
export async function reportAgentProviders(ctx: Ctx, agent: string): Promise<boolean> {
    const proxyBase = proxyBaseForCtx(ctx);
    if (proxyBase === undefined) return false;
    const registry = ctx.modelRegistry;
    if (registry?.getAll === undefined || registry.getProvider === undefined || registry.getProviderAuthStatus === undefined || registry.getApiKeyForProvider === undefined) return true;
    type ProviderAcc = { api: "anthropic" | "openai" | "responses" | "google"; models: Array<{ id: string; contextWindow?: number; outputTokens?: number }> };
    const byProvider = new Map<string, ProviderAcc>();
    for (const model of registry.getAll()) {
        const api = typeof model.api === "string" ? AGENT_PROVIDER_API[model.api] : undefined;
        if (api === undefined || typeof model.provider !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(model.provider) || model.provider.length === 0 || typeof model.id !== "string" || model.id.length === 0 || model.id.length > 200) continue;
        let entry = byProvider.get(model.provider);
        if (entry === undefined) {
            entry = { api, models: [] };
            byProvider.set(model.provider, entry);
        }
        // A provider speaking two wire apis dials them differently; the
        // recipe carries ONE api, so keep only the first one's models.
        if (entry.api !== api || entry.models.length >= 16) continue;
        entry.models.push({
            id: model.id,
            ...(typeof model.contextWindow === "number" && Number.isSafeInteger(model.contextWindow) && model.contextWindow >= 2048 && model.contextWindow <= 10_000_000 ? { contextWindow: model.contextWindow } : {}),
            ...(typeof model.maxTokens === "number" && Number.isSafeInteger(model.maxTokens) && model.maxTokens >= 128 ? { outputTokens: model.maxTokens } : {}),
        });
    }
    const providers: Record<string, { baseUrl: string; api: "anthropic" | "openai" | "responses" | "google"; apiKey: string; models: Record<string, { contextWindow?: number; outputTokens?: number }> }> = {};
    for (const [id, entry] of byProvider) {
        if (entry.models.length === 0) continue;
        const provider = registry.getProvider(id);
        const baseUrl = provider?.baseUrl;
        if (typeof baseUrl !== "string" || !(baseUrl.startsWith("https://") || baseUrl.startsWith("http://"))) continue;
        // Self-loop guard: skip providers whose endpoint IS this proxy — in
        // the /bili/<upstream> prefix form the baseUrl embeds the proxy
        // origin, and in MITM form detectProxyBase(baseUrl) resolves EVERY
        // url through the env base, so compare origins instead of just
        // testing detectProxyBase() !== undefined (which would skip the
        // whole table whenever BILLION_CONTEXT_PROXY is set).
        let selfLoop = true;
        try {
            const u = new URL(baseUrl);
            // #2585/#2984: untrusted plain-HTTP would be refused server-side
            // (key over plaintext) — pre-skip and say so. Same shared predicate
            // as the server gate (src/private-host.ts); the warn text stays
            // generic because it also covers public hosts. No url in the warn:
            // a baseUrl may carry inline credentials.
            if (u.protocol === "http:" && !plainHttpTrusted(u, allowPrivateHttpProviders())) {
                logHostEvent("warn", "[native-client]", `bili-plugin(${agent}): agent-providers: provider "${id}" not reported — plain-HTTP non-loopback baseUrl (bili refuses to register it, its apiKey would travel over plaintext) (#2585)`);
                continue;
            }
            selfLoop = u.origin === new URL(proxyBase).origin;
        } catch { selfLoop = true; }
        if (selfLoop) continue;
        const status = registry.getProviderAuthStatus(id);
        if (status?.configured !== true || status.source === "stored") continue;
        if (provider?.auth?.oauth !== undefined) continue;
        let apiKey: string | undefined;
        try {
            apiKey = await registry.getApiKeyForProvider(id);
        } catch {
            continue;
        }
        if (typeof apiKey !== "string" || apiKey.length === 0) continue;
        const models: Record<string, { contextWindow?: number; outputTokens?: number }> = {};
        for (const model of entry.models) {
            models[model.id] = {
                ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
                ...(model.outputTokens !== undefined ? { outputTokens: model.outputTokens } : {}),
            };
        }
        providers[id] = { baseUrl, api: entry.api, apiKey, models };
    }
    if (Object.keys(providers).length === 0) return true;
    const res = await fetch(`${proxyBase}/__bili/agent-providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, providers }),
        signal: AbortSignal.timeout(10_000),
    });
    let body: { error?: unknown; skipped?: unknown };
    try { body = JSON.parse(await res.text()); } catch { body = {}; }
    if (!res.ok) {
        // #2585: the response body names what was refused — surface it, don't
        // leave the user with a bare status code.
        const detail = typeof body.error === "string" && body.error.length > 0 ? body.error.slice(0, 300) : "";
        throw new Error(detail.length > 0 ? `agent-providers HTTP ${res.status}: ${detail}` : `agent-providers HTTP ${res.status}`);
    }
    for (const s of Array.isArray(body.skipped) ? body.skipped : []) {
        const item = s as { name?: unknown; reason?: unknown };
        if (typeof item.name === "string" && typeof item.reason === "string") {
            logHostEvent("warn", "[native-client]", `bili-plugin(${agent}): agent-providers: provider "${item.name}" not registered by bili: ${item.reason} — bili-side references to it stay unresolved (#2585)`);
        }
    }
    return true;
}

function virtualModelProxyBase(ctx: Ctx, branchEntries: unknown): string | undefined {
    try {
        const last = latestPhysicalResponse(Array.isArray(branchEntries) ? branchEntries : ctx.sessionManager?.getBranch?.());
        if (last) {
            const registryBase = ctx.modelRegistry?.find?.(last.provider, last.modelId)?.baseUrl;
            if (typeof registryBase === "string" && registryBase.length > 0) {
                const base = detectProxyBase(registryBase);
                if (base) return base;
            }
            const rewrite = parseProviderRewrites(process.env)?.[last.provider];
            if (rewrite) {
                const base = detectProxyBase(rewrite);
                if (base) return base;
            }
        }
        return detectProxyBase(undefined);
    } catch {
        return detectProxyBase(undefined);
    }
}

function proxyBaseForCtx(ctx: Ctx | undefined, branchEntries?: unknown): string | undefined {
    if (ctx !== undefined && ctx.model?.api === VIRTUAL_MODEL_API) return virtualModelProxyBase(ctx, branchEntries);
    return detectProxyBase(ctx?.model?.baseUrl);
}

function sessionIdOf(ctx: Ctx): string | undefined {
    try {
        const sid = ctx.sessionManager?.getSessionId?.();
        return typeof sid === "string" ? sid : undefined;
    } catch {
        return undefined;
    }
}

// #2322: report the host session name (pi /name) so the proxy's web UI labels
// the conversation with it instead of staying pinned to the truncated first
// user message. B-channel: a dedicated POST per change (set/rename/clear —
// empty string clears) rather than piggybacking a header on model requests,
// which could never express "cleared" and would only land on the next
// request. Deduped per sid; a failed POST re-arms so the next event retries.
const lastReportedNames = new Map<string, string>();

function reportSessionName(ctx: Ctx | undefined, name: string): void {
    const proxyBase = proxyBaseForCtx(ctx);
    if (proxyBase === undefined) return;
    const sid = ctx !== undefined ? sessionIdOf(ctx) : undefined;
    if (sid === undefined || sid.length === 0) return;
    const prev = lastReportedNames.get(sid);
    if (prev === name || (name === "" && prev === undefined)) return;
    lastReportedNames.set(sid, name);
    fetch(`${proxyBase}/__bili/plugin/session-name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: sid, name }),
        signal: AbortSignal.timeout(5000),
    }).then((res) => {
        if (!res.ok) lastReportedNames.delete(sid);
    }).catch(() => {
        lastReportedNames.delete(sid);
    });
}

/** [#1333/#1362] Session files declare derivation in their header: the header
 *  of a spawned/forked child carries parentSession. The value has TWO shapes
 *  across hosts — pi RLM inline spawns write the PATH of the parent session
 *  file, while omp fork() writes the PARENT'S BARE SESSION ID directly. The
 *  parent's conversation id is that file's own header id for paths (one bounded
 *  read — 64KB covers any header these hosts write; headers are the first JSONL
 *  line), and the bare value itself when it is an id. The path-vs-id split
 *  mirrors omp's own gc-cli discriminator: only an absolute path or a *.jsonl
 *  suffix is treated as a file reference; anything else is an id (fail-safe —
 *  an ambiguous alias resolves to nothing rather than guessing). Returns
 *  undefined for root sessions, unreadable parents, or hosts without getHeader
 *  — derivation reporting is strictly best-effort and never blocks registration. */
export function parentConversationIdOf(ctx: Ctx): string | undefined {
    try {
        const header = ctx.sessionManager?.getHeader?.() as { parentSession?: unknown } | null | undefined;
        const ref = typeof header?.parentSession === "string" ? header.parentSession.trim() : "";
        if (!ref) return undefined;
        // omp fork records the parent session id verbatim; pi records a path.
        const isFileRef = path.isAbsolute(ref) || ref.endsWith(".jsonl");
        if (!isFileRef) return ref;
        const fd = fs.openSync(ref, "r");
        try {
            const buf = Buffer.alloc(64 * 1024);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
                const text = line.trim();
                if (!text) continue;
                try {
                    const obj = JSON.parse(text) as { type?: unknown; id?: unknown };
                    if (obj?.type === "session" && typeof obj.id === "string" && obj.id) return obj.id;
                } catch {
                    // not JSON — keep scanning
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        // unreadable parent or missing getHeader — no derivation to report
    }
    return undefined;
}

// #2469: parentSession proves LINEAGE, not seeding. Pi's session header has
// no seed marker, but the evidence sits in the child's own branch: fork()
// copies the parent's entries verbatim, and pi persists the turn's user
// message BEFORE its first provider request (runAgentLoop emits the prompt
// messages' message_end — session-manager.appendMessage — ahead of the
// stream's onPayload hook), so a seeded child's branch already holds
// parent-length + 1 messages at first request, while a spawned subagent
// (newSession({parentSession}), inherit_context off) holds only its own task
// prompt. Counting the branch's conversation messages distinguishes the two
// at zero network cost; hosts without getBranch (or where it throws) yield
// undefined and keep today's always-attempt behavior (fail toward capability).
// The hash prefix match inside tryForkAdoption stays the final gate either
// way (#2394 opencode-lane contract), so a misclassified attempt only costs
// one snapshot GET.
export const FORK_SEED_MIN_REPLAYED_MESSAGES = 2;

export function replayedMessageCount(ctx: Ctx): number | undefined {
    try {
        const branch = ctx.sessionManager?.getBranch?.();
        if (!Array.isArray(branch)) return undefined;
        let count = 0;
        for (const entry of branch) {
            if (entry !== null && typeof entry === "object" && (entry as { type?: unknown }).type === "message") count += 1;
        }
        return count;
    } catch {
        return undefined;
    }
}

/** #4491 omp msgids wiring: (id, role) of the branch's message entries in
 *  session order — the hint the fetch-layer incremental planner
 *  (omp-native) aligns against the ACTUALLY-sent wire messages and carries
 *  as `msgIds` when they match 1:1. Non-message entries (model_change,
 *  native-compaction summaries) are skipped — they have no message id, so a
 *  summary that DID become a wire message leaves the counts short and the
 *  alignment refuses the whole field (all-or-nothing). An entry without a
 *  stable id yields an empty one, which the consumer's screen rejects the
 *  same way. Total: a missing/throwing getBranch yields [] — this request
 *  cannot vouch ids, and [] forces the degrade instead of leaving a stale
 *  earlier hint in place. */
export function ompBranchMsgIdEntries(ctx: Ctx): HostMsgIdHintEntry[] {
    const out: HostMsgIdHintEntry[] = [];
    try {
        const branch = ctx.sessionManager?.getBranch?.();
        if (!Array.isArray(branch)) return out;
        for (const entry of branch) {
            if (entry === null || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") continue;
            const id = (entry as { id?: unknown }).id;
            const role = (entry as { message?: { role?: unknown } | null }).message?.role;
            out.push({ id: typeof id === "string" ? id : "", role: typeof role === "string" ? role : "" });
        }
    } catch {
        return [];
    }
    return out;
}

// #2583: OMP's Cowork transport (can1357/oh-my-pi 642892ae, proxy handling
// e22a5ff2) picks egress PER MODEL: default anthropic/anthropic-messages
// requests go out over node:https DIRECTLY — stable header order, HTTP/1.1,
// streaming decompression — and never touch globalThis.fetch, so the
// fetch-layer routing claim of the native mode does not hold for them. Only
// an explicit proxy setting (PI_PROXY / PI_PROXY_<PROVIDER>) pushes them back
// onto Bun's own fetch (which the patch then sees), as do exotic request
// shapes (Request input, non-record headers, non-string body, non-https).
// The stamped prompt_cache_key's sole consumer is the proxy itself
// (#1403/#1579); on the direct path the field rides verbatim into Anthropic's
// strict schema and 400s every request ("prompt_cache_key: Extra inputs are
// not permitted"). This mirrors the host's own selection predicate exactly
// (defaultFetchForModel + getProxyForProvider) — an evidence-permitlist entry
// with source-level proof, not a URL heuristic. Missing provider/api fields
// cannot conclude bypass, so they keep today's optimistic stamp (older hosts
// still route through globalThis.fetch — fail-safe toward #1579).
export function ompCoworkTransportBypassesFetch(
    model: { provider?: string; api?: string } | undefined,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    if (model?.provider !== "anthropic" || model?.api !== "anthropic-messages") return false;
    // getProxyForProvider("anthropic"): PI_PROXY_ANTHROPIC (raw truthy) || PI_PROXY (trimmed).
    const hasProviderProxy = (env.PI_PROXY_ANTHROPIC ?? "").length > 0;
    const hasGlobalProxy = (env.PI_PROXY ?? "").trim().length > 0;
    if (hasProviderProxy || hasGlobalProxy) return false;
    // HTTPS_PROXY is deliberately NOT routing evidence here: the Cowork
    // transport's node:https stack ignores env proxies entirely (proven
    // live 2026-10-17, Anthropic req_011Cg7cujfgv4xLjuRvLMqvg — a loopback
    // HTTPS_PROXY was set and the stamped body still reached the upstream
    // direct, 400). Only PI_PROXY / PI_PROXY_ANTHROPIC push Cowork onto
    // Bun's fetch, where the patch can see and the proxy can consume it.
    return true;
}

// Once per process per model — the bypass is a property of the installed host
// build, not of individual requests, so repeating it per call would spam logs.
const coworkBypassNoted = new Set<string>();
function noteOmpCoworkBypass(modelId: string): void {
    const key = modelId || "<unknown>";
    if (coworkBypassNoted.has(key) || coworkBypassNoted.size >= 64) return;
    coworkBypassNoted.add(key);
    logHostEvent("warn", "[native-client]", `bili-plugin(omp): ${key} leaves this host through the host-native direct TLS transport (OMP Cowork transport, #2583) — those requests bypass bili's fetch interception and go DIRECT (uncompressed, invisible to the proxy). The prompt_cache_key identity stamp is withheld so the field can never leak into the upstream body.`);
}

// omp's chat-completions payloads carry NO conversation signal (no
// prompt_cache_key / session / user, and no session header — verified by dump),
// so the proxy's openai identity falls to a content fingerprint that never
// matches the session id this plugin registered (the identity register is keyed
// by the omp session uuid). The before_provider_request return value REPLACES
// the whole outgoing payload (omp onPayload chain, verified in the omp 17.3.8
// dist), so stamp prompt_cache_key with the omp session id: the proxy binds
// pluginMode by that identity and /acp finds the session by it.
// Chat shape = messages array, no responses `input`, no native prompt_cache_key.
// max_tokens is NOT a discriminator: omp's openai-compat providers send it in
// every chat-completions body (maxTokensField:"max_tokens") exactly like the
// anthropic wire — excluding it meant the target shape was never stamped
// (#268). The anthropic wire gets stamped too: the proxy records the mapping
// from the body pck there as well and strips the field before forwarding to
// the real Anthropic. pi is untouched (it stamps x-bili-plugin-conversation in
// before_provider_headers, which outranks the body field).
// #1403: stamp ONLY when the destination will actually be seen by the proxy —
// the pck's sole consumer is the proxy itself (identity bind + strip-before-
// forward). A destination the proxy blind-tunnels never sees the field, so the
// stamp rides verbatim into the upstream body, where strict-schema upstreams
// (opencode zen's anthropic endpoint: "prompt_cache_key: Extra inputs are not
// permitted") 400 the whole request. Unrouted destinations degrade to the
// proxy's anonymous prefix-affinity sessions (#309): compression still works,
// /acp lookup by session id does not — acceptable vs a guaranteed 400.
export function stampPromptCacheKey(event: unknown, ctx: Ctx, agent: string): Record<string, unknown> | undefined {
    // #3482 site 3: the identity-stamp CHANNEL is a registry property — omp
    // stamps the body pck, pi stamps x-bili-plugin-conversation in
    // before_provider_headers (which outranks the body field). No adapter-side
    // name gate.
    const profile = hostProfileFor(agent);
    if (!profile.stampsBodyPromptCacheKey) return undefined;
    // #2583 (hoisted): the Cowork withhold must gate EVERY stamp path, not
    // just the unrouted fallback below. On the launcher cert-MITM lane
    // (HTTPS_PROXY + BILI_MITM_HOSTS) destinationRoutedThroughProxy() is
    // true, which skipped this check entirely — yet Cowork traffic never
    // rides globalThis.fetch on that lane either, so the stamp could fire
    // on a transport the fetch intercept cannot consume and ride verbatim
    // into Anthropic's strict schema (#1403's 400 on every delegation).
    // #3482 site 2: whether that transport is even POSSIBLE is a registry
    // property; the env observation below is the per-request truth.
    if (profile.coworkTransportPossible && ompCoworkTransportBypassesFetch(ctx.model, process.env)) {
        noteOmpCoworkBypass(ctx.model?.id ?? (ctx.model?.baseUrl ?? ""));
        return undefined;
    }
    if (!destinationRoutedThroughProxy(ctx.model?.baseUrl)) {
        // #1579: native omp mode routes at the FETCH layer — the model
        // baseUrl stays the real upstream, so the launcher-shaped checks
        // (a /bili/-wrapped URL, the BILLION_CONTEXT_PROXY origin, the MITM
        // whitelist) can never match and #1403's gate silently killed the
        // identity stamp for EVERY native session. Mirror the interceptor's
        // own predicate instead: when the native intercept is installed it
        // WILL rewrite any isModelApiUrl request URL to <proxy>/bili/<url>.
        // The interceptor judges the FULL request URL while ctx carries only
        // the baseUrl prefix (".../v1" — not suffix-matched by itself), so
        // probe both the bare baseUrl and its natural chat-completions
        // expansion; the proxy consumes (and strips) the stamped pck exactly
        // as on the launcher lanes. Anything the interceptor would NOT
        // rewrite keeps #1403's guarantee — never stamp where the proxy
        // cannot see it. The install flag alone is not routing evidence — it
        // outlives routing (failed bootstrap, or proxy death + respawn
        // give-up: onGiveUp clears BILLION_CONTEXT_PROXY but not the flag),
        // and an un-routed stamped request rides verbatim into strict-schema
        // upstreams (#1403's 400). Live claim = same env-keyed signal
        // ownsCompaction / registerTools / runtime-info use; bootstrap
        // rewrites it on (re-)establishment so degrades/recovery track the
        // traffic. Round 1 inside the pre-bootstrap window misses the stamp
        // and self-heals on round 2.
        if (!nativeInterceptInstalled()) return undefined;
        if (detectProxyBase(ctx.model?.baseUrl) === undefined) return undefined;
        const base = ctx.model?.baseUrl ?? "";
        const expanded = /\/v\d+\/?$/.test(base) ? `${base.replace(/\/+$/, "")}/chat/completions` : base;
        if (!isModelApiUrl(base) && !isModelApiUrl(expanded)) return undefined;
    }
    const payload = (event as { payload?: unknown } | undefined)?.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const p = payload as Record<string, unknown>;
    if (!Array.isArray(p.messages)) return undefined;
    if (p.input !== undefined) return undefined;
    if (typeof p.prompt_cache_key === "string" && p.prompt_cache_key.trim().length > 0) return undefined;
    const sid = sessionIdOf(ctx);
    if (sid === undefined || sid.length === 0) return undefined;
    return { ...p, prompt_cache_key: sid };
}

function fmtTok(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}

function renderAcpStatus(s: Record<string, unknown>): string {
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const contextTokens = num(s.contextTokens);
    const contextLimit = num(s.contextLimit);
    const inputTokens = num(s.inputTokens);
    const outputTokens = num(s.outputTokens);
    const cachedTokens = num(s.cachedTokens);
    const requests = num(s.requests);
    const blocks = Array.isArray(s.blocks) ? (s.blocks as Array<{ tier?: number; active?: boolean }>) : [];
    const activeBlocks = blocks.filter((b) => b.active === true).length;
    const lines: string[] = ["📊 ACP status"];
    if (contextTokens !== null) {
        const pct = contextLimit !== null && contextLimit > 0 ? ` (${((contextTokens / contextLimit) * 100).toFixed(1)}%)` : "";
        lines.push(`  context: ${fmtTok(contextTokens)}${contextLimit !== null ? ` / ${fmtTok(contextLimit)}` : ""}${pct}`);
    }
    const hostCredit = num(s.hostCredit);
    if (hostCredit !== null && hostCredit > 0) {
        lines.push(`  host baseline: uncompressed (proxy backfilled +${fmtTok(hostCredit)} tok)`);
    }
    if (inputTokens !== null || outputTokens !== null || cachedTokens !== null) {
        lines.push(`  in/out/cached: ${fmtTok(inputTokens ?? 0)} / ${fmtTok(outputTokens ?? 0)} / ${fmtTok(cachedTokens ?? 0)}`);
    }
    if (requests !== null) lines.push(`  requests: ${requests}`);
    if (blocks.length > 0) lines.push(`  blocks: ${blocks.length} (${activeBlocks} active)`);
    return lines.join("\n");
}

function outcomeDetailsOf(output: ForwardedToolResult): Record<string, unknown> | undefined {
    if (output.outcome === undefined && output.blocksCreated === undefined) return undefined;
    const details: Record<string, unknown> = {};
    if (output.outcome !== undefined) details.outcome = output.outcome;
    if (output.blocksCreated !== undefined) details.blocksCreated = output.blocksCreated;
    return details;
}

function manifestToTool(proxyBase: string, tool: ManifestTool, agent: string): ToolDefinition {
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        loadMode: "essential",
        execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
            const conversationId = sessionIdOf(ctx) ?? "unknown";
            try {
                // #2416: read the LIVE base — a native respawn after a proxy
                // death moves the origin (the interceptor rewrites
                // BILLION_CONTEXT_PROXY), and a captured base would keep
                // firing at a dead port for the whole session while the model
                // channel recovers on its next dispatch. Same precedence as
                // registration (baseUrl /bili/ first, env second); the
                // captured value stays as fallback when nothing resolves.
                // baseUrl-first is deliberate for /bili/-wrapped baseUrls too:
                // wrapped URLs pin the model channel to their baked origin
                // (#1365) — a replacement instance can never carry them, and
                // recovery WAITS for the pinned origin instead of moving
                // traffic (verifyAttachAndRecover) — so env-first would split
                // tools onto an instance that lacks the conversation. Any
                // env divergence in that shape is transient: the intercept
                // rebinding (onRoutedOriginObserved) converges env back to the
                // observed routed origin.
                const base = proxyBaseForCtx(ctx) ?? proxyBase;
                const output = await forwardTool(base, conversationId, tool.name, params, signal, conversationId !== "unknown", toolCallId);
                // #2204: a business failure (e.g. a refused export) must reach
                // the host as isError — rendering it as plain success text is
                // what hid the #2204 write failures from OMP.
                // #2752: the structured business state rides pi's details channel
                // on BOTH branches — a refused/failure receipt carries its
                // outcome too, so analysis tooling can classify every call.
                const details = outcomeDetailsOf(output);
                if (output.failed) return { content: [{ type: "text", text: output.text }], isError: true, details };
                return { content: [{ type: "text", text: output.text }], details };
            } catch (err) {
                return { content: [{ type: "text", text: `bili tool error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
            }
        },
    };
}

function parseProviderRewrites(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
    const raw = env.BILI_PROVIDER_REWRITES;
    if (raw === undefined || raw.trim().length === 0) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.error("bili-plugin: BILI_PROVIDER_REWRITES is not valid JSON — provider URLs left untouched");
        return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== "string" || !/^https?:\/\//i.test(value)) continue;
        out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

// #788: neutral wording — the plugin also loads under plain pi/omp launches
// where the user never intended proxy mode (e.g. they use billion-context-pi
// in-process instead), so offer both exits instead of assuming proxy intent.
function noProxyWarning(agent: string): string {
    const removeHint = agent === "pi"
        ? ", or remove this plugin (`bili plugin remove pi`) if you use billion-context-pi or don't want a proxy"
        : agent === "omp"
            ? ", or remove this plugin (`bili plugin remove omp`) if you don't want a proxy"
            : "";
    return `bili: no proxy detected — run via \`bili ${agent}\` (or set a /bili/ baseURL) to use proxy mode${removeHint}`;
}

const RETRY_INTERVAL_MS = 10000;

type RegisterState = { sid?: string; toolsFor?: string; toolsReady?: boolean; pending?: Promise<void>; retryAt?: number; identityAt?: string; carriedSids?: Set<string>; retryIntervalMs: number; manifestPrime?: { base: string; tools: Promise<ManifestTool[] | undefined> }; registeredTools?: ManifestTool[]; observedActiveBili?: string[] };

// #2708: pi rebuilds its executable tool list per request — _refreshToolRegistry() walks
// the live extension instances' tool maps into _toolRegistry, and setActiveToolsByName()
// filters the active names through _toolRegistry.has(name), silently dropping any name it
// no longer holds. If that rebuild runs while our instance's map is empty (a runtime
// replacement / reload mid-session), the ACP tools leave the registry + active set while the
// transcript keeps declaring them — the model then calls tools pi rejects by name forever,
// and the once-per-sid gate below would never re-register them. Self-heal by probing the
// host's real registry and re-asserting vanished tools: registerTool is idempotent (dedup by
// name) and post-bind triggers a registry refresh, so a per-request re-assert is cheap and
// safe. No registry query (older pi / omp) or a throwing query → no-op, never a blind re-register.
function reassertDroppedTools(pi: ExtensionAPI, state: RegisterState, agent: string, proxyBase: string): void {
    const tools = state.registeredTools;
    if (tools === undefined || tools.length === 0) return;
    const probe = (pi as { getAllTools?: () => Array<{ name?: unknown }> }).getAllTools;
    if (typeof probe !== "function") return;
    let present: Set<string>;
    try {
        present = new Set(probe.call(pi).map((t) => (typeof t?.name === "string" ? t.name : "")).filter((n): n is string => n.length > 0));
    } catch {
        return; // query rejected (e.g. stale ctx) — never re-register blindly
    }
    const missing = tools.map((t) => t.name).filter((name) => !present.has(name));
    if (missing.length === 0) return;
    logHostEvent("warn", "[native-client]", `bili-plugin(${agent}): ${missing.length} bili tool(s) dropped from the host registry (${missing.join(", ")}) — re-registering (#2708)`);
    for (const t of tools) pi.registerTool(manifestToTool(proxyBase, t, agent));
}

// #4988: remember which of our registered tools the host currently has ACTIVE.
// An external loadout manager (pi-loadout) or a manual toggle may deliberately
// keep a registered bili tool OUT of the loadout, and #3542's recovery must not
// resurrect those — only tools that were active before the navigation and are
// gone after it were actually lost to the rewind. session_before_tree fires
// inside navigateTree BEFORE the leaf switch and the _restoreToolsFromTranscript
// reset, so a sample taken there IS the pre-navigation loadout; per-request
// sampling covers hosts without the event. undefined = never sampled → the
// caller falls back to the original all-registered recovery.
function sampleActiveBili(pi: ExtensionAPI, state: RegisterState): void {
    const tools = state.registeredTools;
    if (tools === undefined || tools.length === 0) return; // nothing registered yet — stay unobserved
    const getActive = pi.getActiveTools;
    if (typeof getActive !== "function") return;
    let names: unknown;
    try {
        names = getActive.call(pi);
        if (!Array.isArray(names)) return;
    } catch {
        return; // stale ctx — never guess
    }
    const present = new Set(names.filter((n): n is string => typeof n === "string"));
    state.observedActiveBili = tools.map((t) => t.name).filter((name) => present.has(name));
}

// #3542: a pi /tree rewind (navigateTree) resets the ACTIVE tool loadout to what
// the surviving transcript system entries declare (_restoreToolsFromTranscript),
// discarding the entry that declared our tools whenever it sits after the rewind
// target — the normal case, since the manifest handshake is async and lands after
// the first turn's declaration. The definitions stay in the registry, so #2708's
// probe sees nothing missing, but pi dispatches on the loadout: every later call
// fails with "Tool X not found" until restart. session_tree fires right after the
// reset and before the next _startRun, so re-assert there. Additive-only (names
// the host currently holds are never removed), mirroring pi's own reload()
// precedent of re-activating all extension tools. No loadout query/setter (older
// pi / omp) or a throwing query → no-op, never a blind set.
 // #4988: "missing" is judged against the PRE-navigation observation, not against
 // everything we ever registered — a tool deliberately kept off by an external
 // loadout manager (or a manual toggle) was inactive before the navigation too, so
 // it is not among the candidates and its off state survives in either handler
 // order. Never sampled (host without session_before_tree) → the original
 // all-registered recovery stands. Known boundary: when SOURCE and TARGET branches
 // carry DIFFERENT selections (active on source, deliberately off on target), the
 // post-nav absence looks exactly like a rewind drop from bili's local view — bili
 // running LAST resurrects it, only the manager-last order keeps the target
 // selection; closing that needs a coordination signal, not a better local guess.
function reassertLoadoutAfterTree(pi: ExtensionAPI, state: RegisterState, agent: string): void {
    const tools = state.registeredTools;
    if (tools === undefined || tools.length === 0) return;
    const getActive = pi.getActiveTools;
    const setActive = pi.setActiveTools;
    if (typeof getActive !== "function" || typeof setActive !== "function") return;
    let active: string[];
    try {
        const names = getActive.call(pi);
        if (!Array.isArray(names)) return;
        active = names.filter((n): n is string => typeof n === "string");
    } catch {
        return; // stale ctx — same guard as reassertDroppedTools
    }
    const present = new Set(active);
    const registeredNames = tools.map((t) => t.name);
    const observed = state.observedActiveBili;
    const candidates = observed === undefined ? registeredNames : registeredNames.filter((name) => observed.includes(name));
    const missing = candidates.filter((name) => !present.has(name));
    if (missing.length === 0) return;
    try {
        setActive.call(pi, [...active, ...missing]);
    } catch {
        return; // setter rejected — never break the navigation
    }
    logHostEvent("warn", "[native-client]", `bili-plugin(${agent}): ${missing.length} bili tool(s) dropped from the active loadout by a tree navigation (${missing.join(", ")}) — re-asserting (#3542/#4988)`);
}

async function registerTools(pi: ExtensionAPI, ctx: Ctx, state: RegisterState, agent: string, awaitNativeOrigin = true): Promise<void> {
    let proxyBase = proxyBaseForCtx(ctx);
    if (proxyBase === undefined && awaitNativeOrigin) proxyBase = await awaitNativeProxyOrigin();
    if (proxyBase === undefined) return;
    // Cache on the session id; "" (host has no sessionManager) still caches,
    // so a successful registration is not re-fetched on every provider
    // request — the manifest is session-independent anyway.
    const sid = sessionIdOf(ctx) ?? "";
    if (sid === state.sid) {
        // #2708: already registered for this sid — but pi may have rebuilt its
        // registry since and dropped our tools. Re-assert if they vanished.
        reassertDroppedTools(pi, state, agent, proxyBase);
        // #4988: keep the pre-navigation observation fresh on hosts whose
        // session_tree is not preceded by a usable session_before_tree sample.
        sampleActiveBili(pi, state);
        return;
    }
    if (state.pending !== undefined) return state.pending;
    if (state.retryAt !== undefined && Date.now() < state.retryAt) return;
    const wait = state.retryIntervalMs;
    state.pending = (async () => {
        // #1217: consume the load-time manifest prime (see factory). It is
        // taken exactly once and only for the same proxy origin; a failed
        // prime resolves to undefined and falls through to the normal fetch
        // below (same failure path, same log, then retry-throttled).
        let tools: ManifestTool[] | undefined;
        const prime = state.manifestPrime;
        state.manifestPrime = undefined;
        if (prime !== undefined && prime.base === proxyBase) tools = await prime.tools;
        if (tools === undefined) {
            try {
                tools = await fetchManifest(proxyBase);
            } catch (err) {
                state.retryAt = Date.now() + wait;
                logHostEvent("error", "[native-client]", `bili-plugin(${agent}): manifest fetch failed: ${err instanceof Error ? err.message : String(err)} — retrying in ${wait / 1000}s`);
                return;
            }
        }
        try {
            // toolsFor (not sid) guards the register loop: a retry after a
            // failed identity register re-fetches the manifest but must NOT
            // re-register the tools (the host may not dedupe by name).
            if (state.toolsFor !== sid) {
                for (const t of tools) pi.registerTool(manifestToTool(proxyBase, t, agent));
                state.toolsFor = sid;
                // #2708: remember what we put in the host registry so the
                // per-request re-assert can detect a later drop.
                state.registeredTools = tools;
            }
            state.toolsReady = true;
            state.retryAt = undefined;
            // #1333/#1362: a child session (pi RLM inline spawn, omp fork or
            // newSession with a parentSession header) reports its parent
            // conversation so the proxy can record a read-only inheritance
            // link (decompress/search_context fall back to the parent chain —
            // no state is copied). Plain pi sessions never identity-register:
            // their plugin-mode binding rides the x-bili-plugin-conversation
            // header stamped per request below, so the extra register only
            // fires when derivation is actually declared. omp ALWAYS registers
            // (its wire carries no other conversation signal), so it reports
            // the parent whenever the header declares one.
            const parent = agent === "pi" || agent === "omp" ? parentConversationIdOf(ctx) : undefined;
            if ((agent === "omp" || (agent === "pi" && parent !== undefined)) && sid !== "" && state.identityAt !== sid) {
                try {
                    await postIdentityRegister(proxyBase, sid, agent, parent);
                    state.identityAt = sid;
                } catch (err) {
                    // Leave state.sid UNSET so the next per-request event
                    // re-enters (throttled by retryAt) and retries ONLY the
                    // register — setting sid here would wedge the session in
                    // wire mode forever (the early return above blocks every
                    // retry).
                    state.retryAt = Date.now() + wait;
                    logHostEvent("error", "[native-client]", `bili-plugin(${agent}): identity register failed (${err instanceof Error ? err.message : String(err)}) — retrying in ${wait / 1000}s`);
                    return;
                }
            }
            state.sid = sid;
            // #2708: a same-id session_start skips the register loop above
            // (toolsFor already === sid), so re-assert here too — otherwise a
            // drop during that window wouldn't heal until the next request.
            reassertDroppedTools(pi, state, agent, proxyBase);
        } catch (err) {
            state.sid = undefined;
            state.toolsFor = undefined;
            state.retryAt = Date.now() + wait;
            logHostEvent("error", "[native-client]", `bili-plugin(${agent}): tool registration deferred (${err instanceof Error ? err.message : String(err)}) — retrying in ${wait / 1000}s`);
        }
    })();
    try {
        await state.pending;
    } finally {
        state.pending = undefined;
    }
}

// #3304: pi's payload swap happens INSIDE the runner (before_provider_request
// returns the replacement), so the fetch layer cannot correlate a request by
// object identity. Instead it sniffs the outgoing body for the incremental
// envelope — the same shape test the lane's divert runs server-side — and
// restores the original stashed under the envelope's conversationId. Pi sends
// model requests strictly sequentially per session (the same invariant
// pendingIncrementalAcks relies on), so one entry per conversation is exact.
const PI_ORIGINAL_TTL_MS = 5 * 60_000;
const piIncrementalOriginals = new Map<string, { body: string; at: number }>();

function stashPiIncrementalOriginal(conversationId: string, payload: unknown): void {
    const now = Date.now();
    sweepStale(piIncrementalOriginals, PI_ORIGINAL_TTL_MS);
    piIncrementalOriginals.set(conversationId, { body: JSON.stringify(payload), at: now });
}

function takePiIncrementalOriginal(conversationId: string): string | null {
    const entry = piIncrementalOriginals.get(conversationId);
    if (entry === undefined || Date.now() - entry.at >= PI_ORIGINAL_TTL_MS) return null;
    return entry.body;
}

export function __resetPiIncrementalOriginalsForTests(): void {
    piIncrementalOriginals.clear();
}

/** Test-only: seed the stash directly (driving the full extension event
 *  chain just for this is not worth it). */
export function __stashPiIncrementalOriginalForTests(conversationId: string, payload: unknown): void {
    stashPiIncrementalOriginal(conversationId, payload);
}

/** #3304: prepareDirectSend for the pi/omp extension lanes (pi-native arms
 *  it on its NativeInterceptState). A body that IS an incremental envelope
 *  was swapped by maybeIncrementalTurn → restore the stashed original
 *  (or refuse when the stash aged out); any other body is a standalone
 *  full-resend request → as-is. */
export function createPiDirectSendGuard(): (url: string, input: string | URL | Request, init: RequestInit | undefined) => Promise<DirectSendPrep> {
    return async (_url, input, init) => {
        let text: string | undefined;
        try {
            if (typeof init?.body === "string") {
                text = init.body;
            } else if (input instanceof Request) {
                text = await input.clone().text();
            }
        } catch {
            text = undefined; // unreadable body — treat as standalone
        }
        if (text === undefined || text.length === 0) return { outcome: "as-is" };
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return { outcome: "as-is" };
        }
        const sid = incrementalEnvelopeConversationId(parsed);
        if (sid === undefined) return { outcome: "as-is" };
        const body = takePiIncrementalOriginal(sid);
        return body === null ? { outcome: "unrestorable" } : { outcome: "restored", body };
    };
}

export function createBiliPlugin(agentOverride?: string, opts?: { retryIntervalMs?: number }): (pi: ExtensionAPI) => void {
    return function biliPlugin(pi: ExtensionAPI): void {
        const agent = agentName(agentOverride);
        const state: RegisterState = { retryIntervalMs: opts?.retryIntervalMs ?? RETRY_INTERVAL_MS };
        // #3066/#3516: tool-output guardrails (output cap / bash timeout /
        // repetition loop-break); knobs resolve env > file > default so the
        // documented BILI_GUARDRAIL_* / guardrails.* switches work end-to-end.
        // maxBytes maps knob-undefined(disabled) → 0(no cap): wireToolGuardrails
        // treats undefined as its 50KB default, not as "off".
        wireToolGuardrails(pi, {
            bashTimeout: guardrailBashTimeout(),
            maxBytes: guardrailMaxOutputBytes() ?? 0,
            repetition: guardrailRepetition(),
        });
        // #2336: one successful agent-providers report per plugin instance;
        // retried on later session_starts while the proxy base is unknown
        // (native mode resolves it asynchronously).
        let agentProvidersDone = false;
        // #2185 方案 A: this bundle's own file path, registered per session so
        // pi-subagents children load it deterministically (see module header).
        const subagentReg: SubagentSelfRegState = {};
        const entryFile = fileURLToPath(import.meta.url);
        // #1217: -p single-shot fires round 1 before session_start's manifest
        // fetch can resolve, leaving the request unmarked → anonymous
        // proxy-mode session. Prime the fetch at load time: the launcher
        // health-checks the proxy before spawning pi, so by session_start the
        // prime has almost always settled and toolsReady flips in microtasks
        // — ahead of round 1. Native mode (#519) sets BILLION_CONTEXT_PROXY
        // only after async bootstrap, so no prime exists there and round 1
        // stays on wire mode (residual; the host would have to await us).
        const primeBase = detectProxyBase(undefined);
        if (primeBase !== undefined) {
            state.manifestPrime = { base: primeBase, tools: fetchManifest(primeBase).then((t) => t, () => undefined) };
        }
        // #535: file-free routing — override provider baseUrls at load from
        // the launcher-passed manifest (see buildPiEnv). registerProvider is
        // queued during initial extension load and applied before any model
        // traffic, so every request (including round 1) rides the proxy.
        const rewrites = parseProviderRewrites(process.env);
        if (rewrites !== undefined && typeof pi.registerProvider !== "function") {
            console.error(
                "bili-plugin: BILI_PROVIDER_REWRITES is set but this pi build has no registerProvider API — " +
                    "provider traffic goes DIRECT (uncompressed). Update pi, or reinstall the bili plugin: `bili plugin install pi`.",
            );
        }
        if (rewrites !== undefined && typeof pi.registerProvider === "function") {
            for (const [key, url] of Object.entries(rewrites)) {
                try {
                    pi.registerProvider(key, { baseUrl: url });
                } catch (err) {
                    console.error(`bili-plugin: registerProvider(${key}) failed: ${err instanceof Error ? err.message : String(err)} — traffic for this provider goes direct`);
                }
            }
        }
        // #535: cancel the host's NATIVE compaction so its summarizer never
        // fires alongside bili's ACP compression — the in-extension
        // replacement for the old compaction-off config injection. pi's event
        // carries `reason`: cancel only threshold + overflow so manual
        // /compact stays user-owned. omp (#851): session_before_compact
        // carries NO reason field, so at hook level manual compaction
        // (/compact, plan-mode "Approve and compact context") is
        // indistinguishable from auto — but every auto pass announces itself
        // first via auto_compaction_start (reason threshold|overflow|idle|
        // incomplete), which omp emits (awaited) before the hook fires;
        // manual paths never do. Track the announcement: announced passes
        // stay cancelled, unannounced ones are left user-owned. A surviving
        // native compaction is safe: the proxy archives the unreachable
        // blocks on session_compact (#395).
        // Whether we own compression is decided at EVENT time, not load time:
        // in native mode (#519) the proxy origin lands in
        // BILLION_CONTEXT_PROXY only after the async bootstrap finishes, so a
        // load-time check would leave the cancel disarmed for the whole
        // session. Plain pi/omp with the plugin installed but NO reachable
        // proxy (incl. a failed bootstrap) stays fully native.
        // #1382: a proxy EXISTING is not enough — the evidence must be that
        // THIS conversation's traffic reaches it. Native mode sets
        // BILLION_CONTEXT_PROXY for the whole process, but extension-provided
        // models like pi-claude-bridge run their own child processes (the
        // model's baseUrl is literally "claude-bridge") and call upstream
        // directly: the fetch intercept never sees those requests, so the
        // proxy never carried the conversation. Cancelling there killed ALL
        // compaction — the bridge disables Claude Code's own auto-compact and
        // takes over Pi's in its own session_before_compact handler, which
        // never runs once an earlier handler returned cancel. Accepted
        // evidence, in order: (1) local — we stamped
        // x-bili-plugin-conversation for this session id (tools registered
        // AND a request routed through the proxy), or omp's identity register
        // succeeded; (2) remote — the proxy confirms it carries the
        // conversation id (/__bili/plugin/status ok). A non-http(s) baseUrl
        // vetoes by default (opt-in via BILI_NON_HTTP_PROVIDERS below only
        // widens the candidate set; carriage evidence still decides). Hosts
        // exposing no stable session id keep the
        // historical cancel (the proxy may carry them under a derived
        // content-hash identity, where avoiding double compression still
        // wins). Probe failure (proxy down/hung) means NO evidence → defer to
        // native compaction: a surviving native pass is safe (#395), a wrong
        // cancel overflows the session. The handlers are async on purpose —
        // pi's runner awaits session_before_compact handlers (verified in
        // pi-coding-agent dist) before consulting .cancel/.compaction.
        const ownsCompaction = async (ctx: Ctx | undefined, branchEntries?: unknown): Promise<boolean> => {
            const proxyBase = proxyBaseForCtx(ctx, branchEntries);
            if (proxyBase === undefined) return false;
            const baseUrl = ctx?.model?.baseUrl;
            if (typeof baseUrl === "string" && baseUrl.length > 0 && !/^https?:\/\//i.test(baseUrl)) {
                // #1392: an opaque-scheme baseUrl (e.g. pi-claude-bridge's "claude-bridge")
                // vetoes compaction ownership UNLESS its provider is explicitly opted in via
                // BILI_NON_HTTP_PROVIDERS. Opt-in only widens the candidate set — the carriage
                // evidence below (carriedSids / status probe) still decides, so unrouted traffic
                // never cancels and #1382 cannot recur for a newly-opted-in provider class.
                const provider = ctx?.model?.provider;
                if (!(typeof provider === "string" && provider.length > 0 && nonHttpProvidersFromEnv().has(provider))) return false;
            }
            const sid = ctx === undefined ? undefined : sessionIdOf(ctx);
            if (sid === undefined || sid.length === 0) return true;
            if (agent === "pi" ? state.carriedSids?.has(sid) === true : state.identityAt === sid) return true;
            try {
                return (await fetchStatus(proxyBase, sid)) !== undefined;
            } catch (err) {
                logHostEvent("error", "[native-client]", `bili-plugin(${agent}): compaction ownership probe failed (${err instanceof Error ? err.message : String(err)}) — leaving native compaction enabled`);
                return false;
            }
        };
        if (agent === "pi" || agent === "omp") {
            if (agent === "pi") {
                pi.on("session_before_compact", async (event, ctx) => {
                    const ev = event as unknown as { reason?: unknown; branchEntries?: unknown };
                    if (ev.reason !== "threshold" && ev.reason !== "overflow") return undefined;
                    if (!(await ownsCompaction(ctx, ev.branchEntries))) return undefined;
                    return { cancel: true };
                });
            } else {
                let autoPending = false;
                pi.on("auto_compaction_start", () => {
                    autoPending = true;
                });
                pi.on("auto_compaction_end", () => {
                    autoPending = false;
                });
                pi.on("session_before_compact", async (event, ctx) => {
                    if (!autoPending) return undefined;
                    if (!(await ownsCompaction(ctx))) return undefined;
                    autoPending = false;
                    return { cancel: true };
                });
            }
        }
        // #535 omp-only: omp resolves modelRoles.default into options.model
        // from the PRE-extension static catalog (main.ts: "scope is resolved
        // before extensions register their providers"), and omp's fork lacks
        // pi's registerProvider → _refreshCurrentModelFromRegistry hop — the
        // registry gets the rewritten baseUrl but the live session keeps the
        // direct one, so every request bypasses the proxy (fetch trace →
        // http://127.0.0.1:8197/v1/responses with zero proxy forwards). Re-pin
        // the session model at load + on every session switch: spread the
        // current model with the rewritten baseUrl through the host setModel
        // (keyed-provider-gated; local providers carry dummy keys). Mid-session
        // /model picks resolve from the already-overridden registry, so only
        // session start/restore need this.
        if (agent === "omp" && rewrites !== undefined && typeof pi.setModel === "function") {
            const repin = async (ctx: Ctx): Promise<void> => {
                const model = ctx?.model;
                if (model === null || typeof model !== "object") return;
                const provider = model.provider;
                if (typeof provider !== "string" || provider === "") return;
                const rewritten = rewrites[provider];
                if (rewritten === undefined || model.baseUrl === rewritten) return;
                try {
                    const switched = await pi.setModel?.({ ...model, baseUrl: rewritten });
                    if (switched === false) {
                        logHostEvent("error", "[native-client]", `bili-plugin: omp setModel(${provider}/${String(model.id)}) rejected (no API key) — traffic for this provider goes direct`);
                    }
                } catch (err) {
                    logHostEvent("error", "[native-client]", `bili-plugin: omp setModel failed: ${err instanceof Error ? err.message : String(err)} — traffic goes direct`);
                }
            };
            pi.on("session_start", (_event, ctx) => repin(ctx));
            pi.on("session_switch", (_event, ctx) => repin(ctx));
        }
        if (agent === "pi" && typeof pi.registerMessageRenderer === "function") {
            pi.registerMessageRenderer("bili-acp-status", (message, { expanded, outputPad }, theme) => {
                if (expanded) return undefined;
                const text = typeof message.content === "string" ? message.content
                    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
                const lines = text.split("\n");
                // Block-detail line shape is owned by the kernel's buildStatusPanel
                // (kernel/src/panel/panel.ts); if it ever changes, folding degrades to full display.
                const collapsed = lines.filter((line) => !/^  \[b\d+\] T\d+ /.test(line));
                if (collapsed.length === lines.length) return undefined;
                const box = new Box(outputPad ?? 1, 1, (line) => theme.bg("customMessageBg", line));
                box.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[bili-acp-status]\x1b[22m"), 0, 0));
                box.addChild(new Spacer(1));
                box.addChild(new Markdown(collapsed.join("\n"), 0, 0, {
                    heading: (value) => theme.fg("mdHeading", value),
                    link: (value) => theme.fg("mdLink", value),
                    linkUrl: (value) => theme.fg("mdLinkUrl", value),
                    code: (value) => theme.fg("mdCode", value),
                    codeBlock: (value) => theme.fg("mdCodeBlock", value),
                    codeBlockBorder: (value) => theme.fg("mdCodeBlockBorder", value),
                    quote: (value) => theme.fg("mdQuote", value),
                    quoteBorder: (value) => theme.fg("mdQuoteBorder", value),
                    hr: (value) => theme.fg("mdHr", value),
                    listBullet: (value) => theme.fg("mdListBullet", value),
                    bold: (value) => theme.bold(value),
                    italic: (value) => theme.italic(value),
                    underline: (value) => theme.underline(value),
                    strikethrough: (value) => theme.strikethrough(value),
                }, { color: (value) => theme.fg("customMessageText", value) }));
                box.addChild(new Text(theme.fg("dim", "Ctrl+O to expand full ACP report"), 0, 0));
                return box;
            });
        }
        if (typeof pi.registerCommand === "function") {
            pi.registerCommand("acp", {
                description: "Show ACP context-compression status for this session",
                handler: async (_args, ctx) => {
                    const notify = (message: string, type?: string): void => {
                        try {
                            ctx.ui?.notify?.(message, type);
                        } catch {
                            // host UI unavailable — the command is best-effort
                        }
                    };
                    const proxyBase = detectProxyBase(ctx.model?.baseUrl);
                    if (proxyBase === undefined) {
                        notify(noProxyWarning(agent), "warning");
                        return;
                    }
                    const conversationId = sessionIdOf(ctx) ?? "unknown";
                    let status: Record<string, unknown> | undefined;
                    try {
                        status = await fetchStatus(proxyBase, conversationId);
                    } catch (err) {
                        notify(`bili: status fetch failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                        return;
                    }
                    if (status === undefined) {
                        // 404 from a live proxy = this conversation has sent no
                        // model request yet (e.g. /acp right after startup).
                        // Probe the manifest to confirm liveness + version and
                        // show an armed/idle notice instead of a scary warning.
                        let version: string | undefined;
                        try {
                            version = await fetchProxyVersion(proxyBase);
                        } catch {
                            version = undefined;
                        }
                        if (version !== undefined) {
                            notify(armedIdleNotice(version, proxyBase), "info");
                        } else {
                            notify(noSessionWarning(), "warning");
                        }
                        return;
                    }
                    const panel = typeof status.panel === "string" ? status.panel : undefined;
                    const text = panel ?? renderAcpStatus(status);
                    // Persistent transcript output (TUI + web hosts like pi-web).
                    // The proxy strips this message from the model context by
                    // content signature (src/acp-panel.ts), so it never reaches
                    // the LLM; notify() is the fallback for hosts without
                    // sendMessage (older pi).
                    if (typeof pi.sendMessage === "function") {
                        try {
                            pi.sendMessage({ customType: "bili-acp-status", content: text, display: true });
                            return;
                        } catch (err) {
                            logHostEvent("error", "[native-client]", `bili-plugin(${agent}): sendMessage failed (${err instanceof Error ? err.message : String(err)}) — falling back to notify`);
                        }
                    }
                    notify(text, "info");
                },
            });
            // #800: human entry point for the cache-reconciliation feature — the model side
            // already has the acp_cache tool; this command shows humans the identical report
            // (both paths hit handleAcpCache on the proxy). Launcher mode and native mode both
            // load this factory (see pi-native.ts), so one registration covers both.
            pi.registerCommand("acp-cache", {
                description: "Prompt-cache reconciliation for this session (same report as the acp_cache tool). Usage: /acp-cache [full]",
                handler: async (args, ctx) => {
                    const notify = (message: string, type?: string): void => {
                        try {
                            ctx.ui?.notify?.(message, type);
                        } catch {
                            // host UI unavailable — the command is best-effort
                        }
                    };
                    const proxyBase = detectProxyBase(ctx.model?.baseUrl);
                    if (proxyBase === undefined) {
                        notify(noProxyWarning(agent), "warning");
                        return;
                    }
                    const conversationId = sessionIdOf(ctx) ?? "unknown";
                    const toolArgs = /(^|\s)(--)?full(\s|$)/.test(args ?? "") ? { detail: "full" as const } : {};
                    let text: string;
                    try {
                        const out = await forwardTool(proxyBase, conversationId, "acp_cache", toolArgs, undefined, conversationId !== "unknown");
                        if (out.failed) {
                            notify(`bili: cache report failed: ${out.text}`, "error");
                            return;
                        }
                        text = out.text;
                    } catch (err) {
                        notify(`bili: cache report failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                        return;
                    }
                    // Persistent transcript output (TUI + web hosts like pi-web). The proxy strips
                    // the wrapped message from the model context by content signature
                    // (src/acp-panel.ts), so it never reaches the LLM; notify() is the fallback
                    // for hosts without sendMessage (older pi).
                    if (typeof pi.sendMessage === "function") {
                        try {
                            pi.sendMessage({ customType: "bili-acp-cache", content: wrapCacheReport(text), display: true });
                            return;
                        } catch (err) {
                            logHostEvent("error", "[native-client]", `bili-plugin(${agent}): sendMessage failed (${err instanceof Error ? err.message : String(err)}) — falling back to notify`);
                        }
                    }
                    notify(text, "info");
                },
            });
            // #1251/#1399: human entry point for the persistent-rules feature — the model
            // side already has the acp_rule tool; this command shows humans the identical
            // list (both paths hit executeRule on the proxy) and gives humans the full
            // operation set: record by passing text, remove one via `remove <id>`, wipe
            // all via bare `clear` (extra words after clear are recorded, never wiped —
            // a typo must not destroy every rule). Launcher mode and native mode both
            // load this factory (see pi-native.ts), so one registration covers both.
            pi.registerCommand("acp-rule", {
                description: "Persistent rules for this session (same ops as the acp_rule tool). Usage: /acp-rule [text to record] | /acp-rule remove <id> | /acp-rule clear",
                handler: async (args, ctx) => {
                    const notify = (message: string, type?: string): void => {
                        try {
                            ctx.ui?.notify?.(message, type);
                        } catch {
                            // host UI unavailable — the command is best-effort
                        }
                    };
                    const proxyBase = detectProxyBase(ctx.model?.baseUrl);
                    if (proxyBase === undefined) {
                        notify(noProxyWarning(agent), "warning");
                        return;
                    }
                    const conversationId = sessionIdOf(ctx) ?? "unknown";
                    const raw = (args ?? "").trim();
                    let toolArgs: Record<string, unknown>;
                    if (raw === "") {
                        toolArgs = {};
                    } else if (raw === "clear") {
                        toolArgs = { clear: true };
                    } else if (raw === "remove" || raw.startsWith("remove ")) {
                        const id = raw.slice("remove".length).trim();
                        if (id === "") {
                            notify("Usage: /acp-rule remove <rule-id> — bare /acp-rule lists the recorded ids", "warning");
                            return;
                        }
                        toolArgs = { delete: id };
                    } else {
                        toolArgs = { rule: raw };
                    }
                    let text: string;
                    try {
                        const out = await forwardTool(proxyBase, conversationId, "acp_rule", toolArgs, undefined, conversationId !== "unknown");
                        if (out.failed) {
                            notify(`bili: acp_rule failed: ${out.text}`, "error");
                            return;
                        }
                        text = out.text;
                    } catch (err) {
                        notify(`bili: acp_rule failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                        return;
                    }
                    // #1192 note channel (disabledOptionalToolNote): the feature is off in
                    // this session's effective config — surface the enablement hint instead
                    // of echoing the model-facing note into the transcript.
                    if (text.startsWith("acp_rule is not enabled")) {
                        notify("bili: acp_rule is not enabled on this bili proxy — set compress.rules.enabled: true in your bili config", "warning");
                        return;
                    }
                    // Persistent transcript output (TUI + web hosts like pi-web). The proxy strips
                    // the wrapped message from the model context by content signature
                    // (src/acp-panel.ts), so it never reaches the LLM; notify() is the fallback
                    // for hosts without sendMessage (older pi).
                    if (typeof pi.sendMessage === "function") {
                        try {
                            pi.sendMessage({ customType: "bili-acp-rule", content: wrapRuleReport(text), display: true });
                            return;
                        } catch (err) {
                            logHostEvent("error", "[native-client]", `bili-plugin(${agent}): sendMessage failed (${err instanceof Error ? err.message : String(err)}) — falling back to notify`);
                        }
                    }
                    notify(text, "info");
                },
            });
        }
        pi.on("before_provider_headers", async (event, ctx) => {
            try {
                // #1243: on the native lane the proxy origin lands via an async
                // bootstrap that writes BILLION_CONTEXT_PROXY only after the spawn;
                // a one-shot (-p) fires this event exactly once, inside that
                // window. Await the writer's ready promise instead of racing it —
                // hosts without a native entry register no waiter and fall
                // straight through to wire mode.
                let proxyBase = proxyBaseForCtx(ctx);
                if (proxyBase === undefined) proxyBase = await awaitNativeProxyOrigin();
                if (proxyBase === undefined) return;
                const headers = (event as unknown as { headers?: Record<string, string> }).headers;
                if (headers === undefined || typeof headers !== "object" || Array.isArray(headers)) return;
                // #1214: pi's runner AWAITS async handlers (emitBeforeProviderHeaders),
                // so the ownership claim serializes behind tool registration instead
                // of racing it. A one-shot (`pi -p`) dispatches exactly ONE request —
                // with fire-and-forget registration it rode wire mode forever and
                // bound as an anonymous pfa session. registerTools is idempotent
                // (sid-cached, pending-deduped, retryAt-throttled), so the await is
                // bounded; a permanently failing manifest fetch still degrades to
                // wire mode — a graceful fallback rather than a tool-less session.
                try {
                    await registerTools(pi, ctx, state, agent);
                } catch (err) {
                    logHostEvent("error", "[native-client]", `bili-plugin(${agent}): tool registration failed (${err instanceof Error ? err.message : String(err)}) — riding wire mode for this request`);
                }
                // The x-bili-plugin marker tells the proxy "the client owns the
                // ACP tools natively — skip wire-level injection". Ownership is
                // claimed only once tools are registered (#162). In launcher mode
                // the manifest fetch is primed at extension load time (#1217), so
                // by round 1 registration has almost always completed.
                if (state.toolsReady === true) {
                    const sid = sessionIdOf(ctx);
                    if (sid !== undefined) headers["x-bili-plugin-conversation"] = sid;
                    if (sid !== undefined && sid.length > 0) {
                        state.carriedSids ??= new Set();
                        state.carriedSids.add(sid);
                    }
                    headers["x-bili-plugin"] = agent;
                    // #3248: when the lane advertises incremental turns, declare
                    // the divert intent. Declaring is safe — the lane shape-tests
                    // the body, so full-resend turns (retries, dead conversations,
                    // side lanes) ride the normal pipeline anyway. pi only: omp
                    // never emits before_provider_headers, so its requests carry
                    // no x-bili-plugin marker and the divert would never fire.
                    if (agent === "pi" && proxyBase !== undefined && await probeIncrementalTurns(proxyBase)) {
                        headers[INCREMENTAL_TURN_MARKER_HEADER] = "1";
                    }
                    const window = ctx.model?.contextWindow;
                    if (typeof window === "number" && Number.isFinite(window) && window > 0) {
                        headers["x-bili-plugin-context-window"] = String(Math.floor(window));
                    }
                    // Runtime-info (#955): model id + configured max output.
                    // pi's model config exposes id / contextWindow / baseUrl;
                    // maxTokens lives on the model object when configured.
                    const modelId = ctx.model?.id;
                    if (typeof modelId === "string" && modelId.length > 0) {
                        const modelHeader = asciiHeaderValue(modelId);
                        if (modelHeader !== undefined) headers["x-bili-plugin-model"] = modelHeader;
                        const maxOut = (ctx.model as { maxTokens?: unknown } | undefined)?.maxTokens;
                        if (typeof maxOut === "number" && Number.isFinite(maxOut) && maxOut > 0) headers["x-bili-plugin-max-output"] = String(Math.floor(maxOut));
                        reportRuntimeInfoOnChange(proxyBase, { agent, model: modelId, contextWindow: typeof window === "number" && window > 0 ? Math.floor(window) : undefined, maxOutput: typeof maxOut === "number" && maxOut > 0 ? Math.floor(maxOut) : undefined, baseURL: ctx.model?.baseUrl, source: "client-config" });
                    }
                }
            } catch (err) {
                logHostEvent("error", "[native-client]", `bili-plugin(${agent}): header stamp skipped (${err instanceof Error ? err.message : String(err)})`);
            }
        });
        // omp never emits before_provider_headers — where pi stamps the
        // x-bili-plugin-* headers and reports runtime info (#955) — so omp's
        // report rides this per-request event instead: POST only, deduped per
        // config change, gated on toolsReady like pi's header path (ownership
        // claim = ACP tools registered; round 1 rides wire mode). #1531: the
        // report carries the session id as conversationId and is AWAITED
        // before the request dispatches — omp sends no x-bili-plugin header,
        // so the proxy resolves this report by the prompt_cache_key identity
        // stamped below, and the first request must not outrun its own
        // report. Worst hold = native-origin wait (bounded by the bootstrap
        // readyTimeoutMs) + one POST (STATUS_TIMEOUT_MS) — well inside omp's
        // handler timeout guardrail.
        async function reportOmpRuntimeInfo(ctx: Ctx): Promise<void> {
            if (state.toolsReady !== true) return;
            const modelId = ctx.model?.id;
            if (typeof modelId !== "string" || modelId.length === 0) return;
            // #1243 pattern: native bootstrap writes BILLION_CONTEXT_PROXY
            // asynchronously — await the writer instead of racing it.
            let proxyBase = proxyBaseForCtx(ctx);
            if (proxyBase === undefined) proxyBase = await awaitNativeProxyOrigin();
            if (proxyBase === undefined) return;
            const window = ctx.model?.contextWindow;
            const maxOut = (ctx.model as { maxTokens?: unknown } | undefined)?.maxTokens;
            const sid = sessionIdOf(ctx);
            await reportRuntimeInfoOnChange(proxyBase, { agent, model: modelId, contextWindow: typeof window === "number" && window > 0 ? Math.floor(window) : undefined, maxOutput: typeof maxOut === "number" && maxOut > 0 ? Math.floor(maxOut) : undefined, baseURL: ctx.model?.baseUrl, ...(sid !== undefined && sid.length > 0 ? { conversationId: sid } : {}), source: "client-config" });
        }
        // #2399 stage 2: fork-child adoption for pi (/fork, /clone, --fork)
        // and omp (fork()). A child session's header declares parentSession;
        // its first model request replays the parent history, so BEFORE that
        // request lands we adopt the parent's compression state through the
        // plugin fork protocol — otherwise the replay arrives as a fresh
        // conversation and preflight refolds everything from scratch (#2383).
        // The once-per-sid / retry-cap / single-flight bookkeeping lives in
        // the shared coordinator; the per-sid parent cache avoids re-reading
        // the parent session file (64KB sync read in parentConversationIdOf)
        // on every model request.
        const forkAdopter = createForkAdopter((line) => logHostEvent("error", "[native-client]", `bili-plugin(${agent}): ${line}`));
        const forkParents = new Map<string, string | undefined>();
        const forkSeedVerdicts = new Map<string, "seeded" | "lineage-only" | "unknown">();
        // #3248 incremental turns: outbound plans awaiting their ack. Keyed by
        // conversation id; one entry per in-flight incremental turn (pi sends
        // model requests strictly sequentially per session). Cleared on the
        // after_provider_response ack, dropped on failure.
        const pendingIncrementalAcks = new Map<string, { messages: IncrementalWireMessage[]; system: unknown; base: string }>();
        async function maybeIncrementalTurn(event: { payload?: unknown }, ctx: Ctx): Promise<unknown> {
            if (state.toolsReady !== true) return undefined; // no marker stamped → must not replace
            const payload = event.payload as { messages?: unknown; system?: unknown } | undefined;
            if (payload === null || typeof payload !== "object" || !Array.isArray((payload as { messages?: unknown }).messages)) return undefined;
            if (!wireMessagesLookAnthropic(payload.messages)) return undefined; // anthropic wire only — OpenAI tool shapes resend full (#3433)
            const sid = sessionIdOf(ctx);
            if (sid === undefined || sid.length === 0) return undefined;
            let proxyBase = proxyBaseForCtx(ctx);
            if (proxyBase === undefined) proxyBase = await awaitNativeProxyOrigin();
            if (proxyBase === undefined) return undefined;
            if (!(await probeIncrementalTurns(proxyBase))) return undefined;
            // #4352: the response-header ack channel is transport-dependent —
            // pi's after_provider_response only exposes headers for some
            // provider transports, and a missed ack makes EVERY next turn
            // re-seed the full history (the 2026-10-22 incident: turn 2 sent
            // sinceSeq=0 again). Before planning, reconcile any still-pending
            // un-acked turn by PULLING the lane's receipt and adopting it only
            // when the boundary hash proves the canonical absorbed OUR last
            // message — never on mere seq progress (a foreign full-resend can
            // advance the canonical too).
            const pendingAck = pendingIncrementalAcks.get(sid);
            if (pendingAck !== undefined && pendingAck.messages.length > 0) {
                const receipt = await pullIncrementalReceipt(proxyBase, sid);
                const expected = incrementalWireHash(pendingAck.messages[pendingAck.messages.length - 1]);
                if (receipt !== null && receipt.appliedSeq > 0 && receipt.boundary === expected) {
                    pendingIncrementalAcks.delete(sid);
                    piIncrementalOriginals.delete(sid);
                    noteIncrementalAck(sid, receipt.appliedSeq, pendingAck.messages, pendingAck.system);
                }
            }
            const plan = planIncrementalTurn({
                conversationId: sid,
                // The marker divert uses the ORIGINAL request URL server-side;
                // this path is only a placeholder for the direct-endpoint form.
                path: "/v1/messages",
                messages: payload.messages as IncrementalWireMessage[],
                system: "system" in payload ? payload.system : undefined,
                request: payload as Record<string, unknown>,
            });
            if (plan.mode === "skip") return undefined;
            // #3304: stash the ORIGINAL payload under this conversation — the
            // direct-send guard restores it if the proxy dies before the
            // swapped envelope lands on the wire.
            stashPiIncrementalOriginal(sid, payload);
            pendingIncrementalAcks.set(sid, { messages: payload.messages as IncrementalWireMessage[], system: "system" in payload ? payload.system : undefined, base: proxyBase });
            const body = JSON.parse((plan as { body: string }).body) as { messages: IncrementalWireMessage[]; msgIds?: string[] };
            // #4491 pi msgids wiring: attach the pi session's stable message
            // ids (aligned to the FULL outgoing wire) sliced to the plan's
            // delta messages, all-or-nothing — one unresolvable message, a
            // multi-block delta message (the lane pins 1:1 onto the flattened
            // core messages and 400s otherwise), or a poison-shaped id leaves
            // the field off entirely and the turn rides content-derived ids.
            let branch: unknown;
            try {
                branch = ctx.sessionManager?.getBranch?.();
            } catch {
                branch = undefined;
            }
            const ids = laneMsgIdsForWire(payload.messages, branch);
            if (ids !== undefined && body.messages.every((m) => lanePinnableContent(m.content))) {
                const sliced = ids.slice(ids.length - body.messages.length);
                if (sliced.length === body.messages.length && validateMsgIds(sliced, sliced.length).ok) body.msgIds = sliced;
            }
            return body;
        }
        async function maybeAdoptForkChild(event: unknown, ctx: Ctx): Promise<void> {
            if (state.toolsReady !== true) return;
            const sid = sessionIdOf(ctx);
            if (sid === undefined || sid.length === 0) return;
            if (!forkParents.has(sid)) forkParents.set(sid, parentConversationIdOf(ctx));
            const parent = forkParents.get(sid);
            if (parent === undefined || parent === "" || parent === sid) return;
            // #2469: seeding evidence is evaluated ONCE per sid — the first
            // model request IS the adoption window (later requests can only
            // CHILD_CONFLICT), so a lineage-only verdict can never lose a
            // later adoption opportunity. Lineage-only children skip every
            // network call; their derivedFrom link (registerTools) stays
            // read-only.
            if (!forkSeedVerdicts.has(sid)) {
                const count = replayedMessageCount(ctx);
                const verdict = count === undefined ? "unknown" : count >= FORK_SEED_MIN_REPLAYED_MESSAGES ? "seeded" : "lineage-only";
                forkSeedVerdicts.set(sid, verdict);
                if (verdict === "lineage-only") {
                    logHostEvent("warn", "[native-client]", `bili-plugin(${agent}): fork adoption for ${sid} skipped — lineage-only child (${count} message(s) in its own branch, no replayed parent history); the derivedFrom link stays read-only (#2469)`);
                }
            }
            if (forkSeedVerdicts.get(sid) === "lineage-only") return;
            let proxyBase = proxyBaseForCtx(ctx);
            if (proxyBase === undefined) proxyBase = await awaitNativeProxyOrigin();
            if (proxyBase === undefined) return;
            await forkAdopter.maybeAdopt({ base: proxyBase, parent, child: sid, body: (event as { payload?: unknown } | undefined)?.payload });
        }
        pi.on("before_provider_request", async (event, ctx) => {
            // #4491 omp msgids: snapshot the branch's stable entry ids BEFORE
            // any await below — the hint must be the generation of THIS
            // payload. The fetch-layer planner (omp-native) reads it back by
            // the prompt_cache_key conversation id and carries `msgIds` only
            // when the ids align 1:1 with the actually-sent messages; any
            // mismatch degrades to no field, never a misaligned array.
            if (agent === "omp") {
                const hintSid = sessionIdOf(ctx);
                if (hintSid !== undefined && hintSid.length > 0) noteHostMsgIdHint(hintSid, ompBranchMsgIdEntries(ctx));
            }
            // omp emits this per model request (but never before_provider_headers);
            // it doubles as the retry driver when the session_start manifest
            // fetch raced the proxy startup. Cached by sid, throttled by retryAt.
            // #1230: omp's runner also AWAITS async handlers (emitBeforeProviderRequest)
            // and uses the resolved value as the outgoing payload — so the plugin-mode
            // claim serializes behind tool registration instead of racing it. For omp
            // the claim is the identity registration that runs INSIDE registerTools
            // (after the manifest fetch): a one-shot (`omp -p`) dispatches exactly ONE
            // request, and with fire-and-forget registration it left before the proxy
            // saw the conversation id — bound as an anonymous pfa session, rode proxy
            // mode forever, no round 2 to self-heal. registerTools is idempotent
            // (sid-cached, pending-deduped, retryAt-throttled), so the await is bounded
            // (worst case = manifest fetch + identity POST timeouts); a permanently
            // failing manifest fetch still degrades to wire mode.
            try {
                await registerTools(pi, ctx, state, agent);
            } catch (err) {
                logHostEvent("error", "[native-client]", `bili-plugin(${agent}): tool registration failed (${err instanceof Error ? err.message : String(err)}) — riding wire mode for this request`);
            }
            if (agent === "omp") {
                // #1531: awaited so the report lands BEFORE this request's
                // window resolution runs server-side; never throws (soft-fail).
                try {
                    await reportOmpRuntimeInfo(ctx);
                } catch (err) {
                    logHostEvent("error", "[native-client]", `bili-plugin(omp): runtime-info report failed (${err instanceof Error ? err.message : String(err)}) — riding legacy window resolution`);
                }
            }
            // #2399 stage 2: adoption must win the race with the child's first
            // stamped request (which would create the conversation and close
            // the window), so it rides the same awaited pre-send slot — after
            // registerTools (plugin claim) but before the payload returns.
            try {
                await maybeAdoptForkChild(event, ctx);
            } catch (err) {
                logHostEvent("error", "[native-client]", `bili-plugin(${agent}): fork adoption failed (${err instanceof Error ? err.message : String(err)}) — starting the session fresh (#2399)`);
            }
            // #3248 incremental turns: pi only (the divert needs the
            // x-bili-plugin marker this extension stamps in
            // before_provider_headers — omp never fires that hook). Replaces
            // the full-resend payload with the delta; skips prompt-cache-key
            // stamping when it does (the lane owns cache stability through
            // the server-side canonical).
            if (agent === "pi") {
                try {
                    const replaced = await maybeIncrementalTurn(event, ctx);
                    if (replaced !== undefined) return replaced;
                } catch (err) {
                    logHostEvent("error", "[native-client]", `bili-plugin(${agent}): incremental turn skipped (${err instanceof Error ? err.message : String(err)}) — full resend this turn`);
                }
            }
            return stampPromptCacheKey(event, ctx, agent);
        });
        // #3248 incremental turns: the ack channel. after_provider_response
        // fires with status + headers BEFORE the stream is consumed, so the
        // x-bili-applied-seq header is readable here. 200 → record the ack
        // (the server seq is the only sinceSeq authority); 409 → sticky
        // per-conversation fallback (seed always resyncs, so a delta 409 means
        // genuine drift pi's own retry loop cannot repair); 503 → drop the
        // probe cache so the next turn re-probes (rollout flag or sidecar
        // liveness changed on the lane).
        pi.on("after_provider_response", ((event: unknown, ctx: Ctx) => {
            try {
                const sid = sessionIdOf(ctx);
                if (sid === undefined || sid.length === 0) return;
                const pending = pendingIncrementalAcks.get(sid);
                if (pending === undefined) return;
                const status = (event as { status?: unknown }).status;
                const headers = (event as { headers?: Record<string, unknown> }).headers;
                const seq = headers?.["x-bili-applied-seq"];
                if (status === 200 && !(typeof seq === "string" && /^\d+$/.test(seq))) {
                    // 200 without an ack header CANNOT be the marker'd response —
                    // the lane stamps x-bili-applied-seq on every diverted
                    // response that reaches the forward (incremental-lane.ts
                    // writeHead wrap). It is a concurrent full-resend response
                    // for this conversation: keep the pending entry for the
                    // marker'd response still in flight.
                    return;
                }
                pendingIncrementalAcks.delete(sid);
                piIncrementalOriginals.delete(sid); // #3304: turn settled — original no longer needed
                if (status === 200) {
                    noteIncrementalAck(sid, Number(seq), pending.messages, pending.system);
                    return;
                }
                if (status === 409) {
                    // #3369: one 409 resets the conversation state — the next
                    // turn re-seeds with resync:true (never 409s) instead of
                    // permanently downgrading to full resend. Only a streak of
                    // consecutive 409s (no ack between) trips the sticky kill.
                    const verdict = noteIncrementalRejection(sid);
                    logHostEvent("warn", "[native-client]", `bili-plugin(${agent}): incremental turn rejected (seq drift) for ${sid} — ${verdict === "dead" ? "sticky fallback to full resend (rejection circuit)" : "re-seeding with a full resync next turn"} (#3369)`);
                    return;
                }
                if (status === 503) {
                    // #3369: 503 means the lane is temporarily unavailable
                    // (sidecar boot / rollout flip) — the conversation's ack
                    // state is still valid, so do NOT kill it. Just drop the
                    // probe cache; the next turn re-probes and resumes.
                    clearIncrementalProbe(pending.base);
                    logHostEvent("warn", "[native-client]", `bili-plugin(${agent}): incremental turns unavailable on the lane — re-probing next turn (conversation state preserved, #3369)`);
                }
            } catch (err) {
                logHostEvent("error", "[native-client]", `bili-plugin(${agent}): incremental ack handling failed (${err instanceof Error ? err.message : String(err)})`);
            }
        }) as unknown as (...args: unknown[]) => void);
        pi.on("session_start", (_event, ctx) => {
            if (!agentProvidersDone) {
                agentProvidersDone = true;
                reportAgentProviders(ctx, agent).then((done) => {
                    if (done) return;
                    // Proxy base not resolvable yet — retry on the next session.
                    agentProvidersDone = false;
                }).catch((err: unknown) => {
                    agentProvidersDone = false;
                    logHostEvent("warn", "[native-client]", `bili-plugin(${agent}): agent-providers report failed (${err instanceof Error ? err.message : String(err)}) — bili-side provider references to host models stay unresolved`);
                });
            }
            if (agent === "pi") {
                const regReason = selfRegisterForSession(subagentReg, {
                    env: process.env,
                    agent,
                    sessionId: sessionIdOf(ctx),
                    filePath: entryFile,
                    log: (m) => logHostEvent("warn", "[native-client]", `bili-plugin(pi): ${m}`),
                });
                if (regReason !== "registered" && regReason !== "registered-already") {
                    logHostEvent("warn", "[native-client]", `bili-plugin(pi): subagent self-registration skipped (${regReason})`);
                }
            }
            state.sid = undefined;
            // #4988: a new session has no pre-navigation observation yet.
            state.observedActiveBili = undefined;
            // #1586 review: session_start captures its ctx for the whole
            // session — never suspend across it here. One-shot flows replace
            // the session inside async windows, so an awaited native-origin
            // resolution would resume on stale refs and pi throws "ctx is
            // stale" into our catch → stderr noise (e2e-native-pi gate). The
            // per-event handlers below get a fresh ctx each time and are the
            // ones that await the origin (#1243 pattern); launcher mode is
            // unaffected (its base resolves synchronously).
            void registerTools(pi, ctx, state, agent, false).catch((err: unknown) => logHostEvent("error", "[native-client]", `bili-plugin(${agent}): ${err instanceof Error ? err.message : String(err)}`));
            // #2322: a resumed session may carry a name without ever firing
            // session_info_changed (nothing changed) — stamp the current
            // value once per session start so the proxy label follows it.
            if (typeof pi.getSessionName === "function") {
                try {
                    const n = pi.getSessionName();
                    if (typeof n === "string" && n.length > 0) reportSessionName(ctx, n);
                } catch {
                    // optional host API — ignore
                }
            }
        });
        // #2185: drop our required-child-extension entry when this session's
        // extension runtime tears down (quit/reload/new/resume/fork).
        pi.on("session_shutdown", () => {
            disposeSubagentSelfReg(subagentReg);
        });
        // #4988: session_before_tree fires inside navigateTree BEFORE the leaf
        // switch and the loadout reset — sample our tools' pre-navigation
        // activity there so the re-assert below can tell a rewind-dropped tool
        // apart from one deliberately kept off by an external loadout manager.
        pi.on("session_before_tree", () => sampleActiveBili(pi, state));
        // #3542: a /tree rewind resets the active loadout from the transcript —
        // re-assert ours right after the reset (see reassertLoadoutAfterTree).
        pi.on("session_tree", () => reassertLoadoutAfterTree(pi, state, agent));
        // omp fires session_compact on in-session native compaction (sid does
        // not rotate), so the proxy reuses stale state — notify it to archive
        // the now-unreachable blocks (#395). Fire-and-forget: a failed
        // notification must never break the agent's compaction.
        pi.on("session_compact", (_event, ctx) => {
            const proxyBase = proxyBaseForCtx(ctx);
            if (proxyBase === undefined) return;
            const sid = sessionIdOf(ctx);
            if (sid === undefined || sid.length === 0) return;
            fetch(`${proxyBase}/__bili/plugin/compact`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ conversationId: sid }),
                signal: AbortSignal.timeout(5000),
            }).catch(() => {});
        });
        // #2322: follow the host session name. The event carries the
        // authoritative value (name: undefined = cleared) and fires on
        // rename — no need to wait for the next model request.
        pi.on("session_info_changed", (event, ctx) => {
            const name = (event as { name?: unknown }).name;
            reportSessionName(ctx, typeof name === "string" ? name : "");
        });
        // #2186: acp_delegate surface for the pi lane, inlined from
        // billion-context-pi-subagents. omp never reaches the wiring (the
        // gate repeats inside) and a previously claimed surface stands down.
        wirePiSubagents(pi, agent);
    };
}

export default createBiliPlugin();

export { fetchStatus };
