// Raw-stage inbound marker stripping — one engine, four wire protocols
// (issue #2811 plan B). Replaces the per-prepare three-call wiring
// (stripAcpPanel* → stripAcpStatusMarkers → stripEmbeddedChainCarriers) with
// a single ordered pipeline every protocol walks the same way:
//
//   per text slot (user/assistant text):  status body → stripAcpTags
//   whole message:                        panels → nudge echoes → carriers
//
// The google walk is NEW (#2798): the old generic walk only recognized
// `content: string | part[]` and google's `content.parts` objects were
// invisible to it, so panels/status lines/nudge echoes rode the rebuild.
//
// Counts are returned per class so prepares log recognizable lines and
// tests/marker-lane-coverage.test.ts can assert every spec id fires on
// every protocol.

import { isAcpPanelText, stripAcpPanelMessages, stripAcpPanelResponsesInput } from "../acp-panel.js";
import { stripEmbeddedChainCarriers } from "../chain-checkpoint.js";
import { MARKER_LINE, stripMarkerLines } from "../loop/tag-echo-filter.js";
import type { WireProtocol } from "../util.js";
import { isNudgeEchoText } from "./anchors.js";
import { consumeAcpStatusBody, type StatusBodyResult } from "./status-body.js";

export interface RawStripCounts {
    panels: number;
    statusBodies: number;
    statusBodyLines: number;
    markerLines: number;
    nudges: number;
    carriers: number;
}

function emptyCounts(): RawStripCounts {
    return { panels: 0, statusBodies: 0, statusBodyLines: 0, markerLines: 0, nudges: 0, carriers: 0 };
}

function countMarkerLines(text: string): number {
    let n = 0;
    for (const _ of text.matchAll(MARKER_LINE)) n++;
    return n;
}

// Shared per-text-slot pipeline. Mirrors stripAcpStatusMarkers semantics:
// status-body blocks, then marker LINES only. Render-tag spans (<acp …>) are
// deliberately NOT touched at this layer — a foreign literal tag is user
// data (#1357 advisory processing keeps it byte-intact) and bili's own tag
// echoes are handled at the projection layer (tag-echo-filter render walk).
// A slot that becomes empty degrades to a single space (an assistant message
// may still carry tool_calls whose results must not be orphaned).
function stripTextSlot(text: string, counts: RawStripCounts, opts?: { noStatusBody?: boolean }): string {
    let t = text;
    if (!opts?.noStatusBody) {
        const body: StatusBodyResult = consumeAcpStatusBody(t);
        if (body.bodies > 0) {
            t = body.text.trim().length > 0 ? body.text : " ";
            counts.statusBodies += body.bodies;
            counts.statusBodyLines += body.lines;
        }
    }
    const out = stripMarkerLines(t);
    if (out !== t) {
        counts.markerLines += countMarkerLines(t);
        t = out.trim().length > 0 ? out : " ";
    }
    return t;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

// anthropic / openai chat `messages` walk.
function stripMessagesArray(messages: unknown, counts: RawStripCounts): void {
    if (!Array.isArray(messages)) return;
    counts.panels += stripAcpPanelMessages(messages);
    // #2815 review: the latest user message is the CURRENT turn — a user
    // pasting an acp_status report (bug-report scenario) must not have it
    // eaten as an echo. Older user messages are resent history: consume.
    let lastUserIdx = -1;
    for (let i = 0; i < messages.length; i++) {
        const r = messages[i];
        if (isPlainRecord(r) && r.role === "user") lastUserIdx = i;
    }
    // reverse index: nudge splices remove the current element, and a forward
    // for..of would silently skip the next message after each splice
    for (let i = messages.length - 1; i >= 0; i--) {
        const rec = messages[i];
        if (!isPlainRecord(rec)) continue;
        const role = rec.role;
        if (role !== "user" && role !== "assistant") continue;
        const noStatusBody = i === lastUserIdx;
        if (typeof rec.content === "string") {
            rec.content = stripTextSlot(rec.content, counts, { noStatusBody });
        } else if (Array.isArray(rec.content)) {
            for (const part of rec.content) {
                if (!isPlainRecord(part)) continue;
                // KDD #10 / #1882: signed thinking blocks ride byte-for-byte —
                // their text lives in `.thinking` (never `.text`), and this
                // explicit gate keeps a future shape change from silently
                // wiring them into the strip walk.
                if (part.type === "thinking" || part.type === "redacted_thinking") continue;
                if (typeof part.text === "string") part.text = stripTextSlot(part.text, counts, { noStatusBody });
            }
        }
        // nudge echoes: whole user message (exact tail match); an assistant
        // echo degrades to a space so tool_calls survive
        if (typeof rec.content === "string" && isNudgeEchoText(rec.content)) {
            if (role === "user") {
                messages.splice(i, 1);
                counts.nudges++;
            } else {
                rec.content = " ";
            }
        }
    }
}

// google `contents` walk (#2798 fix): text parts live at content.parts[].text.
function stripGoogleContents(parsed: unknown, counts: RawStripCounts): void {
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.contents)) return;
    const contents = parsed.contents;
    // #2815 review: same latest-user-turn paste guard as the messages walk.
    let lastUserIdx = -1;
    for (let i = 0; i < contents.length; i++) {
        const c = contents[i];
        if (isPlainRecord(c) && c.role === "user") lastUserIdx = i;
    }
    for (let i = contents.length - 1; i >= 0; i--) {
        const c = contents[i];
        if (!isPlainRecord(c)) continue;
        const role = typeof c.role === "string" ? c.role : "user";
        if (role !== "user" && role !== "model") continue;
        const parts = c.parts;
        if (!Array.isArray(parts)) continue;
        const noStatusBody = i === lastUserIdx;
        for (const p of parts) {
            if (!isPlainRecord(p)) continue;
            // KDD #10 / #1960: thought text is signed (thoughtSignature is
            // verified byte-for-byte on replay) — any rewrite desyncs text
            // from signature and bricks the session. Thought parts ride
            // verbatim; cosmetic marker echoes inside a thought pane are
            // accepted, same verdict as the outbound walk (adapter-google).
            if (p.thought === true || p.thoughtSignature !== undefined) continue;
            if (typeof p.text === "string") p.text = stripTextSlot(p.text, counts, { noStatusBody });
        }
        // whole-content removal only under carrier strictness: every part is
        // a single-key {text} and the joined text matches a panel / nudge.
        const allPlain = parts.every(
            (p) => isPlainRecord(p) && Object.keys(p).length === 1 && typeof p.text === "string",
        );
        if (allPlain) {
            const joined = parts.map((p) => (p as Record<string, unknown>).text as string).join("");
            if (isAcpPanelText(joined) || isNudgeEchoText(joined)) {
                contents.splice(i, 1);
                counts.panels += isAcpPanelText(joined) ? 1 : 0;
                counts.nudges += isNudgeEchoText(joined) && !isAcpPanelText(joined) ? 1 : 0;
            }
        }
    }
}

