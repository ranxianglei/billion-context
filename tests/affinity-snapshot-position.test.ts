import assert from "node:assert/strict";
import test from "node:test";
import { PrefixAffinityResolver } from "../src/prefix-affinity.ts";

function seed() {
    const messages = Array.from({ length: 16 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}: deployment analysis includes the latency profile and retry budget of service ${i}`,
    }));
    const resolver = new PrefixAffinityResolver();
    const affinity = resolver.resolve(messages);
    assert.ok(affinity);
    resolver.note(affinity.sessionId, affinity.incomingDepth, affinity.tailHash, affinity.itemHashes, false, affinity.sketches, affinity.userFlags);
    const snapshot = resolver.exportSnapshot()[0]!;
    assert.equal(snapshot.sketches?.length, 16);
    assert.equal(snapshot.userFlags?.length, 16);
    return { messages, snapshot };
}

test("a malformed middle sketch degrades the carrier without shifting positions", () => {
    const { messages, snapshot } = seed();
    const sketches: unknown[] = [...snapshot.sketches!];
    sketches[4] = null;
    const restored = new PrefixAffinityResolver();
    assert.equal(restored.importSnapshot([{ ...snapshot, sketches }]), 1);
    assert.equal(restored.exportSnapshot()[0]!.sketches, undefined);
    assert.equal(restored.exportSnapshot()[0]!.userFlags, undefined);
    const replay = restored.resolve(messages);
    assert.ok(replay);
    assert.equal(replay.sessionId, snapshot.sessionId);
    assert.equal(replay.via, "prefix");
});

test("a malformed middle role flag drops flags instead of moving later anchors", () => {
    const { snapshot } = seed();
    const userFlags: unknown[] = [...snapshot.userFlags!];
    userFlags[3] = "invalid";
    const restored = new PrefixAffinityResolver();
    assert.equal(restored.importSnapshot([{ ...snapshot, userFlags }]), 1);
    const actual = restored.exportSnapshot()[0]!;
    assert.deepEqual(actual.sketches, snapshot.sketches);
    assert.equal(actual.userFlags, undefined);
});

test("valid positional carriers round-trip unchanged", () => {
    const { snapshot } = seed();
    const restored = new PrefixAffinityResolver();
    assert.equal(restored.importSnapshot([snapshot]), 1);
    assert.deepEqual(restored.exportSnapshot(), [snapshot]);
});

test("sparse positional carriers are rejected without skipping their holes", () => {
    const { snapshot } = seed();
    const sketches = [...snapshot.sketches!];
    delete sketches[4];
    const restored = new PrefixAffinityResolver();
    restored.importSnapshot([{ ...snapshot, sketches }]);
    assert.equal(restored.exportSnapshot()[0]!.sketches, undefined);

    const userFlags = [...snapshot.userFlags!];
    delete userFlags[3];
    restored.importSnapshot([{ ...snapshot, userFlags }]);
    assert.deepEqual(restored.exportSnapshot()[0]!.sketches, snapshot.sketches);
    assert.equal(restored.exportSnapshot()[0]!.userFlags, undefined);
});

function seedWithTailFrags() {
    const messages = [
        ...Array.from({ length: 16 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `message ${i}: deployment analysis includes the latency profile and retry budget of service ${i}`,
        })),
        { role: "assistant", content: "follow-up note on the retry budget for service 9" },
    ];
    const resolver = new PrefixAffinityResolver();
    const affinity = resolver.resolve(messages);
    assert.ok(affinity);
    const fp = resolver.chainFingerprint(messages);
    assert.ok(fp && fp.tailFrags && fp.tailFrags.length >= 2);
    resolver.note(affinity.sessionId, affinity.incomingDepth, affinity.tailHash, affinity.itemHashes, false, affinity.sketches, affinity.userFlags, undefined, fp.tailFrags);
    const snapshot = resolver.exportSnapshot()[0]!;
    assert.ok(snapshot.tailFrags && snapshot.tailFrags.length >= 2);
    return { messages, snapshot };
}

test("a malformed middle tail fragment degrades the carrier without shifting positions", () => {
    const { messages, snapshot } = seedWithTailFrags();
    const tailFrags: unknown[] = [...snapshot.tailFrags!];
    tailFrags[1] = null;
    const restored = new PrefixAffinityResolver();
    assert.equal(restored.importSnapshot([{ ...snapshot, tailFrags }]), 1);
    assert.equal(restored.exportSnapshot()[0]!.tailFrags, undefined);
    const replay = restored.resolve(messages);
    assert.ok(replay);
    assert.equal(replay.sessionId, snapshot.sessionId);
    assert.equal(replay.via, "prefix");
});

test("valid tail fragments round-trip unchanged", () => {
    const { snapshot } = seedWithTailFrags();
    const restored = new PrefixAffinityResolver();
    assert.equal(restored.importSnapshot([snapshot]), 1);
    assert.deepEqual(restored.exportSnapshot(), [snapshot]);
});
