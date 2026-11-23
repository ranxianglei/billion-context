import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import type { BiliMessage } from "acp-kernel/wire";
import { getSession } from "../src/session.ts";
import { estimateCoreMessages } from "../src/preflight.ts";
import { calibratedImageTextSide, estimateWireOverhead } from "../src/server/budget.ts";
import { learnedImageReserve, noteForwardedImageFacts, settleUsageReport, type LearnedImageCostEntry } from "../src/cache-ledger.ts";

// #7621: settleImageLearning learns the per-image cost as
//   observed = billedTotal - textSide,  per = observed / nImages.
// billedTotal is provider-measured (billing caliber); textSide MUST be in the
// same caliber. The pre-fix producers captured the RAW chars/4 estimate, which
// underestimates the billed text by (k-1)× on a route with active k̂ > 1 (CJK /
// code-heavy) — and that gap was mis-attributed to the images, inflating the
// learned per-image cost (bounded only by the #4153 guards). The producers now
// capture the k̂-calibrated text side via calibratedImageTextSide.

let seq = 0;
function textMsg(chars: number): BiliMessage {
    seq++;
    return { id: `txt-${seq}`, role: "user", contentType: "text", text: "a".repeat(chars) };
}

const ORIGIN = "http://127.0.0.1:8317";
const OTHER_ORIGIN = "http://127.0.0.1:9999";

test("#7621 unit: calibratedImageTextSide scales the text side with the active origin-scoped k̂", () => {
    const s = getSession(`t-7621-${Math.random().toString(36).slice(2)}`);
    const msgs = [textMsg(40_000)];
    const body = JSON.stringify({ messages: msgs, system: "S".repeat(7_200) });
    const raw = estimateCoreMessages(msgs) + estimateWireOverhead("anthropic", body);
    assert.ok(raw > 0, "sanity: a non-empty payload has a positive raw estimate");

    // No calibration yet → raw unchanged (legacy behavior preserved).
    assert.equal(calibratedImageTextSide(s, "anthropic", msgs, body, ORIGIN), raw, "no active k̂ → raw estimate");

    // Learn k̂ = 1.46 on this origin (a CJK-heavy route).
    s.stats.calibratedEstimate = 1.46;
    s.stats.calibratedEstimateOrigin = ORIGIN;
    assert.equal(calibratedImageTextSide(s, "anthropic", msgs, body, ORIGIN), raw * 1.46, "matching origin → raw × k̂");
    assert.equal(calibratedImageTextSide(s, "anthropic", msgs, body, OTHER_ORIGIN), raw, "mismatched origin → raw (no cross-route bleed)");
    assert.equal(calibratedImageTextSide(s, "anthropic", msgs, body, undefined), raw, "unknown origin → raw");
});

test("#7621 unit: a k̂ learned for one model does not calibrate a different model", () => {
    const s = getSession(`t-7621-model-${Math.random().toString(36).slice(2)}`);
    const msgs = [textMsg(40_000)];
    const body = JSON.stringify({ messages: msgs, system: "S".repeat(7_200) });
    const raw = estimateCoreMessages(msgs) + estimateWireOverhead("anthropic", body);
    s.stats.calibratedEstimate = 2;
    s.stats.calibratedEstimateOrigin = ORIGIN;
    s.stats.calibratedEstimateModel = "model-A";
    s.metadata.lastModel = "model-B";
    assert.equal(calibratedImageTextSide(s, "anthropic", msgs, body, ORIGIN), raw, "cross-model factor → raw");
    s.metadata.lastModel = "model-A";
    assert.equal(calibratedImageTextSide(s, "anthropic", msgs, body, ORIGIN), raw * 2, "same model → raw × k̂");
});

test("#7621 e2e: image learning on a k̂>1 route no longer mis-attributes the tokenizer gap to images", () => {
    const s = getSession(`t-7621-e2e-${Math.random().toString(36).slice(2)}`);
    const host = "vision.example.com";
    const msgs = [textMsg(40_000)];
    const body = JSON.stringify({ messages: msgs, system: "S".repeat(7_200) });
    const raw = estimateCoreMessages(msgs) + estimateWireOverhead("anthropic", body);
    const k = 2; // CJK-heavy route: billed ≈ 2× raw
    s.stats.calibratedEstimate = k;
    s.stats.calibratedEstimateOrigin = ORIGIN;

    const nImages = 2;
    const truePerImage = 3_000;
    // The producer now captures the CALIBRATED text side (billing units).
    const calibratedText = calibratedImageTextSide(s, "anthropic", msgs, body, ORIGIN);
    assert.equal(calibratedText, raw * k, "producer captures the billing-caliber text side");
    // The provider bills the calibrated text + the true image mass.
    const billedTotal = calibratedText + truePerImage * nImages;

    noteForwardedImageFacts(s, { nImages, textSide: calibratedText, host, fp: "bytes:0" });
    settleUsageReport(s, { total: billedTotal, reportedCached: null });
    const entry = s.metadata.learnedImageCosts as Record<string, LearnedImageCostEntry>;
    assert.ok(entry[host], "first sample learned");
    assert.equal(entry[host].cost, truePerImage, "calibrated textSide → learned per-image cost is the true image mass, not the k̂ gap");
    assert.equal(learnedImageReserve(s, host, nImages, "bytes:0", 0), truePerImage * nImages, "reserve reflects the corrected cost");

    // Contrast: the OLD uncalibrated textSide would have mis-attributed the (k-1)×raw gap to images.
    const oldPer = (billedTotal - raw) / nImages;
    assert.ok(oldPer > truePerImage, "uncalibrated textSide inflates the learned cost by the tokenizer gap");
});
