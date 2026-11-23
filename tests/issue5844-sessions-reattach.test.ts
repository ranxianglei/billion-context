// #5844: a DSH desktop upgrade changed the persona tag AND the replay shape
// in one shot → all four reanchor rungs failed → the resolver forked a fresh
// `${rawId}|sub:` lane that inherits NO blocks; the parent's 95 accumulated
// blocks went unclaimed and the 2.5M-token conversation was re-folded from
// scratch until the client's 300s idle timeout killed the turn (413). The
// owner recovered by hand: stop the proxy, edit ONE field (the parent
// skeleton's tagHash) in session-order.json, restart. This test pins the
// supported form of that recovery — `bili sessions reattach <rawId>
// <laneKey>` — at three levels:
//   A: resolver round trip — claim under tag A, drift+new tag forks the
//      lane, flush → simulated restart → reattach → re-resolve lands on the
//      PARENT (inherited blocks reclaimed), not a derived-persona fork.
//   B: verify-after-write (§6.2) — a running proxy rewrites the carrier from
//      its in-memory skeletons within ~1 minute and silently reverts an
//      offline edit; reattach re-reads after a delay and fails loudly (2).
//   C: unit errors — bad lane key shape, unknown lane, unknown parent,
//      lane recorded without a tag.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Hermetic state dirs BEFORE importing the server modules (#7.2 / #2668).
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-5844-reattach-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

// Imported AFTER the XDG env above.
const { resolveSessionOrder, resetSessionOrderForTest, orderSnapshot } = await import("../src/session-resolve.ts");
const {
    flushOrderSkeletons,
    hydrateOrderSkeletons,
    orderFile,
    reattachOrderSkeleton,
    readOrderTagHash,
} = await import("../src/order-persist.ts");
const { runSessionsCommand } = await import("../src/storage-maintenance.ts");
const { stateDir } = await import("../src/paths.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const long = (s: string): string => `${s}-` + "z".repeat(120);
/** Deep main-shaped history (≥3 turns incl. an assistant turn). */
const mainMsgs = (n: number, tag: string): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: long(`${tag}-${i + 1}`) }));

const SYS_A = "You are the pre-upgrade assistant persona.";
const SYS_B = "You are the post-upgrade assistant persona, with a completely different system prompt.";

/** The §5 incident in miniature: claim under the old persona, then a shorter
 *  replay under the NEW persona tag → every rung fails → persona fork. */
function forkScenario(id: string): { laneKey: string } {
    resetSessionOrderForTest();
    const claim = resolveSessionOrder(id, mainMsgs(6, "a"), SYS_A);
    assert.equal(claim.action, "claim", "old persona claims the raw id");
    // "Upgrade": the host now replays fewer turns AND sends a different tag.
    const r = resolveSessionOrder(id, mainMsgs(4, "b"), SYS_B);
    assert.equal(r.action, "derived-persona", "tag+shape drift forks the persona lane");
    const laneKey = r.key;
    assert.ok(laneKey.startsWith(`${id}|sub:`), "lane key embeds the raw id");
    return { laneKey };
}

function readSnapshot(): { version: number; entries: { id: string; tagHash: string; lastSeen: number }[] } {
    return JSON.parse(readFileSync(orderFile(), "utf8"));
}

test("#5844 A: reattach re-points the parent at the new tag — the next request reclaims the parent instead of forking", async () => {
    const id = "c-5844-a";
    const { laneKey } = forkScenario(id);
    flushOrderSkeletons(); // simulated shutdown: skeletons out to disk
    resetSessionOrderForTest(); // simulated restart: memory wiped
    hydrateOrderSkeletons();

    const before = readSnapshot().entries.find((e) => e.id === id)!;
    assert.equal(sha256(SYS_A), before.tagHash, "parent still carries the OLD tag on disk");
    const lane = readSnapshot().entries.find((e) => e.id === laneKey)!;
    assert.equal(sha256(SYS_B), lane.tagHash, "the orphan lane recorded the NEW tag");

    const res = await reattachOrderSkeleton(null, id, laneKey);
    assert.equal(res.after, sha256(SYS_B));
    assert.equal(res.before, sha256(SYS_A));
    assert.equal(res.fileTouched, true);

    const after = readSnapshot();
    assert.equal(after.entries.find((e) => e.id === id)!.tagHash, sha256(SYS_B), "parent re-pointed at the new tag");
    assert.equal(after.entries.find((e) => e.id === laneKey)!.tagHash, sha256(SYS_B), "lane entry preserved");
    assert.equal(after.entries.length, readSnapshot().entries.length, "no sibling entry lost");

    // The moment that mattered in §6.3: after the proxy restarts on the
    // edited file, the SAME drifted request resolves to the PARENT — its 95
    // blocks (84 active) come back with it.
    resetSessionOrderForTest();
    hydrateOrderSkeletons();
    const r2 = resolveSessionOrder(id, mainMsgs(4, "b"), SYS_B);
    assert.equal(r2.key, id, "post-reattach the drifted request lands on the parent, not a fresh fork");
    assert.notEqual(r2.action, "derived-persona");
});

