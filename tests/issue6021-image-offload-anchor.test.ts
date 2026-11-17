// #6021: dsh compaction-image-offload rewrites an OLD message's inline image
// into placeholder prose when the route's request budget is exceeded. The
// rewrite changes content identity, so bili re-ingests the cell as a NEW row
// (fresh ref / storage seq / timestamp) — a two-day-old message now sitting at
// the TAIL of the resent history. Unclassified, the placeholder is plain
// user-role text: once everything after the newest human request has folded
// away, that stale prose is the last visible user message, wins the Rule-3
// last-user anchor (#5109), pins the protected zone on the stale topic and the
// model answers it for the whole turn. #5752 shipped the sibling live handle
// with this slot deliberately unclassified; this file pins the deferred family
// at all three levels (classifier units per #3617, BOTH-registries wiring, and
// end-to-end anchor geometry through the REAL dsh classifier).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assignRefs, createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import {
    dshImageHandlePath,
    dshImageOffloadPlaceholderPath,
    durableMessageToolPaths,
    oneShotCarrierPaths,
    withDurableProtection,
} from "../src/durable-message-guards.ts";

function mk(id: string, role: CoreMessage["role"], text: string): CoreMessage {
    return { id, role, contentType: "text", text } as CoreMessage;
}

const PLACEHOLDER = '[image omitted to fit request image limits; "image.png" (sha256:0e596a186ab8f0c2d4e6a7b9). Normalized copy (read-only; may be resized or re-encoded): "C:/Users/x/.dsh/attachments/v1/objects/0e/0e596a186ab8f0c2d4e6a7b9" (1584x892px, image/png).]';
const PLACEHOLDER_TEXT_ONLY = "[image omitted because this model accepts text only; attachment sha256:0e596a186ab8f0c2d4e6a7b9.]";

describe("#6021 dshImageOffloadPlaceholderPath units", () => {
    test("positives: production spliced shape, pure placeholder, text-only route", () => {
        // m03269 shape: placeholder opens the cell, the user's own prose follows
        // AFTER the "]" tail (the original message was [text, image]).
        assert.equal(dshImageOffloadPlaceholderPath(mk("u1", "user", `${PLACEHOLDER}有点小问题，这些unknown的按键应该是手柄按键，不应该统计`)), "oneshot/image-offload-placeholder");
        assert.equal(dshImageOffloadPlaceholderPath(mk("u2", "user", PLACEHOLDER)), "oneshot/image-offload-placeholder", "m03272 shape: pure placeholder");
        assert.equal(dshImageOffloadPlaceholderPath(mk("u3", "user", PLACEHOLDER_TEXT_ONLY)), "oneshot/image-offload-placeholder", "text-only route variant shares the path");
        assert.equal(dshImageOffloadPlaceholderPath(mk("u4", "user", `saw ${PLACEHOLDER} in the log yesterday`)), "oneshot/image-offload-placeholder", "substring match is deliberate: prefix match misses the spliced shape");
    });

    test("negatives: assistant echo, pi-lane wording, live handle, prose near-miss", () => {
        assert.equal(dshImageOffloadPlaceholderPath(mk("a1", "assistant", PLACEHOLDER)), undefined, "assistant echo must never classify (#2766)");
        assert.equal(dshImageOffloadPlaceholderPath(mk("p1", "user", "(image omitted: model does not support images)")), undefined, "pi-lane non-vision placeholder is different wording (src/agent/pi-msgids.ts)");
        const handle = 'Image "x.png" (sha256:2e896b95dec003df); request preview 1600x900px. Normalized copy (read-only; may be resized or re-encoded): "normalized/x.png" (1600x900px, image/png).';
        assert.equal(dshImageOffloadPlaceholderPath(mk("h1", "user", handle)), undefined, "live handle stays its own family");
        assert.equal(dshImageHandlePath(mk("h2", "user", PLACEHOLDER)), undefined, "placeholder does not claim the live-handle slot either (#5142 negative pin stays true)");
        assert.equal(dshImageOffloadPlaceholderPath(mk("n1", "user", "the image omitted part confused me")), undefined, "prose without the full marker stays unmatched");
        const tool = { id: "t1", role: "tool" as const, contentType: "tool-result" as const, text: PLACEHOLDER } as CoreMessage;
        assert.equal(dshImageOffloadPlaceholderPath(tool), undefined, "tool channel is not a carrier surface");
    });

    test("BOTH registries resolve the production shape (wiring)", () => {
        const msg = mk("w", "user", `${PLACEHOLDER}有点小问题，这些unknown的按键应该是手柄按键，不应该统计`);
        assert.equal(durableMessageToolPaths.dsh!(msg), "oneshot/image-offload-placeholder", "slot-exclusion registry");
        assert.equal(oneShotCarrierPaths.dsh!(msg), "oneshot/image-offload-placeholder", "drift-accounting registry");
    });
});

