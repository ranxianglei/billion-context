// #4317: context trajectory + cache hit-rate trend linkage — brushing EITHER detail
// chart zooms both over the same sample range; resets (button / dblclick / Esc) propagate too.
process.env.TZ = "UTC";
import test from "node:test";
import assert from "node:assert/strict";
import { bigFixture, bigDetailPayload } from "./web-trajectory-fixture.ts";
import { runWebClient, waitFor } from "./web-trajectory-harness.ts";

type HitSvgFn = (lines: unknown[], folds: unknown[], seams: unknown[]) => string;
interface ZoomApi {
    minSamples: number;
    idxFromX(x: number, n: number): number;
    visible(): { lines: unknown[]; folds: unknown[]; seams: unknown[]; offset: number } | null;
    range(): [number, number] | null;
}

// Full-view sample x in viewBox units (PL + i/(n-1)*iw with n=1200).
const X_FULL = (i: number) => 56 + (i * 888) / 1199;
// Zoomed-view sample x for the 121-sample window (absolute 400..520).
const X_Z = (i: number) => 56 + i * (888 / 120);
const hoverCount = (svg: string) => (svg.match(/fill="transparent"/g) || []).length;

const detailFetch = (payload: unknown) => async (url: string) => {
    if (String(url).includes("/__bili/sessions/big-1/detail")) return { ok: true, status: 200, json: async () => payload };
    return { ok: false, status: 503, json: async () => ({ error: "stub" }) };
};

const rangeOf = (z: ZoomApi): [number, number] | null => { const r = z.range(); return r ? [r[0], r[1]] : null; };

