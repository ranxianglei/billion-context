import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    reconcileFoldCoverage,
    resetNormalizedIdentityWork,
    normalizedIdentityWorkCount,
    resetPositionalFingerprintWork,
    positionalFingerprintWorkCount,
    METADATA_EXPECTED_REBASE,
} from "../src/fold-reconcile.ts";
import { dshPastedImagePath, dshTimeContextPath, dshToolJobNoticePath, oneShotCarrierPaths, dshCarrierRawMarkers } from "../src/durable-message-guards.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

// #5142 — the perf pin #1921's acceptance list promised but #1924 never
// delivered. Legitimate host behavior (one-shot context carriers that appear
// only on their own turn, image/offload retroactive rewrites of covered
// messages) used to be booked as permanent drift: the missing-id set grew
// monotonically with session age and EVERY turn paid a full O(full-history)
// multi-channel alignment. After the fix those ids take deterministic
// expected-rebase channels out of drift accounting, so:
//   - per-turn reconcile work stays bounded vs an identical no-carrier
//     control as carriers retire (T1),
//   - the verdict names expected rebase, not drift/truncation (T1/T2),
//   - genuine truncation/edits STILL alarm — bidirectional pins (#3617) (T3),
//   - upgrade residue backfills from stored bytes, once (T4).
const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";

let seq = 0;
function makeMsg(role: CoreMessage["role"], text: string): CoreMessage {
    seq += 1;
    return { id: `m${seq}`, role, contentType: "text", text } as CoreMessage;
}

function baseHistory(n: number): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let i = 0; i < n; i++) {
        out.push(makeMsg(i % 2 === 0 ? "user" : "assistant", `${i}: ${FILLER.repeat(2)}`));
    }
    return out;
}

interface Harness {
    session: Session;
    block: { active: boolean; effectiveMessageIds: string[] };
    logs: Array<[string, string]>;
    opts: { mode: "repair"; sessionId: string; log: (lvl: string, m: string) => void };
}

function harness(lane?: string): Harness {
    const block: { active: boolean; effectiveMessageIds: string[] } = { active: true, effectiveMessageIds: [] };
    const session = { state: { blocks: [block] }, metadata: lane === undefined ? {} : { pluginAgent: lane } } as unknown as Session;
    const logs: Array<[string, string]> = [];
    const opts = { mode: "repair" as const, sessionId: "t5142", log: (lvl: string, m: string) => { logs.push([lvl, m]); } };
    return { session, block, logs, opts };
}

/** Normalized-identity + positional-fingerprint work of one reconcile pass. */
function measurePass(fn: () => void): number {
    resetNormalizedIdentityWork();
    resetPositionalFingerprintWork();
    fn();
    return normalizedIdentityWorkCount() + positionalFingerprintWorkCount();
}

function recordOf(session: Session): Record<string, string> | undefined {
    return (session.metadata as Record<string, unknown>)[METADATA_EXPECTED_REBASE] as Record<string, string> | undefined;
}

// All three evidence-backed dsh one-shot families (#5142 reporter samples,
// personal paths redacted to synthetic values) rotated across turns so the
// perf pin exercises every C1 channel.
function oneShotCarrierText(t: number): string {
    switch (t % 3) {
        case 0:
            return `background job bash-${(0xabc0de00 + t).toString(16)} (bash: "echo done ${t}") finished [status: completed, exit code: 0]. Read its output with job_output.`;
        case 1:
            return `\x3cpath\x3epaste_${t}.png\x3c/path\x3e\n\x3ctype\x3eimage\x3c/type\x3e\n\x3ccontent\x3e\nimage/png image, 640x480 px, ${10000 + t} bytes\n\x3c/content\x3e`;
        default:
            return `Time sampled while preparing turn ${t}, step 1: 2026-10-29T12:${String(t % 60).padStart(2, "0")}:00Z`;
    }
}

/**
 * 40-turn mega-session scenario. Every 5th turn a fold covers the recent span
 * INCLUDING that turn's one-shot carrier (when present), so the carrier is
 * covered from turn t+1 on and never re-sent — exactly the #5139 shape.
 * The control run (no carriers) carries the identical anchor-seeding load, so
 * treatment-minus-control isolates the retirement tax itself.
 */
