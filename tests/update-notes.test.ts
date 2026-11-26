// #1870: tiered release-notes visibility. The self-updater is a silent
// courier on native lanes (its "Restart to finish" line only reaches a log
// file), so disk runs new while the process runs old. These tests pin the
// three behaviors that make the fix safe and useful:
//   1. parsing/validation of the remote doc (bad entries skipped, bad doc = error),
//   2. the user-side span + visibility derivation (#1977: silent by
//      default — routine/recommended NEVER surface; only a critical-tier
//      entry does, and a pending restart is announced only when the pending
//      span carries one; clean installs see NOTHING — byte-identical to
//      pre-#1870 output),
//   3. the two surfaces: acp_status section + /acp panel line before the
//      footer (stripper-safe), with remote-doc text escaped for replace().
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import {
    _resetReleaseNotesWatcherForTest,
    _setReleaseNotesStateForTest,
    parseReleaseNotesDoc,
    spanNotes,
    getUpdateVisibility,
    describeUpdateReady,
    updateBannerPayload,
    type ReleaseNoteEntry,
} from "../src/update-notes.ts";
import { VERSION } from "../src/version.ts";
import semver from "semver";

// #1870 follow-up: the two SURFACE tests below exercise the real running
// version (package.json at runtime), so their fixtures must be derived FROM
// it — hardcoded 0.1.18x strings rotted the moment v0.1.180 shipped and put
// master's CI red after the #1870 merge. The explicit-version unit tests
// above keep hardcoded strings (they pin spanNotes logic, not this repo's
// current version).
const RUNNING = semver.valid(VERSION) ?? "0.0.1";
const NEXT = semver.inc(RUNNING, "patch") ?? "0.0.2";
const NEXT2 = semver.inc(NEXT, "patch") ?? "0.0.3";
const SURFACE_ENTRIES: ReleaseNoteEntry[] = [
    { version: NEXT2, tier: "routine", summary: "docs and log polish" },
    { version: NEXT, date: "2026-10-02", tier: "critical", summary: "OpenCode WebSocket traffic intercepted again (#1844)" },
    { version: RUNNING, tier: "recommended", summary: "compression survives restart/resume forks (#1834)" },
];

const ENTRIES: ReleaseNoteEntry[] = [
    { version: "0.1.181", tier: "routine", summary: "docs and log polish" },
    { version: "0.1.180", date: "2026-10-02", tier: "critical", summary: "OpenCode WebSocket traffic intercepted again (#1844)" },
    { version: "0.1.179", tier: "recommended", summary: "compression survives restart/resume forks (#1834)" },
];

test("#1870 parseReleaseNotesDoc: valid doc parses; malformed entries skip; broken doc errors", () => {
    const doc = {
        billionContextReleaseNotes: {
            schema: 1,
            releases: [
                { version: "0.1.181", tier: "routine", summary: "ok" },
                { version: "not-semver", tier: "routine", summary: "skipped" },
                { version: "0.1.180", tier: "urgent", summary: "bad tier skipped" },
                { version: "0.1.179", tier: "routine", summary: "   " },
                { version: "0.1.178", tier: "recommended", date: "2026-10-01", summary: "ok with date" },
                { version: "0.1.177", tier: "critical", date: "2026-10-01", summary: "ok critical accepted (#1977)" },
            ],
        },
    };
    const parsed = parseReleaseNotesDoc(doc);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.entries.length, 3);
    assert.equal(parsed.entries[0].version, "0.1.181");
    assert.equal(parsed.entries[1].date, "2026-10-01");
    assert.equal(parsed.entries[2].tier, "critical", "critical tier accepted (#1977)");

    assert.equal(parseReleaseNotesDoc(null).error, "document is not a JSON object");
    assert.equal(parseReleaseNotesDoc({}).error, "missing billionContextReleaseNotes object");
    assert.equal(parseReleaseNotesDoc({ billionContextReleaseNotes: { schema: 2, releases: [] } }).error, "unsupported schema 2 (supported: 1)");
    assert.equal(parseReleaseNotesDoc({ billionContextReleaseNotes: { schema: 1, releases: "no" } }).error, "releases field is not an array");
    // Entries present but ALL invalid → error (distinguish broken feed from empty).
    const allBad = parseReleaseNotesDoc({ billionContextReleaseNotes: { schema: 1, releases: [{ version: "x", tier: "routine", summary: "s" }] } });
    assert.equal(allBad.error, "no valid release-note entries in document");
    // Empty releases array = legitimate empty feed, not an error.
    assert.deepEqual(parseReleaseNotesDoc({ billionContextReleaseNotes: { schema: 1, releases: [] } }), { entries: [] });
});

