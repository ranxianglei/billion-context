import test from "node:test";
import assert from "node:assert/strict";
import { classifySameLanePeer, entryShape, sameInstanceShape, type InstanceShape, type RegistryEntry } from "../src/instance.ts";

// #3801: the twin rule used to classify ANY live same-lane same-build holder
// as a duplicate — so a holder whose config drifted (client model config
// edited after it spawned) killed the very launch that should have laddered
// off it. classifySameLanePeer splits that one case into "twin" (identical
// code AND shape — a true duplicate, the newcomer loses per #3044) and
// "drifted" (same code, different shape — the newcomer ladders off, the
// holder keeps serving). These rows pin BOTH directions of every cell:
// triggers when it should, does NOT trigger when it should not (#3617).

const OWN_FP = "fp-our-build";
const OTHER_FP = "fp-other-build";
const BASE = 18818;

function ownShape(over: Partial<InstanceShape> = {}): InstanceShape {
    return {
        host: "127.0.0.1",
        passthrough: false,
        mitmDomains: [],
        modelWindows: { "model-a": 1000 },
        modelMaxOutputs: { "model-a": 128 },
        ...over,
    };
}

function holder(over: Partial<RegistryEntry> = {}): RegistryEntry {
    return {
        instanceId: "holder-1",
        pid: process.pid,
        port: BASE,
        origin: `http://127.0.0.1:${BASE}`,
        startedAt: Date.now(),
        host: "127.0.0.1",
        passthrough: false,
        mitmDomains: [],
        modelWindows: { "model-a": 1000 },
        modelMaxOutputs: { "model-a": 128 },
        lane: "pi",
        codeFingerprint: OWN_FP,
        ...over,
    };
}

/** A pid guaranteed dead: above every platform's assignable range, so
 *  kill(pid, 0) always misses (same idiom as instance-governance). */
function deadPid(): number {
    return 4_000_000;
}

function classify(own: InstanceShape, entries: RegistryEntry[]): ReturnType<typeof classifySameLanePeer> {
    return classifySameLanePeer(entries, BASE, "pi", OWN_FP, (e) => sameInstanceShape(entryShape(e), own));
}

// ---------------------------------------------------------------------------
// sameInstanceShape — the five cells, each with a positive and negative row.
// ---------------------------------------------------------------------------

test("sameInstanceShape: identical shapes match", () => {
    assert.equal(sameInstanceShape(ownShape(), ownShape()), true);
});

test("sameInstanceShape: empty tables on both sides match (nothing configured)", () => {
    const s = ownShape({ modelWindows: {}, modelMaxOutputs: {} });
    assert.equal(sameInstanceShape(s, s), true);
});

test("sameInstanceShape: a model ADDED to the window map mismatches (#3801 repro)", () => {
    assert.equal(sameInstanceShape(ownShape(), ownShape({ modelWindows: { "model-a": 1000, "model-b": 2000 } })), false);
});

test("sameInstanceShape: a model REMOVED from the window map mismatches (symmetric direction)", () => {
    assert.equal(sameInstanceShape(ownShape({ modelWindows: { "model-a": 1000, "model-b": 2000 } }), ownShape()), false);
});

test("sameInstanceShape: a changed window value mismatches", () => {
    assert.equal(sameInstanceShape(ownShape(), ownShape({ modelWindows: { "model-a": 999 } })), false);
});

test("sameInstanceShape: max-output drift mismatches in either direction", () => {
    assert.equal(sameInstanceShape(ownShape(), ownShape({ modelMaxOutputs: { "model-a": 256 } })), false);
    assert.equal(sameInstanceShape(ownShape(), ownShape({ modelMaxOutputs: { "model-a": 128, "model-b": 64 } })), false);
});

test("sameInstanceShape: host or passthrough drift mismatches", () => {
    assert.equal(sameInstanceShape(ownShape(), ownShape({ host: "0.0.0.0" })), false);
    assert.equal(sameInstanceShape(ownShape(), ownShape({ passthrough: true })), false);
});

