import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createServedMarkerWriter } from "../src/served-markers.ts";

const identity = { instanceId: "bounded-writer", pid: process.pid, origin: "http://127.0.0.1:18080", version: "test" };

function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), "bili-verdict-retention-"));
    const dir = path.join(root, "writers");
    const logs: string[] = [];
    const writer = createServedMarkerWriter(identity, dir, (_level, message) => logs.push(message));
    return {
        dir, logs, writer,
        peer(id: string) {
            mkdirSync(dir, { recursive: true });
            const file = path.join(dir, "peer.json");
            writeFileSync(file, JSON.stringify({ v: 1, instanceId: "peer", pid: 999_999_999, origin: "http://127.0.0.1:18081", version: "test", servedAt: { [id]: Date.now() } }));
            utimesSync(file, new Date(), new Date());
        },
        close() { writer.dispose(); rmSync(root, { recursive: true, force: true }); },
    };
}

test("verdict memory is bounded alongside the persisted session window", t => {
    const f = fixture();
    t.after(() => f.close());
    for (let batch = 0; batch < 4; batch++) {
        for (let i = 0; i < 500; i++) f.writer.noteServed(`session-${batch}-${i}`);
        f.writer.__flushForTest();
        assert.equal(Object.keys(f.writer.__servedForTest()).length, 128);
        assert.equal(f.writer.__verdictCountForTest(), 128);
    }
    const marker = JSON.parse(readFileSync(path.join(f.dir, identity.instanceId + ".json"), "utf8"));
    assert.equal(Object.keys(marker.servedAt).length, 128);
    assert.ok(Object.values(marker.servedAt).every(value => typeof value === "number"));
});

test("expired verdicts disappear while the longer-lived served marker remains", t => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const f = fixture();
    t.after(() => f.close());
    f.writer.noteServed("idle-session");
    f.writer.__flushForTest();
    assert.equal(f.writer.__verdictCountForTest(), 1);
    t.mock.timers.tick(60_000);
    f.writer.__flushForTest();
    assert.equal(f.writer.__verdictCountForTest(), 0);
    assert.equal(Object.keys(f.writer.__servedForTest()).length, 1);
});

test("recent active verdicts still suppress repeats across marker flushes", t => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const f = fixture();
    t.after(() => f.close());
    f.peer("contested");
    f.writer.noteServed("contested");
    assert.equal(f.logs.length, 1);
    t.mock.timers.tick(5_000);
    f.writer.__flushForTest();
    f.writer.noteServed("contested");
    assert.equal(f.logs.length, 1);
    assert.equal(f.writer.__verdictCountForTest(), 1);
    t.mock.timers.tick(55_000);
    f.peer("contested");
    f.writer.__flushForTest();
    f.writer.noteServed("contested");
    assert.equal(f.logs.length, 2);
});

test("a returning evicted session is checked again against current peer activity", t => {
    const f = fixture();
    t.after(() => f.close());
    f.writer.noteServed("returning");
    for (let i = 0; i < 128; i++) f.writer.noteServed(`replacement-${i}`);
    f.writer.__flushForTest();
    assert.equal(f.writer.__servedForTest().returning, undefined);
    f.peer("returning");
    f.writer.noteServed("returning");
    assert.equal(f.logs.length, 1);
});
