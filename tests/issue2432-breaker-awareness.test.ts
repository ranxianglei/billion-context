// #2432: the compress circuit breaker (#2146) was invisible outside its own
// receipts while still steering every other surface against it — acp_status
// kept advertising compressible ranges the model then failed on (climbing the
// counter), and every turn's nudge kept inviting the same failing calls. The
// armed state now reaches those surfaces (acp_status section + counter,
// per-turn nudge suppression), and the armed receipt branches on the failure
// CAUSE: substrate-destruction gets the single-recovery-step wording (one
// acp_status + live-range re-anchor; success disarms) instead of the blanket
// "do not poll acp_status" order that locked the model out of the only exit.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, compressBreakerArmed, compressBreakerDetail, compressLastFailureCause, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { METADATA_DRIFT_ESCALATED } from "../src/fold-reconcile.ts";
import { conflictEventsOf, formatConflictSection, recordConflict } from "../src/conflict-watch.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue2432-${randomUUID()}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
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

function makeCtx(messages: CoreMessage[], config?: Config, logs?: string[]): RewriteCtx & { session: Session; config: Config } {
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: config ?? defaultConfig(200000), messages, session, log: logs ? (m) => logs.push(m) : () => {} };
}

function compressArgs(startId: string, endId: string) {
    return JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] }));
}

test("#2432: armed receipts branch on cause — substrate-destruction names the single recovery step", () => {
    // Ten mapped messages; the "resent history" then drops the first seven
    // (an out-of-band rewrite), so their refs are known-but-dangling — the
    // kernel's "cannot be anchored" shape.
    const all = Array.from({ length: 10 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(400)));
    const ctx = makeCtx(all);
    ctx.messages = all.slice(7);
    ctx.session.metadata[METADATA_DRIFT_ESCALATED] = true;

    const f1 = applyRanges(parseCompressInput(compressArgs("m00001", "m00003")), ctx).text;
    assert.ok(f1.startsWith("[Compression FAILED:"), `failure 1 (got: ${f1.slice(0, 120)})`);
    assert.match(f1, /cannot be anchored/, "kernel reports the unanchored range");
    assert.match(f1, /\[cause: substrate-destruction/, "escalated drift sharpens the cause");
    assert.ok(!f1.includes("CIRCUIT BREAKER"), "failure 1 carries no breaker");

    const f2 = applyRanges(parseCompressInput(compressArgs("m00004", "m00006")), ctx).text;
    assert.ok(!f2.includes("CIRCUIT BREAKER"), "failure 2 carries no breaker");

    const f3 = applyRanges(parseCompressInput(compressArgs("m00001", "m00007")), ctx).text;
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "third failure arms the breaker");
    assert.match(f3, /fold substrate was destroyed/, "substrate cause named in the armed paragraph");
    assert.match(f3, /exactly ONE recovery step/, "recovery step stated");
    assert.match(f3, /run acp_status once/, "the single permitted action is named");
    assert.doesNotMatch(f3, /do not poll acp_status/, "the blanket ban is WITHHELD for substrate-destruction (it forbids the only exit)");
});

test("#2432: non-substrate causes keep the verbatim loop-noise paragraph (owner decision 2026-10-07)", () => {
    // Same dangling shape but WITHOUT the escalated drift flag: the cause is
    // content-changed, and the armed paragraph must stay byte-identical to the
    // pre-#2432 wording (its measured behavior is load-bearing for #2146).
    const all = Array.from({ length: 10 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(400)));
    const ctx = makeCtx(all);
    ctx.messages = all.slice(7);

    applyRanges(parseCompressInput(compressArgs("m00001", "m00003")), ctx);
    applyRanges(parseCompressInput(compressArgs("m00004", "m00006")), ctx);
    const f3 = applyRanges(parseCompressInput(compressArgs("m00001", "m00007")), ctx).text;
    assert.match(f3, /COMPRESS CIRCUIT BREAKER: 3 consecutive/, "arms at three");
    assert.match(f3, /do not try other ranges, do not re-issue any previous range, and do not poll acp_status\./, "verbatim loop-noise sentence intact");
    assert.match(f3, /compression happens again only when there is genuinely new content to fold\.\]/, "verbatim closing intact");
    assert.doesNotMatch(f3, /exactly ONE recovery step/, "no substrate wording for a non-substrate cause");
});

test("#2432: compressBreakerDetail/Armed mirror the receipt's arming conditions", () => {
    const s = makeSession();
    assert.equal(compressBreakerArmed(s), false, "empty session disarmed");
    assert.equal(compressBreakerDetail(s), undefined);

    s.metadata["compressFailStreak"] = { n: 2, lastAt: Date.now() };
    assert.equal(compressBreakerArmed(s), false, "below threshold disarmed");

    s.metadata["compressFailStreak"] = { n: 3, lastAt: Date.now() - 11 * 60 * 1000 };
    assert.equal(compressBreakerArmed(s), false, "decayed streak reads disarmed even before the next failure rewrites the metadata");

    s.metadata["compressFailStreak"] = { n: 4, lastAt: Date.now() - 4 * 60 * 1000 };
    const d = compressBreakerDetail(s);
    assert.deepEqual(d, { n: 4, threshold: 3, decayMinutes: 10 }, "armed detail carries the visible counter");
    assert.equal(compressBreakerArmed(s), true);
});

