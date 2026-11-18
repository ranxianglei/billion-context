/** node --import ./tests/preload-test-env.mjs --import tsx scripts/bench-canonical-repeated-pointers.ts */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BiliMessage } from "acp-kernel/wire";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { recordCanonicalPointers } from "../src/incremental-lane.ts";
const dir = mkdtempSync(join(tmpdir(), "bili-pointer-bench-"));
const store = new SessionStore({ dir, enabled: true });
_setStoreForTest(store);
try {
    for (const count of [10_000, 50_000, 100_000]) {
        const messages: BiliMessage[] = Array.from({ length: count }, () => ({ id: "h_0123456789abcdef", role: "assistant", contentType: "text", text: "ok" }));
        const rows = messages.map((message, i) => ({ seq: i, content: JSON.stringify({ ...message, id: `${message.id}_${i + 1}` }), ts: null }));
        store.unifiedRawMessages = () => rows;
        const samples: number[] = [];
        for (let run = 0; run < 3; run++) {
            const start = performance.now();
            recordCanonicalPointers(`bench-${count}-${run}`, messages, () => {});
            samples.push(performance.now() - start);
            assert.equal((store.getSessionExt(`bench-${count}-${run}`, "inc:canonical-ptrs") as number[]).length, count);
        }
        console.log(JSON.stringify({ count, milliseconds: samples, medianMs: [...samples].sort((a,b)=>a-b)[1] }));
    }
} finally {
    _resetStoreForTest(); rmSync(dir, { recursive: true, force: true });
}
