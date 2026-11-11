import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { noteColdLoad, _resetAttachHeartbeatForTest } from "../src/attach-heartbeat.ts";
import { setLogCapture } from "../src/logger.ts";

function setup(t: TestContext): string[] {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-09T00:00:00Z") });
    _resetAttachHeartbeatForTest(1_000);
    const messages: string[] = [];
    setLogCapture((_level, message) => messages.push(message));
    t.after(() => {
        _resetAttachHeartbeatForTest();
        setLogCapture(null);
        t.mock.timers.reset();
    });
    return messages;
}

test("invalid saved timestamps never arm a throwing heartbeat", (t) => {
    const messages = setup(t);
    for (const [index, savedAt] of [NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1].entries()) {
        noteColdLoad(`invalid-${index}`, "test", savedAt);
    }
    assert.doesNotThrow(() => t.mock.timers.tick(2_000));
    assert.deepEqual(messages, []);
});

test("missing or invalid replacement timestamps disarm an earlier hot load", (t) => {
    const messages = setup(t);
    noteColdLoad("missing", "test", Date.now());
    noteColdLoad("missing", "test");
    noteColdLoad("invalid", "test", Date.now());
    noteColdLoad("invalid", "test", NaN);
    assert.doesNotThrow(() => t.mock.timers.tick(2_000));
    assert.deepEqual(messages, []);
});

test("a valid hot timestamp still emits one silence warning", (t) => {
    const messages = setup(t);
    noteColdLoad("valid-hot", "test", Date.now());
    t.mock.timers.tick(1_000);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /valid-hot.*NO model request/);
    t.mock.timers.tick(1_000);
    assert.equal(messages.length, 1);
});
