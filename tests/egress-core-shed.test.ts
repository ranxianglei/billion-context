/**
 * #7693: the core-space image shed (src/egress-core-shed.ts) — archiving
 * over-budget images IN the recorded egress flow so wire = flow = kernel
 * input = client view. Pinned contract:
 *   - selection mirrors the wire shed's rung A: oldest first, protected
 *     tail (newest 8) yields only for a hard count wall (two passes);
 *   - exemptions survive: read_original_image outputs + receipt-verified
 *     originals are never archived;
 *   - the placeholder is a foldable text row: same id/role, note text,
 *     every image sidecar cleared, input never mutated;
 *   - deterministic + idempotent (the recorded bytes are stable across
 *     turns — that is the fix);
 *   - recording the shed core emits a `U` op for the archived row (same
 *     msgid, new bytes) and then NO ops at all (byte stability);
 *   - the authority probe exempts the by-design placeholder-vs-original
 *     divergence pair.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { BiliMessage } from "acp-kernel/wire";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema } from "../src/storage/schema.ts";
import { egressAppendTurn, egressFlowWalkBack, egressStateAt, egressStateView, type EgressOp } from "../src/storage/egress-state.ts";
import { recordEgressTurn, type EgressOpLogStore } from "../src/storage/egress-record.ts";
import { shedCoreImages, coreImageShedNote, CORE_IMAGE_SHED_NOTE_RE } from "../src/egress-core-shed.ts";
import { egressAuthorityProbe } from "../src/server/egress-lane-io.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-core-shed-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

const B64 = "aGVsbG8td29ybGQtYnl0ZXM="; // some bytes; decodeImageDims → undefined (not a real image)

function imageRow(id: string, text = "[image]"): BiliMessage {
    return { id, role: "user", contentType: "text", text, imagePart: true, imageBase64: B64, imageMediaType: "image/png" };
}
const M = (id: string, text: string, role: BiliMessage["role"] = "user"): BiliMessage => ({ id, role, contentType: "text", text });

test("shedCoreImages: no targets / nothing to shed → unchanged", () => {
    const conv = [M("m1", "hi"), imageRow("m2")];
    for (const targets of [undefined, {}, { maxImages: 10 }, { maxBytes: 1 << 30 }]) {
        const r = shedCoreImages(conv, targets);
        assert.equal(r.changed, false, JSON.stringify(targets));
        assert.equal(r.archived, 0);
        assert.deepEqual(r.rows, conv.map((m) => ({ ...m })), "rows deep-equal the input");
    }
});

test("shedCoreImages: count wall archives oldest non-tail first, tail yields on the second pass", () => {
    // 12 image rows + 1 text row at the front: 13 entries, protectFrom = 5 →
    // rows at index >= 5 (8 rows) are protected in pass 1.
    const conv: BiliMessage[] = [M("m0", "start")];
    for (let i = 1; i <= 12; i++) conv.push(imageRow(`mi${i}`));
    // maxImages = 10 → archive 2: the two OLDEST (mi1, mi2 — indices 1,2, both < 5).
    let r = shedCoreImages(conv, { maxImages: 10 });
    assert.equal(r.archived, 2);
    assert.ok(CORE_IMAGE_SHED_NOTE_RE.test(r.rows[1].text ?? ""), "mi1 replaced by a placeholder note");
    assert.ok(CORE_IMAGE_SHED_NOTE_RE.test(r.rows[2].text ?? ""));
    assert.equal(r.rows[3].imagePart, true, "mi3 untouched (10 images remain)");
    // maxImages = 5 → pass 1 archives mi1..mi4 (indices 1..4, all < 5);
    // 8 images remain > 5 → pass 2 archives from the tail: mi5, mi6, mi7.
    r = shedCoreImages(conv, { maxImages: 5 });
    assert.equal(r.archived, 7);
    for (const i of [1, 2, 3, 4, 5, 6, 7]) assert.ok(CORE_IMAGE_SHED_NOTE_RE.test(r.rows[i].text ?? ""), `index ${i} archived`);
    assert.equal(r.rows[8].imagePart, true, "mi8+ untouched (5 images remain)");
});

test("shedCoreImages: byte budget archives oldest non-tail only (rung A)", () => {
    const fat = "a".repeat(200_000); // ~200KB of "b64"
    const conv: BiliMessage[] = [imageRow("img1", "[image]"), M("m2", "text"), imageRow("img3", "[image]")];
    conv[0] = { ...conv[0], imageBase64: fat };
    // systemTextBytes 0 + wrapper 512KiB + rows: img1 ~200KB + tiny + img3 tiny
    // ≈ 750KB < maxBytes 900KB → no shed.
    let r = shedCoreImages(conv, { maxBytes: 900 * 1024 });
    assert.equal(r.changed, false, "under budget → untouched");
    // maxBytes 700KB → over → archive the oldest non-tail. The protected
    // tail is the newest 8 = ALL of these 3 rows… so rung A has nothing to
    // archive (the byte shed never touches the tail; the relay backstop
    // owns that division of labor).
    r = shedCoreImages(conv, { maxBytes: 700 * 1024 });
    assert.equal(r.changed, false, "byte shed is tail-protected — the backstop owns rung B");
    // Same with 12 rows: the oldest 4 are outside the protected tail.
    const big: BiliMessage[] = [];
    for (let i = 0; i < 12; i++) big.push(i % 2 === 0 ? { ...imageRow(`img${i}`), imageBase64: "b".repeat(100_000) } : M(`t${i}`, "x"));
    const rb = shedCoreImages(big, { maxBytes: 900 * 1024 });
    assert.ok(rb.archived > 0, "archives oldest non-tail image rows");
    const archivedIdx = rb.rows.map((r, i) => (CORE_IMAGE_SHED_NOTE_RE.test(r.text ?? "") ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(archivedIdx, [0, 2], "the two oldest NON-tail image rows, oldest first (tail-protected ones survive)");
});

test("shedCoreImages: exemptions — read_original_image outputs and receipts never archive", () => {
    const b64 = B64;
    const sha = createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
    const receipt = `Billion original image receipt v1 sha256=${sha}`;
    const toolResult: BiliMessage = { id: "tool1", role: "tool", contentType: "tool-result", text: "[image]", toolName: "acp_read_original_image", imagePart: true, imageBase64: b64, imageMediaType: "image/png" };
    const receipted: BiliMessage = { ...imageRow("img1"), text: "[image]" };
    // 12 filler image rows push the protected tail past index 0… actually we
    // want the exempt rows OUTSIDE the tail: put them at the front.
    const conv: BiliMessage[] = [
        toolResult,
        { ...receipted, text: receipt },
        imageRow("img3"),
    ];
    for (let i = 4; i <= 14; i++) conv.push(imageRow(`fill${i}`));
    const r = shedCoreImages(conv, { maxImages: 4 });
    assert.equal(r.rows[0].imagePart, true, "read_original_image output survives even on a hard wall");
    assert.equal(r.rows[1].imagePart, true, "receipt-verified original survives");
    assert.ok(CORE_IMAGE_SHED_NOTE_RE.test(r.rows[2].text ?? "") || r.rows[2].imagePart === true); // img3: pass-1 candidate
});

test("shedCoreImages: the placeholder is a foldable text row; input is never mutated", () => {
    const original: BiliMessage = {
        id: "m00042",
        role: "user",
        contentType: "text",
        text: "[image]",
        imagePart: true,
        imageBase64: B64,
        imageMediaType: "image/jpeg",
        rawOpenaiContent: { type: "image_url", image_url: { url: "data:image/jpeg;base64,x" } },
    };
    const conv: BiliMessage[] = [original];
    for (let i = 1; i < 10; i++) conv.push(M(`t${i}`, "padding"));
    const before = JSON.stringify(conv);
    const r = shedCoreImages(conv, { maxImages: 0 });
    assert.equal(r.archived, 1);
    assert.equal(JSON.stringify(conv), before, "input array untouched (no mutation)");
    const note = r.rows[0];
    assert.notEqual(note, original, "archived row is a NEW object");
    assert.equal(note.id, "m00042", "msgid preserved (the U op rides on it)");
    assert.equal(note.role, "user");
    assert.equal(note.contentType, "text");
    assert.ok(CORE_IMAGE_SHED_NOTE_RE.test(note.text ?? ""));
    assert.ok((note.text ?? "").includes("m00042"), "the ref is the row's own mNNNNN id");
    assert.ok((note.text ?? "").includes("jpeg"));
    for (const k of ["imageBase64", "imageMediaType", "imagePart", "rawOpenaiContent", "rawOpenaiContentParts", "rawAnthropicBlock", "rawResponsesItem", "rawGoogleParts"]) {
        assert.ok(!(k in note), `${k} cleared`);
    }
});

test("shedCoreImages: deterministic and idempotent (byte-stable across turns)", () => {
    const conv: BiliMessage[] = [M("t0", "start")];
    for (let i = 1; i <= 12; i++) conv.push({ ...imageRow(`img${i}`), imageBase64: "c".repeat(i * 50_000) });
    const targets = { maxImages: 6, maxBytes: 600 * 1024 };
    const r1 = shedCoreImages(conv, targets);
    const r2 = shedCoreImages(conv, targets);
    assert.deepEqual(r1.rows, r2.rows, "same inputs → same output");
    assert.equal(JSON.stringify(r1.rows), JSON.stringify(r2.rows), "byte-stable");
    const again = shedCoreImages(r1.rows, targets);
    assert.equal(again.changed, false, "shedding the shed output is a no-op (converged)");
    assert.deepEqual(again.rows, r1.rows);
});

test("note format matches the wire shed's shape", () => {
    const n = coreImageShedNote("image/png", undefined, "m00017");
    assert.equal(n, "[image: png m00017 omitted for size limit]");
    const n2 = coreImageShedNote(undefined, B64, "");
    assert.equal(n2, "[image:  omitted for size limit]", "no mime/dims/ref → empty middle, still the note shape");
    assert.match(n2, /^\[image: .* omitted for size limit\]$/);
    assert.ok(CORE_IMAGE_SHED_NOTE_RE.test(n) && CORE_IMAGE_SHED_NOTE_RE.test(n2));
});

// ---- recording integration: a shed row rewrites its BYTES under the same
// msgid → exactly one `U` op, then zero ops (stability across turns) ----

function openStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-egress-core-shed-"));
    const { db } = openSqliteDatabase(path.join(dir, "index.db"));
    migrateSchema(db);
    const captured: EgressOp[][] = [];
    const store: EgressOpLogStore = {
        egressAppendTurn: (sid, ops, baseSeq, nowMs) => {
            captured.push(ops.map((o) => ({ ...o })));
            return egressAppendTurn(db, sid, ops, nowMs, { baseSeq });
        },
        egressStateView: (sid) => egressStateView(db, sid),
        egressStateViewAt: (sid, seq) => egressStateAt(db, sid, seq),
        egressFlowWalkBack: (sid) => egressFlowWalkBack(db, sid),
        egressStateMaxSeq: (sid) => (db.prepare(`SELECT COALESCE(MAX(op_seq), 0) AS mx FROM egress_flow WHERE session_id = ?`).get(sid) as { mx: number }).mx,
        egressStateTruncateAfter: (sid, seq) => {
            const a = db.prepare(`DELETE FROM egress_state WHERE session_id = ? AND op_seq > ?`).run(sid, seq);
            const b = db.prepare(`DELETE FROM egress_flow WHERE session_id = ? AND op_seq > ?`).run(sid, seq);
            return Number(a.changes) + Number(b.changes);
        },
    };
    return { db, dir, store, captured };
}

test("recordEgressTurn: archived row → one U op (same msgid, new bytes), then zero ops", () => {
    const H = openStore();
    const S = "s-core-shed";
    try {
        const full: BiliMessage[] = [M("t0", "start")];
        for (let i = 1; i <= 10; i++) full.push({ ...imageRow(`img${i}`), imageBase64: "d".repeat(i * 60_000) });
        const targets = { maxImages: 4 };

        let view = recordEgressTurn({ store: H.store, sessionId: S, prev: undefined, conversation: full, systemText: "sys", nowMs: 1 });
        assert.equal(view.length, 12, "system + t0 + 10 rows after turn 1");
        assert.equal(H.captured.length, 1);
        assert.ok(H.captured[0].every((o) => o.type === "I"), "turn 1 is all +I");

        // Turn 2: same rows, but the flow now archives the over-cap images.
        const shed2 = shedCoreImages(full, targets);
        assert.ok(shed2.archived > 0, "precondition: something is archivable");
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: view, conversation: shed2.rows, systemText: "sys", nowMs: 2 });
        const ops2 = H.captured[H.captured.length - 1];
        const us = ops2.filter((o) => o.type === "U");
        assert.equal(us.length, shed2.archived, "exactly one U per archived row");
        assert.ok(ops2.every((o) => o.type === "U"), "no I/D — same msgids, rewritten bytes");
        const archivedIds = new Set(full.map((m) => m.id).filter((id) => !shed2.rows.some((r) => r.id === id && r.imagePart === true)));
        for (const u of us) assert.ok(archivedIds.has(u.msgid), `U rides the archived row's msgid (${u.msgid})`);
        assert.equal(view.length, 12, "row count unchanged (U rewrites in place)");

        // Turn 3: identical shed rows → NO ops (the byte stability the
        // cache seam relies on).
        const shed3 = shedCoreImages(full, targets);
        view = recordEgressTurn({ store: H.store, sessionId: S, prev: view, conversation: shed3.rows, systemText: "sys", nowMs: 3 });
        assert.equal(H.captured.length, 2, "turn 3 appended nothing — the view is byte-stable");
    } finally {
        H.db.close();
        fs.rmSync(H.dir, { recursive: true, force: true });
    }
});

// ---- probe: the by-design placeholder-vs-original pair is exempt ----

test("egressAuthorityProbe: placeholder-vs-original divergence is exempt; real divergence still warns", () => {
    const warn: string[] = [];
    const log = (level: string, msg: string) => {
        if (level === "warn") warn.push(msg);
    };
    const base: BiliMessage[] = [
        M("m00001", "[image] replaced in flow"),
        // the flow row holds the note; the client row holds the original.
        { id: "m00002", role: "user", contentType: "text", text: coreImageShedNote("image/png", B64, "m00002") },
    ];
    for (let i = 3; i <= 20; i++) base.push(M(`m0000${i}`, `text ${i}`));
    const client = base.map((b) => ({ ...b }));
    const original: BiliMessage = { id: "m00002", role: "user", contentType: "text", text: "[image]", imagePart: true, imageBase64: B64, imageMediaType: "image/png" };
    client[1] = original;
    const ok = egressAuthorityProbe(base, client, "s-probe", log);
    assert.equal(ok, true, "order intact → probe passes");
    // A pair at a sampled index must not warn:
    const warnBefore = warn.length;
    const base10 = base.slice(0, 10); // step = 1 → every row sampled
    const client10 = client.slice(0, 10);
    const ok2 = egressAuthorityProbe(base10, client10, "s-probe2", log);
    assert.equal(ok2, true);
    assert.equal(warn.length, warnBefore, "placeholder-vs-original pair does not count as divergence");
    // A REAL divergence (client edited text of a non-image row) still warns.
    const clientBad = client10.map((c, i) => (i === 4 ? { ...c, text: "DIFFERENT TEXT!" } : c));
    const ok3 = egressAuthorityProbe(base10, clientBad, "s-probe3", log);
    assert.equal(ok3, true, "divergence never fails the probe");
    assert.equal(warn.length, warnBefore + 1, "real divergence is still logged");
});
