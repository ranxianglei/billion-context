// Web conflicts banner: the aggregate line must NAME the conflicting
// plugin/mechanism, not just counts (#1206 ledger carries per-event identity;
// the banner used to force users into acp_status to find out WHAT it was).
// #2102: non-plugin kinds (client-native rewrites) get time+detail items too,
// the line splits active vs historical, and non-plugin items are capped so a
// stock ledger doesn't turn the banner into a log dump.
import test from "node:test";
import assert from "node:assert/strict";
import { WEB_CLIENT } from "../src/web/client.ts";

// #2324: bili_conflictLine now localizes its age labels via t(), so the extracted
// slice must reach back to the IIFE top ("use strict") to capture MESSAGES/locale/t.
// In the Node test env localStorage/navigator throw inside the guarded try/catch, so
// locale deterministically defaults to "zh-CN" — assertions below expect zh labels.
const START_MARK = '"use strict";';
const END_MARK = "window.bili_conflictLine = bili_conflictLine;";

type LatestEntry = { kind: string; detail?: string; at?: number; sessionId?: string };
type BannerInput = { events?: number; sessions?: number; active?: number; historical?: number; kinds?: Record<string, number>; latest?: LatestEntry[] };
// #2545: displayOnly/activeConfirmed are additive payload fields from summarizeConflicts.
type SeverityInput = BannerInput & { sibling?: number; suspected?: number; displayOnly?: number; activeConfirmed?: number };
interface Severity { onKey: string; riskKey: string; hasConfirmed: boolean; siblingOnly?: boolean; neutralOnly?: boolean; landed?: boolean; signalN?: number; showHints?: boolean; what: string; active: number; activeConfirmed: number }

// Both helpers share the same extracted slice (they sit together in WEB_CLIENT);
// the slice ends at the first window.* export so no `window` reference runs under Node.
function _extract(): { line: (c: BannerInput) => string; severity: (c: SeverityInput) => Severity; dismissed: (c: { events: number; lastAt?: number | null }, stored: unknown) => boolean } {
    const s = WEB_CLIENT.indexOf(START_MARK);
    const e = WEB_CLIENT.indexOf(END_MARK);
    assert.ok(s >= 0 && e > s, "conflict-banner helpers missing from WEB_CLIENT");
    const src = WEB_CLIENT.slice(s, e) + "\nreturn { line: bili_conflictLine, severity: bili_conflictSeverity, dismissed: bili_conflictDismissed };";
    return new Function(src)() as { line: (c: BannerInput) => string; severity: (c: SeverityInput) => Severity; dismissed: (c: { events: number; lastAt?: number | null }, stored: unknown) => boolean };
}
function bannerLine(): (c: BannerInput) => string { return _extract().line; }
function bannerSeverity(): (c: SeverityInput) => Severity { return _extract().severity; }

test("banner line shows FULL identity (client: entry + source), dedupe, weights, suspected marker (#2045)", () => {
    const f = bannerLine();
    const out = f({
        events: 40, sessions: 23,
        kinds: { "third-party-plugin": 40 },
        latest: [
            { kind: "third-party-plugin", detail: "pi: npm:billion-context-pi (/home/dog/.pi/agent/settings.json)" },
            { kind: "third-party-plugin", detail: "pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]" },
            { kind: "third-party-plugin", detail: "pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]" },
            { kind: "third-party-plugin", detail: "opencode: opencode-acp (~/.config/opencode/opencode.json)" },
        ],
    });
    assert.equal(out,
        "40 event(s) in 23 session(s): third-party-plugin×40 — pi: npm:billion-context-pi (/home/dog/.pi/agent/settings.json) · pi: npm:context-forge (/home/dog/.pi/agent/settings.json) [suspected]×2 · opencode: opencode-acp (~/.config/opencode/opencode.json)");
});

test("banner line escapes HTML across the full detail incl. source path", () => {
    const f = bannerLine();
    const out = f({
        events: 1, sessions: 1, kinds: { "third-party-plugin": 1 },
        latest: [{ kind: "third-party-plugin", detail: "pi: npm:a<b&c (settings.json)" }],
    });
    assert.equal(out, "1 event(s) in 1 session(s): third-party-plugin×1 — pi: npm:a&lt;b&amp;c (settings.json)");
});

