import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { estimateWireOverhead } from "../src/server.ts";

// #470: the preflight trigger under-counted the wire payload — system text and
// tool definitions (incl. the proxy-injected compress prompt + ACP tools) ride
// the request but are invisible to estimateCoreMessages. estimateWireOverhead
// extracts them from the raw wire body per protocol.

test("estimateWireOverhead: anthropic string system + tools", () => {
    const body = JSON.stringify({
        model: "m",
        system: "S".repeat(4000),
        tools: [{ name: "t", description: "D".repeat(2000), input_schema: {} }],
        messages: [],
    });
    const oh = estimateWireOverhead("anthropic", body);
    assert.ok(oh >= 1000 && oh <= 2200, `system ~1000 + tools ~500 + JSON punctuation (got ${oh})`);
});

test("estimateWireOverhead: anthropic array-form system blocks", () => {
    const body = JSON.stringify({
        system: [{ type: "text", text: "S1 ".repeat(500) }, { type: "text", text: "S2 ".repeat(500) }],
    });
    const oh = estimateWireOverhead("anthropic", body);
    assert.ok(oh >= 500 && oh <= 1200, `array blocks joined (got ${oh})`);
});

test("estimateWireOverhead: openai hoisted system/developer messages counted, non-system not", () => {
    const body = JSON.stringify({
        messages: [
            { role: "system", content: "SYS ".repeat(300) },
            { role: "developer", content: "DEV ".repeat(300) },
            { role: "user", content: "U".repeat(40000) },
            { role: "assistant", content: "A".repeat(40000) },
        ],
    });
    const oh = estimateWireOverhead("openai", body);
    // ~300 tokens of system text — NOT the 20k of user/assistant content
    assert.ok(oh >= 250 && oh <= 800, `only system/developer messages count (got ${oh})`);
});

test("estimateWireOverhead: responses instructions", () => {
    const body = JSON.stringify({ instructions: "I".repeat(8000) });
    const oh = estimateWireOverhead("responses", body);
    assert.ok(oh >= 1800 && oh <= 2400, `instructions ~2000 (got ${oh})`);
});

test("estimateWireOverhead: responses input[] developer/system counted, user/assistant not (#829)", () => {
    const body = JSON.stringify({
        input: [
            { type: "message", role: "developer", content: "SYS ".repeat(300) },
            { type: "message", role: "system", content: "SYS2 ".repeat(300) },
            { type: "message", role: "user", content: "U".repeat(40000) },
            { type: "message", role: "assistant", content: "A".repeat(40000) },
        ],
    });
    const oh = estimateWireOverhead("responses", body);
    assert.ok(oh >= 300 && oh <= 1500, `only developer/system items in input[] count, not the 20k user/assistant (got ${oh})`);
});

test("estimateWireOverhead: responses input[] developer with array-of-parts content (#829)", () => {
    const body = JSON.stringify({
        input: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: "P1 ".repeat(300) }, { type: "input_text", text: "P2 ".repeat(300) }] },
            { type: "message", role: "user", content: "U".repeat(40000) },
        ],
    });
    const oh = estimateWireOverhead("responses", body);
    assert.ok(oh >= 300 && oh <= 1500, `array-of-parts developer content joined (got ${oh})`);
});

test("estimateWireOverhead: responses instructions AND input[] developer both counted (#829)", () => {
    const body = JSON.stringify({
        instructions: "I".repeat(4000),
        input: [{ type: "message", role: "developer", content: "D".repeat(4000) }],
    });
    const oh = estimateWireOverhead("responses", body);
    assert.ok(oh >= 1800 && oh <= 2600, `top-level instructions + input[] developer item summed (got ${oh})`);
});

test("estimateWireOverhead: unparseable body → 0, not a crash", () => {
    assert.equal(estimateWireOverhead("anthropic", "not json {"), 0);
    assert.equal(estimateWireOverhead("openai", Buffer.from("}{"), ), 0);
});

test("estimateWireOverhead: empty payload → ~0 (no system, no tools)", () => {
    assert.ok(estimateWireOverhead("anthropic", JSON.stringify({ messages: [] })) <= 1);
    assert.ok(estimateWireOverhead("responses", JSON.stringify({})) <= 1);
});

// #2078: forward() now parses the sent body once and passes the object through;
// the pre-parsed path must yield byte-identical numbers to the legacy
// string-re-parse path for every protocol.
test("estimateWireOverhead: pre-parsed object ≡ legacy string re-parse (#2078)", () => {
    const cases: Array<[Parameters<typeof estimateWireOverhead>[0], Record<string, unknown>]> = [
        ["anthropic", { model: "m", system: "S".repeat(4000), tools: [{ name: "t", description: "D".repeat(2000), input_schema: {} }], messages: [] }],
        ["openai", { messages: [{ role: "system", content: "SYS ".repeat(300) }, { role: "developer", content: "DEV ".repeat(300) }, { role: "user", content: "U".repeat(40000) }] }],
        ["responses", { instructions: "I".repeat(4000), input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "P1 ".repeat(300) }] }] }],
        ["google", { model: "m", systemInstruction: { parts: [{ text: "G".repeat(4000) }] }, contents: [] }],
    ];
    for (const [protocol, obj] of cases) {
        assert.equal(estimateWireOverhead(protocol, obj), estimateWireOverhead(protocol, JSON.stringify(obj)), `${protocol}: pre-parsed must equal legacy`);
    }
});