test("#1870 spanNotes: strictly-newer entries, ascending (user-side diff), invalid base = none", () => {
    const span = spanNotes(ENTRIES, "0.1.179");
    assert.deepEqual(span.map((e) => e.version), ["0.1.180", "0.1.181"], "excludes the running version itself, oldest first");
    assert.deepEqual(spanNotes(ENTRIES, "0.1.180").map((e) => e.version), ["0.1.181"]);
    assert.deepEqual(spanNotes(ENTRIES, "0.1.181"), [], "up to date → empty span");
    assert.deepEqual(spanNotes(ENTRIES, "0.1.182"), [], "future version → empty span");
    assert.deepEqual(spanNotes(ENTRIES, "garbage"), [], "invalid running version → empty (no crash)");
});

test("#3719 item4 parseReleaseNotesDoc: summaryZh/minVersion/maxVersion optional fields parse + validate", () => {
    const doc = {
        billionContextReleaseNotes: {
            schema: 1,
            releases: [
                { version: "0.1.210", tier: "critical", summary: "en fix", summaryZh: "中文修复" },
                { version: "0.1.211", tier: "critical", summary: "blank zh", summaryZh: "   " },
                { version: "0.1.212", tier: "critical", summary: "bad min", minVersion: "not-semver" },
                { version: "0.1.213", tier: "critical", summary: "inverted range", minVersion: "0.1.200", maxVersion: "0.1.100" },
                { version: "0.1.214", tier: "critical", summary: "floored", minVersion: "0.1.205" },
            ],
        },
    };
    const parsed = parseReleaseNotesDoc(doc);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.entries.length, 3);
    assert.equal(parsed.entries[0].summaryZh, "中文修复");
    assert.equal(parsed.entries[1].summaryZh, undefined, "blank summaryZh is dropped, entry kept");
    assert.ok(!parsed.entries.some((e) => e.version === "0.1.212"), "invalid minVersion skips the entry");
    assert.ok(!parsed.entries.some((e) => e.version === "0.1.213"), "minVersion > maxVersion skips the entry");
    assert.equal(parsed.entries[2].minVersion, "0.1.205");
    assert.equal(parsed.entries[2].summaryZh, undefined, "summaryZh stays unset when absent");
});

test("#3719 item4 spanNotes: [minVersion, maxVersion] targeting on the RUNNING version — inclusive, bidirectional", () => {
    const entries: ReleaseNoteEntry[] = [
        { version: "0.1.210", tier: "critical", summary: "floored", minVersion: "0.1.205" },
        { version: "0.1.211", tier: "critical", summary: "ceilinged", maxVersion: "0.1.204" },
        { version: "0.1.212", tier: "critical", summary: "windowed", minVersion: "0.1.200", maxVersion: "0.1.203" },
        { version: "0.1.213", tier: "critical", summary: "unbounded" },
    ];
    // running 0.1.203: below floor 0.1.205 → hidden; ceiling 0.1.204 above → visible; inside window → visible
    assert.deepEqual(spanNotes(entries, "0.1.203").map((e) => e.version), ["0.1.211", "0.1.212", "0.1.213"]);
    // running 0.1.204: below floor 0.1.205 → hidden; at ceiling → visible; outside window → hidden
    assert.deepEqual(spanNotes(entries, "0.1.204").map((e) => e.version), ["0.1.211", "0.1.213"]);
    // running 0.1.199: below floor → hidden; below window min → hidden
    assert.deepEqual(spanNotes(entries, "0.1.199").map((e) => e.version), ["0.1.211", "0.1.213"]);
    // boundaries are inclusive: running == minVersion still sees the entry
    assert.ok(spanNotes(entries, "0.1.205").some((e) => e.version === "0.1.210"), "running == minVersion stays targeted");
    assert.ok(spanNotes(entries, "0.1.200").some((e) => e.version === "0.1.212"), "running == window min stays targeted");
    // compat negative control: bounds-free entries keep the historic reach for EVERY older version
    assert.equal(spanNotes([{ version: "0.1.190", tier: "routine", summary: "legacy" }], "0.1.100").length, 1, "unset bounds = historic reach");
});

