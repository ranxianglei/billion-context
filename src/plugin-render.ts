// #4491 S4: POST /__bili/plugin/render — the outbound prefix rendered from
// the server-owned transcript (unified storage), so the client shim can
// splice it into its request instead of resending its own bytes.
//
// Contract (degrade, never guess — same discipline as snapshot render D):
// any desync (gate off, storage unreadable, cold session, unparsable row,
// dangling view pointer) returns a non-2xx {ok:false} and the shim falls
// back to sending its local history verbatim. Covered regions render as
// acp_summary anchors past each fold's last covered row; an active block
// with NO resolvable row in the window skips its coverage (its rows stay
// live-visible — the safe direction) instead of failing the whole render.
import http from "node:http";
import { coreToAnthropic, type BiliMessage } from "acp-kernel/wire";
import { getStore } from "./persist.js";
import { peekSession } from "./session.js";
import { pluginAgentHeader } from "./plugin.js";
import { readBody } from "./server.js";
import { featureEnabled } from "./rollout.js";
import { loadSystem } from "./incremental-lane.js";
import type { MessageRow } from "./storage/store.js";

export const PLUGIN_RENDER_PATH = "/__bili/plugin/render";

const MAX_ID_LEN = 512;
const MAX_UNTIL_SEQ = 1_000_000;

function jsonReply(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

export async function handlePluginRender(req: http.IncomingMessage, res: http.ServerResponse, log: (level: string, msg: string) => void): Promise<void> {
    const agent = pluginAgentHeader(req.headers);
    if (!agent) return jsonReply(res, 400, { ok: false, error: "render requires the x-bili-plugin header (agent identity)" });
    if (!featureEnabled("pluginLaneServerHistory")) return jsonReply(res, 404, { ok: false, error: "feature-off" });
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>;
    } catch {
        return jsonReply(res, 400, { ok: false, error: "invalid JSON body" });
    }
    const conversationId = typeof payload.conversationId === "string" ? payload.conversationId.trim() : "";
    if (!conversationId || conversationId.length > MAX_ID_LEN) return jsonReply(res, 400, { ok: false, error: "conversationId must be a non-empty string (≤512 chars)" });
    const untilSeq = typeof payload.untilSeq === "number" && Number.isInteger(payload.untilSeq) && payload.untilSeq >= 0 && payload.untilSeq <= MAX_UNTIL_SEQ ? payload.untilSeq : -1;
    if (untilSeq === -1) return jsonReply(res, 400, { ok: false, error: "untilSeq must be an integer in [0, 1000000]" });

    // Same identity rule as the incremental lane: the conversation id IS the
    // pipeline session id (x-bili-plugin-conversation is the strongest signal).
    const sessionId = conversationId;
    let store: ReturnType<typeof getStore>;
    try {
        store = getStore();
    } catch {
        return jsonReply(res, 503, { ok: false, error: "storage-unavailable" });
    }
    if (!store.replicasAvailable()) return jsonReply(res, 503, { ok: false, error: "storage-unavailable" });
    const rows = store.unifiedTailViewRows(sessionId);
    if (rows === null) return jsonReply(res, 503, { ok: false, error: "storage-unavailable" });
    const tailSeqs = store.unifiedTailSeqs(sessionId);
    if (tailSeqs === null || tailSeqs.length === 0) return jsonReply(res, 503, { ok: false, error: "transcript-empty" });

    const bySeq = new Map<number, MessageRow>();
    for (const r of rows) bySeq.set(r.seq, r);
    const viewRows: MessageRow[] = [];
    for (const s of tailSeqs.slice(0, untilSeq)) {
        const row = bySeq.get(s);
        if (row === undefined) return jsonReply(res, 503, { ok: false, error: "view-pointer-missing-row" });
        viewRows.push(row);
    }
    const appliedSeq = viewRows.length;

    const prefix: BiliMessage[] = [];
    const idToSeq = new Map<string, number>();
    for (const row of viewRows) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(row.content);
        } catch {
            return jsonReply(res, 503, { ok: false, error: "row-unparsable" });
        }
        if (!parsed || typeof parsed !== "object" || typeof (parsed as BiliMessage).id !== "string" || typeof (parsed as BiliMessage).role !== "string") {
            return jsonReply(res, 503, { ok: false, error: "row-unparsable" });
        }
        const m = parsed as BiliMessage & { ledgerSeq?: number };
        // store seqs are 0-based; ref display numbers are 1-based (#4346)
        m.ledgerSeq = row.seq + 1;
        prefix.push(m);
        idToSeq.set(m.id, row.seq);
    }

    // Cold session = fold state unknown. Rendering without folds would serve
    // a silently un-folded prefix, so degrade; the next model turn warms the
    // session and the capability self-heals.
    const session = peekSession(sessionId);
    if (!session) return jsonReply(res, 503, { ok: false, error: "session-cold" });
    const activeBlocks = session.state.blocks.filter((b) => b.active);
    const coveredSeqs = new Set<number>();
    const anchors: { pos: number; msg: BiliMessage }[] = [];
    for (const block of activeBlocks) {
        const blockSeqs: number[] = [];
        for (const id of block.effectiveMessageIds) {
            const seq = idToSeq.get(id);
            if (seq !== undefined) blockSeqs.push(seq);
        }
        if (blockSeqs.length === 0) continue;
        for (const s of blockSeqs) coveredSeqs.add(s);
        const maxCover = Math.max(...blockSeqs);
        const pos = viewRows.findIndex((r) => r.seq > maxCover);
        // #4732: pos === -1 means the fold reaches the END of the window — the
        // covered rows are suppressed below, so the anchor MUST still land
        // (at the tail) or the rendered prefix silently drops the whole fold
        // with no summary in its place.
        anchors.push({ pos: pos === -1 ? viewRows.length : pos, msg: { id: `acp_summary_${block.blockId}`, role: "system", contentType: "text", text: "" } as BiliMessage });
    }
    anchors.sort((a, b) => a.pos - b.pos);
    const merged: BiliMessage[] = [];
    let ai = 0;
    for (let i = 0; i < viewRows.length; i++) {
        while (ai < anchors.length && anchors[ai].pos === i) {
            merged.push(anchors[ai].msg);
            ai++;
        }
        if (!coveredSeqs.has(viewRows[i].seq)) merged.push(prefix[i]);
    }
    // #4732: tail anchors (fold covers the window's last rows) flush after
    // the loop — they never satisfy anchors[ai].pos === i inside it.
    while (ai < anchors.length) {
        merged.push(anchors[ai].msg);
        ai++;
    }

    const system = loadSystem(sessionId);
    // v1 renders the prefix WITHOUT cache-control marks: marks are per-turn
    // computed artifacts (the pipeline places them at the frontier), so
    // replaying a stored copy would desync the rendered prefix from the next
    // assembled turn's bytes. The client tail carries its own fresh marks.
    const messages = coreToAnthropic(merged);
    log("info", `[render] ${sessionId} until=${String(untilSeq)} served=${String(appliedSeq)} folded=${String(coveredSeqs.size)} agent=${agent}`);
    jsonReply(res, 200, {
        ok: true,
        appliedSeq,
        ...(system !== undefined && system !== null ? { system } : {}),
        messages,
    });
}
