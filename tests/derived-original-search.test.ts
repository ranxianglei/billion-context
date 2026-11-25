import assert from "node:assert/strict";
import test from "node:test";
import { createCore, createInitialState, defaultConfig, type CoreMessage } from "acp-kernel";
import { executeSearchContextTarget } from "../src/decompress-shared.ts";
import { getSession, _resetSessionsForTest, type Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";

const core = createCore({ countTokens: (text) => Math.ceil(text.length / 4) });
const config = defaultConfig(100000, { compress: { minCompressRange: 0, minSummaryLength: 1, maxSummaryLength: 5000 }, preserveRecentMessages: 2, preserveRecentTokens: 0 });

function session(id: string): Session {
    return getSession(id, { protocol: "openai", upstreamOrigin: "http://upstream" });
}

function folded(id: string, original: string): Session {
    const target = session(id);
    const messages: CoreMessage[] = Array.from({ length: 12 }, (_, i) => ({
        id: `message-${i}`, role: i % 2 ? "assistant" : "user", contentType: "text", text: `Conversation message ${i}: ${original} `.repeat(10),
    }));
    const turn = core.processTurn({ messages, state: createInitialState(), config, tokenCount: 2000 });
    const compressed = core.applyCompression({ ranges: [{ startRef: "m00001", endRef: "m00008", summary: "A general discussion of project decisions and earlier work." }], state: turn.state, messages: turn.messages, config });
    assert.equal(compressed.result.blocksCreated, 1);
    target.state = compressed.state;
    target.blockContents.set(target.state.blocks[0]!.blockId, { one: { text: "A general discussion.", count: 8 }, full: { text: original, count: 8 } });
    return target;
}

test.beforeEach(() => { _resetSessionsForTest(); _setStoreForTest(new SessionStore({ enabled: false })); });
test.afterEach(() => { _resetSessionsForTest(); _resetStoreForTest(); });

test("a derived child can find text retained only in its parent's folded originals", () => {
    const parent = folded("original-parent", "The deployment codename is zephyronlyarchive.");
    const child = session("original-child");
    child.metadata.derivedFromSessionId = parent.id;
    const before = JSON.stringify({ state: parent.state, contents: [...parent.blockContents] });
    const direct = executeSearchContextTarget({ query: "zephyronlyarchive", conversation_id: parent.id }, core, child.id, child.state);
    assert.match(direct.text, /Original-text hit\(s\)/);
    const inherited = executeSearchContextTarget({ query: "zephyronlyarchive" }, core, child.id, child.state);
    assert.match(inherited.text, /Original-text hit\(s\)/);
    assert.match(inherited.text, /in session original-parent/);
    assert.match(inherited.text, /zephyronlyarchive/);
    assert.equal(JSON.stringify({ state: parent.state, contents: [...parent.blockContents] }), before);
});

test("ancestor fallback continues past a parent with no match to a grandparent's originals", () => {
    const grandparent = folded("original-grandparent", "The earlier launch key is grandarchivekey.");
    const parent = folded("unmatched-parent", "Different retained content.");
    parent.metadata.derivedFromSessionId = grandparent.id;
    const child = session("grandchild");
    child.metadata.derivedFromSessionId = parent.id;
    const found = executeSearchContextTarget({ query: "grandarchivekey" }, core, child.id, child.state);
    assert.match(found.text, /in session original-grandparent/);
    assert.match(found.text, /Original-text hit\(s\)/);
});

test("current-session original hits win, and unlinked sessions remain isolated", () => {
    const parent = folded("priority-parent", "sharedarchivekey in parent");
    const child = folded("priority-child", "sharedarchivekey in child");
    child.metadata.derivedFromSessionId = parent.id;
    const local = executeSearchContextTarget({ query: "sharedarchivekey" }, core, child.id, child.state, { session: child, config, messages: [], log: () => {} });
    assert.match(local.text, /sharedarchivekey in child/);
    assert.doesNotMatch(local.text, /in session priority-parent/);
    const unlinked = session("unlinked");
    assert.match(executeSearchContextTarget({ query: "sharedarchivekey" }, core, unlinked.id, unlinked.state).text, /^\[No compressed blocks exist yet/);
});

test("an empty ancestor search keeps the child's original empty result", () => {
    const parent = folded("empty-parent", "Unrelated original.");
    const child = session("empty-child");
    child.metadata.derivedFromSessionId = parent.id;
    assert.equal(executeSearchContextTarget({ query: "missingarchivekey" }, core, child.id, child.state).text, "[No compressed blocks exist yet — nothing to search.]");
});
