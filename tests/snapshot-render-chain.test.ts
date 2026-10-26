/**
 * #4052 — covered rows must not accept signature binds in the snapshot-render
 * backward chain.
 *
 * The chain binds the client's re-sent history onto server transcript rows (id
 * fast path, then role|type|text signature). A NEW message whose identity
 * signature collides with an already-folded (covered) row used to bind onto
 * that row: the join moved past it, and the engine's covered-row suppression
 * then erased the message's content from the outbound view — the model never
 * saw the user's latest message. Covered rows are excluded from bySig; byId
 * keeps them (an exact id is unambiguous and steady-state seams need it).
 *
 * These drive maybeSnapshotView directly against a fabricated transcript —
 * the same buildView-replay verification shape the issue used to find the
 * counterexample. Gate discipline (#3617): every positive case has its
 * negative twin below.
 */

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "shadow";

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the config resolver at a non-existent temp file so no real user
// config can leak into these cases.
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-snap-chain-")), "no-config.json");
// Force the D lane on for this process regardless of bucket.
process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";

import type { BiliMessage } from "acp-kernel/wire";
import { maybeSnapshotView } from "../src/server/snapshot-render.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { Session } from "../src/session.ts";

function msg(id: string, text: string, role: BiliMessage["role"] = "user"): BiliMessage {
    return { id, role, contentType: "text", text } as BiliMessage;
}

type BlockLike = { blockId: string; active: boolean; effectiveMessageIds: string[] };

let nextSessionId = 0;

/** Install a fabricated unified-store tail view and render `client` through it. */
function render(blocks: BlockLike[], client: BiliMessage[], rows: BiliMessage[]): { session: Session; view: BiliMessage[] } {
    const rawRows = rows.map((m, i) => ({ seq: i + 1, msgId: m.id, content: JSON.stringify(m) }));
    const inWindow = (seq: number, intervals: readonly [number, number][]) => intervals.some(([a, b]) => seq >= a && seq <= b);
    const fake = {
        unifiedTailSeqs: () => rawRows.map((r) => r.seq),
        unifiedTailViewRows: () => rawRows,
        unifiedMessageIdRows: () => rawRows.map(({ seq, msgId }) => ({ seq, msgId })),
        unifiedUncoveredRows: (_id: string, intervals: readonly [number, number][]) => rawRows.filter((r) => !inWindow(r.seq, intervals)),
    };
    _setStoreForTest(fake as unknown as SessionStore);
    nextSessionId++;
    const session = {
        id: `sess-snap-chain-${nextSessionId}`,
        state: { blocks },
        metadata: {},
    } as unknown as Session;
    const view = maybeSnapshotView(session, client, { sessionId: session.id });
    return { session, view };
}

function assertRendered(session: Session): void {
    const turns = session.metadata["snapshotRenderTurns"];
    assert.ok(
        typeof turns === "number" && turns >= 1,
        `expected engine render, got degrade=${String(session.metadata["snapshotRenderDegradeReason"])}`,
    );
}

function assertDegraded(session: Session, reason: string, view: BiliMessage[], client: BiliMessage[]): void {
    assert.equal(session.metadata["snapshotRenderDegradeReason"], reason);
    assert.equal(view, client, "degrade must return the client view untouched (same reference)");
}

test("#4052: new message colliding with a COVERED row rides the tail — never vanishes", () => {
    // The issue's exact replay shape: mF is a fresh message whose
    // role|contentType|text equals folded row r2 (different id).
    const rows = [msg("r1", ""), msg("r2", "D"), msg("r3", "")];
    const client = [msg("r1", ""), msg("r2", "D"), msg("f-new", "D")];
    const { session, view } = render([{ blockId: "b1", active: true, effectiveMessageIds: ["r2"] }], client, rows);
    assertRendered(session);
    // Pre-fix this was [r1, acp_summary_b1] — "D" (the latest message) gone.
    assert.deepEqual(view.map((m) => m.id), ["r1", "acp_summary_b1", "f-new"]);
    assert.equal(view[2].text, "D");
});