describe("#6021 end-to-end anchor geometry", () => {
    test("fold covering the offloaded tail keeps the live request visible (THE repro)", () => {
        const config = withDurableProtection(
            defaultConfig(200000, { preserveRecentMessages: 1, preserveRecentTokens: 0 }),
            durableMessageToolPaths.dsh!,
        );
        const run = (msgs: CoreMessage[], startRef: string, endRef: string) => {
            const c = createCore();
            const st = createInitialState();
            st.messageRefs = assignRefs(msgs, { existing: st.messageRefs, nextIndex: 1 }).map;
            return c.applyCompression({
                ranges: [{ startRef, endRef, summary: "A long enough summary body to satisfy the minimum summary length gate of fifty characters." }],
                messages: msgs,
                state: st,
                config,
            });
        };

        // THE repro (mirrors m02528 -> m03269/m03272 in #6021): the offload
        // rewrite lands AFTER the real question. Pre-fix the anchor was ph (the
        // stale placeholder prose), so #3953 truncated at ph and folded live —
        // the instruction the model is currently answering. Post-fix ph loses
        // slot eligibility and the anchor is live again.
        {
            // PAD clears config.compress.minCompressRange (5000 chars) on the
            // foldable subset (o1+o2).
            const PAD = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(60);
            const LIVE = "current live request: check why the unknown keys register";
            const msgs: CoreMessage[] = [
                mk("o1", "user", `old question ${PAD}`),
                mk("o2", "assistant", `old answer ${PAD}`),
                mk("live", "user", LIVE),
                mk("ph", "user", `${PLACEHOLDER}有点小问题，这些unknown的按键应该是手柄按键，不应该统计`),
                mk("a3", "assistant", `working on it ${PAD}`),
            ];
            const res = run(msgs, "m00001", "m00004");
            assert.equal(res.result.blocksCreated, 1, `expected one block, got errors=${JSON.stringify(res.result.errors)} warnings=${JSON.stringify(res.result.warnings)}`);
            const block = res.state.blocks.find((b) => b.active)!;
            assert.deepEqual([...block.effectiveMessageIds].sort(), ["o1", "o2"], "only pre-anchor content folds; #3953 keeps everything at/after the live request visible");
            assert.ok(
                res.result.warnings.some((w) => w.startsWith("Excluded") && w.includes("Last-user anchor: m00003")),
                `receipt names the anchor ref, got: ${JSON.stringify(res.result.warnings)}`,
            );
        }

        // No-bloat pin: once the rewritten cell sits BEFORE the live request
        // (steady state on later turns), it folds like any other history —
        // classification removes slot eligibility only, never foldability.
        {
            const PAD2 = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(60);
            const msgs: CoreMessage[] = [
                mk("q1", "user", `old question ${PAD2}`),
                mk("a1", "assistant", `old answer ${PAD2}`),
                mk("ph1", "user", PLACEHOLDER),
                mk("live", "user", "current live request: continue"),
            ];
            const res = run(msgs, "m00001", "m00003");
            assert.equal(res.result.blocksCreated, 1, `expected one block, got errors=${JSON.stringify(res.result.errors)} warnings=${JSON.stringify(res.result.warnings)}`);
            const block = res.state.blocks.find((b) => b.active)!;
            assert.deepEqual([...block.effectiveMessageIds].sort(), ["a1", "ph1", "q1"].sort(), "classified placeholders fold normally when they are ahead of the live request");
        }
    });
});
