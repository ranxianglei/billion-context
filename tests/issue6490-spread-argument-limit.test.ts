// #6490: Math.min/Math.max argument spread over unbounded arrays trips V8's
// argument-spread limit (~65K args) → RangeError. The reconciliation site
// (planReconciliation) is pinned by fold-reconcile-large-history.test.ts;
// this file pins the second same-mechanism site in src/ — the incremental
// lane's canonical-pointer upkeep, which spreads the session's full pointer
// list (one entry per settled canonical message) into Math.max.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BiliMessage } from "acp-kernel/wire";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { recordCanonicalPointers } from "../src/incremental-lane.ts";

// Beyond V8's argument-spread limit (~125K–130K on Node 22/24 x64, lower on
// some builds): spreading this many arguments throws RangeError: Maximum call
// stack size exceeded. Same size as the fold-reconcile-large-history case.
const SPREAD_LIMIT = 150_000;

test("#6490: canonical-pointer upkeep survives a pointer list beyond the argument limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-6490-"));
    const previousMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const store = new SessionStore({ dir, enabled: true });
        _setStoreForTest(store);
        const ptrs = Array.from({ length: SPREAD_LIMIT }, (_, i) => i);
        store.setSessionExt("conv-6490", "inc:canonical-ptrs", ptrs);
        const msgs: BiliMessage[] = Array.from({ length: SPREAD_LIMIT }, (_, i) => ({
            id: `m${i}`,
            role: "user",
            contentType: "text",
            text: `turn ${i}`,
        }));
        const warnings: string[] = [];
        let seenFromSeq: number | undefined;
        const orig = store.unifiedRawMessages.bind(store);
        store.unifiedRawMessages = (sessionId: string, fromSeqExclusive?: number) => {
            seenFromSeq = fromSeqExclusive;
            return orig(sessionId, fromSeqExclusive);
        };
        recordCanonicalPointers("conv-6490", msgs, (level, m) => {
            if (level === "warn") warnings.push(m);
        });
        assert.equal(
            warnings.filter((w) => w.includes("Maximum call stack")).length,
            0,
            `no argument-limit RangeError: ${warnings.join(" | ")}`,
        );
        assert.equal(seenFromSeq, SPREAD_LIMIT - 1, "the upkeep reads rows after the highest pointer");
        const after = store.getSessionExt("conv-6490", "inc:canonical-ptrs");
        assert.ok(Array.isArray(after), "pointer list preserved");
        assert.equal((after as number[]).length, SPREAD_LIMIT);
        assert.equal((after as number[])[SPREAD_LIMIT - 1], SPREAD_LIMIT - 1);
    } finally {
        _resetStoreForTest();
        if (previousMode === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = previousMode;
        rmSync(dir, { recursive: true, force: true });
    }
});
