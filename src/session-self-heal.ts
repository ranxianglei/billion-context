import type { CoreMessage } from "acp-kernel";
import { PROXY_TOOL_NAMES } from "./compress-tool.js";
import type { Session } from "./session.js";

/**
 * #2155 session self-heal: a stuck session must not spin forever.
 *
 * Two degradation shapes, both detected on the request path (per prepared
 * round, evaluated once per HTTP request — the prepare pipeline can re-run
 * for overflow refold, see runPreparedPipeline):
 *
 *  D2 — zombie plugin session. The client was plugin-bound
 *       (session.metadata.pluginAgent, sticky by design: #1426) but the
 *       plugin lane has since died (e.g. `bili plugin remove zcode` while a
 *       client window stays open — the client's MCP subprocess is gone, so
 *       requests keep arriving with the session header but WITHOUT the
 *       live plugin markers: no x-bili-plugin header and no bili tool
 *       declarations in the request's tools array). The proxy still nudges
 *       (~89% usage every 30-60s) but the model's compression tools are
 *       gone (plugin mode suppresses wire injection), so the model spins on
 *       dead mcp__bili__* tools and nothing ever shrinks.
 *       Remedy of first resort: DEGRADE the session to proxy mode — flip
 *       pluginMode off, the proxy re-injects the ACP tools wire-side and
 *       owns compression server-side again. The session keeps working
 *       instead of being silenced. When wire injection is globally off
 *       (compress.injectTool=false) the degrade is unavailable and the
 *       fallback remedy is nudge suppression.
 *
 *  D1 — nudge idle loop (any mode). The proxy keeps injecting the
 *       compression nudge but no reduction ever lands (no new block, no
 *       lastCompress change, no bili tool use in the re-sent history).
 *       After SELF_HEAL_WINDOW consecutive idle rounds the session is
 *       telling us the nudge will not be acted on — stop injecting it
 *       (per-session, incl. the emergency path; equivalent to
 *       compress.injectNudge=false for this session only). Any later
 *       reduction lifts the suppression automatically.
 *
 * Recovery is evidence-based: the degrade lifts only when the live plugin
 * lane comes back (header or declared tools), the suppression lifts only
 * when compression actually resumes (reduction or bili tool use). State is
 * carried in session.metadata.selfHeal = { detected, action, since } so it
 * survives proxy restarts with the session snapshot (#499) and is visible
 * on /__bili/sessions.
 */

/** Consecutive idle/zombie rounds before a remedy arms. Constant by design
 * (#2155: no new config knobs); recorded in TECHNICAL-NOTES.md. */
export const SELF_HEAL_WINDOW = 5;

/** #3004: wall-clock cap on the suppress-nudge remedy. Release is
 * evidence-based (a reduction or bili tool use lifts it), but when the agent
 * never compresses on its own that evidence never arrives and the latch was
 * permanent — while the ONLY channel left to prompt compression IS the
 * suppressed nudge (circular wait; field report: 4h12m latch at zero blocks,
 * context pinned 77% under the wall). After the cap the remedy clears and
 * re-evaluates from scratch: still-idle sessions re-arm after another
 * SELF_HEAL_WINDOW injected rounds, so noise stays bounded (at most one
 * window of nudges per cap period) and sessions that start compressing
 * recover on evidence exactly as before. Constant by design (#2155
 * precedent); does not apply to degrade-to-proxy (its recovery is
 * header-driven, not circular). */
export const SELF_HEAL_SUPPRESS_CAP_MS = 10 * 60 * 1000;

type SelfHealAction = "degrade-to-proxy" | "suppress-nudge";

type SelfHealStateView = { detected: string; action: string; since: number };

type SelfHealCounters = {
    /** last observed reduction fingerprint (nextBlockId:lastCompress.at) */
    lastReductionKey: string | undefined;
    zombieStreak: number;
    idleStreak: number;
};

const counters = new WeakMap<Session, SelfHealCounters>();

