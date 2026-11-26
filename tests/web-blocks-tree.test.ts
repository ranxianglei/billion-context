import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { collectBlockContent, createInitialState, defaultCountTokens } from "acp-kernel";
import type { CompressionBlock, CoreMessage } from "acp-kernel";
import { LazyBlockContents, _resetSessionsForTest, getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetDiskCacheForTest, buildBlockContent, buildMessageContent, buildSessionDetail, buildSessionTree } from "../src/web/sessions-data.ts";
import { MESSAGES } from "../src/web/i18n.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { WEB_STYLES } from "../src/web/styles.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_SESSIONS_DIR = mkdtempSync(path.join(tmpdir(), "bili-blocks-tree-sess-"));
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-blocks-tree-")), "no-config.json");

// #3917: the compression-tree lane is read-only web diagnostics — no store, no
// disk, every fixture is an in-memory live session.
_setStoreForTest(new SessionStore({ enabled: false }));

function mkBlock(
    blockId: string,
    tier: number,
    summary: string,
    direct: string[],
    effective: string[],
    kids: string[] = [],
    span?: [string, string],
): CompressionBlock {
    return {
        blockId,
        runId: "run-1",
        tier: tier as CompressionBlock["tier"],
        summary,
        directMessageIds: direct,
        effectiveMessageIds: effective,
        directBlockIds: kids,
        compressedTokens: 1000 * tier,
        createdAt: 1_700_000_000_000 - 1000 * tier,
        survivedCount: 0,
        generation: "young",
        active: true,
        ...(span ? { startRef: span[0], endRef: span[1] } : {}),
    };
}

function seedSession(id: string, blocks: CompressionBlock[]): ReturnType<typeof getSession> {
    _resetSessionsForTest();
    const s = getSession(id, { protocol: "openai" });
    s.state = createInitialState();
    s.state.blocks = blocks;
    s.blockContents = new LazyBlockContents(id, {}, () => null);
    return s;
}

test("#3917: detail carries fold-parent links and summary accounting for the tree", async () => {
    const t1 = mkBlock("b1", 1, "## T1 summary\n- point one", ["rm1", "rm2"], ["rm1", "rm2"], [], ["m00001", "m00002"]);
    const t2 = mkBlock("b2", 2, "T2 summary", ["rm3"], ["rm1", "rm2", "rm3"], ["b1"], ["m00001", "m00003"]);
    seedSession("tree-1", [t1, t2]);
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-1");
    assert.ok(d, "live session resolves");
    const byId = new Map(d.blockDetails.map((b) => [b.blockId, b]));
    const b1 = byId.get("b1")!;
    const b2 = byId.get("b2")!;
    assert.equal(b1.parentBlockId, "b2", "the folded child points at the block that absorbed it");
    assert.equal(b2.parentBlockId, undefined, "a root has no fold parent");
    assert.deepEqual(b2.directBlockIds, ["b1"], "children survive in the payload so the tree can nest");
    assert.equal(b1.effectiveMessageCount, 2);
    assert.equal(b1.directMessageCount, 2);
    assert.equal(b1.summaryTokens, defaultCountTokens(t1.summary), "summary tokens are the kernel's own count");
    assert.equal(b1.summaryBytes, Buffer.byteLength(t1.summary));
    assert.equal(b2.startRef, "m00001");
    assert.equal(b2.endRef, "m00003");
    assert.equal(b1.active, true);
});

test("#3917: buildBlockContent serves one/full views and reports honest misses", async () => {
    const s = seedSession("tree-content", [mkBlock("b1", 1, "s", ["m1"], ["m1"])]);
    s.blockContents.set("b1", { one: { text: "one-body", count: 1 }, full: { text: "full-body-longer", count: 3 } });

    const one = await buildBlockContent("tree-content", "b1", "one");
    assert.ok(one.ok);
    assert.equal(one.text, "one-body");
    assert.equal(one.count, 1);
    assert.equal(one.view, "one");
    assert.equal(one.bytes, Buffer.byteLength("one-body"));
    assert.equal(one.totalBytes, one.bytes);
    assert.equal(one.truncated, false);

    const full = await buildBlockContent("tree-content", "b1", "full");
    assert.ok(full.ok);
    assert.equal(full.text, "full-body-longer");
    assert.equal(full.count, 3);

    assert.deepEqual(await buildBlockContent("tree-content", "missing", "one"), { ok: false, reason: "unknown-block" });
    assert.deepEqual(await buildBlockContent("no-such-session", "b1", "one"), { ok: false, reason: "unknown-session" });

    s.state.blocks.push(mkBlock("b2", 1, "no snapshot", [], []));
    assert.deepEqual(await buildBlockContent("tree-content", "b2", "one"), { ok: false, reason: "no-content-snapshot" });
});