test("#3719 item4 updateBannerPayload: summaryZh rides the wire when the critical carries one; absent stays absent (compat)", () => {
    _resetReleaseNotesWatcherForTest();
    _setReleaseNotesStateForTest({ entries: [{ version: "0.1.210", tier: "critical", summary: "en", summaryZh: "中文" }] });
    const payload = updateBannerPayload(getUpdateVisibility("0.1.209"));
    assert.equal(payload?.kind, "available");
    assert.equal(payload?.summary, "en");
    assert.equal(payload?.summaryZh, "中文");
    _setReleaseNotesStateForTest({ entries: [{ version: "0.1.210", tier: "critical", summary: "en" }], diskVersion: "0.1.210" });
    const ready = updateBannerPayload(getUpdateVisibility("0.1.209"));
    assert.equal(ready?.kind, "ready");
    assert.equal(ready?.summaryZh, undefined, "legacy entries never grow the field");
    _resetReleaseNotesWatcherForTest();
});

test("#1977 getUpdateVisibility: silent by default — only critical surfaces; pending restart alone is silent", () => {
    _resetReleaseNotesWatcherForTest();
    try {
        // Clean install: no disk info, no span → invisible (byte-identical surfaces).
        const clean = getUpdateVisibility(VERSION);
        assert.equal(clean.visible, false);
        assert.equal(clean.pendingRestart, false);
        assert.deepEqual(clean.span, []);

        // #1977 core: routine/recommended-only span (span from 0.1.180 =
        // [0.1.181 routine]) → invisible even though an update exists.
        _setReleaseNotesStateForTest({ entries: ENTRIES });
        const recOnly = getUpdateVisibility("0.1.180");
        assert.equal(recOnly.pendingRestart, false);
        assert.equal(recOnly.critical, false);
        assert.equal(recOnly.visible, false, "#1977: recommended/routine alone must NOT surface");
        assert.deepEqual(recOnly.span.map((e) => e.version), ["0.1.181"]);

        // Critical entry in the span (auto-update off) → the one case that
        // surfaces without a restart pending.
        const crit = getUpdateVisibility("0.1.179");
        assert.equal(crit.pendingRestart, false);
        assert.equal(crit.critical, true);
        assert.equal(crit.visible, true, "critical alone must surface (updater may be off)");
        assert.deepEqual(crit.span.map((e) => e.version), ["0.1.180", "0.1.181"]);

        // Disk newer than running + critical in the pending span → the
        // actionable announcement.
        _setReleaseNotesStateForTest({ entries: ENTRIES, diskVersion: "0.1.181" });
        const pending = getUpdateVisibility("0.1.179");
        assert.equal(pending.pendingRestart, true);
        assert.equal(pending.visible, true);

        // #1977: disk newer but the pending span is routine/recommended-only
        // → restart happens naturally, nothing surfaces.
        const pendingQuiet = getUpdateVisibility("0.1.180");
        assert.equal(pendingQuiet.pendingRestart, true);
        assert.equal(pendingQuiet.visible, false, "pending restart with no critical entry stays silent");

        // Disk older or equal (edge: rollback / same) → not pending.
        assert.equal(getUpdateVisibility("0.1.181").pendingRestart, false);
        _setReleaseNotesStateForTest({ entries: ENTRIES, diskVersion: "0.1.175" });
        assert.equal(getUpdateVisibility("0.1.179").pendingRestart, false);
        // Disk version garbage → never pending (fail-closed on visibility, no crash).
        _setReleaseNotesStateForTest({ entries: [], diskVersion: "not-semver" });
        const garbage = getUpdateVisibility("0.1.179");
        assert.equal(garbage.pendingRestart, false);
        assert.equal(garbage.visible, false);
    } finally {
        _resetReleaseNotesWatcherForTest();
    }
});