test("banner line lists ALL distinct plugin entries without truncation (#2045: 显示全尽量)", () => {
    const f = bannerLine();
    const latest = ["a-one", "a-two", "a-three", "a-four", "a-five"].map((n) => ({
        kind: "third-party-plugin" as const, detail: `pi: ${n} (/tmp/settings.json)`,
    }));
    const out = f({ events: 5, sessions: 5, kinds: { "third-party-plugin": 5 }, latest });
    assert.equal(out,
        "5 event(s) in 5 session(s): third-party-plugin×5 — pi: a-one (/tmp/settings.json) · pi: a-two (/tmp/settings.json) · pi: a-three (/tmp/settings.json) · pi: a-four (/tmp/settings.json) · pi: a-five (/tmp/settings.json)");
});

test("banner line degrades gracefully: no latest keeps the count-only shape", () => {
    const f = bannerLine();
    assert.equal(
        f({ events: 39, sessions: 22, kinds: { "third-party-plugin": 39 } }),
        "39 event(s) in 22 session(s): third-party-plugin×39");
});

test("banner line names non-plugin kinds with time + short session id + detail (#2102)", () => {
    const f = bannerLine();
    const out = f({
        events: 2, sessions: 1, kinds: { "native-compaction": 1, "unannounced-rewrite": 1 },
        latest: [
            { kind: "native-compaction", at: Date.UTC(2026, 9, 3, 5, 2), sessionId: "abcdef123456", detail: "codex: compaction_trigger item" },
            { kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 4, 58), sessionId: "fedcba654321", detail: "history rewrite without marker" },
        ],
    });
    assert.equal(out,
        "2 event(s) in 1 session(s): native-compaction×1, unannounced-rewrite×1 — [2026-10-03 05:02Z] abcde…: codex: compaction_trigger item · [2026-10-03 04:58Z] fedcb…: history rewrite without marker");
});

test("banner line omits the session id for short ids and truncates long details (#2102)", () => {
    const f = bannerLine();
    const longDetail = "x".repeat(70);
    const out = f({
        events: 1, sessions: 1, kinds: { "unannounced-rewrite": 1 },
        latest: [{ kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 5, 2), sessionId: "short1", detail: longDetail }],
    });
    const expectedDetail = longDetail.slice(0, 57) + "...";
    assert.equal(out,
        "1 event(s) in 1 session(s): unannounced-rewrite×1 — [2026-10-03 05:02Z]: " + expectedDetail);
});

test("banner line appends the active/historical split when present, degrades when absent (#2102)", () => {
    const f = bannerLine();
    const base = {
        events: 22, sessions: 6,
        kinds: { "unannounced-rewrite": 22 },
        latest: [
            { kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 5, 2), sessionId: "abcdef123456", detail: "d1" },
            { kind: "unannounced-rewrite", at: Date.UTC(2026, 9, 3, 4, 58), sessionId: "abcdef123456", detail: "d1" },
        ],
    };
    // Non-plugin item NAMES carry their own timestamp ([time] sid: detail), so
    // entries at distinct times stay separate rows — each row keeps its "when"
    // (the whole point of #2102 sub-problem ①). The ×N weight only collapses
    // identity-only names (plugin entries), never time-stamped ones.
    // #2324: the split is now localized record-recency labels (zh-CN under the
    // Node test env), not "N active / M historical" which read as liveness.
    const withSplit = f({ ...base, active: 0, historical: 22 });
    assert.equal(withSplit,
        "22 event(s) in 6 session(s): unannounced-rewrite×22 · 近 7 天 0 条 · 更早 22 条 — [2026-10-03 05:02Z] abcde…: d1 · [2026-10-03 04:58Z] abcde…: d1");
    const withoutSplit = f(base);
    assert.equal(withoutSplit.indexOf("近 7 天"), -1, "payloads without active/historical emit no age split at all");
    assert.equal(withoutSplit,
        "22 event(s) in 6 session(s): unannounced-rewrite×22 — [2026-10-03 05:02Z] abcde…: d1 · [2026-10-03 04:58Z] abcde…: d1");
});