test("#3917: an oversized block truncates at the byte cap and still reports the full size", async () => {
    const s = seedSession("tree-big", [mkBlock("b1", 1, "s", ["m1"], ["m1"])]);
    const huge = "x".repeat(2 * 1024 * 1024 + 64);
    s.blockContents.set("b1", { one: { text: huge, count: 9 }, full: { text: huge, count: 9 } });
    const r = await buildBlockContent("tree-big", "b1", "full");
    assert.ok(r.ok);
    assert.equal(r.truncated, true);
    assert.equal(r.bytes, 2 * 1024 * 1024);
    assert.equal(r.totalBytes, huge.length);
    assert.equal(r.text.length, 2 * 1024 * 1024);
});

test("#3917: a block stored before directBlockIds existed neither throws nor nests", async () => {
    const legacy = mkBlock("b1", 1, "s", ["m1"], ["m1"]);
    delete (legacy as { directBlockIds?: string[] }).directBlockIds;
    delete (legacy as { effectiveMessageIds?: string[] }).effectiveMessageIds;
    delete (legacy as { directMessageIds?: string[] }).directMessageIds;
    seedSession("tree-legacy", [legacy]);
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-legacy");
    assert.ok(d, "a partial legacy block still renders");
    const b1 = d.blockDetails[0];
    assert.deepEqual(b1.directBlockIds, []);
    assert.equal(b1.effectiveMessageCount, 0);
    assert.equal(b1.directMessageCount, 0);
    assert.deepEqual(b1.directMessageRefs, []);
    assert.equal(b1.parentBlockId, undefined);
});

test("#3917: message leaves name each folded message and serve its text lazily", async () => {
    const s = seedSession("tree-msgs", [mkBlock("b1", 1, "s", ["rm1", "rm2"], ["rm1", "rm2"])]);
    s.state.messageRefs = { byRaw: { rm1: "m00001", rm2: "m00002" }, byRef: { m00001: "rm1", m00002: "rm2" } };
    s.lastMessages = [
        { id: "rm1", role: "user", contentType: "text", text: "hello   there\nworld" },
        { id: "rm2", role: "assistant", contentType: "text", text: "hi" },
    ];
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-msgs");
    assert.ok(d);
    assert.deepEqual(d.blockDetails[0].directMessages, [
        { ref: "m00001", role: "user", preview: "hello there world" },
        { ref: "m00002", role: "assistant", preview: "hi" },
    ]);
    const one = await buildMessageContent("tree-msgs", "m00001");
    assert.ok(one.ok);
    assert.equal(one.role, "user");
    assert.equal(one.text, "hello   there\nworld", "the leaf serves the message verbatim, whitespace intact");
    assert.equal(one.totalBytes, Buffer.byteLength("hello   there\nworld"));
    assert.deepEqual(await buildMessageContent("tree-msgs", "m99999"), { ok: false, reason: "unknown-message" });
    assert.deepEqual(await buildMessageContent("no-such-session", "m00001"), { ok: false, reason: "unknown-session" });
});

for (const [name, text, preview] of [
    ["empty text", "", ""],
    ["short ASCII", "x".repeat(109), "x".repeat(109)],
    ["exact ASCII limit", "x".repeat(110), "x".repeat(110)],
    ["over ASCII limit", "x".repeat(111), "x".repeat(110) + "…"],
    ["exact astral limit", "😀".repeat(110), "😀".repeat(110)],
    ["over astral limit", "😀".repeat(111), "😀".repeat(110) + "…"],
    ["astral boundary", "x".repeat(109) + "😀tail", "x".repeat(109) + "😀…"],
    ["combining code points", "e\u0301".repeat(56), "e\u0301".repeat(55) + "…"],
    ["Unicode whitespace", " \talpha\r\n\u00a0beta\u2028\u2029gamma\ufeff ", "alpha beta gamma"],
    ["whitespace-only tail", "x".repeat(110) + "\r\n\t ", "x".repeat(110)],
    ["collapsed boundary", "x".repeat(109) + "\r\n\t tail", "x".repeat(109) + " …"],
    ["existing lone surrogate", "x".repeat(109) + "\ud800tail", "x".repeat(109) + "\ud800…"],
] as const) {
    test(`message preview preserves ${name}`, async () => {
        const s = seedSession("preview-boundary", [mkBlock("b1", 1, "summary", ["rm1"], ["rm1"])]);
        s.state.messageRefs = { byRaw: { rm1: "m00001" }, byRef: { m00001: "rm1" } };
        s.lastMessages = [{ id: "rm1", role: "tool", contentType: "text", text }];
        const detail = await buildSessionDetail(s.id);
        assert.ok(detail);
        assert.deepEqual(detail.blockDetails[0].directMessages, [{ ref: "m00001", role: "tool", preview }]);
        assert.equal(s.lastMessages?.[0]?.text, text, "rendering must not modify the retained message");
    });
}