test("#4317: brushing either detail chart zooms BOTH over the same sample range", async () => {
    const fx = bigFixture();
    const h = runWebClient({ hash: "#/session/big-1", fetchImpl: detailFetch(bigDetailPayload(fx)) });
    await waitFor(() => {
        const t = h.els.get("traj-chart"), c = h.els.get("hit-chart");
        return t !== undefined && c !== undefined && t.innerHTML.includes("<svg") && c.innerHTML.includes("<svg");
    });
    const traj = h.els.get("traj-chart");
    const hit = h.els.get("hit-chart");
    const trajStatus = h.els.get("traj-status");
    const hitStatus = h.els.get("hit-status");
    assert.ok(traj && hit && trajStatus && hitStatus, "both charts bound during detail load");
    assert.equal(typeof h.window.bili_hitZoom, "object", "window.bili_hitZoom test seam missing");
    const trajZoom = h.window.bili_trajZoom as ZoomApi;
    const hitZoom = h.window.bili_hitZoom as ZoomApi;
    const hitSvg = h.window.bili_hitSvg as HitSvgFn;
    const fullTraj = traj.innerHTML;
    const fullHit = hit.innerHTML;

    // Selection on the trajectory chart → the hit-rate chart follows over the same samples.
    traj.dispatch("mousedown", { clientX: X_FULL(400), clientY: 100, button: 0 });
    h.document.dispatch("mousemove", { clientX: X_FULL(460), clientY: 100 });
    h.document.dispatch("mouseup", { clientX: X_FULL(520), clientY: 100 });
    assert.deepEqual(rangeOf(trajZoom), [400, 520]);
    assert.deepEqual(rangeOf(hitZoom), [400, 520], "hit-rate chart follows the trajectory selection");
    const hv = hitZoom.visible();
    assert.ok(hv, "linked peer exposes the visible slice");
    assert.equal(hoverCount(hit.innerHTML), 121, "hit-rate chart re-rendered over the same slice");
    assert.equal(hit.innerHTML, hitSvg(hv.lines, hv.folds, hv.seams), "hit-rate view equals the renderer on its own visible slice");
    assert.ok(!hitStatus.hidden);
    assert.ok(hitStatus.innerHTML.includes("View #401-#521"), hitStatus.innerHTML);
    assert.ok(!trajStatus.hidden, "trajectory status row stays in sync");

    // Selection on the hit-rate chart → the trajectory chart follows (nested zoom maps to absolute indices).
    hit.dispatch("mousedown", { clientX: X_Z(10), clientY: 100, button: 0 });
    h.document.dispatch("mousemove", { clientX: X_Z(20), clientY: 100 });
    h.document.dispatch("mouseup", { clientX: X_Z(30), clientY: 100 });
    assert.deepEqual(rangeOf(hitZoom), [410, 430]);
    assert.deepEqual(rangeOf(trajZoom), [410, 430], "trajectory chart follows the hit-rate selection");
    assert.equal(hoverCount(traj.innerHTML), 21, "trajectory re-rendered over the same nested slice");

    // Reset through one chart's button restores BOTH to their full renders.
    const resetBtn = h.els.get("traj-reset");
    assert.ok(resetBtn, "reset button rendered in the trajectory status row");
    resetBtn.dispatch("click");
    assert.equal(traj.innerHTML, fullTraj);
    assert.equal(hit.innerHTML, fullHit, "hit-rate chart restored to its unzoomed render");
    assert.ok(trajStatus.hidden && hitStatus.hidden, "both status rows clear together");
    assert.equal(rangeOf(trajZoom), null);
    assert.equal(rangeOf(hitZoom), null);

    // Selection on the hit chart again, then Esc resets BOTH.
    hit.dispatch("mousedown", { clientX: X_FULL(400), clientY: 100, button: 0 });
    h.document.dispatch("mouseup", { clientX: X_FULL(520), clientY: 100 });
    assert.deepEqual(rangeOf(trajZoom), [400, 520], "a hit-chart selection propagates back to the trajectory chart");
    h.document.dispatch("keydown", { key: "Escape" });
    assert.equal(traj.innerHTML, fullTraj);
    assert.equal(hit.innerHTML, fullHit);
    assert.equal(rangeOf(trajZoom), null);
    assert.equal(rangeOf(hitZoom), null);

    // A rejected (too-narrow) selection leaves BOTH at full view.
    traj.dispatch("mousedown", { clientX: X_FULL(500), clientY: 100, button: 0 });
    h.document.dispatch("mouseup", { clientX: X_FULL(502), clientY: 100 });
    assert.equal(traj.innerHTML, fullTraj);
    assert.equal(hit.innerHTML, fullHit);
    assert.equal(rangeOf(hitZoom), null, "a rejected selection never reaches the linked peer");
});

test("#4317: double-click reset on one chart resets the other", async () => {
    const fx = bigFixture();
    const h = runWebClient({ hash: "#/session/big-1", fetchImpl: detailFetch(bigDetailPayload(fx)) });
    await waitFor(() => {
        const t = h.els.get("traj-chart"), c = h.els.get("hit-chart");
        return t !== undefined && c !== undefined && t.innerHTML.includes("<svg") && c.innerHTML.includes("<svg");
    });
    const traj = h.els.get("traj-chart");
    const hit = h.els.get("hit-chart");
    assert.ok(traj && hit, "both charts bound during detail load");
    const trajZoom = h.window.bili_trajZoom as ZoomApi;
    const hitZoom = h.window.bili_hitZoom as ZoomApi;
    const fullTraj = traj.innerHTML;
    const fullHit = hit.innerHTML;

    hit.dispatch("mousedown", { clientX: X_FULL(400), clientY: 100, button: 0 });
    h.document.dispatch("mouseup", { clientX: X_FULL(520), clientY: 100 });
    assert.deepEqual(rangeOf(hitZoom), [400, 520]);
    assert.deepEqual(rangeOf(trajZoom), [400, 520]);
    traj.dispatch("dblclick");
    assert.equal(traj.innerHTML, fullTraj);
    assert.equal(hit.innerHTML, fullHit, "dblclick reset propagates to the linked peer");
    assert.equal(rangeOf(trajZoom), null);
    assert.equal(rangeOf(hitZoom), null);
});