function runCarrierScenario(withCarriers: boolean): {
    session: Session;
    works: number[];
    logs: Array<[string, string]>;
    results: ReturnType<typeof reconcileFoldCoverage>[];
    coveredCarriers: string[];
} {
    const { session, block, logs, opts } = harness("dsh");
    const history = baseHistory(60);
    block.effectiveMessageIds.push(...history.slice(0, 40).map((m) => m.id!));
    const coveredCarriers: string[] = [];
    const results: ReturnType<typeof reconcileFoldCoverage>[] = [];
    const works: number[] = [];
    const TURNS = 40;
    for (let t = 1; t <= TURNS; t++) {
        const carrier = withCarriers ? makeMsg("user", oneShotCarrierText(t)) : undefined;
        history.push(makeMsg("assistant", `${history.length}: reply ${t} ${FILLER.repeat(2)}`));
        history.push(makeMsg("user", `${history.length}: question ${t} ${FILLER.repeat(2)}`));
        const wire = [...history, ...(carrier === undefined ? [] : [carrier])];
        works.push(measurePass(() => {
            results.push(reconcileFoldCoverage(session, wire, opts));
        }));
        if (t % 5 === 0) {
            block.effectiveMessageIds.push(...(withCarriers ? wire.slice(-3) : wire.slice(-2)).map((m) => m.id!));
            if (carrier !== undefined) {
                block.effectiveMessageIds.push(carrier.id);
                coveredCarriers.push(carrier.id);
            }
        }
    }
    return { session, works, logs, results, coveredCarriers };
}

