import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { outboundContextEstimate } from "../src/server.ts";

// #2078: forward() now parses the sent wire body ONCE and hands the object to
// outboundContextEstimate instead of letting it re-parse the largest payload
// per request. The three input modes must be numerically identical:
//   undefined  → legacy self-parse (any future caller without a pre-parsed body)
//   object     → project straight from the parse-once result
//   null       → parse failed upstream; helpers receive "" so they yield the
//                same zeros the legacy in-function catch used to produce
// Fakes stay minimal: empty message views + no images, so the estimate reduces
// to projection + overhead + image-reserve(0) and no Session internals are
// touched (imageReserveFor early-returns before session access).

type PreparedLike = Parameters<typeof outboundContextEstimate>[0];
type OptsLike = Parameters<typeof outboundContextEstimate>[2];
type Proto = Parameters<typeof outboundContextEstimate>[0]["protocol"];

const OPTS = { routes: {} } as unknown as OptsLike;
const UPSTREAM = "https://upstream.example/v1";

function makePrepared(protocol: Proto): PreparedLike {
    return {
        body: "",
        session: { id: "t-2078" },
        processedMessages: [],
        originalMessages: [],
        protocol,
        stream: false,
        compressInjected: false,
    } as unknown as PreparedLike;
}

const FIXTURES: Array<[Proto, Record<string, unknown>]> = [
    ["anthropic", { model: "m", max_tokens: 100, system: "S".repeat(4000), messages: [{ role: "user", content: [{ type: "text", text: "hello world" }] }], tools: [{ name: "t", description: "D".repeat(2000), input_schema: {} }] }],
    ["openai", { model: "m", messages: [{ role: "system", content: "SYS ".repeat(300) }, { role: "user", content: "hello world" }], tools: [{ type: "function", function: { name: "t", description: "D".repeat(2000) } }] }],
    ["responses", { model: "m", instructions: "I".repeat(4000), input: [{ type: "message", role: "user", content: "hello world" }], tools: [{ type: "function", name: "t", description: "D".repeat(2000) }] }],
    ["google", { model: "m", systemInstruction: { parts: [{ text: "G".repeat(4000) }] }, contents: [{ role: "user", parts: [{ text: "hello world" }] }] }],
];

test("#2078: pre-parsed object ≡ legacy self-parse, all protocols, codec path live", () => {
    for (const [protocol, obj] of FIXTURES) {
        const s = JSON.stringify(obj);
        const prepared = makePrepared(protocol);
        const legacy = outboundContextEstimate(prepared, s, OPTS, UPSTREAM);
        const preparsed = outboundContextEstimate(prepared, s, OPTS, UPSTREAM, obj);
        assert.ok(legacy > 0, `${protocol}: estimate path must be live (got ${legacy})`);
        assert.equal(preparsed, legacy, `${protocol}: pre-parsed mode must equal legacy mode`);
    }
});

test("#2078: unparseable body — null mode ≡ legacy fallback (both zero here)", () => {
    const prepared = makePrepared("openai");
    const legacy = outboundContextEstimate(prepared, "{not json", OPTS, UPSTREAM);
    const nullMode = outboundContextEstimate(prepared, "{not json", OPTS, UPSTREAM, null);
    assert.equal(nullMode, legacy);
    // Empty message views + unprojectable body: projection 0, overhead 0, no images.
    assert.equal(legacy, 0);
});

test("#2078: estimate tracks wire-body content in BOTH modes (projection not dead)", () => {
    const small = { model: "m", max_tokens: 100, system: "S".repeat(100), messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
    const big = { ...small, system: "S".repeat(9000) };
    const ss = JSON.stringify(small);
    const sb = JSON.stringify(big);
    const ps = makePrepared("anthropic");
    const pb = makePrepared("anthropic");
    const legacyDelta = outboundContextEstimate(pb, sb, OPTS, UPSTREAM) - outboundContextEstimate(ps, ss, OPTS, UPSTREAM);
    const preparsedDelta = outboundContextEstimate(pb, sb, OPTS, UPSTREAM, big) - outboundContextEstimate(ps, ss, OPTS, UPSTREAM, small);
    assert.ok(legacyDelta > 500, `legacy mode must see the bigger system (delta ${legacyDelta})`);
    assert.ok(preparsedDelta > 500, `pre-parsed mode must see the bigger system (delta ${preparsedDelta})`);
});