test("#3917: a folded message the host pruned reports a miss instead of a guess", async () => {
    const s = seedSession("tree-pruned", [mkBlock("b1", 1, "s", ["rm1"], ["rm1"])]);
    s.state.messageRefs = { byRaw: { rm1: "m00001" }, byRef: { m00001: "rm1" } };
    s.lastMessages = [];
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-pruned");
    assert.ok(d);
    assert.deepEqual(d.blockDetails[0].directMessages, [{ ref: "m00001", missing: true }], "the ref survives even when its bytes are gone");
    assert.equal(d.blockDetails[0].directMessageCount, 1, "but the count still says one message was folded");
    assert.equal(d.blockDetails[0].directMessageRefs.length, 1, "and its ref is still named");
    assert.deepEqual(await buildMessageContent("tree-pruned", "m00001"), { ok: false, reason: "unknown-message" });
});

test("frozen-snapshot hydration: a leaf block's pruned messages re-align by position", async () => {
    const s = seedSession("tree-snap", [mkBlock("b1", 1, "s", ["rm1", "rm2", "rm3"], ["rm1", "rm2", "rm3"])]);
    s.state.messageRefs = { byRaw: { rm1: "m00001", rm2: "m00002", rm3: "m00003" }, byRef: { m00001: "rm1", m00002: "rm2", m00003: "rm3" } };
    s.lastMessages = [];
    // collectBlockContent's full view: [role] (or [role • toolName]) header
    // per message, pi-host user text opens with its ACP ref marker.
    const full = [
        "[user]",
        '<acp tokens="2" type="text">m00001</acp>',
        "hello world",
        "",
        "[assistant]",
        "said hi",
        "",
        "[tool \u2022 read]",
        "/path/x.ts:1-9",
    ].join("\n");
    s.blockContents.set("b1", { one: null, full: { text: full, count: 3 } });
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-snap");
    assert.ok(d);
    assert.deepEqual(d.blockDetails[0].directMessages, [
        { ref: "m00001", role: "user", preview: "hello world" },
        { ref: "m00002", role: "assistant", preview: "said hi" },
        { ref: "m00003", role: "tool", toolName: "read", preview: "/path/x.ts:1-9" },
    ], "window + store pruned — the frozen snapshot re-aligns by position");
    const one = await buildMessageContent("tree-snap", "m00003");
    assert.ok(one.ok);
    assert.equal(one.role, "tool");
    assert.equal(one.text, "/path/x.ts:1-9", "click-to-open serves the snapshot bytes");
});

for (const [label, text] of [
    ["leading blank lines", "\n\n  first line"],
    ["trailing blank lines", "last line\n\n"],
    ["only blank lines", "\n\n"],
    ["CRLF content", "\r\n  mixed\r\n\n"],
    ["empty content", ""],
    ["ordinary content", "one\n  two"],
] as const) {
    for (const at of [0, 1, 2]) {
        test(`frozen snapshot preserves ${label} at message ${at + 1}`, async () => {
            const ids = ["raw-1", "raw-2", "raw-3"];
            const block = mkBlock("b1", 1, "summary", ids, ids);
            const session = seedSession(`snapshot-${label}-${at}`, [block]);
            session.state.messageRefs = {
                byRaw: { "raw-1": "m00001", "raw-2": "m00002", "raw-3": "m00003" },
                byRef: { m00001: "raw-1", m00002: "raw-2", m00003: "raw-3" },
            };
            const originals: CoreMessage[] = ids.map((id, index) => ({
                id,
                role: index === 1 ? "assistant" : "user",
                contentType: "text",
                text: index === at ? text : `neighbor ${index + 1}`,
            }));
            const full = collectBlockContent(session.state, block, originals, { full: true });
            session.blockContents.set(block.blockId, { one: null, full });
            session.lastMessages = [];
            _resetDiskCacheForTest();

            for (let index = 0; index < originals.length; index++) {
                const result = await buildMessageContent(session.id, `m0000${index + 1}`);
                assert.ok(result.ok);
                assert.equal(result.text, originals[index].text);
                assert.equal(result.totalBytes, Buffer.byteLength(originals[index].text!));
                assert.equal(result.bytes, result.totalBytes);
                assert.equal(result.truncated, false);
            }
            assert.deepEqual(session.blockContents.get(block.blockId)?.full, full);
        });
    }
}