test("sameInstanceShape: mitm domains compare positionally (order matters)", () => {
    assert.equal(sameInstanceShape(ownShape({ mitmDomains: ["a.example", "b.example"] }), ownShape({ mitmDomains: ["b.example", "a.example"] })), false);
    assert.equal(sameInstanceShape(ownShape({ mitmDomains: ["a.example", "b.example"] }), ownShape({ mitmDomains: ["a.example", "b.example"] })), true);
});

test("entryShape: absent fields normalize to the empty value", () => {
    const bare: RegistryEntry = { instanceId: "x", pid: 1, port: 1, origin: "", startedAt: 0 };
    assert.deepEqual(entryShape(bare), {
        host: "",
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        modelMaxOutputs: {},
    });
});

// ---------------------------------------------------------------------------
// classifySameLanePeer — trigger / non-trigger rows.
// ---------------------------------------------------------------------------

test("classify: a live same-lane same-build SAME-SHAPE holder is a twin (the #3044 duplicate)", () => {
    const peer = classify(ownShape(), [holder()]);
    assert.equal(peer?.kind, "twin");
    assert.equal(peer?.entry.instanceId, "holder-1");
});

test("classify: a live same-lane same-build holder with DRIFTED windows is not a twin (#3801)", () => {
    const peer = classify(ownShape({ modelWindows: { "model-a": 1000, "model-b": 2000 } }), [holder()]);
    assert.equal(peer?.kind, "drifted");
    assert.equal(peer?.entry.instanceId, "holder-1");
});

test("classify: drifted max outputs / host / passthrough / domain order all classify as drifted too", () => {
    assert.equal(classify(ownShape({ modelMaxOutputs: { "model-a": 256 } }), [holder()])?.kind, "drifted");
    assert.equal(classify(ownShape({ host: "0.0.0.0" }), [holder()])?.kind, "drifted");
    assert.equal(classify(ownShape({ passthrough: true }), [holder()])?.kind, "drifted");
    assert.equal(classify(ownShape({ mitmDomains: ["b.example", "a.example"] }), [holder({ mitmDomains: ["a.example", "b.example"] })])?.kind, "drifted");
});

test("classify: a holder with NO recorded shape cells is drifted against any non-empty own shape", () => {
    const bare = holder({ host: undefined, passthrough: undefined, mitmDomains: undefined, modelWindows: undefined, modelMaxOutputs: undefined });
    assert.equal(classify(ownShape(), [bare])?.kind, "drifted");
});

test("classify: wrong port, wrong lane, or undeclared lanes never classify", () => {
    assert.equal(classify(ownShape(), [holder({ port: BASE + 1 })]), undefined, "different port");
    assert.equal(classify(ownShape(), [holder({ lane: "dsh" })]), undefined, "different lane");
    assert.equal(classify(ownShape(), [holder({ lane: undefined })]), undefined, "undeclared (wildcard) lane is a manual daemon — never a peer here");
    assert.equal(classifySameLanePeer([holder()], BASE, undefined, OWN_FP, () => true), undefined, "no lane of our own");
    assert.equal(classifySameLanePeer([holder()], BASE, "", OWN_FP, () => true), undefined, "empty lane");
});

test("classify: different or missing fingerprints never classify (predecessor/squatter territory)", () => {
    assert.equal(classify(ownShape(), [holder({ codeFingerprint: OTHER_FP })]), undefined, "foreign build");
    assert.equal(classify(ownShape(), [holder({ codeFingerprint: undefined })]), undefined, "missing fingerprint (pre-fingerprint marker)");
    assert.equal(classifySameLanePeer([holder()], BASE, "pi", undefined, () => true), undefined, "no own fingerprint — cannot tell builds apart");
});

test("classify: a dead holder never classifies (its port frees itself)", () => {
    assert.equal(classify(ownShape(), [holder({ pid: deadPid() })]), undefined);
});

test("classify: no holders at all", () => {
    assert.equal(classify(ownShape(), []), undefined);
});

test("classify: mixed holders — the first matching live same-build peer decides", () => {
    const foreign = holder({ instanceId: "other-1", codeFingerprint: OTHER_FP });
    const twin = holder({ instanceId: "twin-1" });
    assert.equal(classify(ownShape(), [foreign, twin])?.entry.instanceId, "twin-1");
});
