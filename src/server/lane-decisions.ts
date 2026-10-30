/**
 * #3417 lane-decisions: the single source of truth for per-lane gating
 * decisions ("are the tools reachable? is the compress surface on? may the
 * nudge ride this turn?").
 *
 * History: the same gating expressions were copied into all four wire
 * adapters and drifted (#3293 prompt/tool gate drift, #3401 lane-name
 * reachability misjudged 4x). This module is the extraction point:
 *
 *   ① HostProfile — per-agent DECLARED defaults (the registry is the only
 *      place a lane name is compared; identity lives here, properties flow out)
 *   ② WireObservation — per-request OBSERVED facts (which bili tools the
 *      request actually declares, per wire shape). Environment-varying
 *      properties are OBSERVED, not name-derived: the same dsh agent name has
 *      profiles where the agent sees bili's tools and profiles where it
 *      cannot (#3401) — so the observation layer may override the profile
 *      default.
 *   ③ LaneDecisions — the one resolver: consumers (the four prepares, the
 *      loop, plugin paths) read the frozen decision object and never
 *      re-derive a gate from `pluginAgent === "..."` themselves.
 *
 * Kernel purity: host-side only, imports nothing from kernel internals.
 */

import { biliToolsDeclaredOnWire } from "../session-self-heal.js";
import { extractBillingAttributionBlock } from "../preflight.js";
import { ANONYMOUS, hostProfileFor, type HostProfile } from "../host-profiles.js";
import { CODE_MODE_OMNIBUS_TOOL_NAMES, mcpBiliToolName } from "../compress-tool.js";

type LaneProtocol = "anthropic" | "openai" | "google" | "responses";

// ① HostProfile registry lives in ../host-profiles.ts — an import-free leaf
// so host-side agent bundles can read declared defaults without dragging
// this module's server dependencies (preflight → kernel) across the proxy
// boundary (#3482 review). Re-exported for consumers already on this path.
export { hostProfileFor } from "../host-profiles.js";
export type { HostProfile } from "../host-profiles.js";

// ② WireObservation — facts read off THIS request body.
interface WireObservation {
    /** The specific bili tools the request declares (named-tool precision —
     * the nudge advertises `compress`, so THAT name decides reachability,
     * #3403 review follow-up). */
    readonly declaredTools: ReadonlySet<string>;
    /** #3482: does this request's system carry a billing-attribution block
     * (#2189 shape — `x-anthropic-billing-header:` text block)? Observation,
     * not name-derivation: any lane's request that actually carries one
     * keeps it honored (the same evidence-over-defaults override as
     * toolsReachable, #3401). */
    readonly billingBlockObserved: boolean;
}

function observeDeclaredTools(parsed: unknown, protocol: LaneProtocol): ReadonlySet<string> {
    const out = new Set<string>();
    if (parsed === null || typeof parsed !== "object") return out;
    const tools = (parsed as Record<string, unknown>)["tools"];
    if (!Array.isArray(tools)) return out;
    for (const t of tools) {
        if (t === null || typeof t !== "object") continue;
        const rec = t as Record<string, unknown>;
        if (typeof rec["name"] === "string" && biliToolsDeclaredOnWire({ tools: [t] }, protocol, rec["name"])) out.add(rec["name"]);
        const fn = rec["function"];
        if (fn !== null && typeof fn === "object" && typeof (fn as Record<string, unknown>)["name"] === "string") {
            const n = (fn as Record<string, unknown>)["name"] as string;
            if (biliToolsDeclaredOnWire({ tools: [t] }, protocol, n)) out.add(n);
        }
        const decls = rec["functionDeclarations"];
        if (Array.isArray(decls)) {
            for (const d of decls) {
                if (d !== null && typeof d === "object" && typeof (d as Record<string, unknown>)["name"] === "string") {
                    const n = (d as Record<string, unknown>)["name"] as string;
                    if (biliToolsDeclaredOnWire({ tools: [t] }, protocol, n)) out.add(n);
                }
            }
        }
    }
    return out;
}