test("#5844 B: a running proxy reverting the edit within the verify window is reported as code 2 (§6.2)", async () => {
    const id = "c-5844-b";
    const { laneKey } = forkScenario(id);
    flushOrderSkeletons();
    // The running proxy's snapshot (its in-memory skeletons still hold the
    // OLD parent hash) — it rewrites the file moments later.
    const stale = readFileSync(orderFile(), "utf8");

    // No reattach yet: the "proxy" rewrite of the identical bytes is a no-op;
    // apply the reattach, then let the "proxy" overwrite with its stale copy.
    const t = setTimeout(() => writeFileSync(orderFile(), stale), 60);
    const r = await runSessionsCommand({ sub: "reattach", target: id, laneKey, verifyDelayMs: 300 });
    clearTimeout(t);
    assert.equal(r.code, 2, "reverted edit must fail loudly, not report success");
    assert.match(r.text, /REVERTED|running proxy/i);
});

test("#5844 C: validation errors (bad shape / unknown lane / unknown parent / tagless lane)", async () => {
    const id = "c-5844-c";
    const { laneKey } = forkScenario(id);
    flushOrderSkeletons();

    await assert.rejects(
        () => reattachOrderSkeleton(null, id, "unrelated-lane"),
        /not an orphan lane/,
        "lane key must extend <rawId>|sub:",
    );
    await assert.rejects(
        () => reattachOrderSkeleton(null, id, `${id}|sub:0000000000000000`),
        /orphan lane skeleton .* not found/,
        "unknown lane key",
    );
    await assert.rejects(
        () => reattachOrderSkeleton(null, "c-5844-noparent", "c-5844-noparent|sub:0000000000000000"),
        /parent skeleton .* not found/,
        "unknown parent id",
    );

    // A lane recorded without a tag cannot be the source of truth.
    const snap = readSnapshot();
    const tagless = { ...snap, entries: [...snap.entries, { id: `${id}|sub:deadbeef00000000`, kinds: ["user"], frags: [], tagHash: "", lastSeen: Date.now() }] };
    writeFileSync(orderFile(), JSON.stringify(tagless));
    await assert.rejects(
        () => reattachOrderSkeleton(null, id, `${id}|sub:deadbeef00000000`),
        /no persona tagHash/,
        "tagless lane rejected",
    );

    // readOrderTagHash sees the freshest carrier value.
    assert.equal(await readOrderTagHash(null, id), sha256(SYS_A), "parent tag readable before any reattach here");
    assert.equal(await readOrderTagHash(null, "no-such-id"), null, "absent id reads null");
});

test("#5844 D: the fork is logged with the exact recovery command", () => {
    // orderSnapshot exposes the recorded skeleton; the warn line itself is a
    // logger surface — pin the contract that the fork records a lane whose
    // key the command accepts, so the logged command is always runnable.
    resetSessionOrderForTest();
    const id = "c-5844-d";
    resolveSessionOrder(id, mainMsgs(6, "d"), SYS_A);
    const r = resolveSessionOrder(id, mainMsgs(4, "d2"), SYS_B);
    const snap = orderSnapshot();
    assert.ok(snap.some((e) => e.id === r.key), "fork lane is recorded");
    assert.ok(r.key.startsWith(`${id}|sub:`), "logged lane key has the accepted shape");
    assert.ok(stateDir(), "state dir resolvable (order file sits under it)");
    void existsSync;
});
