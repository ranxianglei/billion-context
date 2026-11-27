// Structural wire-id identity (this PR). The real identity of a pinned core is
// the (wire-element, ordinal) pair; the on-wire/ledger id string is an INJECTIVE
// rendering of it. Legacy rendered the k-th sibling as `<base>#p<k>`, which was
// lossy: (elem X, ord 1) and (elem X#p1, ord 0) BOTH rendered to "X#p1". That
// only fires for a host that mints an id CONTAINING '#' — but it made the id
// space depend on a host promise instead of holding on its own.
//
// Now: a '#' -free element id renders VERBATIM (byte-identical to legacy for
// every real host); a '#' -containing one is injected into the reserved SIBMARK
// namespace (SIBMARK + base64url), so its cores can never equal a derived `#p<k>`
// sibling of another element. This suite locks: byte-identity, injectivity,
// round-trip inversion, the SIBMARK reservation, and the original collision.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    SIBMARK,
    renderCoreId,
    elementOfCore,
    applyMsgIdPin,
    applyWireMsgIdPin,
    wirePinGroups,
    validateMsgIds,
    validateWireMsgIds,
    wireElementIds,
} from "../src/msgid-pin.js";
import type { BiliMessage } from "acp-kernel/wire";

const core = (id: string, wireIndex: number, extra: Partial<BiliMessage> = {}): BiliMessage =>
    ({ id, role: "user", contentType: "text", text: `t-${id}`, wireIndex, ...extra }) as BiliMessage;

/** A few realistic 8-hex host ids (pi mints randomUUID().slice(0,8)). */
const HEX_IDS = ["1a2b3c4d", "9f0e1d2c", "00aabbcc", "deadbeef"];

test("byte-identity: '#' -free element renders exactly as legacy (head + siblings)", () => {
    for (const id of HEX_IDS) {
        assert.equal(renderCoreId(id, 0), id, "head core is the id verbatim");
        for (const k of [1, 2, 3]) assert.equal(renderCoreId(id, k), `${id}#p${k}`, "sibling is `<head>#p<k>` verbatim");
    }
});

test("byte-identity: applyMsgIdPin / applyWireMsgIdPin unchanged for '#' -free hosts", () => {
    // per-core 1:1 form
    const msgs = [core("d0", 0), core("d1", 1)];
    const pinned = applyMsgIdPin(msgs, HEX_IDS.slice(0, 2));
    assert.deepEqual(pinned.map((m) => m.id), HEX_IDS.slice(0, 2));

    // wire form with a split element — ids are the verbatim `<head>#p<k>` derivation
    const split = [core("d0", 0), core("a", 1), core("b", 1), core("c", 2)];
    const g = wirePinGroups(split)!;
    const pinned2 = applyWireMsgIdPin(split, g, ["e0", "e1", "e2"]);
    assert.deepEqual(pinned2.map((m) => m.id), ["e0", "e1", "e1#p1", "e2"]);
});

test("injectivity: distinct (element, ordinal) pairs always yield distinct ids", () => {
    // Mix of '#' -free and '#' -containing elements, many ordinals.
    const elements = [...HEX_IDS, "X", "X#p1", "a#b", "a#p1", "x-not-a-sib", "plain#tag", "#lead", "trailing#"];
    const seen = new Set<string>();
    for (const el of elements) {
        for (let k = 0; k < 4; k++) {
            const rendered = renderCoreId(el, k);
            assert.ok(!seen.has(rendered), `collision: (${JSON.stringify(el)}, ${k}) -> ${JSON.stringify(rendered)} already minted`);
            seen.add(rendered);
        }
    }
    assert.equal(seen.size, elements.length * 4);
});

