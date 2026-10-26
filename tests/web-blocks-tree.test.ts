import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createInitialState, defaultCountTokens } from "acp-kernel";
import type { CompressionBlock } from "acp-kernel";
import { LazyBlockContents, _resetSessionsForTest, getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetDiskCacheForTest, buildBlockContent, buildMessageContent, buildSessionDetail, buildSessionTree } from "../src/web/sessions-data.ts";
import { MESSAGES } from "../src/web/i18n.ts";
import { WEB_CLIENT } from "../src/web/client.ts";

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

test("#3917: the tree's strings exist in both locales with identical placeholders", () => {
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
        "det.tree_hint",
        "det.tree_view_list",
        "det.tree_view_graph",
        "det.tree_map_hint",
        "det.tree_sum_more",
        "det.tree_sum_less",
        "det.tree_map_fit",
        "det.tree_graph_legend",
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

test("#3917: the web client bundle stays parseable JS after the tree additions", () => {
    assert.doesNotThrow(() => new vm.Script(WEB_CLIENT), "WEB_CLIENT must compile as a standalone script");
    assert.match(WEB_CLIENT, /function buildTreePane\(blocks\)/);
    assert.match(WEB_CLIENT, /\/block-content\?blockId=/);
    // the graph reading of the same folds: layered boxes + list⇄graph switch
    assert.match(WEB_CLIENT, /function buildGraphSvg\(blocks/);
    assert.match(WEB_CLIENT, /function blockGraphLayout\(blocks,/);
    // #4173: pathologically wide trees rotate instead of shrinking to sub-pixel
    assert.match(WEB_CLIENT, /function blockGraphLayoutVertical\(blocks,/);
    assert.match(WEB_CLIENT, /g-svg-v/);
    // #4173: in-pane live tree map — the full labeled drawing in wrapped mode
    // (compact nodes at natural pixel size flowing with the page), fed by
    // GET /sessions/<id>/tree on the 5s poller; wheel/pan/click bind on the
    // stable #tree-graph container and zoom resizes .tm-inner via treeMapApply.
    assert.match(WEB_CLIENT, /function graphLayouts\(blocks,/);
    assert.match(WEB_CLIENT, /function buildGraphSvg\(blocks, wrapped,/);
    assert.match(WEB_CLIENT, /class="tm-g"/);
    assert.match(WEB_CLIENT, /class="tm-inner" data-nw=/);
    assert.match(WEB_CLIENT, /function treeMapInnerHtml\(graph\)/);
    assert.match(WEB_CLIENT, /function treeMapApply\(view\)/);
    assert.match(WEB_CLIENT, /function treeMapFit\(view\)/);
    assert.match(WEB_CLIENT, /function bindTreeMap\(\)/);
    assert.match(WEB_CLIENT, /function refreshTreeMap\(\)/);
    assert.match(WEB_CLIENT, /addEventListener\("wheel"/);
    // #4173 review: plain wheel scrolls the page over the in-flow map; only
    // Ctrl/pinch wheels zoom (anchored via window.scrollBy), and the map draws
    // with tighter metrics than the legacy fit-shrunk graph.
    assert.match(WEB_CLIENT, /if \(!e\.ctrlKey\) return;/);
    assert.match(WEB_CLIENT, /const MAP_METRICS = \{ w: MAP_NODE_W/);
    assert.match(WEB_CLIENT, /window\.scrollBy\(/);
    assert.match(WEB_CLIENT, /pointerdown/);
    assert.match(WEB_CLIENT, /tm-fit/);
    // #4173 review: Fit is mode-gated (visible only while the tree drawing shows)
    // and live refreshes swap just the .tm-inner frame so the legend row survives.
    assert.match(WEB_CLIENT, /fit\.hidden = !g/);
    assert.match(WEB_CLIENT, /insertAdjacentHTML\("afterbegin", treeMapInnerHtml/);
    // #4173 review: click-to-jump hit-tests by point (pointer capture
    // retargets the event), and graph mode stacks map+list instead of hiding
    // the detail rows.
    assert.match(WEB_CLIENT, /document\.elementFromPoint\(e\.clientX, e\.clientY\)/);
    assert.match(WEB_CLIENT, /list\.hidden = false/);
    // #4173 review: list rows start collapsed; tree nodes carry the message
    // span (mXXXX–mYYYY); the raw-text button can be pressed again to close.
    assert.match(WEB_CLIENT, /const openAttr = "";/);
    assert.match(WEB_CLIENT, /const rr = refRangeOf\(b\)/);
    assert.match(WEB_CLIENT, /escapeHtml\(rr \|\| meta\)/);
    assert.match(WEB_CLIENT, /if \(!box\.hidden && box\.getAttribute\("data-view"\) === view\) \{ box\.hidden = true; return; \}/);
    // #4173 review: jump lands at the top of the target row; long summaries
    // open as five clamped lines behind a show-all toggle.
    assert.match(WEB_CLIENT, /row\.scrollIntoView\(\{ block: "start", behavior: "smooth" \}\)/);
    assert.match(WEB_CLIENT, /blk-sum clamp/);
    assert.match(WEB_CLIENT, /blk-sum-toggle/);
    assert.match(WEB_CLIENT, /body\.__sumChk/);
    assert.ok(WEB_CLIENT.includes('"/sessions/" + encodeURIComponent(m[1]) + "/tree"'), "#4173 tree URL wiring present in the bundle");
    assert.match(WEB_CLIENT, /"g-node tier-" \+/);
    assert.match(WEB_CLIENT, /data-mode="graph"/);
    assert.match(WEB_CLIENT, /id="tree-graph"/);
    assert.match(WEB_CLIENT, /\.block-node\[data-bid=/);
});

// #4173: run the actual layout/graph code from the bundle against fixtures.
test("#4173: wide trees rotate to vertical full-size instead of shrinking to smears", () => {
    const start = WEB_CLIENT.indexOf("function blockTreeShape(");
    const end = WEB_CLIENT.indexOf("function refRangeOf(");
    assert.ok(start > 0 && end > start, "graph section anchors present in the bundle");
    const stubs = "var escapeHtml=function(s){return String(s);};var fmtW=function(n){return String(n);};var blockTopic=function(b){return b.topic||'';};var t=function(k){return k;};var refRangeOf=function(b){return '';};";
    const ctx = vm.createContext({});
    vm.runInContext(stubs + WEB_CLIENT.slice(start, end) + "this.api={blockGraphLayout:blockGraphLayout,blockGraphLayoutVertical:blockGraphLayoutVertical,buildGraphSvg:buildGraphSvg,graphLayouts:graphLayouts};;this.api", ctx, { filename: "web-graph.js" });
    const api = ctx.api;

    // 30 independent T1 roots → flat row 4004px wide: the old code fit-scaled it
    // to ≈ 33px boxes; now it must rotate.
    const wide = [];
    for (let i = 0; i < 30; i++) wide.push({ blockId: "b" + i, tier: 1, active: true, parentBlockId: undefined });
    const res = api.buildGraphSvg(wide);
    assert.equal(res.vertical, true, "a 30-root flat tree rotates");
    assert.match(res.html, /class="g-svg g-svg-v"/);
    assert.ok((res.html.match(/data-bid=/g) || []).length === 30, "rotation keeps every node");
    const m = res.html.match(/ width="(\d+)" height="(\d+)"/);
    assert.ok(m, "svg carries explicit dimensions");
    // vertical extent ≈ 30 slots × 52 − gap (+padding), rendered UNscaled (width axis ~3 levels)
    assert.ok(Number(m[1]) < 600, "long dimension moved off the width axis (got " + m[1] + "px)");
    assert.ok(Number(m[2]) >= 1400, "height holds the 30 stacked nodes near natural size (got " + m[2] + "px)");

    // small deep chain: stays top-down, byte-level unchanged rendering path
    const chain = [{ blockId: "c1", tier: 1, active: true, parentBlockId: undefined }, { blockId: "c2", tier: 2, active: true, parentBlockId: "c1" }, { blockId: "c3", tier: 3, active: true, parentBlockId: "c2" }];
    const small = api.buildGraphSvg(chain);
    assert.equal(small.vertical, false, "a narrow chain does not rotate");
    assert.doesNotMatch(small.html, /g-svg-v/);
    assert.ok(small.html.includes('viewBox="0 0'), "still an svg");

    // empty tree keeps the old falsy contract via {html:""}
    const none = api.buildGraphSvg([]);
    assert.equal(none.html, "");

    // #4173: the in-pane live map reuses the full labeled drawing — every node
    // keeps its box AND its text — but switches into wrapped mode: content sits
    // in the pan/zoom <g class="tm-g"> group and the svg tag carries NO fixed
    // size attributes (CSS owns the viewport). The plain path is untouched.
    const mapRes = api.buildGraphSvg(wide, true);
    const mapWide = mapRes.html;
    assert.ok(mapWide.startsWith('<svg class="g-svg g-svg-v tm-svg"'), "wide trees rotate in the map too");
    assert.ok(mapWide.includes('<g class="tm-g">'), "map wraps its drawing in the transform group");
    assert.ok(mapWide.includes("<text"), "map keeps the labels");
    assert.equal((mapWide.match(/data-bid="/g) || []).length, 30, "every block still gets a node");
    const mvb = mapWide.match(/viewBox="0 0 (\d+) (\d+)"/);
    const mwd = mapWide.match(/ width="(\d+)" height="(\d+)"/);
    assert.ok(mvb && mwd, "wrapped svg carries viewBox plus natural size attrs");
    assert.equal(Number(mvb[1]), Number(mwd[1]), "wrapped width is the natural width (no fit shrink)");
    assert.equal(Number(mvb[2]), Number(mwd[2]), "wrapped height is the natural height (no fit shrink)");
    assert.equal(mapRes.width, Number(mwd[1]), "returned width matches the drawing");
    assert.ok(api.buildGraphSvg(wide).html.match(/<svg[^>]*>/)[0].includes("width="), "plain svg keeps fit size attrs");
    const mapChain = api.buildGraphSvg(chain, true).html;
    assert.ok(mapChain.length > 0 && mapChain.includes('viewBox="0 0'), "a narrow chain renders a non-empty map with viewBox geometry");
    assert.equal(api.buildGraphSvg([], true).html, "", "empty tree renders nothing");
});