function selfHealOf(session: Session): SelfHealStateView | undefined {
    const raw = session.metadata["selfHeal"];
    if (raw === null || typeof raw !== "object") return undefined;
    const rec = raw as Record<string, unknown>;
    if (typeof rec["detected"] !== "string" || typeof rec["action"] !== "string" || typeof rec["since"] !== "number") return undefined;
    return { detected: rec["detected"], action: rec["action"], since: rec["since"] };
}

/** True when this session's nudge injection is suppressed (D1 remedy, or the
 * D2 fallback when the degrade is unavailable). Gates every willInjectNudge
 * site so both the regular and the emergency path go quiet together. */
export function nudgeSuppressed(session: Session): boolean {
    return selfHealOf(session)?.action === "suppress-nudge";
}

/** True when a zombie plugin session has been degraded back to proxy mode
 * (tools re-injected wire-side, the proxy owns compression again). */
export function pluginLaneDegraded(session: Session): boolean {
    return selfHealOf(session)?.action === "degrade-to-proxy";
}

/** Restore a degraded session to plugin mode the moment the plugin header
 * reappears (the client re-registered). Called BEFORE the pluginMode flip so
 * the very first header-bearing request is already served in plugin mode —
 * otherwise the degrade would lag one round (pluginMode is computed before
 * the round's evaluation hook runs). */
export function pluginLaneRestore(session: Session, headerPresent: boolean, log: LogFn): boolean {
    if (!headerPresent || selfHealOf(session)?.action !== "degrade-to-proxy") return false;
    clearSelfHeal(session);
    const st = counters.get(session);
    if (st) {
        st.zombieStreak = 0;
        st.idleStreak = 0;
    }
    log("info", `[${session.id}] [self-heal] plugin lane is back (plugin header) — session restored to plugin mode`);
    return true;
}

function clearSelfHeal(session: Session): void {
    delete session.metadata["selfHeal"];
}

function armSelfHeal(session: Session, detected: "plugin-lane-gone" | "nudge-idle", action: SelfHealAction): void {
    session.metadata["selfHeal"] = { detected, action, since: Date.now() };
}

/** Fingerprint of "a reduction landed": a committed fold advances
 * nextBlockId (or the plugin-lane compress tool stamps lastCompress). Exported
 * so other nudge machinery (#3461 emergency backoff) watches the SAME evidence
 * instead of inventing a parallel signal. */
export function reductionKeyOf(session: Session): string {
    return `${session.state.nextBlockId}:${session.lastCompress?.at ?? 0}`;
}

/** A bili-owned tool name as it can appear on the wire: the proxy-injected
 * bare ACP names (compress/…, also used by pi/omp extensions) or the
 * MCP-prefixed form (mcp__bili__compress, zcode/claude-code lanes). */
function isBiliToolName(name: string): boolean {
    return name.startsWith("mcp__bili__") || PROXY_TOOL_NAMES.has(name);
}

const TOOL_WALK_MAX_DEPTH = 8;
// Codex serializes an MCP server on the Responses wire as a namespace entry
// named exactly `mcp__<server>` whose members carry BARE names (openai/codex:
// callable_namespace = format!("mcp__{server_name}")); the flat
// `mcp__bili__<tool>` spelling is the legacy/other-host form. Both declare the
// same MCP lane (#3522). Exact match only — `mcp__bilibili` must not count.
const MCP_BILI_NAMESPACE_NAME = "mcp__bili";

function declaresMcpBiliInList(entries: unknown, depth: number): boolean {
    if (!Array.isArray(entries) || depth > TOOL_WALK_MAX_DEPTH) return false;
    for (const entry of entries) {
        if (entry === null || typeof entry !== "object") continue;
        const rec = entry as Record<string, unknown>;
        const name = rec["name"];
        if (typeof name === "string" && (name.startsWith("mcp__bili__") || name === MCP_BILI_NAMESPACE_NAME)) return true;
        const fn = rec["function"];
        if (fn !== null && typeof fn === "object") {
            const name = (fn as Record<string, unknown>)["name"];
            if (typeof name === "string" && name.startsWith("mcp__bili__")) return true;
        }
        if (declaresMcpBiliInList(rec["functionDeclarations"], depth + 1)) return true;
        if (declaresMcpBiliInList(rec["tools"], depth + 1)) return true;
    }
    return false;
}

