import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import { createSession } from "../src/session.ts";
import { rewriteJsonResponseAsync, type RewriteCtx } from "../src/stream.ts";
import { rewriteOpenaiJsonResponseAsync } from "../src/stream-openai.ts";
import { rewriteResponsesJsonResponseAsync } from "../src/stream-responses.ts";
import { rewriteGoogleJsonResponseAsync } from "../src/stream-google.ts";

const emission = "\n<parameter=ref>\nm00608\n</parameter>\n<parameter=summary>\nconsume the read output\n</parameter>\n</function>\n</function_calls>";
const renderTag = '<acp tokens="177" type="text">m00155</acp>';

function context(armed: boolean, requestText: string): RewriteCtx {
    const config = defaultConfig(200_000);
    config.absorb!.enabled = armed;
    const messages: CoreMessage[] = [{ id: "request", role: "user", contentType: "text", text: requestText }];
    return { core: createCore(), config, messages, session: createSession("json-history-test"), log: () => {} };
}

const lanes = [
    { name: "anthropic", rewrite: rewriteJsonResponseAsync, body: (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) },
    { name: "openai", rewrite: rewriteOpenaiJsonResponseAsync, body: (text: string) => ({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }) },
    { name: "responses", rewrite: rewriteResponsesJsonResponseAsync, body: (text: string) => ({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], status: "completed" }) },
    { name: "google", rewrite: rewriteGoogleJsonResponseAsync, body: (text: string) => ({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] }) },
];

for (const lane of lanes) {
    for (const scenario of [
        { name: "ordinary text, absorb disabled", armed: false, request: "Answer normally", text: "你好 🌏 — complete.", expected: "你好 🌏 — complete." },
        { name: "ordinary text, absorb enabled", armed: true, request: "Answer normally", text: "你好 🌏 — complete.", expected: "你好 🌏 — complete." },
        { name: "user-quoted emission", armed: true, request: `Output exactly this fragment:\n${emission.trim()}`, text: emission, expected: emission },
        { name: "model-invented emission", armed: true, request: emission.replace("m00608", "m00999"), text: emission, expected: "" },
        { name: "unarmed emission", armed: false, request: "Answer normally", text: emission, expected: emission },
        { name: "render tags without absorb", armed: false, request: "Answer normally", text: `before ${renderTag} after`, expected: "before  after" },
    ]) {
        test(`${lane.name}: preserves ${scenario.name} behavior`, async () => {
            const ctx = context(scenario.armed, scenario.request);
            const history = structuredClone(ctx.messages);
            assert.deepEqual(await lane.rewrite(lane.body(scenario.text), ctx), lane.body(scenario.expected));
            assert.deepEqual(ctx.messages, history, "reply filtering never changes request history");
        });
    }
}

test("anthropic: each prose field sees the same quoted-request evidence", async () => {
    const ctx = context(true, `Output exactly:\n${emission.trim()}`);
    const body = { content: [{ type: "text", text: renderTag }, { type: "text", text: emission }, { type: "text", text: emission }] };
    assert.deepEqual(await rewriteJsonResponseAsync(body, ctx), { content: [{ type: "text", text: "" }, { type: "text", text: emission }, { type: "text", text: emission }] });
});

test("google: quoted prose is preserved without touching signed thoughts or tool arguments", async () => {
    const ctx = context(true, `Output exactly:\n${emission.trim()}`);
    const thought = { text: emission + renderTag, thought: true, thoughtSignature: "signed-thought" };
    const call = { functionCall: { name: "write_file", args: { content: emission + renderTag } } };
    const body = { candidates: [{ content: { role: "model", parts: [thought, { text: renderTag }, call, { text: emission }, { text: emission }] } }] };
    assert.deepEqual(await rewriteGoogleJsonResponseAsync(body, ctx), { candidates: [{ content: { role: "model", parts: [thought, { text: "" }, call, { text: emission }, { text: emission }] } }] });
});
