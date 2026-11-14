/**
 * #3417 layer ① — the per-agent DECLARED-defaults registry, as an IMPORT-FREE
 * LEAF module.
 *
 * Why a separate file: layer ① must be readable from BOTH sides of the proxy
 * boundary. Server-side consumers (lane-decisions, the four prepares) AND
 * host-side agent bundles (src/agent/pi.ts resolves its own profile for the
 * body-stamp channel) need these constants. Lane-decisions itself drags in
 * server modules (preflight → kernel); an agent-side import of it would pull
 * the whole compression stack into dist/agent/*.js client-process bundles
 * (#3482 review: the first cut doubled dist/agent/pi.js and omp.js). Keeping
 * the pure table here — zero imports, no payload scanning — lets both sides
 * share ONE registry without crossing the boundary. A structural guard in
 * tests/lane-decisions-matrix.test.ts pins the import-free property.
 */

// ① HostProfile registry — the ONLY place lane names are compared (#3417).
// Properties here are per-AGENT constants. Anything that can vary per
// environment/profile/request belongs in the WireObservation layer instead.
export interface HostProfile {
    readonly identity: string;
    /**
     * Declared: this host's upstream requests need the billing block carried
     * from the client request (#2189, subscription-OAuth lanes 429 without it).
     */
    readonly wantsBillingBlock: boolean;
    /**
     * Declared: this host's identity stamp rides the request BODY
     * (`prompt_cache_key`) — omp has no session header the proxy can bind
     * (#1403/#1579); pi stamps `x-bili-plugin-conversation` in
     * before_provider_headers instead (which outranks the body field).
     * Registry property, not an adapter-side name gate (#3482 site 3).
     */
    readonly stampsBodyPromptCacheKey: boolean;
    /**
     * Declared: this host build can route anthropic-messages traffic over
     * its own direct TLS transport, bypassing globalThis.fetch (OMP Cowork,
     * #2583) — the fetch-layer interception claim does not hold for such
     * hosts, so body stamps must be withheld there. The per-request truth
     * stays environmental (ompCoworkTransportBypassesFetch reads
     * provider/api/proxy env); this flag owns the "is that even possible
     * here" question (#3482 site 2).
     */
    readonly coworkTransportPossible: boolean;
    /**
     * Declared: this client's `instructions` drift means a NEW persona, so
     * the compression-session key fingerprints it (inverted allowlist —
     * everyone else keys verbatim). Wire-CLIENT entries only: codex (#150,
     * task ids reused across tasks) and claude-on-responses (#970, subagents
     * share the main session id there). #3482 site 4.
     */
    readonly instructionsFingerprintKeyed: boolean;
    /**
     * Declared: this client shares one conversation id across personas
     * (main agent + subagents), so its ANTHROPIC-wire traffic rides the
     * continuity-aware order resolver (personaConversationOrder) for persona
     * separation (#4352): a continuing main conversation keeps the raw key on
     * order+content evidence, a history-disjoint subagent ride forks onto its
     * own |sub:<fp> lane. Anthropic wire only — the responses wire expresses
     * the same intent via instructionsFingerprintKeyed (#970/#2250).
     */
    readonly personaOrderKeyed: boolean;
    /**
     * Declared: this host compacts histories CLIENT-SIDE and resends the
     * compacted form (dsh native compaction, #2432) — the four prepares run
     * the dual-signal compact-guard rebase for such hosts. Registry property,
     * not a name comparison in each adapter (#3417).
     */
    readonly compactsClientSide: boolean;
}

// ACP tool visibility has NO declared per-agent default (#4998): delivery is
// environmental on every lane — dsh profiles gate the surface (#3401), zcode
// rides its MCP bridge (#4344), pi/omp/opencode register through an async
// manifest handshake that can land after a round's payload is already built
// (pi cold-start round 1; #2708-style drop rounds). lane-decisions observes
// each request's own declaration instead of assuming it from the profile name.
const PROFILES: Record<string, HostProfile> = {
    dsh: { identity: "dsh", wantsBillingBlock: true, stampsBodyPromptCacheKey: false, coworkTransportPossible: false, instructionsFingerprintKeyed: false, personaOrderKeyed: false, compactsClientSide: true },
    // #4344: zcode reaches the ACP tools ONLY through its MCP bridge
    // (mcp__bili__* names), and bridge delivery is environmental — zcode's
    // agent modes gate MCP tools, and the degraded shim path serves an EMPTY
    // tool list when no healthy proxy is found (src/zcode/mcp-entry.ts
    // serveDegraded). So reachability is OBSERVED per request, never assumed:
    // a healthy bridge declares mcp__bili__compress (dialect-aware, #4344
    // fix) and the surface stays on; a broken/idle bridge declares nothing
    // and the surface goes silent instead of advertising a tool the model
    // cannot call (the #4344 shape: nudges armed at 21-29% usage, 0
    // compressions — #3177's "unknown tool" discipline, applied to zcode).
    zcode: { identity: "zcode", wantsBillingBlock: false, stampsBodyPromptCacheKey: false, coworkTransportPossible: false, instructionsFingerprintKeyed: false, personaOrderKeyed: false, compactsClientSide: false },
    pi: { identity: "pi", wantsBillingBlock: false, stampsBodyPromptCacheKey: false, coworkTransportPossible: false, instructionsFingerprintKeyed: false, personaOrderKeyed: false, compactsClientSide: false },
    omp: { identity: "omp", wantsBillingBlock: false, stampsBodyPromptCacheKey: true, coworkTransportPossible: true, instructionsFingerprintKeyed: false, personaOrderKeyed: false, compactsClientSide: false },
    opencode: { identity: "opencode", wantsBillingBlock: false, stampsBodyPromptCacheKey: false, coworkTransportPossible: false, instructionsFingerprintKeyed: false, personaOrderKeyed: false, compactsClientSide: false },
};

/** No declared defaults at all — unknown agents and header-less proxy-lane
 * clients resolve here (lane-decisions re-identifies them by name or wire
 * signals). Exported because the wire-client table spreads it. */
export const ANONYMOUS: HostProfile = { identity: "", wantsBillingBlock: false, stampsBodyPromptCacheKey: false, coworkTransportPossible: false, instructionsFingerprintKeyed: false, personaOrderKeyed: false, compactsClientSide: false };

/** Resolve the declared profile for a plugin agent header value. Trimmed
 * exact match — the historical shape of every pluginAgent comparison.
 * Agent-side consumers (the host plugins) resolve their own profile through
 * this same registry — name gates never re-appear adapter-side (#3482). */
export function hostProfileFor(agentName: string | undefined | null): HostProfile {
    const key = (agentName ?? "").trim();
    return PROFILES[key] ?? { ...ANONYMOUS, identity: key };
}
