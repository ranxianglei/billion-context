import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { getSession, type Session } from "../src/session.ts";
import { pixelTileEstimate } from "../src/image-tokens.ts";
import { learnedImageReserve, noteForwardedImageFacts, settleUsageReport, type LearnedImageCostEntry } from "../src/cache-ledger.ts";

// Issue #4153: settleImageLearning attributes the ENTIRE usage residual
// (billed - text-side estimate) to images, so a route whose bill outruns bili's
// text estimate by reasoning/system/tool mass converges its learned per-image
// cost to a nonsense fixed point (448,724 tok on a 2,125-prior 1080p screenshot).
// The three old guards all missed it: the backstop sat at 1e6, imageTokenCap
// defaulted to 0 (dead clamp branch), and the TTL refreshed every settle.
//
// The load-bearing cure is the CONSUME-side prior-relative ceiling: the learned
// reserve for a payload may never exceed LEARNED_VARIANCE_BAND x that payload's
// OWN prior, so a poisoned persisted value is neutralized immediately no matter
// how it got there. These tests pin the incident numbers end-to-end plus the two
// secondary facets the owner raised (settle backstop nImages-dependence, and the
// write-side fingerprint reset so a reconfigured route stops EMA-ing off a
// poisoned base).

// The incident's exact per-image prior: 1920x1080 -> 12 tiles -> 85 + 170*12.
const PRIOR_PER_IMAGE = 2125;
// The incident's converged poisoned per-image cost (seen=791, fp="pixels:0").
const POISONED_COST = 448_724.59893398033;
const VARIANCE_BAND = 15;

function seed(session: Session, host: string, entry: LearnedImageCostEntry): void {
    session.metadata.learnedImageCosts = { [host]: entry };
}

test("#4153: the pixels prior is the documented 2,125 tok for a 1080p frame", () => {
    assert.equal(pixelTileEstimate(1920, 1080), PRIOR_PER_IMAGE);
});

test("#4153 consume: a poisoned persisted value clamps to 15x the payload's own prior", () => {
    const s = getSession(`t-4153-clamp-${Math.random().toString(36).slice(2)}`);
    const host = "poison.example.com";
    seed(s, host, { cost: POISONED_COST, seen: 791, ts: Date.now(), fp: "pixels:0" });

    // Pre-fix this returned 4 x 448,724 = 1,794,898 (the brick-wall). The ceiling
    // caps the TOTAL reserve at 15 x prior_total, independent of nImages.
    const nImages = 4;
    const priorTotal = PRIOR_PER_IMAGE * nImages; // 8,500
    assert.equal(
        learnedImageReserve(s, host, nImages, "pixels:0", 0, priorTotal),
        VARIANCE_BAND * priorTotal, // 127,500
        "incident shape: 4 x min(448,724, 15x2,125) = 127,500",
    );

    // nImages-independence (owner detail 2): the settle backstop gets WEAKER as
    // nImages grows (same residual / more images = smaller per-image), but the
    // consume ceiling total stays 15 x prior_total no matter how many images ride.
    for (const n of [1, 4, 40]) {
        const pTotal = PRIOR_PER_IMAGE * n;
        assert.equal(
            learnedImageReserve(s, host, n, "pixels:0", 0, pTotal),
            VARIANCE_BAND * pTotal,
            `nImages=${n}: total reserve pinned to 15 x prior_total`,
        );
    }
});

test("#4153 consume: without a prior the reduced backstop still bites at 100k, not 1M", () => {
    const s = getSession(`t-4153-backstop-${Math.random().toString(36).slice(2)}`);
    const host = "h.example.com";
    seed(s, host, { cost: POISONED_COST, seen: 791, ts: Date.now(), fp: "pixels:0" });

    // Old code: backstop 1e6 -> 448,724 sailed through unclamped -> 1,794,898.
    // New code: backstop 100k -> clamped to 4 x 100,000 even with no prior anchor.
    assert.equal(learnedImageReserve(s, host, 4, "pixels:0", 0), 100_000 * 4, "no-prior path caps at 100k/image");
});

test("#4153 consume: downward corrections (the #1843 rescue) stay untouched", () => {
    const s = getSession(`t-4153-rescue-${Math.random().toString(36).slice(2)}`);
    const host = "bytes.example.com";
    // A bytes route whose true bill (3,000/img) is FAR below the bytes prior
    // (~150,000/img). The ceiling only bounds the HIGH side, so the rescue holds.
    seed(s, host, { cost: 3000, seen: 5, ts: Date.now(), fp: "bytes:0" });
    const nImages = 2;
    const priorTotal = 150_000 * nImages;
    assert.equal(
        learnedImageReserve(s, host, nImages, "bytes:0", 0, priorTotal),
        3000 * nImages,
        "learned < prior is trusted verbatim (rescue preserved)",
    );
});