for (const leading of ["", "\n", "\n\n"]) {
    test(`frozen snapshot keeps ${leading.length} leading blank lines around its ref marker`, async () => {
        const block = mkBlock("b1", 1, "summary", ["raw"], ["raw"]);
        const session = seedSession(`snapshot-marker-${leading.length}`, [block]);
        session.state.messageRefs = { byRaw: { raw: "m00001" }, byRef: { m00001: "raw" } };
        const text = leading + '\x3cacp tokens="2" type="text"\x3em00001\x3c/acp\x3e\n\n body\n\n';
        const full = collectBlockContent(session.state, block, [
            { id: "raw", role: "user", contentType: "text", text },
        ], { full: true });
        session.blockContents.set(block.blockId, { one: null, full });
        session.lastMessages = [];
        _resetDiskCacheForTest();
        const result = await buildMessageContent(session.id, "m00001");
        assert.ok(result.ok);
        assert.equal(result.text, leading + "\n body\n\n");
        assert.equal(result.totalBytes, Buffer.byteLength(result.text));
    });
}

test("frozen-snapshot hydration refuses a partial, shifted or non-leaf parse", async () => {
    // Count mismatch: the snapshot captured only 2 of the block's 3 messages
    // (host pruned the third before capture) — no half-alignment allowed.
    const s = seedSession("tree-snap-short", [mkBlock("b1", 1, "s", ["rm1", "rm2", "rm3"], ["rm1", "rm2", "rm3"])]);
    s.state.messageRefs = { byRaw: { rm1: "m00001", rm2: "m00002", rm3: "m00003" }, byRef: { m00001: "rm1", m00002: "rm2", m00003: "rm3" } };
    s.lastMessages = [];
    s.blockContents.set("b1", { one: null, full: { text: "[user]\nfirst\n\n[assistant]\nsecond", count: 2 } });
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-snap-short");
    assert.ok(d);
    assert.deepEqual(d.blockDetails[0].directMessages, [
        { ref: "m00001", missing: true },
        { ref: "m00002", missing: true },
        { ref: "m00003", missing: true },
    ], "a partial capture keeps every row an honest miss");
    assert.deepEqual(await buildMessageContent("tree-snap-short", "m00002"), { ok: false, reason: "unknown-message" });

    // Marker shift: three-way count matches, but the marker proves position 0
    // is the ledger's SECOND ref (the frozen first message was pruned before
    // capture) — the marker pins its own ref exactly (the pi host stamped it
    // into the message body), the rest stays an honest miss. The span
    // m00001–m00002 does NOT arithmetically anchor item 0 (2 − 1 = 1 ≠ 0), so
    // this case exercises the legacy current-ref pin, not the restamp-proof
    // arithmetic anchor.
    const s2 = seedSession("tree-snap-shift", [mkBlock("b1", 1, "s", ["rm1", "rm2"], ["rm1", "rm2"], [], ["m00001", "m00002"])])
    s2.state.messageRefs = { byRaw: { rm1: "m00001", rm2: "m00002" }, byRef: { m00001: "rm1", m00002: "rm2" } };
    s2.lastMessages = [];
    s2.blockContents.set("b2", { one: null, full: { text: "unused", count: 0 } });
    s2.blockContents.set("b1", { one: null, full: { text: '[user]\n<acp tokens="1" type="text">m00002</acp>\nwrong place\n\n[assistant]\nsecond', count: 2 } });
    _resetDiskCacheForTest();
    const d2 = await buildSessionDetail("tree-snap-shift");
    assert.ok(d2);
    assert.deepEqual(d2.blockDetails[0].directMessages, [
        { ref: "m00001", missing: true },
        { ref: "m00002", role: "user", preview: "wrong place" },
    ], "a marker pins its own ref exactly; the unprovable neighbour stays a miss");
    assert.deepEqual(await buildMessageContent("tree-snap-shift", "m00001"), { ok: false, reason: "unknown-message" });

    // Non-leaf span (direct \u2260 effective): children live inside the full
    // text, so position means nothing — stays a miss even when counts look right.
    const s3 = seedSession("tree-snap-nonleaf", [mkBlock("b1", 2, "s", ["rm1"], ["rm1", "rm2"])]);
    s3.state.messageRefs = { byRaw: { rm1: "m00001", rm2: "m00002" }, byRef: { m00001: "rm1", m00002: "rm2" } };
    s3.lastMessages = [];
    s3.blockContents.set("b1", { one: null, full: { text: "[user]\nonly direct\n\n[assistant]\nchild message", count: 2 } });
    _resetDiskCacheForTest();
    const d3 = await buildSessionDetail("tree-snap-nonleaf");
    assert.ok(d3);
    assert.deepEqual(d3.blockDetails[0].directMessages, [{ ref: "m00001", missing: true }], "non-leaf spans never zip");
});

