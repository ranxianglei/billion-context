import assert from "node:assert/strict";
import test from "node:test";
import { anthropicToCore, type BiliMessage } from "acp-kernel/wire";
import { continueContentClusters } from "../src/incremental-lane.js";

test("content clusters match one full conversion across repeated delta boundaries", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: i % 3 === 0 ? "continue" : "ok", cache_control: { type: "ephemeral" } }],
    }));
    for (let split = 1; split < messages.length; split++) {
        const prefix = anthropicToCore({ messages: messages.slice(0, split) } as never);
        const delta = anthropicToCore({ messages: messages.slice(split) } as never);
        const before = JSON.stringify(delta.msgs);
        const continued = continueContentClusters(prefix.msgs, delta);
        const full = anthropicToCore({ messages } as never);
        assert.deepEqual([...prefix.msgs, ...continued.msgs].map(({ id }) => id), full.msgs.map(({ id }) => id));
        assert.deepEqual(new Map([...prefix.cacheControls, ...continued.cacheControls]), full.cacheControls);
        assert.equal(JSON.stringify(delta.msgs), before, "input messages remain unchanged");
    }
});

test("sparse content clusters skip the highest retained suffix; other namespaces remain exact", () => {
    const base = "h_0123456789abcdef";
    const msg = (id: string): BiliMessage => ({ id, role: "user", contentType: "text", text: "literal payload", rawAnthropicBlock: { type: "document", source: { data: "exact bytes" } } });
    const delta = { msgs: [msg(base), msg("client-pinned")], cacheControls: new Map([[base, { type: "ephemeral" }]]) };
    const shifted = continueContentClusters([msg(base), msg(`${base}_9`)], delta);
    assert.equal(shifted.msgs[0].id, `${base}_10`);
    assert.equal(shifted.msgs[0].rawAnthropicBlock, delta.msgs[0].rawAnthropicBlock);
    assert.equal(shifted.msgs[1], delta.msgs[1]);
    assert.ok(shifted.cacheControls.has(`${base}_10`));
    assert.ok(!shifted.cacheControls.has(base));
    assert.equal(continueContentClusters([msg("client-pinned")], delta), delta);
});
