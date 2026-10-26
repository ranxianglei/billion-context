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
    assert.match(WEB_CLIENT, /renderCollapSvg\(r\.blocks/);
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