test("#2432/#2451: acp_status shows the armed counter and keeps reporting the live ranges table", () => {
    // Six big messages: with no breaker the surface advertises ranges.
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const session = makeSession();
    session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    const ctx = { core: createCore(), config: defaultConfig(200000), messages: msgs, session };

    const healthy = handleAcpStatus({}, ctx);
    assert.ok(healthy.text?.includes("Compressible ranges ("), `healthy surface advertises ranges (got: ${healthy.text?.slice(-300)})`);
    assert.ok(!healthy.text?.includes("COMPRESS CIRCUIT BREAKER"), "healthy surface has no breaker section");

    session.metadata["compressFailStreak"] = { n: 4, lastAt: Date.now() };
    const armed = handleAcpStatus({}, ctx);
    assert.match(armed.text, /COMPRESS CIRCUIT BREAKER: ARMED — consecutiveFailures: 4 \/ 3\./, "armed section with the visible counter");
    assert.match(armed.text, /Disarms on one successful compress or 10 min/, "disarm condition stated");
    assert.ok(armed.text.includes("Compressible ranges ("), "armed surface still reports the live table — it is re-derived from the current view, and hiding it contradicts the recovery receipts that point here");
    assert.match(armed.text, /do not attempt to compress now; continue the task/, "unknown-cause armed note mirrors the receipt's STOP order instead of inventing a second command");
    assert.doesNotMatch(armed.text, /SUPPRESSED/, "no false claim that the list is hidden");
});

test("#2432: failure cause persists on the streak and is readable before the breaker arms", () => {
    const all = Array.from({ length: 10 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(400)));
    const ctx = makeCtx(all);
    ctx.messages = all.slice(7);
    ctx.session.metadata[METADATA_DRIFT_ESCALATED] = true;

    applyRanges(parseCompressInput(compressArgs("m00001", "m00003")), ctx);
    assert.equal(compressBreakerArmed(ctx.session), false, "one failure does not arm");
    assert.ok(compressLastFailureCause(ctx.session)?.startsWith("substrate-destruction"), "cause readable at n=1");

    // A later unknown-cause failure (parse failure — no kernel error text to
    // attribute) must NOT erase the last known verdict.
    applyRanges(parseCompressInput({ content: [] }), ctx);
    assert.ok(compressLastFailureCause(ctx.session)?.startsWith("substrate-destruction"), "unknown-cause failure keeps the prior verdict");

    const st = ctx.session.metadata["compressFailStreak"];
    assert.ok(st && typeof st === "object");
    (st as { lastAt: number }).lastAt = Date.now() - 11 * 60 * 1000;
    assert.equal(compressLastFailureCause(ctx.session), undefined, "decayed streak lapses the verdict");
});

test("#2432/#2451: substrate/stale-ref verdicts annotate honestly BEFORE arming; the table stays up", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const session = makeSession();
    session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    const ctx = { core: createCore(), config: defaultConfig(200000), messages: msgs, session };
    assert.ok(handleAcpStatus({}, ctx).text?.includes("Compressible ranges ("), "healthy surface advertises");

    session.metadata["compressFailStreak"] = { n: 1, lastAt: Date.now(), cause: "substrate-destruction — host-native compaction or bulk client-side history rewrite landed outside bili's knowledge (#1729/#2193); structural, report it" };
    const sub = handleAcpStatus({}, ctx).text ?? "";
    assert.match(sub, /FOLD SUBSTRATE INVALID/, "explicit invalid-substrate section at n=1");
    assert.match(sub, /start a fresh conversation/, "recovery path stated");
    assert.ok(sub.includes("Compressible ranges ("), "ranges stay reported at n=1 — they are re-derived from the current view, so they anchor");
    assert.doesNotMatch(sub, /COMPRESS CIRCUIT BREAKER: ARMED/, "no armed section below threshold");

    session.metadata["compressFailStreak"] = { n: 1, lastAt: Date.now(), cause: "stale-ref — the refs belong to another session generation (or are typos)" };
    const stale = handleAcpStatus({}, ctx).text ?? "";
    assert.match(stale, /FOLD BASE GENERATION MISMATCH/, "stale-ref gets its own section");
    assert.ok(stale.includes("Compressible ranges ("), "ranges stay reported for stale-ref too — the failed refs were the model's stale input, not this table");

    session.metadata["compressFailStreak"] = { n: 1, lastAt: Date.now(), cause: "covered-by-block — nothing new to fold in that window" };
    assert.ok(handleAcpStatus({}, ctx).text?.includes("Compressible ranges ("), "covered-by-block does not over-suppress");

    session.metadata["compressFailStreak"] = { n: 1, lastAt: Date.now() - 11 * 60 * 1000, cause: "substrate-destruction — structural" };
    assert.ok(handleAcpStatus({}, ctx).text?.includes("Compressible ranges ("), "decayed verdict lapses its annotation");
});

