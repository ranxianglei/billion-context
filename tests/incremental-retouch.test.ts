import assert from "node:assert/strict";
import test from "node:test";
import { compactRetouch, expandRetouch, isCompactRetouch, retouchContentHash } from "../src/incremental-retouch.ts";
import { probeIncrementalTurns, incrementalCompactCacheRetouchEnabled, clearIncrementalProbe } from "../src/agent/incremental-client.ts";

test("compact retouch requires its own positive capability", async () => {
    const base = "http://127.0.0.1:1";
    for (const capability of [undefined, false, true]) {
        clearIncrementalProbe(base);
        const fake: typeof fetch = async () => new Response(JSON.stringify({ enabled: true, cacheControlRetouch: true, cacheControlRetouchCompact: capability }), { status: 200 });
        assert.equal(await probeIncrementalTurns(base, fake), true);
        assert.equal(incrementalCompactCacheRetouchEnabled(base), capability === true);
    }
    clearIncrementalProbe(base);
    assert.equal(incrementalCompactCacheRetouchEnabled(base), false);
});

test("compact marks retain protected opaque payloads and nested cache fields", () => {
    const original = { role: "assistant", content: [
        { type: "thinking", thinking: "opaque β", signature: "signed\nbytes", cache_control: { type: "ephemeral" } },
        { type: "redacted_thinking", data: "opaque==" },
        { type: "tool_use", id: "call-1", name: "read", input: { z: 1, cache_control: "application data", a: "β" } },
    ] };
    const desired = structuredClone(original);
    delete desired.content[0].cache_control;
    desired.content[2].cache_control = { type: "ephemeral" };
    const before = JSON.stringify(original);
    const patch = compactRetouch(0, desired);
    assert.ok(isCompactRetouch(patch));
    assert.deepEqual(expandRetouch(original, patch), desired);
    assert.equal(JSON.stringify(original), before);
    for (const mutate of [
        (m: typeof desired) => { m.content[0].signature = "changed"; },
        (m: typeof desired) => { m.role = "user"; },
        (m: typeof desired) => { m.content.reverse(); },
        (m: typeof desired) => { if (m.content[2].input) { m.content[2].input.cache_control = "changed"; } },
    ]) {
        const altered = structuredClone(desired);
        mutate(altered);
        assert.equal(expandRetouch(original, compactRetouch(0, altered)), null);
    }
    assert.equal(expandRetouch(original, { ...patch, cacheControls: [] }), null);
    assert.equal(isCompactRetouch({ ...patch, message: original }), false);
    assert.equal(isCompactRetouch({ ...patch, cacheControls: ["bad"] }), false);
});

test("large mark patch size is independent of message bytes", () => {
    const original = { role: "user", content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }] };
    const patch = compactRetouch(0, { ...original, content: [{ ...original.content[0], cache_control: { type: "ephemeral" } }] });
    assert.ok(Buffer.byteLength(JSON.stringify(patch)) < 200);
    assert.equal(retouchContentHash(original), patch.contentHash);
    assert.notEqual(expandRetouch(original, patch), null);
});
