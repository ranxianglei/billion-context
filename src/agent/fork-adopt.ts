import { createHash } from "node:crypto";
import { openaiToCore, anthropicToCore, detectWireFormat } from "acp-kernel/wire";
import type { CoreMessage } from "acp-kernel";
import { stripAcpPanelMessages, stripAcpPanelResponsesInput, stripAcpStatusMarkers } from "../acp-panel.js";
import { stripEmbeddedChainCarriers } from "../chain-checkpoint.js";
import { responsesToCoreWithToolImages } from "../responses-tool-output.js";
import { hashId } from "../util.js";
import { ACP_NAME_ALT } from "../loop/tag-echo-filter.js";

/**
 * Agent-side fork adoption (#2399): a host extension reads its session header
 * (parent lineage marker — dsh stamps parentSession+isSeeded, pi/omp stamp
 * parentSession alone, opencode V2 derives it from session.created), and
 * before a fork child's first model request replays into the proxy, adopts
 * the parent conversation's compression state through the plugin fork
 * protocol (PLUGIN.md §8). This module is the client half: it projects the
 * outgoing body (openai/anthropic/responses dialects) the same way the
 * server's incomingCoreMessages does, matches the longest parent prefix by
 * identity hash, and posts the fork receipt. The google wire has no
 * client-side projection yet and is gated off BEFORE any network request
 * (#2469).
 *
 * HASH PARITY CONTRACT: forkStableJson/forkIdentityHashOf/forkOrderHashOf
 * below are byte-for-byte replicas of src/plugin.ts stableJson/
 * forkMessageIdentityHash/forkOrderHash. The server's publicForkInputMatches
 * rejects the child's first request (409 FORK_PREFIX_CONFLICT) when the
 * replayed prefix does not hash-match the receipt, so any drift here poisons
 * the child conversation permanently. The parity is pinned by
 * tests/dsh-fork-adopt.test.ts against the exported plugin.ts hash.
 *
 * RESPONSES PIPELINE PARITY CONTRACT: the forkResponses* functions below are
 * byte-for-byte replicas of the server's responses pre-projection pipeline
 * (src/loop/adapter-responses.ts type-stamp/id-sanitize/whitespace-drop +
 * src/codex-compact.ts compaction-echo replacement), applied in the exact
 * order prepareResponses applies them (#1853). They live here instead of
 * being imported because pulling src/loop into the agent bundle would drag
 * in the server request loop; tests/pi-omp-fork-adopt.test.ts pins the
 * replicas against the real incomingCoreMessages("responses", …) output.
 */

const SNAPSHOT_TIMEOUT_MS = 15_000;
const FORK_TIMEOUT_MS = 15_000;

// #2620: ref null = intentionally unaddressable prefix message (kernel-protected);
// matching and hashing are identity-based, so null flows through untouched.
export type ForkIdentity = { rawId: string; ref: string | null; identityHash: string };

type SnapshotResponse = {
    ok?: boolean;
    protocolVersion?: number;
    status?: string;
    sessionId?: string;
    parentRevision?: string;
    orderHash?: string;
    orderedMessages?: ForkIdentity[];
};

type ForkAdoptionResult =
    | { outcome: "adopted"; branchPoint: number; replayed: boolean }
    | { outcome: "degraded"; reason: string };

function forkStableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(forkStableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${forkStableJson(obj[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function forkHash(value: unknown): string {
    return createHash("sha256").update(forkStableJson(value), "utf8").digest("hex");
}

/** Byte-identical to src/plugin.ts forkMessageIdentityHash. */
export function forkIdentityHashOf(message: CoreMessage): string {
    const toolIsError = (message as CoreMessage & { toolIsError?: boolean }).toolIsError === true;
    return forkHash([message.role, message.contentType, message.text ?? null, message.toolName ?? null, message.toolCallId ?? null, message.thinkingTokens ?? null, message.summaryOfBlockId ?? null, toolIsError]);
}

/** Byte-identical to src/plugin.ts forkOrderHash (plain JSON.stringify over
 *  the identity array as received — snapshot identities arrive with the
 *  server's literal key order rawId, ref, identityHash, so re-serialization
 *  reproduces it). */
export function forkOrderHashOf(messages: ForkIdentity[]): string {
    return createHash("sha256").update(JSON.stringify(messages), "utf8").digest("hex");
}

/** Project an outgoing OpenAI chat body to CoreMessages exactly the way the
 *  server's incomingCoreMessages openai branch does (src/fork-adoption.ts):
 *  clone → strip bili panel echoes → strip ACP status markers → openaiToCore.
 *  The leading system/developer prefix is hoisted out by openaiToCore on both
 *  sides, so projections align 1:1 with the parent snapshot. Returns null for
 *  bodies that do not carry a messages array. */
export function openaiBodyToCore(body: unknown): CoreMessage[] | null {
    if (body === null || typeof body !== "object") return null;
    try {
        const clone = structuredClone(body) as Record<string, unknown>;
        if (!Array.isArray(clone.messages)) return null;
        stripAcpPanelMessages(clone.messages);
        stripAcpStatusMarkers(clone.messages);
        return openaiToCore(clone as Parameters<typeof openaiToCore>[0]).msgs;
    } catch {
        return null;
    }
}

/** Project an outgoing Anthropic body the same way (#2399 stage 2: pi/omp
 *  can talk Anthropic wire). Mirrors the server's incomingCoreMessages
 *  anthropic branch: clone → strip panel echoes → strip status markers →
 *  anthropicToCore. Returns null when the body carries no messages array. */
export function anthropicBodyToCore(body: unknown): CoreMessage[] | null {
    if (body === null || typeof body !== "object") return null;
    try {
        const clone = structuredClone(body) as Record<string, unknown>;
        if (!Array.isArray(clone.messages)) return null;
        stripAcpPanelMessages(clone.messages);
        stripAcpStatusMarkers(clone.messages);
        return anthropicToCore(clone as Parameters<typeof anthropicToCore>[0]).msgs;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Responses-dialect pre-projection pipeline — byte-for-byte replicas of the
// server's ingress mutations (src/loop/adapter-responses.ts +
// src/codex-compact.ts), kept out-of-graph so the agent bundle never pulls
// the server request loop. Parity pinned by tests/pi-omp-fork-adopt.test.ts.
// ---------------------------------------------------------------------------

const FORK_RESPONSES_ITEM_ID_MAX = 64;
const FORK_PROXY_MESSAGE_ID_PREFIX = "msg-proxy-";
const FORK_LEGACY_MARKER_MESSAGE_ID_PREFIX = "marker-";
const FORK_CODEX_COMPACT_ID_PREFIX = "fc_bili_";
const FORK_CODEX_COMPACT_SENTINEL = "bili:acp:";
const FORK_CODEX_FORGED_HANDOFF_HEADER = "[bili] context summary after compaction:";
const FORK_RENDER_TAG_RE = new RegExp("\x3c" + ACP_NAME_ALT + "\\s[^\x3e]*\x3e[^\x3c]*\x3c\\/" + ACP_NAME_ALT + "\x3e|\x3c" + ACP_NAME_ALT + "\\s[^\x3e]*\\/\x3e", "g");

function forkStripRenderTags(text: string): string {
    return text.replace(FORK_RENDER_TAG_RE, "");
}

function forkIsBiliMessageId(id: unknown): id is string {
    return typeof id === "string"
        && (id.startsWith(FORK_PROXY_MESSAGE_ID_PREFIX) || id.startsWith(FORK_LEGACY_MARKER_MESSAGE_ID_PREFIX));
}

/** Byte-for-byte replica of adapter-responses normalizeResponsesMessageItems. */
function forkNormalizeResponsesMessageItems(input: unknown): number {
    if (!Array.isArray(input)) return 0;
    let typed = 0;
    for (const item of input) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        if (rec["type"] !== undefined) continue;
        if (rec["role"] !== "user" && rec["role"] !== "assistant") continue;
        if (rec["content"] === undefined) continue;
        // omp (pi-ai) sends user items without the spec-required "type" field;
        // responsesToCore switches on item.type and silently drops type-less
        // items, so user prompts never enter the kernel (no refs, never
        // compressible, invisible to nudge/preflight). Stamp the standard
        // type at ingress.
        rec["type"] = "message";
        typed++;
    }
    return typed;
}

/** Byte-for-byte replica of adapter-responses sanitizeResponsesInputIds (#242). */
function forkSanitizeResponsesInputIds(input: unknown): void {
    if (!Array.isArray(input)) return;
    for (const item of input) {
        const rec = item as Record<string, unknown>;
        // Client-visible proxy ids are not upstream item identities; replay the full message instead.
        if (rec?.type === "message" && rec.role === "assistant"
            && forkIsBiliMessageId(rec.id)
            && (typeof rec.content === "string" || Array.isArray(rec.content))) {
            delete rec.id;
            continue;
        }
        if (typeof rec?.id === "string" && rec.id.startsWith(FORK_PROXY_MESSAGE_ID_PREFIX)
            && rec.id.length > FORK_RESPONSES_ITEM_ID_MAX) {
            rec.id = `msg-fix-${hashId(rec.id)}`;
        }
    }
}

/** Byte-for-byte replica of adapter-responses dropWhitespaceResponsesMessages. */
function forkDropWhitespaceResponsesMessages(input: unknown): number {
    if (!Array.isArray(input)) return 0;
    let dropped = 0;
    for (let i = input.length - 1; i >= 0; i--) {
        const rec = input[i] as Record<string, unknown>;
        if (rec === null || typeof rec !== "object") continue;
        const type = rec.type;
        // message items carry type "message"; omp's user items omit the field
        // entirely (role + content only) — treat those as messages too.
        if (type !== "message" && type !== undefined) continue;
        const role = rec.role;
        if (role !== "user" && role !== "assistant") continue;
        const content = rec.content;
        let text: string | undefined;
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
            let mixed = false;
            let joined = "";
            for (const part of content) {
                const p = part as Record<string, unknown>;
                // Malformed parts (non-objects) make emptiness unknowable —
                // treat as mixed and preserve the item.
                if (p === null || typeof p !== "object") {
                    mixed = true;
                    break;
                }
                const pt = p.type;
                if (pt !== undefined && pt !== "input_text" && pt !== "output_text" && pt !== "text") {
                    mixed = true;
                    break;
                }
                if (typeof p.text === "string") joined += p.text;
            }
            if (!mixed) text = joined;
        }
        // Replay stickiness: an originally-whitespace message comes back on
        // every later request carrying the render tag a previous turn
        // stamped onto it (tag + whitespace, still semantically empty). A
        // tag wrapping a real ref over real content keeps the message alive;
        // only tag-over-nothing is droppable.
        if (text !== undefined && forkStripRenderTags(text).trim() === "") {
            input.splice(i, 1);
            dropped++;
        }
    }
    return dropped;
}

/** Byte-for-byte replica of codex-compact isBiliCompactionItem. */
function forkIsBiliCompactionItem(item: unknown): boolean {
    const it = item as { type?: unknown; id?: unknown; encrypted_content?: unknown } | null;
    if (!it || it.type !== "compaction") return false;
    if (typeof it.id === "string" && it.id.startsWith(FORK_CODEX_COMPACT_ID_PREFIX)) return true;
    if (typeof it.encrypted_content === "string" && it.encrypted_content.startsWith(FORK_CODEX_COMPACT_SENTINEL)) return true;
    return false;
}

/** Byte-for-byte replica of codex-compact extractBiliSummary. */
function forkExtractBiliSummary(item: unknown): string | undefined {
    const it = item as { encrypted_content?: unknown } | null;
    if (!it || typeof it.encrypted_content !== "string") return undefined;
    if (!it.encrypted_content.startsWith(FORK_CODEX_COMPACT_SENTINEL)) return undefined;
    const text = it.encrypted_content.slice(FORK_CODEX_COMPACT_SENTINEL.length);
    return text.length > 0 ? text : undefined;
}

/** Byte-for-byte replica of codex-compact replaceBiliCompactionItems. An
 *  echoed fc_bili_ compaction item is REPLACED (in place) by a plain user
 *  message carrying the extracted summary — a history-borne handoff the
 *  kernel can fold again. Marker items without an extractable blob are
 *  dropped; non-compaction items pass through untouched. */
function forkReplaceBiliCompactionItems<T>(input: T[]): { items: T[]; replaced: number; dropped: number } {
    const items: T[] = [];
    let replaced = 0;
    let dropped = 0;
    for (const item of input) {
        if (!forkIsBiliCompactionItem(item)) { items.push(item); continue; }
        const summary = forkExtractBiliSummary(item);
        if (summary === undefined) { dropped++; continue; }
        items.push({ type: "message", role: "user", content: [{ type: "input_text", text: `${FORK_CODEX_FORGED_HANDOFF_HEADER}\n${summary}` }] } as T);
        replaced++;
    }
    return { items, replaced, dropped };
}

/** Project an outgoing Responses body the same way (#2469 stage 2: pi on
 *  codex-class providers talks the responses wire). Mirrors the server's
 *  incomingCoreMessages responses branch IN ORDER: compaction-echo
 *  replacement → type stamping → id sanitize → whitespace drop → panel/marker
 *  strip → chain-carrier strip → responsesToCoreWithToolImages. Returns null
 *  when the body carries no input array. */
export function responsesBodyToCore(body: unknown): CoreMessage[] | null {
    if (body === null || typeof body !== "object") return null;
    try {
        const clone = structuredClone(body) as Record<string, unknown>;
        if (!Array.isArray(clone.input)) return null;
        const { items, replaced, dropped } = forkReplaceBiliCompactionItems(clone.input);
        if (replaced + dropped > 0) clone.input = items;
        forkNormalizeResponsesMessageItems(clone.input);
        forkSanitizeResponsesInputIds(clone.input);
        forkDropWhitespaceResponsesMessages(clone.input);
        stripAcpPanelResponsesInput(clone.input);
        stripAcpStatusMarkers(clone.input);
        stripEmbeddedChainCarriers(clone, "responses");
        return responsesToCoreWithToolImages(clone as Parameters<typeof responsesToCoreWithToolImages>[0]).msgs;
    } catch {
        return null;
    }
}

/** Project an outgoing body of any supported dialect. Google bodies return
 *  null — that wire is not projected client-side yet; the wire gate (#2469,
 *  see tryForkAdoption / createForkAdopter) ends adoption terminally BEFORE
 *  any network request for it, so this null is defense in depth for direct
 *  callers, not a retryable condition. */
export function chatBodyToCore(body: unknown): CoreMessage[] | null {
    const format = detectWireFormat(body);
    if (format === "anthropic") return anthropicBodyToCore(body);
    if (format === "responses") return responsesBodyToCore(body);
    if (format === undefined || format === "openai") return openaiBodyToCore(body);
    return null;
}

/** Longest prefix of `core` whose identity hashes equal the snapshot's, in
 *  order. 0 means the child body shares nothing with the parent — sending a
 *  fork would poison the child id, so the caller degrades instead. */
export function matchForkPrefix(core: CoreMessage[], identities: ForkIdentity[]): number {
    let n = 0;
    while (n < core.length && n < identities.length && forkIdentityHashOf(core[n]!) === identities[n]!.identityHash) n += 1;
    return n;
}

function snapshotOf(raw: unknown): { parentRevision: string; orderHash: string; orderedMessages: ForkIdentity[] } | null {
    if (raw === null || typeof raw !== "object") return null;
    const snap = raw as SnapshotResponse;
    if (typeof snap.parentRevision !== "string" || typeof snap.orderHash !== "string" || !Array.isArray(snap.orderedMessages)) return null;
    for (const identity of snap.orderedMessages) {
        if (identity === null || typeof identity !== "object" || typeof identity.rawId !== "string" || (identity.ref !== null && typeof identity.ref !== "string") || typeof identity.identityHash !== "string") return null;
    }
    return { parentRevision: snap.parentRevision, orderHash: snap.orderHash, orderedMessages: snap.orderedMessages };
}

// #2469: error bodies are read BOUNDED — a hostile or misconfigured upstream
// can stream an unbounded body on a 4xx, and adoption must degrade with the
// diagnostics it actually needs (code + a short error), never hang or buffer.
const ERROR_BODY_MAX_BYTES = 1024;
const ERROR_FIELD_MAX_CHARS = 120;

function sanitizeDiagnostic(value: string): string {
    const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    return cleaned.length > ERROR_FIELD_MAX_CHARS ? `${cleaned.slice(0, ERROR_FIELD_MAX_CHARS - 1)}…` : cleaned;
}

/** Read at most ERROR_BODY_MAX_BYTES of an error response and extract the
 *  proxy's `{ code, error }` fields, sanitized (control characters stripped,
 *  whitespace collapsed, length-capped). Non-JSON / oversized / truncated
 *  bodies yield empty fields — callers fall back to the status-only reason. */
async function readBoundedErrorBody(res: Response): Promise<{ code: string; error: string }> {
    try {
        const body = res.body;
        if (body === null) return { code: "", error: "" };
        const reader = body.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done || value === undefined) break;
            const room = ERROR_BODY_MAX_BYTES - size;
            if (room <= 0) break;
            const chunk = value.byteLength <= room ? value : value.subarray(0, room);
            parts.push(chunk);
            size += chunk.byteLength;
            if (size >= ERROR_BODY_MAX_BYTES) {
                void reader.cancel().catch(() => undefined);
                break;
            }
        }
        const joined = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
            joined.set(part, offset);
            offset += part.byteLength;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(new TextDecoder("utf-8").decode(joined));
        } catch {
            return { code: "", error: "" };
        }
        if (parsed === null || typeof parsed !== "object") return { code: "", error: "" };
        const rec = parsed as Record<string, unknown>;
        return {
            code: typeof rec.code === "string" ? sanitizeDiagnostic(rec.code) : "",
            error: typeof rec.error === "string" ? sanitizeDiagnostic(rec.error) : "",
        };
    } catch {
        return { code: "", error: "" };
    }
}

/**
 * GET parent snapshot → match longest prefix → POST fork receipt. Every
 * failure path returns { outcome: "degraded" } — the child then simply starts
 * a fresh conversation, exactly today's behavior; adoption is best effort.
 * A 409 PARENT_REVISION_CONFLICT (parent mutated between snapshot and fork)
 * is retried once with a fresh snapshot before degrading.
 */
export async function tryForkAdoption(opts: {
    base: string;
    parentConversationId: string;
    childConversationId: string;
    body: unknown;
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
}): Promise<ForkAdoptionResult> {
    const doFetch = opts.fetchImpl ?? fetch;
    // #2469: deterministic protocol mismatch ends adoption BEFORE any network
    // request — retrying can never grow the client's projection capability.
    // Only the google wire lacks a client-side projection today; responses is
    // projected above with pinned parity (#2469 stage 2).
    const wire = detectWireFormat(opts.body);
    if (wire === "google") {
        return { outcome: "degraded", reason: `wire unsupported (${wire})` };
    }
    const core = chatBodyToCore(opts.body);
    if (core === null || core.length === 0) return { outcome: "degraded", reason: "body unmappable" };
    const snapshotUrl = `${opts.base}/__bili/plugin/snapshot?conversationId=${encodeURIComponent(opts.parentConversationId)}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let snapshot: Awaited<ReturnType<typeof snapshotOf>>;
        try {
            const res = await doFetch(snapshotUrl, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
            if (!res.ok) {
                // #2469: surface the proxy's bounded diagnostics (e.g. 409
                // SNAPSHOT_UNAVAILABLE + why) instead of hiding them behind a
                // bare status code.
                const detail = await readBoundedErrorBody(res);
                return { outcome: "degraded", reason: `snapshot http ${res.status}${detail.code ? ` ${detail.code}` : ""}${detail.error ? ` (${detail.error})` : ""}` };
            }
            snapshot = snapshotOf(await res.json());
        } catch (err) {
            return { outcome: "degraded", reason: `snapshot error ${err instanceof Error ? err.message : String(err)}` };
        }
        if (snapshot === null) return { outcome: "degraded", reason: "snapshot malformed" };
        const branchPoint = matchForkPrefix(core, snapshot.orderedMessages);
        if (branchPoint === 0) return { outcome: "degraded", reason: "no prefix match" };
        const prefix = snapshot.orderedMessages.slice(0, branchPoint);
        const orderHash = branchPoint === snapshot.orderedMessages.length ? snapshot.orderHash : forkOrderHashOf(prefix);
        const payload = {
            protocolVersion: 1,
            parentConversationId: opts.parentConversationId,
            childConversationId: opts.childConversationId,
            parentRevision: snapshot.parentRevision,
            branchPoint: { messageCount: branchPoint, orderHash },
            orderedMessages: prefix,
            idempotencyKey: `fork:${opts.childConversationId}`,
        };
        let res: Response;
        try {
            res = await doFetch(`${opts.base}/__bili/plugin/fork`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(FORK_TIMEOUT_MS),
            });
        } catch (err) {
            return { outcome: "degraded", reason: `fork error ${err instanceof Error ? err.message : String(err)}` };
        }
        if (res.status === 201 || res.status === 200) {
            let replayed = false;
            try {
                const parsed = await res.json() as { replayed?: unknown };
                replayed = parsed.replayed === true;
            } catch {
                replayed = false;
            }
            opts.log?.(`fork child ${opts.childConversationId} adopted parent ${opts.parentConversationId} at branch point ${branchPoint}${replayed ? " (replayed)" : ""} (#2399)`);
            return { outcome: "adopted", branchPoint, replayed };
        }
        const code = (await readBoundedErrorBody(res)).code;
        if (res.status === 409 && code === "PARENT_REVISION_CONFLICT" && attempt === 0) {
            opts.log?.(`fork for ${opts.childConversationId} hit parent revision conflict, retrying once with a fresh snapshot (#2399)`);
            continue;
        }
        return { outcome: "degraded", reason: `fork http ${res.status}${code ? ` ${code}` : ""}` };
    }
    return { outcome: "degraded", reason: "parent revision conflict retry exhausted" };
}

