import test from "node:test";
import assert from "node:assert/strict";
import { injectSystem, renderSessionMemoryToc } from "../src/server/inject.js";
import { renderMemoryToc } from "../src/memory-toc.js";

const TOC_HEADER = "### Active Session Memory Index";
const TOC_BODY = `${TOC_HEADER}\n- b2: Headroom compose migration`;

function fakeSession(blocks: Array<{ blockId: string; active: boolean; topic?: string; tier?: number; summary?: string }>) {
    return { state: { blocks } };
}

/** Returned shape is a plain string when the client sent a string `system`
 *  and an array when it sent blocks; both paths must carry the TOC. Fold the
 *  union into one comparable string so ordering asserts run on either shape. */
function asText(out: unknown): string {
    if (typeof out === "string") return out;
    if (Array.isArray(out)) {
        return out
            .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? String((part as { text: string }).text) : ""))
            .join("\n\n");
    }
    return "";
}

/** Index of the static compress anchor inside the rendered system text. It is
 *  the byte-stable prefix the TOC must never precede — the entire reason the
 *  TOC is appended last. */
function compressAnchorIndex(text: string): number {
    const candidates = ["Compression", "compress", "decompress", "acp"];
    for (const needle of candidates) {
        const at = text.indexOf(needle);
        if (at !== -1) return at;
    }
    return -1;
}

test("renderSessionMemoryToc renders and honours the window knob", () => {
    const session = fakeSession([
        { blockId: "b1", active: false, topic: "Inactive" },
        { blockId: "b2", active: true, topic: "Headroom compose migration" },
        { blockId: "b3", active: true, topic: "MariaDB migration", tier: 2 },
    ]);
    const toc = renderSessionMemoryToc(session, { compress: { memoryToc: true, memoryTocWindow: 5 } } as never);
    assert.ok(toc);
    assert.ok(toc.includes("- b2: Headroom compose migration"));
    assert.ok(toc.includes("- b3 (T2): MariaDB migration"));
    assert.ok(!toc.includes("Inactive"));
});

test("renderSessionMemoryToc accepts CompressionBlock-shaped blocks without a cast", () => {
    // Structural assignability is the contract: a real block carries many more
    // fields than BlockTocItem and must still type-check at the call site.
    const session = {
        state: {
            blocks: [
                { blockId: "b7", active: true, topic: "Typed block", tier: 1, summary: "s", effectiveMessageIds: ["m1"], compressedTokens: 12, rawTokens: 900 },
            ],
        },
    };
    const toc = renderSessionMemoryToc(session, {} as never);
    assert.ok(toc);
    assert.ok(toc.includes("- b7: Typed block"));
});

test("renderSessionMemoryToc returns undefined when disabled via env", () => {
    const prev = process.env.BILI_MEMORY_TOC;
    process.env.BILI_MEMORY_TOC = "0";
    try {
        const session = fakeSession([{ blockId: "b1", active: true, topic: "x" }]);
        assert.equal(renderSessionMemoryToc(session, {} as never), undefined);
    } finally {
        if (prev === undefined) delete process.env.BILI_MEMORY_TOC;
        else process.env.BILI_MEMORY_TOC = prev;
    }
});

test("renderSessionMemoryToc returns undefined when there are no active blocks", () => {
    const session = fakeSession([{ blockId: "b1", active: false, topic: "x" }]);
    assert.equal(renderSessionMemoryToc(session, {} as never), undefined);
});

test("injectSystem appends the memory TOC AFTER the static compress prompt (string system)", () => {
    // The common path: the client sent `system` as a plain string, so
    // appendSystemText joins everything into ONE string. The ordering assert
    // must therefore run on substring indices, not on the array shape.
    const parsed = { model: "m", messages: [], system: "client system prompt" };
    const out = injectSystem(
        parsed as never,
        { compress: { injectTool: true } } as never,
        undefined,
        { compress: { injectTool: true } } as never,
        undefined,
        true,
        false,
        false,
        false,
        TOC_BODY,
    );
    const text = asText(out);
    assert.ok(text.includes("client system prompt"));
    assert.ok(text.includes(TOC_HEADER));

    const tocAt = text.indexOf(TOC_HEADER);
    const anchorAt = compressAnchorIndex(text);
    assert.ok(anchorAt !== -1, "the static compress prompt must be present");
    assert.ok(tocAt > anchorAt, "the memory TOC must trail the static compress anchor (prefix-cache stability)");
    // Trailing means literally last: nothing but the TOC may follow it.
    assert.equal(text.slice(tocAt + TOC_BODY.length).trim(), "");
});

