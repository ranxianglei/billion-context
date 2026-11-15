import test from "node:test";
import assert from "node:assert/strict";
import { WEB_CLIENT } from "../src/web/client.ts";

// #6729: the recovery card is a LINKED zoom member (drag-select on the trajectory or
// hit-rate chart re-renders it over the same window). The windowed per-round aggregates are
// re-derived client-side from the filtered event slice — these tests exercise exactly that
// path, extracted from the real WEB_CLIENT template literal.

function extractFn(src: string, name: string): string {
    const marker = `function ${name}(`;
    const start = src.indexOf(marker);
    assert.ok(start !== -1, `${name} not found in WEB_CLIENT`);
    const open = src.indexOf("{", start);
    assert.ok(open !== -1, `${name}: no body brace found`);
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    assert.ok(end !== -1, `${name}: unbalanced braces`);
    return src.slice(start, end);
}

const TIP_TEMPLATES: Record<string, string> = {
    "det.rec_bar_n_tip": "round {i}, call {k}/{n} · {at} · folded {s} · round recovery {pct}",
    "det.rec_bar_a_tip": "active compression · {at} · folded {s}",
    "det.rec_line_base": "baseline 100% (fully folded the recommendation)",
    "det.rec_line_over_note": " (over-compression, includes old stock)",
    "det.rec_line_under_note": " (under-compression)",
    "det.rec_bracket_over": " excess old stock {s}",
};
const T = (k: string, p?: Record<string, unknown>): string => {
    const tpl = TIP_TEMPLATES[k] || k;
    let s = tpl;
    if (p) for (const [kk, vv] of Object.entries(p)) s = s.split(`{${kk}}`).join(String(vv));
    return s;
};
const FAKE_W = (n: unknown): string => String(n);
const FAKE_DT = (ms: unknown): string => String(ms);
const FAKE_ESC = (s: unknown): string => String(s);

const recoveryEpisodes = new Function(
    "t", "fmtW", "fmtDT", "escapeHtml",
    `${extractFn(WEB_CLIENT, "recoveryEpisodesFromEvents")}; return recoveryEpisodesFromEvents;`,
)(T, FAKE_W, FAKE_DT, FAKE_ESC) as (events: unknown[]) => {
    eps: Array<{ at: number; tier: number | null; pending: number; folded: number; pct: number | null; credited: number; extra: number; activeFolds: number }>;
    nudges: unknown[];
    folds: unknown[];
    roundOf: (ev: { at: number }) => number;
};

const recoveryRoundSvg = new Function(
    "t", "fmtW", "fmtDT", "escapeHtml", "TRAJ_W", "recoveryEpisodesFromEvents",
    `${extractFn(WEB_CLIENT, "recoveryWindowMeta")}\n${extractFn(WEB_CLIENT, "recoveryRoundSvg")}; return recoveryRoundSvg;`,
)(T, FAKE_W, FAKE_DT, FAKE_ESC, 660, recoveryEpisodes) as (events: unknown[]) => string;

const T0 = 1_760_000_000_000;
const MIN = 60_000;
// n1@T0(pending 100) → f1, f2 burst → n2@T0+10m(pending 200) → f3 → active f4 → n3@T0+20m(pending 0)
// round 3 (pct null) then: n4@T0+30m(pending 100) → f5 310 (OVER-fold: 100 from the list + 210 old stock)
const EVENTS = [
    { at: T0, kind: "n", tier: 1, pending: 100, paired: true },
    { at: T0 + 1 * MIN, kind: "f", S: 60, folded: 60, mode: "n", pct: 60 },
    { at: T0 + 2 * MIN, kind: "f", S: 50, folded: 50, mode: "n", pct: 50 },
    { at: T0 + 10 * MIN, kind: "n", tier: 1, pending: 200, paired: true },
    { at: T0 + 11 * MIN, kind: "f", S: 150, folded: 150, mode: "n", pct: 75 },
    { at: T0 + 12 * MIN, kind: "f", S: 40, folded: 40, mode: "a", pct: null },
    { at: T0 + 20 * MIN, kind: "n", tier: 2, pending: 0, paired: false },
    { at: T0 + 30 * MIN, kind: "n", tier: 1, pending: 100, paired: true },
    { at: T0 + 31 * MIN, kind: "f", S: 310, folded: 310, mode: "n", pct: 310 },
];

test("#6729: full-window episode derivation matches the server-side aggregation", () => {
    const built = recoveryEpisodes(EVENTS);
    assert.equal(built.eps.length, 4);
    // round 1: nudge followed by BOTH burst folds until the next nudge
    assert.deepEqual({ at: built.eps[0].at, p: built.eps[0].pending, f: built.eps[0].folded, pct: built.eps[0].pct, a: built.eps[0].activeFolds },
        { at: T0, p: 100, f: 110, pct: 110, a: 0 });
    // round 2: nudge fold only — the active compression is a marker, never a numerator
    assert.deepEqual({ p: built.eps[1].pending, f: built.eps[1].folded, pct: built.eps[1].pct, a: built.eps[1].activeFolds },
        { p: 200, f: 150, pct: 75, a: 1 });
    // round 3: non-T1 nudge (pending 0) → pct null, not NaN
    assert.equal(built.eps[2].pct, null);
    // tier survives the derivation (the point tip renders it; an inverted ternary
    // once silently nulled every tier)
    assert.deepEqual(built.eps.map((e) => e.tier), [1, 1, 2, 1]);
});

