// #3198-C: compress.reasoning.flush — the #651 reasoning drop's
// LEAVE-THE-WIRE timing. Default "fold" freezes the applied drop set between
// folds: the wire stays byte-stable across round closes (no fresh prefix-cache
// seam per round), and the reclaim rides the fold's own re-billed region.
// "close" keeps the legacy per-round-close timing (opt-in: every round close
// rewrites mid-history bytes and pays a cache miss — fine where misses are
// cheap, e.g. local endpoints). The pending-mass cap (REASONING_FLUSH_CAP)
// bounds sessions that never fold: one attributed flush per crossing. The
// applied set is memory-only; a restart brings reasoning back with the
// already-attributed restart re-bill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReasoningDrop, settleReasoningDropPlan } from "../src/server.ts";
import { dropCompressReasoningIds, REASONING_FLUSH_CAP } from "../src/reasoning-drop.ts";
import type { Session } from "../src/session.ts";
import type { BiliMessage } from "acp-kernel/wire";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return { id: `flush-${seq}`, metadata: {}, stats: {}, state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} } } as unknown as Session;
}

const logs: string[] = [];
const capLog = (level: string, msg: string): void => { if (level === "info") logs.push(msg); };

const reason = (id: string, n = 3000): BiliMessage => ({ id, role: "assistant", contentType: "reasoning", text: "x".repeat(n) }) as BiliMessage;
const call = (id: string, cid: string): BiliMessage => ({ id, role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: cid }) as BiliMessage;
const result = (id: string, cid: string): BiliMessage => ({ id, role: "user", contentType: "tool-result", toolCallId: cid, text: "ok" }) as BiliMessage;
const user = (id: string): BiliMessage => ({ id, role: "user", contentType: "text", text: "next" }) as BiliMessage;

/** A closed compress round: reasoning run → compress call → result → a later
 *  message (round demonstrably moved on, #348 twin). */
function closedRound(round: string): BiliMessage[] {
    return [reason(`${round}-r1`, 6000), reason(`${round}-r2`, 6000), call(`${round}-c`, `tc-${round}`), result(`${round}-res`, `tc-${round}`), user(`${round}-u`)];
}

const blockIds = (n: number): Set<string> => new Set(Array.from({ length: n }, (_, i) => `b${i}`));
const blocksOf = (ids: string[]): { blockId: string }[] => ids.map((blockId) => ({ blockId }));

function settle(s: Session, candidate: Set<string>, msgs: BiliMessage[], reasoning: { flush?: "fold" | "close" } | undefined, before: Set<string>, after: string[]): Set<string> {
    return settleReasoningDropPlan(s, candidate, msgs, reasoning, before, blocksOf(after), capLog, s.id);
}

test("flush=fold (default): round close does NOT change the wire; the fold flushes", () => {
    const s = makeSession();
    const msgs = closedRound("a");
    const candidate = dropCompressReasoningIds(msgs, undefined);
    assert.equal(candidate.size, 2, "both reasoning messages of the closed round are candidates");
    // Request after the round closes, no fold in it: applied stays empty.
    let plan = settle(s, candidate, msgs, undefined, blockIds(0), []);
    assert.equal(plan.size, 0, "frozen: reasoning stays on the wire");
    assert.equal(applyReasoningDrop(msgs, plan, capLog, s.id), msgs, "wire byte-stable — no mid-history rewrite");
    // A second round closes, still no fold: still frozen.
    const msgs2 = [...msgs, ...closedRound("b")];
    const candidate2 = dropCompressReasoningIds(msgs2, undefined);
    assert.equal(candidate2.size, 4);
    plan = settle(s, candidate2, msgs2, undefined, blockIds(0), []);
    assert.equal(plan.size, 0);
    // The fold lands (new block): everything flushes in the SAME request.
    plan = settle(s, candidate2, msgs2, undefined, blockIds(0), ["b0"]);
    assert.equal(plan.size, 4, "fold flushes all pending closed rounds");
    assert.equal(applyReasoningDrop(msgs2, plan, capLog, s.id).length, msgs2.length - 4);
});

test("flush=close (legacy opt-in): applied follows every candidate", () => {
    const s = makeSession();
    const msgs = closedRound("a");
    const candidate = dropCompressReasoningIds(msgs, { flush: "close" });
    const plan = settle(s, candidate, msgs, { flush: "close" }, blockIds(0), []);
    assert.equal(plan.size, 2, "legacy timing drops at the first request after round close");
    assert.equal(applyReasoningDrop(msgs, plan, capLog, s.id).length, msgs.length - 2);
});

test("pending-mass cap: a never-folding session flushes once past REASONING_FLUSH_CAP", () => {
    const s = makeSession();
    const msgs = [...closedRound("a"), ...closedRound("b"), ...closedRound("c"), ...closedRound("d"), ...closedRound("e"), ...closedRound("f")];
    const candidate = dropCompressReasoningIds(msgs, undefined);
    const mass = msgs.filter((m) => candidate.has(m.id)).reduce((n, m) => n + (m.text ?? "").length, 0);
    assert.ok(mass > REASONING_FLUSH_CAP, `fixture must exceed the cap (mass=${mass}, cap=${REASONING_FLUSH_CAP})`);
    const plan = settle(s, candidate, msgs, undefined, blockIds(0), []);
    assert.equal(plan.size, candidate.size, "cap flush applies the full candidate set");
    assert.ok(logs.some((l) => l.includes("flushing outside a fold")), "one info line explains the out-of-fold flush");
});

test("gate opens (candidate empty): applied resets, reasoning returns to the wire", () => {
    const s = makeSession();
    const msgs = closedRound("a");
    // A fold earlier flushed round a.
    settle(s, dropCompressReasoningIds(msgs, undefined), msgs, undefined, blockIds(0), ["b0"]);
    assert.ok((s.transient?.reasoningDropped?.size ?? 0) > 0);
    // The strict-echo / signed-thinking gate arms: candidate empty this request.
    const plan = settle(s, new Set(), msgs, undefined, blockIds(1), []);
    assert.equal(plan.size, 0, "presence-based gate per request: nothing applies");
    assert.equal(s.transient?.reasoningDropped?.size, 0, "applied set resets with the gate");
});

test("restart semantics: a fresh process starts with an empty applied set", () => {
    const s1 = makeSession();
    const msgs = closedRound("a");
    const candidate = dropCompressReasoningIds(msgs, undefined);
    settle(s1, candidate, msgs, undefined, blockIds(0), ["b0"]);
    // Restart = transient gone; the same inbound view keeps candidate frozen
    // only after the next fold — reasoning reappears until then (the restart
    // re-bill is already attributed by the ledger's restart arm).
    const s2 = makeSession();
    const plan = settle(s2, candidate, msgs, undefined, blockIds(1), []);
    assert.equal(plan.size, 0);
    const plan2 = settle(s2, candidate, msgs, undefined, blockIds(1), ["b1"]);
    assert.equal(plan2.size, candidate.size);
});

test("invalid flush values fall back to fold", () => {
    const s = makeSession();
    const msgs = closedRound("a");
    const candidate = dropCompressReasoningIds(msgs, { flush: "nonsense" as unknown as "fold" });
    const plan = settle(s, candidate, msgs, { flush: "nonsense" as unknown as "fold" }, blockIds(0), []);
    assert.equal(plan.size, 0, "unknown value behaves as the default fold policy");
});
