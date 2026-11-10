import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { matchSession as matchSessionKernel, parseStoredPlaceholder, renderHandoff as renderHandoffKernel, renderMessage, type MessageContentStore, type CoreMessage } from "acp-kernel";
import type { Session } from "./session.js";
import { SessionStore } from "./persist.js";
import { SqliteBackend, backendSelectionNotice, listBackendNames, openBackend, resolveBackendName, resolveMysqlDsn, selectedBackendRaw, type StorageBackend } from "./storage/backend.js";
import { fileStorageBackend, fileStorageMysqlDsn } from "./knobs.js";
import { UnifiedStore } from "./storage/store.js";

interface ExportOptions {
    dir?: string;
    output?: string;
    full?: boolean;
    /** #2671 Phase 2c: render a deterministic JSONL dump (one record per
     * line) from the unified tables when the session is indexed, else from
     * the legacy tail. Generated artifact — never a source of truth. */
    jsonl?: boolean;
}

interface SessionSummary {
    id: string;
    title?: string;
    label?: string;
    protocol?: string;
    upstreamOrigin?: string;
    savedAt?: number;
    contextTokens?: number;
    blocks: number;
}

function fmtDate(ms: number | undefined): string {
    return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
}

export async function listSessions(opts: ExportOptions = {}): Promise<SessionSummary[]> {
    const store = new SessionStore({ dir: opts.dir, enabled: true });
    // One-shot store: the constructor opens index.db in unified modes, and
    // long-running callers (server exposure tick, web sessions index, plugin
    // lineage) would leak one SQLite connection per call and re-break the
    // Windows EPERM fix closeQuietly gave exportSession (#2690 review 4).
    try {
    // #2960 R2.1 fast path (full mode): serve summaries from one SQL over
    // the sessions table — no file parse, no Session hydration. Parity
    // contract: display title host_title ?? title; display time = latest
    // block created_at (0-block sessions sort last, savedAt undefined);
    // blocks = ALL blocks count.
    const fast = store.unifiedSessionSummaries();
    if (fast) {
        return fast
            .map((r) => ({
                id: r.sessionId,
                title: r.title,
                label: r.label,
                protocol: r.protocol,
                upstreamOrigin: r.origin,
                savedAt: r.latestBlockAt ?? undefined,
                contextTokens: r.contextTokens,
                blocks: r.blocks,
            }))
            .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    }
    const sessions = [...(await store.loadAll()).values()];
    sessions.sort((a, b) => latestBlockTime(b) - latestBlockTime(a));
    return sessions.map((s) => ({
        id: s.id,
        title: s.meta.hostTitle ?? s.meta.title,
        label: s.meta.label,
        protocol: s.meta.protocol,
        upstreamOrigin: s.meta.upstreamOrigin,
        savedAt: latestBlockTime(s) || undefined,
        contextTokens: s.stats.contextTokens,
        blocks: s.state.blocks.length,
    }));
    } finally {
        store.closeQuietly();
    }
}

function latestBlockTime(s: Session): number {
    let latest = 0;
    for (const b of s.state.blocks) if (b.createdAt > latest) latest = b.createdAt;
    return latest;
}

/** Ends the reasoning cell inside a single assistant block. `renderMessage`
 *  emits `_reasoning_: …` with no terminator, so without it the handoff
 *  renderer folds the answer that follows into the collapsed thinking box.
 *  An HTML comment keeps the marker invisible in rendered Markdown. */
export const HANDOFF_THINK_END = "<!-- /reasoning -->";

function handoffCells(messages: CoreMessage[]): CoreMessage[] {
    return messages.map((m) => m.contentType === "reasoning"
        ? { ...m, text: (m.text ?? "").split("\n").map((line, index) =>
            index > 0 && line.trim() === HANDOFF_THINK_END ? line + "\n" + line : line
        ).join("\n").trimEnd() + "\n" + HANDOFF_THINK_END }
        : m);
}