test("frozen-snapshot hydration anchors on markers when the host pruned a message mid-block", async () => {
    // The b88 shape: 4 ledger refs, the snapshot only froze 3 messages (the
    // host pruned the first one before capture). The ACP marker in item 0 pins
    // it to the SECOND ref — the leading segment no longer balances (m00001
    // stays an honest miss) but the tail balances and zips positionally.
    const s = seedSession("tree-snap-anchor", [mkBlock("b1", 1, "s", ["rm1", "rm2", "rm3", "rm4"], ["rm1", "rm2", "rm3", "rm4"])]);
    s.state.messageRefs = { byRaw: { rm1: "m00001", rm2: "m00002", rm3: "m00003", rm4: "m00004" }, byRef: { m00001: "rm1", m00002: "rm2", m00003: "rm3", m00004: "rm4" } };
    s.lastMessages = [];
    s.blockContents.set("b1", {
        one: null,
        full: { text: '[user]\n<acp tokens="1" type="text">m00002</acp>\ntwo\n\n[assistant]\nthree\n\n[tool \u2022 read]\nfour', count: 3 },
    });
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-snap-anchor");
    assert.ok(d);
    assert.deepEqual(d.blockDetails[0].directMessages, [
        { ref: "m00001", missing: true },
        { ref: "m00002", role: "user", preview: "two" },
        { ref: "m00003", role: "assistant", preview: "three" },
        { ref: "m00004", role: "tool", toolName: "read", preview: "four" },
    ], "marker-anchored segments re-align around the pruned message");
    const one = await buildMessageContent("tree-snap-anchor", "m00003");
    assert.ok(one.ok);
    assert.equal(one.text, "three", "click-to-open follows the anchored alignment");
});

test("frozen-snapshot hydration: restamp-proof arithmetic anchor recovers a renumbered block", async () => {
    // The b27 shape: the cold load RESTAMPED the block's refs (cold-load #5196
    // parked bands take fresh numbers), so the markers' frozen numbers no
    // longer occur in the direct list — identity cannot prove anything. But
    // the frozen span m00001–m00003 was written WITH the markers, so
    // `frozenNumber − spanStart === snapshot position` still holds for every
    // marker, and the whole block zips positionally.
    const s = seedSession("tree-snap-restamp", [mkBlock("b1", 1, "s", ["ra", "rb", "rc"], ["ra", "rb", "rc"], [], ["m00001", "m00003"])]) ;
    s.state.messageRefs = { byRaw: { ra: "m90001", rb: "m90002", rc: "m90003" }, byRef: { m90001: "ra", m90002: "rb", m90003: "rc" } };
    s.lastMessages = [];
    s.blockContents.set("b1", {
        one: null,
        full: {
            text: ["[user]", '<acp tokens="2" type="text">m00001</acp>', "first", "", "[assistant]", "middle", "", "[user]", '<acp tokens="1" type="text">m00003</acp>', "last"].join("\n"),
            count: 3,
        },
    });
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-snap-restamp");
    assert.ok(d);
    assert.deepEqual(d.blockDetails[0].directMessages, [
        { ref: "m90001", role: "user", preview: "first" },
        { ref: "m90002", role: "assistant", preview: "middle" },
        { ref: "m90003", role: "user", preview: "last" },
    ], "renumbered refs still re-align via the frozen span arithmetic");
    const one = await buildMessageContent("tree-snap-restamp", "m90001");
    assert.ok(one.ok);
    assert.equal(one.text, "first", "click-to-open follows the arithmetic alignment");
});

test("frozen-snapshot hydration: arithmetic beats a coincidental current-ref match", async () => {
    // The b27 m01055 trap: a restamped frozen number (m00002) happens to equal
    // some OTHER message's new ref (the second dref, m90002 in this ledger). The
    // marker sits at item 0 and its frozen arithmetic (2 − spanStart 2 = 0 =
    // position 0) proves item 0 IS the marked message — the coincidental
    // dref[1] number match must not steal the pin (a legacy pin (0,1) would
    // leave both outer rows missing instead).
    const s = seedSession("tree-snap-trap", [mkBlock("b1", 1, "s", ["ra", "rb", "rc"], ["ra", "rb", "rc"], [], ["m00002", "m00004"])]) ;
    s.state.messageRefs = { byRaw: { ra: "m90001", rb: "m90002", rc: "m90003" }, byRef: { m90001: "ra", m90002: "rb", m90003: "rc" } };
    s.lastMessages = [];
    s.blockContents.set("b1", {
        one: null,
        full: { text: "[user]\n<acp tokens=\"1\" type=\"text\">m00002</acp>\nmarked one\n\n[assistant]\nsecond\n\n[assistant]\nthird", count: 3 },
    });
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-snap-trap");
    assert.ok(d);
    assert.deepEqual(d.blockDetails[0].directMessages, [
        { ref: "m90001", role: "user", preview: "marked one" },
        { ref: "m90002", role: "assistant", preview: "second" },
        { ref: "m90003", role: "assistant", preview: "third" },
    ], "the marker pins item 0 via arithmetic (a legacy pin (0,1) on the coincidental number would have left m90001/m90003 missing); the anchored tail zips positionally");
});

