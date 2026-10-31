// Shared overflow-evidence arming (#4950). Extracted verbatim from the
// forward() closure in server/relay.ts so every lane that observes a context
// overflow — HTTP status bodies, in-stream SSE error frames, the compress
// loop's in-band errors — records IDENTICAL evidence: same baseline, same
// "overflow-arm" source tag, same current-route origin stamp, same calibration
// feed. Callers own their own once-per-request guard (this function is not
// idempotent by design: feeding the calibration ring twice would double-sample).
import { defaultCountTokens } from "acp-kernel";
import { markDirty } from "./session.js";
import type { Session } from "./session.js";
import { settleOverflowCalibration } from "./cache-ledger.js";
import { normalizeUpstreamOrigin } from "./util.js";
import type { ContextOverflowInfo } from "./util.js";

export function armSessionOverflow(
    session: Session,
    info: ContextOverflowInfo,
    upstreamUrl: string | undefined,
    payloadText: string | undefined,
    log: (level: string, msg: string) => void,
): void {
    if (!info.isOverflow) return;
    const s = session;
    let reqModel: string | undefined;
    try {
        const parsedBody = JSON.parse(payloadText ?? "") as Record<string, unknown>;
        reqModel = typeof parsedBody.model === "string" ? parsedBody.model : undefined;
    } catch {
        reqModel = undefined;
    }
    if (info.window) {
        // Arm the emergency shrink at EXACTLY the stated window: the
        // upstream just proved a turn cannot succeed above it, so the
        // next turn's kernel emergency nudge + tool-result truncate
        // must fire. #857: a number the upstream itself stated bounds
        // the payload (never a content estimate). #1839: it is still an
        // ARM, not a billing report — tag it "overflow-arm", never
        // "usage" (the only tier trusted unconditionally);
        // effectiveTokenCount's fast path and the #496 forward-once gate
        // accept it as rescue-grade, everything else usage-gated keeps
        // excluding it. A real usage report on the next successful turn
        // overwrites it.
        //
        // #3738: the armed value must be ≤ the limit the kernel actually
        // JUDGES against, or the arm can never trigger the fold it
        // exists to cause. The kernel judges against reqConfig's
        // output-headroom-RESERVED window, recorded per-request as
        // `session.metadata.reservedContextLimit` (#4205 split the display
        // off into the unreserved `effectiveContextLimit`), e.g. 1,048,576
        // - 256,000 = 792,576 — while `info.window` is the RAW stated
        // window (1,048,576). A
        // live limb hit exactly this: upstream 400 "maximum context
        // length is 1048576 ... you requested 1097304 (841304 in the
        // messages, 256000 in the completion)", the arm sat at 1,048,576
        // which is ABOVE the 792,576 judging limit, so the emergency /
        // over-limit bands read the arm as "still fits" and the client
        // re-sent the same oversized history every turn — 400 forever.
        // Clamping to min(stated, reserved) keeps the arm upstream-truth
        // when the two agree, and only bites when a reservation exists.
        //
        // #3450: when the body states the REJECTED PAYLOAD'S OWN size
        // ("N in the messages"), book THAT as the armed baseline — the
        // window is a ceiling, not a measurement; arming at the ceiling
        // made preflight see "payload ~window, deficit 0" while the real
        // payload sat above its local estimate and the re-forward died.
        // The #3738 clamp then caps that measurement at the judging limit
        // (a stated count exceeds the reserved limit exactly when the
        // completion share pushed the total over the window).
        const measured = typeof info.requestedMessages === "number" && info.requestedMessages > 0 ? info.requestedMessages : undefined;
        const judgingLimit = typeof s.metadata.reservedContextLimit === "number" && s.metadata.reservedContextLimit > 0
            ? s.metadata.reservedContextLimit
            : typeof s.metadata.effectiveContextLimit === "number" && s.metadata.effectiveContextLimit > 0 ? s.metadata.effectiveContextLimit : 0;
        const unclampedBaseline = measured ?? info.window;
        const armedBaseline = judgingLimit > 0 && judgingLimit < unclampedBaseline ? judgingLimit : unclampedBaseline;
        s.stats.lastInputTokens = armedBaseline;
        s.stats.lastInputTokensSource = "overflow-arm";
        // #2313: the rejection came from THIS upstream — stamp the
        // evidence origin so the #1933 F2 route gate (and the #2313
        // probe-forward gate) treat the arm as current-route evidence
        // instead of demoting it against a stale settle origin.
        s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(upstreamUrl);
        // #1110: record the arm SEPARATELY so the side-request guard
        // can read it without ever touching the nudge baseline. The guard
        // keeps the CEILING even when the baseline books a measured or
        // clamped value (#3450) — it must never clamp below what the
        // upstream proved, and it reserves each side request's own output
        // from this value itself, so feeding it a pre-reserved number
        // would double-subtract the headroom.
        s.stats.overflowArmTokens = info.window;
        // #3450: the completion share proves this provider bills OUTPUT
        // against the same wall — remember it so preflight folds against
        // window − completion (the foldable quantity is MESSAGES).
        const reserve = typeof info.requestedCompletion === "number" && info.requestedCompletion > 0 ? info.requestedCompletion : undefined;
        if (reserve !== undefined) {
            s.stats.overflowArmCompletionReserve = reserve;
            // #3450 follow-up: same evidence on the provider's lifetime —
            // the arm retires on the next usage report (#1110), this must
            // not (see provenCompletionReserve). Scoped to the origin+model.
            const provenOrigin = normalizeUpstreamOrigin(upstreamUrl);
            if (provenOrigin !== undefined && reqModel !== undefined) {
                s.stats.provenCompletionWall = reserve;
                s.stats.provenCompletionWallOrigin = provenOrigin;
                s.stats.provenCompletionWallModel = reqModel;
            }
        }
        // #3450: one-time mismatch warning — the upstream-stated window
        // differs from the window bili actually judges on. #4205: compare
        // against the UNRESERVED declaration, so routes that reserve output
        // headroom no longer warn on every arm just because R < N.
        const declaredWindow = typeof s.metadata.effectiveContextLimit === "number" ? s.metadata.effectiveContextLimit : 0;
        if (declaredWindow > 0 && declaredWindow !== info.window && !s.stats.overflowArmMismatchWarned) {
            s.stats.overflowArmMismatchWarned = true;
            log("warn", `[${s.id}] upstream-stated window ${info.window} differs from the declared window in use (${declaredWindow}, model=${reqModel ?? "unknown"}) — folding targets the smallest of the stated window, the declared window and the per-route output reservation; set compress.modelContextLimit if the declaration is wrong (#3450)`);
        }
        log("warn", `[${s.id}] upstream context overflow (model=${reqModel ?? "unknown"}) — window ${info.window} stated upstream${measured !== undefined ? `, rejected payload ~${measured} tokens stated` : ""}${reserve !== undefined ? `, completion reservation ${reserve} tokens` : ""}; armed emergency shrink at ${armedBaseline}${armedBaseline < unclampedBaseline ? ` (clamped to the judging limit ${judgingLimit}, #3738)` : ""}, declared window unchanged (#987)`);
        // #3900/#4079: the stated count is a usage-grade measurement of
        // the exact rejected body (#3450) whose local estimate prepare
        // recorded as the pending k̂ pair — feed it into the SAME ring a
        // usage settle uses, so the estimator learns even on a route that
        // only ever overflows and the next preflight judges "doesn't fit"
        // on the corrected calibre instead of re-forwarding the same body
        // forever. The refold below re-runs prepare and re-notes a fresh
        // pair for the folded body (#1195), so retiring the consumed pair
        // here cannot mispair a later report.
        if (measured !== undefined) settleOverflowCalibration(s, measured, upstreamUrl);
    } else {
        // No window number stated — nothing to learn (and #987
        // removed the learner anyway), but the rejection itself is
        // evidence at the size actually sent: arm at
        // min(declared, payload estimate). A payload BELOW the
        // declared window being rejected means the declaration is
        // wrong (or the upstream is flaky) — arming at the payload's
        // own size never over-triggers, while a payload OVER the
        // declared window arms at the declaration — which is what
        // the #496 image-relay forward-once gate needs to break the
        // #488 400 loop after exactly one rejected forward.
        // #4205: arm against the JUDGING (reserved) window so the #3738
        // invariant holds here too; pre-#4205 persisted sessions carry that
        // value in effectiveContextLimit (the field then held R), hence the
        // fallback.
        const judging = typeof s.metadata.reservedContextLimit === "number" && s.metadata.reservedContextLimit > 0
            ? s.metadata.reservedContextLimit
            : typeof s.metadata.effectiveContextLimit === "number" ? s.metadata.effectiveContextLimit : 0;
        let est = 0;
        try {
            // #1492: same CJK-aware lower bound as armFailureShrink.
            est = defaultCountTokens(payloadText ?? "");
        } catch { est = 0; }
        const arm = Math.max(0, Math.min(judging, Number.isFinite(est) ? est : judging));
        if (arm > 0) {
            s.stats.lastInputTokens = arm;
            // #1839: an estimate promoted to "usage" would enter the nudge
            // denominator unconditionally — tag it "overflow-arm" instead
            // (still accepted by effectiveTokenCount + the #496 gate).
            s.stats.lastInputTokensSource = "overflow-arm";
            s.stats.overflowArmTokens = arm; // #1110: guard reads this, not the baseline
            s.stats.lastInputTokensOrigin = normalizeUpstreamOrigin(upstreamUrl); // #2313: same-route evidence, see the window branch above
        }
        log("warn", `[${s.id}] upstream context overflow (window not parseable, model=${reqModel ?? "unknown"}) — armed emergency shrink at ~${arm} tokens (min of judging window ${judging} and payload estimate), nothing learned (#987): ${info.message}`);
    }
    // The armed emergency (lastInputTokens) lives in memory only
    // until scheduled — the error path returns before forward()'s
    // trailing markDirty, so schedule the save HERE or the arm is
    // lost on restart.
    markDirty(s);
}
