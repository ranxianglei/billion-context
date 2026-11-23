import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { detectKeepaliveTier, keepaliveStatusFor, noteSuccessfulForward, _resetKeepaliveForTest, _setKeepaliveSchedulerForTest } from "../src/cache-keepalive.js";

const breakpoint = { type: "ephemeral", ttl: "1h" };
const toolInput = { cache_control: breakpoint, nested: { cache_control: breakpoint } };

const lookalikeOnly = {
    model: "claude-test",
    max_tokens: 1024,
    tools: [{ name: "read_settings", input_schema: { type: "object", examples: [toolInput] } }],
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_settings", input: toolInput }] }],
};

afterEach(() => _resetKeepaliveForTest());

test("tool arguments and JSON-schema examples are data, not cache breakpoints", () => {
    assert.equal(detectKeepaliveTier(lookalikeOnly), undefined);
    assert.equal(detectKeepaliveTier({ messages: [{ role: "assistant", content: [{ type: "server_tool_use", id: "call-server", name: "web_search", input: toolInput }] }] }), undefined);
});

test("a fake one-hour directive cannot override a real five-minute breakpoint", () => {
    assert.equal(detectKeepaliveTier({ ...lookalikeOnly, system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }] }), "5m");
});

test("actual request, tool, system and message cache-control locations remain eligible", () => {
    const controls = [
        { cache_control: breakpoint, messages: [{ role: "user", content: "hi" }] },
        { tools: [{ name: "read_settings", input_schema: { type: "object" }, cache_control: breakpoint }] },
        { system: [{ type: "text", text: "system", cache_control: breakpoint }] },
        { messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: breakpoint }] }] },
        { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "result" }], cache_control: breakpoint }] }] },
    ];
    for (const body of controls) assert.equal(detectKeepaliveTier(body), "1h");
});

test("nested tool-result content keeps its genuine block breakpoints", () => {
    assert.equal(detectKeepaliveTier({ messages: [{ role: "user", content: [{
        type: "tool_result", tool_use_id: "call-1", content: [{
            type: "tool_reference", tool_name: "read_settings", cache_control: breakpoint,
        }],
    }] }] }), "1h");
});

test("lookalikes do not arm an otherwise enabled idle-ping schedule", () => {
    const scheduled: number[] = [];
    _setKeepaliveSchedulerForTest({ schedule(_fn, ms) { scheduled.push(ms); return ms; }, cancel() {} });
    noteSuccessfulForward({
        sessionId: "scope-no-breakpoint", protocol: "anthropic", reqMethod: "POST", sidePassthrough: false, resignLane: false,
        wireBody: JSON.stringify(lookalikeOnly), upstreamUrl: "https://api.anthropic.com/v1/messages", headers: {}, dispatcher: undefined,
        routes: { "https://api.anthropic.com": { cacheKeepalive: { enabled: true } } },
    });
    assert.equal(keepaliveStatusFor("scope-no-breakpoint"), undefined);
    assert.deepEqual(scheduled, []);
});

test("a real breakpoint still arms keepalive with the correct tier", () => {
    const scheduled: number[] = [];
    _setKeepaliveSchedulerForTest({ schedule(_fn, ms) { scheduled.push(ms); return ms; }, cancel() {} });
    noteSuccessfulForward({
        sessionId: "scope-real-breakpoint", protocol: "anthropic", reqMethod: "POST", sidePassthrough: false, resignLane: false,
        wireBody: JSON.stringify({ ...lookalikeOnly, system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }] }),
        upstreamUrl: "https://api.anthropic.com/v1/messages", headers: {}, dispatcher: undefined,
        routes: { "https://api.anthropic.com": { cacheKeepalive: { enabled: true } } },
    });
    assert.equal(keepaliveStatusFor("scope-real-breakpoint")?.tierLabel, "5m");
    assert.deepEqual(scheduled, [270_000]);
});
