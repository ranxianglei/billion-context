/**
 * #5874 T8 — decompress green-lane switch: the honest post-GC exit.
 *
 * The snapshot ROW LEDGER is the authoritative record of a block's pre-fold
 * content in the foundation lane. A block that left the kernel state is
 * restorable while its covering rows survive; once the lifecycle GC reaps the
 * rows together with the dead block (ruling B), decompress must fail with an
 * EXPLICIT audit diagnostic — never a silent empty body, never a bare
 * "not found".
 *
 * Hermetic: no server, no model — resolveDecompress(args, ctx) is a pure
 * function of (args, ctx) and the store is a scratch sqlite sidecar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import type { ProxyToolResult } from "../src/proxy-tool-result.ts";

const BLOCK_ID = "blk-t8";
const NO_LOG = (_msg: string): void => {};

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        pendingRetrievals: [],
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    } as unknown as Session;
}

/** Seed the ledger exactly the way a fold commit does: two covered rows
 *  (active=0, cover_ref=the block) + a ckpt whose coverage map records the
 *  fold. The block itself is NOT in the kernel state (it "died"). */
async function seedDeadBlockLedger(store: SessionStore, sessionId: string): Promise<void> {
    const backend = store.foundationStore();
    assert.ok(backend, "scratch store must expose the foundation substrate");
    const now = Date.now();
    await backend.commitSnapshot({
        sessionId,
        rows: [
            {
                pos: 1,
                coreIds: JSON.stringify(["c1"]),
                postJson: JSON.stringify([{ id: "c1", role: "user", contentType: "text", text: "the original question about the deploy" }]),
                tokensEst: 10,
                active: false,
                coverRef: BLOCK_ID,
            },
            {
                pos: 2,
                coreIds: JSON.stringify(["c2"]),
                postJson: JSON.stringify([{ id: "c2", role: "assistant", contentType: "text", text: "the deploy plan: cut over at 02:00" }]),
                tokensEst: 12,
                active: false,
                coverRef: BLOCK_ID,
            },
        ],
        logEntries: [{ kind: "compact", payload: JSON.stringify({ pos: 1, blockId: BLOCK_ID }), createdAt: now }],
        ckpt: {
            ckptSeq: 1,
            metaJson: JSON.stringify({
                v: 1,
                kernelState: {},
                stateChecksum: "t8",
                coverage: { "1": { lo: 1, hi: 2, blockId: BLOCK_ID } },
                s4: "t8",
            }),
            checksum: "t8",
            updatedAt: now,
        },
        now,
    });
}

function ctxFor(session: Session): Parameters<typeof resolveDecompress>[1] {
    return { core: createCore(), config: defaultConfig(200000), messages: [], session, log: NO_LOG };
}

test("T8a: green lane — a block that left state is restored from the row ledger", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "t8a-"));
    t.after(() => { _resetStoreForTest(); rmSync(dir, { recursive: true, force: true }); });
    const store = new SessionStore({ dir, enabled: true });
    _setStoreForTest(store);
    const session = makeSession("t8a");
    await seedDeadBlockLedger(store, "t8a");

    const r: ProxyToolResult = resolveDecompress({ blockId: BLOCK_ID }, ctxFor(session));
    assert.equal(r.outcome, "success");
    assert.match(r.text, /snapshot ledger/);
    assert.match(r.text, /\[user\] the original question about the deploy/);
    assert.match(r.text, /\[assistant\] the deploy plan: cut over at 02:00/);
    assert.match(r.text, /2 item\(s\)/);
});

test("T8b: lifecycle GC — the explicit audit exit, never a silent empty body", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "t8b-"));
    t.after(() => { _resetStoreForTest(); rmSync(dir, { recursive: true, force: true }); });
    const store = new SessionStore({ dir, enabled: true });
    _setStoreForTest(store);
    const session = makeSession("t8b");
    await seedDeadBlockLedger(store, "t8b");
    // The lifecycle GC reaps the rows together with the dead block (ruling B).
    const swept = await store.foundationStore()!.sweepSnapRowsByDeadCovers("t8b", [BLOCK_ID]);
    assert.equal(swept, 2);

    const r: ProxyToolResult = resolveDecompress({ blockId: BLOCK_ID }, ctxFor(session));
    assert.equal(r.outcome, "failure");
    // The red line: an explicit, grep-able audit line — not "not found", not "".
    assert.match(r.text, /garbage-collected/);
    assert.match(r.text, new RegExp(BLOCK_ID));
    assert.match(r.text, /audit: sid=t8b/);
    assert.match(r.text, /unrecoverable/);
    assert.ok(r.text.length > 80, "the receipt must carry the audit detail, not a stub");
});

test("T8c: no snapshot substrate — the legacy receipts apply unchanged", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "t8c-"));
    t.after(() => { _resetStoreForTest(); rmSync(dir, { recursive: true, force: true }); });
    const store = new SessionStore({ dir, enabled: false }); // sidecar closed
    _setStoreForTest(store);
    const session = makeSession("t8c");

    const r: ProxyToolResult = resolveDecompress({ blockId: BLOCK_ID }, ctxFor(session));
    // Whatever the legacy receipt says, it must NOT claim snapshot authority.
    assert.ok(!r.text.includes("snapshot ledger"), "no substrate → no ledger restore");
    assert.ok(!r.text.includes("garbage-collected"), "no substrate → no GC audit line");
    store.cancelAll();
});
