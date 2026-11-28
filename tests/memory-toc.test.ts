import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_TOC_WINDOW,
    extractTopicFromSummary,
    normalizeTocWindow,
    renderMemoryToc,
    resolveMemoryToc,
    resolveMemoryTocWindow,
    type BlockTocItem,
} from "../src/memory-toc.js";

test("extractTopicFromSummary extracts topic from compression section header", () => {
    const summary = "[Compressed conversation section] — MariaDB migration and test verification\nSome other details...";
    assert.equal(extractTopicFromSummary(summary), "MariaDB migration and test verification");
});

test("extractTopicFromSummary extracts markdown heading when header is missing", () => {
    const summary = "Some preamble\n### Cloudflare IP Extraction and Whitespace Trimming\n- Fixed rate limit";
    assert.equal(extractTopicFromSummary(summary), "Cloudflare IP Extraction and Whitespace Trimming");
});

test("extractTopicFromSummary falls back to first non-empty line", () => {
    const summary = "Investigated and fixed memory leaks in the V8 heap\nOther logs...";
    assert.equal(extractTopicFromSummary(summary), "Investigated and fixed memory leaks in the V8 heap");
});

test("renderMemoryToc returns null for empty or all-inactive blocks", () => {
    assert.equal(renderMemoryToc([]), null);
    assert.equal(renderMemoryToc([{ blockId: "b1", active: false }]), null);
});

test("renderMemoryToc renders active blocks within default window", () => {
    const blocks: BlockTocItem[] = [
        { blockId: "b1", active: true, topic: "Topic 1" },
        { blockId: "b2", active: true, topic: "Topic 2", tier: 2 },
        { blockId: "b3", active: false, topic: "Inactive Topic" },
    ];
    const out = renderMemoryToc(blocks);
    assert.ok(out !== null);
    assert.ok(out.includes("### Active Session Memory Index"));
    assert.ok(out.includes("- b1: Topic 1"));
    assert.ok(out.includes("- b2 (T2): Topic 2"));
    assert.ok(!out.includes("Inactive Topic"));
    assert.ok(!out.includes("older block(s)"));
});

test("renderMemoryToc truncates at window and adds range-aware overflow line", () => {
    const blocks: BlockTocItem[] = Array.from({ length: 15 }, (_, i) => ({
        blockId: `b${i + 1}`,
        active: true,
        topic: `Milestone ${i + 1}`,
    }));

    const out = renderMemoryToc(blocks, { window: 5 });
    assert.ok(out !== null);
    // Shows the 5 most recent: b11 through b15
    for (let i = 11; i <= 15; i++) {
        assert.ok(out.includes(`- b${i}: Milestone ${i}`));
    }
    // Does NOT show b1 through b10 as individual lines
    for (let i = 1; i <= 10; i++) {
        assert.ok(!out.includes(`- b${i}: Milestone ${i}`));
    }
    // Overflow line names the omitted count and the range b1–b10
    assert.ok(out.includes("... 10 older block(s) (b1–b10) not listed"));
    assert.ok(out.includes("search_context({ query })"));
    assert.ok(out.includes("decompress({ blockId })"));
});

test("renderMemoryToc window <= 0 lists every block without truncation", () => {
    const blocks: BlockTocItem[] = Array.from({ length: 25 }, (_, i) => ({
        blockId: `b${i + 1}`,
        active: true,
        topic: `Milestone ${i + 1}`,
    }));
    const out = renderMemoryToc(blocks, { window: 0 });
    assert.ok(out !== null);
    assert.ok(!out.includes("older block(s)"));
    assert.ok(out.includes("- b1: Milestone 1"));
    assert.ok(out.includes("- b25: Milestone 25"));
});

test("normalizeTocWindow handles numbers, strings, and garbage", () => {
    assert.equal(normalizeTocWindow(10), 10);
    assert.equal(normalizeTocWindow("15"), 15);
    assert.equal(normalizeTocWindow("  5  "), 5);
    assert.equal(normalizeTocWindow(-1), -1);
    assert.equal(normalizeTocWindow(0), 0);
    assert.equal(normalizeTocWindow("abc"), undefined);
    assert.equal(normalizeTocWindow(null), undefined);
    assert.equal(normalizeTocWindow(undefined), undefined);
});

test("resolveMemoryTocWindow respects precedence", () => {
    assert.equal(resolveMemoryTocWindow({ BILI_MEMORY_TOC_WINDOW: "20" }, 5), 20);
    assert.equal(resolveMemoryTocWindow({}, 15), 15);
    assert.equal(resolveMemoryTocWindow({}, undefined), DEFAULT_TOC_WINDOW);
    assert.equal(resolveMemoryTocWindow({ BILI_MEMORY_TOC_WINDOW: "0" }, 15), 0);
});

test("resolveMemoryToc respects env and config", () => {
    assert.equal(resolveMemoryToc({ BILI_MEMORY_TOC: "0" }, true), false);
    assert.equal(resolveMemoryToc({ BILI_MEMORY_TOC: "false" }, true), false);
    assert.equal(resolveMemoryToc({ BILI_MEMORY_TOC: "1" }, false), true);
    assert.equal(resolveMemoryToc({}, false), false);
    assert.equal(resolveMemoryToc({}, true), true);
    assert.equal(resolveMemoryToc({}, undefined), true);
});
