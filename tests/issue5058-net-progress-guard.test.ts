import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import type { Session } from "../src/session.ts";
import { SELF_HEAL_SUPPRESS_CAP_MS, nudgeSuppressed } from "../src/session-self-heal.ts";
import {
    NET_PROGRESS_MARGIN_TOKENS,
    NET_PROGRESS_STRIKE_LIMIT,
    evaluateNetProgressRound,
    netProgressNudgeBlocked,
    netProgressState,
    nudgeInjectionBlocked,
    recordNetProgressBaseline,
} from "../src/net-progress-guard.ts";

// #5058: companion-session compress spiral — folds keep committing while the
// session keeps growing (each compress action costs about as much as its fold
// saves). D1 (#2155) needs reductions to STOP landing; the #2748 gate judges
// one commit in isolation; this guard measures the cross-round trajectory of
// the resent payload: two consecutive rounds that fail to drop below
// pre-fold-level-minus-margin latch a nudge suppression until a round
// demonstrably reduces the context or the #3004 wall cap expires.

const noop = () => {};

// The guard is plugin-lane only: fakes carry a plugin binding by default so
// the state-machine rows below exercise the guarded path; pass null for
// proxy-mode (unbound) sessions — a default argument kicks in on undefined,
// so null is the only sentinel that survives the signature.
function mkSession(pluginAgent: string | null = "dsh"): Session {
    return {
        id: "s1",
        metadata: pluginAgent === null ? {} : { pluginAgent },
        state: { nextBlockId: 1 },
        lastCompress: undefined,
    } as unknown as Session;
}

// ---- unit: baseline + strike state machine ----------------------------------

test("unit: arms only after exactly two consecutive non-progress rounds and warns once", () => {
    const s = mkSession();
    recordNetProgressBaseline(s, 600_000, 120_000);
    const logs: string[] = [];
    const log = (level: string, msg: string) => logs.push(`${level}:${msg}`);

    // Round 1: still above the bar — one strike, not armed yet.
    evaluateNetProgressRound(s, 610_000, log);
    assert.equal(netProgressNudgeBlocked(s), false, "one strike must not arm");
    assert.equal(netProgressState(s)?.strikes, 1);

    // Round 2: still above — arms with a warn carrying the numbers.
    evaluateNetProgressRound(s, 640_000, log);
    assert.equal(netProgressNudgeBlocked(s), true, "second consecutive non-progress round arms");
    const st = netProgressState(s)!;
    assert.equal(st.baseline, 600_000);
    assert.equal(st.expectedFloor, 120_000);
    assert.equal(st.strikes, NET_PROGRESS_STRIKE_LIMIT);
    assert.ok(typeof st.armedAt === "number");
    const warns = logs.filter((l) => l.startsWith("warn:"));
    assert.equal(warns.length, 1, "exactly one warn at arm");
    assert.match(warns[0], /\[net-progress\]/);
    assert.match(warns[0], /~640000/);
    assert.match(warns[0], /~600000/);
});

test("unit: a progress round resets strikes and lifts an active latch", () => {
    const s = mkSession();
    recordNetProgressBaseline(s, 600_000, 120_000);
    const logs: string[] = [];
    const log = (level: string, msg: string) => logs.push(`${level}:${msg}`);
    evaluateNetProgressRound(s, 610_000, noop);
    evaluateNetProgressRound(s, 620_000, noop);
    assert.equal(netProgressNudgeBlocked(s), true, "armed before the reducing round");

    // Below pre-fold level by more than the margin: compression is working again.
    evaluateNetProgressRound(s, 600_000 - NET_PROGRESS_MARGIN_TOKENS - 1, log);
    assert.equal(netProgressNudgeBlocked(s), false, "reducing round lifts the latch early");
    assert.equal(netProgressState(s)?.strikes, 0);
    assert.equal(netProgressState(s)?.armedAt, undefined);
    assert.ok(logs.some((l) => l.startsWith("info:") && /\[net-progress\]/.test(l)), "recovery is logged");
});

test("unit: boundary — observed exactly at baseline-minus-margin counts as non-progress", () => {
    const s = mkSession();
    recordNetProgressBaseline(s, 600_000, 120_000);
    evaluateNetProgressRound(s, 600_000 - NET_PROGRESS_MARGIN_TOKENS, noop);
    assert.equal(netProgressState(s)?.strikes, 1, "the margin must be exceeded strictly");
});

test("unit: wall cap — predicate expires inline and the next evaluate clears the latch", () => {
    const s = mkSession();
    recordNetProgressBaseline(s, 600_000, 120_000);
    evaluateNetProgressRound(s, 900_000, noop);
    evaluateNetProgressRound(s, 900_000, noop);
    assert.equal(netProgressNudgeBlocked(s), true);

    // Time-travel past the #3004 cap without any further round.
    const st = netProgressState(s)!;
    st.armedAt = Date.now() - SELF_HEAL_SUPPRESS_CAP_MS - 1;
    assert.equal(netProgressNudgeBlocked(s), false, "expired latch blocks nothing");

    const logs: string[] = [];
    evaluateNetProgressRound(s, 900_000, (level: string, msg: string) => logs.push(`${level}:${msg}`));
    assert.equal(netProgressState(s), undefined, "expiry deletes the whole evidence window");
    assert.ok(logs.some((l) => l.startsWith("info:") && /expired/.test(l)), "expiry is logged");
});

