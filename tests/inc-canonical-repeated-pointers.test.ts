import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BiliMessage } from "acp-kernel/wire";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { recordCanonicalPointers } from "../src/incremental-lane.ts";

process.env.BILI_STORAGE_UNIFIED = "full";

const repeated = (id = "h_0123456789abcdef"): BiliMessage => ({ id, role: "assistant", contentType: "text", text: "ok" });

test("repeated content consumes settled row pointers in order, including across incremental updates", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bili-repeat-ptrs-"));
    const store = new SessionStore({ dir, enabled: true });
    _setStoreForTest(store);
    t.after(() => { _resetStoreForTest(); rmSync(dir, { recursive: true, force: true }); });
    const count = 25_000;
    const rows = Array.from({ length: count + 2 }, (_, i) => ({
        seq: i * 2 + 10, content: JSON.stringify(repeated(`h_0123456789abcdef_${i + 1}`)), ts: null,
    }));
    t.mock.method(store, "unifiedRawMessages", (_sid: string, from?: number) => rows.filter((row) => from === undefined || row.seq > from));
    const messages = Array.from({ length: count }, () => repeated());
    const warnings: string[] = [];
    const log = (level: string, text: string) => { if (level === "warn") warnings.push(text); };
    recordCanonicalPointers("repeated", messages, log);
    assert.deepEqual(store.getSessionExt("repeated", "inc:canonical-ptrs"), rows.slice(0, count).map((row) => row.seq));
    assert.deepEqual(messages.map((message) => message.ledgerSeq), rows.slice(0, count).map((row) => row.seq + 1));
    messages.push(repeated(), repeated());
    recordCanonicalPointers("repeated", messages, log);
    assert.deepEqual(store.getSessionExt("repeated", "inc:canonical-ptrs"), rows.map((row) => row.seq));
    assert.deepEqual(messages.slice(-2).map((message) => message.ledgerSeq), rows.slice(-2).map((row) => row.seq + 1));
    assert.deepEqual(warnings, []);
});

test("interleaved content buckets preserve canonical order and stop at the first unsettled message", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bili-mixed-ptrs-"));
    const store = new SessionStore({ dir, enabled: true });
    _setStoreForTest(store);
    t.after(() => { _resetStoreForTest(); rmSync(dir, { recursive: true, force: true }); });
    const other: BiliMessage = { id: "other", role: "user", contentType: "text", text: "next" };
    const rows = [
        { seq: 2, content: JSON.stringify(repeated("h_0123456789abcdef_1")), ts: null },
        { seq: 7, content: JSON.stringify(other), ts: null },
        { seq: 11, content: JSON.stringify(repeated("h_0123456789abcdef_2")), ts: null },
    ];
    t.mock.method(store, "unifiedRawMessages", () => rows);
    const messages = [repeated(), { ...other }, repeated(), { ...other }, repeated()];
    recordCanonicalPointers("mixed", messages, () => {});
    assert.deepEqual(store.getSessionExt("mixed", "inc:canonical-ptrs"), [2, 7, 11]);
    assert.deepEqual(messages.map((message) => message.ledgerSeq), [3, 8, 12, undefined, undefined]);
});
