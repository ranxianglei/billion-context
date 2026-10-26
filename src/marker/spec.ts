// Marker classes stripped from inbound history — the single table behind
// src/marker/engine.ts (issue #2811, plan B: strip 声明化).
//
// One class per kind of proxy-owned text that can leak into a resent client
// history. The table is documentation + coverage contract: every id with
// stage "raw" is exercised per wire protocol by
// tests/marker-lane-coverage.test.ts; the renderer-anchored classes are
// pinned against their emitters by tests/marker-render-contract.test.ts.
//
// stage:
//   raw   — wire-shape text, stripped by stripRawStage in every prepare-*
//           before projection (works for proxy, MITM and plugin lanes alike;
//           the passthrough early-returns are the documented exemptions).
//   state — core BiliMessage[] level (summary anchors ride the compression
//           state and are stripped carrier-aware by stripKernelSummaries).
//   title — notification title slot (anthropic), handled at the adapter.
// scope:
//   message  — whole-message match (exact text; never deletes user words)
//   lines    — line-level (MARKER_LINE grammar)
//   span     — tag-shaped spans inside otherwise user-owned text
//   block    — head line + contiguous report body

export type MarkerId =
    | "acp_panel_message"
    | "acp_status_body"
    | "marker_line"
    | "render_tag"
    | "forged_header"
    | "confirmation_marker"
    | "chain_carrier"
    | "nudge_echo"
    | "summary_anchor"
    | "notification_title";

export type MarkerStage = "raw" | "render" | "state" | "title";
export type MarkerScope = "message" | "lines" | "span" | "block";

export interface MarkerSpec {
    id: MarkerId;
    stage: MarkerStage;
    scope: MarkerScope;
    /** canonical implementation home */
    home: string;
    /** originating issue / design ref */
    refs: string;
    note?: string;
}

export const MARKER_SPECS: readonly MarkerSpec[] = [
    {
        id: "acp_panel_message",
        stage: "raw",
        scope: "message",
        home: "src/acp-panel.ts (isAcpPanelText + per-wire walks)",
        refs: "#359 #800 #1251",
        note: "box panel / fallback panel / [acp-cache] / [acp-rule]; anchored both ends",
    },
    {
        id: "acp_status_body",
        stage: "raw",
        scope: "block",
        home: "src/marker/status-body.ts",
        refs: "#2789 #2811",
        note: "head line + contiguous report body; renderer contract test",
    },
    {
        id: "marker_line",
        stage: "raw",
        scope: "lines",
        home: "src/loop/tag-echo-filter.ts (MARKER_LINE / stripAcpTags)",
        refs: "#1029 #717",
        note: "icon + [ACP] one-liners",
    },
    {
        id: "render_tag",
        stage: "render",
        scope: "span",
        home: "src/loop/tag-echo-filter.ts (stripAcpTags, projection walk)",
        refs: "#2023 #717 #1357",
        note: "\x3cacp …\x3e spans; paired/wrapped forms. NOT raw-stage: a foreign literal tag is user data (#1357 advisory keeps it byte-intact inbound); own echoes strip at render",
    },
    {
        id: "forged_header",
        stage: "raw",
        scope: "lines",
        home: "src/loop/tag-echo-filter.ts (MARKER_LINE via stripAcpTags)",
        refs: "#717",
        note: "model-forged confirmation lines share the marker grammar",
    },
    {
        id: "confirmation_marker",
        stage: "raw",
        scope: "lines",
        home: "src/loop/tag-echo-filter.ts (MARKER_LINE via stripAcpTags)",
        refs: "#717",
        note: "genuine streamed confirmations resent by echo clients",
    },
    {
        id: "chain_carrier",
        stage: "raw",
        scope: "message",
        home: "src/chain-checkpoint.ts (stripEmbeddedChainCarriers)",
        refs: "#1542",
        note: "whole-PART exact parseChainCheckpoint; google/responses aware",
    },
    {
        id: "nudge_echo",
        stage: "raw",
        scope: "message",
        home: "src/marker/anchors.ts (isNudgeEchoText)",
        refs: "#2811",
        note: "whole message ending with the integrity note/silence clause; corpus-verified latent; anthropic/openai/responses only splice STRING content — an array-content echo keeps its text slots washed (marker lines/status bodies) but is not whole-message spliced; google's parts walk covers all shapes",
    },
    {
        id: "summary_anchor",
        stage: "state",
        scope: "message",
        home: "src/server.ts (stripKernelSummaries, carrier-aware)",
        refs: "#1567",
        note: "state-stage; never raw-stripped (anchors are load-bearing)",
    },
    {
        id: "notification_title",
        stage: "title",
        scope: "message",
        home: "src/agent/notifications (isAutoInjectedNotification)",
        refs: "#897-era",
        note: "title slot only; not part of the body walk",
    },
];