test("#4052 gate: uncovered rows still accept signature binds (upgrade-twin path intact)", () => {
    // Every client id re-minted; only the anchor row is covered. The seam must
    // still form via signatures on the UNCOVERED rows (c, b), with the
    // covered twin A1 tolerated as the one gap.
    const rows = [msg("a", "P"), msg("c", "Q"), msg("b", "R")];
    const client = [msg("A1", "P"), msg("C1", "Q"), msg("B1", "R")];
    const { session, view } = render([{ blockId: "b1", active: true, effectiveMessageIds: ["a"] }], client, rows);
    assertRendered(session);
    assert.deepEqual(view.map((m) => m.id), ["acp_summary_b1", "c", "b"]);
    assert.deepEqual(view.map((m) => m.text), ["", "Q", "R"]);
});

test("#4052 gate: chain breaks at a mid-history covered region WITHOUT truncating the prefix", () => {
    // Covered region c,d sits mid-transcript and all ids are re-minted: the
    // sig hits on c,d are now refused, so the chain breaks at the region's top
    // edge — but the join stays at the tail, so rows above the region (a,b)
    // still render behind their anchor instead of being rewound away.
    const rows = [msg("a", "P"), msg("b", "Q"), msg("c", "R"), msg("d", "S"), msg("e", "T"), msg("f", "U")];
    const client = [msg("A1", "P"), msg("B1", "Q"), msg("C1", "R"), msg("D1", "S"), msg("E1", "T"), msg("F1", "U")];
    const { session, view } = render([{ blockId: "b1", active: true, effectiveMessageIds: ["c", "d"] }], client, rows);
    assertRendered(session);
    assert.deepEqual(view.map((m) => m.id), ["a", "b", "acp_summary_b1", "e", "f"]);
    assert.deepEqual(view.map((m) => m.text), ["P", "Q", "", "T", "U"]);
});

test("#4052 gate: steady-state exact-id seam keeps binding covered rows via byId", () => {
    // No re-minting at all: the covered row a must still bind by exact id or
    // the ordinary post-compression turn would degrade needlessly.
    const rows = [msg("a", "P"), msg("b", "Q")];
    const client = [msg("a", "P"), msg("b", "Q"), msg("n1", "X")];
    const { session, view } = render([{ blockId: "b1", active: true, effectiveMessageIds: ["a"] }], client, rows);
    assertRendered(session);
    assert.deepEqual(view.map((m) => m.id), ["acp_summary_b1", "b", "n1"]);
    assert.deepEqual(view.map((m) => m.text), ["", "Q", "X"]);
});

test("#4052 gate: a seam resting solely on covered-row sig hits degrades instead of guessing", () => {
    // The only row is covered and the client's sole message is its re-minted
    // twin: with covered rows out of bySig nothing can chain — degrade to the
    // legacy path rather than render an empty-ish view.
    const rows = [msg("a", "P")];
    const client = [msg("A1", "P")];
    const { session, view } = render([{ blockId: "b1", active: true, effectiveMessageIds: ["a"] }], client, rows);
    assertDegraded(session, "chain-not-started", view, client);
});

test("#4052 gate: a lone uncovered match still degrades as seam-too-short (#3812 MIN_SEAM_RUN intact)", () => {
    // Exactly one match in the whole walk (the re-minted twin b of the
    // uncovered row; the covered twin A1 no longer counts): run stays at 1,
    // below MIN_SEAM_RUN — the #3812 short-seam protection must survive the
    // #4052 change.
    const rows = [msg("a", "P"), msg("b", "Q")];
    const client = [msg("A1", "P"), msg("B1", "Q")];
    const { session, view } = render([{ blockId: "b1", active: true, effectiveMessageIds: ["a"] }], client, rows);
    assertDegraded(session, "seam-too-short", view, client);
});