export function renderHandoff(s: Session, full: boolean): string {
    const response = s.metadata.handoffResponse as { request?: unknown; messages?: unknown } | undefined;
    const reply = response?.request === s.stats.requests && Array.isArray(response.messages) && response.messages.every((m): m is CoreMessage =>
        m !== null && typeof m === "object" && typeof m.id === "string" && m.role === "assistant"
        && ["text", "reasoning", "tool-call"].includes(m.contentType)
        && [m.text, m.toolName, m.toolCallId].every((value) => value === undefined || typeof value === "string")
    ) ? response.messages : [];
    const messages = s.lastMessages;
    // Keep one assistant turn in arrival order, with explicit reasoning boundaries.
    const latestReply = reply.length ? "\n### assistant\n\n" + handoffCells(reply).map(renderMessage).join("\n") + "\n" : "";
    if (messages && messages.length > 0) {
        const folded = s.lastMessagesFolded === true;
        const base = renderHandoffKernel({
            coreMessages: handoffCells(messages),
            state: s.state,
            full,
            folded,
            meta: {
                title: s.meta.hostTitle ?? s.meta.title,
                label: s.meta.label,
                sessionId: s.id,
                contextTokens: s.stats.contextTokens,
                extraBullets: [
                    ...(s.meta.protocol ? [`- protocol: ${s.meta.protocol}`] : []),
                    ...(s.meta.upstreamOrigin ? [`- upstream: ${s.meta.upstreamOrigin}`] : []),
                    `- requests: ${s.stats.requests}`,
                ],
            },
        });
        return base + latestReply + blockSummariesSection(s, full && folded, base);
    }

    // v2 fallback: no snapshot persisted. Block summaries (+ originals with
    // --full from the blockContents cache) are all that is recoverable offline.
    const lines: string[] = [];
    lines.push(`# billion-context session handoff`);
    lines.push("");
    lines.push(`- title: ${s.meta.hostTitle ?? s.meta.title ?? "(untitled)"}`);
    if (s.meta.label) lines.push(`- label: ${s.meta.label}`);
    lines.push(`- session id: ${s.id}`);
    if (s.meta.protocol) lines.push(`- protocol: ${s.meta.protocol}`);
    if (s.meta.upstreamOrigin) lines.push(`- upstream: ${s.meta.upstreamOrigin}`);
    lines.push(`- requests: ${s.stats.requests}`);
    if (s.stats.contextTokens) lines.push(`- last context tokens: ~${s.stats.contextTokens}`);
    lines.push(`- compression blocks: ${s.state.blocks.length} (active ${s.state.blocks.filter((b) => b.active).length})`);
    lines.push("");
    const active = s.state.blocks.filter((b) => b.active);
    if (active.length === 0) {
        lines.push(reply.length
            ? "No persisted request snapshot is available. Only the latest assistant response is included below."
            : "No active compression blocks and no persisted conversation snapshot (v2 session file). Original messages are only persisted when they are compressed into a block, so this session's conversation content is not available for export.");
        lines.push("");
    }
    for (const b of active) {
        lines.push(`## Block ${b.blockId}${b.topic ? ` — ${b.topic}` : ""}`);
        lines.push("");
        lines.push(`tier ${b.tier} · ~${b.compressedTokens} tokens compressed · ${fmtDate(b.createdAt)}`);
        lines.push("");
        lines.push(b.summary.trim());
        lines.push("");
        const content = s.blockContents.get(b.blockId);
        if (full && content) {
            lines.push(`### Original messages (${content.full.count})`);
            lines.push("");
            lines.push(content.full.text.trim());
            lines.push("");
        }
    }
    if (active.length > 0) {
        lines.push("---");
        lines.push("");
        lines.push("Paste the block summaries above into a new session to continue without the proxy.");
        lines.push("");
    }
    return lines.join("\n") + latestReply;
}

