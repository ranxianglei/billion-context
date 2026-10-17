// #3484: per-request cache hit-rate line chart — golden byte-stability, cause-dot
// parity with the trajectory bands, and the brush-zoom contract (shared machinery).
process.env.TZ = "UTC";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bigFixture, bigDetailPayload, seamEventsOf, smallFixture } from "./web-trajectory-fixture.ts";
import { runWebClient, waitFor } from "./web-trajectory-harness.ts";

type HitSvgFn = (lines: unknown[], folds: unknown[], seams: unknown[]) => string;
type TrajSvgFn = (lines: unknown[], folds: unknown[], win: number, baseIn: number, seams: unknown[]) => string;
type CausesFn = (lines: unknown[], folds: unknown[]) => string[];

// Full-view sample x in viewBox units (PL + i/(n-1)*iw with n=1200).
const X_FULL = (i: number) => 56 + (i * 888) / 1199;
const hoverCount = (svg: string) => (svg.match(/fill="transparent"/g) || []).length;
const dotCount = (svg: string) => (svg.match(/r="2\.5"/g) || []).length;
const bandCount = (svg: string) => (svg.match(/opacity="0\.35"/g) || []).length;

const detailFetch = (payload: unknown) => async (url: string) => {
    if (String(url).includes("/__bili/sessions/big-1/detail")) return { ok: true, status: 200, json: async () => payload };
    return { ok: false, status: 503, json: async () => ({ error: "stub" }) };
};
const rejectFetch = async () => ({ ok: false, status: 503, json: async () => ({ error: "stub" }) });

test("#3484: golden — unzoomed hit-rate SVG is byte-stable", () => {
    const h = runWebClient({ hash: "#/", fetchImpl: rejectFetch });
    const fn = h.window.bili_hitSvg;
    assert.equal(typeof fn, "function", "window.bili_hitSvg test seam missing");
    const fx = smallFixture();
    const svg = (fn as HitSvgFn)(fx.lines, fx.folds, seamEventsOf(fx.seam));
    const golden = readFileSync(join(import.meta.dirname, "golden", "web-hitrate", "small-full.svg"), "utf8");
    assert.equal(svg, golden, "renderer output drifted from the golden — regenerate via scripts/update-web-hitrate-golden.ts and justify the change in the PR");
});

test("#3484: hit-rate cause dots match the ledger classification and the trajectory bands", () => {
    const h = runWebClient({ hash: "#/", fetchImpl: rejectFetch });
    const hitSvg = h.window.bili_hitSvg as HitSvgFn;
    const trajSvg = h.window.bili_trajSvg as TrajSvgFn;
    const causes = h.window.bili_causes as CausesFn;
    assert.equal(typeof causes, "function", "window.bili_causes test seam missing");
    const fx = bigFixture();
    const seams = seamEventsOf(fx.seam);
    const list = causes(fx.lines, fx.folds);
    assert.equal(list.length, fx.lines.length);
    // Each fixture fold lands exactly on a sample boundary, so BOTH flanking
    // lines fire the opener heuristic (re-arming the 3-round tail counter):
    // 5 comp claims per fold × 4 folds. No cold (line 0 carries cache here),
    // no warm resets (fixture lines have no hitPct field).
    const nonNew = list.filter((c) => c !== "new");
    assert.deepEqual(nonNew, Array(20).fill("comp"));
    assert.equal(list[100], "comp");
    assert.equal(list[105], "new", "tail counter retired after its window");
    const hv = hitSvg(fx.lines, fx.folds, seams);
    const tv = trajSvg(fx.lines, fx.folds, 0, fx.systemPromptTokens, seams);
    assert.equal(dotCount(hv), nonNew.length, "one dot per classified sample");
    assert.equal(bandCount(tv), nonNew.length, "trajectory bands stay in lockstep with the same classification");
    // Hover columns carry the same per-sample numbers in both charts.
    assert.ok(hv.includes("hit 97.0%"), "steady-state samples read their rate");
});

test("#3484: hit-rate chart binds, zooms, and resets like the trajectory chart", async () => {
    const fx = bigFixture();
    const h = runWebClient({ hash: "#/session/big-1", fetchImpl: detailFetch(bigDetailPayload(fx)) });
    await waitFor(() => {
        const c = h.els.get("hit-chart");
        return c !== undefined && c.innerHTML.includes("<svg") && h.els.has("hit-status");
    });
    const chart = h.els.get("hit-chart");
    const status = h.els.get("hit-status");
    const hitSvg = h.window.bili_hitSvg as HitSvgFn;
    assert.ok(chart && status, "chart/status elements created during detail binding");
    const fullSvg = chart.innerHTML;
    assert.equal(fullSvg, hitSvg(fx.lines, fx.folds, seamEventsOf(fx.seam)), "default view must equal a direct renderer call on the same inputs");
    assert.equal(hoverCount(fullSvg), 1200);
    assert.ok(status.hidden);

    chart.dispatch("mousedown", { clientX: X_FULL(400), clientY: 100, button: 0 });
    h.document.dispatch("mousemove", { clientX: X_FULL(460), clientY: 100 });
    assert.equal(chart.children.length, 1, "brush overlay appears during the drag");
    assert.equal(chart.children[0].className, "chart-brush");
    assert.ok(parseFloat(chart.children[0].style.width) > 0, "overlay spans the selection");
    h.document.dispatch("mouseup", { clientX: X_FULL(520), clientY: 100 });
    let svg = chart.innerHTML;
    assert.notEqual(svg, fullSvg, "zoom re-rendered the chart");
    assert.equal(hoverCount(svg), 121, "only the selected samples remain");
    assert.ok(!status.hidden);
    assert.ok(status.innerHTML.includes("View #401-#521"), status.innerHTML);
    assert.ok(status.innerHTML.includes('id="hit-reset"'));

    // Reset — button.
    const resetBtn = h.els.get("hit-reset");
    assert.ok(resetBtn, "reset button rendered in the status row");
    resetBtn.dispatch("click");
    assert.equal(chart.innerHTML, fullSvg);
    assert.ok(status.hidden);

    // Reset — double-click.
    chart.dispatch("mousedown", { clientX: X_FULL(400), clientY: 100, button: 0 });
    h.document.dispatch("mouseup", { clientX: X_FULL(520), clientY: 100 });
    chart.dispatch("dblclick");
    assert.equal(chart.innerHTML, fullSvg);

    // Reset — Esc.
    chart.dispatch("mousedown", { clientX: X_FULL(400), clientY: 100, button: 0 });
    h.document.dispatch("mouseup", { clientX: X_FULL(520), clientY: 100 });
    h.document.dispatch("keydown", { key: "Escape" });
    assert.equal(chart.innerHTML, fullSvg);

    // Too-narrow selection (<5 samples) is ignored.
    chart.dispatch("mousedown", { clientX: X_FULL(500), clientY: 100, button: 0 });
    h.document.dispatch("mouseup", { clientX: X_FULL(502), clientY: 100 });
    assert.equal(chart.innerHTML, fullSvg);

    // Full-width drag is ignored (nothing to gain).
    chart.dispatch("mousedown", { clientX: X_FULL(0), clientY: 100, button: 0 });
    h.document.dispatch("mouseup", { clientX: X_FULL(1199), clientY: 100 });
    assert.equal(chart.innerHTML, fullSvg);
});