test("#2451 review: armed + substrate-destruction reports live ranges — the receipt's recovery path is reachable", () => {
    // The armed receipt (#2432) orders: "run acp_status once, then compress
    // ONLY a range it currently reports as compressible — one success clears
    // this breaker." Before this fix acp_status suppressed the list whenever
    // armed, so the promised recovery was unreachable and the output carried
    // two contradictory orders ("do not attempt to compress now" /
    // "start a fresh conversation") — the #2360 two-orders shape.
    const msgs = Array.from({ length: 6 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "y".repeat(8000)));
    const session = makeSession();
    session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
    const ctx = { core: createCore(), config: defaultConfig(200000), messages: msgs, session };

    session.metadata["compressFailStreak"] = { n: 4, lastAt: Date.now(), cause: "substrate-destruction — host-native compaction or bulk client-side history rewrite landed outside bili's knowledge (#1729/#2193); structural, report it" };
    const armed = handleAcpStatus({}, ctx).text ?? "";
    assert.ok(armed.includes("Compressible ranges ("), "armed substrate-destruction still reports live ranges (the receipt's single recovery step)");
    assert.match(armed, /COMPRESS CIRCUIT BREAKER: ARMED — consecutiveFailures: 4 \/ 3\./, "armed section with the visible counter");
    assert.match(armed, /re-derived from the CURRENT resent view/, "tailored recovery line replaces the blanket suppression order");
    assert.match(armed, /one success clears this breaker/, "disarm-by-success is restated on the status surface");
    assert.doesNotMatch(armed, /SUPPRESSED while the breaker is armed/, "no blanket suppression on the receipt's own recovery path");
    assert.doesNotMatch(armed, /Do not attempt to compress now/, "no contradictory compress ban");
    assert.doesNotMatch(armed, /start a fresh conversation/, "no second, contradictory recovery order (#2360 shape)");

    // Control: armed + stale-ref ALSO reports the live table — the failed
    // refs were the model's stale input, not this table (the table is
    // re-derived from the current view), so honest reporting is safe and the
    // armed note mirrors the receipt's STOP order for non-substrate causes.
    session.metadata["compressFailStreak"] = { n: 4, lastAt: Date.now(), cause: "stale-ref — the refs belong to another session generation (or are typos)" };
    const stale = handleAcpStatus({}, ctx).text ?? "";
    assert.ok(stale.includes("Compressible ranges ("), "stale-ref armed still reports the live table");
    assert.doesNotMatch(stale, /SUPPRESSED/, "no suppression claim anywhere");
    assert.match(stale, /do not attempt to compress now; continue the task/, "receipt STOP order mirrored for non-substrate causes");
    assert.match(stale, /FOLD BASE GENERATION MISMATCH/, "stale-ref section still renders while armed");
});

test("#2432: conflict footer stops presenting host-native landings as a second compressor", () => {
    const s = makeSession();
    recordConflict(s, "unannounced-rewrite", "359/1611 incoming message(s) carry pre-turn refs of 2196 known");
    recordConflict(s, "native-compaction", "dsh native compaction: 12/14 covered id(s) replaced by the compacted history; ACP state rebased (#2432)");
    const mixed = formatConflictSection(conflictEventsOf(s)).join("\n");
    // #2912: the host-native landing is handled stock (rebased onto), so the footer no longer
    // names it as the driver; the lone observed rewrite carries the (unconfirmed) diagnosis.
    assert.match(mixed, /UNCONFIRMED signal/, "the observed rewrite carries the diagnosis");
    assert.doesNotMatch(mixed, /Keep exactly ONE compressor/, "no second-plugin hunt command when nothing foreign was confirmed");
    assert.doesNotMatch(mixed, /Two compressors on one conversation/, "handled native landing must not re-arm the double-compression header");

    const s2 = makeSession();
    recordConflict(s2, "third-party-plugin", "some-other-compressor plugin detected [confirmed]");
    assert.match(formatConflictSection(conflictEventsOf(s2)).join("\n"), /Keep exactly ONE compressor/, "foreign confirmed ledger keeps the one-compressor command");

    const s3 = makeSession();
    recordConflict(s3, "third-party-plugin", "maybe-a-compressor [suspected]");
    recordConflict(s3, "native-compaction", "dsh native compaction: 3/4 covered id(s) replaced; ACP state rebased (#2432)");
    const suspectedMixed = formatConflictSection(conflictEventsOf(s3)).join("\n");
    // #2912: with the recovered native landing out of the confirmed tier, the name-only
    // [suspected] plugin governs the (verify-first) tier, not the host-native framing.
    assert.match(suspectedMixed, /Every event above is \[suspected\]/, "name-only tier governs when nothing is confirmed");
    assert.doesNotMatch(suspectedMixed, /Keep exactly ONE compressor/, "suspected-only foreign names do not keep the hunt command either (#1736 tiering)");
});
