// #5608-D follow-up: the one-time #4316 ref/ledger alignment is deferred to
// "the session's next successful fold" so its byte changes ride a boundary
// that already breaks the provider prefix. applyRanges armed the marker
// (session.pendingLedgerAlign) right after committing the kernel's returned
// state — BEFORE the blocksCreated === 0 returns — so a refused compress
// (range too small, cannot anchor, already compressed …) and the no-op class
// armed it as well. The next save then ran the alignment, whose mark raise
// stripped the time attribute from every <acp> tag rendered so far: the whole
// cached prefix changed after a call whose receipt says nothing was folded.
//
// Pinned here: a compress that creates no block leaves the marker unset and
// the next request's rendered bytes identical; a real fold still arms it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.BILI_STORAGE_UNIFIED = "full";
const testRoot = mkdtempSync(join(tmpdir(), "bili-refused-align-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import type { Session } from "../src/session.ts";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };
type Marked = Session & { pendingLedgerAlign?: boolean };

const cfg = defaultConfig(200000, { preserveRecentMessages: 2, preserveRecentTokens: 0 } as never);
const timeOf = (t: string | undefined): string | undefined => / time="([^"]+)"/.exec(t ?? "")?.[1];

function conversation(): CoreMessage[] {
    // 9 turns of 3000 chars: one message alone sits under minCompressRange
    // (5000), four together clear it.
    return Array.from({ length: 9 }, (_, i): CoreMessage => ({
        id: `raw_${i + 1}`,
        role: i % 2 === 0 ? "user" : "assistant",
        contentType: "text",
        text: `turn ${i + 1} ` + "lorem ipsum ".repeat(250),
    }));
}

/** A brand-new session exactly as the proxy leaves it after its first rounds:
 *  the timestamp pipeline has rendered every tag with a time attribute, and
 *  the rows are saved so each ref already sits on its ledger seat (seq + 1). */
async function freshSession(tag: string) {
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const dir = join(testRoot, `${tag}-${Math.random().toString(36).slice(2)}`);
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    const core = createCore({ timestamps: true });
    const messages = conversation();
    const first = core.processTurn({ messages, state: createInitialState(), config: cfg, tokenCount: 9000 });
    const session = {
        id: `refused-align-${tag}`,
        meta: { protocol: "anthropic" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: first.state,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        lastMessages: messages,
    } as unknown as Marked;
    store.scheduleSave(session);
    assert.ok(store.flushSync(session), "seed save committed");
    const seq = store.unifiedSeqByRaw(session.id);
    assert.ok(seq !== null && seq.size === messages.length, "rows are in the unified store (the alignment would have something to read)");
    const logs: string[] = [];
    const ctx: Ctx = { core, config: cfg, messages: first.messages, session, log: (m) => { logs.push(m); }, logs };
    const render = (): string[] => core
        .processTurn({ messages, state: session.state, config: cfg, tokenCount: 9000 })
        .messages.map((m) => m.text ?? "");
    const close = (): void => { store.closeQuietly(); _setStoreForTest({} as never); rmSync(dir, { recursive: true, force: true }); };
    return { store, session, ctx, before: first.messages.map((m) => m.text ?? ""), render, close };
}

test("a refused compress does not arm the ledger alignment — next request's tags are byte-identical", async () => {
    const s = await freshSession("refused");
    try {
        assert.ok(s.before.every((t) => timeOf(t) !== undefined), "precondition: every tag carries a time attribute");
        const res = applyRanges(parseCompressInput({ content: [{ startId: "m00002", endId: "m00002", summary: "one short turn, nothing worth keeping from it at all" }] }), s.ctx);
        assert.equal(res.outcome, "refused", res.text.slice(0, 200));
        assert.equal(res.reason, "gate:too-small", res.text.slice(0, 200));
        assert.equal(s.session.state.blocks.length, 0, "nothing was folded");
        assert.equal(s.session.pendingLedgerAlign, undefined, "no fold ⇒ marker never set (persist.ts consumePendingLedgerAlign contract)");
        // The save that follows the tool round, then the next request's render.
        s.store.scheduleSave(s.session);
        assert.ok(s.store.flushSync(s.session), "post-refusal save committed");
        assert.notEqual((s.session.state as { refLedgerAligned?: boolean }).refLedgerAligned, true, "alignment did not run on a refusal");
        assert.deepEqual(s.render(), s.before, "rendered tags unchanged after a refused compress");
    } finally { s.close(); }
});

test("a no-op compress (range inside the protected zone) does not arm it either", async () => {
    const s = await freshSession("noop");
    try {
        const res = applyRanges(parseCompressInput({ content: [{ startId: "m00008", endId: "m00009", summary: "the two most recent turns, which the protection window keeps raw" }] }), s.ctx);
        assert.equal(res.blocksCreated ?? 0, 0, res.text.slice(0, 200));
        assert.equal(s.session.state.blocks.length, 0, "nothing was folded");
        assert.equal(s.session.pendingLedgerAlign, undefined, "no block created ⇒ marker never set");
        s.store.scheduleSave(s.session);
        assert.ok(s.store.flushSync(s.session));
        assert.deepEqual(s.render(), s.before, "rendered tags unchanged after a compress that folded nothing");
    } finally { s.close(); }
});

test("a real fold still arms the alignment and the next save consumes it (#5608-D unchanged)", async () => {
    const s = await freshSession("applied");
    try {
        const res = applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00004", summary: "four early turns of filler text; nothing in them needs to be kept verbatim" }] }), s.ctx);
        assert.equal(res.outcome, "applied", res.text.slice(0, 200));
        assert.ok(s.session.state.blocks.length > 0, "a block was created");
        assert.equal(s.session.pendingLedgerAlign, true, "fold commit arms the one-time alignment");
        s.store.scheduleSave(s.session);
        assert.ok(s.store.flushSync(s.session));
        assert.equal(s.session.pendingLedgerAlign, undefined, "marker consumed by the save");
        assert.equal((s.session.state as { refLedgerAligned?: boolean }).refLedgerAligned, true, "alignment ran on the fold boundary");
    } finally { s.close(); }
});