test("unit: while armed, extra non-progress rounds neither re-warn nor grow strikes", () => {
    const s = mkSession();
    recordNetProgressBaseline(s, 600_000, 120_000);
    const logs: string[] = [];
    const log = (level: string, msg: string) => logs.push(`${level}:${msg}`);
    evaluateNetProgressRound(s, 900_000, log);
    evaluateNetProgressRound(s, 900_000, log);
    evaluateNetProgressRound(s, 950_000, log);
    assert.equal(netProgressState(s)?.strikes, NET_PROGRESS_STRIKE_LIMIT);
    assert.equal(logs.filter((l) => l.startsWith("warn:")).length, 1, "no warn spam while latched");
});

test("unit: a new fold commit opens a fresh window and resets strikes", () => {
    const s = mkSession();
    recordNetProgressBaseline(s, 600_000, 120_000);
    evaluateNetProgressRound(s, 900_000, noop);
    assert.equal(netProgressState(s)?.strikes, 1);

    recordNetProgressBaseline(s, 950_000, 200_000);
    const st = netProgressState(s)!;
    assert.equal(st.baseline, 950_000);
    assert.equal(st.strikes, 0);
    assert.equal(st.armedAt, undefined, "a new fold also lifts an armed latch");
});

test("unit: degenerate inputs are no-ops", () => {
    const s = mkSession();
    recordNetProgressBaseline(s, NaN, 100);
    recordNetProgressBaseline(s, 0, 100);
    assert.equal(netProgressState(s), undefined, "invalid baselines are not recorded");

    recordNetProgressBaseline(s, 600_000, 120_000);
    evaluateNetProgressRound(s, NaN, noop);
    evaluateNetProgressRound(s, 0, noop);
    evaluateNetProgressRound(s, -5, noop);
    assert.equal(netProgressState(s)?.strikes, 0, "non-positive observations count for nothing");

    // No baseline at all: the guard stays silent.
    const bare = mkSession();
    evaluateNetProgressRound(bare, 900_000, noop);
    assert.equal(netProgressState(bare), undefined);
});

test("unit: the guard never touches persisted session state (storage goldens stay clean)", () => {
    // persist serializes session.metadata into the state file; writing the
    // volatile latch there drifted every storage golden on each fold commit
    // (#4790 precedent). Exercise every mutation path, then pin the document.
    const s = mkSession();
    recordNetProgressBaseline(s, 600_000, 120_000);
    evaluateNetProgressRound(s, 900_000, noop);
    evaluateNetProgressRound(s, 900_000, noop);
    assert.equal(netProgressNudgeBlocked(s), true, "armed before the persistence pin");
    // expiry path
    netProgressState(s)!.armedAt = Date.now() - SELF_HEAL_SUPPRESS_CAP_MS - 1;
    evaluateNetProgressRound(s, 900_000, noop);
    // re-arm + recovery path
    recordNetProgressBaseline(s, 600_000, 120_000);
    evaluateNetProgressRound(s, 900_000, noop);
    evaluateNetProgressRound(s, 900_000, noop);
    evaluateNetProgressRound(s, 600_000 - NET_PROGRESS_MARGIN_TOKENS - 1, noop);
    assert.deepEqual(Object.keys(s.metadata), ["pluginAgent"], "session.metadata must stay untouched apart from the pre-existing lane binding");
});

test("unit: proxy-mode sessions (no plugin binding) are out of scope and never arm", () => {
    const s = mkSession(null);
    recordNetProgressBaseline(s, 600_000, 120_000);
    assert.equal(netProgressState(s), undefined, "proxy sessions get no evidence window");
    // A mature proxy session's raw resend structurally never drops below the
    // bar (the client keeps its full local history) — the guard must stay
    // inert there so the flat-50K cadence keeps running (KDD #8).
    evaluateNetProgressRound(s, 900_000, noop);
    evaluateNetProgressRound(s, 900_000, noop);
    assert.equal(netProgressState(s), undefined, "rounds stay inert without a window");
    assert.equal(nudgeInjectionBlocked(s), false, "proxy cadence stays untouched");
});

test("unit: a healthy long session never arms", () => {
    const s = mkSession();
    recordNetProgressBaseline(s, 600_000, 150_000);
    // Folds keep buying back real room; growth between folds stays under the bar.
    for (let i = 0; i < 10; i++) {
        evaluateNetProgressRound(s, 500_000 + i * 1_000, noop);
        recordNetProgressBaseline(s, 500_000 + i * 1_000, 150_000 + i * 1_000);
    }
    assert.equal(netProgressNudgeBlocked(s), false);
    assert.equal(netProgressState(s)?.strikes, 0);
});

// ---- unit: the shared suppression expression --------------------------------

test("unit: nudgeInjectionBlocked ORs the #2155 and #5058 latches", () => {
    const none = mkSession();
    assert.equal(nudgeInjectionBlocked(none), false);

    const selfHealOnly = mkSession();
    selfHealOnly.metadata.selfHeal = { detected: "nudge-idle", action: "suppress-nudge", since: Date.now() };
    assert.equal(nudgeSuppressed(selfHealOnly), true);
    assert.equal(nudgeInjectionBlocked(selfHealOnly), true, "#2155 latch alone blocks");

    const netOnly = mkSession();
    recordNetProgressBaseline(netOnly, 600_000, 120_000);
    evaluateNetProgressRound(netOnly, 900_000, noop);
    evaluateNetProgressRound(netOnly, 900_000, noop);
    assert.equal(nudgeSuppressed(netOnly), false);
    assert.equal(nudgeInjectionBlocked(netOnly), true, "#5058 latch alone blocks");

    const both = mkSession();
    both.metadata.selfHeal = { detected: "nudge-idle", action: "suppress-nudge", since: Date.now() };
    recordNetProgressBaseline(both, 600_000, 120_000);
    evaluateNetProgressRound(both, 900_000, noop);
    evaluateNetProgressRound(both, 900_000, noop);
    assert.equal(nudgeInjectionBlocked(both), true);
});