test("#1977 describeUpdateReady: critical wording + byte-stability", () => {
    _resetReleaseNotesWatcherForTest();
    try {
        _setReleaseNotesStateForTest({ entries: ENTRIES, diskVersion: "0.1.181" });
        const pending = getUpdateVisibility("0.1.179");
        const line = describeUpdateReady(pending);
        assert.ok(line.startsWith("Critical update ready: 0.1.181 — restart to finish."), `pending-restart wording (got: ${line})`);
        assert.ok(line.includes("#1844"), "top critical summary carried");
        assert.equal(line, describeUpdateReady(getUpdateVisibility("0.1.179")), "byte-stable for identical state");
        assert.deepEqual(updateBannerPayload(pending), { kind: "ready", version: "0.1.181", summary: "OpenCode WebSocket traffic intercepted again (#1844)" }, "wire payload (ready): names the disk version, newest critical summary");

        _setReleaseNotesStateForTest({ entries: ENTRIES }); // no disk info
        const recVis = getUpdateVisibility("0.1.179");
        const rec = describeUpdateReady(recVis);
        assert.ok(rec.startsWith("Critical update available: ≥ 0.1.180 —"), `critical wording names the MINIMUM fixed version (got: ${rec})`);
        assert.ok(!rec.includes("npm install"), "no install command — hosts differ (npm -g / opencode / dsh / pi)");
        // span = [0.1.180 critical, 0.1.181 routine] ascending: the payload must
        // carry 0.1.180 (the minimum version WITH the fix), not 0.1.181 — the
        // locales render "v{version} 或更新版本 / v{version} or newer" from it.
        assert.deepEqual(updateBannerPayload(recVis), { kind: "available", version: "0.1.180", summary: "OpenCode WebSocket traffic intercepted again (#1844)" }, "wire payload (available): minimum fixed version, never the routine tail");

        // Span with NO critical entry + no pending restart = invisible; the
        // routine-only branch exists for panel completeness only.
        const routineOnly = getUpdateVisibility("0.1.178"); // span = 179(rec),… — pick a base where span is routine-only
        const routineEntries: ReleaseNoteEntry[] = [{ version: "0.2.0", tier: "routine", summary: "polish" }];
        _setReleaseNotesStateForTest({ entries: routineEntries });
        const ro = getUpdateVisibility("0.1.179");
        assert.equal(ro.critical, false);
        assert.equal(ro.visible, false);
        assert.ok(describeUpdateReady(ro).includes("0.2.0"), "fallback line still names the version");
        assert.ok(routineOnly !== undefined);
    } finally {
        _resetReleaseNotesWatcherForTest();
    }
});

// ---------------------------------------------------------------------------
// Surfaces. Mirrors the #1577 advisory-surface tests.

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeCtx(messages: CoreMessage[]): { core: ReturnType<typeof createCore>; config: Config; messages: CoreMessage[]; session: Session; log: (m: string) => void } {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "update-notes-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0 , retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: () => {},
    };
}

function makeCtx12(): ReturnType<typeof makeCtx> {
    const msgs: CoreMessage[] = [];
    for (let i = 1; i <= 12; i++) msgs.push(textMsg(`raw_${i}`, i % 2 === 1 ? "user" : "assistant", "x".repeat(5000)));
    const ctx = makeCtx(msgs);
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return ctx;
}

function mockRes(): { res: http.ServerResponse; status: number; body: string } {
    const out = { res: undefined as unknown as http.ServerResponse, status: 0, body: "" };
    const res = {
        writeHead(code: number) { out.status = code; return res; },
        end(chunk?: unknown) { if (typeof chunk === "string") out.body = chunk; return res; },
    } as unknown as http.ServerResponse;
    out.res = res;
    return out;
}

