// #6104: dsh 0.2.2-rc.1's auto-review sidecar stopped matching
// isDshAutoReviewRequest, so every review call ran the FULL pipeline under the
// main session id: reconcileFoldCoverage read the (differently serialized)
// history as a wholesale rewrite on both legs (1,006/1,007 alternating system
// fingerprints across 5 sessions), and the refs minted from the wrong
// serialization were tombstoned as DEAD — 107 `compress FAILED … cannot be
// anchored` receipts and 0 successful compressions in those sessions, with no
// un-tombstone path short of the message reappearing in the view.
//
// Both bars that failed were HOST-SIDE FORMAT decisions, not identity:
//   (a) REVIEW_POLICY now opens with a `REVIEW_POLICY` banner line, so the
//       pinned sentence is on line 2 and startsWith(line 1) is false;
//   (b) reviewMessages(snapshot) replays the whole conversation as
//       role:"user" text blobs, so `users === 1` is never true once history is
//       non-empty.
// The identity is the pinned sentence (banner-tolerant, still version-pinned);
// the replay veto is carried by the assistant/tool veto inside the loop — a
// real resend always carries assistant turns — so the user COUNT itself never
// had to be 1. These cases pin both halves plus the vetoes that must not move.

import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { DSH_AUTO_REVIEW_SYSTEM_PREFIX, isDshAutoReviewRequest } from "../src/server/side-request.ts";

// dsh 0.2.1-and-earlier REVIEW_POLICY: the pinned sentence IS the first line.
const POLICY_LEGACY = `${DSH_AUTO_REVIEW_SYSTEM_PREFIX} in this conversation.\n\nYou must decide whether the pending action is allowed, and reply with exactly one JSON verdict.`;

// dsh 0.2.2-rc.1 REVIEW_POLICY: a `REVIEW_POLICY` banner line precedes the
// pinned sentence (the reporter's payload: system=4334 chars, policy[0] =
// "REVIEW_POLICY", policy[1] = the pinned sentence).
const POLICY_RC1 = `REVIEW_POLICY\n${DSH_AUTO_REVIEW_SYSTEM_PREFIX} in this conversation.\n\nYou must decide whether the pending action is allowed, and reply with exactly one JSON verdict.`;

function anthropic(system: string, entries: unknown[], tools?: unknown[]): Record<string, unknown> {
    return tools === undefined ? { system, messages: entries } : { system, messages: entries, tools };
}

function userText(text: string): Record<string, unknown> {
    return { role: "user", content: [{ type: "text", text }] };
}

// reviewMessages(snapshot): [ENVIRONMENT, ...snapshot.history.map(json)], all
// replayed as role:"user" text blobs.
function reviewSnapshot(sections: string[]): Record<string, unknown>[] {
    return sections.map((s) => userText(s));
}

const SECTIONS = ["ENVIRONMENT\nprofile: web; model: deepseek-flash", "PROJECT_INSTRUCTIONS\n(none)", "FILTERED_HISTORY\n[…]", "PENDING_ACTION\n{\"tool\":\"bash\"}"];

test("#6104: the 0.2.2 REVIEW_POLICY banner no longer hides the pinned sentence", () => {
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(POLICY_RC1, reviewSnapshot([SECTIONS[0]!]))), true);
    // The legacy first-line shape stays a hit.
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(POLICY_LEGACY, reviewSnapshot([SECTIONS[0]!]))), true);
});

test("#6104: a history-replaying review body (N role:user blobs) is still the review", () => {
    // Pre-fix this was false for every non-empty history: `users === 1`.
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(POLICY_RC1, reviewSnapshot(SECTIONS))), true);
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(POLICY_LEGACY, reviewSnapshot(SECTIONS))), true);
    // Responses-wire spelling of the same body.
    assert.equal(isDshAutoReviewRequest("responses", { instructions: POLICY_RC1, input: reviewSnapshot(SECTIONS) }), true);
});

test("#6104: an assistant or tool turn still vetoes — a real resend can never match", () => {
    const replayed = [SECTIONS[0]!, { role: "assistant", content: [{ type: "text", text: "done" }] }, SECTIONS[1]!];
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(POLICY_RC1, replayed)), false);
    // Responses-side typed non-message items can only appear in a real round-trip.
    assert.equal(isDshAutoReviewRequest("responses", { instructions: POLICY_RC1, input: [SECTIONS[0]!, { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" }] }), false);
});

test("#6104: the tools veto and the identity pin are untouched", () => {
    // Any action surface marks an agent turn, even with the reviewer policy.
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(POLICY_RC1, reviewSnapshot(SECTIONS), [{ name: "bash", input_schema: {} }])), false);
    // Same body shapes, unrelated system text: not the reviewer's call.
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic("You are a helpful assistant.", reviewSnapshot(SECTIONS))), false);
    // Empty content is never a review snapshot.
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(POLICY_RC1, [{ role: "user", content: "" }])), false);
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(POLICY_RC1, [])), false);
});

test("#6104: the banner tolerance is bounded to the system head, not the whole prompt", () => {
    // A policy quoted deep inside someone else's prompt must not identify a review call.
    const quoted = ["You are a coding agent.", "", "", "", "", "", `${DSH_AUTO_REVIEW_SYSTEM_PREFIX} in this conversation.`].join("\n");
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(quoted, reviewSnapshot(SECTIONS))), false);
    // The window itself, line by line: DSH_AUTO_REVIEW_HEAD_LINES is the whole
    // contract of the tolerance, so pin BOTH ends of it — a future "just raise
    // the constant" edit has to face the case it stops catching.
    const sentenceAt = (line: number): string => {
        const lines = ["You are a coding agent.", "body", "body", "body", "body", "body", "body"];
        lines[line - 1] = `${DSH_AUTO_REVIEW_SYSTEM_PREFIX} in this conversation.`;
        return lines.join("\n");
    };
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(sentenceAt(1), reviewSnapshot(SECTIONS))), true, "line 1 (the legacy pin) still matches");
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(sentenceAt(5), reviewSnapshot(SECTIONS))), true, "line 5 is the last line inside the window");
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(sentenceAt(6), reviewSnapshot(SECTIONS))), false, "line 6 is outside the window");
    // CRLF carriers (the reporter's host is Windows) read the same.
    assert.equal(isDshAutoReviewRequest("anthropic", anthropic(POLICY_RC1.replace(/\n/g, "\r\n"), reviewSnapshot(SECTIONS))), true);
    // Block-array system: systemCarrierTexts hands each block over separately, so
    // a banner in its own block still leaves the sentence at the head of its own.
    assert.equal(isDshAutoReviewRequest("anthropic", { system: [{ type: "text", text: "REVIEW_POLICY" }, { type: "text", text: POLICY_LEGACY }], messages: reviewSnapshot(SECTIONS) }), true);
});

test("#6104: non-anthropic wires keep their carrier reading", () => {
    // Google: systemInstruction.parts carries the policy; contents hold the blobs.
    assert.equal(isDshAutoReviewRequest("google", { systemInstruction: { parts: [{ text: POLICY_RC1 }] }, contents: reviewSnapshot(SECTIONS).map((e) => ({ role: "user", parts: [{ text: String((e.content as { text: string }[])[0]!.text) }] })) }), true);
});