test("frozen-snapshot hydration: a marker proving neither anchor rejects the whole block", async () => {
    // Foreign-content shape: the marker names m00050, which is neither a
    // current ref at the marker's position nor inside the frozen span
    // m00001–m00003 — the frozen context mixed in foreign messages. No part of
    // the block may be served (two-sided assertion: hydrated preview AND
    // click-to-open both stay honest misses).
    const s = seedSession("tree-snap-foreign", [mkBlock("b1", 1, "s", ["ra", "rb"], ["ra", "rb"], [], ["m00001", "m00003"])]) ;
    s.state.messageRefs = { byRaw: { ra: "m90001", rb: "m90002" }, byRef: { m90001: "ra", m90002: "rb" } };
    s.lastMessages = [];
    s.blockContents.set("b1", {
        one: null,
        full: { text: "[user]\n<acp tokens=\"1\" type=\"text\">m00050</acp>\nforeign\n\n[assistant]\nsecond", count: 2 },
    });
    _resetDiskCacheForTest();
    const d = await buildSessionDetail("tree-snap-foreign");
    assert.ok(d);
    assert.deepEqual(d.blockDetails[0].directMessages, [
        { ref: "m90001", missing: true },
        { ref: "m90002", missing: true },
    ], "an unanchorable marker aborts the whole block");
    assert.deepEqual(await buildMessageContent("tree-snap-foreign", "m90001"), { ok: false, reason: "unknown-message" });
});

test("#4173: the live tree endpoint ships ids/tiers/edges/spans — no summaries", async () => {
    // #4173 review: nodes label their covered message span; non-monotonic
    // stored spans are canonicalized ascending before leaving the server.
    const t1 = mkBlock("b1", 1, "## T1 summary\n- point one", ["rm1"], ["rm1"], [], ["m00010", "m00005"]);
    const t2 = mkBlock("b2", 2, "T2 summary", ["rm3"], ["rm1", "rm3"], ["b1"], ["m00001", "m00030"]);
    seedSession("tree-live", [t1, t2]);
    const tree = await buildSessionTree("tree-live");
    assert.ok(tree);
    assert.equal(tree.blocks.length, 2);
    const byId = new Map(tree.blocks.map((b) => [b.blockId, b]));
    assert.deepEqual(byId.get("b1"), { blockId: "b1", tier: 1, active: true, startRef: "m00005", endRef: "m00010", parentBlockId: "b2", directBlockIds: [] }, "the child names its fold parent AND its message span");
    assert.deepEqual(byId.get("b2"), { blockId: "b2", tier: 2, active: true, startRef: "m00001", endRef: "m00030", directBlockIds: ["b1"] }, "the root has no parent field at all");
    // The whole point of the compact feed: no summary bytes on the wire.
    assert.ok(!JSON.stringify(tree).includes("point one"), "summaries never leave the server");
    assert.equal(await buildSessionTree("no-such-session"), null, "unknown session resolves to a 404 payload");
});

test("#4608: the pane's strings exist in both locales with identical placeholders", () => {
    const keys = [
        "det.tab_overview",
        "det.tab_blocks",
        "det.tab_handoff",
        "det.tree_total",
        "det.tree_active",
        "det.tree_split",
        "det.tree_msgs",
        "det.tree_direct",
        "det.tree_orig_one",
        "det.tree_orig_full",
        "det.tree_orig_meta",
        "det.tree_orig_truncated",
        "det.tree_orig_missing",
        "det.tree_msgs_unavailable",
        "det.tree_msg_gone",
        "det.tree_view_graph",
        "det.tree_view_list",
        "det.tree_list_hint",
        "det.tree_expand_all",
        "det.tree_collapse_all",
        "det.tree_interact",
        "det.block_detail_title",
        "det.block_side_hint",
        "det.block_side_live",
        "det.tree_sum_more",
        "det.tree_sum_less",
    ];
    const placeholders = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join(",");
    for (const key of keys) {
        const zh = MESSAGES["zh-CN"][key];
        const en = MESSAGES.en[key];
        assert.ok(zh, `zh-CN missing ${key}`);
        assert.ok(en, `en missing ${key}`);
        assert.equal(placeholders(zh), placeholders(en), `${key} placeholder drift`);
    }
});

