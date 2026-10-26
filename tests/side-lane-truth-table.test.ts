import assert from "node:assert/strict";
import test from "node:test";
import { demoteGate, DSH_TITLE_SYSTEM_PREFIX, isDshTitleRequest, isSideRequest, resolveSideLane, SIDE_REQUEST_MAX_TOKENS } from "../src/server/side-request.ts";

// #2170 measure 1: exhaustive truth-table pin for the two extracted lane
// decision functions. These tables ARE the regression net: any future edit to
// a conjunct, a veto, or a reason string changes a cell here and forces the
// author to also touch tests/ — which is exactly what the lane-guard CI job
// (#2170 measure 5) demands. The reference formulas below are the pre-#2170
// inline expressions from src/server.ts, copied verbatim.

const AGENT_STATES: (string | undefined)[] = [undefined, "main", "title"];

test("demoteGate: exhaustive over every signal combination vs the reference conjunction", () => {
    for (const countTokens of [false, true]) {
        for (const responsesCompact of [false, true]) {
            for (const protocol of [null, "anthropic", "responses"] as const) {
                for (const pluginMode of [false, true]) {
                    for (const requestAgent of AGENT_STATES) {
                        for (const wsLaneEnvelope of [false, true]) {
                            for (const publicForkPrefix of [false, true]) {
                                const got = demoteGate({ countTokens, responsesCompact, protocol, pluginMode, requestAgent, wsLaneEnvelope, publicForkPrefix });
                                // reference: the original inline expression (pre-#2170 server.ts)
                                const want = !countTokens && !responsesCompact && protocol !== null && pluginMode
                                    && requestAgent !== "main" && !wsLaneEnvelope && !publicForkPrefix;
                                assert.equal(got, want, JSON.stringify({ countTokens, responsesCompact, protocol, pluginMode, requestAgent, wsLaneEnvelope, publicForkPrefix }));
                            }
                        }
                    }
                }
            }
        }
    }
});

test("demoteGate: the #2164 fork veto is structural — publicForkPrefix=true always vetoes, for every other signal combination", () => {
    let combos = 0;
    for (const countTokens of [false, true]) {
        for (const responsesCompact of [false, true]) {
            for (const protocol of [null, "anthropic"] as const) {
                for (const pluginMode of [false, true]) {
                    for (const requestAgent of AGENT_STATES) {
                        for (const wsLaneEnvelope of [false, true]) {
                            combos++;
                            assert.equal(demoteGate({ countTokens, responsesCompact, protocol, pluginMode, requestAgent, wsLaneEnvelope, publicForkPrefix: true }), false, "a verified public-fork prefix must veto heuristic demotion in every configuration");
                        }
                    }
                }
            }
        }
    }
    assert.ok(combos >= 24, `exercised ${combos} combinations`);
});

test("resolveSideLane: exhaustive over every signal combination vs the reference expression", () => {
    for (const countTokens of [false, true]) {
        for (const responsesCompact of [false, true]) {
            // #2203: "responses" added — the dsh persona split now consumes this
            // gate's verdict on the Responses wire (sideRequestLike conjunct in
            // src/server.ts), so every cell there must be table-covered.
            for (const protocol of [null, "anthropic", "responses"] as const) {
                for (const stripApplied of [false, true]) {
                    for (const sideIntent of [false, true]) {
                        for (const requestAgent of AGENT_STATES) {
                            const d = resolveSideLane({ countTokens, responsesCompact, protocol, stripApplied, sideIntent, requestAgent });
                            // reference: the original inline lane condition (pre-#2170 server.ts)
                            const side = !countTokens && !responsesCompact && protocol !== null && (stripApplied || sideIntent);
                            assert.equal(d.lane, side ? "side" : "main", JSON.stringify({ countTokens, responsesCompact, protocol, stripApplied, sideIntent, requestAgent }));
                            assert.equal(d.demoted, side && stripApplied, `demoted ⊆ side, and equals the strip: ${JSON.stringify(d)}`);
                            if (d.lane === "main") {
                                const expected = countTokens || responsesCompact || protocol === null ? "not a model turn" : "main turn";
                                assert.equal(d.reason, expected, `main-lane reason: ${JSON.stringify(d)}`);
                            }
                        }
                    }
                }
            }
        }
    }
});

test("resolveSideLane: reason strings for the three side shapes", () => {
    assert.equal(resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: true, sideIntent: false, requestAgent: undefined }).reason, "leaked bili tools stripped (#1897)");
    assert.equal(resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: false, sideIntent: true, requestAgent: "title" }).reason, "agent=title");
    assert.equal(resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: false, sideIntent: true, requestAgent: undefined }).reason, `max_tokens<=${SIDE_REQUEST_MAX_TOKENS}`);
});

test("resolveSideLane: no fork input exists — intent-certain side requests ride the lane under a fork receipt (#2164 fix pin)", () => {
    // The #2157→#2164 regression was exactly this cell: a fork-child
    // title-gen. resolveSideLane has no fork field to consult, so the cell
    // cannot regress without removing the function's inputs (a visible,
    // reviewable change). Pin the decision:
    const d = resolveSideLane({ countTokens: false, responsesCompact: false, protocol: "anthropic", stripApplied: false, sideIntent: true, requestAgent: "title" });
    assert.equal(d.lane, "side");
    assert.equal(d.demoted, false);
    // and the fork-vetoed demote shape stays OFF the strip path while still
    // riding via intent (the two gates are complementary, not redundant):
    assert.equal(demoteGate({ countTokens: false, responsesCompact: false, protocol: "anthropic", pluginMode: true, requestAgent: "title", wsLaneEnvelope: false, publicForkPrefix: true }), false);
});

