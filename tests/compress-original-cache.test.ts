import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { collectBlockContent, createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { getSession } from "../src/session.ts";
import { applyRanges } from "../src/stream.ts";

function history(): CoreMessage[] {
    return Array.from({ length: 7 }, (_, i) => ({
        id: "source_" + i, role: i % 2 ? "assistant" : "user", contentType: "text",
        text: Array.from({ length: 40 }, (_, j) =>
            ("Record " + i + "-" + j + ": checksum " + (i === 1 && j === 17 ? 2711 : i * 1000 + j) + "; verified source for later lookup.").padEnd(121, "."),
        ).join(" "),
    }));
}

for (const source of ["raw-with-display", "raw-with-empty-display", "display-only"] as const) {
    test("compression caches its authoritative source after emergency truncation: " + source, () => {
        const core = createCore(), config = defaultConfig(15904);
        const session = getSession("original-cache-" + randomUUID());
        const raw = history();
        const turn = core.processTurn({ messages: raw, state: session.state, config, tokenCount: 18500, tokenCountSource: "usage", renderTags: "text-only" });
        session.state = turn.state;
        const target = "Record 1-17: checksum 2711";
        assert.ok(raw[1]!.text?.includes(target));
        assert.ok(!turn.messages.some(message => message.text?.includes(target)), "real emergency truncation must hide the middle record");
        const applyView = source === "display-only" ? turn.messages : raw.map(message => {
            if (source === "raw-with-empty-display") return message;
            const rendered = turn.messages.find(candidate => candidate.id === message.id);
            const tag = rendered?.text?.split("\n")[0];
            assert.match(tag ?? "", /^\x3cacp /, "the emergency view retains a citation line");
            return { ...message, text: tag + "\n" + message.text };
        });
        const ctx = {
            core, config, session, log: () => {},
            messages: source === "raw-with-empty-display" ? [] : turn.messages,
            ...(source === "display-only" ? {} : { compressMessages: raw }),
        };
        const compressed = applyRanges(parseCompressInput({ content: "m00001–m00002 Verified source archive\nTASK AS OF THIS BLOCK: source verification is complete. Exact values are omitted from this summary; retrieve the archived sources for the pending lookup." }), ctx);
        assert.equal(compressed.outcome, "applied");
        const block = session.state.blocks.find(candidate => candidate.active)!;
        const expected = collectBlockContent(session.state, block, applyView, { full: true });
        assert.equal(session.blockContents.get(block.blockId)?.full.text, expected.text, "cache must preserve the complete fold source and its displayed citations");
        const evicted = { ...ctx, messages: [], compressMessages: [] };
        for (const full of [false, true]) {
            const restored = resolveDecompress({ blockId: block.blockId, full }, evicted);
            assert.equal(restored.outcome, "success");
            assert.ok(restored.text.includes(expected.text), "leaf originals must survive loss of both live views");
            assert.equal(restored.text.includes(target), source !== "display-only");
        }
    });
}

test("original caching copies only a leading citation belonging to the same source message", () => {
    const core = createCore(), config = defaultConfig(100000);
    const session = getSession("original-citations-" + randomUUID());
    const raw = history();
    const turn = core.processTurn({ messages: raw, state: session.state, config, tokenCount: 18500 });
    session.state = turn.state;
    const tag = '\x3cacp tokens="2.5K" type="text" time="2026-11-15 00:00:00"\x3em00001\x3c/acp\x3e\n';
    const foreignTag = '\x3cacp tokens="1" type="text"\x3em99999\x3c/acp\x3e\n';
    const secondTag = '\x3cacp tokens="1" type="text"\x3em00002\x3c/acp\x3e\n';
    for (const [label, displayed, expectedFirst, expectedSecond] of [
        ["owned", [tag + "clipped", foreignTag + "clipped"], tag + raw[0]!.text, raw[1]!.text],
        ["quoted", ["quoted: " + tag, "prose\n" + secondTag], raw[0]!.text, raw[1]!.text],
    ] as const) {
        const fresh = getSession("original-citations-" + label + randomUUID());
        fresh.state = turn.state;
        const ctx = { core, config, session: fresh, log: () => {}, compressMessages: raw,
            messages: raw.map((message, index) => ({ ...message, text: displayed[index] === undefined
                ? message.text : displayed[index] + "Display-only filler. ".repeat(100) })),
        };
        const result = applyRanges(parseCompressInput({ content: "m00001–m00002 Archive\nVerified source records and their checksums are archived for a later exact lookup." }), ctx);
        assert.equal(result.outcome, "applied", JSON.stringify(result));
        const block = fresh.state.blocks.find(candidate => candidate.active)!;
        assert.equal(fresh.blockContents.get(block.blockId)?.full.text, "[user]\n" + expectedFirst + "\n\n[assistant]\n" + expectedSecond);
        assert.equal(raw[0]!.text, history()[0]!.text, "adding cache citations must not mutate the source");
    }
});
