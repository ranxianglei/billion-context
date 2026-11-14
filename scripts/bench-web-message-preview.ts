// Run with node --import ./tests/preload-test-env.mjs --import ./tests/preload-storage-baseline.mjs --import tsx scripts/bench-web-message-preview.ts [bytes]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createInitialState } from "acp-kernel";
import { _resetSessionsForTest, getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { buildSessionDetail } from "../src/web/sessions-data.ts";

const bytes = Number(process.argv[2] ?? 8 * 1024 * 1024);
if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 128 * 1024 * 1024) {
    throw new Error("bytes must be an integer between 1 and 134217728");
}
// Pin the ledger's generatedAt for response equality; timings use the monotonic clock.
Date.now = () => 1_700_000_000_000;
_setStoreForTest(new SessionStore({ enabled: false }));
_resetSessionsForTest();
const session = getSession("preview-benchmark", { protocol: "openai" });
session.createdAt = session.lastSeen = 1_700_000_000_000;
session.state = createInitialState();
session.state.blocks = [{
    blockId: "b1", runId: "r", tier: 1, summary: "Summary", directMessageIds: ["m1"],
    effectiveMessageIds: ["m1"], directBlockIds: [], compressedTokens: 1,
    createdAt: 1_700_000_000_000, survivedCount: 0, generation: "young", active: true,
}];
session.state.messageRefs = { byRaw: { m1: "m00001" }, byRef: { m00001: "m1" } };
session.lastMessages = [{ id: "m1", role: "tool", contentType: "text", text: "x".repeat(bytes) }];
const timings: number[] = [];
let digest: string | undefined;
for (let sample = 0; sample < 7; sample++) {
    const started = performance.now();
    const detail = await buildSessionDetail(session.id);
    const elapsed = performance.now() - started;
    assert.ok(detail);
    assert.equal(detail.blockDetails[0].directMessages[0]?.preview, bytes > 110 ? "x".repeat(110) + "…" : "x".repeat(bytes));
    const hash = createHash("sha256").update(JSON.stringify(detail)).digest("hex");
    if (digest) assert.equal(hash, digest, "the complete response must stay deterministic");
    digest = hash;
    if (sample >= 2) timings.push(elapsed);
}
console.log(JSON.stringify({
    bytes, warmups: 2, samples: timings.length, timings_ms: timings,
    median_ms: [...timings].sort((a, b) => a - b)[2],
    max_rss_kib: process.resourceUsage().maxRSS, digest,
}));