test("#6729: over-100% rounds read against the baseline — extra is old stock, not fake recovery", () => {
    const built = recoveryEpisodes(EVENTS);
    // outstanding pool: only nudge pendings accumulate, folds consume the pool to a floor of 0,
    // anything consumed beyond the pool is older stock the model cleaned on its own (extra).
    // round 1: pool 100, folded 110 → credited 100, extra 10 (folded, not carried forward)
    // round 2: pool 200, folded 150 → credited 150, extra 0, pool left 50
    // round 3: non-T1 pending 0, folded 0 → pool stays 50
    // round 4: pool 50+100=150, folded 310 → credited 150, extra 160
    const last = built.eps[built.eps.length - 1];
    assert.equal(last.pct, 310);           // the TRUE ratio is kept
    assert.equal(last.credited, 150);      // what came from the recommended stock
    assert.equal(last.extra, 160);         // the rest is older stock the model cleaned on its own
    const first = built.eps[0];
    assert.equal(first.credited, 100);
    assert.equal(first.extra, 10);
});

test("#6729: the chart draws the 100% baseline, an extended axis, and the extra as old stock", () => {
    const svg = recoveryRoundSvg(EVENTS);
    assert.ok(svg.includes("baseline 100%"), "100% baseline label present");
    assert.ok(svg.includes('stroke="#57606a"'), "main recovery line present");
    // round 4 (310%) → blue over dot with halo + the true label
    assert.ok(svg.includes('r="7" fill="none" stroke="#0969da"'), "over-100% halo dot");
    assert.ok(svg.includes("310%"), "true >100% value labeled");
    assert.ok(svg.includes("excess old stock"), "bracket shows the extra as old stock");
    assert.ok(svg.includes("(over-compression, includes old stock)"), "point tip marks over-compression");
    // axisMax for maxPct 310 = ceil(341/50)*50 = 350 → the axis extends well past the baseline
    assert.ok(svg.includes("350%"), "axis extends past the baseline (axisMax 350)");
    assert.ok(!svg.includes("400%"), "axis not pushed to the cap for this data");
});

test("#6729: windowed events re-derive per-round aggregates (the linked-zoom path)", () => {
    // makeChartZoom's visible() filters events by [t0, t1]; simulate its output.
    const t0 = T0 + 9 * MIN, t1 = T0 + 13 * MIN;
    const windowed = EVENTS.filter((e) => e.at >= t0 && e.at <= t1);
    const built = recoveryEpisodes(windowed);
    assert.equal(built.eps.length, 1);
    assert.equal(built.eps[0].at, T0 + 10 * MIN);
    assert.equal(built.eps[0].folded, 150);
    assert.equal(built.eps[0].pct, 75);
    assert.equal(built.eps[0].activeFolds, 1);
    const svg = recoveryRoundSvg(windowed);
    assert.match(svg, /75\.0%/);
    // the active fold still draws (blue bar) even though it is not a round numerator
    assert.match(svg, /#0969da/);
});

test("#6729: a window with only an active fold renders a chart with no round points", () => {
    const windowed = EVENTS.filter((e) => e.at >= T0 + 11.5 * MIN && e.at <= T0 + 12.5 * MIN);
    const built = recoveryEpisodes(windowed);
    assert.equal(built.eps.length, 0);
    const svg = recoveryRoundSvg(windowed);
    assert.ok(svg.startsWith("<svg"));
    // no round-point circles (grid tick labels still say 25% etc., so target the point marks)
    assert.doesNotMatch(svg, /r=\"4\.5\"/);
    assert.match(svg, /#0969da/);         // the active bar is still visible
});

test("#6729: a fold before the first visible nudge lands in the synthetic open round (no fake %)", () => {
    // window starts AFTER the first nudge: those early folds have no nudge in the window
    // (the window filter also drops pre-window nudges), so they form the synthetic open round
    const windowed = EVENTS.filter((e) => e.at >= T0 + 1 * MIN && e.at <= T0 + 3 * MIN);
    const svg = recoveryRoundSvg(windowed);
    assert.doesNotMatch(svg, /r=\"4\.5\"/);       // no round points
    // tooltip must not claim a round number that does not exist in the window:
    // the open round is numbered 0, no other round appears
    assert.match(svg, /round 0, call 1\/2/);
    assert.match(svg, /round 0, call 2\/2/);
    assert.doesNotMatch(svg, /round 1, call /);
});

test("#6729: empty window returns empty string (the render callback contract)", () => {
    assert.equal(recoveryRoundSvg([]), "");
    assert.equal(recoveryRoundSvg([null, undefined] as unknown[]), "");
});

test("#6729: client wires the recovery chart into the detail-chart brush link", () => {
    // the card HTML: honest header in a div (never inside the SVG), status row, zoom target
    assert.match(WEB_CLIENT, /parts\.push\(recoveryHeadHtml\(recLine\)\)/);
    assert.match(WEB_CLIENT, /id=\\"?rec-chart\\"?|id="rec-chart"/);
    // third linked member with the same detailChartLink
    assert.match(WEB_CLIENT, /const recZoom = makeChartZoom\(\{ elId: "rec-chart", statusId: "rec-status", resetId: "rec-reset", link: detailChartLink/);
    // render callback consumes the 4th (recovery) parameter visible() provides
    assert.match(WEB_CLIENT, /render: \(lines, folds, seams, recovery\) => \(recovery && recovery\.events && recovery\.events\.length\) \? recoveryRoundSvg\(recovery\.events\) : ""/);
    // bound on the same code path as the trajectory/hit-rate charts
    assert.match(WEB_CLIENT, /bindRecoveryChart\(d\);/);
    // the in-SVG header text is gone (it collided with the first nudge flag's label):
    // no text element at y=14 anywhere inside recoveryRoundSvg
    const fn = extractFn(WEB_CLIENT, "recoveryRoundSvg");
    assert.doesNotMatch(fn, /y="14"/);
});