// #845: the kernel handoff never emits state.blocks[].summary, and the persisted
// snapshot keeps only the newest BILI_PERSIST_TAIL_TOKENS tail — a summary whose
// anchor fell outside that tail vanishes from the doc although it survives on
// disk in state.blocks[]. This section guarantees every active block's summary
// appears at least once. Originals attach only for folded snapshots — a
// non-folded --full export already contains every original message.
function blockSummariesSection(s: Session, includeOriginals: boolean, priorDoc: string): string {
    const active = s.state.blocks.filter((b) => b.active);
    if (active.length === 0) return "";
    const lines: string[] = [];
    lines.push(`## Compressed block summaries`);
    lines.push("");
    for (const b of active) {
        lines.push(`### Block ${b.blockId}${b.topic ? ` — ${b.topic}` : ""}`);
        lines.push("");
        lines.push(`tier ${b.tier} · ~${b.compressedTokens} tokens compressed · ${fmtDate(b.createdAt)}`);
        lines.push("");
        const summary = b.summary.trim();
        if (summary === "") {
            lines.push("_no summary recorded_");
        } else if (priorDoc.includes(summary)) {
            lines.push("_summary already shown in the conversation view above_");
        } else {
            lines.push(summary);
        }
        lines.push("");
        const content = includeOriginals ? s.blockContents.get(b.blockId) : undefined;
        if (content) {
            lines.push(`#### Original messages (${content.full.count})`);
            lines.push("");
            lines.push(content.full.text.trim());
            lines.push("");
        }
    }
    return lines.join("\n");
}

function matchSession(sessions: Session[], selector: string): Session[] {
    return matchSessionKernel(sessions, selector, (s) => s.meta.label);
}

function safeJson(raw: string | null | undefined): unknown {
    if (!raw) return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

/** JSONL dump rendered from the unified tables (#2671 Phase 2c). One JSON
 * record per line: a session header, then messages ordered by seq (CCR
 * placeholders dereferenced to their stored originals when `full`; retired
 * rows included carrying `retiredAt`, live rows omit it — #4390/#4664), then
 * blocks ordered by ord, then dead refs. Deterministic for a given store
 * state; a generated artifact, never a source of truth. */
// #3931: consumes the StorageBackend contract (not UnifiedStore) — the
// jsonl renderer is the step-1 seam proof: it runs unchanged against the
// mysql backend once that lands.
export async function renderSessionJsonlFromTables(backend: StorageBackend, sessionId: string, full: boolean, extraCcr?: ReadonlyMap<string, string>): Promise<string> {
    const row = await backend.getSessionRow(sessionId);
    if (!row) throw new Error(`session ${sessionId} is not in the unified index`);
    const lines: string[] = [];
    lines.push(
        JSON.stringify({
            type: "session",
            v: 1,
            source: "unified",
            sessionId: row.sessionId,
            ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
            ...(row.forkPointSeq != null ? { forkPointSeq: row.forkPointSeq } : {}),
            ...(row.protocol ? { protocol: row.protocol } : {}),
            ...(row.label ? { label: row.label } : {}),
            ...(row.title ? { title: row.title } : {}),
            ...(row.hostTitle ? { hostTitle: row.hostTitle } : {}),
            status: row.status,
            createdAt: row.createdAt,
            lastSeen: row.updatedAt,
            stats: safeJson(row.statsJson),
            tail: safeJson(row.tailJson),
        }),
    );
    // Index entries first (fork receipts carry them); the on-disk content
    // store fills the gaps for normal sessions — the record itself omits the
    // store by design (multi-MB rewrite cost, see session.ts contentStore).
    const ccr = new Map((await backend.getCcrEntries(sessionId)).map((e) => [e.key, e.content] as const));
    if (extraCcr) for (const [k, v] of extraCcr) if (!ccr.has(k)) ccr.set(k, v);
    // #4664: historian read — include retired (tombstoned) rows so a rewound
    // session exports its full history; live rows omit `retiredAt`.
    for (const m of await backend.getMessages(sessionId, { includeRetired: true })) {
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(m.content) as Record<string, unknown>;
        } catch {
            message = { raw: m.content };
        }
        if (full && typeof message.text === "string") {
            const ph = parseStoredPlaceholder(message.text);
            const payload = ph ? ccr.get(ph.ref) : undefined;
            if (payload !== undefined) message = { ...message, text: payload, dereferencedFrom: ph!.ref };
        }
        lines.push(JSON.stringify({ type: "message", seq: m.seq, rawId: m.msgId, ref: m.ref, refNum: m.refNum ?? undefined, role: m.role, kind: m.kind ?? undefined, ...(m.retiredAt != null ? { retiredAt: m.retiredAt } : {}), message }));
    }
    for (const b of await backend.getBlocks(sessionId)) {
        lines.push(
            JSON.stringify({
                type: "block",
                ord: b.ord,
                blockId: b.blockId,
                tier: b.tier,
                startSeq: b.startSeq,
                endSeq: b.endSeq,
                startRef: b.startRef,
                endRef: b.endRef,
                active: b.active,
                createdAt: b.createdAt,
                ...(b.supersedesBlockId ? { supersedesBlockId: b.supersedesBlockId } : {}),
                summary: safeJson(b.summary),
                one: safeJson(b.one),
            }),
        );
    }
    const dead = await backend.getDeadRefs(sessionId);
    if (dead.length > 0) lines.push(JSON.stringify({ type: "deadRefs", refs: dead.map((d) => ({ ref: d.ref, refNum: d.refNum, recordedAt: d.recordedAt })) }));
    return `${lines.join("\n")}\n`;
}

