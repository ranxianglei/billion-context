// #6922: single source of truth for the Responses-wire developer-section join.
//
// The steady prepare path (prepare-responses.ts) and the proxy-loop round-2
// rebuild (relay.ts) each assemble the outbound developer/system element from
// the same ordered sections — client system parts, the compress prompt, the
// standing generation-boundary note (#4305), the absorb section and the
// block-ops section. They used to build it independently: steady joined with
// the "---" divider while round-2 glued the boundary/absorb/block-ops sections
// with plain "\n\n", so on EVERY fold of a generation-boundary-affected
// session the developer element forked at the note position and the upstream
// prefix cache re-billed everything after it.
//
// Both paths now call joinResponsesSystemSections(), which carries the
// separator in one place — the two builders can no longer drift apart. The
// helper is a plain join over the exact array it is given (no filtering, no
// coercion): it must reproduce the historical steady bytes bit-for-bit, so
// callers keep the same array construction they always had.
//
// The non-responses round-2 path keeps its historical plain "\n\n" join: those
// steady wires really do join the absorb section with "\n\n" (verified
// byte-for-byte by the cache-seam probes P1-P3), so no change is needed there.
export const RESPONSES_SYSTEM_SECTION_SEPARATOR = "\n\n---\n\n";

export function joinResponsesSystemSections(sections: readonly string[]): string {
    return sections.join(RESPONSES_SYSTEM_SECTION_SEPARATOR);
}