test("#1977 acp_status: CRITICAL UPDATE READY section lists the span; clean + non-critical states stay byte-absent", async () => {
    _resetReleaseNotesWatcherForTest();
    const { handleAcpStatus } = await import("../src/acp-status.ts");
    try {
        const ctx = makeCtx12();
        const clean = handleAcpStatus({}, ctx);
        assert.ok(!clean.text.includes("UPDATE READY") && !clean.text.includes("UPDATE AVAILABLE"), "no section on a clean install");

        // #1977: a newer disk version with a routine/recommended-only span
        // must NOT surface either — silence is the default.
        _setReleaseNotesStateForTest({ entries: [SURFACE_ENTRIES[0]], diskVersion: NEXT2 });
        const quiet = handleAcpStatus({}, ctx);
        assert.ok(!quiet.text.includes("UPDATE READY") && !quiet.text.includes("UPDATE AVAILABLE"), "#1977: pending restart without a critical entry stays silent");

        _setReleaseNotesStateForTest({ entries: SURFACE_ENTRIES, diskVersion: NEXT2 });
        const out = handleAcpStatus({}, ctx);
        assert.ok(out.text.includes(`CRITICAL UPDATE READY (instance-level): ${NEXT2} downloaded — restart this agent's proxy to finish`), "actionable headline names the disk version");
        assert.ok(out.text.includes(`(running ${VERSION})`), "names the running version for contrast");
        assert.ok(out.text.includes(`· ${NEXT} [critical] OpenCode WebSocket traffic intercepted again (#1844)`), "span renders versions below disk but above running, tier-first");
        assert.ok(out.text.includes(`· ${NEXT2} [routine] docs and log polish`), "span renders up to the disk version the restart will finish");
        assert.ok(out.text.includes("the update field of GET /__bili/status"), "points at the live-state field");

        // No disk info (auto-update off): AVAILABLE wording — and NO install
        // command anywhere (hosts differ: npm -g / opencode / dsh / pi).
        _setReleaseNotesStateForTest({ entries: SURFACE_ENTRIES });
        const avail = handleAcpStatus({}, ctx);
        assert.ok(avail.text.includes("CRITICAL UPDATE AVAILABLE (instance-level):"), "available headline when nothing is pending");
        assert.ok(!avail.text.includes("npm install"), "no npm install prescription (host-neutral wording)");
        assert.ok(!avail.text.includes("UPDATE READY"), "ready wording reserved for the pending-restart case");
    } finally {
        _resetReleaseNotesWatcherForTest();
    }
});

test("#1977 /acp panel: one critical-update line BEFORE the footer, stripper-safe, byte-exact when clean; $ survives", async () => {
    _resetReleaseNotesWatcherForTest();
    const { _resetSessionsForTest } = await import("../src/session.ts");
    const { handlePluginStatus } = await import("../src/plugin.ts");
    const { PANEL_BOX_FOOTER } = await import("../src/acp-panel.ts");
    try {
        _resetSessionsForTest();
        const { getSession } = await import("../src/session.ts");
        getSession("upd-sess", { protocol: "anthropic", label: "UPD" });
        const deps = { core: createCore(), config: defaultConfig(200000), log: (_l: string, _m: string) => {} };

        const r0 = mockRes();
        await handlePluginStatus("never-seen", r0.res, deps, true);
        assert.equal(r0.status, 200);
        const p0 = JSON.parse(r0.body).panel as string;
        assert.ok(!p0.includes("Update ready") && !p0.includes("Update available") && !p0.includes("Critical update"), "no update line when clean");
        assert.ok(p0.includes(PANEL_BOX_FOOTER), "footer present when clean");

        _setReleaseNotesStateForTest({ entries: SURFACE_ENTRIES, diskVersion: NEXT2 });
        const r1 = mockRes();
        await handlePluginStatus("never-seen", r1.res, deps, true);
        const p1 = JSON.parse(r1.body).panel as string;
        assert.ok(p1.includes(`Critical update ready: ${NEXT2} — restart to finish.`), "panel line present");
        assert.ok(p1.includes(PANEL_BOX_FOOTER), "footer still present with the update line");
        assert.ok(p1.indexOf("Critical update ready") < p1.indexOf(PANEL_BOX_FOOTER), "update line sits BEFORE the footer (stripper anchor)");
        const footerEsc = PANEL_BOX_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.equal((p1.match(new RegExp(footerEsc, "g")) ?? []).length, 1, "footer appears exactly once");

        // Remote-doc summary containing replace() pattern syntax must survive
        // byte-exact (same escape the advisory line relies on).
        const dollarSummary = "saves $5 and echoes $& `$'` verbatim";
        _setReleaseNotesStateForTest({
            entries: [{ version: NEXT, tier: "critical", summary: dollarSummary }],
            diskVersion: NEXT,
        });
        const r2 = mockRes();
        await handlePluginStatus("never-seen", r2.res, deps, true);
        const p2 = JSON.parse(r2.body).panel as string;
        assert.ok(p2.includes(dollarSummary), "dollar-sign summary survives byte-exact");
    } finally {
        _resetReleaseNotesWatcherForTest();
        _resetSessionsForTest();
    }
});