test("banner line caps NON-plugin items at 4 with a stats pointer; plugin items stay uncapped (#2102)", () => {
    const f = bannerLine();
    const t0 = Date.UTC(2026, 9, 3, 5);
    const latest: LatestEntry[] = [
        ...["p1", "p2", "p3", "p4", "p5", "p6"].map((n) => ({ kind: "third-party-plugin", detail: `pi: ${n} (/tmp/settings.json)` })),
        { kind: "unannounced-rewrite", at: t0, sessionId: "aaaa1111bbbb", detail: "np-one" },
        { kind: "unannounced-rewrite", at: t0 + 60000, sessionId: "cccc2222dddd", detail: "np-two" },
        { kind: "unannounced-rewrite", at: t0 + 120000, sessionId: "eeee3333ffff", detail: "np-three" },
        { kind: "unannounced-rewrite", at: t0 + 180000, sessionId: "gggg4444hhhh", detail: "np-four" },
        { kind: "unannounced-rewrite", at: t0 + 240000, sessionId: "iiii5555jjjj", detail: "np-five" },
    ];
    const out = f({ events: 11, sessions: 7, kinds: { "third-party-plugin": 6, "unannounced-rewrite": 5 }, latest });
    assert.equal(out,
        "11 event(s) in 7 session(s): third-party-plugin×6, unannounced-rewrite×5 — pi: p1 (/tmp/settings.json) · pi: p2 (/tmp/settings.json) · pi: p3 (/tmp/settings.json) · pi: p4 (/tmp/settings.json) · pi: p5 (/tmp/settings.json) · pi: p6 (/tmp/settings.json) · [2026-10-03 05:00Z] aaaa1…: np-one · [2026-10-03 05:01Z] cccc2…: np-two · [2026-10-03 05:02Z] eeee3…: np-three · [2026-10-03 05:03Z] gggg4…: np-four · …+1 more (the conflicts field of GET /__bili/stats)");
});

// #2324: the banner's title/risk selection must NEVER treat name-only [suspected] matches
// as confirmed compressors. Assert on the i18n KEYS (locale-independent) so this pins the
// decision logic regardless of zh/en wording.
test("#2324 suspected-only ledger -> soft 'verify first' framing, no confirmed-conflict warning", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 96, sessions: 96, kinds: { "third-party-plugin": 96 }, sibling: 0, suspected: 96, active: 96, historical: 0 });
    assert.strictEqual(r.hasConfirmed, false);
    assert.strictEqual(r.onKey, "conflict.on_suspected");
    assert.strictEqual(r.riskKey, "conflict.risk_suspected");
    assert.strictEqual(r.active, 96);
    assert.ok(!r.siblingOnly, "#2430: non-sibling ledgers must never set siblingOnly");
});

test("#2324 confirmed third-party plugin keeps the double-compression warning (active)", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 10, kinds: { "third-party-plugin": 10 }, suspected: 0, active: 5, historical: 5 });
    assert.strictEqual(r.hasConfirmed, true);
    assert.strictEqual(r.onKey, "conflict.on");
    assert.strictEqual(r.riskKey, "conflict.risk_active");
});

test("#2324 confirmed plugin with only historical stock -> risk_historical", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 4, kinds: { "third-party-plugin": 4 }, suspected: 0, active: 0, historical: 4 });
    assert.strictEqual(r.hasConfirmed, true);
    assert.strictEqual(r.riskKey, "conflict.risk_historical");
});

test("#2324 sibling-only -> stands-down framing, not a confirmed conflict (#2261 preserved)", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 3, kinds: { "third-party-plugin": 3 }, sibling: 3, suspected: 0, active: 3 });
    assert.strictEqual(r.hasConfirmed, false);
    assert.strictEqual(r.onKey, "conflict.on");
    assert.strictEqual(r.riskKey, "conflict.risk_sibling");
    // #2430: pure-sibling ledgers stand down completely — the banner hides on this flag.
    assert.strictEqual(r.siblingOnly, true);
});

