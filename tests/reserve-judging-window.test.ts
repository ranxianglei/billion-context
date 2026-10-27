import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, type Config } from "acp-kernel";
import { reserveJudgingWindow } from "../src/server/handle.ts";
import type { ProxyOptions } from "../src/config.ts";
import type { Session } from "../src/session.ts";

// The output-headroom reservation inside handleRequest(): the DECLARED window
// becomes the window this turn actually judges against. Extracted verbatim
// (readability refactor, no behavior change) so the budget matrix can be pinned
// directly instead of through six server fixtures.
//
// The four rules this file pins, each in both directions:
//   #896  reserved = min(maxOutput, cap × window)  — the cap bounds GUESSED budgets
//   #282  a fallback-derived window never drops below FALLBACK_EFFECTIVE_WINDOW_FLOOR
//   #4205 an anthropic route with separate-output-wall evidence reserves NOTHING
//   #3450/#3973 a PROVEN completion share outranks that exemption and clamps the
//         window to (declared − proven), scoped to the exact origin+model

const BASE_WINDOW = 200_000;
const UNKNOWN_MODEL = "relay/test-unknown-model";
const RELAY = "https://relay.example.com";
const ANTHROPIC = "https://api.anthropic.com";
const CLAUDE = "claude-sonnet-4-5";

type Input = Parameters<typeof reserveJudgingWindow>[0];

function reserveWindow(
    overrides: Partial<Input> = {},
    proven?: { wall: number; origin: string; model: string },
): { config: Config; session: Session } {
    const session = { id: "reserve-window", metadata: {}, stats: {} } as unknown as Session;
    if (proven !== undefined) {
        Object.assign(session.stats, {
            provenCompletionWall: proven.wall,
            provenCompletionWallOrigin: proven.origin,
            provenCompletionWallModel: proven.model,
        });
    }
    const window = overrides.nativeWindow ?? BASE_WINDOW;
    const model = overrides.requestModel ?? UNKNOWN_MODEL;
    const origin = overrides.headroomOrigin ?? RELAY;
    const input: Input = {
        reqConfig: defaultConfig(window),
        nativeWindow: window,
        headroomCap: 0.25,
        nativeFromFallback: false,
        parsed: { model, max_tokens: 64_000 },
        req: { headers: {} } as unknown as http.IncomingMessage,
        opts: { routes: [], sessionHeader: "x-session-id" } as unknown as ProxyOptions,
        protocol: "openai",
        requestModel: model,
        providerDestUrl: `${origin}/v1/chat/completions`,
        headroomOrigin: origin,
        reqModelId: model,
        windowSource: "test",
        session,
        log: () => {},
        ...overrides,
    };
    return { config: reserveJudgingWindow(input), session };
}

test("#896 the headroom cap bounds the reservation, not max_tokens", () => {
    // 64k requested, cap = 25% of a 200k window = 50k → the CAP is what binds.
    const { config } = reserveWindow();
    assert.equal(config.modelContextLimit, 150_000);
});

test("#896 max_tokens below the cap is what binds", () => {
    const { config } = reserveWindow({ parsed: { model: UNKNOWN_MODEL, max_tokens: 8_000 } });
    assert.equal(config.modelContextLimit, 192_000);
});

test("#896 no output budget anywhere → no reservation and no crash", () => {
    // Runtime-info, launcher, configured and registry tiers all miss for an
    // unknown model on an unconfigured route: the window must survive intact
    // rather than being shrunk by a guessed budget.
    const { config } = reserveWindow({ parsed: { model: UNKNOWN_MODEL } });
    assert.equal(config.modelContextLimit, BASE_WINDOW);
});

test("#282 a fallback-derived window never drops below the floor", () => {
    // 128k table window − min(64k, 25% = 32k) = 96k, which the floor lifts to 100k.
    const { config } = reserveWindow({ nativeWindow: 128_000, nativeFromFallback: true });
    assert.equal(config.modelContextLimit, 100_000);
});

