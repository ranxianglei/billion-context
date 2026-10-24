import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { reconcileFoldCoverage } from "../src/fold-reconcile.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { createSession } from "../src/session.ts";
import { applyRanges } from "../src/stream.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

for (const shape of ["one-interior-survivor", "all-missing", "small-zombie"] as const) {
    test(`#4260 epoch confirmation retains real kernel folds: ${shape}`, () => {
        const dir = mkdtempSync(join(tmpdir(), "bili-epoch-confirm-"));
        try {
            const core = createCore();
            const config = defaultConfig(200_000);
            const session = createSession(`epoch-confirm-${shape}`);
            const messages: CoreMessage[] = Array.from({ length: 40 }, (_, i) => ({
                id: `h_original_${i}`, role: i % 2 ? "assistant" : "user", contentType: "text",
                text: `Historical detail ${i}: ${String.fromCharCode(65 + i % 26).repeat(2000)}`,
            }));
            const tick = (incoming: CoreMessage[]) => {
                const turn = core.processTurn({ messages: incoming, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
                session.state = turn.state;
                return turn;
            };
            const initial = tick(messages);
            const summary = "The early history establishes independent details for an epoch-confirmation recovery regression, with original content retained for later retrieval.";
            applyRanges(parseCompressInput({ content: [{
                startId: "m00001", endId: shape === "small-zombie" ? "m00007" : "m00020", summary,
            }] }), { core, config, messages: initial.messages, session, log: () => {} });
            assert.equal(session.state.blocks.length, 1);
            const blockId = session.state.blocks[0].blockId;
            const original = session.blockContents.get(blockId)?.full.text;
            assert.ok(original);
            const opts = { mode: "repair" as const, inboundMessageCount: 40, log: () => {} };
            reconcileFoldCoverage(session, messages, opts);
            tick(messages);
            const foreign: CoreMessage[] = Array.from({ length: 40 }, (_, i) => ({
                id: `h_foreign_${i}`, role: i % 2 ? "assistant" : "user", contentType: "text",
                text: `Unrelated narrative ${i} with different evidence ${"qzjy".repeat(500)}`,
            }));
            if (shape !== "all-missing") foreign[15] = messages[shape === "small-zombie" ? 3 : 10];
            for (let pass = 1; pass <= 5; pass++) {
                const rec = reconcileFoldCoverage(session, foreign, opts);
                tick(foreign);
                assert.equal(rec.reaped, shape === "small-zombie" && pass === 3 ? 1 : 0);
                if (shape === "one-interior-survivor") {
                    assert.equal(session.state.blocks.length, 1);
                    assert.equal(session.state.blocks[0].active, true);
                    assert.equal(session.metadata.foldEpochConfirmPending === true, pass >= 3);
                }
                if (shape === "all-missing") {
                    assert.equal(session.state.blocks.length, 1);
                    assert.equal(session.state.blocks[0].active, false);
                    // #3641 boundary 4 / MESSAGE-IDENTITY.md epoch-confirm gate: total collapse latches
                    // like partial coverage — the kernel deactivates the zero-coverage block, but the
                    // snapshot is retained and folding pauses until realignment or a user-confirmed epoch.
                    assert.equal(session.metadata.foldEpochConfirmPending === true, pass >= 3);
                }
            }
            assert.equal(session.blockContents.get(blockId)?.full.text, original);
            const receipt = resolveDecompress({ blockId, full: true, toFile: join(dir, "original.txt") },
                { core, config, messages: [], session, log: () => {} }).text;
            assert.equal(receipt.startsWith("[decompress FAILED:"), shape === "small-zombie");
            reconcileFoldCoverage(session, messages, opts);
            const returned = tick(messages);
            assert.equal(session.metadata.foldEpochConfirmPending === true, false);
            assert.equal(session.state.blocks.length, shape === "small-zombie" ? 0 : 1);
            assert.equal(returned.messages.some(m => m.text?.includes(summary)), shape !== "small-zombie");
            if (shape !== "small-zombie") {
                assert.equal(session.state.blocks[0].active, true);
                assert.equal(returned.messages.some(m => m.text?.includes("Historical detail 5:")), false);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
}