test("#2324 mixed suspected+confirmed -> strong warning retained while naming both families", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 10, kinds: { "third-party-plugin": 10 }, sibling: 0, suspected: 6, active: 10 });
    assert.strictEqual(r.hasConfirmed, true, "a single confirmed event keeps the imperative warning");
    assert.strictEqual(r.riskKey, "conflict.risk_active");
    assert.ok(r.what.length > 0, "families named");
});

test("#2324/#2912 native-compaction-only (recovered) ledger stands down silently — no alarm", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 7, kinds: { "native-compaction": 7 }, active: 7 });
    // #2912: a marker-detected landing is by construction already rebased onto (#2372/#2432),
    // so a pure-recovered ledger is handled stock, not confirmed evidence — the banner hides.
    assert.strictEqual(r.hasConfirmed, false);
    assert.strictEqual(r.neutralOnly, true, "fully-handled ledger stands down (banner hidden)");
});

test("#2324 old payload without c.suspected degrades to the previous all-confirmed view", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 96, sessions: 96, kinds: { "third-party-plugin": 96 }, active: 96 });
    assert.strictEqual(r.hasConfirmed, true);
    assert.strictEqual(r.riskKey, "conflict.risk_active");
});

// #2545: unannounced rewrites / orphan reaps are UNCONFIRMED signals — they must
// never count as confirmed native evidence, verified read-only viewers are neutral,
// and liveness follows the confirmed tier, not any fresh event.

test("#2545 the issue's exact aggregate: rewrite ×1 + suspected inspector ×2 across 3 sessions -> unconfirmed diagnosis", () => {
    const sev = bannerSeverity();
    const r = sev({
        events: 3, sessions: 3,
        kinds: { "unannounced-rewrite": 1, "third-party-plugin": 2 },
        sibling: 0, suspected: 2, displayOnly: 2,
        active: 1, historical: 2, activeConfirmed: 0,
    });
    assert.strictEqual(r.hasConfirmed, false, "no confirmed compressor evidence in this mix");
    assert.strictEqual(r.onKey, "conflict.on_unconfirmed");
    assert.strictEqual(r.riskKey, "conflict.risk_unconfirmed");
    assert.ok(r.what.length > 0, "names the observed-rewrite family");
    assert.ok(!r.neutralOnly, "a genuine rewrite signal keeps the banner visible");
});

test("#2545 display-only-only ledger stands down completely (banner hidden via neutralOnly)", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 2, kinds: { "third-party-plugin": 2 }, sibling: 0, suspected: 2, displayOnly: 2, active: 2 });
    assert.strictEqual(r.hasConfirmed, false);
    assert.strictEqual(r.siblingOnly, false, "display-only records are not siblings");
    assert.strictEqual(r.neutralOnly, true, "verified read-only viewers are not conflicts");
});

test("#2545 a lone unannounced-rewrite was escalated to a confirmed warning before — now unconfirmed", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 1, sessions: 1, kinds: { "unannounced-rewrite": 1 }, active: 1 });
    assert.strictEqual(r.hasConfirmed, false);
    assert.strictEqual(r.onKey, "conflict.on_unconfirmed");
    assert.strictEqual(r.riskKey, "conflict.risk_unconfirmed");
});

test("#2545/#2912 recovered native-compaction + rewrite: no longer confirmed stock — the rewrite drives the unconfirmed tier", () => {
    const sev = bannerSeverity();
    // #2912: the marker-detected landing is handled stock (rebased onto), so it no longer
    // lights the confirmed tier; only the observed rewrite remains, at the unconfirmed level.
    const stale = sev({
        events: 2, sessions: 2,
        kinds: { "native-compaction": 1, "unannounced-rewrite": 1 },
        active: 2, historical: 0, activeConfirmed: 0,
    });
    assert.strictEqual(stale.hasConfirmed, false, "recovered native-compaction is no longer confirmed evidence");
    assert.strictEqual(stale.onKey, "conflict.on_unconfirmed");
    assert.strictEqual(stale.riskKey, "conflict.risk_unconfirmed");

    const fresh = sev({
        events: 2, sessions: 2,
        kinds: { "native-compaction": 1, "unannounced-rewrite": 1 },
        active: 2, historical: 0, activeConfirmed: 1,
    });
    assert.strictEqual(fresh.hasConfirmed, false);
    assert.strictEqual(fresh.riskKey, "conflict.risk_unconfirmed");
});