/** JSONL fallback when no unified index exists: the legacy record's tail
 * snapshot + block summaries + CCR store. The header says so. */
export function renderSessionJsonlFromSession(s: Session, full: boolean, contentStore?: MessageContentStore | null): string {
    const lines: string[] = [];
    lines.push(
        JSON.stringify({
            type: "session",
            v: 1,
            source: "legacy-tail",
            sessionId: s.id,
            ...(s.meta.label ? { label: s.meta.label } : {}),
            ...(s.meta.hostTitle ?? s.meta.title ? { title: s.meta.hostTitle ?? s.meta.title } : {}),
            ...(s.meta.protocol ? { protocol: s.meta.protocol } : {}),
            createdAt: s.createdAt,
            lastSeen: s.lastSeen,
            stats: { requests: s.stats.requests, contextTokens: s.stats.contextTokens },
        }),
    );
    const store = contentStore ?? s.contentStore;
    const entryFor = (ref: string): string | undefined => {
        const entry = store?.byRef[ref];
        if (!entry) return undefined;
        return store.byHash[entry.hash];
    };
    for (const [i, m] of (s.lastMessages ?? []).entries()) {
        const message = m as unknown as Record<string, unknown>;
        let out = message;
        if (full && typeof message.text === "string") {
            const ph = parseStoredPlaceholder(message.text);
            const payload = ph ? entryFor(ph.ref) : undefined;
            if (payload !== undefined) out = { ...message, text: payload, dereferencedFrom: ph!.ref };
        }
        lines.push(JSON.stringify({ type: "message", seq: i, rawId: m.id, role: m.role, message: out }));
    }
    for (const [i, b] of s.state.blocks.entries()) {
        lines.push(
            JSON.stringify({
                type: "block",
                ord: i,
                blockId: b.blockId,
                tier: b.tier,
                startRef: b.startRef,
                endRef: b.endRef,
                active: b.active,
                createdAt: b.createdAt,
                summary: { text: b.summary, compressedTokens: b.compressedTokens, tier: b.tier },
            }),
        );
    }
    const dead = s.state.deadRefs ?? [];
    if (dead.length > 0) lines.push(JSON.stringify({ type: "deadRefs", refs: dead }));
    return `${lines.join("\n")}\n`;
}