test("the original collision is gone: (elem X, ord 1) no longer equals (elem X#p1, ord 0)", () => {
    // Element "X" (split into 2 cores) + element "X#p1" (single core). Legacy
    // rendered both cores of "X" as ["X", "X#p1"] and the "X#p1" element's head
    // as "X#p1" -> three ids with two distinct values. Now they are all distinct.
    const msgs = [core("a", 0), core("b", 0), core("c", 1)]; // wireIndex 0 splits (2 cores), wireIndex 1 is one
    const g = wirePinGroups(msgs)!;
    const ids = applyWireMsgIdPin(msgs, g, ["X", "X#p1"]).map((m) => m.id);
    assert.deepEqual(new Set(ids).size, ids.length, "all rendered ids are distinct");
    assert.equal(ids[0], "X");
    assert.equal(ids[1], "X#p1"); // sibling of element "X"
    // The "X#p1" element's head is injected into the SIBMARK namespace, NOT "X#p1".
    assert.ok(ids[2]!.startsWith(SIBMARK), `#-host element head is in the reserved namespace, got ${JSON.stringify(ids[2])}`);
    assert.notEqual(ids[2], "X#p1");
});

test("elementOfCore inverts renderCoreId for both '#' -free and '#' -containing elements", () => {
    const cases: Array<[string, number]> = [
        ["1a2b3c4d", 0],
        ["1a2b3c4d", 1],
        ["1a2b3c4d", 7],
        ["a#b", 0],
        ["a#b", 3],
        ["X#p1", 0], // the adversarial form — head
        ["X#p1", 2],
        ["#lead", 1],
        ["trailing#", 0],
    ];
    for (const [el, k] of cases) {
        const rendered = renderCoreId(el, k);
        const back = elementOfCore(rendered);
        assert.deepEqual(back, { element: el, ordinal: k }, `round-trip for (${JSON.stringify(el)}, ${k}) via ${JSON.stringify(rendered)}`);
    }
});

test("elementOfCore: '#' -free head is ordinal 0 with element === id (no suffix misparse)", () => {
    assert.deepEqual(elementOfCore("1a2b3c4d"), { element: "1a2b3c4d", ordinal: 0 });
});

test("SIBMARK namespace is reserved: host ids in it are rejected (per-core + wire)", () => {
    const perCore = validateMsgIds([`${SIBMARK}abc`, "1a2b3c4d"], 2);
    assert.equal(perCore.ok, false);
    assert.equal((perCore as { reason: string }).reason, "reserved-prefix");

    const g = wirePinGroups([core("d0", 0)])!;
    const wire = validateWireMsgIds([`${SIBMARK}not-a-sib`], g);
    assert.equal(wire.ok, false);
    assert.equal((wire as { reason: string }).reason, "reserved-prefix");
});

test("validateMsgIds still accepts '#' -containing ids (we encode them, not reject them)", () => {
    const ok = validateMsgIds(["a#b", "1a2b3c4d"], 2);
    assert.equal(ok.ok, true);
});

test("wireElementIds: drops siblings, returns DECODED element ids ('#' -host and '#' -free)", () => {
    // A split '#' -containing element "a#b": cores render to SIBMARK form; the
    // element list must come back as the raw "a#b" (what the host resends).
    const eb = renderCoreId("a#b", 0);
    assert.deepEqual(wireElementIds([eb, renderCoreId("a#b", 1), renderCoreId("a#b", 2)]), ["a#b"]);

    // A split '#' -free element: cores render to id / id#p1; element list is [id].
    assert.deepEqual(wireElementIds(["1a2b3c4d", "1a2b3c4d#p1", "1a2b3c4d#p2"]), ["1a2b3c4d"]);

    // Mixed flat view (each element a single head core) — all survive, decoded.
    assert.deepEqual(wireElementIds([renderCoreId("a#b", 0), "1a2b3c4d"]), ["a#b", "1a2b3c4d"]);
});

test("encode/decode is stable and #p-suffix-free in the base (base64url has no '#')", () => {
    const e = "a#b#c"; // multiple '#'
    const base = renderCoreId(e, 0);
    assert.ok(base.startsWith(SIBMARK));
    assert.ok(!base.includes("#"), "encoded base is '#' -free, so the #p suffix is unambiguous");
    assert.equal(elementOfCore(base).element, e);
});