test("#2545 old payload without displayOnly degrades: stock suspected records keep the soft tier", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 2, kinds: { "third-party-plugin": 2 }, suspected: 2, active: 2 });
    assert.strictEqual(r.hasConfirmed, false);
    assert.strictEqual(r.onKey, "conflict.on_suspected");
    assert.strictEqual(r.riskKey, "conflict.risk_suspected");
    assert.ok(!r.neutralOnly, "without displayOnly data the pre-#2545 soft behavior holds");
});

test("banner wiring: conflicts-banner branch renders bili_conflictLine (drift guard)", () => {
    assert.ok(WEB_CLIENT.includes("window.bili_conflictLine = bili_conflictLine;"), "test seam export present");
    assert.ok(WEB_CLIENT.includes("bili_conflictLine(c)"), "banner branch calls the helper");
    const occurrences = WEB_CLIENT.split(" event(s) in ").length - 1;
    assert.equal(occurrences, 1, "'event(s) in' phrasing lives only inside bili_conflictLine");
});

test("#2709 inferred native-compaction landing counts as CONFIRMED, not an unconfirmed signal", () => {
    const sev = bannerSeverity();
    // inferred-only must reach the confirmed-native tier (client mirror of the server ladder)
    const inferred = sev({ events: 2, sessions: 1, active: 2, historical: 0, kinds: { "native-compaction-inferred": 2 }, latest: [{ kind: "native-compaction-inferred", detail: "framing absent [inferred]" }] });
    assert.strictEqual(inferred.hasConfirmed, true);
    assert.strictEqual(inferred.onKey, "conflict.on");
    assert.strictEqual(inferred.riskKey, "conflict.risk_active");
    // contrast: a plain unannounced rewrite stays UNCONFIRMED (no false positive)
    const unannounced = sev({ events: 2, sessions: 1, active: 2, historical: 0, kinds: { "unannounced-rewrite": 2 }, latest: [{ kind: "unannounced-rewrite", detail: "x/y incoming carry pre-turn refs" }] });
    assert.strictEqual(unannounced.hasConfirmed, false);
    assert.strictEqual(unannounced.onKey, "conflict.on_unconfirmed");
    assert.strictEqual(unannounced.riskKey, "conflict.risk_unconfirmed");
});

test("#2969 suspected-only ledger -> no imperative per-client hints (showHints false)", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 3, sessions: 3, kinds: { "third-party-plugin": 3 }, sibling: 0, suspected: 3, active: 3 });
    assert.strictEqual(r.onKey, "conflict.on_suspected");
    assert.strictEqual(r.showHints, false, "name-only guesses get verify-first wording, not disable/restart commands");
});

test("#2969 confirmed and unconfirmed-signal ledgers keep the per-client hints (showHints true)", () => {
    const sev = bannerSeverity();
    const confirmed = sev({ events: 2, kinds: { "third-party-plugin": 2 }, suspected: 0, active: 2 });
    assert.strictEqual(confirmed.showHints, true, "confirmed tier keeps imperative remediation");
    const signal = sev({ events: 2, kinds: { "unannounced-rewrite": 2 }, active: 2 });
    assert.strictEqual(signal.showHints, true, "unconfirmed-signal tier keeps the hints (cause may be native compaction)");
    const mixed = sev({ events: 5, kinds: { "third-party-plugin": 3, "unannounced-rewrite": 2 }, sibling: 0, suspected: 3, active: 5 });
    assert.strictEqual(mixed.showHints, true, "a single signal event keeps the hints alongside suspected names");
    const oldPayload = sev({ events: 96, kinds: { "third-party-plugin": 96 }, active: 96 });
    assert.strictEqual(oldPayload.showHints, true, "pre-#2324 payloads degrade to the all-confirmed view WITH hints");
});