// ①b WireClientProfile — proxy-lane clients carry no pluginAgent header;
// their identity is OBSERVED from wire signals. Registry discipline as ①:
// the wire-client header-name literals live ONLY here (the old
// variable-mediated comparisons in session-id.ts were un-greppable by
// design — #3482 Step 2 site 4 pins them here). Shared detection
// primitives (isCodexClient, the codex UA definition) stay where they are
// — they feed many decisions and are exempt by the #3417 guard's design
// note; the DECISION table moves here.
interface WireClientSignals {
    /** Header NAMES whose value is a non-empty trimmed string. */
    readonly headerNames: ReadonlySet<string>;
    /** The conversation-header source that won precedence (name only). */
    readonly conversationSourceName: string | undefined;
    /** The shared codex UA/header detection (isCodexClient). */
    readonly codexUserAgent: boolean;
}

interface WireClientEntry {
    readonly profile: HostProfile;
    readonly matches: (s: WireClientSignals) => boolean;
}

const WIRE_CLIENTS: readonly WireClientEntry[] = [
    {
        // codex (#150): task-level session ids are REUSED across tasks —
        // different task instructions under one id must not merge. Modern
        // codex isolates subagent threads via the turn-metadata header
        // (keyed verbatim there); the fingerprint still matters for root
        // threads and older builds (same evidence as isCodexClient, #645).
        // #3686: this registry observes HEADERLESS proxy-lane clients; a request
        // carrying an explicit x-bili-plugin marker has declared its identity
        // (resolved from the plugin agent above), so a codex-shaped UA on that
        // traffic is relay compatibility, not codex.
        profile: { ...ANONYMOUS, identity: "codex", instructionsFingerprintKeyed: true },
        matches: (s) => !s.headerNames.has("x-bili-plugin") && (s.headerNames.has("x-codex-turn-metadata") || s.codexUserAgent),
    },
    {
        // claude code (#970/#4352): subagents SHARE the main agent's session
        // id on every wire. The responses wire separates them via the
        // instructions fingerprint (instructionsFingerprintKeyed); the
        // anthropic wire via the order resolver (personaOrderKeyed) when the
        // two-signal header gate (claudeSubagentAgentId) misses.
        profile: { ...ANONYMOUS, identity: "claude-responses", instructionsFingerprintKeyed: true, personaOrderKeyed: true },
        matches: (s) => s.conversationSourceName === "x-claude-code-session-id",
    },
];

/** Resolve the wire-client profile from observed signals (first match wins;
 * unknown clients resolve ANONYMOUS — instructions key VERBATIM for them,
 * #1106). */
export function resolveWireClientProfile(signals: WireClientSignals): HostProfile {
    for (const entry of WIRE_CLIENTS) if (entry.matches(signals)) return entry.profile;
    return ANONYMOUS;
}
// ③ LaneDecisions — the frozen decision object every gate reads.
interface LaneDecisions {
    /** The resolved profile (identity + declared defaults). */
    readonly profile: HostProfile;
    /** Observed per-request facts. */
    readonly observed: WireObservation;
    /** Is the tool the nudge/standing prompt advertises (`compress`) actually
     * declared on this request's wire? Environment truth — overrides the
     * profile default when the tools ARE visible (#3401). */
    readonly toolsReachable: { readonly compress: boolean };
    /**
     * Should the model-side compress surface (standing system prompt + nudge)
     * be ON for this request? Plugin lanes whose agent cannot reach the
     * compress tool must not advertise it ("unknown tool" loops, #3177/#3401).
     * Suppression here also keeps the developer/system slot append-stable.
     *
     * Cache-sensitivity note (#3403 review): the flag is recomputed per
     * request from `parsed.tools`; it stays prefix-cache stable as long as the
     * host's tool table is per-session stable (a mid-session flip breaks the
     * cache prefix once — observed only on hosts that violate that premise).
     */
    readonly compressSurfaceOn: boolean;
    /** Legacy alias kept for the four prepares' migration: TRUE when the
     * surface must be OFF (the old `dshCompressSurfaceOff` variable). */
    readonly compressSurfaceOff: boolean;
    /** #4344: this plugin-mode request declares the compress tool ONLY in the
     * MCP dialect (`mcp__bili__compress`, no bare `compress`) — the standing
     * prompt must teach the model the name it can actually call (see
     * withMcpDialectNote). False in proxy mode (bili injects the bare tools
     * itself, so the bare name is always callable). */
    readonly mcpDialect: boolean;
    /** #3482 site 1: should this lane's summary side-calls carry the billing
     * attribution block extracted from the client system (#2189)? The dsh
     * profile declares it (subscription-OAuth lanes 429 without it); any
     * request observed carrying the block keeps it honored regardless of
     * profile — evidence over defaults, same shape as toolsReachable. */
    readonly billingBlockWanted: boolean;
}