test("#282 the floor does NOT apply to an authoritative window", () => {
    // Same arithmetic without the low-confidence flag: 96k stands.
    const { config } = reserveWindow({ nativeWindow: 128_000 });
    assert.equal(config.modelContextLimit, 96_000);
});

test("#282 the floor only LIFTS, it never caps a wide fallback window", () => {
    // A fallback-derived window whose reservation still leaves it above the
    // floor must keep its own value — an unconditional floor would collapse a
    // 400k guess to 100k and over-compress a session that fit perfectly.
    const { config } = reserveWindow({ nativeWindow: 400_000, nativeFromFallback: true });
    assert.equal(config.modelContextLimit, 336_000);
});

test("#4205 an exempt anthropic route reserves nothing", () => {
    const { config } = reserveWindow({
        protocol: "anthropic",
        headroomOrigin: ANTHROPIC,
        requestModel: CLAUDE,
        reqModelId: CLAUDE,
        providerDestUrl: `${ANTHROPIC}/v1/messages`,
    });
    assert.equal(config.modelContextLimit, BASE_WINDOW);
});

test("#4205 an anthropic-shaped route WITHOUT separate-wall evidence still reserves", () => {
    // Wrapper providers on the anthropic wire bill completion inside the wall
    // (#3900): absent evidence the call degrades to "reserve", never "exempt".
    const { config } = reserveWindow({
        protocol: "anthropic",
        headroomOrigin: RELAY,
        requestModel: UNKNOWN_MODEL,
        reqModelId: UNKNOWN_MODEL,
    });
    assert.equal(config.modelContextLimit, 150_000);
});

test("#3450/#3973 a proven completion share outranks the exemption and clamps the window", () => {
    // Exempt route, but this origin+model was already rejected while billing a
    // 150k completion inside the wall: the accepted input ceiling is
    // window − proven = 50k, which must beat the cap path's 150k.
    const { config } = reserveWindow(
        {
            protocol: "anthropic",
            headroomOrigin: ANTHROPIC,
            requestModel: CLAUDE,
            reqModelId: CLAUDE,
            providerDestUrl: `${ANTHROPIC}/v1/messages`,
        },
        { wall: 150_000, origin: ANTHROPIC, model: CLAUDE },
    );
    assert.equal(config.modelContextLimit, 50_000);
});

test("#3450 a proven share is scoped to its own origin+model", () => {
    // Same session proof, different model: the exemption stands, nothing is
    // reserved, and no unrelated upstream inherits the clamp.
    const { config } = reserveWindow(
        {
            protocol: "anthropic",
            headroomOrigin: ANTHROPIC,
            requestModel: CLAUDE,
            reqModelId: CLAUDE,
            providerDestUrl: `${ANTHROPIC}/v1/messages`,
        },
        { wall: 150_000, origin: ANTHROPIC, model: "claude-opus-4" },
    );
    assert.equal(config.modelContextLimit, BASE_WINDOW);
});

test("#2283 the resolution triple is stamped with the PRE-reservation base", () => {
    // The [window-change] diagnostic compares model/source/base across turns;
    // recording the reserved value here would report a change on every turn
    // whose max_tokens differs.
    const { session } = reserveWindow();
    assert.deepEqual(session.metadata.lastWindowResolution, {
        m: UNKNOWN_MODEL,
        s: "test",
        b: BASE_WINDOW,
    });
});

test("#2283 no stamp when the reservation is skipped entirely", () => {
    // Exempt route takes the early skip: nothing was judged, so nothing is
    // recorded and the next turn cannot read a phantom base change.
    const { session } = reserveWindow({
        protocol: "anthropic",
        headroomOrigin: ANTHROPIC,
        requestModel: CLAUDE,
        reqModelId: CLAUDE,
        providerDestUrl: `${ANTHROPIC}/v1/messages`,
    });
    assert.equal(session.metadata.lastWindowResolution, undefined);
});
