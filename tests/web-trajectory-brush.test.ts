process.env.TZ = "UTC";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bigFixture, bigDetailPayload, seamEventsOf, smallFixture } from "./web-trajectory-fixture.ts";
import { runWebClient, waitFor } from "./web-trajectory-harness.ts";

type TrajSvgFn = (lines: unknown[], folds: unknown[], win: number, baseIn: number, seams: unknown[]) => string;
interface ZoomApi { minSamples: number; idxFromX(x: number, n: number): number; range(): [number, number] | null; }

// Full-view sample x in viewBox units (PL + i/(n-1)*iw with n=1200).
const X_FULL = (i: number) => 56 + (i * 888) / 1199;
const hoverCount = (svg: string) => (svg.match(/fill="transparent"/g) || []).length;
const foldCount = (svg: string) => (svg.match(/<line[^>]*stroke-dasharray="3 3"/g) || []).length;
const seamCount = (svg: string) => (svg.match(/<line[^>]*stroke-width="1\.8"/g) || []).length;

const detailFetch = (payload: unknown) => async (url: string) => {
    if (String(url).includes("/__bili/sessions/big-1/detail")) return { ok: true, status: 200, json: async () => payload };
    return { ok: false, status: 503, json: async () => ({ error: "stub" }) };
};
const rejectFetch = async () => ({ ok: false, status: 503, json: async () => ({ error: "stub" }) });

test("#2489: golden — unzoomed trajectory SVG is byte-stable", () => {
    const h = runWebClient({ hash: "#/", fetchImpl: rejectFetch });
    const seam = h.window.bili_trajSvg;
    assert.equal(typeof seam, "function", "window.bili_trajSvg test seam missing");
    const trajSvg = seam as TrajSvgFn;
    const fx = smallFixture();
    const svg = trajSvg(fx.lines, fx.folds, fx.win, fx.baseIn, seamEventsOf(fx.seam));
    const golden = readFileSync(join(import.meta.dirname, "golden", "web-trajectory", "small-full.svg"), "utf8");
    assert.equal(svg, golden, "renderer output drifted from the golden — regenerate via scripts/update-web-trajectory-golden.ts and justify the change in the PR");
});

