import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOpenAiChatBody } from "./wire-contract-fakes.js";

function body(content: object, model = "gemini-synthetic") {
    return { model, tools: [{ type: "function", function: {
        name: "compress", parameters: { type: "object", properties: { content } },
    } }] };
}

test("Copilot Gemini rejects union types and untyped alternatives independently", () => {
    assert.match(validateOpenAiChatBody(body({ type: ["array", "string"] })).join(), /WC-008.*scalar/);
    assert.match(validateOpenAiChatBody(body({ anyOf: [{ required: ["summary"] }] })).join(), /WC-008.*declare its type/);
});

test("Copilot Gemini accepts explicit alternatives without changing other model validation", () => {
    const properties = { summary: { type: "string" } };
    assert.deepEqual(validateOpenAiChatBody(body({ anyOf: [
        { type: "array", items: { anyOf: [
            { type: "string" }, { type: "object", properties, required: ["summary"] },
        ] } }, { type: "string" },
    ] })), []);
    assert.deepEqual(validateOpenAiChatBody(body({ type: ["array", "string"] }, "other-model")), []);
});