describe("#5142 expected-rebase accounting", () => {
    test("T1 carrier retirement adds no asymptotic per-turn cost (THE perf pin)", () => {
        const treat = runCarrierScenario(true);
        const ctrl = runCarrierScenario(false);
        // (a) THE pin: pre-fix every retired carrier sat in `missing` forever
        // and forced a full multi-channel alignment on EVERY later turn, so
        // treatment-minus-control grew with session age (#5139: local 1.8s ->
        // 25s while drift ids climbed 739 -> 1045). Post-fix the retired ids
        // take deterministic expected-rebase channels out of drift accounting
        // and the gap stays bounded no matter how many carriers retire.
        let worstGap = 0;
        let worstGapTurn = -1;
        for (let t = 9; t < treat.works.length; t++) {
            const gap = treat.works[t] - ctrl.works[t];
            if (gap > worstGap) {
                worstGap = gap;
                worstGapTurn = t + 1;
            }
        }
        assert.ok(worstGap <= 10,
            `retirement-driven per-turn work unbounded: worst treatment-control gap ${worstGap} at turn ${worstGapTurn} after ${treat.coveredCarriers.length} retirements (treatment ${workString(treat.works)} vs control ${workString(ctrl.works)}) — O(full-history) tax regressed`);
        // (b) Near-zero steady state: between folds the pass must stay tiny
        // regardless of how many carriers have already retired (pre-fix even
        // these turns paid the full drift alignment). Post-fold turns are
        // excluded from this ABSOLUTE bound: they seed the fold's new
        // bare-assistant anchors, whose lazy turnContexts rebuild pays an
        // O(|msgs|) term in BOTH arms — a pre-existing cost tracked under
        // #5142 (direction B), not the retirement tax this pin bounds
        // (assertion (a) above still covers those turns differentially).
        const steady = treat.works.filter((_, t) => t >= 9 && t % 5 !== 0 && (t + 1) % 5 !== 0);
        const steadyMax = Math.max(...steady);
        assert.ok(steadyMax <= 40, `steady-state pass paid ${steadyMax} units after ${treat.coveredCarriers.length} retirements — expected-rebase exclusion from missing failed`);
        // (c) Verdict honesty: expected retirement is named as such, once per
        // episode — never as drift/truncation, never escalated.
        assert.ok(!treat.logs.some(([, m]) => m.includes("resent history drifted")), "no drift warn for expected carrier retirement");
        const rebaseLines = treat.logs.filter(([, m]) => m.includes("retired by expected host behavior"));
        assert.equal(rebaseLines.length, 1, "exactly one episode-scoped info line");
        assert.ok(rebaseLines[0][1].includes("#5142"));
        assert.ok(rebaseLines[0][1].includes("one-shot carrier(s)"));
        // (d) Accounting: every folded carrier is accounted, nothing reaped.
        assert.ok(treat.results[treat.results.length - 1].expectedRetired >= treat.coveredCarriers.length,
            `expectedRetired ${treat.results[treat.results.length - 1].expectedRetired} < covered carriers ${treat.coveredCarriers.length}`);
        for (const r of treat.results) assert.equal(r.reaped, 0, "no substrate reap on healthy carrier churn");
        assert.ok(!treat.logs.some(([lvl]) => lvl === "error"), "no epoch-confirmation escalation");
        // Control sanity: the harness itself must not manufacture drift.
        assert.ok(!ctrl.logs.some(([, m]) => m.includes("resent history drifted")), "control run must stay clean");
        assert.deepEqual(recordOf(ctrl.session) ?? {}, {}, "control run must not populate the expected record");
    });

    test("T2 image offload rewrite: head-run plain-text replacements classified, next turn near-zero", () => {
        const { session, block, logs, opts } = harness("dsh");
        const images = Array.from({ length: 6 }, (_, i) => makeMsg("user", "[image]"));
        const rest = baseHistory(34);
        const history = [...images, ...rest];
        block.effectiveMessageIds.push(...history.map((m) => m.id!));
        const storeRows: Record<string, Array<{ seq: number; msgId: string; content: string }>> = {};
        for (const img of images) {
            storeRows[img.id!] = [{
                seq: 1,
                msgId: img.id!,
                content: JSON.stringify({
                    id: img.id, role: "user", contentType: "text", text: "[image]",
                    rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJDREVG" } },
                    imageBase64: "QUJDREVG", imageMediaType: "image/png",
                }),
            }];
        }
        const storedRowLookup = (ids: readonly string[]) => ids.flatMap((id) => storeRows[id] ?? []);
        const fullOpts = { ...opts, storedRowLookup };
        // Head run (no prefix flank) so the #2915 order bracket cannot claim
        // the slot — this is the mass-offload shape C3 owns.
        let r = reconcileFoldCoverage(session, history, fullOpts);
        assert.equal(r.kind, "resend");
        const replacements = Array.from({ length: 6 }, (_, i) => makeMsg("user", `Figure ${i} uploaded to files; see attached reference.`));
        const wire2 = history.map((m, i) => (i < 6 ? replacements[i] : m));
        const w2 = measurePass(() => { r = reconcileFoldCoverage(session, wire2, fullOpts); });
        assert.ok(!logs.some(([, m]) => m.includes("resent history drifted")), "offload rewrite must not read as drift");
        const rebase = logs.filter(([, m]) => m.includes("retired by expected host behavior"));
        assert.equal(rebase.length, 1);
        assert.ok(rebase[0][1].includes("image offload rewrite(s)"));
        assert.equal(r.expectedRetired, 6);
        const rec = recordOf(session)!;
        for (const img of images) assert.equal(rec[img.id!], "image-offload");
        // Accounted for: the next turn early-exits again.
        const w3 = measurePass(() => { r = reconcileFoldCoverage(session, wire2, fullOpts); });
        assert.equal(r.kind, "resend");
        assert.ok(w3 < w2 / 2, `steady-state pass ${w3} not far below the classification pass ${w2}`);
    });

    test("T2b slot-pairing hard gates: image-bearing / role-mismatched replacements stay in drift (#3617 negative)", () => {
        const mkStore = (ids: string[]) => {
            const storeRows: Record<string, Array<{ seq: number; msgId: string; content: string }>> = {};
            for (const id of ids) {
                storeRows[id] = [{
                    seq: 1,
                    msgId: id,
                    content: JSON.stringify({
                        id, role: "user", contentType: "text", text: "[image]",
                        rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJDREVG" } },
                    }),
                }];
            }
            return (listed: readonly string[]) => listed.flatMap((id) => storeRows[id] ?? []);
        };
        // Gate !storedMessageCarriesImage(replacement): a replacement cell that
        // ITSELF carries an image is not an offload landing — the matcher must
        // fail safe and keep the id in drift accounting, alarm included.
        {
            const { session, block, logs, opts } = harness("dsh");
            const img = makeMsg("user", "[image]");
            const rest = baseHistory(20);
            const history = [img, ...rest];
            block.effectiveMessageIds.push(...history.map((m) => m.id!));
            const fullOpts = { ...opts, storedRowLookup: mkStore([img.id!]) };
            reconcileFoldCoverage(session, history, fullOpts);
            const imgCell = { id: "rep-img", role: "user" as const, contentType: "text" as const, text: "alt", rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: "image/png", data: "WFg=" } } } as CoreMessage;
            reconcileFoldCoverage(session, [imgCell, ...rest], fullOpts);
            assert.equal(recordOf(session)?.[img.id!], undefined, "image-bearing replacement must not classify as offload");
            assert.ok(!logs.some(([, m]) => m.includes("retired by expected host behavior")), "no expected-rebase line for a mis-gated pair");
            assert.ok(
                logs.some(([lvl, m]) => lvl === "warn" && m.includes("resent history drifted"))
                || logs.some(([, m]) => m.includes("truncation/dropped history") || m.includes("rewind/undo")),
                "the genuine-loss alarm must stay live (no masking)",
            );
        }
        // Gate anchor.role === replacement.role: a role-mismatched replacement
        // at the same index is not the offlanded text of this image.
        {
            const { session, block, logs, opts } = harness("dsh");
            const img = makeMsg("user", "[image]");
            const rest = baseHistory(20);
            const history = [img, ...rest];
            block.effectiveMessageIds.push(...history.map((m) => m.id!));
            const fullOpts = { ...opts, storedRowLookup: mkStore([img.id!]) };
            reconcileFoldCoverage(session, history, fullOpts);
            const roleCell = makeMsg("assistant", "Figure uploaded to files; see attached reference.");
            reconcileFoldCoverage(session, [roleCell, ...rest], fullOpts);
            assert.equal(recordOf(session)?.[img.id!], undefined, "role-mismatched replacement must not classify as offload");
            assert.ok(!logs.some(([, m]) => m.includes("retired by expected host behavior")), "no expected-rebase line for a mis-gated pair");
        }
    });

    test("T2c production offload placeholder format pairs through C3 (reporter sample shape)", () => {
        const { session, block, logs, opts } = harness("dsh");
        const img = makeMsg("user", "[image]");
        const history = [img, ...baseHistory(34)];
        block.effectiveMessageIds.push(...history.map((m) => m.id!));
        const storedRowLookup = (ids: readonly string[]) => ids.filter((id) => id === img.id!).map((id) => ({
            seq: 1,
            msgId: id,
            content: JSON.stringify({
                id, role: "user", contentType: "text", text: "[image]",
                rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJDREVG" } },
                imageBase64: "QUJDREVG", imageMediaType: "image/png",
            }),
        }));
        const fullOpts = { ...opts, storedRowLookup };
        reconcileFoldCoverage(session, history, fullOpts);
        // The exact @deepseek-ai/dsh-llm offloadedImageText output shape from
        // the #5142 reporter sample (personal path redacted to synthetic):
        const placeholder = makeMsg("user", '[image omitted to fit request image limits; "spawn_preview.png" (sha256:2e896b95dec003df). Normalized copy (read-only; may be resized or re-encoded): "normalized/spawn_preview.png" (1600x900px, image/png). Source dimensions, format, and byte size may differ. Copy to a writable path ending in .png before editing.]');
        const wire2 = [placeholder, ...history.slice(1)];
        const r = reconcileFoldCoverage(session, wire2, fullOpts);
        assert.equal(recordOf(session)?.[img.id!], "image-offload", "the production placeholder must pair structurally at its slot");
        assert.ok(!logs.some(([, m]) => m.includes("resent history drifted")), "production offload must not read as drift");
        assert.equal(r.expectedRetired, 1);
    });

    test("T3a real head truncation still alarms — no expected-rebase masking (#3617 negative)", () => {
        const { session, block, logs, opts } = harness("dsh");
        const history = baseHistory(40);
        block.effectiveMessageIds.push(...history.map((m) => m.id!));
        reconcileFoldCoverage(session, history, opts);
        const truncated = history.slice(8);
        const r = reconcileFoldCoverage(session, truncated, opts);
        assert.ok(r.missing > 0, "genuine loss must still be accounted");
        assert.deepEqual(recordOf(session) ?? {}, {}, "genuine loss must not enter the expected record");
        assert.ok(!logs.some(([, m]) => m.includes("retired by expected host behavior")));
        assert.ok(
            logs.some(([, m]) => m.includes("truncation/dropped history") || m.includes("rewind/undo"))
            || logs.some(([, m]) => m.includes("resent history drifted")),
            "the pre-existing alarm (benign truncation note or drift warn) must still fire",
        );
    });

    test("T3b real mid-history edit still alarms (#3617 negative)", () => {
        const { session, block, logs, opts } = harness("dsh");
        const history = baseHistory(40);
        block.effectiveMessageIds.push(...history.map((m) => m.id!));
        reconcileFoldCoverage(session, history, opts);
        const edited = history.map((m, i) => (i === 20 ? makeMsg(m.role, `${i}: zebra quokka pangolin — completely unrelated rewrite ${FILLER.repeat(2)}`) : m));
        const r = reconcileFoldCoverage(session, edited, opts);
        assert.ok(r.missing > 0 || r.claims > 0, "genuine rewrite must still be handled as churn");
        assert.deepEqual(recordOf(session) ?? {}, {}, "an edited cell is not an expected rebase");
        assert.ok(!logs.some(([, m]) => m.includes("retired by expected host behavior")));
    });

    test("T3c non-dsh lane: carrier retirement keeps legacy drift accounting (KDD #9 gating)", () => {
        const { session, block, logs, opts } = harness("pi");
        const history = baseHistory(30);
        block.effectiveMessageIds.push(...history.slice(0, 20).map((m) => m.id!));
        reconcileFoldCoverage(session, history, opts);
        const carrier = makeMsg("user", "Time sampled while preparing turn 1, step 1: 2026-10-29T12:00:00Z");
        // One-shot shape (mirrors T1): the carrier rides ONLY its own turn's
        // wire and the fold covers it at turn end — an earlier draft kept the
        // carrier in `history`, so it never actually retired and the
        // assertion below could never fire.
        history.push(makeMsg("assistant", `${history.length}: reply ${FILLER.repeat(2)}`));
        reconcileFoldCoverage(session, [...history, carrier], opts);
        block.effectiveMessageIds.push(carrier.id);
        // Next turn: the carrier is gone from the wire.
        history.push(makeMsg("user", `${history.length}: question ${FILLER.repeat(2)}`));
        const r = reconcileFoldCoverage(session, history, opts);
        assert.ok(r.missing > 0, "unrecognized-lane retirement stays in drift accounting");
        assert.deepEqual(recordOf(session) ?? {}, {}, "no classifier registered for this lane (KDD #9 evidence-permitlist)");
        assert.ok(!logs.some(([, m]) => m.includes("retired by expected host behavior")));
    });

    test("T4 upgrade residue: carriers folded before first sight backfill from stored bytes, once", () => {
        const { session, block, logs, opts } = harness("dsh");
        const history = baseHistory(40);
        const ghost = "ghost-carrier-1";
        block.effectiveMessageIds.push(...history.map((m) => m.id!), ghost);
        const storedRowLookup = (ids: readonly string[]) => ids.filter((id) => id === ghost).map((id) => ({
            seq: 1,
            msgId: id,
            content: JSON.stringify({ id, role: "user", contentType: "text", text: "Current runtime context: window 200000 tokens, model qwen3-coder" }),
        }));
        const fullOpts = { ...opts, storedRowLookup };
        const w1 = measurePass(() => { reconcileFoldCoverage(session, history, fullOpts); });
        assert.equal(recordOf(session)?.[ghost], "durable/runtime-context", "stored-byte backfill must classify the residue");
        assert.ok(!logs.some(([, m]) => m.includes("resent history drifted")));
        const w2 = measurePass(() => {
            const r2 = reconcileFoldCoverage(session, history, fullOpts);
            assert.equal(r2.kind, "resend", "classified residue restores the near-zero steady state");
        });
        assert.ok(w2 <= w1 / 2, `second pass ${w2} not far below the backfill pass ${w1} — memoization regressed`);
    });
});