/** Strict MCP-lane evidence: the request itself declares the fixed bili MCP
 *  server — either as flat `mcp__bili__<tool>` names (legacy/other hosts) or
 *  as a Codex-style Responses namespace entry named exactly `mcp__bili`.
 *  Bare ACP names can also be wire-injected by the proxy, so they must not
 *  authorize a pending MCP registration (#3522). */
export function declaresMcpBiliToolsOnWire(parsed: unknown): boolean {
    if (parsed === null || typeof parsed !== "object") return false;
    return declaresMcpBiliInList((parsed as Record<string, unknown>)["tools"], 0);
}

export function countBiliToolUses(messages: CoreMessage[]): number {
    let n = 0;
    for (const m of messages) if (m.toolName !== undefined && isBiliToolName(m.toolName)) n += 1;
    return n;
}

type SelfHealRoundInputs = {
    /** x-bili-plugin header present on this request */
    pluginHeaderPresent: boolean;
    /** the request's own tools array declares bili tools (live MCP lane) */
    biliToolsDeclared: boolean;
    /** a nudge was injected into this round's payload, or the round carried
     * admitted over-limit pressure held only by the #3461 backoff ("gated") */
    nudgeActive: boolean;
    /** bili tool_use entries in the re-sent history (plugin-mode evidence the agent is still compressing) */
    biliToolUses: number;
    /** wire tool injection is available for the degrade remedy */
    degradeAvailable: boolean;
};

type LogFn = (level: "info" | "warn", message: string) => void;

/** Evaluate one prepared round. Pure w.r.t. inputs; mutates only the WeakMap
 * counters and (on transitions) session.metadata.selfHeal. Called once per
 * HTTP request after prepare (nudge-carrying rounds only — bypass lanes
 * never reach it). */
export function evaluateSelfHealRound(session: Session, inputs: SelfHealRoundInputs, log: LogFn): void {
    const st = counters.get(session) ?? { lastReductionKey: undefined, zombieStreak: 0, idleStreak: 0 };
    counters.set(session, st);
    const key = reductionKeyOf(session);
    const reduction = st.lastReductionKey !== undefined && key !== st.lastReductionKey;
    st.lastReductionKey = key;

    const active = selfHealOf(session);
    // #3004: time cap BEFORE evidence recovery — a suppression older than the
    // cap clears unconditionally so the nudge channel gets a fresh chance even
    // when no compression evidence ever arrives (the circular-wait case).
    if (active !== undefined && active.action === "suppress-nudge" && Date.now() - active.since >= SELF_HEAL_SUPPRESS_CAP_MS) {
        clearSelfHeal(session);
        st.zombieStreak = 0;
        st.idleStreak = 0;
        log("info", `[${session.id}] [self-heal] nudge suppression expired after ${Math.round((Date.now() - active.since) / 60_000)} min without compression evidence — re-enabling the nudge channel (re-arms after ${SELF_HEAL_WINDOW} more idle rounds if still ignored) (#3004)`);
    }
    // Recovery: evidence first, detection second — a recovered session can
    // re-arm later if it goes idle again (streaks restart from this round).
    if (active !== undefined && selfHealOf(session) !== undefined) {
        if (active.action === "degrade-to-proxy" && inputs.pluginHeaderPresent) {
            // NOTE: biliToolsDeclared is deliberately NOT a recovery signal
            // here — after degrading, OUR OWN wire injection puts the ACP tools
            // on every request, so "tools on the wire" would clear the degrade
            // on the first degraded round and the session would oscillate
            // (degrade -> clear -> zombie streak -> degrade). Only the plugin
            // header (the client actually re-registered) restores plugin mode.
            clearSelfHeal(session);
            st.zombieStreak = 0;
            st.idleStreak = 0;
            log("info", `[${session.id}] [self-heal] plugin lane is back (live marker on request) — session restored to plugin mode`);
        } else if (active.action === "suppress-nudge" && (reduction || inputs.biliToolUses > 0)) {
            clearSelfHeal(session);
            st.zombieStreak = 0;
            st.idleStreak = 0;
            log("info", `[${session.id}] [self-heal] compression resumed — nudge suppression lifted`);
        }
    }

    const pluginBound = typeof session.metadata["pluginAgent"] === "string";
    // Streaks advance only on rounds that actually carried a nudge — an idle
    // session (no traffic, side requests) must not accumulate zombie credit,
    // and a reduction or an agent-side tool use always resets both streaks.
    if (inputs.nudgeActive) {
        const zombieSignal = pluginBound && !inputs.pluginHeaderPresent && !inputs.biliToolsDeclared;
        if (reduction || inputs.biliToolUses > 0) {
            st.zombieStreak = 0;
            st.idleStreak = 0;
        } else {
            st.idleStreak += 1;
            st.zombieStreak = zombieSignal ? st.zombieStreak + 1 : 0;
        }
    }

    if (selfHealOf(session) !== undefined) return;
    if (pluginBound && st.zombieStreak >= SELF_HEAL_WINDOW) {
        if (inputs.degradeAvailable) {
            armSelfHeal(session, "plugin-lane-gone", "degrade-to-proxy");
            log("warn", `[${session.id}] [self-heal] plugin lane gone for ${st.zombieStreak} nudged rounds (no x-bili-plugin header, no bili tools declared) — session degraded to proxy mode: ACP tools re-injected wire-side, nudge kept`);
        } else {
            armSelfHeal(session, "plugin-lane-gone", "suppress-nudge");
            log("warn", `[${session.id}] [self-heal] plugin lane gone for ${st.zombieStreak} nudged rounds — wire injection unavailable (compress.injectTool=false), nudge suppressed for this session`);
        }
        st.zombieStreak = 0;
        st.idleStreak = 0;
        return;
    }
    if (st.idleStreak >= SELF_HEAL_WINDOW) {
        armSelfHeal(session, "nudge-idle", "suppress-nudge");
        log("warn", `[${session.id}] [self-heal] nudge idle for ${st.idleStreak} rounds (injected but nothing ever compressed) — nudge suppressed for this session until compression resumes`);
        st.idleStreak = 0;
        st.zombieStreak = 0;
    }
}