test("#2489: brush zoom-to-selection with reset paths", async () => {
    const fx = bigFixture();
    const h = runWebClient({ hash: "#/session/big-1", fetchImpl: detailFetch(bigDetailPayload(fx)) });
    // The stub does not parse innerHTML; traj-chart/traj-status enter the element map when the
    // client itself calls getElementById during loadDetail → bindTrajectoryBrush → trajRender.
    await waitFor(() => {
        const c = h.els.get("traj-chart");
        return c !== undefined && c.innerHTML.includes("<svg") && h.els.has("traj-status");
    });
    const chart = h.els.get("traj-chart");
    const status = h.els.get("traj-status");
    assert.ok(chart && status, "chart/status elements created during detail binding");
    const fullSvg = chart.innerHTML;
    const trajSvg = h.window.bili_trajSvg as TrajSvgFn;
    const zoom = h.window.bili_trajZoom as ZoomApi;
    // range() returns an array from the vm realm — copy into this realm for strict equality.
    const range = (): [number, number] | null => { const r = zoom.range(); return r ? [r[0], r[1]] : null; };

    assert.equal(fullSvg, trajSvg(fx.lines, fx.folds, 0, fx.systemPromptTokens, seamEventsOf(fx.seam)), "default view must equal a direct renderer call on the same inputs");
    assert.equal(hoverCount(fullSvg), 1200);
    assert.equal(foldCount(fullSvg), 4);
    assert.equal(seamCount(fullSvg), 2);
    assert.ok(fullSvg.includes(">1</text>") && fullSvg.includes(">600</text>") && fullSvg.includes(">1200</text>"), "full-view x ticks");
    assert.ok(fullSvg.includes(">480K</text>"), "full-view maxY tick");
    assert.ok(status.hidden);

    chart.dispatch("mousedown", { clientX: X_FULL(400), clientY: 100, button: 0 });
    h.document.dispatch("mousemove", { clientX: X_FULL(460), clientY: 100 });
    assert.equal(chart.children.length, 1, "brush overlay appears during the drag");
    assert.equal(chart.children[0].className, "chart-brush");
    assert.ok(parseFloat(chart.children[0].style.width) > 0, "overlay spans the selection");
    h.document.dispatch("mouseup", { clientX: X_FULL(520), clientY: 100 });
    assert.equal(chart.children.length, 0, "brush overlay removed on release");

    let svg = chart.innerHTML;
    assert.notEqual(svg, fullSvg, "zoom re-rendered the chart");
    assert.deepEqual(range(), [400, 520]);
    assert.equal(hoverCount(svg), 121, "only the selected samples remain");
    assert.ok(svg.includes('width="7.4" height="220"'), "hover columns widened to ~7px");
    assert.ok(!svg.includes(">480K</text>") && svg.includes(">129K</text>"), "maxY recomputed from the visible segment");
    assert.ok(svg.includes(">401</text>") && svg.includes(">461</text>") && svg.includes(">521</text>"), "x ticks re-equispaced over the selection");
    assert.equal(foldCount(svg), 1, "only folds inside the time window remain");
    assert.equal(seamCount(svg), 1, "only seams inside the time window remain");
    assert.ok(svg.includes(">10-01 06:40</text>"), "time axis starts at the selection start");
    assert.ok(!status.hidden);
    assert.ok(status.innerHTML.includes("View #401-#521"), status.innerHTML);
    assert.ok(status.innerHTML.includes("10-01 06:40 \u2192 10-01 08:40"), status.innerHTML);
    assert.ok(status.innerHTML.includes('id="traj-reset"'));

    // Nested zoom inside the zoomed view maps back to absolute indices.
    const X_Z = (i: number) => 56 + i * (888 / 120);
    chart.dispatch("mousedown", { clientX: X_Z(10), clientY: 100, button: 0 });
    h.document.dispatch("mousemove", { clientX: X_Z(20), clientY: 100 });
    h.document.dispatch("mouseup", { clientX: X_Z(30), clientY: 100 });
    svg = chart.innerHTML;
    assert.deepEqual(range(), [410, 430]);
    assert.ok(svg.includes(">411</text>") && svg.includes(">421</text>") && svg.includes(">431</text>"), "nested zoom x ticks");
    assert.equal(foldCount(svg), 0, "no folds inside the nested window");
    assert.equal(seamCount(svg), 1, "the seam at the window edge remains");

    // Reset — button.
    const resetBtn = h.els.get("traj-reset");
    assert.ok(resetBtn, "reset button rendered in the status row");
    resetBtn.dispatch("click");
    assert.equal(chart.innerHTML, fullSvg);
    assert.ok(status.hidden);
    assert.equal(range(), null);

    // Reset — double-click.
    chart.dispatch("mousedown", { clientX: X_FULL(400), clientY: 100, button: 0 });
    h.document.dispatch("mouseup", { clientX: X_FULL(520), clientY: 100 });
    chart.dispatch("dblclick");
    assert.equal(chart.innerHTML, fullSvg);
    assert.equal(range(), null);

    // Reset — Esc.
    chart.dispatch("mousedown", { clientX: X_FULL(400), clientY: 100, button: 0 });
    h.document.dispatch("mouseup", { clientX: X_FULL(520), clientY: 100 });
    h.document.dispatch("keydown", { key: "Escape" });
    assert.equal(chart.innerHTML, fullSvg);
    assert.equal(range(), null);

    // Too-narrow selection (<5 samples) is ignored.
    chart.dispatch("mousedown", { clientX: X_FULL(500), clientY: 100, button: 0 });
    h.document.dispatch("mouseup", { clientX: X_FULL(502), clientY: 100 });
    assert.equal(chart.innerHTML, fullSvg);
    assert.equal(range(), null);

    // Full-width drag is ignored (nothing to gain).
    chart.dispatch("mousedown", { clientX: X_FULL(0), clientY: 100, button: 0 });
    h.document.dispatch("mouseup", { clientX: X_FULL(1199), clientY: 100 });
    assert.equal(chart.innerHTML, fullSvg);
    assert.equal(range(), null);
});

test("#2489: full view passes out-of-sample-range fold/seam marks through unfiltered", async () => {
    const fx = bigFixture();
    const lastAt = fx.lines[fx.lines.length - 1].at;
    const folds = [...fx.folds, { seq: 9999, at: lastAt + 5 * 60_000, S: 7_000 }];
    const seamEvents = [{ seq: 0, at: fx.lines[0].at - 5 * 60_000, hitPct: 33.3, lcpBytes: 1_000, msgIndex: 0, prevMsgs: 1, curMsgs: 2 }, ...fx.seam.events];
    const h = runWebClient({ hash: "#/session/big-1", fetchImpl: detailFetch(bigDetailPayload(fx, { folds, seamEvents })) });
    await waitFor(() => {
        const c = h.els.get("traj-chart");
        return c !== undefined && c.innerHTML.includes("<svg");
    });
    const chart = h.els.get("traj-chart");
    assert.ok(chart, "chart element created during detail binding");
    const svg = chart.innerHTML;
    const trajSvg = h.window.bili_trajSvg as TrajSvgFn;
    assert.equal(svg, trajSvg(fx.lines, folds, 0, fx.systemPromptTokens, seamEvents), "full view must hand every fold/seam to the renderer exactly as pre-#2489 did");
    assert.equal(foldCount(svg), 5, "the late fold still renders (clamped to the right edge)");
    assert.equal(seamCount(svg), 3, "the early seam still renders (clamped to the left edge)");
});
