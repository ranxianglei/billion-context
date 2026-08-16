import test from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
import { renderHandoff } from "../src/export.ts";

// Regression: a session with no compression blocks CAN be selected for export,
// but the persisted record (persist.ts buildRecord) stores only compression
// state and compressed originals — never uncompressed conversation text. The
// handoff doc must say so honestly instead of promising "the session history
// below is the original conversation" and then rendering nothing, and must not
// print the "paste the block summaries" tail when there are no summaries.

function makeSession(id: string, title: string): Session {
    return {
        id,
        meta: { protocol: "responses", upstreamOrigin: "https://api.openai.com/v1", title },
        stats: { requests: 12, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50, cacheSamples: 1, lastInputTokens: 100, contextTokens: 99000 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("export of a snapshot session (v3) renders the full conversation", () => {
    const s = makeSession("abc123", "my chat");
    s.lastMessages = [
        { id: "m1", role: "user", contentType: "text", text: "hello from the client" },
        { id: "m2", role: "assistant", contentType: "text", text: "hi from the model" },
    ];
    const md = renderHandoff(s, false);
    assert.match(md, /hello from the client/);
    assert.match(md, /hi from the model/);
    assert.match(md, /### user/);
    assert.match(md, /### assistant/);
});

test("export of a v2 session without snapshot states honestly that content is unavailable", () => {
    for (const full of [false, true]) {
        const md = renderHandoff(makeSession("abc123", "my uncompressed chat"), full);
        assert.match(md, /No active compression blocks and no persisted conversation snapshot/);
        assert.doesNotMatch(md, /session history below/, `full=${full}: handoff still promises a history that is never rendered`);
        assert.doesNotMatch(md, /Paste the block summaries above/, `full=${full}: tail guidance printed with zero blocks`);
        // Header metadata is still useful — id/title/stats identify the session.
        assert.match(md, /- title: my uncompressed chat/);
        assert.match(md, /- session id: abc123/);
    }
});