export async function exportSession(selector: string | undefined, opts: ExportOptions = {}): Promise<string> {
    const store = new SessionStore({ dir: opts.dir, enabled: true });
    try {
    const all = [...(await store.loadAll()).values()];
    if (all.length === 0) {
        return "No persisted sessions found. Sessions are written under the sessions directory once the proxy has served a request (compression state, compressed originals, and a bounded folded-view snapshot of the recent conversation).";
    }
    if (!selector) {
        const list = await listSessions(opts);
        const rows = list.map((s) =>
            `${s.id}${s.label ? `  label=${s.label}` : ""}${s.protocol ? `  [${s.protocol}]` : ""}  blocks=${s.blocks}${s.contextTokens ? `  ctx~${s.contextTokens}` : ""}  ${s.title ?? ""}`
        );
        return ["Persisted sessions:", "", ...rows.map((r) => `  ${r}`), "", "Usage: bili export <session-id|label> [--output handoff.md] [--full]"].join("\n");
    }
    const matches = matchSession(all, selector);
    if (matches.length === 0) {
        throw new Error(`no session matches "${selector}" (run "bili export" to list sessions)`);
    }
    if (matches.length > 1) {
        const ids = matches.map((s) => s.id).join(", ");
        throw new Error(`selector "${selector}" matches ${matches.length} sessions (${ids}); use the full session id`);
    }
    if (opts.jsonl) {
        // Backend-aware open (#3388 step 2): storage.backend="mysql" + a DSN
        // exports straight from MySQL; everything else (and every fallback)
        // stays on the local sqlite index. A mysql failure degrades to the
        // legacy-tail renderer exactly like a corrupt index does.
        const backendName = resolveBackendName(process.env, fileStorageBackend());
        if (backendName === "mysql") {
            const dsn = resolveMysqlDsn(process.env, fileStorageMysqlDsn());
            if (dsn.length > 0) {
                try {
                    const backend = await openBackend("mysql", dsn);
                    try {
                        await backend.init?.();
                        if (await backend.getSessionRow(matches[0]!.id)) {
                            return await renderSessionJsonlFromTables(backend, matches[0]!.id, opts.full ?? false);
                        }
                    } finally {
                        await backend.close();
                    }
                } catch (err) {
                    process.stderr.write(`[export] mysql backend unreadable (${String(err)}) — falling back to the local index
`);
                }
            }
        }
        const index = path.join(store.dir, "index.db");
        const encrypted = process.env.BILI_ENCRYPTION_KEY !== undefined && process.env.BILI_ENCRYPTION_KEY !== "";
        if (existsSync(index) && !encrypted) {
            // #3931: the selection is enforced at open time, mirroring the lane-boot
            // split — a registered-but-unshipped choice (mysql, step 2) fails here
            // with its documented backend error before any file access, so a deliberate
            // selection never silently reads sqlite; a typo'd name warns once and reads sqlite.
            const selected = selectedBackendRaw(process.env, fileStorageBackend());
            if (selected && selected !== "sqlite") {
                if (listBackendNames().includes(selected)) {
                    // #3931 step 2: open is async now. The contract from the
                    // #3932 review holds — a deliberate selection never
                    // silently reads sqlite: without a DSN the open rejects
                    // with the documented error (bubbles out of the export);
                    // with a DSN the probe opens + closes cleanly (the real
                    // mysql export above already ran; if it degraded, its
                    // stderr notice announced the sqlite fallback).
                    const probe = await openBackend(selected, selected === "mysql" ? resolveMysqlDsn(process.env, fileStorageMysqlDsn()) : index);
                    await probe.close();
                } else {
                    const notice = backendSelectionNotice(selected);
                    if (notice) process.stderr.write(`[export] ${notice}\n`);
                }
            }
            // Guarded open: a corrupt/foreign index.db must degrade to the
            // legacy-tail renderer, not fail the export (#2690 review notes).
            // Encryption gates the read for the same reason the ingest side
            // does — index.db holds cleartext payloads, so an encrypted lane
            // must never read from it.
            try {
                // #3931 step 2: openBackend is async (network backends
                // open a pool + DDL init); the sqlite path resolves
                // immediately.
                const backend = await openBackend("sqlite", index);
                try {
                    if (await backend.getSessionRow(matches[0]!.id)) {
                        const disk = store.loadContentStore(matches[0]!);
                        const extra = disk ? new Map(Object.entries(disk.byRef).map(([ref, e]) => [ref, disk.byHash[e.hash] ?? ""] as const)) : undefined;
                        return await renderSessionJsonlFromTables(backend, matches[0]!.id, opts.full ?? false, extra);
                    }
                } finally {
                    await backend.close();
                }
            } catch (err) {
                process.stderr.write(`[export] unified index unreadable (${String(err)}) — falling back to the legacy-tail renderer\n`);
            }
        }
        return renderSessionJsonlFromSession(matches[0]!, opts.full ?? false, store.loadContentStore(matches[0]!));
    }
    const markdown = renderHandoff(matches[0]!, opts.full ?? false);
    if (opts.output) {
        mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
        writeFileSync(opts.output, markdown, "utf8");
        return `written to ${opts.output}`;
    }
    return markdown;
    } finally {
        // The one-shot store holds index.db open in unified modes; close it or
        // Windows callers cannot delete their temp dirs (EPERM).
        store.closeQuietly();
    }
}
