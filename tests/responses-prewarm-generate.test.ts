import { test } from "node:test";
import assert from "node:assert/strict";
import { ResponsesWsHistory } from "../src/responses-ws.ts";

const devMsg = (text: string) => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
const userMsg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

test("prewarm generate:false must not disable a real continuation (#2966)", () => {
    const history = new ResponsesWsHistory();
    history.commit(
        { model: "gpt-6.1-sol", generate: false, input: [devMsg("Synthetic test instructions.")] },
        { id: "resp_prewarm", status: "completed", output: [] },
    );

    const expanded = history.expand({
        type: "response.create",
        previous_response_id: "resp_prewarm",
        input: [userMsg("Reply exactly BILI_REPRO_OK.")],
    });

    assert.notEqual(expanded.generate, false, "Prewarm generate:false leaked into a real continuation");
});

test("explicit generate:false on the current request is still respected", () => {
    const history = new ResponsesWsHistory();
    history.commit(
        { model: "m", input: [devMsg("setup")] },
        { id: "r1", status: "completed", output: [] },
    );

    const expanded = history.expand({
        type: "response.create",
        previous_response_id: "r1",
        generate: false,
        input: [userMsg("no-op turn")],
    });

    assert.equal(expanded.generate, false);
});

test("explicit generate:true on the current request overrides prior generate:false", () => {
    const history = new ResponsesWsHistory();
    history.commit(
        { model: "m", generate: false, input: [devMsg("setup")] },
        { id: "r2", status: "completed", output: [] },
    );

    const expanded = history.expand({
        type: "response.create",
        previous_response_id: "r2",
        generate: true,
        input: [userMsg("real turn")],
    });

    assert.equal(expanded.generate, true);
});

test("continuation preserves prior input/output/tools and current metadata; checkpoint not mutated", () => {
    const history = new ResponsesWsHistory();
    const priorInput = [devMsg("instructions"), userMsg("hello")];
    const tools = [{ type: "function", name: "search", parameters: {} }];
    const priorRequest = { model: "gpt-5", instructions: "sys", tools, generate: false, input: priorInput };
    const priorOutput = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }];

    history.commit(priorRequest, { id: "r3", status: "completed", output: priorOutput });
    const snapshotBefore = JSON.stringify(priorRequest);

    const expanded = history.expand({
        type: "response.create",
        previous_response_id: "r3",
        model: "gpt-5-turbo",
        metadata: { tag: "new" },
        input: [userMsg("next")],
    });

    const input = expanded.input as unknown[];
    assert.equal(input.length, 4);
    assert.deepEqual(input[0], priorInput[0]);
    assert.deepEqual(input[1], priorInput[1]);
    assert.equal((input[2] as Record<string, unknown>).role, "assistant");
    assert.deepEqual(input[3], userMsg("next"));

    assert.equal(expanded.model, "gpt-5-turbo");
    assert.equal(expanded.instructions, "sys");
    assert.deepEqual(expanded.tools, tools);
    assert.deepEqual(expanded.metadata, { tag: "new" });
    assert.notEqual(expanded.generate, false);

    assert.equal(JSON.stringify(priorRequest), snapshotBefore);
});

// The session-level prewarm guard (src/responses-ws.ts:512) catches only
// EMPTY-input probes (input.length === 0 && generate === false) and forwards
// them verbatim without committing a checkpoint. A NON-empty prewarm (e.g. a
// developer message + generate:false) goes through the ACP pipeline and gets
// committed, so its generate:false leaks into the next continuation via
// expand(). This test pins that specific trigger shape.
test("non-empty prewarm with developer message + generate:false does not poison continuation (#2966)", () => {
    const history = new ResponsesWsHistory();
    history.commit(
        { model: "m", generate: false, input: [devMsg("sub-agent system prompt")] },
        { id: "pw1", status: "completed", output: [] },
    );

    const continuation = history.expand({
        type: "response.create",
        previous_response_id: "pw1",
        input: [userMsg("do the task")],
    });

    assert.notEqual(continuation.generate, false);
    assert.ok((continuation.input as unknown[]).some(item => JSON.stringify(item).includes("sub-agent system prompt")));
});