test("#4608: the web client bundle stays parseable JS with the master-detail pane wired", () => {
    assert.doesNotThrow(() => new vm.Script(WEB_CLIENT), "WEB_CLIENT must compile as a standalone script");
    assert.match(WEB_CLIENT, /function buildTreePane\(blocks\)/);
    assert.match(WEB_CLIENT, /\/block-content\?blockId=/);
    // collapsible tree reading (default) + the restored classic list
    assert.match(WEB_CLIENT, /function collapTreeLayout\(blocks/);
    assert.match(WEB_CLIENT, /function renderCollapSvg\(blocks/);
    assert.match(WEB_CLIENT, /function sidePanelHtml\(b, idx\)/);
    assert.match(WEB_CLIENT, /function blockNodeHtml\(b, shape, idx, depth\)/);
    assert.match(WEB_CLIENT, /id="tree-graph"/);
    assert.match(WEB_CLIENT, /id="tree-list"/);
    assert.match(WEB_CLIENT, /id="bd-panels"/);
    assert.match(WEB_CLIENT, /data-mode="tree"/);
    assert.match(WEB_CLIENT, /data-mode="list"/);
    assert.match(WEB_CLIENT, /"g-node tier-" \+/);
    assert.match(WEB_CLIENT, /tchip/);
    // point hit-testing survives innerHTML swaps; the mode choice persists
    assert.match(WEB_CLIENT, /document\.elementFromPoint/);
    assert.match(WEB_CLIENT, /sessionStorage\.setItem\("bili-tree-mode"/);
    assert.match(WEB_CLIENT, /let treeViewState = null;/);
    assert.match(WEB_CLIENT, /window\.__biliDetailBlocks = blocks;/);
    // live lane repaints only the tree drawing from GET /sessions/<id>/tree
    assert.match(WEB_CLIENT, /function refreshTreeMap\(\)/);
    assert.match(WEB_CLIENT, /renderCollapSvg\(merged/);
    assert.ok(WEB_CLIENT.includes('"/sessions/" + encodeURIComponent(m[1]) + "/tree"'), "#4173 tree URL wiring still present");
    // raw-view buttons stay reversible; the clamp machinery now measures panels
    assert.match(WEB_CLIENT, /if \(!box\.hidden && box\.getAttribute\("data-view"\) === view\) \{ box\.hidden = true; return; \}/);
    assert.match(WEB_CLIENT, /blk-sum clamp/);
    assert.match(WEB_CLIENT, /body\.__sumChk/);
});

// Run the actual drawing code out of the bundle against fixtures (#4173
// precedent): the section is extracted between stable function anchors and
// executed in a vm with the page helpers stubbed.
interface PaneBlock {
    blockId: string;
    tier?: number;
    active?: boolean;
    topic?: string;
    startRef?: string;
    endRef?: string;
    parentBlockId?: string;
    compressedTokens?: number;
    summaryTokens?: number;
}
interface PaneApi {
    collapTreeLayout(blocks: PaneBlock[], expanded: Record<string, boolean>): { nodes: { b: PaneBlock; x: number; y: number }[]; links: unknown[]; sizes: Record<string, number> };
    renderCollapSvg(blocks: PaneBlock[], expanded: Record<string, boolean>, selectedBid?: string): { html: string };
    buildTreePane(blocks: PaneBlock[]): string;
}
function loadPaneApi(): PaneApi {
    const start = WEB_CLIENT.indexOf("function blockTreeStats(");
    const end = WEB_CLIENT.indexOf("function buildDetailHtml(d) {");
    assert.ok(start > 0 && end > start, "pane section anchors present in the bundle");
    const stubs = [
        "var escapeHtml=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};",
        "var fmtW=function(n){return String(n);};",
        "var fmtB=function(n){return String(n)+'B';};",
        "var timeAgo=function(){return 'now';};",
        "var blockTopic=function(b){return b.topic||'';};",
        "var t=function(k,v){return k;};",
        "var renderBlockMd=function(s){return '<p>'+escapeHtml(String(s))+'</p>';};",
        "var window={};",
    ].join("");
    const ctx = vm.createContext({});
    vm.runInContext(stubs + WEB_CLIENT.slice(start, end) + "\nthis.api={collapTreeLayout:collapTreeLayout,renderCollapSvg:renderCollapSvg,buildTreePane:buildTreePane};this.api", ctx, { filename: "web-pane.js" });
    return (ctx as { api: PaneApi }).api;
}

// vm-run code returns foreign-realm arrays/objects; JSON round-trip on the
// host side restores plain prototypes so deepEqual compares structure, not realms.
const fromVm = (x: unknown) => JSON.parse(JSON.stringify(x)) as never;

test("#4608: the collapsible tree shows roots until a branch is opened; chips count what hides", () => {
    const api = loadPaneApi();
    const fam: PaneBlock[] = [
        { blockId: "r1", tier: 1, active: true, topic: "root topic" },
        { blockId: "k1", tier: 2, active: true, parentBlockId: "r1" },
        { blockId: "k2", tier: 2, active: false, parentBlockId: "r1" },
    ];
    const folded = api.collapTreeLayout(fam, {});
    assert.deepEqual(fromVm(folded.nodes.map((n) => n.b.blockId)), ["r1"], "only roots sit on canvas by default");
    assert.equal(folded.sizes.r1, 3, "subtree size counts the hidden descendants");
    const open = api.collapTreeLayout(fam, { r1: true });
    assert.equal(open.nodes.length, 3);
    assert.equal(open.links.length, 2);
    assert.equal(open.nodes.find((n) => n.b.blockId === "k1")!.x, 1, "children land one column deeper");
    const svgF = api.renderCollapSvg(fam, {}, "").html;
    assert.ok(svgF.includes("+2"), "the closed branch advertises how much hides behind it");
    assert.ok(svgF.includes('data-toggle="r1"'), "chips toggle their parent");
    assert.ok(!svgF.includes("k1"), "collapsed children never reach the DOM");
    const svgO = api.renderCollapSvg(fam, { r1: true }, "k2").html;
    assert.ok(svgO.includes("\u2212") || svgO.includes("-"), "the open branch offers a collapse mark");
    assert.ok(svgO.includes("fsel"), "selection rides the node");
    assert.ok(svgO.includes("tier-2 inactive"), "archived children keep the dashed styling");
    assert.equal(api.renderCollapSvg([], {}, "").html, "", "an empty forest renders nothing");
});

test("#4608: buildTreePane wires the two drawings beside the pre-rendered panels", () => {
    const api = loadPaneApi();
    const fam: PaneBlock[] = [
        { blockId: "r1", tier: 1, active: true, topic: "root topic" },
        { blockId: "k1", tier: 2, active: true, parentBlockId: "r1", compressedTokens: 9, summaryTokens: 1 },
    ];
    const pane = api.buildTreePane(fam);
    assert.ok(pane.includes('id="tree-graph"') && !pane.includes('id="tree-graph" hidden'), "the tree reading shows by default");
    assert.ok(pane.includes('id="tree-list" hidden'), "the classic list starts under the tree");
    assert.ok(pane.includes('class="block-item block-node tier-1"'), "the classic list keeps the master-folded rows");
    assert.equal((pane.match(/class="bd-panel"/g) || []).length, 2, "one pre-rendered panel per block");
    assert.ok(pane.includes('data-mode="tree"') && pane.includes('data-mode="list"'), "mode switch offers both readings");
    assert.ok(!pane.includes("flame-stage"), "no flame leftovers in the pane");
    assert.ok(pane.includes('id="tm-expand-all"'), "expand/collapse controls ship with the tree mode");
    assert.ok(!api.buildTreePane([]).includes("tree-list"), "no blocks -> the empty card, no frames");
});

test("#4737 review: pane surfaces follow the theme and list markdown rules keep their element suffixes", () => {
    assert.ok(!/\.fd-left \{[^}]*#fff/.test(WEB_STYLES), ".fd-left must not hardcode white (dark scheme)");
    assert.ok(!/\.bd-card \{[^}]*#fff/.test(WEB_STYLES), ".bd-card must not hardcode white (dark scheme)");
    assert.ok(!/\.block-item \.body\.md,/.test(WEB_STYLES), "no bare '.block-item .body.md,' selector (element suffix dropped)");
    for (const sel of ["p", "h2", "ul", "li", "pre", "code", "blockquote", "hr", "strong"]) {
        assert.match(WEB_STYLES, new RegExp(`\\.block-item \\.body\\.md ${sel},`), `list-mode ${sel} rule keeps its element suffix`);
    }
});

test("#5417: the treemap node fills follow the theme instead of pinning light hues", () => {
    // Dark mode turns var(--text) light; a pinned light fill would bury it. Node fills must stay var-driven.
    const nodeRules = [".g-node rect", ".g-node.tier-1 rect", ".g-node.tier-2 rect", ".g-node.tier-3 rect", ".g-node.tier-n rect"];
    for (const sel of nodeRules) {
        const rule = WEB_STYLES.match(new RegExp("^" + sel.replace(/\./g, "\\.") + " \\{[^}]*}", "m"))?.[0];
        assert.ok(rule, `rule present: ${sel}`);
        assert.match(rule, /fill:\s*var\(--tm-[a-z0-9-]+-fill\)/, `${sel}: fill must be a themed --tm-*-fill var`);
        assert.ok(!/fill:\s*#[0-9a-fA-F]{3,8}\b/i.test(rule), `${sel}: no hardcoded fill hex (breaks dark mode)`);
    }
    const tmVars = ["--tm-base-fill", "--tm-t1-fill", "--tm-t2-fill", "--tm-t3-fill", "--tm-tn-fill"];
    const darkMedia = WEB_STYLES.match(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
    const darkPin = WEB_STYLES.match(/:root\[data-theme="dark"\] \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(darkMedia.length > 0 && darkPin.length > 0, "both dark palettes located");
    for (const v of tmVars) {
        assert.ok(darkMedia.includes(v + ":"), `OS-dark palette defines ${v}`);
        assert.ok(darkPin.includes(v + ":"), `pinned-dark palette defines ${v}`);
    }
});
