import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flushOrderSkeletons, scheduleOrderPersist } from "../src/order-persist.ts";

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
