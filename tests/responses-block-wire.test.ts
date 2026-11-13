import assert from "node:assert/strict";
import test from "node:test";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { ResponseInputItem } from "acp-kernel/wire";
import { responsesToCoreWithToolImages as project, patchResponsesInputWithToolImages as patch, coreToResponsesWithToolImages as encode } from "../src/responses-tool-output.ts";

function images(input: unknown): unknown[] {
    if (Array.isArray(input)) return input.flatMap(images);
    if (!input || typeof input !== "object") return [];
    const item = input as Record<string, unknown>;
    return item.type === "input_image" ? [item] : Object.values(item).flatMap(images);
}

for (const n of [1, 2, 12, 17, 26]) {
    test(`host projection preserves ${n} images when current core IDs differ from layout IDs`, () => {
        const input: ResponseInputItem[] = [{ type: "message", role: "user", content: Array.from({ length: n }, (_, i) => [
            { type: "input_text", text: `caption ${i}`, annotations: [`source-${i}`] },
            { type: "input_image", image_url: `https://example.invalid/${i}.png`, detail: i % 2 ? "low" : "high" },
        ]).flat() }];
        const projection = project({ input });
        assert.deepEqual(patch(projection, projection.msgs), input);
        assert.deepEqual(encode(projection.msgs), input);
        const remapped = projection.msgs.map(message => ({ ...message, id: `fresh_${message.id}` }));
        assert.deepEqual(images(patch(projection, remapped)), images(input), "each surviving part must be emitted exactly once");
    });
}

test("partial block view keeps B, its detail and caption metadata, without resurrecting A", () => {
    const a = { type: "input_image", image_url: "https://example.invalid/A.png", detail: "low" };
    const b = { type: "input_image", image_url: "https://example.invalid/B.png", detail: "high" };
    const caption = { type: "input_text", text: "retained B caption", annotations: ["keep"] };
    const projection = project({ input: [{ type: "message", role: "user", content: [a, caption, b] }] });
    const partial = projection.msgs.slice(1);
    assert.deepEqual(images(patch(projection, partial)), [b]);
    assert.deepEqual((patch(projection, partial) as ResponseInputItem[])[0]!.content, [caption, b]);
    const between = { id: "inserted-summary", role: "user" as const, contentType: "text" as const, text: "Retained block summary at its original position." };
    const separated = patch(projection, [projection.msgs[0]!, between, projection.msgs[2]!]) as ResponseInputItem[];
    assert.deepEqual(images(separated[0]), [a]);
    assert.ok(JSON.stringify(separated[1]).includes(between.text), "the summary stays between retained source parts");
    assert.deepEqual(images(separated[2]), [b]);
});

test("a real block replaces its originals on resends and preserves genuinely new identical instances once", () => {
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const a = { type: "input_image", image_url: image, detail: "low" };
    const b = { type: "input_image", image_url: image, detail: "high" };
    const input: ResponseInputItem[] = [
        { type: "message", role: "user", content: "independent opening" },
        { type: "message", role: "assistant", content: "ready" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Historical A facts and constraints. ".repeat(200) }, a,
            { type: "input_text", text: "Retained B facts." }, b] },
        { type: "message", role: "assistant", content: "Continue from the retained decisions." },
    ];
    const projection = project({ input });
    const core = createCore();
    const config = { ...defaultConfig(100_000), preserveRecentMessages: 0, preserveRecentTokens: 0 };
    const initial = core.processTurn({ messages: projection.msgs, state: createInitialState(), config, tokenCount: 3000, renderTags: "none" });
    const summary = "A facts established the archived screenshot's constraints; retain those decisions while continuing from screenshot B.";
    const folded = core.applyCompression({ messages: projection.msgs, state: initial.state, config, ranges: [{
        startRef: initial.state.messageRefs.byRaw[projection.msgs[2]!.id]!, endRef: initial.state.messageRefs.byRaw[projection.msgs[3]!.id]!, summary,
    }] });
    assert.equal(folded.result.blocksCreated, 1, JSON.stringify(folded.result));
    for (const prior of [initial.state.lastPassIds ?? [], []]) {
        const turn = core.processTurn({ messages: projection.msgs, state: { ...structuredClone(folded.state), lastPassIds: prior }, config, tokenCount: 3000, renderTags: "none" });
        const wire = patch(projection, turn.messages);
        if (prior.length > 0) {
            assert.ok(turn.state.blocks.some(block => block.active), "the compression block remains active");
            assert.ok(JSON.stringify(wire).includes(summary), "the block summary replaces the original facts");
            assert.deepEqual(images(wire), [b], "archived A must stay out while B remains exactly once");
        } else {
            // The kernel deliberately treats absent-prior content as a new
            // identical instance (#1476), rather than hiding new work under an
            // old fold. The host must emit that current view without n² replay.
            assert.deepEqual(images(wire), [a, b]);
        }
    }
});
