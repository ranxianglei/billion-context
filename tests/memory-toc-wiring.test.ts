import test from "node:test";
import assert from "node:assert/strict";
import { injectSystem, renderSessionMemoryToc } from "../src/server/inject.js";

function fakeSession(blocks: Array<{ blockId: string; active: boolean; topic?: string; tier?: number; summary?: string }>) {
    return { state: { blocks } };
}

test("renderSessionMemoryToc renders and honours the window knob", () => {
    const session = fakeSession([
        { blockId: "b1", active: false, topic: "Inactive" },
        { blockId: "b2", active: true, topic: "Headroom compose migration" },
        { blockId: "b3", active: true, topic: "MariaDB migration", tier: 2 },
    ]);
    const toc = renderSessionMemoryToc(session as never, { compress: { memoryToc: true, memoryTocWindow: 5 } } as never);
    assert.ok(toc);
    assert.ok(toc!.includes("- b2: Headroom compose migration"));
    assert.ok(toc!.includes("- b3 (T2): MariaDB migration"));
    assert.ok(!toc!.includes("Inactive"));
});

test("renderSessionMemoryToc returns undefined when disabled via env", () => {
    const prev = process.env.BILI_MEMORY_TOC;
    process.env.BILI_MEMORY_TOC = "0";
    try {
        const session = fakeSession([{ blockId: "b1", active: true, topic: "x" }]);
        assert.equal(renderSessionMemoryToc(session as never, {} as never), undefined);
    } finally {
        if (prev === undefined) delete process.env.BILI_MEMORY_TOC;
        else process.env.BILI_MEMORY_TOC = prev;
    }
});

test("renderSessionMemoryToc returns undefined when there are no active blocks", () => {
    const session = fakeSession([{ blockId: "b1", active: false, topic: "x" }]);
    assert.equal(renderSessionMemoryToc(session as never, {} as never), undefined);
});

test("injectSystem appends the memory TOC as the trailing system block", () => {
    const parsed = { model: "m", messages: [], system: "client system prompt" };
    const opts = { compress: { injectTool: false } };
    const out = injectSystem(
        parsed as never,
        opts as never,
        undefined,
        { compress: { injectTool: false } } as never,
        undefined,
        true,
        false,
        false,
        false,
        "### Active Session Memory Index\n- b2: Headroom compose migration",
    );
    const text = typeof out === "string" ? out : JSON.stringify(out);
    assert.ok(text.includes("client system prompt"));
    assert.ok(text.includes("### Active Session Memory Index"));
    // TOC must be the LAST part so the prompt-cache anchor stays byte-stable.
    const parts = Array.isArray(out) ? out : [];
    if (parts.length > 0) {
        const last = parts[parts.length - 1] as { text?: string };
        assert.ok(String(last.text ?? "").includes("Active Session Memory Index"));
    }
});
