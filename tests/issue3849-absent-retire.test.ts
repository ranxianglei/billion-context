import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { reconcileFoldCoverage, normalizedIdentity, METADATA_FOLD_COVERAGE, METADATA_DRIFT_ESCALATED, type FoldAnchor } from "../src/fold-reconcile.ts";

before(() => {
    // recordConflict -> markDirty -> getStore().scheduleSave; keep that off-disk.
    _setStoreForTest(new SessionStore({ enabled: false }));
});

function makeSession(): Session {
    return {
        id: `test-${Math.random().toString(36).slice(2)}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function msg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function logCapture() {
    const lines: { level: string; text: string }[] = [];
    return { lines, log: (level: string, text: string) => { lines.push({ level, text }); } };
}

// #3849 fixture: 14 distinct messages h0..h13, one active block covering the
// middle span [h2..h7]. The drifted resend drops `drop` ids with NO replacement
// bytes — the mid-session wire/dialect switch shape where old-dialect cores
// never reappear under the new projection (reasoning cores folded into content,
// standalone tool messages re-packed). Fake anchor `n` values never equal a live
// sha256, so nothing can re-anchor onto the missing ids: they stay unmatched
// every pass, exactly like the reported 124-id steady-state residual.
interface FixtureOpts {
    pluginAgent?: boolean;
    drop?: string[];
    replace?: Record<string, { id: string }>;
    reasoningIds?: string[];
    /** ids whose anchor carries the REAL normalized identity (so a byte-identical
     *  re-mint under a new content-hash id can be claimed onto churned bytes);
     *  every other id keeps a fake identity that matches nothing. */
    realN?: string[];
}

function retireFixture(opts: FixtureOpts = {}): { session: Session; full: CoreMessage[]; drifted: CoreMessage[] } {
    const drop = opts.drop ?? ["h5", "h6"];
    const session = makeSession();
    const all: CoreMessage[] = [];
    for (let i = 0; i < 14; i++) all.push(msg(`h${i}`, i % 2 === 0 ? "user" : "assistant", `body ${i} ${"z".repeat(512)}`));
    const covered = ["h2", "h3", "h4", "h5", "h6", "h7"];
    const anchors: Record<string, FoldAnchor> = {};
    for (const id of covered) {
        const n = Number(id.slice(1));
        const source = all.find((m) => m.id === id)!;
        anchors[id] = {
            n: opts.realN?.includes(id) ? normalizedIdentity(source) : `sha_${id}`,
            r: n % 2 === 0 ? "user" : "assistant",
            c: opts.reasoningIds?.includes(id) ? "reasoning" : "text",
            b: source.text?.length ?? 0,
        };
    }
    session.state.blocks = [{
        blockId: "b0", runId: "r0", tier: 1, summary: "folded span", directMessageIds: [...covered],
        effectiveMessageIds: [...covered], directBlockIds: [], compressedTokens: 1000, createdAt: Date.now(),
        survivedCount: 0, generation: "young", active: true,
    }];
    const meta: Record<string, unknown> = { foldAnchors: anchors, foldAnchorOrder: [...covered] };
    if (opts.pluginAgent !== false) meta.pluginAgent = "dsh";
    session.metadata = meta;
    const drifted: CoreMessage[] = [];
    for (const m of all) {
        if (drop.includes(m.id)) continue;
        const rep = opts.replace?.[m.id];
        drifted.push(rep !== undefined ? { ...m, id: rep.id } : m);
    }
    return { session, full: all, drifted };
}

const blockOf = (session: Session) => session.state.blocks[0];
const covOf = (session: Session) => (session.metadata[METADATA_FOLD_COVERAGE] as Record<string, { p: number; r: number; t: number; e?: number; z?: number }> | undefined)?.["b0"];

test("#3849: persistent unmatched residual retires after 3 consecutive evidence-less passes and the warn loop ends", () => {
    const fx = retireFixture();
    const cap = logCapture();
    const seed = reconcileFoldCoverage(fx.session, fx.full, { mode: "repair", sessionId: "s1", log: cap.log });
    assert.equal(seed.kind, "resend");
    assert.equal(seed.retired, 0);
    assert.equal(fx.session.metadata["foldAbsentStreaks"], undefined);

    for (let pass = 1; pass <= 3; pass++) {
        const r = reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair", sessionId: "s1", log: cap.log });
        assert.equal(r.unmatched, 2, `pass ${pass}: both dropped ids stay unmatched`);
        if (pass < 3) {
            assert.equal(r.retired, 0, `pass ${pass}: below the retirement threshold`);
            assert.deepEqual(fx.session.metadata["foldAbsentStreaks"], { h5: pass, h6: pass });
        } else {
            assert.equal(r.retired, 2, "pass 3 retires both ids");
        }
    }

    assert.deepEqual(blockOf(fx.session).effectiveMessageIds, ["h2", "h3", "h4", "h7"]);
    assert.deepEqual(blockOf(fx.session).directMessageIds, ["h2", "h3", "h4", "h7"]);
    const anchors = fx.session.metadata["foldAnchors"] as Record<string, FoldAnchor>;
    assert.ok(!("h5" in anchors) && !("h6" in anchors), "retired ids lose their anchors");
    assert.ok("h2" in anchors && "h7" in anchors, "surviving coverage keeps its anchors");

    // The reported symptom was the generic warn repeating every turn; it must
    // fire on the three drift passes and then go permanently silent.
    const warns = cap.lines.filter((l) => l.level === "warn" && /missing with no anchor match/.test(l.text));
    assert.equal(warns.length, 3, "one generic warn per pre-retirement drift pass");
    const cap2 = logCapture();
    const r4 = reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair", sessionId: "s1", log: cap2.log });
    assert.equal(r4.kind, "resend");
    assert.equal(r4.retired, 0);
    assert.equal(cap2.lines.filter((l) => /missing with no anchor match/.test(l.text)).length, 0, "no warn after retirement");
    assert.equal(fx.session.metadata["foldAbsentStreaks"], undefined, "streak map cleared once no id is absent");

    // One-time retirement report + conflict trace.
    const retireLines = cap.lines.filter((l) => /retired from fold coverage/.test(l.text));
    assert.equal(retireLines.length, 1, "exactly one retirement report per event");
    assert.equal(retireLines[0].level, "info");
    const conflicts = fx.session.metadata["conflictEvents"] as { kind: string }[] | undefined;
    assert.ok(conflicts?.some((c) => c.kind === "absent-retire"), "conflict ledger records the retirement");

    // Coverage denominator converged post-retirement (the #2202 ledger accrual
    // p+r>=t is satisfiable again instead of staying wedged at 6).
    assert.deepEqual({ p: covOf(fx.session)!.p, r: covOf(fx.session)!.r, t: covOf(fx.session)!.t, e: covOf(fx.session)!.e, z: covOf(fx.session)!.z },
        { p: 4, r: 0, t: 4, e: 1, z: 0 });
});

test("#3849: presence resets the absence streak (oscillating ids never retire)", () => {
    const fx = retireFixture();
    reconcileFoldCoverage(fx.session, fx.full, { mode: "repair" });
    reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair" });
    reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair" });
    assert.deepEqual(fx.session.metadata["foldAbsentStreaks"], { h5: 2, h6: 2 });
    reconcileFoldCoverage(fx.session, fx.full, { mode: "repair" });
    assert.equal(fx.session.metadata["foldAbsentStreaks"], undefined, "presence must clear the streak map");
    reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair" });
    reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair" });
    assert.deepEqual(fx.session.metadata["foldAbsentStreaks"], { h5: 2, h6: 2 }, "streak restarts from zero after presence");
    assert.deepEqual(blockOf(fx.session).effectiveMessageIds, ["h2", "h3", "h4", "h5", "h6", "h7"], "nothing retires below the threshold");
});

test("#3849: churned-but-reanchored bytes are evidence — claimed ids never accumulate absence", () => {
    // drop must exclude h5 or the replacement never reaches the wire.
    const fx = retireFixture({ drop: ["h6"], replace: { h5: { id: "h5r" } }, realN: ["h5"] });
    reconcileFoldCoverage(fx.session, fx.full, { mode: "repair" });
    const r1 = reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair" });
    assert.ok(r1.claims >= 1, "the re-minted twin must be claimed onto churned bytes");
    assert.equal(r1.unmatched, 1, "only the truly gone id stays unmatched");
    assert.deepEqual(fx.session.metadata["foldAbsentStreaks"], { h6: 1 }, "claimed id must not accrue absence");
    reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair" });
    const r3 = reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair" });
    assert.equal(r3.retired, 1, "only the persistent id retires");
    assert.deepEqual(blockOf(fx.session).effectiveMessageIds, ["h2", "h3", "h4", "h5r", "h7"],
        "claim target stays covered in place; the gone id is spliced out");
});

test("#3849: sweep is class-agnostic — a reasoning-dominated residual retires where escalation would not fire", () => {
    const fx = retireFixture({ reasoningIds: ["h5"] });
    const cap = logCapture();
    reconcileFoldCoverage(fx.session, fx.full, { mode: "repair", log: cap.log });
    let r3: ReturnType<typeof reconcileFoldCoverage> | undefined;
    for (let i = 0; i < 3; i++) r3 = reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair", log: cap.log });
    assert.equal(r3?.retired, 2, "both classes retire identically");
    assert.deepEqual(blockOf(fx.session).effectiveMessageIds, ["h2", "h3", "h4", "h7"]);
    // The reported case shape: nonReasoningUnmatched = 1 < 10, so the global
    // destroy verdict never escalates — yet the per-id sweep still fires.
    assert.notEqual(fx.session.metadata[METADATA_DRIFT_ESCALATED], true);
    assert.ok(cap.lines.some((l) => /retired from fold coverage/.test(l.text)));
});

test("#3849: reconcile=warn makes no retirement mutation", () => {
    const fx = retireFixture();
    reconcileFoldCoverage(fx.session, fx.full, { mode: "warn" });
    for (let i = 0; i < 4; i++) {
        const r = reconcileFoldCoverage(fx.session, fx.drifted, { mode: "warn" });
        assert.equal(r.retired, 0);
    }
    assert.deepEqual(blockOf(fx.session).effectiveMessageIds, ["h2", "h3", "h4", "h5", "h6", "h7"], "warn mode is diagnostic-only");
    assert.equal(fx.session.metadata["foldAbsentStreaks"], undefined);
});

test("#3849: steady-state clean passes leave no streak state (zero-work contract)", () => {
    const fx = retireFixture();
    const before = JSON.stringify(fx.session.state.blocks);
    for (let i = 0; i < 3; i++) {
        const r = reconcileFoldCoverage(fx.session, fx.full, { mode: "repair" });
        assert.equal(r.kind, "resend");
        assert.equal(r.retired, 0);
    }
    assert.equal(fx.session.metadata["foldAbsentStreaks"], undefined, "clean passes delete the key, not just skip it");
    assert.equal(JSON.stringify(fx.session.state.blocks), before, "no block mutation in steady state");
    assert.ok(!(fx.session.metadata["conflictEvents"] as unknown[] | undefined)?.length, "no conflict noise in steady state");
});

test("#3849: proxy lane retires too (both lanes) and coexists safely with the #2695 reap gate", () => {
    const fx = retireFixture({ pluginAgent: false });
    reconcileFoldCoverage(fx.session, fx.full, { mode: "repair" });
    let r3: ReturnType<typeof reconcileFoldCoverage> | undefined;
    for (let i = 0; i < 3; i++) r3 = reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair" });
    assert.equal(r3?.retired, 2);
    assert.equal(fx.session.state.blocks.length, 1, "majority-present block must not be reaped while shrinking");
    assert.deepEqual(blockOf(fx.session).effectiveMessageIds, ["h2", "h3", "h4", "h7"]);
    assert.equal(covOf(fx.session)!.z, 0, "no zombie streak accrues on a shrinking-but-majority-present block");
});

test("#3849: only the persistently absent subset retires; live siblings keep coverage and order", () => {
    const fx = retireFixture({ drop: ["h5"] });
    reconcileFoldCoverage(fx.session, fx.full, { mode: "repair" });
    let r3: ReturnType<typeof reconcileFoldCoverage> | undefined;
    for (let i = 0; i < 3; i++) r3 = reconcileFoldCoverage(fx.session, fx.drifted, { mode: "repair" });
    assert.equal(r3?.retired, 1);
    assert.deepEqual(blockOf(fx.session).effectiveMessageIds, ["h2", "h3", "h4", "h6", "h7"], "order preserved around the splice");
    assert.deepEqual({ p: covOf(fx.session)!.p, r: covOf(fx.session)!.r, t: covOf(fx.session)!.t, e: covOf(fx.session)!.e, z: covOf(fx.session)!.z },
        { p: 5, r: 0, t: 5, e: 1, z: 0 });
});
