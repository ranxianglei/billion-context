import { isSummaryMessageId, summaryMessageId } from "acp-kernel";

// #1702 (redesigned per review): opencode's sub-agent dispatch carries the
// child session id in two machine-written places: the tool-call arguments
// JSON (structured fields, where present) and the tool-result envelope
// header `<task id="ses_..." state="...">` (opencode renderOutput — the
// shape real traffic always has; the model never chooses the id itself).
// Once a dispatch pair slides out of the protected zone, that id previously
// survived only through the model's free-text summary — weak models drop it
// (#1563 A/B: ~20% loss). Here the id is captured mechanically at fold commit
// into a session-metadata sidecar and re-attached at render time, so it stays
// model-visible regardless of summary quality. The stored block summary stays
// byte-clean (tier distillation never re-copies ids it could corrupt), and the
// attach lines live only in rendered views. opencode only, per review: no other
// client lane ships a structured sub-agent session field today.

// "task" = opencode 1.x; "subagent" = opencode 2.x (packages/core/src/tool/plugin/subagent.ts:16).
const SUBAGENT_TOOL_NAMES = new Set(["task", "subagent"]);
const SES_ID_RE = /^ses_[A-Za-z0-9]+$/;
const MAX_IDS_PER_BLOCK = 100;
const METADATA_KEY = "subagentSessions";
const PLUGIN_AGENT = "opencode";
const SUMMARY_ID_PREFIX = summaryMessageId("");

type SubagentMessage = { id: string; contentType?: string; toolName?: string; text?: string };
type SubagentBlock = { blockId: string; effectiveMessageIds: string[]; directBlockIds: string[] };
type SubagentSession = {
    metadata?: Record<string, unknown>;
    state: { blocks: { blockId: string; active?: boolean }[] };
};

function subagentEnabled(session: SubagentSession | undefined): boolean {
    return session?.metadata?.pluginAgent === PLUGIN_AGENT;
}

export function subagentSessionsOf(session: SubagentSession | undefined): Record<string, string[]> {
    const bag = session?.metadata?.[METADATA_KEY];
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
        if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
}

// Structured extraction ONLY, from the two machine-written carriers:
//   - the tool-call arguments JSON (dispatch message, structured fields);
//   - the tool-result envelope header. opencode 1.x renderOutput writes
//     `<task id="ses_..." state="...">`; opencode 2.x (subagent tool,
//     packages/core/src/tool/plugin/subagent.ts) writes
//     `<subagent sessionID="ses_..." state="completed">`. Both put the
//     child session id as an XML attribute on the first line of the result
//     text — model-chosen call args never carry it. The envelope is matched
//     only at the head of the first non-empty line: it is a machine-generated
//     wrapper, and head-anchoring keeps us off prose (review direction on
//     #1704: fields, not patterns).
const TASK_ENVELOPE_RE = /^<(?:task id|subagent sessionID)="(ses_[A-Za-z0-9]+)"(?:\s[^>]*)?>/;

export function captureSubagentSessionIds(messages: SubagentMessage[], covered: Set<string>): string[] {
    const out: string[] = [];
    for (const m of messages) {
        if (!covered.has(m.id)) continue;
        if (typeof m.toolName !== "string" || !SUBAGENT_TOOL_NAMES.has(m.toolName)) continue;
        if (m.contentType === "tool-result") {
            const first = (m.text ?? "").split("\n", 1)[0]?.trim() ?? "";
            const id = first.match(TASK_ENVELOPE_RE)?.[1];
            if (id !== undefined && !out.includes(id)) out.push(id);
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(m.text ?? "");
        } catch {
            continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const obj = parsed as Record<string, unknown>;
        for (const key of ["sessionId", "sessionID", "session_id"]) {
            const v = obj[key];
            if (typeof v === "string" && SES_ID_RE.test(v) && !out.includes(v)) out.push(v);
        }
    }
    return out;
}

// Fold-commit hook. `changed` = new blocks plus refolds (summary replaced,
// same id). For each, capture from this round's covered view and inherit child
// entries (a T2 refold's covered originals may no longer ride the raw history,
// but its child blocks' entries do). A changed block whose re-capture comes up
// empty keeps its previous entry — the conservative direction is retention.
// Entries for blocks that no longer exist in state are pruned.
export function syncSubagentSessions(session: SubagentSession, changed: SubagentBlock[], messages: SubagentMessage[]): void {
    if (!subagentEnabled(session)) return;
    const bag = subagentSessionsOf(session);
    for (const b of changed) {
        const covered = new Set(b.effectiveMessageIds);
        const captured = captureSubagentSessionIds(messages, covered);
        const inherited = (b.directBlockIds ?? []).flatMap((child) => bag[child] ?? []);
        const ids = [...new Set([...captured, ...inherited])].slice(0, MAX_IDS_PER_BLOCK);
        if (ids.length > 0) bag[b.blockId] = ids;
    }
    const live = new Set(session.state.blocks.map((b) => b.blockId));
    for (const k of Object.keys(bag)) {
        if (!live.has(k)) delete bag[k];
    }
    if (!session.metadata) session.metadata = {};
    session.metadata[METADATA_KEY] = bag;
}

// Receipt line for the compress tool result — the plugin-mode carrier (the
// result rides the agent's re-sent history, so the id survives there too).
export function subagentSessionNote(blockId: string, ids: string[]): string {
    return `[acp-subagent-sessions ${blockId}: ${ids.join(", ")}]`;
}

// Render-time attach for the proxy-mode carrier: the kernel's active-block
// summary message gains a trailing id line. Input messages are never mutated;
// an untouched conversation returns the original array reference.
export function attachSubagentSessions<T extends { id: string; text?: string }>(messages: T[], session: SubagentSession | undefined): T[] {
    if (!subagentEnabled(session)) return messages;
    const map = subagentSessionsOf(session);
    if (Object.keys(map).length === 0) return messages;
    const active = new Set(session!.state.blocks.filter((b) => b.active).map((b) => b.blockId));
    let touched = false;
    const out = messages.map((m) => {
        if (!isSummaryMessageId(m.id)) return m;
        const blockId = m.id.slice(SUMMARY_ID_PREFIX.length);
        if (!active.has(blockId)) return m;
        const ids = map[blockId];
        if (ids === undefined || ids.length === 0) return m;
        touched = true;
        return { ...m, text: `${m.text ?? ""}\n\n[acp-subagent-sessions: ${ids.join(", ")}]` };
    });
    return touched ? out : messages;
}