test("#4153 consume: a within-band encoder variance above prior is trusted", () => {
    const s = getSession(`t-4153-band-${Math.random().toString(36).slice(2)}`);
    const host = "var.example.com";
    // 5,000/img > 2,125 prior but well inside the 15x band (31,875) -> kept.
    seed(s, host, { cost: 5000, seen: 3, ts: Date.now(), fp: "pixels:0" });
    const nImages = 2;
    assert.equal(learnedImageReserve(s, host, nImages, "pixels:0", 0, PRIOR_PER_IMAGE * nImages), 5000 * nImages);
});

test("#4153 consume: the configured cap and the variance band compose (tighter wins)", () => {
    const s = getSession(`t-4153-capband-${Math.random().toString(36).slice(2)}`);
    const host = "cap.example.com";
    seed(s, host, { cost: 40_000, seen: 10, ts: Date.now(), fp: "pixels:0" });
    const nImages = 1;
    const prior = PRIOR_PER_IMAGE; // 2,125 -> band edge 31,875

    // cap tighter than the band: cap wins.
    assert.equal(learnedImageReserve(s, host, nImages, "pixels:0", 2000, prior), 2000, "cap below band edge");
    // band tighter than the cap: band wins (the owner's default-cap=2805 case is
    // subsumed here — the band, not any fixed cap, is what bounds the value).
    assert.equal(learnedImageReserve(s, host, nImages, "pixels:0", 50_000, prior), VARIANCE_BAND * prior, "band below cap");
});

test("#4153 settle: the backstop rejects degenerate samples, and admit != fall-back-to-prior", () => {
    const s = getSession(`t-4153-settle-${Math.random().toString(36).slice(2)}`);
    const host = "settle.example.com";

    // Degenerate sample (per > 100k): rejected, nothing written.
    noteForwardedImageFacts(s, { nImages: 1, textSide: 0, host, fp: "pixels:0" });
    settleUsageReport(s, { total: 200_000, reportedCached: null });
    assert.equal(s.metadata.learnedImageCosts ?? undefined, undefined, "out-of-band sample quarantined");

    // Sane sample (per <= 100k): accepted.
    noteForwardedImageFacts(s, { nImages: 1, textSide: 0, host, fp: "pixels:0" });
    settleUsageReport(s, { total: 50_000, reportedCached: null });
    let entry = s.metadata.learnedImageCosts as Record<string, LearnedImageCostEntry>;
    assert.equal(entry[host].cost, 50_000);
    assert.equal(entry[host].seen, 1);

    // Owner detail 2: the SAME residual split over many images slips under the
    // backstop (2,860,000 / 40 = 71,500 <= 100k) — the backstop alone is NOT the
    // cure. But the consume ceiling still bounds whatever gets admitted.
    const s2 = getSession(`t-4153-settle-many-${Math.random().toString(36).slice(2)}`);
    noteForwardedImageFacts(s2, { nImages: 40, textSide: 0, host, fp: "pixels:0" });
    settleUsageReport(s2, { total: 2_860_000, reportedCached: null });
    entry = s2.metadata.learnedImageCosts as Record<string, LearnedImageCostEntry>;
    assert.equal(entry[host].cost, 71_500, "large-nImages sample passes the per-image backstop");
    const priorTotal = PRIOR_PER_IMAGE * 40;
    assert.equal(
        learnedImageReserve(s2, host, 40, "pixels:0", 0, priorTotal),
        VARIANCE_BAND * priorTotal,
        "consume ceiling bounds the admitted sample regardless of nImages",
    );
});

test("#4153 settle: a reconfigured route resets instead of EMA-ing off a poisoned base", () => {
    const s = getSession(`t-4153-reset-${Math.random().toString(36).slice(2)}`);
    const host = "reset.example.com";
    // Poisoned value persisted under the old fingerprint (no cap).
    seed(s, host, { cost: POISONED_COST, seen: 791, ts: Date.now(), fp: "pixels:0" });

    // Owner sets imageTokenCap to mitigate -> fingerprint becomes "pixels:2805".
    // Read side already fell back to the prior on the mismatch; the WRITE side must
    // also drop the stale base, else the next settle blends half-poison forever.
    noteForwardedImageFacts(s, { nImages: 4, textSide: 0, host, fp: "pixels:2805" });
    settleUsageReport(s, { total: PRIOR_PER_IMAGE * 4, reportedCached: null }); // per = 2,125
    let entry = s.metadata.learnedImageCosts as Record<string, LearnedImageCostEntry>;
    assert.equal(entry[host].cost, PRIOR_PER_IMAGE, "fingerprint change resets to the fresh sample");
    assert.equal(entry[host].seen, 1, "seen counter restarts on reset");
    assert.equal(entry[host].fp, "pixels:2805");

    // Continuity resumes under the stable new fingerprint (EMA from the clean base).
    noteForwardedImageFacts(s, { nImages: 4, textSide: 0, host, fp: "pixels:2805" });
    settleUsageReport(s, { total: 2500 * 4, reportedCached: null }); // per = 2,500
    entry = s.metadata.learnedImageCosts as Record<string, LearnedImageCostEntry>;
    assert.equal(entry[host].cost, (PRIOR_PER_IMAGE + 2500) / 2, "EMA continues from the reset base");
    assert.equal(entry[host].seen, 2);
});
