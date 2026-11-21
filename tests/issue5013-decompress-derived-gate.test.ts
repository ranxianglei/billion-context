import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { resolveDecompress, type ProxyToolCtx } from "../src/decompress-shared.ts";

/**
 * #5013 (audited from #5029/#4992): resolveDerivedDecompress was the only
 * decompress route without the size gates its siblings carry — an oversized
 * parent block restored into a near-full child window rode the wire unbounded,
 * and an explicit toFile argument was silently ignored. Both directions of the
 * restored gate are pinned here: over-cap spills to a tracked temp file (or
 * the caller's toFile path), under-cap stays inline.
 */

const countTokens = (text: string) => Math.ceil(text.length / 4);

function residentParent(id: string) {
    const messages: CoreMessage[] = [];
    for (let i = 1; i <= 6; i++) {
        messages.push({ id: `u${i}`, role: "user", contentType: "text", text: `user turn ${i} with enough prose to fold comfortably`.repeat(3) });
        messages.push({ id: `a${i}`, role: "assistant", contentType: "text", text: `assistant reply ${i} with enough prose to fold comfortably`.repeat(3) });
    }
    const core = createCore({ countTokens });
    const seeded = core.processTurn({ messages, state: createInitialState(), config: defaultConfig(100000), tokenCount: 500 });
    const compressed = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00008", summary: "fixture summary about early user turn exchanges of the derived gate test conversation" }],
        messages: seeded.messages,
        state: seeded.state,
        config: defaultConfig(100000, { compress: { minCompressRange: 0, minSummaryLength: 1, maxSummaryLength: 5000 }, preserveRecentMessages: 2, preserveRecentTokens: 0 }),
    });
    const session = getSession(id, { protocol: "openai", upstreamOrigin: "http://upstream" });
    session.state = compressed.state;
    for (const b of compressed.state.blocks) {
        if (b.active) session.blockContents.set(b.blockId, { one: { text: `one-level fixture content of ${b.blockId}`, count: 4 }, full: { text: `full fixture content of ${b.blockId}`, count: 8 } });
    }
    return session;
}

function makeChildCtx(parentId: string, childId: string): ProxyToolCtx {
    const child = getSession(childId, { protocol: "openai", upstreamOrigin: "http://upstream" });
    child.metadata.derivedFromSessionId = parentId;
    return { core: createCore({ countTokens }), config: defaultConfig(100000), messages: [], session: child, log: () => undefined };
}

test("derived-parent restore over the inline cap spills to a temp file instead of riding the wire (#5013)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const parent = residentParent(`issue5013-parent-${run}`);
    const blockId = parent.state.blocks.filter((b) => b.active)[0]!.blockId;
    const big = "overflow marker ".repeat(1250);
    const bigFull = `${big}full-view-tail`;
    parent.blockContents.set(blockId, { one: { text: big, count: 5 }, full: { text: bigFull, count: 9 } });
    const ctx = makeChildCtx(parent.id, `issue5013-child-${run}`);

    const res = resolveDecompress({ blockId }, ctx);
    assert.equal(res.outcome, "success");
    assert.match(res.text, /Content \(\d+ chars\) written to: (.+)/s);
    assert.doesNotMatch(res.text, /overflow marker/, "raw body must not ride the wire");
    const outPath = res.text.match(/written to: (.+)/)![1]!;
    assert.ok(fs.existsSync(outPath), "spill file exists");
    assert.equal(fs.readFileSync(outPath, "utf8"), big);

    const fullRes = resolveDecompress({ blockId, full: true }, ctx);
    assert.equal(fullRes.outcome, "success");
    const fullPath = fullRes.text.match(/written to: (.+)/)![1]!;
    assert.equal(fs.readFileSync(fullPath, "utf8"), bigFull, "full flag serves the full view");

    const target = path.join(os.tmpdir(), `issue5013-tofile-${run}.txt`);
    try {
        const toFileRes = resolveDecompress({ blockId, toFile: target }, ctx);
        assert.equal(toFileRes.outcome, "success", "explicit toFile must be honored on the derived path");
        assert.match(toFileRes.text, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.equal(fs.readFileSync(target, "utf8"), big);
    } finally {
        if (fs.existsSync(target)) fs.unlinkSync(target);
    }

    const b = parent.state.blocks.find((x) => x.blockId === blockId)!;
    assert.ok(!b.restoredInline, "the read-only fallback must not flag the ancestor's block");
});

test("derived-parent restore under the inline cap stays inline (#5013 negative gate)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const parent = residentParent(`issue5013-parent-neg-${run}`);
    const blockId = parent.state.blocks.filter((b) => b.active)[0]!.blockId;
    const ctx = makeChildCtx(parent.id, `issue5013-child-neg-${run}`);
    const res = resolveDecompress({ blockId }, ctx);
    assert.equal(res.outcome, "success");
    assert.match(res.text, new RegExp(`one-level fixture content of ${blockId}`));
    assert.doesNotMatch(res.text, /written to:/);
});