test("SIDE_REQUEST_MAX_TOKENS stays 200 (budget-heuristic width is load-bearing)", () => {
    assert.equal(SIDE_REQUEST_MAX_TOKENS, 200);
});

test("isSideRequest sanity anchors for the table above (agent wins, main never demotes, tools veto, budget path)", () => {
    assert.equal(isSideRequest({}, "title"), true);
    assert.equal(isSideRequest({ max_tokens: 64 }, "main"), false);
    assert.equal(isSideRequest({ max_tokens: 64, tools: [{ name: "x" }] }, undefined), false);
    assert.equal(isSideRequest({ max_tokens: 64 }, undefined), true);
    assert.equal(isSideRequest({ max_tokens: 1024 }, undefined), false);
    assert.equal(isSideRequest({ tools: [{ name: "bili_compact" }] }, undefined), false);
});

test("isSideRequest: dsh auto-review shape over the Responses wire stays off the side lane (#2203)", () => {
    // Production shape from #2203: fixed REVIEW_POLICY instructions + one
    // flattened user blob, NO tools, budget either explicit-large (the client
    // clamps to the model default ~384K) or absent entirely. Both must stay
    // OFF the side lane — the Responses-wire persona split keys these requests
    // by fingerprint instead, which requires sideRequestLike=false in
    // src/server.ts. A regression here would silently re-route reviews to the
    // passthrough — the exact opposite of the fix's intent.
    assert.equal(isSideRequest({ max_output_tokens: 384_000 }, undefined), false);
    assert.equal(isSideRequest({}, undefined), false);
});

// #3149: the dsh title sidecar is a LANE input, and every wire carries its
// system text differently (anthropic: TOP-LEVEL system, messages[] holds only
// the user blob — the carrier #2503 never read). The table pins every carrier
// the predicate must read plus the closures; the lane-guard job (#2170) ties it
// to the gate edit.
const TITLE_TEXT = `${DSH_TITLE_SYSTEM_PREFIX} from the supplied human messages.`;
const TITLE_CARRIER_ROWS: [string, Record<string, unknown>, boolean][] = [
    ["openai: messages system string", { messages: [{ role: "system", content: TITLE_TEXT }, { role: "user", content: "hi" }] }, true],
    ["openai: messages system parts array", { messages: [{ role: "system", content: [{ type: "text", text: TITLE_TEXT }] }] }, true],
    ["openai: developer-role carrier", { messages: [{ role: "developer", content: TITLE_TEXT }] }, true],
    ["anthropic: top-level system string", { system: TITLE_TEXT, messages: [{ role: "user", content: "[]" }] }, true],
    ["anthropic: top-level system text-block array", { system: [{ type: "text", text: TITLE_TEXT }], messages: [{ role: "user", content: "[]" }] }, true],
    ["responses: top-level instructions", { instructions: TITLE_TEXT, input: [{ role: "user", content: "hi" }] }, true],
    ["responses: input system entry", { input: [{ role: "system", content: TITLE_TEXT }] }, true],
    ["google: systemInstruction parts", { systemInstruction: { parts: [{ text: TITLE_TEXT }] }, contents: [{ role: "user", parts: [{ text: "hi" }] }] }, true],
    ["anthropic: no title text", { system: "MAIN SYSTEM", messages: [{ role: "user", content: "[]" }] }, false],
    ["anthropic: a tool-carrying main turn is vetoed", { tools: [{ name: "bash" }], system: TITLE_TEXT, messages: [{ role: "user", content: "[]" }] }, false],
    ["no system carrier at all", { messages: [{ role: "user", content: "hi" }] }, false],
];

test("isDshTitleRequest: every wire's system carrier is read (the #3149 anthropic blind spot)", () => {
    for (const [name, body, want] of TITLE_CARRIER_ROWS) {
        assert.equal(isDshTitleRequest(body), want, name);
    }
});

// #3153 review: this PR retires tests/dsh-title-side-lane.test.ts (#2503). Its
// remaining pins — the budget-heuristic boundary around the title body and the
// non-object guard — move here so the ledger does not shrink with the file.
function dshTitleBody(maxCompletionTokens: number): Record<string, unknown> {
    return {
        model: "fake-a",
        max_completion_tokens: maxCompletionTokens,
        messages: [
            { role: "system", content: TITLE_TEXT },
            { role: "user", content: "[{\"role\":\"user\",\"content\":\"hello\"}]" },
        ],
    };
}

test("isSideRequest: the <=200 budget heuristic still catches rc.2 titles and misses alpha.2 (the gap the text predicate exists for)", () => {
    assert.equal(isSideRequest(dshTitleBody(64)), true, "rc.2 64 budget rides the original heuristic");
    assert.equal(isSideRequest(dshTitleBody(4096)), false, "alpha.2 4096 budget defeats the heuristic");
});

test("isDshTitleRequest: non-object bodies stay closed", () => {
    assert.equal(isDshTitleRequest(null), false);
    assert.equal(isDshTitleRequest("nope"), false);
});