// Responses `input` walk: message items (plus the type-less omp wire form).
function stripResponsesInput(input: unknown, counts: RawStripCounts): void {
    if (!Array.isArray(input)) return;
    counts.panels += stripAcpPanelResponsesInput(input);
    // #2815 review: same latest-user-turn paste guard as the messages walk.
    let lastUserIdx = -1;
    for (let i = 0; i < input.length; i++) {
        const r = input[i];
        if (isPlainRecord(r) && r.role === "user" && (r.type === "message" || r.type === undefined)) lastUserIdx = i;
    }
    for (let i = input.length - 1; i >= 0; i--) {
        const rec = input[i];
        if (!isPlainRecord(rec)) continue;
        const type = rec.type;
        if (type !== "message" && type !== undefined) continue;
        const role = typeof rec.role === "string" ? rec.role : "";
        if (role !== "user" && role !== "assistant") continue;
        const noStatusBody = i === lastUserIdx;
        if (typeof rec.content === "string") {
            rec.content = stripTextSlot(rec.content, counts, { noStatusBody });
            if (role === "user" && isNudgeEchoText(rec.content as string)) {
                input.splice(i, 1);
                counts.nudges++;
            }
        } else if (Array.isArray(rec.content)) {
            for (const part of rec.content) {
                if (!isPlainRecord(part)) continue;
                // KDD #10 symmetry with the anthropic/openai walk: signed
                // reasoning rides byte-for-byte, never through the strip walk.
                if (part.type === "thinking" || part.type === "redacted_thinking" || part.type === "reasoning") continue;
                if (typeof part.text === "string") part.text = stripTextSlot(part.text, counts, { noStatusBody });
            }
        }
    }
}

// One raw stage for every wire protocol. `parsed` is the decoded request
// body (mutated in place). Carrier stripping runs FIRST and stays in
// chain-checkpoint.ts — it is whole-PART exact per protocol, and running it
// after the text-slot pass would hide its strict semantics behind the
// lenient tag stripper (whitespace zombies instead of message splices,
// #1542's log line starved).
export function stripRawStage(parsed: unknown, wire: WireProtocol): RawStripCounts {
    const counts = emptyCounts();
    if (!isPlainRecord(parsed)) return counts;
    counts.carriers = stripEmbeddedChainCarriers(parsed, wire);
    if (wire === "google") {
        stripGoogleContents(parsed, counts);
    } else if (wire === "responses") {
        stripResponsesInput(parsed.input, counts);
    } else {
        stripMessagesArray(parsed.messages, counts);
    }
    return counts;
}

/** Total raw-stage artifact removals in a pass (every class). Feeds
 *  ReconcileOptions.markerStripped: a pass that stripped bili's own echoes
 *  proves the resent history carried artifacts, so covered ids minted from
 *  artifact-laden bytes churning under clean-byte minting is explained —
 *  fold-reconcile must not misread it as substrate destruction (#2815). */
export function markerArtifactCount(c: RawStripCounts): number {
    return c.panels + c.statusBodies + c.markerLines + c.nudges + c.carriers;
}

// Uniform prepare-side logging for the raw stage. Phrases stay compatible
// with the per-prepare lines this engine replaced (#359 / #1029 / #1542),
// plus the two classes that are new at this layer (#2789 / nudge echoes).
export function logRawStripCounts(
    counts: RawStripCounts,
    log: (level: "info" | "warn", msg: string) => void,
    sessionId: string,
): void {
    if (counts.panels > 0) {
        log("info", `[${sessionId}] stripped ${counts.panels} ACP panel message(s) before projection (UI-only, issue #359)`);
    }
    if (counts.markerLines > 0) {
        log("info", `[${sessionId}] stripped ${counts.markerLines} ACP status marker line(s) from incoming history (ephemeral proxy status, issue #1029)`);
    }
    if (counts.statusBodies > 0) {
        log("info", `[${sessionId}] stripped ${counts.statusBodies} acp_status report bod${counts.statusBodies === 1 ? "y" : "ies"} (${counts.statusBodyLines} line(s)) from incoming history (orphaned report body, issue #2789)`);
    }
    if (counts.nudges > 0) {
        log("info", `[${sessionId}] stripped ${counts.nudges} nudge echo message(s) from incoming history (persisted proxy nudge)`);
    }
    if (counts.carriers > 0) {
        log("info", `[${sessionId}] stripped ${counts.carriers} embedded chain checkpoint(s) from incoming history (leaked egress control data, issue #1542)`);
    }
}