test("#4295 update action follows installed critical fixes, not pending restart alone", () => {
    const entries: ReleaseNoteEntry[] = [
        { version: "0.1.179", tier: "recommended", summary: "recommended" },
        { version: "0.1.180", tier: "critical", summary: "first fix" },
        { version: "0.1.181", tier: "routine", summary: "routine" },
        { version: "0.1.182", tier: "critical", summary: "second fix" },
        { version: "0.1.183", tier: "routine", summary: "future routine" },
    ];
    const cases = [
        { disk: undefined, kind: "available", version: "0.1.180", summary: "first fix", pending: false },
        { disk: "bad", kind: "available", version: "0.1.180", summary: "first fix", pending: false },
        { disk: "0.1.177", kind: "available", version: "0.1.180", summary: "first fix", pending: false },
        { disk: "0.1.178", kind: "available", version: "0.1.180", summary: "first fix", pending: false },
        { disk: "0.1.179", kind: "available", version: "0.1.180", summary: "first fix", pending: true },
        { disk: "0.1.180", kind: "available", version: "0.1.182", summary: "second fix", pending: true },
        { disk: "0.1.181", kind: "available", version: "0.1.182", summary: "second fix", pending: true },
        { disk: "0.1.182", kind: "ready", version: "0.1.182", summary: "second fix", pending: true },
        { disk: "0.1.184", kind: "ready", version: "0.1.184", summary: "second fix", pending: true },
    ] as const;
    try {
        for (const c of cases) {
            _resetReleaseNotesWatcherForTest();
            _setReleaseNotesStateForTest({ entries, ...(c.disk === undefined ? {} : { diskVersion: c.disk }) });
            const v = getUpdateVisibility("0.1.178");
            assert.equal(v.pendingRestart, c.pending, String(c.disk));
            assert.deepEqual(updateBannerPayload(v), { kind: c.kind, version: c.version, summary: c.summary }, String(c.disk));
            const line = describeUpdateReady(v);
            assert.ok(line.startsWith(c.kind === "ready"
                ? `Critical update ready: ${c.version} — restart to finish.`
                : `Critical update available: ≥ ${c.version} —`), line);
            assert.ok(line.includes(c.summary), line);
            assert.equal(line, describeUpdateReady(v), "stable repeated rendering");
        }
        _setReleaseNotesStateForTest({ entries: entries.filter((e) => e.tier !== "critical"), diskVersion: "0.1.184" });
        assert.equal(updateBannerPayload(getUpdateVisibility("0.1.178")), null, "routine/recommended updates stay silent");
    } finally {
        _resetReleaseNotesWatcherForTest();
    }
});

test("#4295 status and panel agree when only some critical updates are installed", async () => {
    const { handleAcpStatus } = await import("../src/acp-status.ts");
    const { handlePluginStatus } = await import("../src/plugin.ts");
    const { getSession, _resetSessionsForTest } = await import("../src/session.ts");
    const next3 = semver.inc(NEXT2, "patch")!;
    const next4 = semver.inc(next3, "patch")!;
    _resetSessionsForTest();
    getSession("upd-sess", { protocol: "anthropic", label: "UPD" });
    const entries: ReleaseNoteEntry[] = [
        { version: NEXT, tier: "recommended", summary: "recommended" },
        { version: NEXT2, tier: "critical", summary: "first fix" },
        { version: next3, tier: "critical", summary: "second fix" },
        { version: next4, tier: "routine", summary: "future routine" },
    ];
    try {
        for (const disk of [NEXT, NEXT2, next3]) {
            _resetReleaseNotesWatcherForTest();
            _setReleaseNotesStateForTest({ entries, diskVersion: disk });
            const ready = disk === next3;
            const version = disk === NEXT ? NEXT2 : next3;
            const status = handleAcpStatus({}, makeCtx12()).text;
            assert.ok(status.includes(ready
                ? `CRITICAL UPDATE READY (instance-level): ${disk} downloaded`
                : "CRITICAL UPDATE AVAILABLE (instance-level):"), status);
            assert.equal(status.includes("UPDATE READY"), ready, "restart must deliver the critical fixes");
            const res = mockRes();
            await handlePluginStatus("never-seen", res.res, { core: createCore(), config: defaultConfig(200000), log: () => {} }, true);
            const body = JSON.parse(res.body) as { panel: string };
            assert.ok(body.panel.includes(ready
                ? `Critical update ready: ${disk} — restart to finish.`
                : `Critical update available: ≥ ${version} —`), body.panel);
        }
    } finally {
        _resetSessionsForTest();
        _resetReleaseNotesWatcherForTest();
    }
});