/** Live-lane evidence on the request's own tool declarations. In plugin mode
 * the CLIENT declares the bili tools (MCP-registered: mcp__bili__* for
 * zcode/claude-code lanes, bare ACP names for pi/omp extensions) — a healthy
 * bound session re-declares them on every main request, while a zombie (the
 * MCP subprocess removed mid-session) stops declaring them. Tolerant by
 * design: unknown shapes answer false and the header signal still carries
 * the healthy-plugin case. */
export function biliToolsDeclaredOnWire(parsed: unknown, protocol: string, named?: string): boolean {
    if (parsed === null || typeof parsed !== "object") return false;
    const body = parsed as Record<string, unknown>;
    const tools = body["tools"];
    // #3417: with `named`, reachability is judged for the SPECIFIC tool the
    // caller is about to advertise (e.g. the nudge names "compress") — a lane
    // that only exposes acp_status must not arm the compress surface
    // (#3403 review follow-up). Without it, any bili tool counts (legacy use).
    const wanted = (name: string): boolean => named === undefined ? isBiliToolName(name) : name === named;
    if (!Array.isArray(tools)) return false;
    for (const t of tools) {
        if (t === null || typeof t !== "object") continue;
        const rec = t as Record<string, unknown>;
        // anthropic / responses: flat { name }.
        const flat = typeof rec["name"] === "string" ? (rec["name"] as string) : undefined;
        if (flat !== undefined && wanted(flat)) return true;
        // openai chat: { function: { name } }.
        const fn = rec["function"];
        if (fn !== null && typeof fn === "object") {
            const inner = (fn as Record<string, unknown>)["name"];
            if (typeof inner === "string" && wanted(inner)) return true;
        }
        // google: { functionDeclarations: [{ name }] }.
        const decls = rec["functionDeclarations"];
        if (Array.isArray(decls)) {
            for (const d of decls) {
                if (d !== null && typeof d === "object") {
                    const n = (d as Record<string, unknown>)["name"];
                    if (typeof n === "string" && wanted(n)) return true;
                }
            }
        }
    }
    void protocol;
    return false;
}
