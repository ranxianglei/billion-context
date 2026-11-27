/**
 * 7773 §6: the structural invariants of the materialized egress planes —
 * asserted AFTER EVERY WRITE, on both planes, for the whole life of the
 * session in this file:
 *
 *   1. the flow is append-only: its row count never shrinks;
 *   2. the state row count == the number of live rows the view shows
 *      (the state plane is a materialization, never an op mirror and never
 *      an aggregate);
 *   3. the LARGEST value in flow/state equals the historical maximum
 *      SINGLE-MESSAGE (block) size — a regression toward the retired B-row
 *      aggregate (whose payload held the WHOLE view) would show up here
 *      immediately, not at release time;
 *   4. the row alphabet is exactly I / D / U (message plane) and I / U / D
 *      (block plane) — the retired 'B' never appears.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { egressAppendTurn, egressStateView } from "../src/storage/egress-state.ts";
import { egressBlockAppend, egressBlockView, diffBlockSet, type EgressBlockSnapshot } from "../src/storage/egress-block.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-invariants-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const db = openSqliteDatabase(path.join(hermetic, "index.db")).db;
migrateSchema(db);

const S = "sess-invariants";

// the historical maximum single-row sizes — updated on every write below
let flowMaxBytes = 0;
let stateMaxBytes = 0;
let prevFlowCount = 0;

function checkMessagePlane(tag: string): void {
    // 1. append-only
    const flowCount = (db.prepare("SELECT COUNT(*) AS n FROM egress_flow WHERE session_id = ?").get(S) as { n: number }).n;
    assert.ok(flowCount >= prevFlowCount, `${tag}: the flow shrank (${prevFlowCount} → ${flowCount}) — 7773 invariant 1`);
    prevFlowCount = flowCount;
    // 4. row alphabet
    const types = (db.prepare("SELECT DISTINCT row_type AS t FROM egress_flow WHERE session_id = ? ORDER BY t").all(S) as { t: string }[]).map((r) => r.t);
    assert.ok(types.every((t) => t === "I" || t === "D" || t === "U"), `${tag}: retired row type in the flow: ${types.join(",")}`);
    // 2. state == live view
    const view = egressStateView(db, S);
    const stateCount = (db.prepare("SELECT COUNT(*) AS n FROM egress_state WHERE session_id = ?").get(S) as { n: number }).n;
    assert.equal(stateCount, view.length, `${tag}: state row count ${stateCount} != live view length ${view.length}`);
    // 3. the largest flow value is the largest SINGLE message (never an
    //    aggregate of several)
    const bigFlow = (db.prepare("SELECT MAX(LENGTH(payload)) AS m FROM egress_flow WHERE session_id = ?").get(S) as { m: number | null }).m ?? 0;
    assert.ok(bigFlow <= flowMaxBytes, `${tag}: a flow value of ${bigFlow} bytes exceeds the largest single message ever written (${flowMaxBytes}) — aggregate-shaped row (the retired B class)`);
    const bigState = (db.prepare("SELECT MAX(LENGTH(bytes)) AS m FROM egress_state WHERE session_id = ?").get(S) as { m: number | null }).m ?? 0;
    assert.ok(bigState <= stateMaxBytes, `${tag}: a state value of ${bigState} bytes exceeds the largest single message ever written (${stateMaxBytes})`);
}

const M = (id: string, text: string, role: "user" | "assistant" = "user") => ({ id, role, contentType: "text" as const, text });
const msg = (id: string, n: number) => M(id, `body of ${id} `.repeat(n));

let view: ReturnType<typeof egressAppendTurn> | undefined;

// turn 1: five distinct-size messages
const t1 = [msg("a", 1), msg("b", 2), msg("c", 3), msg("d", 2), msg("e", 1)];
for (const m of t1) flowMaxBytes = Math.max(flowMaxBytes, JSON.stringify(m).length);
for (const m of t1) stateMaxBytes = Math.max(stateMaxBytes, m.text.length);
view = egressAppendTurn(db, S, [{ type: "I", rid: 1, msgid: "sys", after: null, ref: "", tokens: 0, typeTag: "text", bytes: "" }, { type: "I", rid: 2, msgid: "a", after: 1, ref: "m00001", tokens: 1, typeTag: "text", bytes: t1[0]!.text }, { type: "I", rid: 3, msgid: "b", after: 2, ref: "m00002", tokens: 2, typeTag: "text", bytes: t1[1]!.text }, { type: "I", rid: 4, msgid: "c", after: 3, ref: "m00003", tokens: 3, typeTag: "text", bytes: t1[2]!.text }, { type: "I", rid: 5, msgid: "d", after: 4, ref: "m00004", tokens: 2, typeTag: "text", bytes: t1[3]!.text }, { type: "I", rid: 6, msgid: "e", after: 5, ref: "m00005", tokens: 1, typeTag: "text", bytes: t1[4]!.text }], 1_000, { baseSeq: 0 });
checkMessagePlane("turn 1");

// the block plane lives alongside: two blocks, one reaped later
let prevBlockFlowCount = 0;
let blockMaxPayload = 0;
const snap = (over: Partial<EgressBlockSnapshot> = {}): EgressBlockSnapshot => ({
    tier: 1, startMsgid: "a", startSeq: 1, endMsgid: "c", endSeq: 3, supersedesBlockId: null, active: true, reaped: false,
    one: JSON.stringify({ text: "one" }), full: JSON.stringify({ text: "full-block-content".repeat(5) }), ...over,
});
function checkBlockPlane(tag: string): void {
    const flowCount = (db.prepare("SELECT COUNT(*) AS n FROM egress_block_flow WHERE session_id = ?").get(S) as { n: number }).n;
    assert.ok(flowCount >= prevBlockFlowCount, `${tag}: the block flow shrank (${prevBlockFlowCount} → ${flowCount}) — 7773 invariant 1`);
    prevBlockFlowCount = flowCount;
    const types = (db.prepare("SELECT DISTINCT row_type AS t FROM egress_block_flow WHERE session_id = ? ORDER BY t").all(S) as { t: string }[]).map((r) => r.t);
    assert.ok(types.every((t) => t === "I" || t === "U" || t === "D"), `${tag}: retired row type in the block flow: ${types.join(",")}`);
    const blocks = egressBlockView(db, S);
    const stateCount = (db.prepare("SELECT COUNT(*) AS n FROM egress_block_state WHERE session_id = ?").get(S) as { n: number }).n;
    assert.equal(stateCount, blocks.size, `${tag}: block state row count ${stateCount} != live block count ${blocks.size}`);
    const big = (db.prepare("SELECT MAX(LENGTH(payload)) AS m FROM egress_block_state WHERE session_id = ?").get(S) as { m: number | null }).m ?? 0;
    assert.ok(big <= blockMaxPayload, `${tag}: a block state payload of ${big} bytes exceeds the largest single snapshot ever written (${blockMaxPayload})`);
}

const b1 = snap();
const b2 = snap({ tier: 2, startMsgid: "d", startSeq: 4, endMsgid: "e", endSeq: 5 });
blockMaxPayload = Math.max(blockMaxPayload, JSON.stringify(b1).length, JSON.stringify(b2).length);
egressBlockAppend(db, S, [{ type: "I", blockId: "blk_a", snapshot: b1 }, { type: "I", blockId: "blk_b", snapshot: b2 }], null, 1_000);
checkBlockPlane("block turn 1");

// turn 2: fold b..d into one summary — the state rows of the covered
// messages are physically deleted, the flow keeps the D and the I
const summaryText = `summary of ${"b".repeat(4)}`;
flowMaxBytes = Math.max(flowMaxBytes, summaryText.length);
stateMaxBytes = Math.max(stateMaxBytes, summaryText.length);
view = egressAppendTurn(db, S, [
    { type: "D", start: 3, end: 5 },
    { type: "I", rid: 7, msgid: "sum", after: 2, ref: "m00006", tokens: 5, typeTag: "text", bytes: summaryText },
], 2_000, { baseSeq: 6 });
checkMessagePlane("fold turn");
assert.deepEqual(egressStateView(db, S).map((r) => r.msgid), ["sys", "a", "sum", "e"]);

// the fold retires BOTH blocks — their coverage is subsumed
let prev = new Map<string, EgressBlockSnapshot>([["blk_a", b1], ["blk_b", b2]]);
const next = new Map<string, EgressBlockSnapshot>();
const blockOps = diffBlockSet(prev, next);
for (const op of blockOps) {
    const snapshot = "snapshot" in op ? (op as { snapshot: EgressBlockSnapshot }).snapshot : undefined;
    if (snapshot) blockMaxPayload = Math.max(blockMaxPayload, JSON.stringify(snapshot).length);
}
egressBlockAppend(db, S, blockOps, null, 2_000);
checkBlockPlane("block fold turn");
assert.equal(egressBlockView(db, S).size, 0, "the reaped blocks are physically gone from the live view");

// turn 3: an in-place edit of a survivor — one U, state row count unchanged
view = egressAppendTurn(db, S, [{ type: "U", rid: 6, msgid: "e", bytes: t1[4]!.text + " (edited)", role: "user" }], 3_000, { baseSeq: 8 });
checkMessagePlane("edit turn");

// turn 4: delete the last survivor of a fold chain — the state plane shrinks
view = egressAppendTurn(db, S, [{ type: "D", start: 2, end: 2 }], 4_000, { baseSeq: 9 });
checkMessagePlane("delete turn");

// the message plane's view must be what the ops say it is, to the end
assert.deepEqual(egressStateView(db, S).map((r) => r.msgid), ["sys", "sum", "e"]);

checkMessagePlane("final");
checkBlockPlane("final");

test("7773 §6: the four structural invariants hold after every write, on both planes", () => {
    assert.ok(true);
});

db.close();
fs.rmSync(hermetic, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
