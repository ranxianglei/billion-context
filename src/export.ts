import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Session } from "./session.js";
import { SessionStore } from "./persist.js";

export interface ExportOptions {
    dir?: string;
    output?: string;
    full?: boolean;
}

export interface SessionSummary {
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
    const sessions = [...(await store.loadAll()).values()];
    sessions.sort((a, b) => latestBlockTime(b) - latestBlockTime(a));
    return sessions.map((s) => ({
        id: s.id,
        title: s.meta.title,
        label: s.meta.label,
        protocol: s.meta.protocol,
        upstreamOrigin: s.meta.upstreamOrigin,
        savedAt: latestBlockTime(s) || undefined,
        contextTokens: s.stats.contextTokens,
        blocks: s.state.blocks.length,
    }));
}

function latestBlockTime(s: Session): number {
    let latest = 0;
    for (const b of s.state.blocks) if (b.createdAt > latest) latest = b.createdAt;
    return latest;
}

export function renderHandoff(s: Session, full: boolean): string {
    const lines: string[] = [];
    lines.push(`# billion-context session handoff`);
    lines.push("");
    lines.push(`- title: ${s.meta.title ?? "(untitled)"}`);
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
        lines.push("No active compression blocks — the session history below is the original conversation.");
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
    lines.push("---");
    lines.push("");
    lines.push("Paste the block summaries above into a new session to continue without the proxy.");
    lines.push("");
    return lines.join("\n");
}

function matchSession(sessions: Session[], selector: string): Session[] {
    const exact = sessions.filter((s) => s.id === selector);
    if (exact.length > 0) return exact;
    const byLabel = sessions.filter((s) => s.meta.label === selector);
    if (byLabel.length > 0) return byLabel;
    const byPrefix = sessions.filter((s) => s.id.startsWith(selector) || (s.meta.label ?? "").startsWith(selector));
    return byPrefix;
}

export async function exportSession(selector: string | undefined, opts: ExportOptions = {}): Promise<string> {
    const store = new SessionStore({ dir: opts.dir, enabled: true });
    const all = [...(await store.loadAll()).values()];
    if (all.length === 0) {
        return "No persisted sessions found. Sessions are written under the sessions directory after the proxy compresses a conversation.";
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
    const markdown = renderHandoff(matches[0]!, opts.full ?? false);
    if (opts.output) {
        mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
        writeFileSync(opts.output, markdown, "utf8");
        return `written to ${opts.output}`;
    }
    return markdown;
}
