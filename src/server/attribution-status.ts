// #3581: takeover-failure visibility. When a host plugin's attribution gate
// refuses model traffic (injected code disposed after a version swap — #3578),
// every request silently goes DIRECT: no compression, no session registration,
// tools 404. The refusal evidence lives in the HOST process; the proxy only
// learns about it when a plugin reports it (fire-and-forget POST on refusal
// events — healthy paths report nothing). This module keeps the LATEST report
// per agent in memory and feeds both status surfaces (#2152 parity: one
// wire helper for /__bili/status AND /__bili/overview) so the web panel can
// replace the misleading "0 running" with an explicit "takeover broken" banner.
type AttributionState = "ok" | "none" | "threw";

interface AttributionReport {
    state: AttributionState;
    /** Model requests refused direct in the current degraded episode (resets to 0 on recovery). */
    refusals: number;
    /** Epoch ms of the first refusal in the current episode; 0 while healthy. */
    since: number;
    /** #3651: last thrown attribution error text (diagnosable-failure contract; `threw` episodes only). */
    error?: string;
    /** #3651: masked endpoint (origin+pathname) of the last refused request. */
    endpoint?: string;
    /** #5066: the episode contains a local oversize refusal — host attribution
     *  dead AND body provably over the model window: every retry stays
     *  refused until the host restarts (session wedged). Sticky until recovery. */
    wedged?: boolean;
}

const reports = new Map<string, AttributionReport>();

/** Record seam: latest-report-wins per agent. Called from the
 *  /__bili/plugin/attribution endpoint after validation. */
export function recordAttributionReport(agent: string, report: AttributionReport): void {
    reports.set(agent, {
        state: report.state,
        refusals: report.refusals,
        since: report.since,
        ...(report.error !== undefined ? { error: report.error } : {}),
        ...(report.endpoint !== undefined ? { endpoint: report.endpoint } : {}),
        ...(report.wedged === true ? { wedged: true } : {}),
    });
}

/** Wire payload shared by /__bili/status and /__bili/overview (#2152 parity).
 *  Empty object until the first report arrives — under the #3651 contract a
 *  healthy or by-design-agentless lane never reports, so absence means "no
 *  diagnosable failure observed", not "no plugins". */
export function attributionStatusWire(): Record<string, AttributionReport> {
    const out: Record<string, AttributionReport> = {};
    for (const [agent, r] of reports) out[agent] = {
        state: r.state,
        refusals: r.refusals,
        since: r.since,
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(r.endpoint !== undefined ? { endpoint: r.endpoint } : {}),
        ...(r.wedged === true ? { wedged: true } : {}),
    };
    return out;
}

/** Test hook: clear all reported agents between scenarios. */
export function _resetAttributionStatusForTest(): void {
    reports.clear();
}