test("injectSystem keeps the TOC last for a block-array system", () => {
    const parsed = {
        model: "m",
        messages: [],
        system: [{ type: "text", text: "client block prompt", cache_control: { type: "ephemeral" } }],
    };
    const out = injectSystem(
        parsed as never,
        { compress: { injectTool: true } } as never,
        undefined,
        { compress: { injectTool: true } } as never,
        undefined,
        true,
        false,
        false,
        false,
        TOC_BODY,
    );
    assert.ok(Array.isArray(out), "an array system must stay an array");
    const parts = out as Array<{ text?: string }>;
    // Client blocks stay byte-exact and first; the appended blocks follow.
    assert.equal(parts[0]?.text, "client block prompt");
    const last = parts[parts.length - 1];
    assert.ok(String(last?.text ?? "").includes(TOC_HEADER), "the TOC is the trailing block");
    const text = asText(out);
    assert.ok(text.indexOf(TOC_HEADER) > compressAnchorIndex(text));
});

test("injectSystem omits the TOC when the knob renders no memory index", () => {
    const parsed = { model: "m", messages: [], system: "client system prompt" };
    const out = injectSystem(
        parsed as never,
        { compress: { injectTool: false } } as never,
        undefined,
        { compress: { injectTool: false } } as never,
        undefined,
        true,
        false,
        false,
        false,
        undefined,
    );
    assert.ok(!asText(out).includes(TOC_HEADER));
});

test("plugin mode gets the same TOC: proxy-side rendering needs no ACP tool surface", () => {
    // Plugin lanes (the agent owns the compress tool) still receive the index:
    // the proxy renders it from session state and the injected tools are
    // suppressed, so the TOC is the only place the model can learn which
    // milestones exist. Same window/knob semantics, no mode gate.
    const session = fakeSession([
        { blockId: "b4", active: true, topic: "Plugin-lane milestone" },
        { blockId: "b5", active: true, topic: "Another plugin milestone", tier: 2 },
    ]);
    const toc = renderSessionMemoryToc(session, { compress: { memoryToc: true, memoryTocWindow: 10 } } as never);
    assert.ok(toc);
    assert.ok(toc.includes("- b4: Plugin-lane milestone"));
    assert.ok(toc.includes("- b5 (T2): Another plugin milestone"));

    // Feeding it through injectSystem with the tool injection suppressed (the
    // plugin shape: no compress prompt, tags-only surface) still lands last.
    const parsed = { model: "m", messages: [], system: "plugin client system" };
    const out = injectSystem(
        parsed as never,
        { compress: { injectTool: false } } as never,
        undefined,
        { compress: { injectTool: false } } as never,
        undefined,
        true,
        true,
        false,
        false,
        toc,
    );
    const text = asText(out);
    assert.ok(text.includes("plugin client system"));
    assert.ok(text.includes(TOC_HEADER));
});

test("the window governs what the OpenAI lane pushes onto sysParts", () => {
    // prepare-openai appends renderMemoryToc's output to `sysParts` verbatim, so
    // pinning the renderer here pins the ordering property for that lane too:
    // window=N keeps the newest N blocks and folds the rest into one range line.
    const blocks = Array.from({ length: 15 }, (_, i) => ({ blockId: `b${i + 1}`, active: true, topic: `Milestone ${i + 1}` }));
    const toc = renderMemoryToc(blocks, { window: 10 });
    assert.ok(toc);
    const body = toc.split("\n").filter((line) => line.startsWith("- "));
    assert.equal(body.length, 10, "exactly `window` block lines are rendered");
    assert.equal(body[0], "- b6: Milestone 6");
    assert.equal(body[body.length - 1], "- b15: Milestone 15");
    assert.ok(toc.includes("5 older block(s)"), "the omitted range is named once");
    assert.ok(toc.includes("b1–b5"), "the overflow notice carries the omitted ref range");
    assert.ok(!toc.includes("- b5: Milestone 5"), "omitted blocks are not listed");

    // window <= 0 is the documented escape hatch: list every active block.
    const all = renderMemoryToc(blocks, { window: 0 });
    assert.ok(all);
    assert.equal(all.split("\n").filter((line) => line.startsWith("- ")).length, 15);
    assert.ok(!all.includes("older block(s)"));
});
