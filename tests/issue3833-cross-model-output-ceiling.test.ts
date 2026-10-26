import assert from "node:assert/strict";
import test from "node:test";

import { clampOutputBudget, restoreOutputBudget } from "../src/server.ts";

// #3833: one DSH session ran a model declaring output 256000 (deepseek-flash) and
// then switched back to glm-5.3 (declared ceiling 131072). The session-level
// high-water still held 256000; after history grew past the 1M window the client
// shrank max_tokens to 1 and bili's #546 rescue restored the stale 256000 — which
// glm rejects with 400 code 1210 ("max_tokens参数非法：限制数值范围[1,131072]").
// Root cause: neither the #546 restore nor the #453 clamp honored the CURRENT
// model's declared output ceiling — the restored value rides a session scalar with
// no model dimension straight into the next model's request.

const noopLog = (): void => {};
function freshSession(id: string): { id: string; metadata: Record<string, unknown> } {
    return { id, metadata: {} };
}

test("restoreOutputBudget: cross-model high-water above the current ceiling clamps + corrects in place (#3833)", () => {
    const s = freshSession("xmodel");
    // Learned under the previous model (declared output 256000).
    restoreOutputBudget({ max_tokens: 256_000, model: "deepseek/deepseek-flash" }, s, noopLog);
    assert.equal(s.metadata.outputBudgetHighWater, 256_000, "high-water learned under the previous model");
    // The incident request: starved back on glm-5.3 whose ceiling is 131072.
    const starved = { max_tokens: 1, tools: [{ name: "t" }], model: "zai/glm-5.3" } as { max_tokens: number };
    restoreOutputBudget(starved, s, noopLog, 131_072);
    assert.equal(starved.max_tokens, 131_072, "restored to the CURRENT model's ceiling, not the stale 256000 (#3833)");
    assert.equal(s.metadata.outputBudgetHighWater, 131_072, "over-bound high-water corrected in place so later turns stop replaying 256000 (#3833)");
    // A subsequent starve stays corrected — never re-poisoned back to 256000.
    const again = { max_tokens: 1, tools: [{ name: "t" }], model: "zai/glm-5.3" } as { max_tokens: number };
    restoreOutputBudget(again, s, noopLog, 131_072);
    assert.equal(again.max_tokens, 131_072, "subsequent starve holds at the corrected ceiling (#3833)");
});

test("restoreOutputBudget: a below-ceiling water keeps the pre-existing raise-to-ceiling rescue (#3833 negative)", () => {
    const s = freshSession("xmodel-low");
    restoreOutputBudget({ max_tokens: 50_000, model: "zai/glm-5.3" }, s, noopLog);
    const starved = { max_tokens: 1, tools: [{ name: "t" }], model: "zai/glm-5.3" } as { max_tokens: number };
    restoreOutputBudget(starved, s, noopLog, 131_072);
    assert.equal(starved.max_tokens, 131_072, "below-ceiling water still raises to the ceiling (#1665 rescue preserved)");
    assert.equal(s.metadata.outputBudgetHighWater, 50_000, "a below-ceiling water is NOT rewritten (only over-bound waters are corrected)");
});

test("clampOutputBudget: window headroom above the model ceiling clamps to the ceiling (#3833)", () => {
    // The incident numbers: requested 256000, input ~827069, window 1000000, ceiling
    // 131072. Window headroom alone is floor(1000000 - 827069 - margin) with
    // margin = ceil(827069 * 0.05) = 41354 -> 131577 (> 131072). The ceiling must
    // bind so the emitted budget is 131072, not 131577.
    const capped = clampOutputBudget(256_000, 827_069, 1_000_000, 131_072);
    assert.equal(capped, 131_072, "clamped to the model's declared output ceiling, not the larger window headroom (#3833)");
});

test("clampOutputBudget: an absent ceiling is byte-identical to the legacy window-only cap (#3833 negative)", () => {
    // Same numbers WITHOUT a ceiling -> the legacy headroom cap (131577) applies,
    // proving the ceiling term only engages when a bound is actually known.
    const legacy = clampOutputBudget(256_000, 827_069, 1_000_000);
    const margin = Math.max(2048, Math.ceil(827_069 * 0.05));
    assert.equal(legacy, Math.floor(1_000_000 - 827_069 - margin), "no ceiling -> legacy window-only headroom cap unchanged");
    assert.ok((legacy ?? 0) > 131_072, "the legacy cap sits ABOVE the ceiling — exactly the gap #3833 closes");
});