const forkCapabilityCache = new Map<string, boolean>();

export function resetForkCapabilityCacheForTest(): void {
    forkCapabilityCache.clear();
}

/** Old proxies have no fork endpoints at all; probing manifest keeps adoption
 *  off their request path (and avoids harmless 404 noise). Cached per base —
 *  register.base changes when the extension re-registers with a new proxy. */
export async function manifestForkCapable(base: string, fetchImpl?: typeof fetch): Promise<boolean> {
    const cached = forkCapabilityCache.get(base);
    if (cached !== undefined) return cached;
    const doFetch = fetchImpl ?? fetch;
    try {
        const res = await doFetch(`${base}/__bili/plugin/manifest`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return false;
        const manifest = await res.json() as { capabilities?: { fork?: { protocolVersion?: unknown } } };
        const capable = manifest.capabilities?.fork?.protocolVersion === 1;
        forkCapabilityCache.set(base, capable);
        return capable;
    } catch {
        return false;
    }
}

export type ForkAdoptInput = { base: string; parent: string; child: string; body: unknown };

/** Per-host fork-adoption coordinator (#2399 stage 2): absorbs the bookkeeping
 *  every host needs (done/attempts/single-flight keyed by child id, the
 *  manifest capability gate, wire gating). Semantics carried over from the
 *  stage-1 dsh wiring:
 *  - the adoption window is BEFORE the child's first model request — a later
 *    retry can only CHILD_CONFLICT, so every terminal outcome (adopted OR
 *    degraded) marks the child done;
 *  - bodies with no parseable payload (undefined — e.g. opencode V2's ws
 *    handshake synthetic request) and side-shaped bodies skip WITHOUT
 *    consuming an attempt; a deterministically unsupported wire
 *    (google — no client-side projection yet, #2469) terminates BEFORE any
 *    network request, including the manifest probe; a manifest-incapable
 *    proxy terminates after one probe;
 *  - never throws: an adoption failure degrades to today's behavior (the
 *    session continues without inherited compression state). */
/** Side-shaped request body: no tools AND a tiny output budget (host
 *  title-gen / auto-review sidecars). Mirrors the server-side side heuristic
 *  budget bound (#388: maxTokens <= 200). Exported for tests. */
export function sideShapedBody(body: unknown): boolean {
    if (body === null || typeof body !== "object") return false;
    const rec = body as Record<string, unknown>;
    if (Array.isArray(rec.tools) && rec.tools.length > 0) return false;
    const budget = typeof rec.max_tokens === "number" ? rec.max_tokens : typeof rec.max_completion_tokens === "number" ? rec.max_completion_tokens : undefined;
    return budget !== undefined && budget <= 200;
}

export function createForkAdopter(log: (line: string) => void, opts?: { maxAttempts?: number; fetchImpl?: typeof fetch }): { maybeAdopt(input: ForkAdoptInput | undefined): Promise<void> } {
    const maxAttempts = opts?.maxAttempts ?? 3;
    const done = new Set<string>();
    const attempts = new Map<string, number>();
    const inflight = new Map<string, Promise<void>>();
    const run = async (input: ForkAdoptInput): Promise<void> => {
        attempts.set(input.child, (attempts.get(input.child) ?? 0) + 1);
        // #2469: retrying can never grow the client's projection capability,
        // so an unsupported wire (google only — responses is projected with
        // pinned parity) ends this child's adoption before ANY network request
        // (manifest probe included). tryForkAdoption carries the same guard
        // for direct callers.
        const wire = detectWireFormat(input.body);
        if (wire === "google") {
            log(`fork adoption for ${input.child} skipped — ${wire} wire requests are not supported by public fork adoption yet; the child starts fresh (#2469/#2399)`);
            done.add(input.child);
            return;
        }
        if (!(await manifestForkCapable(input.base, opts?.fetchImpl))) {
            log(`fork adoption for ${input.child} skipped — the proxy does not advertise the fork capability (#2399)`);
            done.add(input.child);
            return;
        }
        const result = await tryForkAdoption({
            base: input.base,
            parentConversationId: input.parent,
            childConversationId: input.child,
            body: input.body,
            fetchImpl: opts?.fetchImpl,
            log,
        });
        if (result.outcome === "adopted") {
            done.add(input.child);
            return;
        }
        log(`fork adoption for ${input.child} degraded (${result.reason}) — the session continues without inherited compression state (#2399/#2469)`);
        // Only transient failures (network / 5xx / unmappable body) leave the
        // window open so a later request retries up to maxAttempts; every other
        // outcome is terminal. Once this child's stamped request has landed, a
        // retry can only ever meet CHILD_CONFLICT (the server registers the
        // child conversation before any later fork POST), which latches here as
        // a non-transient outcome (#2403 review).
        const transient = /^(snapshot|fork) (error|http 5\d\d)/.test(result.reason) || result.reason === "body unmappable";
        if (!transient || (attempts.get(input.child) ?? 0) >= maxAttempts) done.add(input.child);
    };
    return {
        async maybeAdopt(input): Promise<void> {
            if (input === undefined) return;
            if (input.parent === "" || input.child === "" || input.parent === input.child) return;
            if (input.base === "") return;
            // No parseable payload: nothing to match against the snapshot.
            // opencode V2's ws-handshake synthetic request (and any Request
            // whose body the host did not hand us) lands here — skipping
            // WITHOUT attempt bookkeeping keeps reconnects from burning the
            // 2399 retry budget before the first real model request (#2403 review).
            if (input.body === undefined) return;
            // #2399 spec gate ④: a side-shaped request (host title-gen / classify
            // sidecar — no tools + a tiny output budget) carries no replayed
            // prefix; matching it would N=0-degrade the child terminally before
            // the real first main turn can adopt. Skipped BEFORE any attempt
            // bookkeeping so it consumes no budget.
            if (sideShapedBody(input.body)) return;
            if (done.has(input.child)) return;
            if ((attempts.get(input.child) ?? 0) >= maxAttempts) return;
            const existing = inflight.get(input.child);
            if (existing !== undefined) {
                await existing.catch(() => undefined);
                return;
            }
            const flight = run(input).catch((err: unknown) => {
                log(`fork adoption for ${input.child} failed unexpectedly (${err instanceof Error ? err.message : String(err)}) (#2399)`);
                done.add(input.child);
            }).finally(() => {
                inflight.delete(input.child);
            });
            inflight.set(input.child, flight);
            await flight;
        },
    };
}