interface LaneDecisionInput {
    readonly protocol: LaneProtocol;
    readonly pluginMode: boolean;
    readonly pluginAgent: string | undefined;
    readonly parsed: unknown;
    /** injectTool config (`shouldInject`) — the config-level master switch. */
    readonly shouldInject: boolean;
    /** TRUE when THIS request carries the plugin lane header (`x-bili-plugin`),
     * false when a sticky plugin-bound session serves a headerless round.
     * Undefined = caller could not observe (matrix tests, legacy callers) —
     * never triggers the zombie clause below. #2155/#4344 boundary: an idle
     * bridge sends the header but no ACP tools (surface may go silent); a
     * zombie round sends NO header at all because the plugin is gone (client
     * uninstalled/crashed) — those rounds must keep the nudge/self-heal
     * probe alive or degrade-to-proxy can never fire. */
    readonly pluginHeaderPresent?: boolean;
}
// ④ nudgeOn — the ONE nudge-injection gate (#3482 Step 2.5). The four
// prepares used to carry four hand-copied conjunctions that drifted (#3293:
// anthropic lost the injectTool conjunct entirely). The deliberate
// per-lane differences are EXPLICIT inputs, pinned by equivalence tests:
//   - `compactionTrigger` — responses only (#2155/#2432 family): a
//     compaction-trigger request never carries the nudge; the other three
//     wires have no trigger concept and pass `false`.
//   - `growthFoldingArmed` — callers arm it with the codex-intercept health
//     window (`modelContextLimit × CODEX_COMPACT_HEALTH_RATIO`) when that
//     mode is live on the responses lane; all other callers pass the
//     windowless variant.
//   - `compressSurfaceOn` — the lane-decisions surface (this is where the
//     old `shouldInject` conjunct lives for every lane; the standalone
//     copies in openai/google were redundant — compressSurfaceOn already
//     implies injectTool).
// Truth-table pinned across all four wires × lanes × tool shapes by
// tests/lane-decisions-matrix.test.ts: adding or dropping a conjunct must
// land WITH the matrix rows asserting BOTH directions (fires when it should,
// stays silent when it should not — #3617 negative-assertion discipline).
export interface NudgeGateInputs {
    /** opts.compress.injectNudge — the config-level master switch. */
    readonly injectNudge: boolean;
    /** !!turn.nudge — the kernel produced a nudge plan this turn. */
    readonly hasNudgePlan: boolean;
    /** laneDecisions.compressSurfaceOn. */
    readonly compressSurfaceOn: boolean;
    /** responses: hasCompactionTrigger(parsed.input); others: false. */
    readonly compactionTrigger: boolean;
    /** !nudgeInjectionBlocked(session) || decideFallbackOverride — the decide
     * ladder's fallback is the ONE exception that punches through BOTH
     * suppression latches (#2155 self-heal, #5058 net-progress; #3004
     * dead-lock guard). */
    readonly suppressionBypassed: boolean;
    /** compressBreakerArmed(session). */
    readonly breakerArmed: boolean;
    /** autoFoldEngaged(loopConfig, session). */
    readonly autoFoldEngaged: boolean;
    /** growthFoldingArmed(loopConfig, healthWindow?) — precomputed with the
     * lane's health window. */
    readonly growthFoldingArmed: boolean;
    /** turn.nudge.shouldInject || emergencyNudge(turn.nudge, …) — the model
     * actually wants compression (or is past the emergency bar). */
    readonly modelWantsIt: boolean;
}

export function nudgeOn(i: NudgeGateInputs): boolean {
    return i.injectNudge && i.hasNudgePlan && i.compressSurfaceOn && !i.compactionTrigger
        && i.suppressionBypassed && !i.breakerArmed
        && !(i.autoFoldEngaged && i.growthFoldingArmed)
        && i.modelWantsIt;
}

/** Lane-decision resolver — truth-table pinned across all four wires × lanes
 * × tool shapes by tests/lane-decisions-matrix.test.ts; a new tool shape or
 * profile default lands there as a positive+negative row pair (#3617). */
