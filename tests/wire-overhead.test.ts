import assert from "node:assert/strict";
import test from "node:test";
import { defaultCountTokens } from "acp-kernel";
import { estimateWireOverhead } from "../src/server.ts";

// #470: recover the billed envelope (system/instructions + tools) the preflight
// trigger/gates omitted. Assertions use EXACT values from the same
// defaultCountTokens, so any over-count (leaked message / image / role) fails.

const t = (s: string): number => defaultCountTokens(s);
const J = (o: unknown): string => JSON.stringify(o);

test("anthropic: counts string system + tools, never the conversation messages", () => {
    const body = { model: "m", max_tokens: 8, system: "S".repeat(4000), tools: [{ name: "read" }], messages: [{ role: "user", content: "M".repeat(40000) }] };
    const got = estimateWireOverhead("anthropic", J(body));
    assert.equal(got, t("S".repeat(4000)) + t(J([{ name: "read" }])));
    assert.ok(got < t("M".repeat(40000)), "the 40k-char conversation message must not leak into the envelope cost");
});

test("anthropic: counts array-of-blocks system (text blocks only, images skipped)", () => {
    const body = {
        model: "m",
        system: [
            { type: "text", text: "A".repeat(2000) },
            { type: "text", text: "B".repeat(2000) },
            { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
        ],
        messages: [],
    };
    const got = estimateWireOverhead("anthropic", J(body));
    assert.equal(got, t("A".repeat(2000) + "B".repeat(2000)) + t("[]"));
});

test("openai: counts hoisted system/developer messages + tools, not other roles", () => {
    const body = {
        model: "m",
        messages: [
            { role: "system", content: "S".repeat(3000) },
            { role: "developer", content: [{ type: "text", text: "D".repeat(1000) }] },
            { role: "user", content: "U".repeat(30000) },
        ],
        tools: [{ type: "function", function: { name: "f" } }],
    };
    const got = estimateWireOverhead("openai", J(body));
    assert.equal(got, t("S".repeat(3000) + "D".repeat(1000)) + t(J([{ type: "function", function: { name: "f" } }])));
});

test("responses: counts top-level instructions + developer input item + tools", () => {
    const body = {
        model: "m",
        instructions: "I".repeat(2000),
        input: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: "DEV".repeat(1500) }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "U".repeat(30000) }] },
        ],
        tools: [{ type: "function", name: "g", parameters: {} }],
    };
    const got = estimateWireOverhead("responses", J(body));
    assert.equal(got, t("I".repeat(2000) + "DEV".repeat(1500)) + t(J([{ type: "function", name: "g", parameters: {} }])));
});

test("tools: larger definitions raise the overhead across all three protocols", () => {
    const bigTools = Array.from({ length: 20 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, description: "d".repeat(200) } }));
    const smallTools = [{ type: "function", function: { name: "tool_0" } }];
    for (const p of ["anthropic", "openai"] as const) {
        const mk = (tools: unknown) => J({ model: "m", system: "", messages: [], tools });
        assert.ok(estimateWireOverhead(p, mk(bigTools)) > estimateWireOverhead(p, mk(smallTools)), `${p}: more tools -> more overhead`);
    }
    assert.ok(
        estimateWireOverhead("responses", J({ model: "m", input: [], tools: bigTools })) > estimateWireOverhead("responses", J({ model: "m", input: [], tools: smallTools })),
        "responses: tools counted even with no system/instructions",
    );
});

test("unparseable / non-object body -> 0; Buffer input behaves like a string", () => {
    assert.equal(estimateWireOverhead("anthropic", "{not json"), 0);
    assert.equal(estimateWireOverhead("openai", ""), 0);
    assert.equal(estimateWireOverhead("responses", "null"), 0);
    assert.equal(estimateWireOverhead("anthropic", "123"), 0);
    const valid = J({ model: "m", system: "SS", tools: [{ name: "r" }] });
    assert.equal(estimateWireOverhead("anthropic", Buffer.from(valid, "utf8")), estimateWireOverhead("anthropic", valid));
});