describe("#5142 carrier classifier units", () => {
    test("dshTimeContextPath: prefix positives, role/contentType negatives", () => {
        const mk = (role: CoreMessage["role"], text: string): CoreMessage =>
            ({ id: "u", role, contentType: "text", text }) as CoreMessage;
        assert.equal(dshTimeContextPath(mk("user", "Time sampled while preparing turn 3, step 1: 2026-10-29T12:00:00Z")), "oneshot/time-context");
        assert.equal(dshTimeContextPath(mk("user", "  Time sampled while preparing turn 3, step 1: x")), "oneshot/time-context");
        assert.equal(dshTimeContextPath(mk("user", "time sampled while preparing turn 3, step 1: x")), "oneshot/time-context");
        assert.equal(dshTimeContextPath(mk("assistant", "Time sampled while preparing turn 3, step 1: x")), undefined, "assistant echo must never classify (#2766)");
        assert.equal(dshTimeContextPath(mk("user", "we discussed the time sampled while preparing turn earlier")), undefined, "marker mid-text is not a carrier");
        assert.equal(dshTimeContextPath(mk("user", "")), undefined);
        const tool = { id: "u", role: "tool", contentType: "tool-result", text: "Time sampled while preparing turn 3" } as CoreMessage;
        assert.equal(dshTimeContextPath(tool), undefined);
    });

    test("dshPastedImagePath / dshToolJobNoticePath: positives, role negatives, near-miss negatives", () => {
        const mk = (role: CoreMessage["role"], text: string): CoreMessage =>
            ({ id: "u", role, contentType: "text", text }) as CoreMessage;
        // ptc-mode production shape (#5142 reporter sample, path redacted):
        const ptc = "\x3cpath\x3espawn_preview.png\x3c/path\x3e\n\x3ctype\x3eimage\x3c/type\x3e\n\x3ccontent\x3e\nimage/png image, 1600x900 px, 1722627 bytes\n\x3c/content\x3e";
        assert.equal(dshPastedImagePath(mk("user", ptc)), "oneshot/ptc-image");
        assert.equal(dshPastedImagePath(mk("assistant", ptc)), undefined, "assistant echo must never classify (#2766)");
        assert.equal(dshPastedImagePath(mk("user", "\x3cpath\x3ex.png\x3c/path\x3e without an image block")), undefined, "path tag alone is not a paste carrier");
        // tool-jobs notice production shape (#5142 reporter sample, command redacted):
        const job = 'background job bash-abc123 (bash: "echo ok") finished [status: completed, exit code: 0]. Read its output with job_output.';
        assert.equal(dshToolJobNoticePath(mk("user", job)), "oneshot/tool-job-notice");
        assert.equal(dshToolJobNoticePath(mk("user", " Background Job abc finished.")), "oneshot/tool-job-notice", "asciiCI prefix like the other auto-injected families");
        assert.equal(dshToolJobNoticePath(mk("assistant", job)), undefined, "assistant echo must never classify (#2766)");
        assert.equal(dshToolJobNoticePath(mk("user", "the background job failed again")), undefined, "marker mid-text is not a carrier");
    });

    test("dshCarrierRawMarkers stay in lockstep with the dsh lane classifiers", () => {
        const cls = oneShotCarrierPaths.dsh;
        assert.ok(cls !== undefined, "dsh lane must have a classifier registry entry");
        assert.ok(dshCarrierRawMarkers.length >= 7, "seven known dsh carrier families");
        for (const marker of dshCarrierRawMarkers) {
            const msg = { id: "lk", role: "user" as const, contentType: "text" as const, text: marker } as CoreMessage;
            assert.notEqual(cls(msg), undefined, `marker ${JSON.stringify(marker)} no longer matches any dsh classifier`);
        }
    });
});

function workString(works: number[]): string {
    return `[${works.map((w) => w).join(", ")}]`;
}
