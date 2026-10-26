import test from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
import { renderHandoff } from "../src/export.ts";

// Regression #845: bili export on a session with a persisted folded snapshot
// must include every active block's summary even when BILI_PERSIST_TAIL_TOKENS
// truncated the summary out of the snapshot tail; --full must additionally
// attach each block's original messages; a summary already rendered in the
// conversation view must not be duplicated.

const SUMMARY = "Root cause was a stale token cache in auth.ts:42; fixed by invalidating on logout.";
const ORIGINAL_MARKER = "my login breaks after deploy";

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "responses", upstreamOrigin: "https://api.openai.com/v1", title: "auth debugging" },
        stats: { requests: 12, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50, cacheSamples: 1, lastInputTokens: 100, contextTokens: 99000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: true,
        pendingRetrievals: [],
    };
}

function addBlock(s: Session, blockId: string, active: boolean): void {
    s.state.blocks.push({
        blockId, runId: "r0", tier: 1, topic: "auth bug hunt",
        summary: SUMMARY,
        directMessageIds: ["m1", "m2"], effectiveMessageIds: ["m1", "m2"], directBlockIds: [],
        compressedTokens: 4200, createdAt: Date.now() - 5000, survivedCount: 2, generation: "young", active,
    });
    s.blockContents.set(blockId, {
        one: null,
        full: { text: `user: ${ORIGINAL_MARKER}\nassistant: checking auth.ts:42 token cache`, count: 2 },
    });
}

function count(haystack: string, needle: string): number {
    let n = 0;
    let i = 0;
    while ((i = haystack.indexOf(needle, i)) !== -1) {
        n++;
        i += needle.length;
    }
    return n;
}

test("folded snapshot truncated below the summary still exports it (#845)", () => {
    const s = makeSession("abc123");
    addBlock(s, "b1", true);
    s.lastMessagesFolded = true;
    s.lastMessages = [
        { id: "m9", role: "user", contentType: "text", text: "later question" },
        { id: "m10", role: "assistant", contentType: "text", text: "later answer" },
    ];

    const md = renderHandoff(s, false);
    assert.match(md, /## Compressed block summaries/);
    assert.match(md, /### Block b1 — auth bug hunt/);
    assert.equal(count(md, SUMMARY), 1, "summary must appear exactly once");
    assert.doesNotMatch(md, new RegExp(ORIGINAL_MARKER), "plain export must not leak compressed originals");

    const mdFull = renderHandoff(s, true);
    assert.equal(count(mdFull, SUMMARY), 1, "--full must not duplicate the summary");
    assert.equal(count(mdFull, ORIGINAL_MARKER), 1, "--full must attach the block originals");
    assert.match(mdFull, /#### Original messages \(2\)/);
});

test("summary already in the snapshot is not duplicated", () => {
    const s = makeSession("abc123");
    addBlock(s, "b1", true);
    s.lastMessagesFolded = true;
    s.lastMessages = [
        { id: "acp_summary_b1", role: "system", contentType: "text", text: `[Compressed conversation section] — auth bug hunt\n${SUMMARY}` },
        { id: "m9", role: "user", contentType: "text", text: "later question" },
    ];

    const md = renderHandoff(s, false);
    assert.equal(count(md, SUMMARY), 1, "summary must not be duplicated across sections");
    assert.match(md, /_summary already shown in the conversation view above_/);
});

test("legacy non-folded record: prune-injected summary dedups, --full does not duplicate originals", () => {
    const s = makeSession("abc123");
    addBlock(s, "b1", true);
    s.lastMessagesFolded = false;
    s.lastMessages = [
        { id: "m1", role: "user", contentType: "text", text: `user: ${ORIGINAL_MARKER}` },
        { id: "m2", role: "assistant", contentType: "text", text: "assistant: checking auth.ts:42 token cache" },
        { id: "m9", role: "user", contentType: "text", text: "later question" },
    ];

    const md = renderHandoff(s, false);
    assert.equal(count(md, SUMMARY), 1, "prune-injected summary must not be re-emitted");
    assert.match(md, /_summary already shown in the conversation view above_/);

    const mdFull = renderHandoff(s, true);
    assert.equal(count(mdFull, SUMMARY), 1, "raw full dump carries no summary; section supplies it once");
    assert.equal(count(mdFull, ORIGINAL_MARKER), 1, "--full non-folded already dumps every original message");
    assert.doesNotMatch(mdFull, /Original messages/, "originals must not be attached again for non-folded exports");
});

test("section absent without active blocks; inactive blocks excluded", () => {
    const empty = makeSession("empty");
    empty.lastMessagesFolded = true;
    empty.lastMessages = [{ id: "m1", role: "user", contentType: "text", text: "hello" }];
    assert.doesNotMatch(renderHandoff(empty, false), /## Compressed block summaries/);
    assert.doesNotMatch(renderHandoff(empty, true), /## Compressed block summaries/);

    const inactive = makeSession("inactive");
    addBlock(inactive, "b1", false);
    inactive.lastMessagesFolded = true;
    inactive.lastMessages = [{ id: "m9", role: "user", contentType: "text", text: "later question" }];
    assert.doesNotMatch(renderHandoff(inactive, false), /## Compressed block summaries/);
});

test("host-named sessions export under the host name, not the derived title (#2322)", () => {
    const named = makeSession("named1");
    named.meta.hostTitle = "Fix login flow";
    named.lastMessagesFolded = true;
    named.lastMessages = [{ id: "m9", role: "user", contentType: "text", text: "later question" }];
    const md = renderHandoff(named, false);
    assert.match(md, /- title: Fix login flow/, "handoff prefers hostTitle over the derived title");
    assert.doesNotMatch(md, /auth debugging/, "derived title must not replace it");

    const plain = makeSession("plain1");
    plain.lastMessagesFolded = true;
    plain.lastMessages = [{ id: "m9", role: "user", contentType: "text", text: "later question" }];
    assert.match(renderHandoff(plain, false), /- title: auth debugging/, "no hostTitle → derived title unchanged");
});
