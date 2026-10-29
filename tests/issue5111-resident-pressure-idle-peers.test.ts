// #5111: the #3918 permanence verdict counted ALL other residents, but
// admission (makeResidentRoom) seats any session whose own weight fits the
// budget by evicting IDLE peers first — so an evicted session whose peers are
// just leftover idle sessions was told "NOT TRANSIENT ... close sessions or
// raise the limit and restart" when its next model request would have healed
// it. These tests pin the refined verdict: idle peers do not make the refusal
// permanent (self-heal wording stands), active peers still do, and a session
// too heavy for the whole budget alone keeps the permanent claim WITH ITS OWN
// exit advice (closing others cannot help). The gate itself stays pinned in
// tests/issue3126-no-visible-context.test.ts; the fresh-peer direction stays
// pinned in tests/issue3918-resident-eviction-refusal.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreMessage } from "acp-kernel";
import { createCore, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, acquireInFlight, releaseInFlight, markDirty, peekSession, residentPressure, _resetSessionsForTest } from "../src/session.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";

const BUDGET = 300_000;

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

function makeCtx(session: RewriteCtx["session"], logs: string[]): RewriteCtx {
    return {
        core: createCore(),
        config: defaultConfig(200000, { preserveRecentMessages: 5, preserveRecentTokens: 0 }),
        messages: [],
        session,
        log: (m: string) => { logs.push(m); },
    };
}

const SPEC = () => parseCompressInput({ content: [{ startId: "m00010", endId: "m00040", summary: "y".repeat(100) }] });

async function fixture(run: () => Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-5111-"));
    const store = new SessionStore({ dir: path.join(root, "sessions"), enabled: true, debounceMs: 0 });
    _resetSessionsForTest(256, BUDGET);
    _setStoreForTest(store);
    try { await run(); } finally {
        store.closeQuietly();
        _resetSessionsForTest(256, 512 * 1024 * 1024);
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmSync(root, { recursive: true, force: true });
    }
}

/** Same recipe as growAndEvictBig in the #3918 suite: big-sess is evicted by
 * releaseInFlight's discharge with its live weight stamped, peer-sess stays
 * resident. Returns the evicted object (alive in JS, refs intact). */
function growAndEvictBig(): RewriteCtx["session"] {
    const big = getSession("big-sess");
    const peer = getSession("peer-sess");
    big.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    big.metadata.blob = "x".repeat(80_000);
    peer.metadata.blob = "y".repeat(60_000);
    markDirty(big);
    markDirty(peer);
    acquireInFlight(big);
    releaseInFlight(big);
    return big;
}

test("#5111: an IDLE peer does not make the refusal permanent — admission evicts it to seat the reloaded session", async () => fixture(async () => {
    const big = growAndEvictBig();
    // Backdate the peer past PEER_ACTIVE_WINDOW_MS (5 min): a leftover session
    // with no recent traffic is exactly what the #5111 report hit.
    const peer = peekSession("peer-sess");
    assert.ok(peer, "peer still resident after big's discharge");
    peer!.lastSeen = Date.now() - 10 * 60 * 1000;
    const p = residentPressure(big.id);
    assert.ok(p.weightBytes !== undefined && p.weightBytes < BUDGET, `self fits the budget alone: ${p.weightBytes} < ${BUDGET}`);
    assert.ok(p.otherBytes > 50_000, `idle peer still occupies budget space (diagnostics unchanged): ${p.otherBytes}`);
    assert.equal(p.activeOtherBytes, 0, `idle peer excluded from permanence accounting: ${p.activeOtherBytes}`);
    assert.equal(p.permanent, false, "self fits + no active peers → transient again");
    const logs: string[] = [];
    const res = applyRanges(SPEC(), makeCtx(big, logs));
    assert.equal(res.outcome, "refused");
    assert.equal(res.reason, "gate:no-visible-context");
    assert.ok(res.text.includes("Do NOT retry now"), `self-heal wording restored: ${res.text}`);
    assert.ok(!res.text.includes("NOT TRANSIENT"), `no false permanent claim with idle peers: ${res.text}`);
    assert.ok(!logs.some((l) => l.includes("PERMANENT")), "log stays on the #3126 self-heal line");
}));

test("#5111: an ACTIVE peer still makes the refusal permanent (negative direction of the refined verdict)", async () => fixture(async () => {
    const big = growAndEvictBig();
    const p = residentPressure(big.id);
    assert.ok(p.activeOtherBytes > 50_000, `freshly-touched peer counts as active: ${p.activeOtherBytes}`);
    assert.ok(p.permanent, `weight ${p.weightBytes} + active ${p.activeOtherBytes} > budget ${BUDGET} → still permanent`);
    const logs: string[] = [];
    const res = applyRanges(SPEC(), makeCtx(big, logs));
    assert.equal(res.outcome, "refused");
    assert.ok(res.text.includes("NOT TRANSIENT"), `permanent case named: ${res.text}`);
    assert.ok(res.text.includes("ACTIVE resident sessions"), `receipt quotes the active-peer bytes: ${res.text}`);
    assert.ok(logs.some((l) => l.includes("PERMANENT") && l.includes("active other residents")), `log carries the active-peer marker: ${JSON.stringify(logs)}`);
}));

test("#5111: a session heavier than the WHOLE budget alone is permanent — and closing others is NOT offered as an exit", async () => fixture(async () => {
    const big = getSession("big-sess");
    big.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    big.metadata.blob = "x".repeat(350_000);
    markDirty(big);
    acquireInFlight(big);
    releaseInFlight(big);
    const p = residentPressure(big.id);
    assert.ok(p.weightBytes !== undefined && p.weightBytes > BUDGET, `self alone exceeds the budget: ${p.weightBytes} > ${BUDGET}`);
    assert.equal(p.otherBytes, 0, "no peers at all");
    assert.equal(p.activeOtherBytes, 0, "nothing to count as active");
    assert.ok(p.permanent, "heavier-than-budget-alone → permanent even with an empty pool");
    const logs: string[] = [];
    const res = applyRanges(SPEC(), makeCtx(big, logs));
    assert.equal(res.outcome, "refused");
    assert.equal(res.reason, "gate:no-visible-context");
    assert.ok(res.text.includes("NOT TRANSIENT"), `permanent case named: ${res.text}`);
    assert.ok(res.text.includes("will NOT free room"), `closing-others advice withdrawn for this shape: ${res.text}`);
    assert.ok(res.text.includes("sessions.residentMaxBytes"), `raise-limit exit still given: ${res.text}`);
    assert.ok(logs.some((l) => l.includes("PERMANENT") && l.includes("alone exceeds the whole budget")), `log names the self-exceeds shape: ${JSON.stringify(logs)}`);
}));

test("#5111: unknown session keeps no permanent claim and zeroed active accounting", async () => fixture(async () => {
    growAndEvictBig();
    const p = residentPressure("never-seen");
    assert.equal(p.permanent, false, "unknown session: no permanent claim without a known weight");
    assert.equal(p.weightBytes, undefined, "unknown session: no weight to quote");
}));