// ---------------------------------------------------------------------------
// #3235: the banner is an ALARM for interception failure — only LANDED-
// UNRECOVERED evidence pops. Suspected-tier stock stays recorded but quiet,
// and a persisted dismissal quiets the banner until a newer event re-arms it.

test("#3235 landed tier: suspected-only stock never alarms (landed=false, banner hidden)", () => {
    const sev = bannerSeverity();
    const r = sev({ events: 96, sessions: 96, kinds: { "third-party-plugin": 96 }, sibling: 0, suspected: 96, active: 96, historical: 0 });
    assert.strictEqual(r.hasConfirmed, false);
    assert.strictEqual(r.landed, false, "co-residence alone is not interception failure");
    assert.strictEqual(r.signalN, 0);
});

test("#3235 landed tier: confirmed third-party and inferred-native landings alarm (landed=true)", () => {
    const sev = bannerSeverity();
    const tp = sev({ events: 10, kinds: { "third-party-plugin": 10 }, suspected: 0, active: 5 });
    assert.strictEqual(tp.landed, true);
    const inferred = sev({ events: 4, kinds: { "native-compaction-inferred": 4 }, active: 4 });
    assert.strictEqual(inferred.hasConfirmed, true, "inferred native landing is confirmed-class evidence");
    assert.strictEqual(inferred.landed, true);
});

test("#3235 landed tier: recovered-only ledger stays quiet; a rewrite signal alone alarms", () => {
    const sev = bannerSeverity();
    const recovered = sev({ events: 7, kinds: { "native-compaction": 7 }, active: 7 });
    assert.strictEqual(recovered.landed, false, "intercepted+rebased is interception SUCCESS — no alarm");
    const rewrite = sev({ events: 1, kinds: { "unannounced-rewrite": 1 }, active: 1 });
    assert.strictEqual(rewrite.signalN, 1);
    assert.strictEqual(rewrite.landed, true, "an observed history rewrite is a landed event by definition");
});

test("#3235 banner gate + dismiss + report buttons wired in the client source", () => {
    assert.ok(WEB_CLIENT.includes("sev0.landed && !dismissed"), "gate requires landed-unrecovered evidence and no live dismissal");
    assert.ok(WEB_CLIENT.includes('id="conflicts-dismiss-btn"'), "dismiss button rendered on the banner");
    assert.ok(WEB_CLIENT.includes('t("conflict.dismiss")'), "dismiss button localized");
    assert.ok(WEB_CLIENT.includes('attachReportButtons("conflict-banner", cb)'), "banner rides the #3040 report wiring");
    assert.ok(WEB_CLIENT.includes("biliConflictDismiss"), "dismissal watermark persisted in localStorage");
});

test("#3235 dismissal watermark: hides only while no newer event exists", () => {
    const d = _extract().dismissed;
    // nothing stored -> banner shows
    assert.strictEqual(d({ events: 4, lastAt: 200 }, null), false);
    assert.strictEqual(d({ events: 4, lastAt: 200 }, "garbage"), false);
    assert.strictEqual(d({ events: 4, lastAt: 200 }, { lastAt: "x", events: 4 }), false);
    // same watermark -> dismissed
    assert.strictEqual(d({ events: 4, lastAt: 200 }, { lastAt: 200, events: 4 }), true);
    // fewer events now (ledger cleared) -> stays dismissed
    assert.strictEqual(d({ events: 0, lastAt: 0 }, { lastAt: 200, events: 4 }), true);
    // NEW event (newer timestamp, more events) -> re-arms the alarm
    assert.strictEqual(d({ events: 5, lastAt: 900 }, { lastAt: 200, events: 4 }), false);
    // lastAt missing on the wire -> fall back to the event count only
    assert.strictEqual(d({ events: 4 }, { lastAt: 200, events: 4 }), true);
    assert.strictEqual(d({ events: 5 }, { lastAt: 200, events: 4 }), false);
});