export function resolveLaneDecisions(input: LaneDecisionInput): LaneDecisions {
    const profile = hostProfileFor(input.pluginAgent);
    const declaredTools = observeDeclaredTools(input.parsed, input.protocol);
    // Reachability truth: in PROXY mode bili itself injects the tool
    // definitions into the outbound body, so the surface is structurally on.
    // In PLUGIN mode the host owns the tool table: reach when this request
    // declares `compress` (observed — some dsh profiles DO surface it, #3401)
    // or the host exposes bili tools to the model by design (profile default,
    // #3177). #4344: the declaration counts in EITHER dialect — MCP-bridged
    // hosts (zcode/claude-code) carry `mcp__bili__compress`, and a lane whose
    // bridge is healthy must not read as unreachable just because the name is
    // prefixed (session-self-heal's biliToolsDeclaredOnWire docs the same
    // dual dialect). PTC presets collapse EVERY tool into a single omnibus
    // (SDK bindings nested inside it), so top-level absence of `compress` is
    // not evidence of unreachability there — ANY known omnibus name reads as
    // reachable. Known shapes live in CODE_MODE_OMNIBUS_TOOL_NAMES (run_code
    // = dsh-tools built-in, DSH 0.1.x; code_run = dsh-codemode transport,
    // DSH 0.2.x): #3600's miss was released 0.1.198 suppressing the surface
    // on every dsh PTC session until the window hit 100%, and #3884's miss
    // was that same single-literal gate going stale when DSH 0.2.x renamed
    // the transport (12× ARMED-SUPPRESSED at 42% usage, pendingT1 10× over
    // threshold, fully silent).
    const compressReachable = !input.pluginMode
        || declaredTools.has("compress")
        || declaredTools.has(mcpBiliToolName("compress"))
        || [...CODE_MODE_OMNIBUS_TOOL_NAMES].some((n) => declaredTools.has(n))
        || !profile.toolsHostScopedByDefault
        // #2155: a sticky plugin-bound round with NO lane header is the zombie
        // shape (plugin gone from the client). The nudge channel doubles as
        // the self-heal probe — suppressing it here starves zombieStreak and
        // degrade-to-proxy never fires (#4372's zcode profile did exactly
        // that). Headerless rounds keep the surface ON so the probe runs;
        // once degraded, proxy tool injection replaces the lane anyway.
        // (#4344's silent-bridge case always sends the header — unaffected.)
        || (input.pluginMode && input.pluginHeaderPresent === false);
    const compressSurfaceOn = input.shouldInject && compressReachable;
    const mcpDialect = input.pluginMode && declaredTools.has(mcpBiliToolName("compress")) && !declaredTools.has("compress");
    const billingBlockObserved = extractBillingAttributionBlock(systemOf(input.parsed)) !== undefined;
    const billingBlockWanted = profile.wantsBillingBlock || billingBlockObserved;
    return Object.freeze({
        profile,
        observed: Object.freeze({ declaredTools, billingBlockObserved }),
        toolsReachable: Object.freeze({ compress: compressReachable }),
        compressSurfaceOn,
        compressSurfaceOff: !compressSurfaceOn,
        mcpDialect,
        billingBlockWanted,
    });
}

/** #3884 owner follow-up: make a reachability miss LOUD instead of silent.
 * When an armed nudge stays suppressed because the lane surface is OFF for
 * reachability (not the user's own injectTool=false choice), name what was
 * actually observed on the top-level tool table: the next host omnibus rename
 * then shows up in bili.log next to the ARMED-SUPPRESSED label as
 * `surface=off(top-level=[new_name])` instead of requiring user archaeology
 * (#3600 and #3884 were both diagnosed from user-reported log dumps). Returns
 * undefined when there is nothing to explain: surface on, or off by user
 * config. */
export function surfaceOffDetail(d: LaneDecisions, shouldInject: boolean): string | undefined {
    if (d.compressSurfaceOn || !shouldInject) return undefined;
    const declared = [...d.observed.declaredTools];
    return declared.length === 0 ? "surface=off(no-tools)" : `surface=off(top-level=[${declared.join(",")}])`;
}

function systemOf(parsed: unknown): string | Array<Record<string, unknown>> | undefined {
    if (parsed === null || typeof parsed !== "object") return undefined;
    const system = (parsed as Record<string, unknown>)["system"];
    if (typeof system === "string" || Array.isArray(system)) return system;
    return undefined;
}
