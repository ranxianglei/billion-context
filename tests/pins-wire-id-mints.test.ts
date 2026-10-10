// Storage-refactor pins (S6 wire-id mint contract) — pre-refactor guard rails,
// owner directive 2026-10-11 ("重构之前先打桩").
//
// The #2374 class: every id bili mints onto a wire must be (a) known to the
// sanitizers that strip/rewrite client-replayed ids, and (b) stable across the
// storage refactor. This file pins the MINT INVENTORY behaviorally and
// textually: adding or renaming a mint turns it red on purpose.
//
//   M1 responses-wire message ids mint by proxyMessageItemId() under
//      "msg-proxy-" (+ legacy "marker-"); sanitizeResponsesInputIds must
//      treat EXACTLY those two prefixes as bili-owned (delete on assistant
//      message items) and leave foreign ids untouched.
//   M2 over-length (>64) msg-proxy- ids rewrite to "msg-fix-<hash>"; legacy
//      marker- ids delete (never rewritten — upstream never saw a valid one).
//   M3 the prefix constants exist verbatim in the source and isBiliMessageId
//      tests both (textual pin: silent rename breaks the build).
//   M4 external-summary blocks stamp compressCallId under "external-summary-"
//      (src/external-summary-marker.ts — ⚡ext badge + panel marker source).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeResponsesInputIds } from "../src/loop/adapter-responses.ts";
import { EXTERNAL_SUMMARY_CALL_ID_PREFIX, isExternalSummaryBlock } from "../src/external-summary-marker.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "src", "loop", "adapter-responses.ts");

test("M1 sanitizer owns exactly msg-proxy- and marker- on assistant message items", () => {
    const input = [
        { type: "message", role: "assistant", id: "msg-proxy-1760000000000-0", content: "hi" },
        { type: "message", role: "assistant", id: "marker-1760000000000-1", content: ["text"] },
        { type: "message", role: "assistant", id: "msg_foreign123", content: "foreign" },
        { type: "message", role: "user", id: "marker-1760000000000-2", content: "user msg" },
        { type: "function_call", id: "fc_0", call_id: "call_0" },
    ];
    sanitizeResponsesInputIds(input);
    assert.equal(input[0].id, undefined, "msg-proxy- assistant id must be deleted");
    assert.equal(input[1].id, undefined, "marker- assistant id must be deleted");
    assert.equal(input[2].id, "msg_foreign123", "foreign assistant id must survive");
    assert.equal(input[3].id, "marker-1760000000000-2", "user-role marker- id must survive (assistant-only rule)");
    assert.equal((input[4] as { id?: string }).id, "fc_0", "non-message item ids are none of the sanitizer's business");
});

test("M2 over-length ids: msg-proxy- rewrites to msg-fix-, marker- deletes with content", () => {
    // Rewrite branch (id-preservation) fires only when the delete branch does
    // not — i.e. the replayed item is NOT an assistant message with content.
    // The realistic shape: a client replay that stripped content but kept ids.
    const longProxy = "msg-proxy-" + "9".repeat(80);
    const longMarker = "marker-" + "9".repeat(80);
    const input = [
        { type: "message", role: "assistant", id: longProxy },               // no content → rewrite
        { type: "message", role: "assistant", id: longMarker, content: "x" }, // content → delete
    ];
    sanitizeResponsesInputIds(input);
    assert.match(String(input[0].id), /^msg-fix-[0-9a-f]+$/, ">64 msg-proxy- (contentless) must be rewritten to msg-fix-");
    assert.equal(input[1].id, undefined, ">64 marker- with content must be deleted (delete branch precedes rewrite)");
});

test("M3 mint prefixes are pinned verbatim in adapter-responses.ts", () => {
    const src = fs.readFileSync(ADAPTER, "utf8");
    assert.ok(
        src.includes('const PROXY_MESSAGE_ID_PREFIX = "msg-proxy-";'),
        "PROXY_MESSAGE_ID_PREFIX literal changed — update the mint ledger (this test + #2374 class) consciously",
    );
    assert.ok(
        src.includes('const LEGACY_MARKER_MESSAGE_ID_PREFIX = "marker-";'),
        "LEGACY_MARKER_MESSAGE_ID_PREFIX literal changed — update the mint ledger consciously",
    );
    const isBili = src.slice(
        src.indexOf("function isBiliMessageId"),
        src.indexOf("function isBiliMessageId") + 400,
    );
    assert.ok(
        isBili.includes("PROXY_MESSAGE_ID_PREFIX") && isBili.includes("LEGACY_MARKER_MESSAGE_ID_PREFIX"),
        "isBiliMessageId must keep checking BOTH mint prefixes — a new mint added to proxyMessageItemId but not here reopens #2374",
    );
    assert.ok(src.includes("const RESPONSES_ITEM_ID_MAX = 64;"), "RESPONSES_ITEM_ID_MAX changed — over-length rewrite threshold moved");
});

test("M4 external-summary block stamp contract", () => {
    assert.equal(EXTERNAL_SUMMARY_CALL_ID_PREFIX, "external-summary-");
    assert.equal(isExternalSummaryBlock({ compressCallId: "external-summary-3f0c6b8a-1" }), true);
    assert.equal(isExternalSummaryBlock({ compressCallId: "model-run-42" }), false);
    assert.equal(isExternalSummaryBlock({}), false);
});
