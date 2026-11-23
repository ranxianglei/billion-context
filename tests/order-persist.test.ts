import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flushOrderSkeletons, hydrateOrderSkeletons, scheduleOrderPersist, _resetOrderPersistForTest } from "../src/order-persist.ts";
import { applyOrderSnapshot, orderSnapshot, resetSessionOrderForTest, type OrderSkeletonEntry } from "../src/session-resolve.ts";

// #6058: the session-order snapshot writer had its quiesce/max-delay windows
// hardcoded (500ms / 5s) and never read the persist.* knobs — while the main
// session writer honored persist.debounceMs all along. These tests pin both
// directions of the wiring: the defaults stay at the historical cadence, and
// the env knobs actually move the write timing (a knob that is read but only
// the debounce half would pass test A and fail B/C).

let tmp: string;

function orderFile(): string {
    return path.join(tmp, "billion-context", "session-order.json");
}

async function waitUntilFile(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (fs.existsSync(orderFile())) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return fs.existsSync(orderFile());
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "order-persist-"));
    process.env.XDG_STATE_HOME = tmp;
});

test("default cadence unchanged: single mutation lands within ~500ms (#6058)", async () => {
    assert.ok(!fs.existsSync(orderFile()), "fresh state dir has no snapshot yet");
    scheduleOrderPersist();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!fs.existsSync(orderFile()), "no immediate write at t=0");
    const landed = await waitUntilFile(2_000);
    assert.ok(landed, "default 500ms debounce still writes well inside 2.2s");
    flushOrderSkeletons();
});

test("persist.debounceMs knob is honored — a larger window defers the write (#6058)", async () => {
    process.env.BILI_PERSIST_DEBOUNCE_MS = "1500";
    try {
        scheduleOrderPersist();
        await new Promise((r) => setTimeout(r, 700));
        assert.ok(!fs.existsSync(orderFile()), "with debounce=1500 the old hardcoded 500ms must NOT have fired");
        const landed = await waitUntilFile(2_500);
        assert.ok(landed, "the write still lands after the 1500ms knob window");
    } finally {
        delete process.env.BILI_PERSIST_DEBOUNCE_MS;
        flushOrderSkeletons();
    }
});

test("persist.maxDelayMs knob is honored — a small cap beats a huge debounce under sustained traffic (#6058)", async () => {
    // The reported field scenario: continuous mutations. With debounce=5000
    // the OLD code first wrote at ~5s (its hardcoded max-delay budget); with
    // maxDelay=400 the write must land within ~1.5s.
    process.env.BILI_PERSIST_DEBOUNCE_MS = "5000";
    process.env.BILI_PERSIST_MAX_DELAY_MS = "400";
    try {
        const start = Date.now();
        let saw = false;
        while (Date.now() - start < 1_500) {
            scheduleOrderPersist();
            await new Promise((r) => setTimeout(r, 100));
            if (fs.existsSync(orderFile())) {
                saw = true;
                break;
            }
        }
        assert.ok(saw, "maxDelay=400 must force the write within ~1.5s despite debounce=5000");
    } finally {
        delete process.env.BILI_PERSIST_DEBOUNCE_MS;
        delete process.env.BILI_PERSIST_MAX_DELAY_MS;
        flushOrderSkeletons();
    }
});

// #6255: the byte budget used to bind in array order (write order), so with
// fewer than 1,024 entries — where the recency sort was skipped — the OLDEST
// records were kept and the newest conversations were silently dropped. Pin
// both directions: the budget keeps the newest, and sorting a write never
// reorders the resident in-memory records.
test("the order snapshot byte budget keeps newest conversations below the entry-count cap", async () => {
    _resetOrderPersistForTest();
    resetSessionOrderForTest();
    const kinds = Array.from({ length: 4_000 }, (_, i) => i % 2 === 0 ? "user" : "assistant");
    const frags = Array.from({ length: 4_000 }, () => "a".repeat(64));
    const entries = Array.from({ length: 40 }, (_, i): OrderSkeletonEntry => ({
        id: `byte-budget-${i}`, kinds, frags, tagHash: "b".repeat(64), lastSeen: 1_000 + i,
    }));
    applyOrderSnapshot(entries);
    const idsBefore = orderSnapshot().map((e) => e.id);
    await flushOrderSkeletons();
    const bytes = fs.readFileSync(orderFile());
    const saved = JSON.parse(bytes.toString("utf8")) as { entries: OrderSkeletonEntry[] };
    assert.ok(bytes.length <= 8 * 1024 * 1024);
    assert.ok(saved.entries.length > 0 && saved.entries.length < entries.length, "byte budget, not the 1024-entry cap, truncated the snapshot");
    const expected = [...entries].reverse().slice(0, saved.entries.length).map((e) => e.id);
    assert.deepEqual(saved.entries.map((e) => e.id), expected);
    assert.deepEqual(orderSnapshot().map((e) => e.id), idsBefore, "sorting a write does not reorder resident records");
    resetSessionOrderForTest();
    hydrateOrderSkeletons();
    assert.deepEqual(orderSnapshot().map((e) => e.id), expected, "newest skeletons survive an actual file round trip");
});

test("order snapshot budget preserves all small entries and stable timestamp ties", async () => {
    _resetOrderPersistForTest();
    resetSessionOrderForTest();
    const entries: OrderSkeletonEntry[] = [
        { id: "tie-a", kinds: ["user"], frags: ["a"], tagHash: "", lastSeen: 2 },
        { id: "older", kinds: ["assistant"], frags: ["b"], tagHash: "", lastSeen: 1 },
        { id: "tie-b", kinds: ["user"], frags: ["c"], tagHash: "", lastSeen: 2 },
    ];
    applyOrderSnapshot(entries);
    await flushOrderSkeletons();
    const saved = JSON.parse(fs.readFileSync(orderFile(), "utf8")) as { entries: OrderSkeletonEntry[] };
    assert.equal(saved.entries.length, entries.length);
    assert.deepEqual(saved.entries.filter((e) => e.lastSeen === 2).map((e) => e.id), ["tie-a", "tie-b"]);
    const savedById = new Map(saved.entries.map((e) => [e.id, e]));
    for (const e of entries) {
        assert.deepEqual(savedById.get(e.id), e, `entry ${e.id} preserved verbatim`);
    }
});
