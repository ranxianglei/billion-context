import assert from "node:assert/strict";
import test from "node:test";
import { DSH_TITLE_SYSTEM_PREFIX, isDshTitleRequest, isSideRequest, resolveSideLane } from "../src/server/side-request.ts";

// #2503: dsh 0.2.1-alpha.2 raised its title-gen preset maxOutputTokens 64 ->
// 4096, which defeats the <=200 budget heuristic in isSideRequest — the title
// request then looks like a main turn and forks onto a persisted |sub: ghost
// session under the #1916 dsh persona fingerprint (e2e scenario A / #2241).
// These pins fix the new text-based carve-out and document the gap itself.

const TITLE_SYSTEM = `${DSH_TITLE_SYSTEM_PREFIX} from the supplied human messages.\nReturn only the title on one line.`;

function dshTitleBody(maxCompletionTokens: number, extra: Record<string, unknown> = {}, systemContent: unknown = TITLE_SYSTEM) {
    return {
        model: "fake-a",
        max_completion_tokens: maxCompletionTokens,
        messages: [
            { role: "system", content: systemContent },
            { role: "user", content: "[{\"role\":\"user\",\"content\":\"hello\"}]" },
        ],
        ...extra,
    };
}

test("isSideRequest misses the alpha.2 dsh title request (the gap this fix closes)", () => {
    assert.equal(isSideRequest(dshTitleBody(4096)), false, "4096 budget defeats the <=200 heuristic");
});

test("isSideRequest still catches the rc.2 dsh title request (legacy path intact)", () => {
    assert.equal(isSideRequest(dshTitleBody(64)), true, "64 budget rides the original heuristic");
});

test("isDshTitleRequest matches the alpha.2 title request shape", () => {
    assert.equal(isDshTitleRequest(dshTitleBody(4096)), true);
});

test("isDshTitleRequest vetoes any request carrying tools (a main turn can never demote through this path)", () => {
    const withTools = dshTitleBody(4096, { tools: [{ type: "function", function: { name: "bash" } }] });
    assert.equal(isDshTitleRequest(withTools), false);
});

test("isDshTitleRequest does not match other system prompts", () => {
    assert.equal(isDshTitleRequest(dshTitleBody(4096, {}, "You are a helpful assistant.")), false);
    assert.equal(isDshTitleRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }), false);
    assert.equal(isDshTitleRequest(null), false);
    assert.equal(isDshTitleRequest("nope"), false);
});

test("isDshTitleRequest accepts parts-array system content", () => {
    const body = dshTitleBody(4096, {}, [{ type: "text", text: TITLE_SYSTEM }]);
    assert.equal(isDshTitleRequest(body), true);
});

test("resolveSideLane: sideIntent=true still resolves the verbatim side lane (reason string unchanged)", () => {
    const r = resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "openai", stripApplied: false, sideIntent: true, requestAgent: undefined });
    assert.equal(r.lane, "side");
    assert.equal(r.demoted, false);
    assert.equal(r.reason, "max_tokens<=200");
});
