// #3071 path 3: the #2490 planning-floor clamp drove the outgoing output budget into
// the low thousands (observed 1479/2623) whenever input sat near the window — the 5%
// margin ate most of the raw headroom, starving the reply to an empty finish=length
// turn. Owner-signed constraint (#3071): floor the clamped budget at min(4096, window
// - input) so a normal reply always has room, WITHOUT relaxing fail-closed — the
// sub-floor surrender (cap < OUTPUT_CLAMP_FLOOR, i.e. input+margin already past the
// window) stays byte-identical, and min(4096, window-input) is always <= window-input
// so input+output can never exceed the window. The #2490 STICKY pin must stay green.
import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { clampOutputBudget, clampOutgoingOutput } from "../src/server/budget.ts";

const WINDOW = 262_144; // the reported DSH / ark-code-latest window

test("#3071: planning-floor clamp is floored to 4096, not the low thousands (131072 -> 2623 becomes 4096)", () => {
    // Refused dsh compaction replay floors planning input at 247162 tokens; the naive
    // cap is floor(262144 - 247162 - ceil(247162*0.05)) = 2623. Raw headroom is 14982,
    // which comfortably fits the 4096 capability floor.
    assert.equal(clampOutputBudget(131_072, 247_162, WINDOW), 4_096);
});

test("#3071: the 1479 case is floored too when the incoming budget exceeds the floor", () => {
    // planning floor 248252 -> naive cap 1479. An incoming 8192 (a restored starved
    // budget) is reduced to 4096, not 1479.
    assert.equal(clampOutputBudget(8_192, 248_252, WINDOW), 4_096);
});

test("#3071: the clamp never RAISES — a client budget already under the floor is honored", () => {
    // The exact log line "clamped 2512 -> 1479": incoming 2512 < 4096, so we do not
    // reduce it to 1479 (that would lower a value the client itself chose); it passes
    // through untouched. Raising belongs to the restore lane, not the clamp.
    assert.equal(clampOutputBudget(2_512, 248_252, WINDOW), undefined);
});

test("#3071: sub-floor surrender is untouched (fail-closed preserved when input+margin >= window)", () => {
    // Mirrors the #2490 unit s4 shape: input+margin already past the window -> no clamp.
    assert.equal(clampOutputBudget(384_000, 990_000, 1_000_000), undefined);
    // And the #2490 incident clamp (well above the floor) is unchanged.
    assert.equal(clampOutputBudget(384_000, 900_000, 1_000_000), 55_000);
});

test("#3071: when raw headroom < 4096 the floor is bounded by headroom, not forced to 4096", () => {
    // window-input = 3500 (< 4096): naive cap 1452, floor bounded down to 3500 = full
    // headroom. input+output = 8500 + 3500 = 12000 = window exactly (never exceeded).
    assert.equal(clampOutputBudget(8_000, 8_500, 12_000), 3_500);
});

test("#3071: a healthy cap well above the floor is unchanged", () => {
    // cap 136144 >> 4096 -> the capability floor does not interfere.
    assert.equal(clampOutputBudget(200_000, 120_000, WINDOW), 136_144);
});

test("#3071 (integration): clampOutgoingOutput plans against the refused ledger and floors to 4096", () => {
    const lines: string[] = [];
    const log = (level: string, msg: string): void => { if (level === "info" || level === "warn") lines.push(msg); };
    const rebuilt: Record<string, unknown> = { max_tokens: 131_072 };
    const ctx = {
        systemText: "",
        tools: undefined,
        processedMessages: [{ role: "user", text: "hello" }],
        lastInputTokens: 1_000,
        lastInputTokensSource: "usage",
        nativeWindow: WINDOW,
        imageTokens: 0,
        ledgerFloorTokens: 247_162,
    } as Parameters<typeof clampOutgoingOutput>[2];
    clampOutgoingOutput(rebuilt, "max_tokens", ctx, "s-3071", log);
    assert.equal(rebuilt.max_tokens, 4_096, "planned against the refused raw ledger, floored to the capability minimum");
    assert.match(lines[0] ?? "", /planning floor 247162 from the refused dsh compaction replay \(#2490\)/);
    assert.match(lines[0] ?? "", /-> 4096/);
});
